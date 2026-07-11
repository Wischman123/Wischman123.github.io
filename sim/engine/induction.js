// engine/induction.js
//
// Phase 5.D Step 4(b)2 deliverable. Sole owner of `runInductionCheck`
// — the companion to 5.B's `runFluxCheck` that scores Faraday's law
// (EMF = −dΦ_B/dt) against a centered O(dt²) finite-difference
// derivative of the magnetic flux through an open surface bounded by
// an `induction_loop` entry.
//
// Locked decisions (frontmatter `q*_lock` of physics_simulator_phase_5_d_induction):
//   - Q5=b — induction_loops is a sibling block to gauss_surfaces; this
//     module integrates B over those open surfaces (disk for circle,
//     rectangle for rectangle).
//   - Q10=a — analytic-primary, discrete cross-check. The caller may
//     pass `emf_predicted` as an analytic comparand; runInductionCheck
//     gates the numerical EMF against it via the same two-mode (rel /
//     abs) residual policy 5.B locked into runFluxCheck.
//   - Q14=a — centered O(dt²) finite difference: dΦ/dt|_t ≈
//     (Φ(t+dt) − Φ(t−dt)) / (2·dt). Generic across all scenes; no
//     fallback (`tolerance_method_dependency` = {primary:
//     centered_O_dt2, fallback: none} pinned in 0c JSON).
//   - Q15=a — every B_at sample is preceded by `field.setTime(t)` in
//     the same function scope when the field exposes setTime (duck-
//     typed; static fields skip the call). The runtime stale-cache
//     guard inside `TimeVaryingUniformField` enforces this at sample-
//     time; this module's discipline guarantees the guard never trips
//     under normal use.
//   - Q16=a — `runInductionCheck` is a NEW companion entry point;
//     `runFluxCheck`'s signature is NOT mutated. This module imports
//     `runFluxCheck` for closure-sanity verification (∮ B·dA = 0 over
//     a closed pillbox enclosing the loop) — the FIRST production-
//     engine caller of `runFluxCheck` per 0c JSON
//     `runFluxCheck_caller_audit.first_production_caller_lands_at`.
//
// Open-surface integrator note: 5.B's `runFluxCheck` only handles
// CLOSED surfaces (sphere, cylinder, pillbox) because Gauss's law
// computes ∮ over a closed boundary. Faraday's law integrates over an
// OPEN surface bounded by the loop — a fundamentally different
// integral. This module ships the open-surface quadrature directly
// (concentric Vogel-sunflower for disks, regular grid for rectangles)
// rather than mutating the closed-surface integrator. The cap helpers
// in flux.js (`_diskCapDiscrete`, `_squareCapDiscrete`) follow the
// same per-shape patterns; this is shape-parallel, not a leaky
// abstraction.
//
// 5.E forward-extensibility note (per plan §Step 4(b)2 lines 533-540):
// if 5.E ships time-evolved Maxwell coupling (∂E/∂t source for B),
// the setTime → sample → finite-difference loop here is incompatible
// with coupled E-B systems. Unlike 5.B's runFluxCheck (locked field-
// agnostic), `runInductionCheck` is NOT considered API-locked across
// Phase 5. Pinned in 0c JSON
// `runInductionCheck_extensibility_note: "single_physics_only_pre_5e"`.
//
// File-scope CI-gate (Step 0b.2b): this module deliberately does NOT
// import `TimeVaryingUniformField`. The 0b.2b vec3-field gate is file-
// scoped — files that import or declare TVUF have an additional
// setTime-discipline check enabled. Skipping the import keeps the gate
// silent here without suppression. Runtime correctness is enforced by
// (i) the duck-typed setTime call in this module, and (ii) the
// stale-cache throw inside TVUF.B_at itself. Both layers catch a
// missing setTime independent of the build-time gate.

import { vec3, assertVec3Field } from './vec.js';
import { runFluxCheck } from './flux.js';

