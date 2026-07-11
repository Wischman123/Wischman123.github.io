// validation/rail_loop_validation.js
//
// T5 Phase 0 — coupled induction rail-brake (`rl_branch`) validator.
//
// Why this lives outside `induction_loop_validation.js`: that validator
// checks the GEOMETRY of a flux loop (well-formed, unit normal, planarity,
// moving-segment documented). THIS validator checks the COUPLED-ODE physics
// constraints a loop acquires when it carries an `rl_branch` sub-block and
// becomes a TRUE first-order integrator state (its loop current I). Those
// constraints — rk4-only, eigenvalue stiffness, loop↔force pairing, a single
// resolvable B, gravity-off, supported initial_current — are a distinct
// concern from loop geometry, so a separate file keeps the distinction visible
// (same file-level-distinction rationale induction_loop_validation cites for
// splitting Faraday loops from Gauss surfaces).
//
// VALIDATOR-FIRST (project rule): this file lands BEFORE the RailInductionForce
// constructor (Phase 2) and the aux-state machinery (Phase 1). It is wired into
// `loadScene` BEFORE the FORCE_CTORS loop so a deliberately-broken rail fixture
// aborts load with a precise message FROM THIS VALIDATOR — not the later
// "unknown force constructor" error (the rejection test must pass for the RIGHT
// reason). See plan §"Load-path ordering invariant".
//
// Issue shape (matches induction_loop_validation / em_validation):
//   { level: 'error' | 'warn', check: <name>, message: <string>, context?: {} }

import { vec3 } from '../engine/vec.js';
import { loopBarLvec } from '../engine/induction.js';
import { buildField } from '../engine/fields.js';

// RK4 stable-region guard on the coupled-system |λ_max|·dt. Below ~0.1 the
// classic RK4 step is well inside its absolute-stability region for this 3-state
// linear system; above it the integration can amplify. Plan §Phase 0 check (b).
export const RAIL_STIFF_LAMBDA_DT_MAX = 0.1;

// ---------- shared selectors ----------

function _railLoops(scene) {
  const loops = Array.isArray(scene?.induction_loops) ? scene.induction_loops : [];
  return loops.filter((l) => l && typeof l === 'object' && l.rl_branch && typeof l.rl_branch === 'object');
}

function _railForces(scene) {
  const forces = Array.isArray(scene?.forces) ? scene.forces : [];
  return forces.filter((f) => f && f.type === 'rail_induction');
}

function _bodiesById(scene) {
  const map = new Map();
  for (const b of scene?.bodies ?? []) if (b && b.id != null) map.set(b.id, b);
  return map;
}

// Build every scene field instance once, tolerating a malformed field (a bad
// field is its OWN validation concern — here it simply does not count as a
// resolvable magnetic source). Returns Map(id → instance | null).
function _fieldInstances(scene) {
  const map = new Map();
  for (const fj of scene?.fields ?? []) {
    if (!fj || fj.id == null) continue;
    try {
      map.set(fj.id, buildField(fj));
    } catch {
      map.set(fj.id, null);
    }
  }
  return map;
}

function _isMagnetic(inst) {
  return !!inst && typeof inst.B_at === 'function';
}

// Body mass / position from RAW scene json (`mass_kg` / `position_m`), with a
// fallback to the loaded-Body field names (`mass` / `position`) so the validator
// is robust whether handed raw json (both production call sites) or a body-like
// object. Position is normalized to a finite vec3 for B_at sampling.
function _barMass(bar) {
  const m = bar?.mass_kg ?? bar?.mass;
  return typeof m === 'number' ? m : NaN;
}
function _barPos(bar) {
  const p = bar?.position_m ?? bar?.position ?? {};
  return { x: p.x ?? 0, y: p.y ?? 0, z: p.z ?? 0 };
}

