// engine/constraints.js
//
// Constraints and surfaces. Surfaces are first-class because the
// classroom diagrams already use a Surface concept (problems/lib/scene.py).
// Porting that concept to JS lets the simulator share scene descriptions
// with the authoring pipeline.
//
// v1 ships:
//   - Surface (flat | inclined | circular_arc | curved) with
//     penalty-method contact resolution. Curved is a v1 alias for
//     circular_arc; future spline support can land as a separate
//     enum value (schema policy permits new enum values without a
//     version bump).
//   - RodConstraint (rigid distance from anchor — Phase G pendulum).
//   - Pin / Hinge stubs (Phase 3 — RigidBody dependent).
//
// Surface contact uses penalty method (Baraff 1989-style spring-damper):
//   F_normal = k_contact * depth + c_damping * |v_normal_into_surface|
// where depth = -signedDistance when body is below the surface line.
// Damping is one-sided (only when body moves INTO surface) to avoid
// phantom drag when body lifts off.
//
// ----- Arc convention (convex) -----
//
// A `circular_arc` (or `curved`) Surface is a CONVEX arc — body rests
// on the OUTSIDE of the curve, like a hill. Given p1, p2 (endpoints)
// and `fillet_radius_m` (arc radius), the arc center sits on the
// OPPOSITE side of the chord from the chord-perpendicular `+chordNormal`
// direction (which is rotate(chord, +90° CCW)). The body's "above" side
// is +chordNormal — outside the circle. signedDistance > 0 ⇒ above /
// no contact; signedDistance < 0 ⇒ inside / penetrating.
//
// ----- Arc convention (concave) -----
//
// A `circular_arc_concave` Surface is the loop-the-loop interior: a FULL
// circle whose INSIDE the body rides. p1 and p2 are two diametrically
// opposite points (e.g. the bottom and top of a vertical loop), so
// center = midpoint(p1, p2) and radius = |p2 - p1| / 2. The whole circle
// is the surface (isFullCircle) — there is no chord/minor-major choice and
// no segment clip. Contact is the convex case MIRRORED: the outward normal
// points from the body TOWARD the center (the inward push that holds the
// body on the inside of the loop) and signedDistance = radius - |p - center|
// (> 0 inside / safe; < 0 when the body has pushed OUTSIDE the ring). The
// one-sided penalty then models loop departure for free — too slow at the
// top and the required N goes negative, the contact cannot pull, and the
// body lifts inward off the track. See
// docs/physics_briefs/concave_arc_contact_design.md (Option A).
//
// ----- Fillet semantics at JOINTS -----
//
// `fillet_radius_m` on a Surface is REQUIRED for arc shapes (it IS the
// arc's radius). For flat/inclined surfaces it is optional and unused
// at the engine layer — the field is reserved for downstream tooling
// that wants to insert a smoothing arc between adjacent surfaces.
//
// Sharp corners (wall-meeting-floor 90°, block edge meeting surface)
// are modeled by simply OMITTING the arc surface and letting two
// flat/inclined surfaces share an endpoint. No comment-based
// suppression — the choice is data-level.

import { zero } from './vec.js';
import { DEFAULT_K_CONSTRAINT } from './constants.js';
// The engine's ONE definition of "are these two bodies touching?" — already shared
// by the penalty ContactForce (B1) and the perfectly-inelastic merge resolver (B4).
// BodyRodConstraint's activate_on_contact weld reuses it rather than introducing a
// second, drift-prone notion of contact. (No import cycle: forces.js imports only
// vec / constants / fluids — it never imports this module.)
import { contactGeom, weldPairKey } from './forces.js';

const ARC_SHAPES = new Set(['circular_arc', 'curved']);
const VALID_SHAPES = new Set(['flat', 'inclined', 'circular_arc', 'curved', 'circular_arc_concave']);

