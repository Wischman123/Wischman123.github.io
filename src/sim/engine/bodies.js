// engine/bodies.js
//
// Body types. v1 ships Particle (full) + Charge (extends Particle with q).
// RigidBody is interface-only (Phase 3 ships the implementation).
//
// All body types implement the same interface:
//   - mass, position, velocity (state)
//   - stateSize : number — slot count contributed to the flat state
//                 vector (4 for translational-only, 6 for rotational).
//                 Phase 3.4 (Q2=A) made this per-body; the integrator
//                 reads body.stateSize to compute strides.
//   - applyImpulse(J) : J is an impulse vector; updates velocity
//   - kineticEnergy() : number
//   - potentialEnergyContributions() : map of energy-key to scalar
//   - packState() : number[] of length stateSize
//   - unpackState(s) : sync body fields from a state slice of length stateSize
//
// New body types (StringSegment, FluidParcel, CircuitNode in future
// phases) implement the same interface and slot in without changing
// the integrator or the scene loader.
//
// Phase C1-starter: Particle implementation. Charge ships in Phase D
// (E&M proof slice). RigidBody throws on construction in v1.

import { zero, scale, add } from './vec.js';
import { inertiaFromSpec, parallelAxis } from './inertia.js';

export class Particle {
  constructor({ id, mass_kg, position_m, velocity_m_per_s, radius_m = null, render_shape = null, width_m = null, height_m = null }) {
    if (!(mass_kg > 0)) throw new Error(`Particle.mass_kg must be > 0, got ${mass_kg}`);
    this.id = id;
    this.mass = mass_kg;
    this.position = { x: position_m.x, y: position_m.y };
    this.velocity = { x: velocity_m_per_s.x, y: velocity_m_per_s.y };
    // sim_buoyancy_fluids P3: optional PRISM physics dims (metres). STATIC
    // physics metadata — like `radius` below, NOT part of the [x,y,vx,vy] state
    // vector, so packState / serializeState / round-trip stay byte-identical.
    // fluids.js::submergedVolume reads these EXACT names (width_m × unit depth =
    // A_wp; V_max = width_m × height_m × unit depth) and THROWS if a buoyancy
    // body omits them (the disk path is not derived). null for every non-buoyancy
    // body (the default) — the schema prop is inert without this producer, so a
    // body carrying width_m/height_m in JSON reaches the physics ONLY via here.
    this.width_m = width_m;
    this.height_m = height_m;
    // Phase B item B1: optional physical contact radius (metres). STATIC
    // metadata — NOT part of the [x, y, vx, vy] state vector, so packState
    // / serializeState / round-trip are unchanged. Used by the body-body
    // ContactForce (forces.js) for penetration detection; null for point
    // particles that never collide (the existing default for every
    // pre-B1 scene). The ContactForce hard-errors if a participating body
    // has no positive radius — size is physically required to detect contact.
    this.radius = radius_m;
    // Sim-interactivity T4: optional render-only shape descriptor
    // ({ kind, length_m, angle_rad, label }). STATIC render metadata —
    // exactly like `radius` above, it is NOT part of the [x, y, vx, vy]
    // state vector, so packState / serializeState / round-trip stay
    // byte-identical. The render layer (drawBodies → SHAPE_DRAWERS) reads
    // it; the engine never does. null for point bodies drawn as the
    // default disk. Inherited by every body subclass via super().
    this.renderShape = render_shape;
    // Phase 3.4 (Q2=A): per-body state-size. 4 = [x, y, vx, vy].
    // Rotational subclasses (RotatingDipole) override to 6.
    this.stateSize = 4;
  }

  applyImpulse(J) {
    this.velocity = add(this.velocity, scale(J, 1 / this.mass));
  }

  kineticEnergy() {
    const v2 = this.velocity.x * this.velocity.x + this.velocity.y * this.velocity.y;
    return 0.5 * this.mass * v2;
  }