/**
 * railCoupling(loop, fieldInstance, barPos) → number | null
 *
 * The scalar coupling α such that the motional EMF = −α·v and the brake force
 * F = α·I (along the motion). Derived from EMF = (v×B)·L_vec with v = v·d̂:
 *
 *   EMF = v·(d̂ × B)·L_vec  ⇒  α = −(d̂ × B)·L_vec
 *
 * For the canonical d̂=x̂, B=Bẑ, L_vec=barLen·ŷ this reduces to α = B·barLen,
 * i.e. α = B·L_bar (plan §1). Returns null when the geometry/field is
 * unresolvable (a sibling check reports that as the real error).
 *
 * @param {Object} loop          — induction_loop with moving_segment
 * @param {Object} fieldInstance — a built field exposing B_at(point)
 * @param {{x,y,z}} barPos       — bar position to sample B at (initial position)
 * @returns {number|null}
 */
export function railCoupling(loop, fieldInstance, barPos) {
  const Lvec = loopBarLvec(loop);
  if (!Lvec || !_isMagnetic(fieldInstance)) return null;
  const dir = loop?.moving_segment?.direction;
  if (!dir) return null;
  const dmag = vec3.norm({ x: dir.x ?? 0, y: dir.y ?? 0, z: dir.z ?? 0 });
  if (!(dmag > 0)) return null;
  const dhat = { x: (dir.x ?? 0) / dmag, y: (dir.y ?? 0) / dmag, z: (dir.z ?? 0) / dmag };
  const B = fieldInstance.B_at(barPos ?? { x: 0, y: 0, z: 0 });
  const dxB = vec3.cross(dhat, B);
  return -(dxB.x * Lvec.x + dxB.y * Lvec.y + dxB.z * Lvec.z);
}

/**
 * railEigenStiffness(alpha, m, L, R, dt) → { D, lambdaMax, ok }
 *
 * Coupled-system eigenvalues of A = [[0, α/m], [−α/L, −R/L]]:
 *   trace = −R/L, det = α²/(mL), D = trace² − 4·det.
 *   D ≥ 0 (over/critically damped, real roots): λ = (trace ± √D)/2,
 *          lambdaMax = max(|λ₁|, |λ₂|).
 *   D < 0 (UNDERDAMPED, complex conjugates): both share |λ| = √det = |α|/√(mL).
 * Taking a real-only √D for D<0 would go NaN and silently pass a stiff
 * underdamped scene — the exact class the original L=2.0 mistake fell in. So we
 * branch on the discriminant sign and ALWAYS return a finite lambdaMax.
 */
export function railEigenStiffness(alpha, m, L, R, dt) {
  const trace = -R / L;
  const det = (alpha * alpha) / (m * L);
  const D = trace * trace - 4 * det;
  let lambdaMax;
  if (D >= 0) {
    const s = Math.sqrt(D);
    lambdaMax = Math.max(Math.abs((trace + s) / 2), Math.abs((trace - s) / 2));
  } else {
    lambdaMax = Math.sqrt(det); // |λ| of the complex-conjugate pair
  }
  return { D, lambdaMax, ok: Number.isFinite(lambdaMax) && lambdaMax * dt < RAIL_STIFF_LAMBDA_DT_MAX };
}

// ---------- checks ----------

// (a) rail_requires_rk4: a lone first-order state I is integrated correctly only
// by the stride-agnostic RK4. siEuler/verlet treat each stride as a SECOND-order
// x/v pair (v_new = v + a·dt; x_new = x + v_new·dt) — meaningless for a current
// with no paired position. The real boundary is first-order vs second-order
// state, so aux state is rk4-only until the integrator contract gains a
// first-order-state concept.
export function rail_requires_rk4(scene) {
  const issues = [];
  if (_railLoops(scene).length === 0) return issues;
  const integ = scene?.simulation?.integrator;
  if (integ !== 'rk4') {
    issues.push({
      level: 'error',
      message: `scene declares an induction loop with an rl_branch (coupled-ODE rail brake) but simulation.integrator is "${integ}", not "rk4". A lone first-order state (loop current I) has no paired position, so siEuler/verlet would integrate it as a second-order x/v pair and produce silently-wrong dynamics. Set integrator:"rk4".`,
      context: { integrator: integ }
    });
  }
  return issues;
}

