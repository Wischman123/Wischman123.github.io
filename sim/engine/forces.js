// engine/forces.js
//
// Force composition. Every physical phenomenon that produces a vector
// force from current geometry is a Force class. Constraints (rigid
// rods, inextensible ropes, surfaces) live in constraints.js.
//
// Each Force exposes:
//   - applyTo(body, sceneCtx) : returns {F: {x, y}, tau: {x, y, z}}
//                 for this body THIS step. Phase 3.4 (Q5=B) made the
//                 return shape uniform across ALL Force subclasses;
//                 Phase 5.R1 (Q1=α / Q5=α) widened τ from scalar to
//                 vec3 so dispatch can vec3.add across heterogeneous
//                 force returns. F stays vec2 (Q1=α). Only
//                 DipoleInField returns nonzero τ in v0; in v1's 2D
//                 engine τ.x and τ.y must be 0 (assertScalarTau gates
//                 every dispatch). The integrator's consumer contract
//                 destructures both fields and routes τ.z to rotational
//                 state-derivative slot when the body declares
//                 `body.stateSize === 6`.
//   - energyKey : the ConservationTracker key this force contributes to
//                 (or null if the force does no work, e.g., LorentzForce)
//   - potentialEnergy(body, sceneCtx) : the U contribution at the body's
//                 current state, or 0 if force is non-conservative
//
// The integrator never knows what kind of force is acting — it only
// asks "given the current state, what is the total force AND torque on
// each body?" This is the extension-safety contract.
//
// Phase C1 session 2: adds Friction (regularized Coulomb against a
// surface) and Tension (rigid rope, point-to-point) on top of the
// C1-starter set (Gravity, Spring, Drag).
//
// Phase 3.4 sign-convention pin (DipoleInField only): with in-plane
// μ = (μ_x, μ_y, 0) and B = (B_x, B_y, 0),
//   τ = (μ × B).z = μ_x · B_y − μ_y · B_x
// Positive τ = counter-clockwise about ẑ. Restoring behavior is
// implicit in the geometry; the integrator does NOT manually flip
// signs.

import { sub, scale, mag, normalize, zero, vec3 } from './vec.js';
import { GRAVITATIONAL_CONSTANT, DEFAULT_K_CONTACT } from './constants.js';
import { submergedVolume, buoyantPotentialEnergy } from './fluids.js';

// Phase 3.4 (Q5=B) / Phase 5.R1 (Q1=α / Q5=α) helper. Wraps a
// force-only return value into the uniform {F, tau} shape. F stays
// vec2; τ widened to vec3 in Phase 5.R1 so the dispatch site at
// scene.js can run vec3.add over heterogeneous force returns. Used
// by every subclass that does not generate torque (the 7 non-dipole
// Force classes).
function withTau(F) {
  return { F, tau: vec3.zero() };
}

export class Force {
  constructor() {
    this.energyKey = null;
  }
  appliesTo(bodyId) {
    return this.applies_to.includes(bodyId);
  }
  applyTo(/* body, sceneCtx */) {
    return { F: zero(), tau: vec3.zero() };
  }
  potentialEnergy(/* body, sceneCtx */) {
    return 0;
  }
}

// Regularized Coulomb friction velocity threshold. Below this tangential
// speed, friction is smoothly attenuated to avoid the discontinuity at
// v=0. Larger threshold = more "creep" at rest; smaller = sharper but
// risks sign-flip oscillation in the integrator. 1 cm/s matches the
// velocity tolerance band's absolute floor (docs/sim_tolerance_bands.md).
const FRICTION_V_THRESHOLD = 0.01;

// Gravity supports two models, selected by `model`:
//   - 'constant_g' (default): uniform near-surface field, F = -mg ŷ;
//     U_g = mgy. Per-body, ignores other bodies.
//   - 'universal': Newtonian 1/r² attraction between massive bodies,
//     F = G m₁m₂/r² toward the other mass; U_g = -G m₁m₂/r. Pair-iterates
//     sceneCtx.bodies exactly like Coulomb (but ATTRACTIVE, keyed on
//     `mass` not `charge`), so orbits/Kepler/escape-velocity become
//     expressible. Both models share energyKey 'U_g'; a scene uses one or
//     the other (scene_defaults.gravity_model), never both on one body.
//
// PAIR-COUNTING (universal): potentialEnergy returns HALF the per-other
// sum so ConservationTracker's iteration over all bodies recovers the
// full pair PE once — identical contract to Coulomb. The static
// Gravity.pairEnergy(a, b) returns the FULL -G m₁m₂/r for audit/test use.
export class Gravity extends Force {
  constructor({ applies_to, g = 9.8, model = 'constant_g', G = GRAVITATIONAL_CONSTANT }) {
    super();
    this.applies_to = applies_to;
    this.g = g;
    this.model = model;
    this.G = G;
    this.energyKey = 'U_g';
  }
  applyTo(body, sceneCtx = {}) {
    if (this.model === 'constant_g') {
      return withTau({ x: 0, y: -this.g * body.mass });
    }
    if (this.model === 'universal') {
      const bodies = sceneCtx.bodies;
      if (!bodies) return withTau(zero());
      let Fx = 0;
      let Fy = 0;
      for (const other of bodies) {
        if (other === body) continue;
        if (typeof other.mass !== 'number' || other.mass <= 0) continue;
        const dx = body.position.x - other.position.x;
        const dy = body.position.y - other.position.y;
        const r2 = dx * dx + dy * dy;
        if (r2 === 0) continue;
        const r = Math.sqrt(r2);
        // Gravity is ALWAYS attractive: force on `body` points TOWARD
        // `other`, i.e. along -(body - other). Magnitude G m₁m₂/r².
        const fmag = this.G * body.mass * other.mass / r2;
        Fx -= fmag * dx / r;
        Fy -= fmag * dy / r;
      }
      return withTau({ x: Fx, y: Fy });
    }
    throw new Error(`Gravity model "${this.model}" not implemented (expected "constant_g" or "universal").`);
  }
  potentialEnergy(body, sceneCtx = {}) {
    if (this.model === 'constant_g') {
      // U_g = m g y with reference y = 0.
      return body.mass * this.g * body.position.y;
    }
    if (this.model === 'universal') {
      const bodies = sceneCtx.bodies;
      if (!bodies) return 0;
      if (typeof body.mass !== 'number' || body.mass <= 0) return 0;
      let U = 0;
      for (const other of bodies) {
        if (other === body) continue;
        if (typeof other.mass !== 'number' || other.mass <= 0) continue;
        const dx = body.position.x - other.position.x;
        const dy = body.position.y - other.position.y;
        const r = Math.hypot(dx, dy);
        if (r === 0) continue;
        U += -this.G * body.mass * other.mass / r;
      }
      // Half-counting (see class header). Mirrors Coulomb.potentialEnergy.
      return 0.5 * U;
    }
    return 0;
  }

  // STATIC. Full closed-form -G m₁m₂/r between two massive bodies. Not
  // halved — for audit/test consumers that want the pair PE directly.
  // Mirrors Coulomb.pairEnergy.
  static pairEnergy(a, b, G = GRAVITATIONAL_CONSTANT) {
    const dx = a.position.x - b.position.x;
    const dy = a.position.y - b.position.y;
    const r = Math.hypot(dx, dy);
    if (r === 0) return 0;
    return -G * a.mass * b.mass / r;
  }
}