  // Phase 3.5 (Q9=A): per-DOF kinetic energy split. Default Particle has
  // no rotational DOF — K_rot = 0. Subclasses with rotational state
  // (RotatingDipole) override. Used by the LOL overlay to split K into
  // K_trans (cyan) + K_rot (orange) stacked sub-bars.
  kineticEnergyRotational() {
    return 0;
  }

  // Particles do not store potential energy directly. Forces report
  // their own contributions to the ConservationTracker (see energy.js).
  potentialEnergyContributions() {
    return {};
  }

  // State vector packing/unpacking for the integrator. Keeps the
  // integrator framework-free — it sees a flat number[] and a
  // derivative function.
  packState() {
    return [this.position.x, this.position.y, this.velocity.x, this.velocity.y];
  }

  unpackState(s) {
    this.position = { x: s[0], y: s[1] };
    this.velocity = { x: s[2], y: s[3] };
  }
}

// Charge: a Particle that carries an electric charge in Coulombs.
// Phase D (E&M proof slice). The state vector layout is identical to
// Particle ([x, y, vx, vy]) — charge is a static body property, not a
// time-varying state. LorentzForce reads body.charge each step.
export class Charge extends Particle {
  constructor({ id, mass_kg, charge_C, position_m, velocity_m_per_s, render_shape = null }) {
    super({ id, mass_kg, position_m, velocity_m_per_s, render_shape });
    if (typeof charge_C !== 'number' || Number.isNaN(charge_C)) {
      throw new Error(
        `Charge.charge_C must be a finite number (got ${charge_C}). ` +
        `Body id="${id}".`
      );
    }
    this.charge = charge_C;
  }
}

// MagneticDipole: a Particle that carries a magnetic dipole moment μ as
// a vec3. Phase 3.3 (axial slice — μ pinned along ẑ; Q2=a constraint).
// State vector layout unchanged from Particle ([x, y, vx, vy]) — μ is
// static (no rotational dynamics at v0; rotational state deferred to
// Phase 3.4 / 5). DipoleInField reads body.mu each step.
//
// Q1=C lock: μ lives on the body (intrinsic property), force class
// DipoleInField is field-binder only. Mirrors Charge/Coulomb pattern.
export class MagneticDipole extends Particle {
  constructor({ id, mass_kg, mu_z_J_per_T, position_m, velocity_m_per_s, render_shape = null }) {
    super({ id, mass_kg, position_m, velocity_m_per_s, render_shape });
    if (
      typeof mu_z_J_per_T !== 'number' ||
      !Number.isFinite(mu_z_J_per_T)
    ) {
      throw new Error(
        `MagneticDipole.mu_z_J_per_T must be a finite number (got ${mu_z_J_per_T}). ` +
        `Body id="${id}".`
      );
    }
    // SD-7: μ stored as vec3 with explicit zero in-plane components.
    // The asymmetry vs gradB_z_at (vec2) is intentional — μ is a
    // 3D vector quantity; ∇B_z is the gradient of a scalar evaluated
    // in-plane (vec2).
    this.mu = { x: 0, y: 0, z: mu_z_J_per_T };
  }
}