// (d) rail_loop_force_pairing: bidirectional — every rail_induction force's
// loop_id points to an rl_branch loop, AND every rl_branch loop has a matching
// force. A branch-loop with no force still allocates an aux slot and integrates a
// current that produces no braking force (energy not closing); a force with no
// branch-loop has no I to read. ALSO asserts rail-loop ids are unique so the
// per-loop energy key U_inductor_<loop.id> cannot collide (last-writer-wins in
// energy.js would silently drop one loop's ½LI² store).
export function rail_loop_force_pairing(scene) {
  const issues = [];
  const railLoops = _railLoops(scene);
  const railForces = _railForces(scene);
  if (railLoops.length === 0 && railForces.length === 0) return issues;

  const loopIds = railLoops.map((l) => l.id);
  const seen = new Set();
  for (const id of loopIds) {
    if (seen.has(id)) {
      issues.push({
        level: 'error',
        message: `duplicate rl_branch loop id "${id}" — the per-loop energy key U_inductor_${id} would collide (last-writer-wins drops one loop's ½LI² store). Give each rail loop a unique id.`,
        context: { loop_id: id }
      });
    }
    seen.add(id);
  }
  const loopIdSet = new Set(loopIds);

  for (const f of railForces) {
    if (typeof f.loop_id !== 'string' || !loopIdSet.has(f.loop_id)) {
      issues.push({
        level: 'error',
        message: `rail_induction force (applies_to ${JSON.stringify(f.applies_to)}) has loop_id "${f.loop_id}" which is not an induction loop carrying an rl_branch block. Every rail_induction force must point to an rl_branch loop.`,
        context: { loop_id: f.loop_id }
      });
    }
  }
  const forceLoopIds = new Set(railForces.map((f) => f.loop_id));
  for (const id of loopIds) {
    if (!forceLoopIds.has(id)) {
      issues.push({
        level: 'error',
        message: `rl_branch loop "${id}" has no matching rail_induction force. A branch-loop with no force allocates an aux current slot that exerts no braking force — energy would not close. Add a rail_induction force with loop_id:"${id}".`,
        context: { loop_id: id }
      });
    }
  }
  return issues;
}

// (e) rail_single_field: the EMF source (motionalEmf) sums over ALL scene fields
// while the brake force reads ONE field_id; with ≥2 resolvable magnetic fields
// they would see different B and the single-α energy proof breaks. Assert
// EXACTLY ONE resolvable magnetic field in the scene AND that each rail force's
// field_id resolves to it.
export function rail_single_field(scene) {
  const issues = [];
  const railForces = _railForces(scene);
  if (railForces.length === 0) return issues;
  const fieldMap = _fieldInstances(scene);
  const magneticIds = [...fieldMap.entries()].filter(([, inst]) => _isMagnetic(inst)).map(([id]) => id);

  if (magneticIds.length !== 1) {
    issues.push({
      level: 'error',
      message: `rail-brake scene must declare EXACTLY ONE resolvable magnetic field (found ${magneticIds.length}: ${JSON.stringify(magneticIds)}). The motional EMF sums over all fields but the brake force reads one field_id; with ${magneticIds.length === 0 ? 'no' : '≥2'} fields the EMF and force would diverge (or see B=0).`,
      context: { magnetic_field_ids: magneticIds }
    });
  }
  for (const f of railForces) {
    if (typeof f.field_id !== 'string' || !_isMagnetic(fieldMap.get(f.field_id))) {
      issues.push({
        level: 'error',
        message: `rail_induction force loop_id="${f.loop_id}" has field_id "${f.field_id}" which does not resolve to a magnetic field. The brake force and EMF both read this field — it must exist and expose a B.`,
        context: { field_id: f.field_id }
      });
    }
  }
  return issues;
}