// Constant applied acceleration on a body — the settable "a₀" companion to
// the inspector's editable v₀ (plan sim_interactivity_viz T9: "set the
// initial velocity AND acceleration, then hit play and see how it affects
// everything"). A uniform acceleration field a exerts F = m·a, so the body
// integrates under a (plus any OTHER scene forces — e.g. the rail brake —
// which is exactly the "affects everything" the teacher wants to watch).
//
// CONSERVATIVE, with potential U = −m·(a·r) (F = −∇U = m·a), so energy
// closes exactly — near-surface Gravity is the a = (0, −g) special case
// (U = mgy). energyKey is body-suffixed so two bodies' applied-accel
// potentials never collide in the energy map (mirrors U_inductor_<loop.id>).
//
// Built ONLY for a body carrying a nonzero `applied_acceleration_m_per_s2`
// scene property (scene.js). A zero/absent vector adds no force, so every
// existing scene — including the pure rail-brake the T5 drift gate checks —
// is byte-identical.
export class AppliedAcceleration extends Force {
  constructor({ applies_to, a_m_per_s2 }) {
    super();
    this.applies_to = applies_to;
    this.a = { x: a_m_per_s2?.x ?? 0, y: a_m_per_s2?.y ?? 0 };
    this.energyKey = `U_applied_${applies_to.join('_')}`;
  }
  applyTo(body) {
    return withTau({ x: body.mass * this.a.x, y: body.mass * this.a.y });
  }
  potentialEnergy(body) {
    // U = −m·(a·r), reference at the origin. −∇U = m·a recovers applyTo.
    return -body.mass * (this.a.x * body.position.x + this.a.y * body.position.y);
  }
}

export class Spring extends Force {
  constructor({ applies_to, k_N_per_m, rest_length_m, anchor }) {
    super();
    this.applies_to = applies_to;
    this.k = k_N_per_m;
    this.L0 = rest_length_m;
    this.anchor = anchor;
    this.energyKey = 'U_e';
  }
  applyTo(body) {
    const r = sub(body.position, this.anchor);
    const len = mag(r);
    if (len === 0) return withTau(zero());
    const stretch = len - this.L0;
    const dir = normalize(r);
    return withTau(scale(dir, -this.k * stretch));
  }
  potentialEnergy(body) {
    const r = sub(body.position, this.anchor);
    const stretch = mag(r) - this.L0;
    return 0.5 * this.k * stretch * stretch;
  }
}

export class Drag extends Force {
  constructor({ applies_to, model = 'linear', b = 0, c = 0 }) {
    super();
    this.applies_to = applies_to;
    this.model = model;
    this.b = b;
    this.c = c;
    // Drag is dissipative — energy goes to U_thermal via work-tracking,
    // not a state-function potential. ConservationTracker integrates
    // dissipated work separately.
    this.energyKey = 'U_thermal';
  }
  applyTo(body) {
    const v = body.velocity;
    if (this.model === 'linear') {
      return withTau({ x: -this.b * v.x, y: -this.b * v.y });
    }
    if (this.model === 'quadratic') {
      const speed = mag(v);
      if (speed === 0) return withTau(zero());
      const fac = -this.c * speed;
      return withTau({ x: fac * v.x, y: fac * v.y });
    }
    throw new Error(`Drag model "${this.model}" not implemented.`);
  }
  potentialEnergy() {
    return 0;
  }
  powerDissipated(body) {
    const { F } = this.applyTo(body);
    return F.x * body.velocity.x + F.y * body.velocity.y;
  }
}

// Friction force against a named Surface. Uses regularized Coulomb
// friction (smoothed near v=0) rather than full static-kinetic mode
// switching — the regularization avoids the v=0 discontinuity that
// would otherwise oscillate the integrator. Trade-off: a body at the
// friction-limited equilibrium creeps at v≈v_threshold instead of
// truly stopping. v2 (Phase C2 polish) can add a 2-pass static
// detector that zeroes the residual creep for "stuck" bodies.
//
// Normal force magnitude comes from the Surface's penalty contact
// resolution (constraints.js). Friction reads it via sceneCtx.surfaces.
// If the body is not in contact (penalty depth = 0), no friction.
export class Friction extends Force {
  constructor({ applies_to, mu_k, mu_s, surface_id }) {
    super();
    this.applies_to = applies_to;
    this.mu_k = mu_k;
    this.mu_s = mu_s ?? mu_k;
    this.surface_id = surface_id;
    this.energyKey = 'U_thermal';
  }

  applyTo(body, sceneCtx = {}) {
    const surfaces = sceneCtx.surfaces;
    if (!surfaces) return withTau(zero());
    const surface = surfaces.get(this.surface_id);
    if (!surface) {
      throw new Error(
        `Friction force references unknown surface "${this.surface_id}". ` +
        `Scene must declare a surface with that id.`
      );
    }
    const contact = surface.contactForce(body, sceneCtx.k_contact, sceneCtx.c_damping);
    const N = contact.normal_force_mag;
    if (N <= 0) return withTau(zero());

    // Tangent is position-dependent on arc surfaces; tangentAt returns
    // the constant surface tangent for flat/inclined. (Local `tan` —
    // surface.tangentAt — is shadowed by the rotational `tau` field
    // name; rename the surface tangent to `tan` here to keep the
    // {F, tau} return-shape destructuring readable.)
    const tan = surface.tangentAt(body.position);
    const vt = body.velocity.x * tan.x + body.velocity.y * tan.y;
    // Regularized Coulomb: factor smoothly transitions from -1 to +1
    // through v=0, with steepness set by FRICTION_V_THRESHOLD.
    const factor = vt / Math.hypot(vt, FRICTION_V_THRESHOLD);
    const fmag = this.mu_k * N * factor;
    return withTau({
      x: -fmag * tan.x,
      y: -fmag * tan.y
    });
  }

  potentialEnergy() {
    return 0;
  }

  powerDissipated(body, sceneCtx) {
    const { F } = this.applyTo(body, sceneCtx);
    return F.x * body.velocity.x + F.y * body.velocity.y;
  }
}

// RollingContact: no-slip rolling of a rigid body (disk/cylinder/sphere) on a
// surface, enforced by a slip-velocity PENALTY. Phase D2 — the first force that
// COUPLES a body's translation and rotation through the contact point.
//
// Physics (docs/physics_briefs/sim_phase_d2_rolling_brief.md). The contact point
// sits at −R·n̂ from the CoM; its tangential velocity — the SLIP —
//   σ = v·t̂ + ω·R          (t̂ = surface tangent, ω = signed spin, R = radius)
// is zero for ideal rolling. This force drives σ → 0 with a penalty:
//   static/rolling:   F_t = −c·σ                          (capped at µ_s·N)
//   kinetic/slipping: F_t = −µ_k·N·σ/√(σ²+v_thr²)         (reuses Friction's reg.)
// and applies the matching contact torque τ_z = R·F_t (spins the body up). In
// the static regime the penalty SETTLES to the exact no-slip friction
// −Mg sinθ·I/(I+MR²) with a tiny residual slip σ_ss = g sinθ / [c(1/M+R²/I)];
// pick c from the stability bound k_σ·dt ≲ 2.5 (brief §5).
//
// Returns the uniform {F, tau} shape (F vec2 along t̂, tau vec3 about ẑ), so it
// rides the shipped stride-6 torque routing (scene.js:658) with NO integrator
// edit — the library-first framing: the next rolling body reuses this class.
// Reads N + t̂ from the surface's penalty contact (the accessor Friction uses),
// so the body must be in contact (N > 0) or the force is zero. `radius_m` (the
// rolling radius) and `slip_penalty_c` (penalty stiffness, N·s/m — REQUIRED, no
// default: the stable value depends on M, I, R, dt) are force parameters, NOT
// read off the body.
export class RollingContact extends Force {
  constructor({ applies_to, mu_k, mu_s, surface_id, radius_m, slip_penalty_c }) {
    super();
    this.applies_to = applies_to;
    this.mu_k = mu_k;
    this.mu_s = mu_s ?? mu_k;
    this.surface_id = surface_id;
    if (!(radius_m > 0)) {
      throw new Error(
        `RollingContact requires a positive radius_m (the rolling radius); got ${radius_m}.`
      );
    }
    this.radius_m = radius_m;
    if (!(slip_penalty_c > 0)) {
      throw new Error(
        `RollingContact requires a positive slip_penalty_c (the no-slip penalty ` +
        `stiffness, N·s/m); got ${slip_penalty_c}. Pick it from the stability bound ` +
        `k_σ·dt ≲ 2.5 with k_σ = c(1/M + R²/I) — see the D2 brief §5.`
      );
    }
    this.slip_penalty_c = slip_penalty_c;
    this.energyKey = 'U_thermal';
  }

