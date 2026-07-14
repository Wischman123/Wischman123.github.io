// ui/preset_gating.js
//
// Phase 2.7 — pure helpers for curriculum-preset gating.
//
// Two contracts live here, both side-effect-free so they can be
// unit-tested without a DOM:
//   1. Scenario filtering by `preset_required` (each scenario carries
//      a canonical schema-enum string: '1st_year' | 'ap_c' | 'honors',
//      or null/missing meaning "any preset").
//   2. Per-overlay enablement by `feature_toggles_required` (each
//      scene JSON's array of canonical overlay names: 'fbd' | 'lol' |
//      'motion-graph'). Callers force-enable any listed overlay on
//      scene load; overlays not listed retain the user's last
//      manual state (per the Phase 2.7 handoff: "Don't remove the
//      toggle entirely — that breaks teacher exploration").
//
// Curriculum names follow PEDAGOGY.md "Curriculum scoping". Display
// labels are notation only — no difficulty-band framing, no "advanced"
// vs. "harder" wording. The anti-Kohn lint scans this file alongside
// the rest of `sim/ui/`.

// Canonical schema-enum values. Mirror sim/scene.schema.json $defs.
export const KNOWN_PRESETS = ['1st_year', 'ap_c', 'honors'];

// Curriculum-scoped display labels. Used by toolbar.js to populate the
// preset selector. Notation only — these match PEDAGOGY.md verbatim.
export const PRESET_LABELS = {
  '1st_year': '1st-year',
  'ap_c': 'AP-C',
  'honors': 'Honors'
};

// Default preset on session start. PEDAGOGY.md §Curriculum scoping:
// "Default = 1st-year preset. AP-C features are individually
// toggleable."
export const DEFAULT_PRESET = '1st_year';

// Canonical overlay names recognized by feature_toggles_required.
// Phase 2.7 ships gating for the three overlay toggles already on the
// toolbar. Future phases may extend the list (e.g., 'predict',
// 'inspector-edits') — each new entry must also wire enable-on-load
// in main.js.
//
// 'field-overlay' (roadmap F1 / sim_equipotential_overlay) is a DISCOVERY
// overlay and differs from the others: a scene listing it only makes the
// toggle AVAILABLE — it is NEVER auto-shown / force-enabled on load (the
// student turns it on). So main.js must NOT force-enable it from
// requiredOverlays the way it does fbd/lol/motion-graph; listing it gates
// availability only. This preserves the charter anti-target ("student-toggle
// only, default OFF, never auto-shown").
export const KNOWN_OVERLAYS = ['fbd', 'lol', 'motion-graph', 'field-overlay'];

// True when a scene whose preset_required is `scenePreset` should be
// visible under the currently-selected `currentPreset`. A scene with
// `null` / undefined / missing preset_required matches every preset
// (think of it as "preset-agnostic"). The schema permits null per the
// `preset_required` enum — we honor that semantics here so stub scenes
// or shared-across-curricula fixtures don't get hidden.
export function presetMatches(scenePreset, currentPreset) {
  if (scenePreset === null || scenePreset === undefined) return true;
  return scenePreset === currentPreset;
}

// Return a fresh array of scenarios whose preset_required matches
// `currentPreset`. Input is not mutated; ordering is preserved.
export function filterScenariosByPreset(scenarios, currentPreset) {
  if (!Array.isArray(scenarios)) return [];
  return scenarios.filter((s) => presetMatches(s?.preset, currentPreset));
}

// True when the loaded scene declares `overlayName` in its
// feature_toggles_required array. Defensive against missing scene /
// missing array / non-string entries — the schema validator already
// guarantees the shape on disk, but the runtime helper stays
// permissive so a malformed in-memory edit doesn't crash the UI.
export function requiresOverlay(scene, overlayName) {
  const list = scene?.feature_toggles_required;
  if (!Array.isArray(list)) return false;
  return list.includes(overlayName);
}

// Convenience: returns the set of overlays the scene declares as
// required. Useful for callers that want to iterate (e.g., to build
// a one-pass "apply defaults" loop in main.js). The return is a fresh
// Set; mutating it does not feed back into the scene.
export function requiredOverlays(scene) {
  const list = scene?.feature_toggles_required;
  if (!Array.isArray(list)) return new Set();
  return new Set(list.filter((n) => typeof n === 'string'));
}

// True when `preset` is one of the canonical schema-enum values.
// Useful for runtime defense — main.js / scenario_loader.js coerce an
// out-of-vocabulary value back to DEFAULT_PRESET so a typo in a saved
// preference (we don't persist today, but we may later) cannot strand
// the picker.
export function isKnownPreset(preset) {
  return KNOWN_PRESETS.includes(preset);
}

export const NAME = 'preset_gating';