// ─────────────────────────────────────────────────────────────────────
// STRIDE-6 ROTATIONAL-BODY CONTRACT (Phase D1 — formalized once)
//
// Every body that carries a rotational degree of freedom (RotatingDipole,
// RigidBody, and any future rolling cylinder / torsion pendulum) implements
// this SAME contract, so the variable-stride integrator and serializer route
// them without per-class edits. A new rotational body type conforms by
// reading this block — do not invent a parallel shape.
//
//   - stateSize === 6           slot layout [x, y, vx, vy, θ, ω]
//                               (translational FIRST, rotational APPENDED —
//                               so a 4-slot Particle is a strict prefix).
//   - momentOfInertia          scalar I about the fixed out-of-plane (ẑ)
//                               axis, kg·m², MUST be > 0. (2-D planar ω is a
//                               scalar — this is NOT the 3-D vec3-ω refactor,
//                               roadmap H3; do not start that here.)
//   - theta   (rad)            orientation; slot 4.  ← canonical field name
//   - omega   (rad/s)          angular velocity; slot 5.
//     ‼ NEVER name these `angle` / `angular_velocity`. The integrator reads
//       `b.omega` at scene.js (ds[off+4]=b.omega) and would write NaN for a
//       body that spelled it `angular_velocity`; the serializer probes
//       `b.theta`/`b.omega` too. The `angle`/`angular_velocity` names are a
//       retired aspirational spelling — forbidden (see anti-targets).
//   - packState()              returns [x, y, vx, vy, θ, ω] (this exact order).
//   - unpackState(s)           writes position/velocity from s[0..3] and
//                               theta/omega from s[4]/s[5] (plus any derived
//                               per-substep refresh, e.g. RotatingDipole._refreshMu).
//   - kineticEnergy()          includes the rotational term ½Iω²
//                               (Particle's is ½m|v|² only).
//   - kineticEnergyRotational()  returns ½Iω² (the LOL overlay's K_rot sub-bar).
//
// The integrator's dω/dt = Στ.z / I routing is duck-typed on stride === 6;
// the I>0 runtime guard (InvalidMomentOfInertiaError) fires before that
// division. A conforming body needs no integrator change.
// ─────────────────────────────────────────────────────────────────────

// RotatingDipole: a Particle that carries a magnetic dipole moment μ
// PLUS rotational state (θ, ω, I). Phase 3.4 — first body with a
// non-default stateSize (6 = translational [x, y, vx, vy] + rotational
// [θ, ω]). Slot ordering preserved: translational FIRST, rotational
// APPENDED. Phase 3.4 plan §"Files this phase modifies — Engine"
// pins this ordering.
//
// μ is stored as an in-plane vec3: μ = (μ_mag·cos θ, μ_mag·sin θ, 0).
// At θ = 0, μ aligns with +x̂. Rotating by θ rotates μ in the xy-plane.
// This is what gives `tau = (μ × B).z = μ_x·B_y − μ_y·B_x` non-zero
// values for in-plane B fields. The MagneticDipole 3.3 axial-only
// shape (μ_x = μ_y = 0, μ_z = mu_z_J_per_T) is intentionally distinct
// — RotatingDipole and MagneticDipole are sibling classes (Q3=B).
//
// Q4=A v0 lock: compass-needle scenes have v=(0,0); the translational
// state is present-but-zero. Forward-compat with Phase 3.5 coupled
// translational+rotational scenes is why stateSize=6 even though v=0
// here (the variable-stride integrator path is exercised on a body
// that nominally carries translational state).
//
// Sign-convention pin (plan §"Files this phase modifies — Engine,
// forces.js bullet"): with B = (B_x, B_y, 0) in-plane,
//   τ = μ_x · B_y − μ_y · B_x
// (positive = counter-clockwise about ẑ). Restoring behavior is
// implicit in the geometry — when the dipole rotates by +δθ from
// alignment with B, μ rotates so the cross product points in −ẑ,
// yielding negative τ and angular acceleration back toward alignment.
// The integrator does NOT manually flip signs.
export class RotatingDipole extends Particle {
  constructor({
    id,
    mass_kg,
    mu_z_J_per_T,
    I_kg_m2,
    position_m,
    velocity_m_per_s,
    theta_rad,
    omega_rad_per_s,
    render_shape = null
  }) {
    super({ id, mass_kg, position_m, velocity_m_per_s, render_shape });
    if (
      typeof mu_z_J_per_T !== 'number' ||
      !Number.isFinite(mu_z_J_per_T)
    ) {
      throw new Error(
        `RotatingDipole.mu_z_J_per_T must be a finite number (got ${mu_z_J_per_T}). ` +
        `Body id="${id}".`
      );
    }
    if (
      typeof I_kg_m2 !== 'number' ||
      !Number.isFinite(I_kg_m2) ||
      I_kg_m2 <= 0
    ) {
      throw new Error(
        `RotatingDipole.I_kg_m2 must be a finite, positive number (got ${I_kg_m2}). ` +
        `Body id="${id}".`
      );
    }
    if (typeof theta_rad !== 'number' || !Number.isFinite(theta_rad)) {
      throw new Error(
        `RotatingDipole.theta_rad must be a finite number (got ${theta_rad}). ` +
        `Body id="${id}".`
      );
    }
    if (typeof omega_rad_per_s !== 'number' || !Number.isFinite(omega_rad_per_s)) {
      throw new Error(
        `RotatingDipole.omega_rad_per_s must be a finite number (got ${omega_rad_per_s}). ` +
        `Body id="${id}".`
      );
    }
    // Magnitude of the in-plane dipole moment. Stored separately so
    // unpackState can recompute μ when θ changes during integration.
    this.muMagnitude = mu_z_J_per_T;
    this.momentOfInertia = I_kg_m2;
    this.theta = theta_rad;
    this.omega = omega_rad_per_s;
    // 6 slots: [x, y, vx, vy, θ, ω].
    this.stateSize = 6;
    // Compute initial μ from θ. Force consumers read body.mu directly.
    this._refreshMu();
  }