  // Shared core: resolve N, t̂, the slip σ, and the signed tangential friction
  // F_t for the current body state. Returns null when the body is not in
  // contact — so applyTo and powerDissipated agree exactly (no double model).
  _contact(body, sceneCtx) {
    const surfaces = sceneCtx.surfaces;
    if (!surfaces) return null;
    const surface = surfaces.get(this.surface_id);
    if (!surface) {
      throw new Error(
        `RollingContact references unknown surface "${this.surface_id}". ` +
        `Scene must declare a surface with that id.`
      );
    }
    const contact = surface.contactForce(body, sceneCtx.k_contact, sceneCtx.c_damping);
    const N = contact.normal_force_mag;
    if (N <= 0) return null;
    const tan = surface.tangentAt(body.position);
    const R = this.radius_m;
    const omega = body.omega ?? 0;
    const vt = body.velocity.x * tan.x + body.velocity.y * tan.y;
    const sigma = vt + omega * R;                 // slip velocity at the contact
    const staticFt = -this.slip_penalty_c * sigma;
    const muS_N = this.mu_s * N;
    let Ft;
    if (Math.abs(staticFt) <= muS_N) {
      Ft = staticFt;                              // grips: penalty holds no-slip
    } else {
      // Traction broken: kinetic Coulomb, regularized through σ=0 like Friction.
      Ft = -this.mu_k * N * (sigma / Math.hypot(sigma, FRICTION_V_THRESHOLD));
    }
    return { tan, R, sigma, Ft };
  }

  applyTo(body, sceneCtx = {}) {
    const c = this._contact(body, sceneCtx);
    if (c === null) return { F: zero(), tau: vec3.zero() };
    // F along the tangent; τ_z = R·F_t (contact torque about the CoM). Positive
    // ẑ = CCW, matching the integrator's dω/dt = Στ.z/I convention.
    return {
      F: { x: c.Ft * c.tan.x, y: c.Ft * c.tan.y },
      tau: { x: 0, y: 0, z: c.R * c.Ft }
    };
  }

  potentialEnergy() {
    return 0;
  }

  // Mechanical power the force removes = F·v_CoM + τ_z·ω = F_t·(v_t + ωR) =
  // F_t·σ (≤ 0). Includes the ROTATIONAL channel (unlike sliding Friction) — a
  // rolling force does work through both. Booked into U_thermal by the tracker,
  // so total K + U_g + U_thermal closes (spurious penalty heat in rolling; real
  // kinetic-friction heat when slipping).
  powerDissipated(body, sceneCtx = {}) {
    const c = this._contact(body, sceneCtx);
    if (c === null) return 0;
    return c.Ft * c.sigma;
  }
}

// Rope/cable tension. Point-to-point inextensible link modeled as a
// stiff spring (penalty) plus damping along the radial direction.
// One-sided: pulls only when stretched (rope can go slack but never
// pushes).
//
// v1 connects body to a fixed anchor; body-to-body tension lands in
// Phase 3 with multi-body constraint dispatch.
export class Tension extends Force {
  constructor({ applies_to, anchor, rest_length_m, k_N_per_m = 1e5, c_damping = 632 }) {
    super();
    this.applies_to = applies_to;
    this.anchor = { x: anchor.x, y: anchor.y };
    this.L0 = rest_length_m;
    this.k = k_N_per_m;
    this.c = c_damping;
    // Tension is a constraint reaction — it does no net work on a
    // perfectly inextensible rope (small penalty oscillation aside).
    this.energyKey = null;
  }

  applyTo(body) {
    const dx = body.position.x - this.anchor.x;
    const dy = body.position.y - this.anchor.y;
    const r = Math.hypot(dx, dy);
    if (r === 0) return withTau(zero());
    const stretch = r - this.L0;
    if (stretch <= 0) return withTau(zero());
    const radialDir = { x: dx / r, y: dy / r };
    const vRadial = body.velocity.x * radialDir.x + body.velocity.y * radialDir.y;
    // Pull body toward anchor when stretched. Damping opposes outward
    // radial motion only.
    let Fmag = -this.k * stretch;
    if (vRadial > 0) Fmag += -this.c * vRadial;
    return withTau({ x: Fmag * radialDir.x, y: Fmag * radialDir.y });
  }

  potentialEnergy() {
    return 0;
  }
}

// TimeVaryingForce: a driving force F(t) = amplitude · sin(omega·t +
// phase) along a fixed unit direction. The first force whose value
// depends on the clock: `derivState` primes it with the current
// integration time via setTime(t) BEFORE sampling F, so RK4 sub-steps
// (t, t+dt/2, t+dt) each see the right F(t). This mirrors the
// TimeVaryingUniformField.setTime(t) contract in fields.js.
//
// energyKey = null. The driver is external — it does net work on the
// body (mechanical energy is NOT conserved under driving), and there is
// no potential channel to recover. Driven scenes therefore emit
// position/velocity, not energy.total, exactly like the cycloid scene,
// so the drift-budget closure check SKIPs rather than false-failing.
export class TimeVaryingForce extends Force {
  constructor({ applies_to, amplitude_N, omega_rad_per_s, phase_rad = 0, direction = { x: 1, y: 0 } }) {
    super();
    this.applies_to = applies_to;
    this.amplitude = amplitude_N;
    this.omega = omega_rad_per_s;
    this.phase = phase_rad;
    // Normalize so `amplitude_N` is the true peak force magnitude
    // regardless of how the direction vector is scaled.
    const d = Math.hypot(direction.x, direction.y) || 1;
    this.dir = { x: direction.x / d, y: direction.y / d };
    this._t = 0;
    this.energyKey = null;
  }

  // Primed by derivState each evaluation. Stored, not applied here, so a
  // single force instance is reused across RK4 sub-steps.
  setTime(t) {
    this._t = t;
  }

  applyTo(_body) {
    const f = this.amplitude * Math.sin(this.omega * this._t + this.phase);
    return withTau({ x: f * this.dir.x, y: f * this.dir.y });
  }

  potentialEnergy() {
    return 0;
  }

  // Phase S item S2: opt into the external-work budget. This force is a
  // genuine external driver (energyKey = null, no recoverable potential),
  // so the ConservationTracker integrates F·v into `W_external` and
  // subtracts it from `total` to keep driven scenes closed. The tracker
  // primes `setTime(t_post)` before calling this, so `this._t` is the
  // post-step time matching the post-step `body.velocity` (a consistent
  // right-endpoint rectangular sum). Returns work rate done BY the driver
  // ON the body: positive while F and v point the same way.
  powerExternal(body) {
    const f = this.amplitude * Math.sin(this.omega * this._t + this.phase);
    return f * this.dir.x * body.velocity.x + f * this.dir.y * body.velocity.y;
  }
}