export class Surface {
  constructor({ id, shape, p1, p2, fillet_radius_m = null, k_contact = null }) {
    if (!VALID_SHAPES.has(shape)) {
      throw new Error(
        `Surface shape "${shape}" not implemented. Valid shapes: ` +
        `${[...VALID_SHAPES].join(', ')}.`
      );
    }
    this.id = id;
    this.shape = shape;
    this.p1 = { x: p1.x, y: p1.y };
    this.p2 = { x: p2.x, y: p2.y };
    this.fillet_radius_m = fillet_radius_m;
    // Optional per-surface penalty-stiffness override. Null = use the scene
    // default (sceneCtx.k_contact) exactly as before. A heavy body seats
    // depth = N/k below the ring; a stiff loop (e.g. a 500 kg coaster) needs a
    // larger k so the depth stays negligible and the frozen answer is not
    // corrupted by the penalty offset. Must be positive when supplied.
    if (k_contact !== null && !(k_contact > 0)) {
      throw new Error(
        `Surface "${id}": k_contact override must be a positive number; got ${k_contact}.`
      );
    }
    this.k_contact = k_contact;

    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const chordLen = Math.hypot(dx, dy);
    if (chordLen === 0) {
      throw new Error(`Surface "${id}" has zero length (p1 == p2).`);
    }
    // Chord-direction tangent + chord-perpendicular normal. For
    // flat/inclined surfaces these ARE the surface tangent/normal. For
    // arcs they describe the chord; the per-point tangent and normal
    // come from tangentAt() and normalAt().
    this.chordTangent = { x: dx / chordLen, y: dy / chordLen };
    this.chordNormal = { x: -this.chordTangent.y, y: this.chordTangent.x };
    this.chordLength = chordLen;

    if (shape === 'flat' || shape === 'inclined') {
      this.length = chordLen;
      this.tangent = this.chordTangent;
      this.normal = this.chordNormal;
      return;
    }

    // ----- Concave arc (circular_arc_concave) — full-circle loop interior -----
    if (shape === 'circular_arc_concave') {
      // p1..p2 is a DIAMETER: center at the midpoint, radius = half the
      // chord. The whole circle is the surface (no minor/major choice, no
      // segment clip). Contact is mirrored (inward normal) in the methods
      // below via the shape check.
      this.radius = chordLen / 2;
      this.center = {
        x: (p1.x + p2.x) / 2,
        y: (p1.y + p2.y) / 2
      };
      // fillet_radius_m is DERIVED here; if the author supplied one it must
      // agree with the diameter (a contradiction is almost always a bug).
      if (fillet_radius_m !== null && Math.abs(fillet_radius_m - this.radius) > 1e-6) {
        throw new Error(
          `Surface "${id}" (circular_arc_concave): fillet_radius_m ` +
          `${fillet_radius_m} disagrees with the p1..p2 diameter radius ` +
          `${this.radius.toFixed(6)}. Omit fillet_radius_m (it is derived ` +
          `from the p1..p2 diameter) or set it equal to the radius.`
        );
      }
      this.isFullCircle = true;
      // Whole circle: length = circumference; render (drawSurfaces) sweeps
      // the full 2π from p1's angle.
      this.thetaStart = Math.atan2(p1.y - this.center.y, p1.x - this.center.x);
      this.thetaSweep = 2 * Math.PI;
      this.length = 2 * Math.PI * this.radius;
      // Backward-compat scalar normal/tangent sampled at p1 (inward normal).
      const n0 = this.normalAt(p1);
      this.normal = n0;
      this.tangent = { x: -n0.y, y: n0.x };
      return;
    }

    // ----- Arc shapes (circular_arc, curved) -----
    if (fillet_radius_m === null || !(fillet_radius_m > 0)) {
      throw new Error(
        `Surface "${id}" with shape="${shape}" requires a positive ` +
        `fillet_radius_m (the arc radius). For sharp corners (no ` +
        `fillet), model the joint with two flat/inclined surfaces ` +
        `sharing an endpoint and omit the arc surface entirely.`
      );
    }
    if (chordLen > 2 * fillet_radius_m + 1e-9) {
      throw new Error(
        `Surface "${id}": chord length ${chordLen.toFixed(6)} m exceeds ` +
        `2 * fillet_radius_m (${(2 * fillet_radius_m).toFixed(6)} m). ` +
        `The arc cannot reach both endpoints — increase fillet_radius_m ` +
        `or move p1/p2 closer together.`
      );
    }
    this.radius = fillet_radius_m;
    // Center sits on the OPPOSITE side of the chord from chordNormal,
    // so the convex arc bulges along +chordNormal (the "above" side).
    const halfChord = chordLen / 2;
    const centerOffset = Math.sqrt(this.radius * this.radius - halfChord * halfChord);
    const midX = (p1.x + p2.x) / 2;
    const midY = (p1.y + p2.y) / 2;
    this.center = {
      x: midX - this.chordNormal.x * centerOffset,
      y: midY - this.chordNormal.y * centerOffset
    };
    // Arc-length parameterization. theta_start at p1, theta_end at p2;
    // sweep direction follows whichever way gives the MINOR arc.
    this.thetaStart = Math.atan2(p1.y - this.center.y, p1.x - this.center.x);
    this.thetaEnd = Math.atan2(p2.y - this.center.y, p2.x - this.center.x);
    let dTheta = this.thetaEnd - this.thetaStart;
    while (dTheta <= -Math.PI) dTheta += 2 * Math.PI;
    while (dTheta > Math.PI) dTheta -= 2 * Math.PI;
    this.thetaSweep = dTheta; // positive: CCW; negative: CW.
    this.length = Math.abs(this.thetaSweep) * this.radius;
    // Backward-compat: .tangent and .normal are sampled at the arc apex
    // (chord midpoint projected onto the arc). Callers that need
    // position-dependent values must use tangentAt / normalAt.
    const apexNormal = { x: this.chordNormal.x, y: this.chordNormal.y };
    this.normal = apexNormal;
    const sweepSign = this.thetaSweep >= 0 ? 1 : -1;
    this.tangent = { x: -apexNormal.y * sweepSign, y: apexNormal.x * sweepSign };
  }