// Default centered finite-difference step. Matches per_scene_tolerances
// `discrete_dt` in 0c JSON for both 5.D scenes (induction_motional_1,
// induction_time_varying_b_1). Aliasing rule for time-varying-B scenes
// (dt ≤ T_period / 100) is the caller's concern; this module does not
// inspect the field for ω.
const FINITE_DIFF_DT_DEFAULT = 1e-3;

// Open-surface quadrature N (per-loop fallback). Loops MAY pin
// `discretization.N` in the scene JSON; this default applies when none
// is pinned.
const N_QUADRATURE_DEFAULT = 256;

// Below this |emf_predicted|, the residual gate switches to absolute
// mode. Mirrors `EPSILON_ABS_DEFAULT` in flux.js (1e-23 V·m for
// electric flux); EMF units are V, but the same near-zero policy
// applies — for v=0 / ω=0 degenerate cases the predicted EMF is
// machine-zero and a relative residual diverges.
const EPSILON_ABS_DEFAULT = 1e-23;

// Default absolute tolerance fraction (Q7-style band). Mirrors flux.js
// `TOLERANCE_ABS_DEFAULT_FRACTION`.
const TOLERANCE_ABS_DEFAULT_FRACTION = 1 / 100;

// Default residual tolerance for the analytic-vs-numerical EMF check
// when the caller does not pin one. Matches the per-scene
// `discrete_residual_max` budget in 0c JSON (1e-8 for both 5.D scenes
// at dt = 1e-3 — derived from the centered-O(dt²) error scaling).
const TOLERANCE_REL_DEFAULT = 1e-8;

// ---------------------------------------------------------------------
// computeLoopFlux
// ---------------------------------------------------------------------

/**
 * computeLoopFlux(loop, field, t, options) → number.
 *
 * Discrete-method ∫ B·n̂ dA over the open surface bounded by `loop`,
 * sampled at time `t`. Per Q15=a, primes the field's time cache via
 * `field.setTime(t)` if the method is present; otherwise skipped
 * (static fields). Every sample point is gated by `assertVec3Field` so
 * a partial vec2→vec3 widening surfaces with per-source attribution.
 *
 * @param {Object} loop     — `induction_loop` schema entry. shape ∈ {circle, rectangle}.
 * @param {Object} field    — Field-class instance with `B_at(point) → vec3` and optional `setTime(t)`.
 * @param {number} t        — sample time (seconds). Passed to `field.setTime(t)` when applicable.
 * @param {Object} [options]
 * @param {number} [options.N] — quadrature point count override (default loop.discretization.N → 256).
 * @returns {number} Φ_B in Tesla·m² (Weber).
 */
export function computeLoopFlux(loop, field, t, options = {}) {
  if (!loop || typeof loop !== 'object') {
    throw new Error('computeLoopFlux: loop must be an object');
  }
  if (!field || typeof field.B_at !== 'function') {
    throw new Error('computeLoopFlux: field must expose B_at(point) → vec3');
  }
  if (typeof t !== 'number' || !Number.isFinite(t)) {
    throw new Error(`computeLoopFlux: t must be a finite number (got ${t})`);
  }
  // Q15=a: prime time cache before any B_at sample. Same function scope
  // as the sampling loop — keeps the 0b.2b gate silent (file is exempt
  // anyway since TVUF is not imported here, but the pairing is the
  // structurally correct discipline irrespective of the gate).
  if (typeof field.setTime === 'function') {
    field.setTime(t);
  }
  const N = options.N ?? loop?.discretization?.N ?? N_QUADRATURE_DEFAULT;
  if (!Number.isInteger(N) || N < 1) {
    throw new Error(`computeLoopFlux: N must be a positive integer (got ${N})`);
  }
  if (loop.shape === 'circle') return _diskFlux(loop, field, N);
  if (loop.shape === 'rectangle') return _rectFlux(loop, field, N);
  throw new Error(`computeLoopFlux: unsupported loop shape "${loop.shape}"`);
}