// LorentzForce: F = q (E + v × B) on a charged body.
//
// v1 limitation: the engine is 2D, so v has no z component. With B = Bz ẑ
// the cross product v × B stays in the (x, y) plane and the in-plane
// dynamics close. If a scene declares B with non-zero Bx or By AND the
// body has non-zero in-plane velocity, the cross product picks up a
// z component — a force out of the simulation plane. v1 does NOT
// silently drop that z component; LorentzForce throws a clear error so
// the user knows the scene is asking for 3D dynamics that the v1 engine
// doesn't model. (3D bodies and out-of-plane motion are a long-range
// Phase 5 item.)
//
// energyKey = null. The magnetic force does no work (qv×B ⊥ v) and the
// electric work is recovered via the energy cross-check (K + qE·r ≈
// const for uniform E), not via a U_electric potential — that's a
// Phase 5 item once charge–charge interaction lands.
export class LorentzForce extends Force {
  constructor({ applies_to, field_id }) {
    super();
    this.applies_to = applies_to;
    this.field_id = field_id;
    // Phase 3.2: LorentzForce contributes to U_electric via the field's
    // scalar potential. UniformField.potential_at returns 0 (gauge choice
    // preserves cycloid behavior — see fields.js comment); RadialField
    // returns k_e × Q_source / r. ConservationTracker iterates per-body
    // and sums q × V(body.position).
    this.energyKey = 'U_electric';
  }

  applyTo(body, sceneCtx = {}) {
    const fields = sceneCtx.fields;
    if (!fields) {
      throw new Error(
        `LorentzForce requires sceneCtx.fields (a Map). ` +
        `field_id="${this.field_id}".`
      );
    }
    const field = fields.get(this.field_id);
    if (!field) {
      throw new Error(
        `LorentzForce references unknown field "${this.field_id}". ` +
        `Scene must declare a field with that id.`
      );
    }
    if (typeof body.charge !== 'number') {
      throw new Error(
        `LorentzForce applies to a body without a numeric charge. ` +
        `body id="${body.id}". Use type="charge" with charge_C set.`
      );
    }
    const q = body.charge;
    const E = field.E_at(body.position);
    const B = field.B_at(body.position);
    const v = body.velocity;
    // v × B with v = (vx, vy, 0) and B = (Bx, By, Bz):
    //   (v × B)_x =  vy * Bz - 0  * By =  vy * Bz
    //   (v × B)_y =  0  * Bx - vx * Bz = -vx * Bz
    //   (v × B)_z =  vx * By - vy * Bx
    const cx = v.y * B.z;
    const cy = -v.x * B.z;
    const cz = v.x * B.y - v.y * B.x;
    if (cz !== 0) {
      throw new Error(
        `LorentzForce produced an out-of-plane force component ` +
        `(F_z = q*(v × B)_z = ${q * cz}). ` +
        `v1 is a 2D engine: B must lie purely along ẑ to keep the ` +
        `Lorentz force in-plane. Got B=(${B.x}, ${B.y}, ${B.z}); ` +
        `v=(${v.x}, ${v.y}). field_id="${this.field_id}". ` +
        `3D bodies and out-of-plane motion are deferred to Phase 5.`
      );
    }
    return withTau({
      x: q * (E.x + cx),
      y: q * (E.y + cy)
    });
  }

  potentialEnergy(body, sceneCtx = {}) {
    // U = q × V(body.position), where V is the scalar potential of the
    // field referenced by `field_id`. UniformField.potential_at returns
    // 0 (gauge choice — preserves cycloid energy.total behavior, which
    // was already SKIP'd in drift-budget). RadialField contributes the
    // real Coulomb potential q × k_e × Q_source / r.
    const fields = sceneCtx.fields;
    if (!fields) return 0;
    const field = fields.get(this.field_id);
    if (!field) return 0;
    if (typeof body.charge !== 'number') return 0;
    if (typeof field.potential_at !== 'function') return 0;
    return body.charge * field.potential_at(body.position);
  }
}

// BuoyantForce: Archimedes buoyancy on a prismatic body floating in / sinking
// through a declared horizontal fluid region. F_b = ρ_fluid · g · V_sub(y) ŷ
// (upward), with V_sub the submerged prism volume computed EACH STEP from the
// body's cross-section against the fluid's waterline (fluids.js::submergedVolume)
// — so partial submersion (V_sub linear in depth) gives a linear restoring force
// and a prismatic float bobs in genuine SHM. sim_buoyancy_fluids P3. Brief:
// docs/physics_briefs/sim_buoyancy_fluids_brief.md.
//
// Fluid lookup mirrors LorentzForce: the fluid is a `FluidField` in
// sceneCtx.fields, referenced by `field_id` (a fluid is NOT an EM field — it has
// no E_at/B_at — so the shared emFields() accessor filters it out of the field/V
// overlay; see fields.js). applyTo AND potentialEnergy resolve the field the
// same way and THROW symmetrically on a missing field/ctx: buoyancy's U is
// load-bearing for the drift-budget closure, so an asymmetric silent-0 in
// potentialEnergy (while applyTo throws) would break F = −dU/dy INVISIBLY and
// read as a physics bug during drift debug. (This deliberately differs from
// LorentzForce.potentialEnergy's graceful-0, whose U is not drift-load-bearing.)
//
// energyKey = 'U_buoyant' — a DISTINCT position-dependent conservative potential,
// NOT gravity's U_g (the EXTENSION_TESTS.md "U_g" suggestion is the plan's
// anti-target #2). The tracker's OPEN contributions map absorbs it with zero
// edit to energy.js. No powerDissipated: buoyancy is conservative (all its work
// lives in U_buoyant; adding dissipation would double-count).
//
// g-source parity (Option A): the scene loader injects `scene_defaults.g` into
// BOTH Gravity and this force (scene.js buoyancy special-case, mirroring the
// gravity one), so equilibrium and ω use the SAME g by construction. Default
// 9.8 only for direct/test construction. g-parity is observable ONLY in the
// PERIOD (d_eq = m/(ρ·A_wp) is g-independent — the g's cancel), so a g mismatch
// surfaces in T = 2π√(m/(ρg·A_wp)), never in equilibrium depth.
export class BuoyantForce extends Force {
  constructor({ applies_to, field_id, g = 9.8 }) {
    super();
    this.applies_to = applies_to;
    this.field_id = field_id;
    this.g = g;
    this.energyKey = 'U_buoyant';
  }

  // Resolve the referenced FluidField, throwing a clear error if the fields Map
  // or the field is absent (mirrors LorentzForce). Shared by applyTo and
  // potentialEnergy so the two never diverge on how they find the fluid.
  _field(sceneCtx) {
    const fields = sceneCtx.fields;
    if (!fields) {
      throw new Error(
        `BuoyantForce requires sceneCtx.fields (a Map). field_id="${this.field_id}".`
      );
    }
    const field = fields.get(this.field_id);
    if (!field) {
      throw new Error(
        `BuoyantForce references unknown field "${this.field_id}". ` +
        `Scene must declare a fluid field with that id.`
      );
    }
    return field;
  }

  applyTo(body, sceneCtx = {}) {
    const field = this._field(sceneCtx);
    // submergedVolume THROWS if the body lacks width_m/height_m (prism-only;
    // never a silent 0 or a disk fall-through) — the same throw the energy
    // path takes via buoyantPotentialEnergy.
    const V = submergedVolume(body, field.waterlineY);
    return withTau({ x: 0, y: this.g * field.density * V });
  }