  // Outward unit normal at a point. For flat/inclined this is constant;
  // for arcs it points from center to the body's position, so the body
  // resting on the convex outside has positive signedDistance.
  normalAt(point) {
    if (this.shape === 'flat' || this.shape === 'inclined') {
      return this.normal;
    }
    const dx = point.x - this.center.x;
    const dy = point.y - this.center.y;
    const r = Math.hypot(dx, dy);
    if (r === 0) return this.normal;
    if (this.shape === 'circular_arc_concave') {
      // Inward normal: from the body TOWARD the centre — the push that
      // holds a body on the inside of the loop.
      return { x: -dx / r, y: -dy / r };
    }
    return { x: dx / r, y: dy / r };
  }

  // Unit tangent at a point. For flat/inclined this is constant; for
  // arcs it is perpendicular to the radial normal, oriented in the
  // direction of arc traversal (p1 → p2).
  tangentAt(point) {
    if (this.shape === 'flat' || this.shape === 'inclined') {
      return this.tangent;
    }
    const n = this.normalAt(point);
    const sign = this.thetaSweep >= 0 ? 1 : -1;
    return { x: -n.y * sign, y: n.x * sign };
  }

  // Signed perpendicular distance from a point to the surface.
  // > 0: above (no contact). < 0: penetrating from above.
  signedDistance(point) {
    if (this.shape === 'flat' || this.shape === 'inclined') {
      const dx = point.x - this.p1.x;
      const dy = point.y - this.p1.y;
      return dx * this.normal.x + dy * this.normal.y;
    }
    const dx = point.x - this.center.x;
    const dy = point.y - this.center.y;
    const dist = Math.hypot(dx, dy);
    if (this.shape === 'circular_arc_concave') {
      // > 0 INSIDE the loop (safe); < 0 when the body pushed OUTSIDE the ring.
      return this.radius - dist;
    }
    // Convex arc: |p - center| - r.
    return dist - this.radius;
  }

  // Coordinate along the surface, measured from p1. Used to clip contact
  // to the segment (no contact at the extensions). For arcs this is
  // arc-length, mapped to [0, this.length] over the swept sector.
  // Outside that range means the body's projection is off the segment.
  tangentParam(point) {
    if (this.shape === 'flat' || this.shape === 'inclined') {
      const dx = point.x - this.p1.x;
      const dy = point.y - this.p1.y;
      return dx * this.tangent.x + dy * this.tangent.y;
    }
    const theta = Math.atan2(point.y - this.center.y, point.x - this.center.x);
    let dTheta = theta - this.thetaStart;
    if (this.thetaSweep > 0) {
      // CCW sweep — want dTheta in [0, thetaSweep].
      while (dTheta < 0) dTheta += 2 * Math.PI;
      while (dTheta > 2 * Math.PI) dTheta -= 2 * Math.PI;
      return this.radius * dTheta;
    }
    // CW sweep — want dTheta in [-|thetaSweep|, 0]. Convert to positive
    // arc-length by negating.
    while (dTheta > 0) dTheta -= 2 * Math.PI;
    while (dTheta < -2 * Math.PI) dTheta += 2 * Math.PI;
    return this.radius * (-dTheta);
  }

  // Penalty contact force on body. Returns { Fx, Fy, depth, normal_force_mag }.
  // When not in contact (body above surface or off the segment), all
  // fields are zero.
  contactForce(body, k_contact, c_damping) {
    const s = this.signedDistance(body.position);
    if (s >= 0) return { Fx: 0, Fy: 0, depth: 0, normal_force_mag: 0 };
    // Full-circle concave surfaces have no endpoints — the whole ring is
    // active, so skip the segment clip (there is nowhere "off the segment").
    if (!this.isFullCircle) {
      const tau = this.tangentParam(body.position);
      if (tau < 0 || tau > this.length) {
        return { Fx: 0, Fy: 0, depth: 0, normal_force_mag: 0 };
      }
    }
    const depth = -s;
    const n = this.normalAt(body.position);
    const vNormal = body.velocity.x * n.x + body.velocity.y * n.y;
    // A per-surface override (this.k_contact) wins over the scene default; when
    // null the passed-in scene k_contact is used, so the default path is
    // unchanged (byte-identical) for every surface that omits the override.
    const k = this.k_contact ?? k_contact;
    let Fmag = k * depth;
    if (vNormal < 0) {
      Fmag += -c_damping * vNormal;
    }
    return {
      Fx: Fmag * n.x,
      Fy: Fmag * n.y,
      depth,
      normal_force_mag: Fmag
    };
  }
}