// (c) rail_moving_body_coupling: each rl_branch loop must have a moving_segment
// whose body exists and has mass > 0, AND a nonzero coupling α = B·L_bar. A zero
// field or zero-length moving segment allocates an aux slot and integrates a
// current that exerts NO braking force (F = α·I = 0) — silently-wrong dynamics,
// not a load error the other checks catch.
export function rail_moving_body_coupling(scene) {
  const issues = [];
  const railLoops = _railLoops(scene);
  if (railLoops.length === 0) return issues;
  const byId = _bodiesById(scene);
  const fieldMap = _fieldInstances(scene);
  const railForces = _railForces(scene);
  for (const loop of railLoops) {
    const lid = loop.id ?? '<unknown>';
    const seg = loop.moving_segment;
    if (!seg || typeof seg.body_id !== 'string') {
      issues.push({
        level: 'error',
        message: `rl_branch loop "${lid}" has no moving_segment.body_id — a coupled rail brake needs a moving conductor whose velocity drives the EMF.`,
        context: { loop_id: lid }
      });
      continue;
    }
    const bar = byId.get(seg.body_id);
    if (!bar) continue; // induction_loop_moving_segment_documented reports the missing body
    const mass = _barMass(bar);
    if (!(mass > 0)) {
      issues.push({
        level: 'error',
        message: `rl_branch loop "${lid}" moving body "${seg.body_id}" has mass ${mass} (must be > 0): the brake dynamics dv/dt = α·I/m are undefined for a massless bar.`,
        context: { loop_id: lid, body_id: seg.body_id, mass }
      });
      continue;
    }
    // α from the force's field (if pairing resolves); else from the sole field.
    const force = railForces.find((f) => f.loop_id === lid);
    const fieldInst = force && fieldMap.has(force.field_id)
      ? fieldMap.get(force.field_id)
      : [...fieldMap.values()].find(_isMagnetic);
    const alpha = railCoupling(loop, fieldInst, _barPos(bar));
    if (alpha == null || alpha === 0) {
      issues.push({
        level: 'error',
        message: `rl_branch loop "${lid}" has coupling α = ${alpha} (must be nonzero). A zero field or zero-length moving segment integrates a current that exerts no braking force (F = α·I = 0) — silently-wrong dynamics.`,
        context: { loop_id: lid, alpha }
      });
    }
  }
  return issues;
}

// (b) rail_stiffness: coupled-eigenvalue stability guard (NOT the single-ODE L/R
// proxy). Handles BOTH discriminant signs — underdamped (D<0) computes a finite
// |λ|=√det rather than NaN-ing — and rejects |λ_max|·dt ≥ threshold cleanly.
export function rail_stiffness(scene) {
  const issues = [];
  const railLoops = _railLoops(scene);
  if (railLoops.length === 0) return issues;
  const dt = scene?.simulation?.dt_s;
  if (!(typeof dt === 'number' && dt > 0)) return issues; // schema/other check owns dt
  const byId = _bodiesById(scene);
  const fieldMap = _fieldInstances(scene);
  const railForces = _railForces(scene);
  for (const loop of railLoops) {
    const lid = loop.id ?? '<unknown>';
    const rl = loop.rl_branch;
    const R = rl?.R_ohm, L = rl?.L_henry;
    if (!(R > 0 && L > 0)) continue; // schema enforces; skip if malformed
    const bar = byId.get(loop?.moving_segment?.body_id);
    const mass = _barMass(bar);
    if (!bar || !(mass > 0)) continue; // (c) owns this
    const force = railForces.find((f) => f.loop_id === lid);
    const fieldInst = force && fieldMap.has(force.field_id)
      ? fieldMap.get(force.field_id)
      : [...fieldMap.values()].find(_isMagnetic);
    const alpha = railCoupling(loop, fieldInst, _barPos(bar));
    if (alpha == null || alpha === 0) continue; // (c) owns this
    const { D, lambdaMax, ok } = railEigenStiffness(alpha, mass, L, R, dt);
    if (!ok) {
      issues.push({
        level: 'error',
        message: `rl_branch loop "${lid}" is stiff for RK4: coupled |λ_max| = ${lambdaMax.toFixed(4)} (discriminant D = ${D.toFixed(4)}, ${D < 0 ? 'underdamped/complex' : 'real roots'}), so |λ_max|·dt = ${(lambdaMax * dt).toFixed(4)} ≥ ${RAIL_STIFF_LAMBDA_DT_MAX}. Reduce dt, or change R/L/α so the fast eigenvalue is slower.`,
        context: { loop_id: lid, lambdaMax, D, dt, lambda_dt: lambdaMax * dt }
      });
    }
  }
  return issues;
}

