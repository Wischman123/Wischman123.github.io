// engine/rail_induction.js
//
// T5 — coupled induction rod-on-rails magnetic brake (Option B).
//
// The loop current I of a rail-brake loop is a TRUE first-order integrator
// state (one auxiliary ODE slot), integrated by the SAME RK4 as the bar — NOT
// an MNA-solver state. This module owns the SINGLE definition of the governing
// current law so `scene.js` derivState calls it rather than re-inlining the
// formula (§1):
//
//   dI/dt = (EMF − R·I) / L,   EMF = motionalEmf(loop) = −α·v   (α ≡ B·L_bar)
//   ⇒ d/dt[½m v² + ½L I²] = −R I²   (energy closes exactly; brief §3)
//
// Phase 1 ships `railLoopDeriv` (the dI/dt law). Phase 2 adds the
// `RailInductionForce` (the F = I·(L_vec × B) brake force + diagnostics) to this
// same file.
//
// EMF source: `motionalEmf(loop, bodies, fields)` (induction.js) sums the
// (v×B)·L_vec motional term over all scene fields. The Phase-0 validator
// (rail_loop_validation check (e)) guarantees EXACTLY ONE resolvable magnetic
// field per rail loop, so that sum is precisely the ONE B the brake force reads
// via its field_id — i.e. the field_id-threading the plan calls for is enforced
// by the single-field invariant, not re-implemented here. Using the geometric
// MOTIONAL term (velocity-based, no growing-area flux quotient) is correct for
// the ODE: it IS −α·v with no double-count (the growing-area concern is a
// Phase-2 DIAGNOSTIC-channel issue, not a dynamics one).

import { motionalEmf, loopBarLvec } from './induction.js';
import { Force } from './forces.js';
import { vec3 } from './vec.js';

/**
 * railLoopDeriv(loop, bodies, fields, I) → dI/dt (amperes/second).
 *
 * Pure. Reads the bar's live velocity (via motionalEmf → bodies) and the loop's
 * R_ohm / L_henry (from loop.rl_branch); the caller passes the CURRENT RK4
 * sub-stage's loop current I so the four sub-stages each see a consistent I.
 *
 * @param {Object} loop   — induction_loop carrying an `rl_branch` block.
 * @param {Array}  bodies — live engine bodies (the moving bar's velocity).
 * @param {Map}    fields — scene fields (Map of instances exposing B_at).
 * @param {number} I      — loop current at this sub-stage (amperes).
 * @returns {number} dI/dt in A/s.
 */
export function railLoopDeriv(loop, bodies, fields, I) {
  const rl = loop.rl_branch;
  const emf = motionalEmf(loop, bodies, fields);
  return (emf - rl.R_ohm * I) / rl.L_henry;
}

/**
 * RailInductionForce — the coupled rail-brake force on the moving conductor.
 *
 *   F = I · (L_vec × B)            (brake force along the motion; α ≡ B·L_bar)
 *   U_inductor_<loop.id> = ½·L·I²  (recoverable inductor energy store)
 *   powerDissipated = −R·I²        (SIGNED — see the method comment)
 *   diagnostic: i_loop_<loop.id>   (the canonical loop current)
 *
 * The single source of the loop current I is `sceneCtx.railLoops[loop_id].I`
 * (Phase 1): during a step it is the CURRENT RK4 sub-stage's I (unpacked at
 * derivState entry); post-step it is the integrated I_{n+1} (re-synced in
 * syncBodies). The force never reads a derivState scratch copy.
 */
export class RailInductionForce extends Force {
  constructor({ applies_to, loop_id, field_id }) {
    super();
    this.applies_to = applies_to;
    this.loop_id = loop_id;
    this.field_id = field_id;
    // Per-loop-suffixed energy key so two coupled loops each get a DISTINCT
    // ½·L·I² budget entry. A bare 'U_inductor' would collide in energy.js
    // (last-writer-wins drops one loop's store); the Phase-0 validator asserts
    // unique rail-loop ids so the suffixed keys cannot clash.
    this.energyKey = `U_inductor_${loop_id}`;
  }

  _loop(sceneCtx) {
    return (sceneCtx.induction_loops ?? []).find((l) => l && l.id === this.loop_id);
  }

  _current(sceneCtx) {
    return sceneCtx.railLoops?.[this.loop_id]?.I ?? 0;
  }

  // F = I·(L_vec × B). L_vec is in-plane and (rail scenes) B is along ẑ, so the
  // cross product stays in-plane (F_z = 0). For the canonical x̂-motion / ẑ-field
  // geometry this is F = α·I x̂ (α = B·L_bar) — the brake along the motion
  // (F·v < 0 while the loop current opposes the motion-induced EMF).
  applyTo(body, sceneCtx = {}) {
    const loop = this._loop(sceneCtx);
    const field = sceneCtx.fields?.get?.(this.field_id);
    if (!loop || !field) return { F: vec3.zero(), tau: vec3.zero() };
    const Lvec = loopBarLvec(loop);
    if (!Lvec) return { F: vec3.zero(), tau: vec3.zero() };
    const I = this._current(sceneCtx);
    const B = field.B_at(body.position);
    const LxB = vec3.cross(Lvec, B);
    return { F: { x: I * LxB.x, y: I * LxB.y }, tau: vec3.zero() };
  }

  // Inductor energy store ½·L·I² — a recoverable potential keyed
  // U_inductor_<loop.id>. Non-monotonic over a run (rises to ½·L·I_peak² then
  // falls back to 0), which is fine: ConservationTracker sums it as a normal
  // contribution.
  potentialEnergy(body, sceneCtx = {}) {
    const loop = this._loop(sceneCtx);
    if (!loop) return 0;
    const I = this._current(sceneCtx);
    return 0.5 * loop.rl_branch.L_henry * I * I;
  }

  // Resistive dissipation. Returns the SIGNED −R·I² because
  // ConservationTracker.step does `_dissipated += −P·dt`, so a NEGATIVE return
  // GROWS U_thermal by +R·I²·dt (the convention Drag/Friction follow with their
  // F·v < 0 returns). A +R·I² return would drive U_thermal negative and break
  // the K + U_inductor + U_thermal closure → the drift-budget gate would fail.
  powerDissipated(body, sceneCtx = {}) {
    const loop = this._loop(sceneCtx);
    if (!loop) return 0;
    const I = this._current(sceneCtx);
    return -loop.rl_branch.R_ohm * I * I;
  }

  // Emit ONLY the loop-id-suffixed current channel. emf_<loop.id> and
  // flux_B_<loop.id> are owned by the EXISTING induction producer (induction.js
  // contributeDiagnostics, carrying the motional term −α·v); the rail force MUST
  // NOT self-emit emf, or two emitters would write the same channel
  // (last-writer-wins divergence). Single owner per channel: induction producer
  // → emf/flux_B; rail force → i_loop. i_loop is the canonical post-step I.
  contributeDiagnostics(map, sceneCtx) {
    map[`i_loop_${this.loop_id}`] = this._current(sceneCtx);
  }
}

export const NAME = 'rail_induction';
