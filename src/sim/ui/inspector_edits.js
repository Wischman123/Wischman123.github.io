// ui/inspector_edits.js
//
// Pure merge logic for paused-only inspector edits. The orchestrator
// (sim/main.js doReset) calls `mergeEditsIntoScene(scene, edits)` to
// produce a candidate scene JSON that is then re-validated through
// validate_scene_browser.js.
//
// Edits shape returned by inspector.getEdits():
//   {
//     bodies:   [{ body_id,    mass_kg?, position_m?, velocity_m_per_s?,
//                  applied_acceleration_m_per_s2?, charge_C? }, ...],
//     fields:   [{ field_id,   E_V_per_m?, B_T? }, ...],
//     surfaces: [{ surface_id, mu_k? }, ...]
//   }
//
// Surface-friction edits target every `forces[]` entry of type 'friction'
// whose `surface_id` matches; mu_s tracks mu_k iff the original mu_s ===
// the original mu_k (today's "static = kinetic" default in scenes that
// don't distinguish them). When mu_s diverges from mu_k in the scene,
// only mu_k is rewritten — the user can edit mu_s separately in v2.
//
// The function deep-clones via JSON round-trip; the input scene is
// untouched. Returns the merged scene. Unknown ids are silently
// skipped (the inspector should never produce them, but a stale
// edit batch must not crash doReset — re-validation will surface any
// resulting structural issue).

export function mergeEditsIntoScene(scene, edits) {
  const next = JSON.parse(JSON.stringify(scene));
  if (!edits) return next;

  for (const be of edits.bodies ?? []) {
    const body = next.bodies?.find((b) => b.id === be.body_id);
    if (!body) continue;
    if (be.mass_kg !== undefined) body.mass_kg = be.mass_kg;
    if (be.position_m !== undefined) body.position_m = be.position_m;
    if (be.velocity_m_per_s !== undefined) body.velocity_m_per_s = be.velocity_m_per_s;
    if (be.charge_C !== undefined) body.charge_C = be.charge_C;
    // T9 — settable a₀ (the scene builder turns a nonzero value into an
    // AppliedAcceleration force on rebuild). {x:0,y:0} is written through so
    // clearing the control removes the force on the next Reset.
    if (be.applied_acceleration_m_per_s2 !== undefined) {
      body.applied_acceleration_m_per_s2 = be.applied_acceleration_m_per_s2;
    }
  }

  for (const fe of edits.fields ?? []) {
    const field = next.fields?.find((f) => f.id === fe.field_id);
    if (!field) continue;
    if (fe.E_V_per_m !== undefined) field.E_V_per_m = fe.E_V_per_m;
    if (fe.B_T !== undefined) field.B_T = fe.B_T;
  }

  for (const se of edits.surfaces ?? []) {
    if (se.mu_k === undefined) continue;
    for (const force of next.forces ?? []) {
      if (force.type !== 'friction') continue;
      if (force.surface_id !== se.surface_id) continue;
      const trackStatic = force.mu_s === force.mu_k;
      force.mu_k = se.mu_k;
      if (trackStatic) force.mu_s = se.mu_k;
    }
  }

  return next;
}

export const NAME = 'inspector_edits';
