// engine/position_poke.js
//
// T8 live position-poke seam (plan sim_interactivity_viz, decision D1
// forward-pulled feasibility spike).
//
// Applies a {body_id, position_m, velocity_m_per_s?} delta to a RUNNING
// engine state IN PLACE — no scene rebuild, no revalidation, no t reset,
// no buffer clear. This is the lightweight live counterpart to
// ui/inspector_edits.mergeEditsIntoScene + main.doReset, which deep-clone
// the scene JSON, re-run loadScene + new SimRunner, and thereby re-zero t
// and wipe circuit/induction/motion-graph buffers on EVERY call — fatal
// for a ~60 Hz pointer drag (plan §0). The renderer stays read-only; this
// is a UI→engine command, the seam the drag (T8) and the draggable rod
// (T9) route through.
//
// Library-layer, body-type-agnostic. It mutates the body's documented
// `.position` / `.velocity` fields and repacks via `loaded.writebackState`
// — the same packState/unpackState contract every body type already
// honors (scene.js) — so it works for Particle, Charge, MagneticDipole,
// RotatingDipole, … without knowing any per-body state-vector layout.
// writebackState is an exact identity for the un-poked bodies (they
// already match the live state from the prior tick's syncBodies), so only
// the poked body changes in the state vector.
//
// Contract:
//   applyPositionPoke(loaded, state, poke)
//     -> { ok: true,  body_id }        on success
//     -> { ok: false, reason }         on rejection
//   poke = { body_id, position_m: {x, y}, velocity_m_per_s?: {x, y} }
//
//   reasons: 'missing_body_id' | 'unknown_body' | 'missing_position'
//          | 'invalid_position' | 'invalid_velocity'
//
// Validation is ATOMIC: the body is mutated only after BOTH position and
// (when present) velocity pass the finite check, so a bad velocity never
// leaves a half-applied position. A non-finite value is rejected because
// it would poison the integrator with NaN/Inf and leave the engine
// unsolvable. Scene-level drop policy — off-canvas bounds, body overlap,
// netlist rewiring — is deliberately NOT this primitive's job; it is a
// T8 decision that belongs in the pointer→edit adapter that calls this
// seam (plan T8: "validate+reject vs accept a broken scene").
//
// What this seam deliberately does NOT do — the invariants the spike's
// test pins: it never receives the runner, so it cannot touch `t` or the
// play state; it never clears a buffer. The runner-level command
// SimRunner.pokeBody wraps this and additionally invalidates the Verlet
// history (statePrev) so a teleport re-bootstraps cleanly.

function isFiniteVec(v) {
  return v != null && Number.isFinite(v.x) && Number.isFinite(v.y);
}

export function applyPositionPoke(loaded, state, poke) {
  if (!poke || poke.body_id == null) {
    return { ok: false, reason: 'missing_body_id' };
  }
  const body = loaded.bodies.find((b) => b.id === poke.body_id);
  if (!body) {
    return { ok: false, reason: 'unknown_body' };
  }
  if (poke.position_m == null) {
    return { ok: false, reason: 'missing_position' };
  }
  if (!isFiniteVec(poke.position_m)) {
    return { ok: false, reason: 'invalid_position' };
  }
  const hasVelocity = poke.velocity_m_per_s != null;
  if (hasVelocity && !isFiniteVec(poke.velocity_m_per_s)) {
    return { ok: false, reason: 'invalid_velocity' };
  }

  // Validation passed — mutate atomically, then repack into the live
  // state vector so the next integrator tick reads the poked values.
  // (Reassigning a fresh {x, y} mirrors how unpackState sets these.)
  body.position = { x: poke.position_m.x, y: poke.position_m.y };
  if (hasVelocity) {
    body.velocity = { x: poke.velocity_m_per_s.x, y: poke.velocity_m_per_s.y };
  }
  loaded.writebackState(state);
  return { ok: true, body_id: poke.body_id };
}

export const NAME = 'position_poke';