// Rigid distance constraint between a body and a fixed anchor.
// Used for the simple pendulum (Phase G). Implemented as a stiff spring
// at the constraint length — penalty-style same as Surface, so Phase C
// can ship it without a separate constraint solver.
//
// The pendulum is the prototypical RodConstraint user; for v1 we accept
// the slight length-oscillation that penalty introduces. Phase 3 can
// add a true holonomic constraint solver if precision demands it.
export class RodConstraint {
  constructor({ id, body_id, anchor, length_m, k_constraint = DEFAULT_K_CONSTRAINT, c_damping = 632 }) {
    this.id = id;
    this.body_id = body_id;
    this.anchor = { x: anchor.x, y: anchor.y };
    this.length = length_m;
    this.k = k_constraint;
    this.c = c_damping;
  }

  // Returns force on body to maintain rigid distance.
  //
  // Accepts (and ignores) a 2nd `sceneCtx` argument so every constraint's
  // applyTo shares ONE signature — `applyTo(body, sceneCtx)`. RodConstraint is
  // single-body (anchor-to-body) and needs no partner lookup, so the arg is
  // unused; the underscore documents that. This keeps the derivState /
  // fbd_overlay / motion_graph constraint loops uniform after
  // StringConstraint (which DOES read sceneCtx.bodies) landed — the pendulum
  // scenes stay byte-identical because the ignored arg changes no arithmetic.
  applyTo(body, _sceneCtx) {
    const dx = body.position.x - this.anchor.x;
    const dy = body.position.y - this.anchor.y;
    const r = Math.hypot(dx, dy);
    if (r === 0) return zero();
    const stretch = r - this.length;
    const radialDir = { x: dx / r, y: dy / r };
    // Radial velocity (positive = moving away from anchor).
    const vRadial = body.velocity.x * radialDir.x + body.velocity.y * radialDir.y;
    // Stiff spring + damping along radial direction.
    const Fmag = -this.k * stretch - this.c * vRadial;
    return { x: Fmag * radialDir.x, y: Fmag * radialDir.y };
  }

  appliesTo(bodyId) {
    return bodyId === this.body_id;
  }
}

// Two-body inextensible STRING over an ideal (massless, frictionless) point
// pulley — the Atwood machine. This is the engine's FIRST genuine two-body
// coupling: unlike RodConstraint (single body ↔ fixed anchor), StringConstraint
// reads BOTH participating bodies from `sceneCtx.bodies` so the tension it
// returns for whichever body is passed reflects the SYMMETRIC state of the whole
// string.
//
// Physics (sim_body_coupling_atwood, docs/physics_briefs/atwood_machine_brief.md):
//   - Each rope segment length is the radial distance from a body to the pulley
//     POINT:  d_a = |pos_a − pulley|,  d_b = |pos_b − pulley|.
//   - Rope stretch  s = (d_a + d_b) − total_length_m.  Slack (s ≤ 0) ⇒ zero
//     force (a string pulls, never pushes — mirrors the Tension force).
//   - ONE scalar tension is computed from the SYMMETRIC stretch and
//     stretch-rate ṡ = ḋ_a + ḋ_b (both bodies' radial velocities):
//         T = max(0, k·s + c·ṡ)
//     and the SAME T is returned toward the pulley for WHICHEVER body is
//     passed, so T_a = T_b BY CONSTRUCTION (equal tension, ideal pulley) — the
//     coupled acceleration a = (m₁−m₂)g/(m₁+m₂) falls straight out of the
//     geometry with no per-scene coupling math. Damping is deliberately NOT the
//     single passed body's vRadial (the Rod/Tension trick) — that would give
//     T_a ≠ T_b and break equal tension.
//   - The ideal string does ZERO net work → energyKey = null → it must NOT leak
//     into U_thermal (the energy tracker never walks a constraint anyway; the
//     null key documents the contract and matches the Tension force).
//
// Modelled as a stiff PENALTY spring on the stretch (mirrors RodConstraint), not
// a rigid holonomic constraint. Critical damping for the TWO-body penalty mode
// uses the REDUCED mass μ = m_a·m_b/(m_a+m_b): c = 2·√(k·μ). When c_damping is
// omitted it is DERIVED live from the partner masses in sceneCtx (do NOT copy
// RodConstraint's single-body 632 — wrong for μ ≠ 1). k_constraint defaults to
// DEFAULT_K_CONSTRAINT so the derived c always has a real k to work from.
//
// NOTE on the reuse boundary (P2 architectural-scope note): only the sceneCtx
// partner-reading PLUMBING generalizes to future multi-body couplings — NOT this
// equal-tension physics. An inertial (massive) pulley needs UNEQUAL tensions
// (T_a ≠ T_b) to angularly accelerate the wheel — a genuinely NEW constraint,
// not an extension of this one.
export class StringConstraint {
  constructor({ id, body_a, body_b, pulley, total_length_m,
    k_constraint = DEFAULT_K_CONSTRAINT, c_damping }) {
    this.id = id;
    this.body_a = body_a;
    this.body_b = body_b;
    this.pulley = { x: pulley.x, y: pulley.y };
    this.total_length_m = total_length_m;
    this.k = k_constraint;
    // May be undefined — DERIVED from the live reduced mass in applyTo when so
    // (kept as-is here rather than a constructor default because μ is not known
    // until the partner masses are read from sceneCtx).
    this.c = c_damping;
    // Ideal string does no net work — no U_thermal / no potential channel.
    this.energyKey = null;
    // Warn-once latch for the missing-partner guard (avoids spamming the
    // console once per RK4 sub-step).
    this._warnedMissingPartner = false;
  }