// Vogel-sunflower disk quadrature. dA = πR²/N; sample positions span
// the disk uniformly via the golden-angle spiral. Mirrors the pattern
// in flux.js `_diskCapDiscrete` so the two integrators stay shape-
// parallel; the difference here is that the "outward normal" is the
// loop's declared `normal` (RHR-positive circulation), NOT a derived
// axis-component.
function _diskFlux(loop, field, N) {
  const center = loop.center;
  const normal = loop.normal;
  const radius = loop.radius;
  const { e1, e2 } = _orthonormalBasis(normal);
  const dA = (Math.PI * radius * radius) / N;
  const golden = Math.PI * (3 - Math.sqrt(5));
  let phi = 0;
  for (let i = 0; i < N; i++) {
    const r = radius * Math.sqrt((i + 0.5) / N);
    const theta = golden * i;
    const u1 = r * Math.cos(theta);
    const u2 = r * Math.sin(theta);
    const point = {
      x: center.x + u1 * e1.x + u2 * e2.x,
      y: center.y + u1 * e1.y + u2 * e2.y,
      z: center.z + u1 * e1.z + u2 * e2.z
    };
    const B = field.B_at(point);
    assertVec3Field(B, '_diskFlux.B_at');
    const dot = B.x * normal.x + B.y * normal.y + B.z * normal.z;
    phi += dot * dA;
  }
  return phi;
}

// Regular-grid rectangle quadrature. The schema requires axis_u to be
// unit AND ⟂ normal; the orthogonal in-plane axis is normal × axis_u
// (also unit, also ⟂ normal). Sample points live in a k×k grid where
// k = round(√N); dA = (width·height)/k². Mirrors `_squareCapDiscrete`
// in flux.js but uses width × height instead of side² and reads the
// in-plane basis from the loop's declared `axis_u` rather than deriving
// from the surface axis.
function _rectFlux(loop, field, N) {
  const center = loop.center;
  const normal = loop.normal;
  const a = loop.axis_u;
  const b = vec3.cross(normal, a); // unit AND ⟂ to both (schema-locked)
  const k = Math.max(1, Math.round(Math.sqrt(N)));
  const k2 = k * k;
  const dA = (loop.width * loop.height) / k2;
  const half_w = loop.width / 2;
  const half_h = loop.height / 2;
  let phi = 0;
  for (let i = 0; i < k; i++) {
    const u_a = (-half_w) + ((i + 0.5) / k) * loop.width;
    for (let j = 0; j < k; j++) {
      const u_b = (-half_h) + ((j + 0.5) / k) * loop.height;
      const point = {
        x: center.x + u_a * a.x + u_b * b.x,
        y: center.y + u_a * a.y + u_b * b.y,
        z: center.z + u_a * a.z + u_b * b.z
      };
      const B = field.B_at(point);
      assertVec3Field(B, '_rectFlux.B_at');
      const dot = B.x * normal.x + B.y * normal.y + B.z * normal.z;
      phi += dot * dA;
    }
  }
  return phi;
}

// Same Gram-Schmidt pattern flux.js uses for closed-surface quadrature
// bases. Local copy keeps induction.js self-contained (no private cross-
// import from flux.js). Returns (e1, e2) such that {axis, e1, e2} is a
// right-handed orthonormal basis.
function _orthonormalBasis(axis) {
  const ax = Math.abs(axis.x);
  const ay = Math.abs(axis.y);
  const az = Math.abs(axis.z);
  let seed;
  if (ax <= ay && ax <= az) seed = { x: 1, y: 0, z: 0 };
  else if (ay <= az) seed = { x: 0, y: 1, z: 0 };
  else seed = { x: 0, y: 0, z: 1 };
  const cross1 = vec3.cross(axis, seed);
  const m1 = vec3.norm(cross1);
  if (m1 === 0) {
    throw new Error('_orthonormalBasis: degenerate axis (axis ∥ all world bases)');
  }
  const e1 = { x: cross1.x / m1, y: cross1.y / m1, z: cross1.z / m1 };
  const e2 = vec3.cross(axis, e1);
  return { e1, e2 };
}