  potentialEnergy(body, sceneCtx = {}) {
    // SYMMETRIC with applyTo (throw, never silent-0 — see class header).
    const field = this._field(sceneCtx);
    return buoyantPotentialEnergy(body, field.waterlineY, field.density, this.g);
  }
}

// Coulomb: charge–charge electrostatic interaction. F = k_e q1 q2 / r²
// along the line of centers, repulsive for like charges. Phase 3.1
// (E&M extension §3.1). The API contract is locked at the top of
// `sim/validation/em_validation.js` (CoulombClassContract JSDoc).
//
// Pair-counting contract: ConservationTracker iterates ALL bodies and
// sums U from each force.potentialEnergy(body, sceneCtx). To avoid
// double-counting pair interactions, the instance method returns
// ½ × Σ_other (k_e q1 q2 / r). The static helper Coulomb.pairEnergy(a,b)
// returns the FULL closed-form pair PE (not halved) for audit/test use.
//
// Self-pair filtering uses reference equality (`other === body`), not
// id comparison, so two distinct body objects sharing an id still
// interact correctly (matches the contract test in coulomb.test.js).
export class Coulomb extends Force {
  constructor({ applies_to, k_e = 8.9876e9 }) {
    super();
    this.applies_to = applies_to;
    this.k_e = k_e;
    this.energyKey = 'U_electric';
  }

  applyTo(body, sceneCtx = {}) {
    const bodies = sceneCtx.bodies;
    if (!bodies) return withTau(zero());
    let Fx = 0;
    let Fy = 0;
    for (const other of bodies) {
      if (other === body) continue;
      if (typeof other.charge !== 'number') continue;
      const dx = body.position.x - other.position.x;
      const dy = body.position.y - other.position.y;
      const r2 = dx * dx + dy * dy;
      if (r2 === 0) continue;
      const r = Math.sqrt(r2);
      // F on `body` due to `other`. Like charges (q1*q2 > 0) push body
      // AWAY from other, i.e., along +(body - other) = +(dx, dy).
      const fmag = this.k_e * body.charge * other.charge / r2;
      Fx += fmag * dx / r;
      Fy += fmag * dy / r;
    }
    return withTau({ x: Fx, y: Fy });
  }

  potentialEnergy(body, sceneCtx = {}) {
    const bodies = sceneCtx.bodies;
    if (!bodies) return 0;
    if (typeof body.charge !== 'number') return 0;
    let U = 0;
    for (const other of bodies) {
      if (other === body) continue;
      if (typeof other.charge !== 'number') continue;
      const dx = body.position.x - other.position.x;
      const dy = body.position.y - other.position.y;
      const r = Math.hypot(dx, dy);
      if (r === 0) continue;
      U += this.k_e * body.charge * other.charge / r;
    }
    // Half-counting: each pair's PE is split between the two bodies.
    return 0.5 * U;
  }

  // STATIC. Full closed-form k_e q1 q2 / r between two charged bodies.
  // Not halved — meant for audit/test consumers that want the pair PE
  // directly without going through ConservationTracker iteration.
  static pairEnergy(a, b, k_e = 8.9876e9) {
    const dx = a.position.x - b.position.x;
    const dy = a.position.y - b.position.y;
    const r = Math.hypot(dx, dy);
    if (r === 0) return 0;
    return k_e * a.charge * b.charge / r;
  }
}

// DipoleInField: force on a magnetic dipole due to a non-uniform B-field.
// F = ∇(μ·B). For axial μ along ẑ in an in-plane scene this reduces to
//   F = μ_z × ∇B_z   (scalar × vec2 → vec2)
//
// Phase 3.3 deliverable §3.3.3 (Q1=C lock — μ lives on body, force class
// binds field). Tests in `__tests__/dipole_in_field.test.js`.
//
// SD-3 polymorphism guard: gradB_z_at is DipoleField-only at v0. This
// class type-checks the field at runtime and surfaces a clear error if
// a future scene wires a UniformField/RadialField to a DipoleInField
// force, instead of crashing with "field.gradB_z_at is not a function"
// deep inside applyTo. Mirrors LorentzForce's charge-validation pattern.
//
// SD-6 per-body iteration: applies_to is `string[]`. Each body gets its
// OWN field-only force INDEPENDENTLY (mirrors LorentzForce's per-body
// field query, NOT Coulomb's pair-counting template). Two bodies in the
// same applies_to do NOT pair-interact through this force; each feels
// the source-field independently. Q3=b dipole-pair work introduces a
// SEPARATE DipolePair force class with proper pair-counting (out of
// scope at v0).
//
// Energy: U_magnetic = -μ·B = -μ_z × B_z. NO ½ pair-counting factor —
// this is a one-body-in-field force (LorentzForce pattern), not a pair
// sum (Coulomb's halving is for body-pair interactions). The
// ConservationTracker iterates per-body × per-force, so returning the
// FULL one-body-in-field PE is correct; halving would underreport.
export class DipoleInField extends Force {
  constructor({ applies_to, field_id, damping_b_N_m_s_per_rad = 0 }) {
    super();
    this.applies_to = applies_to;
    this.field_id = field_id;
    // Phase 3.6 (Q1=B): per-force rotational damping coefficient. The
    // constructor's destructuring default IS the default-injection
    // contract — when scene JSON omits `damping_b_N_m_s_per_rad`,
    // `this.damping_b` is guaranteed to be the number 0 (NOT undefined),
    // so `this.damping_b === 0` (strict equality) is the bit-stable
    // short-circuit gate. NaN/Infinity are rejected by schema before
    // reaching this constructor (validate_scene_browser.js + scene
    // schema enforce `minimum: 0` and finite-number checks).
    this.damping_b = damping_b_N_m_s_per_rad;
    this.energyKey = 'U_magnetic';
  }