  appliesTo(bodyId) {
    return bodyId === this.body_a || bodyId === this.body_b;
  }

  // Returns the tension force on `body` as a BARE {x,y} vec2 (constraints are
  // NOT Force subclasses — no withTau wrapper), directed from `body` toward the
  // pulley. Reads the partner body from sceneCtx.bodies.
  applyTo(body, sceneCtx) {
    const bodies = sceneCtx && sceneCtx.bodies;
    if (!bodies) {
      this._warnOncePartner(
        `StringConstraint "${this.id}" applied with no sceneCtx.bodies — ` +
        `cannot resolve its partner; returning zero force.`
      );
      return { x: 0, y: 0 };
    }
    const a = bodies.find((b) => b.id === this.body_a);
    const b = bodies.find((bb) => bb.id === this.body_b);
    if (!a || !b) {
      this._warnOncePartner(
        `StringConstraint "${this.id}" could not resolve body_a="${this.body_a}" ` +
        `and/or body_b="${this.body_b}" in sceneCtx.bodies; returning zero force.`
      );
      return { x: 0, y: 0 };
    }

    // Radial vectors from the pulley to each body (body is at pulley + d·û).
    const ax = a.position.x - this.pulley.x;
    const ay = a.position.y - this.pulley.y;
    const bx = b.position.x - this.pulley.x;
    const by = b.position.y - this.pulley.y;
    const d_a = Math.hypot(ax, ay);
    const d_b = Math.hypot(bx, by);

    // Zero-distance guard (mirror RodConstraint's r===0 return) — BEFORE any
    // unit vector, stretch-rate, or toward-pulley division. Reachable: the
    // ascending body reaches the pulley (d → 0) while the string is still taut
    // (s > 0), so the s ≤ 0 slack return below does NOT catch it. Dividing by
    // d here would produce NaN T and poison every body in the RK4 state.
    if (d_a === 0 || d_b === 0) return { x: 0, y: 0 };

    const s = (d_a + d_b) - this.total_length_m;
    // Slack: a string pulls only when stretched (one-sided, mirrors Tension).
    if (s <= 0) return { x: 0, y: 0 };

    // Outward radial unit vectors (pulley → body).
    const uax = ax / d_a, uay = ay / d_a;
    const ubx = bx / d_b, uby = by / d_b;
    // ḋ = rate of change of each rope segment's length = v · û (positive when
    // the body recedes from the pulley, lengthening its segment).
    const ddot_a = a.velocity.x * uax + a.velocity.y * uay;
    const ddot_b = b.velocity.x * ubx + b.velocity.y * uby;
    const sdot = ddot_a + ddot_b; // symmetric stretch-rate (BOTH bodies)

    // Critical damping for the TWO-body penalty mode uses the reduced mass.
    // DERIVE it from the live partner masses when c_damping was omitted so a
    // schema-valid scene that leaves the field off cannot produce NaN tension.
    let c = this.c;
    if (c === undefined || c === null) {
      const mu = (a.mass * b.mass) / (a.mass + b.mass);
      c = 2 * Math.sqrt(this.k * mu);
    }

    // ONE scalar tension from the symmetric stretch + stretch-rate. The max(0,…)
    // clamp keeps a string from ever PUSHING (T ≥ 0 always).
    const T = Math.max(0, this.k * s + c * sdot);
    // Clamped-to-zero (taut but converging fast) ⇒ clean {0,0}, matching the
    // slack / zero-distance returns and avoiding a signed −0 from −0·û.
    if (T === 0) return { x: 0, y: 0 };

    // Return T toward the pulley for whichever body was passed. Toward-pulley is
    // −û (û points pulley → body). Same scalar T for either body ⇒ T_a = T_b.
    const isA = body.id === this.body_a;
    const ux = isA ? uax : ubx;
    const uy = isA ? uay : uby;
    return { x: -T * ux, y: -T * uy };
  }

  _warnOncePartner(msg) {
    if (!this._warnedMissingPartner) {
      console.warn(msg);
      this._warnedMissingPartner = true;
    }
  }
}