// ---------------------------------------------------------------------
// closure-sanity (∮ B·dA = 0 over a closed pillbox enclosing the loop)
// ---------------------------------------------------------------------

/**
 * Verify ∇·B = 0 by computing ∮ B·dA over a closed pillbox tightly
 * enclosing the loop's bounded surface. By Gauss's law for magnetism
 * (no monopoles), this integral is identically zero for any physical
 * field — so a non-zero residual indicates either a buggy field
 * implementation OR a non-Maxwell-physical field (e.g.,
 * LinearGradientField with g≠0; see b_flux_closure.test.js Section C).
 *
 * Q16=a: this is the ONLY call site in induction.js that uses
 * runFluxCheck, satisfying the 0c JSON
 * `first_production_caller_lands_at` claim. The pillbox is always
 * built with `field_kind: 'magnetic'` (Gauss-B; phi_predicted = 0)
 * and never passes `q_enc` (electric-only contract per
 * `runFluxCheck_caller_audit.e_specific_findings`).
 *
 * @param {Object} loop  — induction_loop schema entry.
 * @param {Object} field — Field-class instance.
 * @param {number} t     — sample time (used to prime field.setTime(t)).
 * @param {Object} [options]
 * @param {number} [options.thickness] — pillbox half-thickness (m); default radius/width × 1e-3.
 * @param {number} [options.tolerance_abs] — passed through to runFluxCheck.
 * @param {number} [options.N_quadrature] — passed through to runFluxCheck.
 * @returns {Object} runFluxCheck result ({phi_numeric, phi_predicted, residual, residual_kind, passed}).
 */
export function runLoopClosureSanity(loop, field, t, options = {}) {
  if (typeof field.setTime === 'function') {
    field.setTime(t);
  }
  const surface = _pillboxAroundLoop(loop, options.thickness);
  // Field-eval closure for runFluxCheck. Per Q15=a, setTime was called
  // above in the same function scope; runFluxCheck invokes this closure
  // synchronously inside the same call, so the cache is fresh at every
  // sample. Empty scene — `field_kind: 'magnetic'` short-circuits
  // _computeQ_enc upstream (per `runFluxCheck_caller_audit` audit:
  // magnetic-mode never reaches the q_enc walk).
  // The 0b.2b vec3-field setTime guard is file-scoped and disabled
  // here (induction.js does not import TimeVaryingUniformField). Even
  // without the gate, runtime correctness holds: setTime(t) was called
  // above in this same function scope, runFluxCheck invokes the closure
  // synchronously, and TVUF's stale-cache guard would throw at the
  // first sample if the cache were not primed.
  const fieldFn = (point) => field.B_at(point);
  return runFluxCheck({ bodies: [] }, surface, fieldFn, {
    method: 'discrete',
    field_kind: 'magnetic',
    N_quadrature: options.N_quadrature ?? 128,
    tolerance_abs: options.tolerance_abs ?? 1e-9
  });
}

// Build a thin closed pillbox that encloses the loop's bounded area.
// The pillbox shares the loop's center and normal axis; cap dimension
// matches the loop's bounding box (radius for circle, max(w,h) for
// rectangle). Thickness is small (default = 1e-3 × cap_dim) so the
// pillbox is "thin" — keeps side-flux contribution analytically zero
// for spatially-uniform fields and small for slowly-varying ones.
function _pillboxAroundLoop(loop, thicknessOverride) {
  const isCircle = loop.shape === 'circle';
  const cap_dim = isCircle
    ? loop.radius
    : Math.max(loop.width, loop.height);
  const thickness = thicknessOverride ?? cap_dim * 1e-3;
  return {
    id: `induction_closure_${loop.id ?? 'anon'}`,
    shape: 'pillbox',
    center: loop.center,
    axis: loop.normal,
    cap_shape: isCircle ? 'disk' : 'square',
    cap_dim,
    thickness
  };
}