  // Rebuild the in-plane μ vector from the current θ. Called by the
  // constructor and by unpackState (which fires on every RK4 substep
  // sync). Keeping μ in sync with θ means Force.applyTo's read of
  // body.mu always reflects the current substep's angle.
  _refreshMu() {
    this.mu = {
      x: this.muMagnitude * Math.cos(this.theta),
      y: this.muMagnitude * Math.sin(this.theta),
      z: 0
    };
  }

  // K = ½m|v|² + ½Iω². Override of Particle.kineticEnergy().
  // ConservationTracker accumulates `body.kineticEnergy()` per body
  // (energy.js:45); polymorphism delivers K_rot through that path
  // without touching the tracker.
  kineticEnergy() {
    const v2 = this.velocity.x * this.velocity.x + this.velocity.y * this.velocity.y;
    return 0.5 * this.mass * v2 + 0.5 * this.momentOfInertia * this.omega * this.omega;
  }

  // Phase 3.5 (Q9=A): rotational-only piece of K. The translational
  // piece is the inherited Particle.kineticEnergy minus this. Used by
  // the LOL overlay's K_trans/K_rot stacked sub-bar split.
  kineticEnergyRotational() {
    return 0.5 * this.momentOfInertia * this.omega * this.omega;
  }

  // Slot order pinned: [x, y, vx, vy, θ, ω].
  packState() {
    return [
      this.position.x, this.position.y,
      this.velocity.x, this.velocity.y,
      this.theta, this.omega
    ];
  }

  unpackState(s) {
    this.position = { x: s[0], y: s[1] };
    this.velocity = { x: s[2], y: s[3] };
    this.theta = s[4];
    this.omega = s[5];
    // μ rotates with θ — refresh so subsequent Force.applyTo reads
    // see the new orientation (canonical RK4-substep correctness:
    // μ at substep k_n must reflect θ at substep k_n).
    this._refreshMu();
  }
}

