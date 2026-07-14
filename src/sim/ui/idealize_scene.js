// ui/idealize_scene.js
//
// sim_trace_ghost P3 — the idealized-baseline scene transform.
//
// idealizeScene(sceneJson) returns a DEEP COPY of the scene with every
// mechanical dissipation channel zeroed, so a run of the returned scene
// generates zero U_thermal. It is the "compare against the idealized
// baseline" action's parameter transform: friction, drag, and rolling
// contact are removed; gravity, springs, and other conservative forces are
// left intact. Pure + DOM-free + unit-testable — no engine, no runner.
//
// WHY a transform (not a new scene file): the baseline is a RUNTIME parameter
// change of an already-validated scene, routed through the SAME validateScene
// boundary as inspector edits. No new scene surface, no Physics Design Brief.
//
// ── Force-type classification (UPDATE-SITE COUPLING) ──────────────────────
// Every value in sim/scene.schema.json's $defs.force `type` enum (the
// reciprocal end of this coupling carries a back-reference note beside that
// enum) MUST be classified below into exactly ONE of two sets:
//   DISSIPATIVE_FORCE_TYPES     — zeroed here (they feed U_thermal)
//   NON_DISSIPATIVE_FORCE_TYPES — left intact (conservative, or out of scope
//                                 for the mechanical friction/drag baseline)
// A force whose type is in NEITHER set makes idealizeScene FAIL LOUD (throws).
// This is deliberate: a future dissipative force type added to the schema enum
// WITHOUT classifying it here would otherwise pass through untouched and yield
// an "idealized" run that STILL produces U_thermal — a silent honesty failure
// the effect gate only catches for the three enumerated scenes. The throw makes
// that a loud stop the first time such a scene is idealized; and idealize_scene
// .test.js asserts (at TEST time, schema_browser_lockstep-style) that the union
// of the two sets covers the whole enum, so the drift is caught even before any
// scene exercises the new type. Keep this a discoverable single update site —
// not only a dormant runtime tripwire.
//
// DEVIATIONS from the plan's literal enumeration, forced by the schema/engine
// (documented so a reader is not surprised):
//   1. Forces live at the SCENE ROOT (`sceneJson.forces`), each with its own
//      `applies_to` — NOT `body.forces`. The three real scenes and the schema
//      ($defs.body has additionalProperties:false, no `forces`) confirm this,
//      and the effect gate runs the transform over the real scenes, so the walk
//      MUST target `sceneJson.forces` or it would be a no-op. A defensive
//      `body.forces ?? []` walk is kept for a future per-body-forces schema.
//   2. A drag force's magnitude lives in `b` (linear model) AND `c` (quadratic
//      model); the quadratic scene uses `c`, so BOTH are zeroed regardless of
//      `model` (zeroing only `b` would leave the quadratic scene dissipating).
//   3. `rolling_contact.slip_penalty_c` is LEFT NON-ZERO: the schema pins it
//      exclusiveMinimum 0 (and the browser validator rejects 0), so zeroing it
//      would fail validateScene — and it is inert once mu_k = mu_s = 0 (see the
//      rolling_contact branch below), so U_thermal still reaches 0 without it.

// Mechanical dissipation forces — zeroed by the transform.
export const DISSIPATIVE_FORCE_TYPES = new Set(['drag', 'friction', 'rolling_contact']);

// Every OTHER current sim/scene.schema.json force `type` — conservative
// (gravity/spring/tension/coulomb) or out of scope for the mechanical
// friction/drag baseline (the EM force classes). Left intact by the transform.
// UPDATE-SITE COUPLING: adding a force type to the schema enum requires adding
// it to exactly one of these two sets.
export const NON_DISSIPATIVE_FORCE_TYPES = new Set([
  'gravity',
  'spring',
  'tension',
  'lorentz',
  'coulomb',
  'dipole_in_field',
  'current_in_field',
  'time_varying',
  'contact',
  'body_spring',
  'rail_induction',
  'buoyancy'
]);