// ---------------------------------------------------------------------
// runInductionCheck — chokepoint
// ---------------------------------------------------------------------

/**
 * runInductionCheck(loop, field, options) →
 *   { emf, dphi_dt, phi_minus, phi_plus, t_minus, t_plus,
 *     emf_predicted, residual, residual_kind, passed, dt }
 *
 * Computes Faraday's-law EMF via centered O(dt²) finite difference
 * (Q14=a):
 *
 *     EMF(t) = −dΦ/dt|_t ≈ −(Φ(t+dt) − Φ(t−dt)) / (2·dt)
 *
 * The integrator-owned discipline (Q3=a / Q15=a) is to invoke
 * `field.setTime(t)` before each B_at sample. computeLoopFlux handles
 * this internally; runInductionCheck calls computeLoopFlux at t±dt,
 * each of which primes the cache once before its sampling loop.
 *
 * If `options.emf_predicted` is supplied, the residual gate compares
 * `emf` against it via the same two-mode (rel / abs) policy
 * runFluxCheck uses (Q10=a — analytic-primary + discrete cross-check).
 * Without `emf_predicted`, the gate is informational (`passed = true`,
 * `residual = 0`).
 *
 * @param {Object} loop    — induction_loop schema entry.
 * @param {Object} field   — Field-class instance.
 * @param {Object} [options]
 * @param {number} [options.t]              — center time (seconds). Default 0.
 * @param {number} [options.dt]             — finite-difference step (seconds). Default 1e-3.
 * @param {number} [options.N]              — quadrature N override.
 * @param {number} [options.emf_predicted]  — analytic comparand. If undefined, gate is informational.
 * @param {number} [options.tolerance_rel]  — relative-mode tolerance. Default 1e-8.
 * @param {number} [options.tolerance_abs]  — absolute-mode tolerance. Default epsilon_abs / 100.
 * @param {number} [options.epsilon_abs]    — relative→absolute switch threshold. Default 1e-23.
 * @returns {Object}
 */
export function runInductionCheck(loop, field, options = {}) {
  const t = options.t ?? 0;
  const dt = options.dt ?? FINITE_DIFF_DT_DEFAULT;
  if (typeof t !== 'number' || !Number.isFinite(t)) {
    throw new Error(`runInductionCheck: t must be a finite number (got ${t})`);
  }
  if (typeof dt !== 'number' || !Number.isFinite(dt) || dt <= 0) {
    throw new Error(`runInductionCheck: dt must be a positive finite number (got ${dt})`);
  }
  const t_minus = t - dt;
  const t_plus = t + dt;
  // Sample twice. Each computeLoopFlux call primes setTime in its own
  // scope before its sampling loop, so the t-cache is correct at every
  // sample regardless of field type. The two samples MUST be sequential
  // (t_minus first, then t_plus) — TVUF's setTime overwrites the cache,
  // and any intermediate B_at sample without a fresh setTime would read
  // the wrong t.
  const phi_minus = computeLoopFlux(loop, field, t_minus, { N: options.N });
  const phi_plus = computeLoopFlux(loop, field, t_plus, { N: options.N });
  const dphi_dt = (phi_plus - phi_minus) / (2 * dt);
  const emf = -dphi_dt;
  // Residual gate. Two-mode policy mirrors flux.js exactly so callers
  // see consistent semantics across runFluxCheck / runInductionCheck.
  const emf_predicted = options.emf_predicted;
  let residual = 0;
  let residual_kind = 'absolute';
  let passed = true;
  if (emf_predicted !== undefined) {
    if (typeof emf_predicted !== 'number' || !Number.isFinite(emf_predicted)) {
      throw new Error(
        `runInductionCheck: emf_predicted must be a finite number when supplied (got ${emf_predicted})`
      );
    }
    const epsilon_abs = options.epsilon_abs ?? EPSILON_ABS_DEFAULT;
    residual_kind = Math.abs(emf_predicted) < epsilon_abs ? 'absolute' : 'relative';
    let tolerance;
    if (residual_kind === 'relative') {
      residual = Math.abs(emf - emf_predicted) / Math.abs(emf_predicted);
      tolerance = options.tolerance_rel ?? TOLERANCE_REL_DEFAULT;
    } else {
      residual = Math.abs(emf - emf_predicted);
      tolerance = options.tolerance_abs ?? (epsilon_abs * TOLERANCE_ABS_DEFAULT_FRACTION);
    }
    passed = residual <= tolerance;
  }
  return {
    emf,
    dphi_dt,
    phi_minus,
    phi_plus,
    t_minus,
    t_plus,
    emf_predicted,
    residual,
    residual_kind,
    passed,
    dt
  };
}