  applyTo(body, sceneCtx = {}) {
    const fields = sceneCtx.fields;
    if (!fields) {
      throw new Error(
        `DipoleInField requires sceneCtx.fields (a Map). ` +
        `field_id="${this.field_id}".`
      );
    }
    const field = fields.get(this.field_id);
    if (!field) {
      throw new Error(
        `DipoleInField references unknown field "${this.field_id}". ` +
        `Scene must declare a field with that id.`
      );
    }
    if (!body.mu || typeof body.mu.z !== 'number') {
      throw new Error(
        `DipoleInField applied to a body without a magnetic dipole moment. ` +
        `body id="${body.id}". Use type="magnetic_dipole" or "rotating_dipole" with mu_z_J_per_T set.`
      );
    }
    // Phase 3.5 (Q4=A): widen F to the element-wise form
    //   F_i = μ_x · ∂_i B_x + μ_y · ∂_i B_y + μ_z · ∂_i B_z       (general)
    //
    // Implementation routes (in order of preference):
    //
    //  1. Bit-stable axial short-circuit. When `μ_x === 0.0 &&
    //     μ_y === 0.0` (strict equality), the in-plane terms drop
    //     out exactly. Take the original 3.3 axial code path
    //     (μ_z · ∇B_z) verbatim, preserving bit-identity by
    //     construction (no float-summation reordering risk). This
    //     is the load-bearing gate for §"Success criteria item 7"
    //     (algebraic-reduction). MagneticDipole bodies hit this
    //     branch deterministically (their constructor pins
    //     μ_x = μ_y = 0); RotatingDipole bodies whose θ is
    //     bit-stable at 0 or π also hit it.
    //  2. Full element-wise tensor path. Field provides
    //     `gradB_at(point) → {xx, xy, yx, yy}`. Compute
    //       F_x = μ_x · ∂_x B_x + μ_y · ∂_x B_y + μ_z · ∂_x B_z
    //       F_y = μ_x · ∂_y B_x + μ_y · ∂_y B_y + μ_z · ∂_y B_z
    //     For 2D fields where ∇ B_z is supplied separately via
    //     `gradB_z_at`, splice it in as the μ_z term so DipoleField
    //     in particular still produces the 3.3 axial F when the
    //     in-plane μ components vanish.
    //  3. Capability-flagged no-gradient fallback. Field declares
    //     `static capabilities = { gradient: false }` (UniformField,
    //     RadialField). ∇B = 0 → F = 0; torque can still be nonzero.
    //  4. Hard fail. Field has no `gradB_at` AND no
    //     `capabilities.gradient === false` declaration. The
    //     scene-load capability check (in scene.js loadScene) will
    //     have already aborted the load — this branch is
    //     belt-and-suspenders if a force runs against a hand-built
    //     ctx that bypassed loadScene.
    let F;
    const muXAxialBit = body.mu.x === 0 && body.mu.y === 0;
    if (muXAxialBit) {
      // (1) Axial short-circuit — bit-identical to the 3.3 path.
      if (typeof field.gradB_z_at === 'function') {
        const grad = field.gradB_z_at(body.position);
        F = scale(grad, body.mu.z);
      } else {
        F = zero();
      }
    } else if (typeof field.gradB_at === 'function') {
      // (2) Full element-wise path.
      const grad = field.gradB_at(body.position);
      // Splice in μ_z · ∂_i B_z when the field exposes the 3.3 axial
      // chain — DipoleField does, LinearGradientField does not.
      let dxBz = 0, dyBz = 0;
      if (typeof field.gradB_z_at === 'function') {
        const gz = field.gradB_z_at(body.position);
        dxBz = gz.x;
        dyBz = gz.y;
      }
      const Fx = body.mu.x * grad.xx + body.mu.y * grad.xy + body.mu.z * dxBz;
      const Fy = body.mu.x * grad.yx + body.mu.y * grad.yy + body.mu.z * dyBz;
      F = { x: Fx, y: Fy };
    } else {
      // (3) No-gradient fallback. The scene-load capability check
      // already verified `field.constructor.capabilities.gradient === false`
      // for any field that reaches this branch.
      F = zero();
    }
    // Phase 3.4 (Q5=B) torque: τ = (μ × B).z = μ_x · B_y − μ_y · B_x.
    // For axial μ (mu.x = mu.y = 0, MagneticDipole), τ_z = 0; for
    // in-plane μ (RotatingDipole), τ_z is the SHM driver. Sign
    // convention: positive τ = counter-clockwise about ẑ. Restoring
    // behavior arises from the geometry — when the needle rotates by
    // +δθ from alignment with B, μ rotates so the cross product points
    // in −ẑ, yielding negative τ. The integrator does NOT manually
    // flip signs.
    //
    // Phase 5.R1 (Q4=α): τ widened from scalar to vec3. Z-only formula
    // preserved BIT-IDENTICALLY — full vec3.cross would produce nonzero
    // in-plane components for in-plane μ in B-along-ẑ, immediately
    // firing assertScalarTau. The vec3 namespace is imported but is
    // NOT called at this site.
    const tau = vec3.zero();
    if (typeof field.B_at === 'function') {
      const B = field.B_at(body.position);
      tau.z = body.mu.x * B.y - body.mu.y * B.x;
    }
    // Phase 3.6 (Q1=B): damping torque τ_damping = −b·ω. Bit-stable
    // short-circuit when `damping_b === 0` (strict equality) skips the
    // body.omega read entirely — preserves the Phase 3.5 code path
    // bit-identically for every prior baseline scene whose dipole
    // forces don't declare `damping_b_N_m_s_per_rad`. RK4 substep
    // contract: each call to applyTo reads `body.omega` from the body
    // argument as the integrator presents it on this substep (k1, k2,
    // k3, k4); damping introduces no new substep-state caching.
    //
    // Phase 5.R1 (Q3=α): damping accumulates onto tau.z only — short-
    // circuit gate on `damping_b === 0` preserves bit-identity for
    // every scene whose dipole forces don't declare damping.
    if (this.damping_b !== 0) {
      const omega = typeof body.omega === 'number' ? body.omega : 0;
      tau.z += -this.damping_b * omega;
    }
    return { F, tau };
  }

  potentialEnergy(body, sceneCtx = {}) {
    // U = -μ·B (full vec3 dot product). NO ½ factor (SD-6 + Pass-2
    // finding). For axial μ (MagneticDipole — μ_x=0, μ_y=0, μ_z≠0),
    // this reduces to -μ_z·B_z (the Phase 3.3 form). For in-plane μ
    // (RotatingDipole — μ_x and μ_y vary with θ, μ_z=0), this is
    // -μ_x·B_x − μ_y·B_y. The single dot-product form covers both
    // body classes and is the load-bearing PE bookkeeping that
    // ConservationTracker uses for the LOL energy bar / drift-budget
    // closure check.
    // Graceful degradation mirrors LorentzForce.potentialEnergy:
    // returns 0 if context is incomplete, rather than throwing.
    const fields = sceneCtx.fields;
    if (!fields) return 0;
    const field = fields.get(this.field_id);
    if (!field) return 0;
    if (!body.mu || typeof body.mu.z !== 'number') return 0;
    if (typeof field.B_at !== 'function') return 0;
    const B = field.B_at(body.position);
    const muX = typeof body.mu.x === 'number' ? body.mu.x : 0;
    const muY = typeof body.mu.y === 'number' ? body.mu.y : 0;
    return -(muX * B.x + muY * B.y + body.mu.z * B.z);
  }

  // Phase 3.6 (Q5=B): unified `powerDissipated(body) → F·v + τ·ω`
  // contract. DipoleInField's translational F (∇(μ·B)) is conservative
  // — its work is captured by U_magnetic via potentialEnergy(), so the
  // F·v contribution to U_thermal is 0. The conservative torque
  // (μ × B) is also captured by U_magnetic. The ONLY dissipative
  // channel on this force is the damping torque τ_damping = −b·ω,
  // contributing power `τ_damping · ω = −b·ω²` (always non-positive).
  // Bit-stable short-circuit: when `damping_b === 0`, returns 0
  // exactly — `_dissipated += -0 * dt = 0`, preserving every Phase 3.5
  // baseline value-equal under Object.is.
  powerDissipated(body /*, sceneCtx */) {
    if (this.damping_b === 0) return 0;
    const omega = typeof body.omega === 'number' ? body.omega : 0;
    return -this.damping_b * omega * omega;
  }
}