// Two-body RIGID rod — a stiff penalty link holding two bodies at a fixed
// separation `length_m`. This is the body-to-body rod the double pendulum needs
// (rod bob-1 ↔ bob-2), the deliverable Idea-12 (sim_body_coupling_atwood) left
// unbuilt when it shipped the Atwood *string* instead. Consumed by
// sim_numerical_chaos P3.
//
// How it differs from the two constraints it sits between:
//   - RodConstraint is body ↔ FIXED ANCHOR (single body, no partner lookup).
//     BodyRodConstraint is body ↔ BODY, so — like StringConstraint — it reads
//     BOTH participants from `sceneCtx.bodies`.
//   - StringConstraint is a one-sided string (pulls only: `T = max(0, …)`) bent
//     over a pulley. A rigid rod is TWO-SIDED: it resists BOTH extension (pulls
//     the bobs together) AND compression (pushes them apart), so there is NO
//     max(0,…) clamp — exactly like the anchor RodConstraint, whose penalty is
//     also two-sided.
//
// Physics (docs/physics_briefs/sim_body_rod_constraint_brief.md,
// docs/physics_briefs/sim_double_pendulum_brief.md §4–6):
//   - Separation r = |pos_a − pos_b|; stretch s = r − length_m (signed:
//     s > 0 stretched, s < 0 compressed).
//   - û = (pos_a − pos_b)/r  (unit vector body_b → body_a).
//   - Radial relative velocity ṙ = (v_a − v_b)·û (the rate of change of r) —
//     SYMMETRIC, identical no matter which body is passed.
//   - Scalar penalty magnitude  Fmag = −k·s − c·ṙ  (Hooke restoring + radial
//     damping). Computed ONCE from the shared state.
//   - The force on body_a is Fmag·û; body_b gets the exact reaction −Fmag·û
//     (Newton's 3rd law). Because both applyTo(body_a) and applyTo(body_b) read
//     the SAME sub-step positions from sceneCtx.bodies (derivState syncs them
//     before the force loop), the two forces are equal-and-opposite to floating
//     point ⇒ linear momentum is conserved exactly.
//   - energyKey = null: an ideal rigid rod does zero net work — it never enters
//     the tracked energy budget (the ConservationTracker walks forces by key,
//     never constraints; the null documents the contract, matching Rod/String).
//     The tiny elastic energy stored in the penalty stretch
//     (U_e ≈ ½k·s² ≈ 1×10⁻² J vs ~29 J total) shows up only as bounded drift,
//     handled by P3's `driftCeilingPctUndamped` = 3.0 % ceiling.
//
// Damping default. When c_damping is omitted it is DERIVED from the live reduced
// mass μ = m_a·m_b/(m_a+m_b): c = 2·√(k·μ) — critical damping for the two-body
// penalty mode (the SAME derivation StringConstraint uses; do NOT copy
// RodConstraint's single-body literal 632, wrong for μ ≠ 1). The chaos scene
// deliberately sets c_damping = 0 (energy-clean UNDAMPED) — verified stable
// because ω_c·dt = √(k/μ)·dt ≈ 0.447 ≪ 2 at the scene's dt (brief §5–6).
// ----- activate_on_contact: the WELD-ON-IMPACT channel (orbit_weld_on_contact) -----
//
// Optional. Absent/false ⇒ the rod is active from t=0 and this class is BYTE-IDENTICAL
// to what it was before the flag existed (the double pendulum's bob↔bob link is the
// existing consumer and must not move by one bit). True ⇒ the rod is DORMANT — it
// applies exactly zero force — until body_a and body_b first TOUCH, at which point it
// latches rigidly welded for the rest of the run.
//
// WHY the primitive exists (docs/physics_briefs/orbit_weld_on_contact_brief.md).
// The perfectly-inelastic merge resolver (collisions.js) fires only while a pair is
// in contact AND APPROACHING (`vRel < 0`). That guard is what makes it latch-free and
// replay-safe — but it also makes it ONE-SIDED: it can stop two bodies converging, and
// it can never pull two bodies back together. Two gravity-bound point particles stuck
// at radius r sit at slightly DIFFERENT radii, so the tidal gradient 2GM·Σr/r³ shears
// them apart; the instant that shear makes them recede the merge stops firing and
// NOTHING restores them. They drift out of contact range and the merge can never
// re-fire. A rigid rod is the missing piece precisely because it is TWO-SIDED — but a
// rod active from t=0 would TETHER the two bodies across the whole approach, which for
// an orbital intercept destroys the back-propagated trajectory that makes them meet at
// all. Hence: sleep, then weld.
//
// THREE implementation facts, each load-bearing:
//
//  (a) The latch is set in the runner's STEP-3 slot, never inside applyTo(). applyTo
//      runs FOUR times per tick (once per RK4 sub-stage) on TRIAL states the integrator
//      may discard — a k2/k4 trial that overshoots into contact would weld the rod on a
//      state that never happened. So this class also implements `resolve(sceneCtx)`, the
//      SAME contract the collision resolvers use, which the runner calls once per tick on
//      the COMMITTED post-integration state (after syncBodies). scene.js registers a
//      contact-activated rod in `collisionResolvers`, so the latch is evaluated on the
//      LIVE path and the HEADLESS path alike (activation changes band-checked dynamics —
//      a weld that existed only in the browser would make --check-against a lie).
//
//  (b) reset() CLEARS the latch. This is a deliberate departure from collisions.js's
//      "resolvers are STATELESS — no latch" rule, and it is principled. That rule exists
//      because an "already merged, don't re-merge" latch would leak across a timeline
//      scrub and silently SKIP the merge on replay. A weld latch is the mirror image: it
//      must be cleared on reset so the replay starts un-welded, re-contacts, and re-welds.
//      The runner already clears exactly this class of per-run state (circuitState,
//      wallImpulse, inductionFluxState); the constraint latch joins them.
//
//  (c) BOTH bodies need a positive radius_m. Contact is undetectable between point
//      bodies (contactGeom's depth = rA + rB − r is never > 0 at rA = rB = 0), so an
//      activate_on_contact rod between two radius-less bodies would sleep FOREVER —
//      a silent no-op that looks like "the weld didn't work". scene.js asserts the radii
//      at LOAD time rather than letting the scene run and quietly do nothing.
//
// STIFFNESS WARNING for scenes in a scaled frame. k_constraint's default
// (DEFAULT_K_CONSTRAINT = 1e5) is tuned for SI-scale pendulums (N/m, ~1 kg bodies). The
// penalty mode rings at ω = √(k/μ), and RK4 needs ω·dt well under 2. In a CANONICAL
// frame (GM=1, r0=1) with a light debris fragment (μ ≈ 5e-3), the default gives
// ω·dt ≈ 4.5 — PAST the stability limit; the integrator blows up. A scaled-frame scene
// MUST set k_constraint explicitly, sized between the rigidity floor (stretch under the
// peak tidal load stays a small fraction of the separation) and the stability ceiling
// (ω·dt ≤ 0.5). The brief derives both bounds; the archetype computes them.
export class BodyRodConstraint {
  constructor({ id, body_a, body_b, length_m,
    k_constraint = DEFAULT_K_CONSTRAINT, c_damping, activate_on_contact = false }) {
    this.id = id;
    this.body_a = body_a;
    this.body_b = body_b;
    this.length = length_m;
    this.k = k_constraint;
    // May be undefined — DERIVED from the live reduced mass in applyTo when so
    // (μ is not known until the partner masses are read from sceneCtx).
    // c_damping = 0 is respected as-is (explicit undamped), never re-derived.
    this.c = c_damping;
    // Rigid rod does zero net work — no U_thermal / no potential channel.
    this.energyKey = null;
    this._warnedMissingPartner = false;
    // The weld channel. `_active` is the LATCH; it starts true for a plain rod, so an
    // unflagged constraint never consults the latch machinery at all and stays
    // byte-identical. `_active` is the ONLY mutable per-run state on this object, and
    // reset() is the ONLY thing that clears it.
    this.activateOnContact = activate_on_contact === true;
    this._active = !this.activateOnContact;
  }