// ---------------------------------------------------------------------
// sampleLoopFluxes + contributeDiagnostics — Phase A0 producer surface
// ---------------------------------------------------------------------
//
// Phase A0 registers `induction.js` as a diagnostics PRODUCER (scene.js
// pushes this module onto the tracker's `producers` list when the scene
// declares `induction_loops`). Unlike the flux producer — whose Φ_E is a
// stateless function of the live charges, recomputable on demand — Faraday
// EMF needs dΦ_B/dt, i.e. a flux HISTORY. The history CANNOT be advanced
// inside `contributeDiagnostics`, because:
//
//   1. `computeLoopFlux` calls `field.setTime(t)` — a MUTATION. The
//      producer contract (circuits.js) is a PURE read: calling it twice
//      with no intervening tick must return the same map. Sampling inside
//      it would double-advance the field's time cache.
//   2. The tracker may call `current()` (→ contributeDiagnostics) more
//      than once per tick; the flux must advance EXACTLY once per tick.
//
// So sampling is split from reporting along the S3 tick-ordering invariant:
//
//   - `sampleLoopFluxes(sceneCtx, t, dt)` runs in SimRunner._advanceOne's
//     step-3 discrete-update slot (after syncBodies, BEFORE the tracker
//     snapshot). It computes Φ_B(t) per loop and advances the one-step
//     history stash on `sceneCtx.inductionFluxState`.
//   - `contributeDiagnostics(map, sceneCtx)` is a PURE read of that stash.
//
// Φ_B superposes over all scene fields (flux is linear in B, so
// Σ_fields ∫B_i·dA = ∫(ΣB_i)·dA); a non-magnetic field contributes 0.
//
// Diagnostics-only by contract (energy.js header): nothing here touches
// `total` or `drift_pct`. The validation-grade centered-O(dt²) EMF lives
// in `runInductionCheck`; this live readout uses a one-step backward
// difference — the natural choice for a streaming per-tick sampler.

/**
 * motionalEmf(loop, bodies, fields) → number (volts).
 *
 * The MOTIONAL term of Faraday's law for a loop whose `moving_segment` (the
 * bar) sweeps area: EMF_motional = ∮(v×B)·dl = (v×B)·L_vec, where
 *
 *   L_vec = bar_length · (n̂ × direction)
 *
 * is the bar's length vector along the loop's POSITIVE circulation (RHR with
 * the loop normal n̂) at the +direction edge, and `bar_length` is the loop side
 * perpendicular to the motion (height when direction ∥ axis_u, else width).
 * Summed over magnetic fields, B sampled at the bar's position.
 *
 * Instantaneous — it reads the bar's VELOCITY, not its (pinned) position, so a
 * constant-v bar gives a constant motional EMF. This is the term the live
 * producer omitted (it finite-differenced only the geometric flux, which is
 * constant for a static-snapshot bar). The validation-grade −B·L·v lives in the
 * scene test's two-snapshot construction; this gives the same value live.
 *
 * Returns 0 for a loop with no moving_segment / a non-rectangle loop / a
 * missing bar / a missing field. Pure — no mutation. See
 * docs/physics_briefs/sim_motional_emf_producer_brief.md.
 *
 * @param {Object} loop   — induction_loop entry (needs normal, axis_u, width/height, moving_segment).
 * @param {Array}  bodies — live engine bodies (for the bar's velocity + position).
 * @param {Map}    fields — scene fields (Map of instances exposing B_at).
 * @returns {number} motional EMF in volts (0 when not applicable).
 */
