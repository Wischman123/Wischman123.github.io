// ui/ghost_label.js
//
// sim_trace_ghost P2 — the ghost trail's label formatter. A ghost freezes a
// FINISHED run's trajectory on Reset; this module derives the text that names
// that ghost by the parameter value THE FINISHED RUN ACTUALLY USED.
//
// Anti-Kohn HONESTY (the load-bearing rule, PEDAGOGY.md): the label is the
// value the frozen run ran at — NOT the pending edit's value (which is the
// NEXT run's value). Labeling an m = 1 ghost "m = 2.0 kg" would tell the
// student the old curve is the new run — a lie. So we DIFF `edits` against the
// OUTGOING `baseScene` to find the changed field, then format the BASE scene's
// value for that field. No ordering, no trial counter, no "improved"/"closer".
//
// Producer contract: `doReset` passes `inspector.getEdits()` AND the outgoing
// `currentScene` as `baseScene`. Taking BOTH parameters at the definition site
// is deliberate — the value the finished run used lives in `baseScene`, and
// the diff needs both to isolate the changed field.
//
// getEdits() shape (ui/inspector.js) — every edit object carries ALL of its
// category's fields, NOT just the changed one, so presence never implies a
// change; only a diff against `baseScene` does:
//   {
//     bodies:   [{ body_id,    mass_kg, position_m, velocity_m_per_s, charge_C? }],
//     fields:   [{ field_id,   E_V_per_m?, B_T? }],
//     surfaces: [{ surface_id, mu_k? }]
//   }

// Neutral fallback when no scalar editable field changed (plain Reset/replay,
// or only an unmapped field like position_m changed). Never "trial 2", never a
// count, never a ranking word.
export const PRIOR_RUN = 'prior run';

// The editable-parameter → [symbol, unit] map. ONE named module-local
// constant, keyed to the REAL editable surface (the keys in getEdits()), so
// adding an editable param is provably a ONE-LINE entry here — not an edit to
// an object literal buried inside the formatter.
//
// position_m intentionally unmapped → 'prior run' (vector, not a scalar label).
// It appears in EVERY getEdits() body object and IS editable, but a
// position edit has no honest scalar "x = 5 m" form (it is a 2-vector), so a
// position-only edit falls to the PRIOR_RUN fallback ON PURPOSE. Do NOT "fix"
// this gap by adding a broken entry.
const FIELD_LABELS = {
  mass_kg: ['m', 'kg'],
  velocity_m_per_s: ['v₀', 'm·s⁻¹'],
  charge_C: ['q', 'C'],
  E_V_per_m: ['E', 'V·m⁻¹'],
  B_T: ['B', 'T'],
  mu_k: ['μ_k', '']
};

// Format a base value as a short decimal string. Integers render with one
// decimal ("1" → "1.0") so a mass edit reads "m = 1.0 kg"; non-integers keep
// their significant decimals (trailing zeros trimmed via Number round-trip).
function formatValue(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  if (Number.isInteger(v)) return v.toFixed(1);
  return String(Number(v.toFixed(4)));
}

// Extract the scalar to format for a given field key from its BASE value.
// Scalars (mass, charge, E, B, mu_k) pass through; velocity_m_per_s is a
// 2-vector so we format its MAGNITUDE (the launch speed v₀). Anything else
// non-numeric → null (drop, fall to PRIOR_RUN).
function scalarForBase(key, baseValue) {
  if (key === 'velocity_m_per_s') {
    if (baseValue && typeof baseValue === 'object') {
      return Math.hypot(baseValue.x ?? 0, baseValue.y ?? 0);
    }
    return null;
  }
  return typeof baseValue === 'number' ? baseValue : null;
}

// Value equality that handles both scalars and {x,y} vectors, so "did this
// field change?" compares the edit against the base without false positives.
function valuesEqual(a, b) {
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    return a.x === b.x && a.y === b.y;
  }
  return a === b;
}

// Collect the labels for every MAPPED field that actually changed between an
// edit object and its base record. Iterates FIELD_LABELS in a fixed order so
// multi-field labels are deterministic regardless of edit-object key order.
// Unmapped changed fields (position_m, any unknown key) contribute nothing —
// they leave `labels` empty so the caller falls to PRIOR_RUN.
function collectChangedLabels(editObj, baseRecord) {
  const labels = [];
  if (!editObj || !baseRecord) return labels;
  for (const key of Object.keys(FIELD_LABELS)) {
    if (!(key in editObj)) continue;
    const editVal = editObj[key];
    const baseVal = baseRecord[key];
    if (valuesEqual(editVal, baseVal)) continue; // unchanged → skip
    const scalar = scalarForBase(key, baseVal);
    if (scalar === null) continue;
    const valStr = formatValue(scalar);
    if (valStr === null) continue;
    const [symbol, unit] = FIELD_LABELS[key];
    labels.push(unit ? `${symbol} = ${valStr} ${unit}` : `${symbol} = ${valStr}`);
  }
  return labels;
}

// Find a surface's BASE mu_k. Surface friction lives on `forces[]` entries of
// type 'friction' (mergeEditsIntoScene targets the same shape), not on a
// standalone surface record — so the base value is read from there.
function findBaseMuK(baseScene, surfaceId) {
  const forces = baseScene?.forces;
  if (!Array.isArray(forces)) return null;
  for (const f of forces) {
    if (f.type === 'friction' && f.surface_id === surfaceId && typeof f.mu_k === 'number') {
      return f.mu_k;
    }
  }
  return null;
}

// Derive the ghost label from the paused edits and the outgoing base scene.
//
//   - no edits (plain Reset/replay)            → PRIOR_RUN
//   - one mapped field changed                 → "<symbol> = <base value> <unit>"
//   - several mapped fields changed            → labels joined with ", "
//   - only an unmapped field changed (position)→ PRIOR_RUN
//
// The label always formats the BASE (finished-run) value, never the post-edit
// (next-run) value.
export function ghostLabel(edits, baseScene) {
  if (!edits) return PRIOR_RUN;
  const labels = [];

  for (const be of edits.bodies ?? []) {
    const baseBody = baseScene?.bodies?.find((b) => b.id === be.body_id);
    labels.push(...collectChangedLabels(be, baseBody));
  }
  for (const fe of edits.fields ?? []) {
    const baseField = baseScene?.fields?.find((f) => f.id === fe.field_id);
    labels.push(...collectChangedLabels(fe, baseField));
  }
  for (const se of edits.surfaces ?? []) {
    const baseMuK = findBaseMuK(baseScene, se.surface_id);
    const baseRecord = baseMuK === null ? null : { mu_k: baseMuK };
    labels.push(...collectChangedLabels(se, baseRecord));
  }

  if (labels.length === 0) return PRIOR_RUN;
  return labels.join(', ');
}

export const NAME = 'ghost_label';