  appliesTo(bodyId) {
    return bodyId === this.body_a || bodyId === this.body_b;
  }

  // Step-3 resolver contract — `resolve(sceneCtx, tracker)`, identical in shape to the
  // collision resolvers, so scene.js can dispatch this rod from the SAME per-tick loop
  // (collisionResolvers) on both the live and headless paths. Called once per tick on
  // the COMMITTED post-integration state (see (a) above). Registered ONLY for a rod with
  // activate_on_contact — a plain rod is never in the resolver list.
  //
  // MONOTONIC: it can only ever turn the weld ON. It never releases a welded rod — a rod
  // that let go the moment the tidal gradient stretched the pair past contact range would
  // reproduce, exactly, the one-sided failure of the merge that this primitive exists to
  // fix. Once welded, the rod's own restoring force is what keeps the pair touching.
  //
  // `tracker` is unused (a weld is a kinematic gate, not an energy event — the ROD is
  // ideal and books nothing; the inelastic capture's ΔK is the MERGE's job, and the merge
  // resolver deposits it). The arg is in the signature for contract parity with its
  // siblings, exactly as BoxWallReflection's is.
  resolve(sceneCtx, _tracker) {
    if (this._active) return;              // already welded — monotonic, nothing to do
    const bodies = sceneCtx?.bodies;
    if (!bodies) return;
    const a = bodies.find((x) => x.id === this.body_a);
    const b = bodies.find((x) => x.id === this.body_b);
    if (!a || !b) return;
    // The ONE shared contact test (forces.js) — depth > 0 ⟺ the disks overlap. Note we
    // deliberately do NOT require `approaching` (vRel < 0) the way the merge does: the
    // merge needs it to self-suppress without a latch, whereas THIS gate has a latch and
    // wants to weld on any real touch, however it arose.
    if (!contactGeom(a, b)) return;
    this._active = true;
    // PUBLISH the weld so the rest of the step-3 slot can see it. The perfectly-inelastic
    // merge reads this and STANDS DOWN (collisions.js): its one-time inelastic capture is
    // already done, and a welded pair is co-moving, so its ΔK = kBefore − kAfter degrades
    // into catastrophic cancellation (±1e-16 noise) that trips the merge's strict
    // negative-ΔK guard and kills the run. The latch is the seam that keeps the two
    // resolvers from fighting over a pair that is now ONE rigid object.
    sceneCtx.weldedPairs?.add(weldPairKey(this.body_a, this.body_b));
  }

