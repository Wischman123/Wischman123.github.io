// engine/conserved.js
//
// Phase S item S4 — quantity-agnostic conserved-quantity tracker.
//
// The ConservationTracker (energy.js) is energy-SPECIFIC: K + a
// force-keyed `contributions` map + dissipation + external-work budget,
// with drift on a scalar total. Linear momentum (B1: p = Σ m·v, a
// VECTOR), system momentum (B3), and angular momentum (D3: L = Σ I·ω, a
// scalar in 2-D) need a DIFFERENT shape — "sum a per-body quantity,
// compare to the initial, report drift" — with NONE of energy's
// potential / dissipation / external-work channels. This is that shape,
// extracted ONCE so B1/B3/D3 instantiate it instead of each re-adding an
// ad-hoc tracker plus serialization wiring.
//
// Energy does NOT instantiate this base. Its conserved quantity is not a
// per-body sum: it folds in force-derived potentials (`energyKey` +
// `potentialEnergy`) and a `W_external` budget, none of which fit
// `quantityFn(body)`. Forcing energy through this base would re-grow the
// entire channel apparatus here. The two are deliberately SIBLINGS —
// energy keeps its specialized closure machinery; this serves the
// momentum / angular-momentum family.
//
// Drift convention: ABSOLUTE units, not a percent. A conserved vector
// (momentum) routinely passes through zero — a head-on elastic collision
// reverses p_x through 0 — so a percent drift would divide by ≈ 0 and
// explode. The caller picks the per-quantity tolerance band against the
// absolute drift.

export class ConservedQuantityTracker {
  // quantityFn(body) → number (scalar) | { x, y } (vector). `isVector`
  // picks the accumulation + drift shape. `name` keys the serialized
  // `conserved` block (e.g. 'p_linear', 'L_angular').
  constructor({ bodies, quantityFn, isVector = false, name }) {
    if (typeof quantityFn !== 'function') {
      throw new Error('ConservedQuantityTracker: quantityFn must be a function');
    }
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error('ConservedQuantityTracker: name must be a non-empty string');
    }
    this.bodies = bodies;
    this.quantityFn = quantityFn;
    this.isVector = isVector;
    this.name = name;
    this._initial = null; // captured on the first current() call
  }

  // Sum quantityFn over all bodies; on the first call, capture the result
  // as the conserved baseline. Returns { name, isVector, total, initial,
  // drift }. drift is total − initial, per-component for a vector.
  current() {
    let total;
    if (this.isVector) {
      total = { x: 0, y: 0 };
      for (const b of this.bodies) {
        const q = this.quantityFn(b);
        total.x += q.x;
        total.y += q.y;
      }
    } else {
      total = 0;
      for (const b of this.bodies) total += this.quantityFn(b);
    }

    if (this._initial === null) {
      this._initial = this.isVector ? { x: total.x, y: total.y } : total;
    }

    const drift = this.isVector
      ? { x: total.x - this._initial.x, y: total.y - this._initial.y }
      : total - this._initial;

    return { name: this.name, isVector: this.isVector, total, initial: this._initial, drift };
  }
}

// Linear momentum p = Σ m·v (a vector). B1 (1-D collisions) and B3
// (system momentum) instantiate this so "what is momentum" is defined
// ONCE rather than re-derived per phase. A perfectly elastic OR inelastic
// internal collision conserves total p → zero drift; an external impulse
// shows up as a nonzero drift vector.
export function linearMomentumTracker(bodies, name = 'p_linear') {
  return new ConservedQuantityTracker({
    bodies,
    quantityFn: (b) => ({ x: b.mass * b.velocity.x, y: b.mass * b.velocity.y }),
    isVector: true,
    name
  });
}

// Phase D3 — SPIN angular momentum L = Σ I·ω (a SCALAR in 2-D: rotation
// about the single fixed out-of-plane ẑ axis). Sibling of
// linearMomentumTracker on the SAME S4 base — NOT a fourth ad-hoc tracker.
// The accessor reads (momentOfInertia, omega), which only stride-6
// rotational bodies expose, so a non-rotational body contributes 0 and
// silently opts out.
//
// ‼ SPIN ONLY. This omits the ORBITAL term Σ m(r × v) — a translating or
// rolling body carries angular momentum about an external axis that this
// diagnostic does NOT capture. It is the conserved quantity ONLY for
// pure-spin, zero-net-torque scenes; registering it on a rolling/
// translating scene (D2) would report false drift. The scene opt-in
// (diagnostics.angular_momentum) and its schema doc pin this constraint.
export function angularMomentumTracker(bodies, name = 'L_angular') {
  return new ConservedQuantityTracker({
    bodies,
    quantityFn: (b) => (b.momentOfInertia ?? 0) * (b.omega ?? 0),
    isVector: false,
    name
  });
}

// Pure predicate: does `rp` name a valid axis for the orbital term — a numeric
// x AND y? ONE decision point with TWO call sites: the factory below THROWS on
// !isValidReferencePoint (a library boundary check), and the P3 scene schema
// guard branches on the SAME predicate to emit its friendly build message, so
// the two can never drift. Number.isFinite does NOT coerce, so it rejects a
// string "0", null, undefined, and NaN in one shot. MUST return false (never
// throw a TypeError) for the whole-rp null/undefined case: the P3 guard passes
// `undefined` when `reference_point` is absent and relies on this being `false`
// to emit the friendly message rather than crashing — hence the `rp != null`
// short-circuit before any property access.
export function isValidReferencePoint(rp) {
  return rp != null && Number.isFinite(rp.x) && Number.isFinite(rp.y);
}