/**
 * loopBarLvec(loop) → {x,y,z} | null — the bar's length vector along the loop's
 * POSITIVE circulation (RHR with the loop normal n̂):
 *
 *   L_vec = bar_length · (n̂ × direction)
 *
 * where `bar_length` is the loop side perpendicular to the motion (height when
 * the motion direction ∥ axis_u, else width). Pure geometry — no bodies, no
 * fields. Returns null when the loop has no moving_segment, is not a rectangle,
 * is missing normal/axis_u/direction, or the resolved bar length is ≤ 0.
 *
 * Extracted (T5 Phase 0) so BOTH `motionalEmf` (EMF source) and the rail-brake
 * coupling α = −(d̂ × B)·L_vec (rail_loop_validation) read ONE definition of the
 * loop geometry. Golden-identical to the pre-extraction inline computation that
 * lived in `motionalEmf` — the existing motional-EMF tests are the regression net.
 *
 * @param {Object} loop — induction_loop entry (needs normal, axis_u, width/height, moving_segment).
 * @returns {{x:number,y:number,z:number}|null}
 */
export function loopBarLvec(loop) {
  const seg = loop?.moving_segment;
  if (!seg || loop.shape !== 'rectangle') return null;
  const dir = seg.direction;
  const n = loop.normal;
  const a = loop.axis_u;
  if (!dir || !n || !a) return null;
  // bar_length = the loop side perpendicular to the motion direction.
  const dotAU = Math.abs(dir.x * a.x + dir.y * a.y + (dir.z ?? 0) * (a.z ?? 0));
  const barLen = dotAU > 0.5 ? loop.height : loop.width;
  if (!(barLen > 0)) return null;
  // L_vec = bar_length · (n̂ × direction): positive-circulation dl at the bar.
  const ldir = vec3.cross(n, dir);
  return { x: barLen * ldir.x, y: barLen * ldir.y, z: barLen * ldir.z };
}

export function motionalEmf(loop, bodies, fields) {
  const seg = loop?.moving_segment;
  if (!seg || loop.shape !== 'rectangle') return 0;
  const bar = bodies?.find?.((b) => b.id === seg.body_id);
  if (!bar || !bar.velocity || !bar.position) return 0;
  const Lvec = loopBarLvec(loop);
  if (!Lvec) return 0;
  const v = { x: bar.velocity.x ?? 0, y: bar.velocity.y ?? 0, z: bar.velocity.z ?? 0 };
  const p = { x: bar.position.x ?? 0, y: bar.position.y ?? 0, z: bar.position.z ?? 0 };
  let emf = 0;
  if (fields) {
    for (const field of fields.values()) {
      if (typeof field.B_at !== 'function') continue;
      const B = field.B_at(p);
      const vxB = vec3.cross(v, B);
      emf += vxB.x * Lvec.x + vxB.y * Lvec.y + vxB.z * Lvec.z;
    }
  }
  return emf;
}

/**
 * Per-tick flux sampler (SimRunner._advanceOne step 3, S3 invariant). For
 * each induction loop, compute Φ_B(t) summed over all scene fields and
 * advance the one-step history on `sceneCtx.inductionFluxState` — a Map
 * loop_id → { flux, flux_prev, dt, has_prev }. The first call on a fresh
 * stash records flux with has_prev=false (no derivative yet); every later
 * call shifts the prior flux into flux_prev.
 *
 * @param {Object} sceneCtx — carries `induction_loops`, `fields` (Map of
 *                            field instances), and the mutable
 *                            `inductionFluxState` Map.
 * @param {number} t  — post-step time (seconds); passed to computeLoopFlux.
 * @param {number} dt — tick step (seconds), stored for the dΦ/dt quotient.
 */