  // Clear the weld latch — called by the runner on reset() (and at construction of a
  // fresh run). A plain rod (no activate_on_contact) resets to ACTIVE, which is its only
  // valid state, so this is a no-op for every existing consumer.
  reset() {
    this._active = !this.activateOnContact;
  }

  // Returns the rod force on `body` as a BARE {x,y} vec2 (constraints are NOT
  // Force subclasses — no withTau wrapper). Reads the partner body from
  // sceneCtx.bodies; the reaction is applied when the loop passes the partner.
  applyTo(body, sceneCtx) {
    // DORMANT until welded (activate_on_contact only). Zero force — not a small force,
    // not a soft spring: the two bodies must be dynamically INDEPENDENT during the
    // approach, or an orbital intercept's back-propagated trajectory is perturbed by the
    // very rod that is supposed to be asleep. `_active` is true from construction for a
    // plain rod, so this is a single already-true branch on the existing hot path.
    //
    // This gate READS the latch; it never SETS it. Setting it here would evaluate contact
    // on RK4 trial sub-states (applyTo runs 4× per tick) and could weld on a state the
    // integrator discards — see (a) in the class comment. resolve() owns the write.
    if (!this._active) return zero();
    const bodies = sceneCtx && sceneCtx.bodies;
    if (!bodies) {
      this._warnOncePartner(
        `BodyRodConstraint "${this.id}" applied with no sceneCtx.bodies — ` +
        `cannot resolve its partner; returning zero force.`
      );
      return { x: 0, y: 0 };
    }
    const a = bodies.find((b) => b.id === this.body_a);
    const b = bodies.find((bb) => bb.id === this.body_b);
    if (!a || !b) {
      this._warnOncePartner(
        `BodyRodConstraint "${this.id}" could not resolve body_a="${this.body_a}" ` +
        `and/or body_b="${this.body_b}" in sceneCtx.bodies; returning zero force.`
      );
      return { x: 0, y: 0 };
    }

    // Separation vector body_b → body_a.
    const dx = a.position.x - b.position.x;
    const dy = a.position.y - b.position.y;
    const r = Math.hypot(dx, dy);
    // Zero-separation guard (mirror RodConstraint/StringConstraint): û is
    // undefined at r === 0; dividing would poison the RK4 state with NaN.
    if (r === 0) return zero();

    const stretch = r - this.length;
    // Unit vector body_b → body_a.
    const ux = dx / r, uy = dy / r;
    // Radial relative velocity ṙ = (v_a − v_b)·û. Symmetric ⇒ same for either
    // body passed, so Fmag below is direction-independent.
    const vRadial =
      (a.velocity.x - b.velocity.x) * ux + (a.velocity.y - b.velocity.y) * uy;

    // Reduced-mass critical damping when c_damping was omitted (undefined/null);
    // an explicit 0 stays 0 (the energy-clean undamped chaos rod).
    let c = this.c;
    if (c === undefined || c === null) {
      const mu = (a.mass * b.mass) / (a.mass + b.mass);
      c = 2 * Math.sqrt(this.k * mu);
    }

    // Two-sided penalty (NO max(0,…) clamp — a rigid rod pushes AND pulls):
    // Fmag > 0 when compressed (s < 0) ⇒ pushes body_a along +û (away from b);
    // Fmag < 0 when stretched  (s > 0) ⇒ pulls body_a along −û (toward b).
    const Fmag = -this.k * stretch - c * vRadial;

    // body_a gets +Fmag·û; body_b gets the exact reaction −Fmag·û (N3L).
    const sign = body.id === this.body_a ? 1 : -1;
    return { x: sign * Fmag * ux, y: sign * Fmag * uy };
  }

  _warnOncePartner(msg) {
    if (!this._warnedMissingPartner) {
      console.warn(msg);
      this._warnedMissingPartner = true;
    }
  }
}

export const NAME = 'constraints';