// CurrentInFieldForce: the Laplace/Ampère force on a straight
// current-carrying wire segment in an external magnetic field,
// F = I·(L × B). Phase C2 (Stage ②, sim_phase_c_magnetism). Brief:
// docs/physics_briefs/sim_phase_c_magnetism_brief.md §1b.
//
// The body carries a steady current `I_A` over a current-length vector
// `L_m` = (Lx, Ly, Lz); this force samples the referenced field's B at the
// body's position and returns
//   F = I · (L × B)      (translational only — the field is sampled at a
//                         single point, so this segment carries no torque
//                         about its own centre; tau = 0)
//
// 2-D honesty (the load-bearing correctness point). The engine is strictly
// 2-D: `derivState` (scene.js) sums only F.x/F.y and SILENTLY DROPS any
// F.z. A wire PERPENDICULAR to the plane (L = (0,0,L_z)) crossed with an
// IN-PLANE B (e.g. CurrentWireField's azimuthal field) gives an IN-PLANE
// force (F.z = 0 identically) — the honest parallel-wire case. But an
// IN-PLANE L crossed with an IN-PLANE B gives a PURE-z force the engine
// would drop unseen. This class therefore mirrors the LorentzForce
// out-of-plane guard (~L472 above): it computes the full vec3 cross
// product and THROWS when the resulting F.z is nonzero — closing the exact
// gap RailInductionForce leaves open (it relies on rail geometry keeping F
// in-plane but never checks). 3-D dynamics are deferred to a later phase.
//
// Parallel-wire closed form (brief §1b): wire 1 = CurrentWireField source
// (I₁) at the field centre, wire 2 = this body (I₂ = I_A, length L_z) at
// separation d ⇒ |F| = μ₀ I₁ I₂ L_z / 2π d, ATTRACTIVE for parallel
// currents (I₁·I₂ > 0), repulsive for antiparallel.
//
// Energy: energyKey stays null (Force default). The magnetic force between
// current-maintained wires has no simple mechanical potential (the current
// sources do the work as the wires move), so validation scenes PIN the
// wires — no motion, no work, energy trivially conserved (brief §4). A
// scene that lets a current wire MOVE under this force is out of scope and
// would break the drift-budget closure.
export class CurrentInFieldForce extends Force {
  constructor({ applies_to, field_id, I_A, L_m }) {
    super();
    if (!Array.isArray(applies_to) || applies_to.length === 0) {
      throw new Error(
        'CurrentInFieldForce requires a non-empty applies_to array.'
      );
    }
    if (typeof field_id !== 'string' || field_id.length === 0) {
      throw new Error('CurrentInFieldForce requires a field_id string.');
    }
    if (typeof I_A !== 'number' || !Number.isFinite(I_A)) {
      throw new Error(
        `CurrentInFieldForce.I_A must be a finite number (got ${I_A}).`
      );
    }
    if (
      !L_m ||
      ![L_m.x, L_m.y, L_m.z].every(
        (c) => typeof c === 'number' && Number.isFinite(c)
      )
    ) {
      throw new Error(
        `CurrentInFieldForce.L_m must be a finite {x,y,z} current-length ` +
        `vector (got ${JSON.stringify(L_m)}).`
      );
    }
    this.applies_to = applies_to;
    this.field_id = field_id;
    this.I_A = I_A;
    this.L_m = { x: L_m.x, y: L_m.y, z: L_m.z };
  }

  applyTo(body, sceneCtx = {}) {
    const fields = sceneCtx.fields;
    if (!fields || typeof fields.get !== 'function') {
      throw new Error(
        `CurrentInFieldForce.applyTo requires sceneCtx.fields (a Map). ` +
        `field_id="${this.field_id}".`
      );
    }
    const field = fields.get(this.field_id);
    if (!field) {
      throw new Error(
        `CurrentInFieldForce references unknown field_id="${this.field_id}".`
      );
    }
    if (typeof field.B_at !== 'function') {
      throw new Error(
        `CurrentInFieldForce field_id="${this.field_id}" has no B_at(); ` +
        `cannot sample the magnetic field.`
      );
    }
    const B = field.B_at(body.position);
    const LxB = vec3.cross(this.L_m, B);
    // Out-of-plane guard (mirrors LorentzForce ~L472): a nonzero F.z would
    // be silently dropped by derivState. For an honest ⊥-plane wire
    // (L.x = L.y = 0) this is exactly 0; an in-plane current element trips
    // it. Strict !== 0 (not an epsilon band) matches the Lorentz guard —
    // the honest case zeroes identically in IEEE arithmetic.
    const Fz = this.I_A * LxB.z;
    if (Fz !== 0) {
      throw new Error(
        `CurrentInFieldForce produced an out-of-plane force component ` +
        `(F_z = I·(L × B)_z = ${Fz}). v1 is a 2D engine: derivState drops ` +
        `F_z silently, so the current-length L must be ⊥ the plane ` +
        `(L = (0,0,L_z)) when B is in-plane. Got ` +
        `L=(${this.L_m.x}, ${this.L_m.y}, ${this.L_m.z}), ` +
        `B=(${B.x}, ${B.y}, ${B.z}). field_id="${this.field_id}". ` +
        `In-plane current elements are deferred.`
      );
    }
    return {
      F: { x: this.I_A * LxB.x, y: this.I_A * LxB.y },
      tau: vec3.zero()
    };
  }
}

// ContactForce: body-body penalty contact (Phase B item B1 — 1-D
// collision core). Generalizes the Surface penalty contact
// (constraints.js Surface.contactForce) from body-vs-surface to
// body-vs-body. Two bodies with contact radii overlap when their
// centre-to-centre distance r < sum of radii R; penetration depth =
// R − r drives a Kelvin–Voigt penalty force (spring + one-sided damping)
// pushing them apart.
//
// PAIRWISE template (mirrors Coulomb / Gravity-universal): applyTo(body)
// iterates sceneCtx.bodies and sums the contact force on `body` from every
// OTHER participating body. The pair force is equal-and-opposite by
// construction (n flips sign between the two bodies, the magnitude is
// symmetric), so total linear momentum is conserved STRUCTURALLY for any
// restitution — not tuned. The S4 linearMomentumTracker reports the
// residual drift (≈ integrator precision).
//
// ENERGY (two channels, deliberately split):
//   - SPRING k·depth — CONSERVATIVE. energyKey='U_contact';
//     potentialEnergy = ¼k·depth² half-counted per body (sum over the pair
//     recovers ½k·depth² once — the Coulomb halving contract). Tracking it
//     keeps `total` closed mid-overlap, where the stored PE is the same
//     order as the bodies' KE.
//   - DAMPING c·max(0,−vRel) — DISSIPATIVE, ONE-SIDED (acts only while the
//     bodies APPROACH, vRel<0; zero during separation). powerDissipated
//     returns the DAMPING-ONLY F·v per body (the conservative spring is
//     excluded so it is not double-counted as loss). Fed into U_thermal by
//     the tracker's time-integral — the same channel Drag/Friction use, so
//     Option A needs NO discrete addDissipated (that note in the plan is
//     scoped to Option B impulses, which an integral never feeds).
//
// c_N_s_per_m = 0 → perfectly elastic (e≈1, energy-conserving). c > 0 →
// inelastic; the relative KE lost during compression goes to U_thermal.
// One-sided damping (vs two-sided) gives a well-defined 0<e≤1 and never
// applies a phantom sticky pull during separation — identical rationale to
// the Surface contact's vNormal<0 guard.
//
// Torque is zero in v0: a head-on contact normal passes through both point
// centres (no moment arm), and Particles have no rotational DOF. B2's
// off-axis 2-D impacts can revisit.
//
// Participating-body radius is validated ONCE at scene load (scene.js),
// not here, so this hot-path code trusts body.radius > 0.

// Contact geometry between two bodies A and B — the ONE definition of "are
// these two bodies touching, and approaching?", shared by the continuous
// penalty `ContactForce` (B1) and the discrete perfectly-inelastic merge
// resolver (collisions.js, B4). Returns null when NOT in contact (separated,
// or degenerate coincident centres), else { depth>0, n, vRel } where n is the
// unit normal from B toward A and vRel = (v_A − v_B)·n is the normal relative
// velocity (vRel < 0 ⟺ the bodies are approaching). vRel is symmetric:
// computing it from B's perspective (swap roles, n flips) yields the same
// value — which is what makes the pair force equal-and-opposite.
export function contactGeom(bodyA, bodyB) {
  const dx = bodyA.position.x - bodyB.position.x;
  const dy = bodyA.position.y - bodyB.position.y;
  const r = Math.hypot(dx, dy);
  if (r === 0) return null; // coincident centres — normal undefined; skip
  const depth = (bodyA.radius + bodyB.radius) - r;
  if (depth <= 0) return null; // not overlapping
  const n = { x: dx / r, y: dy / r };
  const vRel = (bodyA.velocity.x - bodyB.velocity.x) * n.x
             + (bodyA.velocity.y - bodyB.velocity.y) * n.y;
  return { depth, n, vRel };
}