// RigidBody: a 2-D planar rigid body with translational DOFs PLUS a single
// rotational DOF (θ, ω) about the fixed out-of-plane (ẑ) axis. Phase D1 —
// the first NON-dipole stride-6 body. It conforms to the STRIDE-6 ROTATIONAL-
// BODY CONTRACT above (theta/omega, packState [x,y,vx,vy,θ,ω], ½Iω² in K),
// so the integrator's dω/dt = Στ.z/I routing drives it with no engine edit.
//
// Unlike RotatingDipole it carries NO magnetic moment — there is no `mu` /
// `_refreshMu`; its torque comes from ordinary forces (D2 rolling friction,
// D4 gravity restoring torque), not μ×B.
//
// Moment of inertia is stated ONE of two ways (exactly one, never both):
//   - `I_kg_m2`: an explicit inertia about the CoM, or
//   - `inertia_spec`: {shape, R_m|L_m} resolved through inertia.js using the
//     body's own mass — so a scene never writes a raw inertia it could get
//     wrong for a standard shape.
//
// PIVOTED bodies (Phase D4 — physical pendulum). An OPTIONAL `pivot: {x, y}`
// turns the rigid body into a body constrained to rotate about that fixed point
// (a physical pendulum). Then:
//   - the stated inertia (I_kg_m2 / inertia_spec) is the CoM inertia I_cm; the
//     constructor shifts it to the pivot via parallelAxis: I_pivot = I_cm + M·D²
//     (D = pivot→CoM distance), and `momentOfInertia` becomes I_pivot so the
//     integrator's dω/dt = Στ.z/I routing divides by the correct inertia;
//   - the SIGN CONVENTION is pinned: θ = 0 ≡ CoM hanging straight DOWN from the
//     pivot, positive CCW (+ẑ). CoM = pivot + D·(sinθ, −cosθ);
//   - the body's translational DOFs are SLAVED, not integrated. `unpackState`
//     derives position from θ and forces velocity to 0 (all KE is rotation
//     about the pivot, ½I_pivot ω² — the standard kineticEnergy() then reports
//     the full pendulum KE with NO double-count). The integrator suppresses the
//     translational derivative rows and folds the net force's moment about the
//     pivot into the torque channel (scene.js). See
//     docs/physics_briefs/sim_phase_d4_pendulum_brief.md.
export class RigidBody extends Particle {
  constructor({
    id,
    mass_kg,
    I_kg_m2,
    inertia_spec,
    position_m,
    velocity_m_per_s,
    theta_rad,
    omega_rad_per_s,
    pivot = null,
    render_shape = null
  }) {
    super({ id, mass_kg, position_m, velocity_m_per_s, render_shape });

    // EXACTLY ONE of I_kg_m2 / inertia_spec. Both-or-neither is an authoring
    // error. The schema's oneOf enforces this at scene-load, but the class
    // must stand alone for the hot-reload / direct-construction paths that
    // bypass schema validation (same rationale as RotatingDipole's guards).
    const hasExplicit = I_kg_m2 !== undefined;
    const hasSpec = inertia_spec !== undefined;
    if (hasExplicit === hasSpec) {
      throw new Error(
        `RigidBody requires EXACTLY ONE of I_kg_m2 or inertia_spec ` +
        `(got I_kg_m2=${I_kg_m2}, inertia_spec=${JSON.stringify(inertia_spec)}). ` +
        `Body id="${id}".`
      );
    }
    let I;
    if (hasExplicit) {
      if (typeof I_kg_m2 !== 'number' || !Number.isFinite(I_kg_m2) || I_kg_m2 <= 0) {
        throw new Error(
          `RigidBody.I_kg_m2 must be a finite, positive number (got ${I_kg_m2}). ` +
          `Body id="${id}".`
        );
      }
      I = I_kg_m2;
    } else {
      // inertiaFromSpec re-validates shape, dimension, and positivity,
      // throwing a spec-specific message on failure.
      I = inertiaFromSpec(inertia_spec, mass_kg);
    }

    if (typeof theta_rad !== 'number' || !Number.isFinite(theta_rad)) {
      throw new Error(
        `RigidBody.theta_rad must be a finite number (got ${theta_rad}). Body id="${id}".`
      );
    }
    if (typeof omega_rad_per_s !== 'number' || !Number.isFinite(omega_rad_per_s)) {
      throw new Error(
        `RigidBody.omega_rad_per_s must be a finite number (got ${omega_rad_per_s}). Body id="${id}".`
      );
    }

    // Pivoted body (Phase D4): shift I_cm → I_pivot and slave the CoM to θ.
    // `pivot` absent ⇒ a free rigid body (momentOfInertia stays I_cm), so
    // every existing rigid_body scene is byte-identical.
    if (pivot != null) {
      if (typeof pivot !== 'object' ||
          typeof pivot.x !== 'number' || !Number.isFinite(pivot.x) ||
          typeof pivot.y !== 'number' || !Number.isFinite(pivot.y)) {
        throw new Error(
          `RigidBody.pivot must be {x, y} with finite numbers ` +
          `(got ${JSON.stringify(pivot)}). Body id="${id}".`
        );
      }
      const dx = this.position.x - pivot.x;
      const dy = this.position.y - pivot.y;
      const D = Math.hypot(dx, dy);
      if (!(D > 0)) {
        throw new Error(
          `RigidBody.pivot coincides with the CoM (D=0); a physical pendulum ` +
          `needs pivot ≠ position_m. Body id="${id}".`
        );
      }
      // θ = 0 ≡ CoM straight down: CoM = pivot + D·(sinθ, −cosθ), so
      // sinθ = dx/D, cosθ = −dy/D ⇒ θ = atan2(dx, −dy). The declared
      // theta_rad must agree with this geometry (single source of truth) —
      // a mismatch is an authoring error (position_m ≠ stated angle).
      const thetaFromGeom = Math.atan2(dx, -dy);
      const thetaGap = Math.abs(
        Math.atan2(Math.sin(thetaFromGeom - theta_rad), Math.cos(thetaFromGeom - theta_rad))
      );
      if (thetaGap > 1e-6) {
        throw new Error(
          `RigidBody.theta_rad=${theta_rad} disagrees with the pivot geometry ` +
          `(position_m relative to pivot implies θ=${thetaFromGeom}). ` +
          `For a pivoted body θ=0 is CoM straight down, +CCW. Body id="${id}".`
        );
      }
      // Velocity is slaved to 0 (the CoM's motion is carried by ω; all KE is
      // ½I_pivot ω²). A nonzero declared velocity would be silently discarded,
      // so reject it — the swing speed is set via omega_rad_per_s.
      if (Math.hypot(this.velocity.x, this.velocity.y) > 1e-9) {
        throw new Error(
          `RigidBody with a pivot must declare velocity_m_per_s = {0, 0} ` +
          `(CoM velocity is derived from omega_rad_per_s, not integrated). ` +
          `Body id="${id}".`
        );
      }
      this.pivot = { x: pivot.x, y: pivot.y };
      this.pivotDistance = D;
      this.momentOfInertia = parallelAxis(I, mass_kg, D); // I_pivot = I_cm + M·D²
      this.theta = thetaFromGeom;
      this.omega = omega_rad_per_s;
      this.velocity = { x: 0, y: 0 };
    } else {
      this.pivot = null;
      this.pivotDistance = 0;
      this.momentOfInertia = I;
      this.theta = theta_rad;
      this.omega = omega_rad_per_s;
    }
    // Stride-6: [x, y, vx, vy, θ, ω]. See the contract block above.
    this.stateSize = 6;
  }