// TOTAL angular momentum about a scene-DECLARED reference point (x0, y0):
//   L = Σ[ I·ω  +  m·((x − x0)·v_y − (y − y0)·v_x) ]
// the spin term (as D3) PLUS the orbital ẑ-component m(r × v). Sibling of
// angularMomentumTracker on the SAME S4 base — reuses ConservedQuantityTracker
// unchanged (isVector:false, scalar L). Unlike the spin-only channel, this
// captures a translating/orbiting body's angular momentum, so it is the
// CONSERVED quantity for a central-force scene (e.g. a planet orbiting a star)
// where the spin-only channel would report a blind constant 0.
//
// ‼ AXIS-DEPENDENT + ZERO-NET-TORQUE ONLY. L is measured about (x0, y0); a
// different reference point gives a different L. Closure (conserved L) holds
// ONLY for scenes with zero net torque about that point (a central force about
// the focus). Because zero-net-torque cannot be proven statically, this channel
// ASSERTS it — a real off-center / non-central force surfaces as drift. The
// SINGLE canonical statement of this caveat + its failure-semantics message
// lives in sim/SCHEMA.md `### diagnostics.orbital_angular_momentum`; this header
// deliberately does NOT restate it (a fourth verbatim copy is what that
// single-home decision exists to prevent).
//
// Sign convention: the orbital term assumes +ẑ = CCW (x·v_y − y·v_x), matching
// b.omega (bodies.js — "positive = counter-clockwise about ẑ"), so the spin and
// orbital terms ADD sign-correctly. Cross-reference the spin-only note above.
//
// Null-safety: every field is `?? 0`, so a body missing velocity/position/mass
// contributes a clean numeric 0 — NEVER a NaN that would poison the whole L sum.
//
// SINGLE-TRACKER invariant: the opt-in is one object with the fixed default
// name 'L_total' (distinct from spin 'L_angular'), and the serialized `conserved`
// block is keyed by tracker .name, so EXACTLY ONE orbital tracker per scene is
// supported and no collision is possible as designed. Latent seam: nothing
// enforces name-uniqueness at registration — IF the opt-in ever grows to
// multiple reference points, a uniqueness guard must be added THEN.
export function totalAngularMomentumTracker(bodies, referencePoint, name = 'L_total') {
  if (!isValidReferencePoint(referencePoint)) {
    throw new Error(
      'totalAngularMomentumTracker: referencePoint must have numeric x and y ' +
      `(got ${JSON.stringify(referencePoint)}) — L is axis-dependent, so the ` +
      'reference point is mandatory.'
    );
  }
  const { x: x0, y: y0 } = referencePoint;
  return new ConservedQuantityTracker({
    bodies,
    quantityFn: (b) => {
      const spin = (b.momentOfInertia ?? 0) * (b.omega ?? 0);
      const m = b.mass ?? 0;
      const rx = (b.position?.x ?? 0) - x0;
      const ry = (b.position?.y ?? 0) - y0;
      const vx = b.velocity?.x ?? 0;
      const vy = b.velocity?.y ?? 0;
      const orbital = m * (rx * vy - ry * vx);   // ẑ-component of m(r × v)
      return spin + orbital;
    },
    isVector: false,
    name
  });
}

// Phase B item B3 — centre of mass of a body system:
//   R_cm = Σ m_i r_i / M,  v_cm = Σ m_i v_i / M  (= p_total / M),  M = Σ m_i.
//
// A read-only DIAGNOSTIC, NOT a ConservedQuantityTracker: R_cm translates (it is
// not conserved), and v_cm is constant only while ΣF_external = 0. B3 surfaces it
// so a momentum scene can show the CoM gliding on a straight line while the parts
// move on complicated paths — the "internal forces never move the centre of mass"
// result (a collision, an explosion: the CoM glides through unperturbed).
//
// Computed DIRECTLY from the bodies, independent of any tracker — deliberately
// decoupled so emitting the CoM read-out never implies the closure-ASSERTION the
// linearMomentumTracker carries (opting into "show me the CoM" must not silently
// assert "this scene is momentum-closed"). Returns null for an empty system (M
// would be 0); Particle.mass > 0 is enforced at construction, so M > 0 for any
// non-empty scene, and a single body degenerates correctly (R_cm = its position).
export function centerOfMass(bodies) {
  if (!bodies || bodies.length === 0) return null;
  let M = 0;
  let rx = 0;
  let ry = 0;
  let vx = 0;
  let vy = 0;
  for (const b of bodies) {
    M += b.mass;
    rx += b.mass * b.position.x;
    ry += b.mass * b.position.y;
    vx += b.mass * b.velocity.x;
    vy += b.mass * b.velocity.y;
  }
  return {
    mass: M,
    position: { x: rx / M, y: ry / M },
    velocity: { x: vx / M, y: vy / M }
  };
}

export const NAME = 'conserved';