// (f) rail_gravity_off: the governing ODE [x, v, I] has no gravity term and the
// rails are decorative (no Surface ⇒ no normal force). With gravity on, the
// loader auto-adds an implicit −y gravity to any uncovered body, pulling the
// unpinned bar off the rail and muddying the Δx / v→0 gate. Require
// scene_defaults.gravity_model:'off' OR an explicit gravity force covering the
// moving bar.
export function rail_gravity_off(scene) {
  const issues = [];
  const railLoops = _railLoops(scene);
  if (railLoops.length === 0) return issues;
  const model = scene?.scene_defaults?.gravity_model;
  if (model === 'off') return issues;
  const explicitGravityBodies = new Set();
  for (const f of scene?.forces ?? []) {
    if (f?.type === 'gravity') for (const id of f.applies_to ?? []) explicitGravityBodies.add(id);
  }
  for (const loop of railLoops) {
    const barId = loop?.moving_segment?.body_id;
    if (barId && !explicitGravityBodies.has(barId)) {
      issues.push({
        level: 'error',
        message: `rail-brake scene has scene_defaults.gravity_model="${model}" and the moving bar "${barId}" is not covered by an explicit gravity force, so the loader adds implicit −y gravity that pulls the unpinned bar off the horizontal rail. Set scene_defaults.gravity_model:"off" (top-down rail view) or add an explicit gravity/support force for "${barId}".`,
        context: { loop_id: loop.id, body_id: barId, gravity_model: model }
      });
    }
  }
  return issues;
}

// (g) rail_initial_current_zero: the schema admits any finite initial_current,
// but only I(0)=0 (un-braked start) has its t=0 energy baseline + v→0 gate
// covered (plan §5 edge case 13). Restrict to 0 until the nonzero-I₀ baseline is
// implemented. This is a scope gate, not a permanent limit.
export function rail_initial_current_zero(scene) {
  const issues = [];
  for (const loop of _railLoops(scene)) {
    const i0 = loop.rl_branch.initial_current;
    if (i0 !== undefined && i0 !== 0) {
      issues.push({
        level: 'error',
        message: `rl_branch loop "${loop.id}" has initial_current=${i0}; only initial_current=0 (un-braked start) is supported. A nonzero I₀ needs the t=0 baseline U_inductor(0)=½LI₀² and a sign-agnostic v→0 gate (plan §5 edge case 13). Set initial_current to 0 or omit it.`,
        context: { loop_id: loop.id, initial_current: i0 }
      });
    }
  }
  return issues;
}

// Aggregator — matches runInductionLoopChecks / runAllChecks shape.
export function runRailLoopChecks(scene) {
  const checks = [
    ['rail_requires_rk4', rail_requires_rk4],
    ['rail_loop_force_pairing', rail_loop_force_pairing],
    ['rail_single_field', rail_single_field],
    ['rail_moving_body_coupling', rail_moving_body_coupling],
    ['rail_stiffness', rail_stiffness],
    ['rail_gravity_off', rail_gravity_off],
    ['rail_initial_current_zero', rail_initial_current_zero]
  ];
  const issues = [];
  for (const [name, fn] of checks) {
    let result;
    try {
      result = fn(scene);
    } catch (err) {
      issues.push({ level: 'error', check: name, message: `check threw: ${err.message}` });
      continue;
    }
    if (!Array.isArray(result)) continue;
    for (const issue of result) issues.push({ ...issue, check: issue.check ?? name });
  }
  const errored = issues.some((i) => i.level === 'error');
  return { ok: !errored, issues };
}

export const NAME = 'rail_loop_validation';