export function sampleLoopFluxes(sceneCtx, t, dt) {
  const loops = sceneCtx?.induction_loops;
  if (!Array.isArray(loops) || loops.length === 0) return;
  const state = sceneCtx.inductionFluxState;
  if (!state) return;
  const fields = sceneCtx.fields;
  for (const loop of loops) {
    let phi = 0;
    if (fields) {
      for (const field of fields.values()) {
        // Superpose over all fields. Skip one with no magnetic surface so
        // a stray electric-only field can't crash a live tick on a missing
        // B_at (computeLoopFlux would otherwise throw).
        if (typeof field.B_at !== 'function') continue;
        phi += computeLoopFlux(loop, field, t);
      }
    }
    // Motional term (∮(v×B)·dl) — instantaneous, velocity-based; 0 for a loop
    // with no moving_segment. Stashed so contributeDiagnostics can add it to
    // the history-based (∂B/∂t) term without needing bodies/fields itself.
    const motional = motionalEmf(loop, sceneCtx.bodies, fields);
    const prev = state.get(loop.id);
    state.set(loop.id, {
      flux: phi,
      flux_prev: prev ? prev.flux : null,
      dt,
      has_prev: !!prev,
      motional_emf: motional
    });
  }
}

/**
 * Pure read of the flux stash populated by `sampleLoopFluxes`. Emits, per
 * loop:
 *
 *   flux_B_<loop_id>   — latest geometric Φ_B (Weber)
 *   emf_<loop_id>      — total Faraday EMF = transformer + motional term
 *   dphi_dt_<loop_id>  — geometric flux rate (Φ − Φ_prev)/dt — TRANSFORMER
 *                        loops only (see below)
 *
 * EMF = (transformer) −∂Φ_geometric/∂t  +  (motional) ∮(v×B)·dl. The
 * transformer term is the history-based backward difference (needs a prior
 * sample); the motional term is velocity-based and available from the FIRST
 * sampled tick. So a moving_segment loop emits `emf` from tick 1; a
 * transformer-only loop emits it from tick 2.
 *
 * `dphi_dt` is emitted ONLY for a transformer-only loop (no motional term),
 * where it equals the geometric flux rate AND is consistent with the `flux_B`
 * history. For a moving_segment loop the geometric flux is static (the declared
 * boundary is not grown) while the EMF is motional, so a `dphi_dt` readout
 * would contradict the constant `flux_B` in the inspector — it is suppressed,
 * and `emf` carries the physics. Never mutates engine state; diagnostics-only.
 *
 * @param {Object} map      — diagnostic-keyed map (mutated in place)
 * @param {Object} sceneCtx — reads `inductionFluxState`.
 */
export function contributeDiagnostics(map, sceneCtx) {
  const state = sceneCtx?.inductionFluxState;
  if (!state || state.size === 0) return;
  for (const [id, entry] of state) {
    map[`flux_B_${id}`] = entry.flux;
    const motional = entry.motional_emf ?? 0;
    const hasHistory = entry.has_prev && entry.dt > 0 && Number.isFinite(entry.flux_prev);
    if (hasHistory || motional !== 0) {
      const emfField = hasHistory ? -(entry.flux - entry.flux_prev) / entry.dt : 0;
      const emf = emfField + motional;
      // Normalize the IEEE-754 −0 that −(+0) yields to +0, so the inspector
      // never renders a meaningless "−0.0000 V".
      map[`emf_${id}`] = emf === 0 ? 0 : emf;
      // dΦ/dt only for the transformer-only case — there it equals the
      // geometric rate and stays consistent with flux_B. Suppressed when a
      // motional term is present (constant flux_B would otherwise be paired
      // with a nonzero rate). For a transformer-only loop emf === −dphi_dt.
      if (motional === 0 && hasHistory) {
        const dphi = (entry.flux - entry.flux_prev) / entry.dt;
        map[`dphi_dt_${id}`] = dphi === 0 ? 0 : dphi;
      }
    }
  }
}

export const NAME = 'induction';