// The ghost label the baseline action stamps on the frozen idealized run.
// Descriptive (states the parameters zeroed), not evaluative — anti-Kohn.
export const IDEALIZED_GHOST_LABEL = 'idealized (f = 0, drag = 0)';

// Zero every dissipative field of a single force IN PLACE. Known-conservative
// types are a no-op; an UNCLASSIFIED type throws (fail-loud, see header).
function zeroDissipativeForce(force) {
  if (!force || typeof force !== 'object') return;
  const type = force.type;
  if (DISSIPATIVE_FORCE_TYPES.has(type)) {
    if (type === 'drag') {
      // Drag magnitude: b (linear model) and c (quadratic model). Zero BOTH so
      // either drag form is fully removed regardless of `model`.
      if ('b' in force) force.b = 0;
      if ('c' in force) force.c = 0;
    } else if (type === 'friction') {
      force.mu_k = 0;
      force.mu_s = 0;
    } else if (type === 'rolling_contact') {
      // Zeroing mu_k AND mu_s drives RollingContact.Ft to 0 for ALL slip states
      // (sim/engine/forces.js: the static branch needs |c·σ| ≤ mu_s·N = 0 ⇒
      // σ = 0 ⇒ Ft = 0; otherwise the kinetic branch gives Ft = −mu_k·N·… = 0),
      // so the rolling penalty stops producing heat. slip_penalty_c is left
      // NON-ZERO on purpose (schema exclusiveMinimum 0; inert once Ft = 0).
      force.mu_k = 0;
      force.mu_s = 0;
    }
    return;
  }
  if (NON_DISSIPATIVE_FORCE_TYPES.has(type)) return; // conservative / out of scope
  throw new Error(
    `idealizeScene: force type "${type}" is classified as NEITHER known-dissipative ` +
    `nor known-conservative. Classify it in sim/ui/idealize_scene.js (and note it at ` +
    `the force type enum in sim/scene.schema.json) before idealizing a scene that uses ` +
    `it — an unclassified type could silently leave U_thermal non-zero in an ` +
    `"idealized" run.`
  );
}

// Transform an already-validated scene into its idealized (dissipation-free)
// twin. Returns a fresh deep copy; the input is untouched. scene.id is
// PRESERVED (structuredClone keeps it) — load-bearing so the baseline's reload
// does not trip loadAndStart's scene-swap ghost clear and wipe the just-captured
// idealized ghost. Throws on an unclassified force type (fail-loud).
export function idealizeScene(sceneJson) {
  const clone = structuredClone(sceneJson);

  // scene-scope air_resistance flag → off. The engine treats it as metadata,
  // but an idealized scene must not advertise air resistance (honesty).
  if (clone.scene_defaults &&
      Object.prototype.hasOwnProperty.call(clone.scene_defaults, 'air_resistance')) {
    clone.scene_defaults.air_resistance = false;
  }

  // Scene-root forces[] carry the dissipative mechanical forces. `?? []` guard:
  // a scene with no forces[] (a pure field/charge scene) does not throw.
  for (const force of clone.forces ?? []) zeroDissipativeForce(force);

  // Body-scope c_damping (linear viscous damping on a body), zeroed IF PRESENT.
  // Conditional so the transform never introduces a field $defs.body
  // (additionalProperties:false) would reject — validity is preserved. Not in
  // today's schema; kept for the plan's body-scope-damping intent + future use.
  for (const body of clone.bodies ?? []) {
    if (Object.prototype.hasOwnProperty.call(body, 'c_damping')) body.c_damping = 0;
    // Defensive: a body carrying its OWN forces[] (future per-body-forces
    // schema) rides the same classifier + fail-loud.
    for (const force of body.forces ?? []) zeroDissipativeForce(force);
  }

  return clone;
}

export const NAME = 'idealize_scene';