export class ContactForce extends Force {
  constructor({ applies_to, k_N_per_m = DEFAULT_K_CONTACT, c_N_s_per_m = 0 }) {
    super();
    this.applies_to = applies_to;
    this.k = k_N_per_m;
    this.c = c_N_s_per_m;
    this.energyKey = 'U_contact';
  }

  // Delegates to the shared module-level contactGeom (library-first: ONE
  // contact-detection definition serves the penalty force and the B4 merge).
  // n is the unit normal from `other` toward `body`; vRel < 0 ⟺ approaching.
  _contactGeom(body, other) {
    return contactGeom(body, other);
  }

  // Penalty-force magnitude along the normal, pushing `body` away from
  // `other`. Spring (always, while overlapping) + one-sided damping (only
  // while approaching). `dampingOnly` returns just the dissipative part,
  // for powerDissipated.
  _normalForceMag(g, dampingOnly = false) {
    const damping = g.vRel < 0 ? -this.c * g.vRel : 0; // ≥ 0, opposes approach
    if (dampingOnly) return damping;
    return this.k * g.depth + damping;
  }

  applyTo(body, sceneCtx = {}) {
    const bodies = sceneCtx.bodies;
    if (!bodies) return withTau(zero());
    let Fx = 0;
    let Fy = 0;
    for (const other of bodies) {
      if (other === body) continue;
      if (!this.appliesTo(other.id)) continue;
      const g = this._contactGeom(body, other);
      if (!g) continue;
      const fmag = this._normalForceMag(g);
      Fx += fmag * g.n.x;
      Fy += fmag * g.n.y;
    }
    return withTau({ x: Fx, y: Fy });
  }

  potentialEnergy(body, sceneCtx = {}) {
    const bodies = sceneCtx.bodies;
    if (!bodies) return 0;
    let U = 0;
    for (const other of bodies) {
      if (other === body) continue;
      if (!this.appliesTo(other.id)) continue;
      const g = this._contactGeom(body, other);
      if (!g) continue;
      U += 0.5 * this.k * g.depth * g.depth; // full pair spring PE
    }
    // Half-counting (Coulomb/Gravity contract): the tracker sums
    // potentialEnergy over BOTH bodies, so each reports half the pair PE.
    return 0.5 * U;
  }

  powerDissipated(body, sceneCtx = {}) {
    const bodies = sceneCtx.bodies;
    if (!bodies) return 0;
    let Fx = 0;
    let Fy = 0;
    for (const other of bodies) {
      if (other === body) continue;
      if (!this.appliesTo(other.id)) continue;
      const g = this._contactGeom(body, other);
      if (!g) continue;
      const damping = this._normalForceMag(g, true); // dissipative part only
      Fx += damping * g.n.x;
      Fy += damping * g.n.y;
    }
    // F_damping · v_body. Negative while approaching (the damping opposes
    // `body`'s motion toward `other`). The tracker sums this over both
    // bodies → total damping power = −c·vRel² ≤ 0, so U_thermal grows by
    // c·vRel²·dt. NOT halved: this is a per-body work RATE, not a shared
    // state function. The conservative spring is excluded (tracked via
    // potentialEnergy / U_contact) so it is never double-counted as loss.
    return Fx * body.velocity.x + Fy * body.velocity.y;
  }
}

// BodySpring: a pairwise body-to-body ideal spring for coupled oscillation
// (sim_body_coupling_atwood P3 — the coupled-oscillator primitive). Unlike the
// single-body anchor `Spring` (L194), this joins TWO bodies with NO fixed
// anchor. Built on the Coulomb/ContactForce pairwise template: applyTo reads
// sceneCtx.bodies, SUMS the spring force from every OTHER body in applies_to
// (≠ body), GUARDS a missing bodies list (return zero), and half-counts
// potentialEnergy so the tracker's per-body sum recovers the full pair PE once.
// For a 2-id applies_to this reduces to the single pair but is N-safe and
// undefined-partner-safe exactly as ContactForce is.
//
// TWO-SIGNED Hooke law (a REAL spring, NOT one-sided like Tension/String):
//   r = pos_body − pos_other, stretch = |r| − rest_length,
//   F = −k·stretch along the unit r.
// stretch > 0 (too far) → F points along −r, pulling the bodies together;
// stretch < 0 (compressed) → F points along +r, pushing them apart. Equal-and-
// opposite by construction: for the partner, r flips sign, |r| and stretch are
// bit-identical, the unit vector negates, so F_other = −F_body to the LAST bit
// → linear momentum / CoM conserved to round-off (the coupled-oscillator
// signature). BodySpring IS a Force → returns withTau({x,y}) (unlike the
// constraint-side StringConstraint, which returns a bare {x,y}).
//
// energyKey 'U_e' (matches the single-body Spring). potentialEnergy returns the
// HALF-counted ¼k·stretch² per body; the tracker sums potentialEnergy over BOTH
// bodies (energy.js L247–251) → ½k·stretch² full pair PE (the Coulomb/
// ContactForce half-counting contract — get it wrong and the reported U_e
// doubles). The 2-body assumption (applies_to.length === 2) is enforced at load
// in scene.js — the anti_target forbids >2-body chains, but no engine code here
// rejects a 3-id list, so the pairwise sum stays generic and the load-time
// guard owns the cardinality contract.
export class BodySpring extends Force {
  constructor({ applies_to, k_N_per_m, rest_length_m }) {
    super();
    this.applies_to = applies_to;
    this.k = k_N_per_m;
    this.L0 = rest_length_m;
    this.energyKey = 'U_e';
  }

  applyTo(body, sceneCtx = {}) {
    const bodies = sceneCtx.bodies;
    if (!bodies) return withTau(zero());
    let Fx = 0;
    let Fy = 0;
    for (const other of bodies) {
      if (other === body) continue;
      if (!this.appliesTo(other.id)) continue;
      const r = sub(body.position, other.position); // body − other
      const len = mag(r);
      if (len === 0) continue; // coincident centres — unit vector undefined
      const stretch = len - this.L0;
      const dir = normalize(r);
      // −k·stretch along +r (dir = r/|r|). stretch>0 pulls body toward other
      // (−r); stretch<0 pushes it away (+r). Accumulate so a hypothetical
      // extra partner would sum (N-safe like Coulomb/ContactForce).
      Fx += -this.k * stretch * dir.x;
      Fy += -this.k * stretch * dir.y;
    }
    return withTau({ x: Fx, y: Fy });
  }

  potentialEnergy(body, sceneCtx = {}) {
    const bodies = sceneCtx.bodies;
    if (!bodies) return 0;
    let U = 0;
    for (const other of bodies) {
      if (other === body) continue;
      if (!this.appliesTo(other.id)) continue;
      const stretch = mag(sub(body.position, other.position)) - this.L0;
      U += 0.5 * this.k * stretch * stretch; // full pair spring PE
    }
    // Half-counting (Coulomb/ContactForce contract): the tracker sums
    // potentialEnergy over BOTH bodies, so each reports half the pair PE.
    return 0.5 * U;
  }
}

export const NAME = 'forces';