  // K = ½m|v|² + ½Iω². Override of Particle.kineticEnergy() — the tracker
  // accumulates body.kineticEnergy() polymorphically (energy.js).
  kineticEnergy() {
    const v2 = this.velocity.x * this.velocity.x + this.velocity.y * this.velocity.y;
    return 0.5 * this.mass * v2 + 0.5 * this.momentOfInertia * this.omega * this.omega;
  }

  // Rotational-only piece of K (the LOL overlay's K_rot sub-bar).
  kineticEnergyRotational() {
    return 0.5 * this.momentOfInertia * this.omega * this.omega;
  }

  // Slot order pinned by the contract: [x, y, vx, vy, θ, ω].
  packState() {
    return [
      this.position.x, this.position.y,
      this.velocity.x, this.velocity.y,
      this.theta, this.omega
    ];
  }

  unpackState(s) {
    this.theta = s[4];
    this.omega = s[5];
    if (this.pivot) {
      // Pivoted (D4): the CoM is a DERIVED position slaved to θ, and velocity
      // is slaved to 0 (all KE is rotation about the pivot). The translational
      // slots s[0..3] are inert — the integrator zeros their derivatives — so
      // reading them would carry stale values; recompute from θ instead.
      this.position = {
        x: this.pivot.x + this.pivotDistance * Math.sin(this.theta),
        y: this.pivot.y - this.pivotDistance * Math.cos(this.theta)
      };
      this.velocity = { x: 0, y: 0 };
    } else {
      this.position = { x: s[0], y: s[1] };
      this.velocity = { x: s[2], y: s[3] };
    }
  }
}

export const NAME = 'bodies';
