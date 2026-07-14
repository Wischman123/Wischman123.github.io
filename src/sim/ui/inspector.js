// ui/inspector.js
//
// Body inspector. Read-only display of a selected body's state plus
// paused-only edit panels for the body, for any uniform field, and for
// any surface that carries friction. Edits land when the user presses
// Reset (the orchestrator pulls them via `getEdits()`, merges into a
// deep-cloned scene via `mergeEditsIntoScene`, and re-validates through
// `validate_scene_browser.js`).
//
// Re-validation rule (plan §Phase E + Phase 2.5): the orchestrator runs
// the edited scene through the validator BEFORE Reset fires; if the
// edits produce an invalid scene, Reset is BLOCKED and the
// scenario_loader's banner shows the validator message. The inspector
// itself does NO validation — it only collects edits.
//
// Edits shape returned by getEdits():
//   {
//     bodies:   [{ body_id,    mass_kg, position_m, velocity_m_per_s, charge_C? }],
//     fields:   [{ field_id,   E_V_per_m?, B_T? }, ...],
//     surfaces: [{ surface_id, mu_k }, ...]
//   }
// Returns null when not paused (no edits collected).
//
// Anti-Kohn note: NO scoring, NO "good guess", NO progress bars
// celebrating progress through the simulation. The display is
// informational. PEDAGOGY.md is the charter.

const STYLE = `
.sim-inspector {
  font-family: system-ui, sans-serif;
  font-size: 0.9rem;
  color: #2d3138;
}
.sim-inspector h3 {
  margin: 0 0 0.5rem;
  font-size: 1rem;
  font-weight: 600;
}
.sim-inspector h4 {
  margin: 0.5rem 0 0.25rem;
  font-size: 0.95rem;
  font-weight: 600;
}
.sim-inspector .placeholder {
  color: #888;
  font-style: italic;
}
.sim-inspector dl {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 0.25rem 0.75rem;
  margin: 0.5rem 0;
  font-variant-numeric: tabular-nums;
}
.sim-inspector dt { font-weight: 600; color: #4a4f59; }
.sim-inspector dd { margin: 0; }
.sim-inspector .group {
  border: 1px solid #dde0e7;
  border-radius: 6px;
  padding: 0.5rem 0.75rem;
  margin-bottom: 0.75rem;
  background: #fcfcfd;
}
.sim-inspector .edit-group input[type="number"] {
  min-height: 32px;
  padding: 0.2rem 0.35rem;
  border: 1px solid #c5c9d2;
  border-radius: 4px;
  font: inherit;
  font-size: 0.85rem;
  font-variant-numeric: tabular-nums;
  -moz-appearance: textfield;
}
.sim-inspector .edit-group input[type="number"]::-webkit-inner-spin-button,
.sim-inspector .edit-group input[type="number"]::-webkit-outer-spin-button {
  -webkit-appearance: none;
  margin: 0;
}
.sim-inspector .edit-group input[type="range"] {
  flex: 1;
  min-width: 4rem;
  min-height: 32px;
}
.sim-inspector .slider-row {
  display: block;
  padding: 0.25rem 0;
}
.sim-inspector .slider-row .slider-label {
  display: block;
  font-size: 0.85rem;
  color: #4a4f59;
  font-weight: 600;
  margin-bottom: 0.15rem;
}
.sim-inspector .slider-row .slider-line {
  display: grid;
  grid-template-columns: 3.4rem 1fr 3.4rem 4rem;
  gap: 0.3rem;
  align-items: center;
}
.sim-inspector .slider-row .slider-line input[data-role="min"],
.sim-inspector .slider-row .slider-line input[data-role="max"] {
  width: 100%;
  text-align: center;
  color: #777;
}
.sim-inspector .slider-row .slider-line input[data-role="val"] {
  width: 100%;
  font-weight: 600;
}
.sim-inspector .hint {
  font-size: 0.8rem;
  color: #666;
  margin: 0.25rem 0 0;
}
`;

let stylesInjected = false;
function injectStyles() {
  if (stylesInjected) return;
  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.appendChild(style);
  stylesInjected = true;
}

// Per-quantity slider defaults: { min, max, step, decimals }. Bounds
// are user-editable from the inspector (the min/max boxes flanking
// each slider) so a starting range that's too tight can be widened
// without touching the scene JSON.
const SLIDER_DEFAULTS = {
  mass_kg:     { min: 0.1,    max: 100,   step: 0.1,    decimals: 2 },
  charge_C:    { min: -1e-5,  max: 1e-5,  step: 1e-7,   decimals: 7 },
  position_x:  { min: -50,    max: 50,    step: 0.1,    decimals: 2 },
  position_y:  { min: -50,    max: 50,    step: 0.1,    decimals: 2 },
  velocity_x:  { min: -50,    max: 50,    step: 0.1,    decimals: 2 },
  velocity_y:  { min: -50,    max: 50,    step: 0.1,    decimals: 2 },
  accel_x:     { min: -50,    max: 50,    step: 0.1,    decimals: 2 },
  accel_y:     { min: -50,    max: 50,    step: 0.1,    decimals: 2 },
  E_x:         { min: -1000,  max: 1000,  step: 10,     decimals: 2 },
  E_y:         { min: -1000,  max: 1000,  step: 10,     decimals: 2 },
  B_x:         { min: -5,     max: 5,     step: 0.1,    decimals: 3 },
  B_y:         { min: -5,     max: 5,     step: 0.1,    decimals: 3 },
  B_z:         { min: -5,     max: 5,     step: 0.1,    decimals: 3 },
  mu_k:        { min: 0,      max: 1,     step: 0.01,   decimals: 2 }
};

function defaultsFor(key, currentValue) {
  const d = SLIDER_DEFAULTS[key] ?? { min: -100, max: 100, step: 0.01, decimals: 3 };
  // If the current value falls outside the default range, widen the
  // range symmetrically so the slider can show it without clamping.
  if (Number.isFinite(currentValue)) {
    if (currentValue < d.min) return { ...d, min: currentValue * 1.5 - Math.abs(d.step) };
    if (currentValue > d.max) return { ...d, max: currentValue * 1.5 + Math.abs(d.step) };
  }
  return d;
}

function sliderRowHtml(labelText, key, value) {
  const d = defaultsFor(key, value);
  const safeVal = Number.isFinite(value) ? value : 0;
  return `
    <div class="slider-row">
      <span class="slider-label">${escapeHtml(labelText)}</span>
      <div class="slider-line">
        <input type="number" data-edit="${escapeHtml(key)}" data-role="min" step="any" value="${d.min}" aria-label="${escapeHtml(labelText)} min" />
        <input type="range" data-edit="${escapeHtml(key)}" data-role="slider" min="${d.min}" max="${d.max}" step="${d.step}" value="${safeVal}" aria-label="${escapeHtml(labelText)} slider" />
        <input type="number" data-edit="${escapeHtml(key)}" data-role="max" step="any" value="${d.max}" aria-label="${escapeHtml(labelText)} max" />
        <input type="number" data-edit="${escapeHtml(key)}" data-role="val" step="any" value="${safeVal}" aria-label="${escapeHtml(labelText)} value" />
      </div>
    </div>
  `;
}

export function makeInspector() {
  injectStyles();
  const root = document.createElement('div');
  root.className = 'sim-inspector';
  let selectedBodyId = null;
  let lastView = null;
  let isPaused = false;
  let currentScene = null;

  // Pending edits collected from inputs while paused. Re-seeded from
  // the live state every time the inspector re-renders (Reset clears
  // them; Pause re-renders).
  let editsForBody = null;                       // single-body slot
  const editsForFields = new Map();              // field_id -> { E_V_per_m?, B_T? }
  const editsForSurfaces = new Map();            // surface_id -> { mu_k? }

  function clearAllEdits() {
    editsForBody = null;
    editsForFields.clear();
    editsForSurfaces.clear();
  }

  function renderEmpty() {
    root.innerHTML = `
      <h3>Inspector</h3>
      <p class="placeholder">Click a body in the scene to inspect.</p>
    `;
  }

  function bodyDisplayBlock(view, body) {
    const isCharge = typeof body.charge === 'number';
    const html = [];
    html.push(`<h3>${escapeHtml(body.id)}</h3>`);
    html.push('<div class="group">');
    html.push('<dl>');
    html.push(`<dt>type</dt><dd>${isCharge ? 'charge' : 'particle'}</dd>`);
    html.push(`<dt>mass</dt><dd>${body.mass.toFixed(3)} kg</dd>`);
    if (isCharge) {
      html.push(`<dt>charge</dt><dd>${body.charge.toFixed(3)} C</dd>`);
    }
    html.push(`<dt>position</dt><dd>(${body.position.x.toFixed(3)}, ${body.position.y.toFixed(3)}) m</dd>`);
    html.push(`<dt>velocity</dt><dd>(${body.velocity.x.toFixed(3)}, ${body.velocity.y.toFixed(3)}) m/s</dd>`);
    html.push(`<dt>speed</dt><dd>${Math.hypot(body.velocity.x, body.velocity.y).toFixed(3)} m/s</dd>`);
    html.push(`<dt>K</dt><dd>${body.kineticEnergy().toFixed(4)} J</dd>`);
    html.push('</dl>');
    html.push('</div>');

    // Whole-system energy summary.
    const energy = view.energy;
    if (energy) {
      html.push('<div class="group">');
      html.push('<h3>Energy (system)</h3>');
      html.push('<dl>');
      html.push(`<dt>K_total</dt><dd>${energy.K.toFixed(4)} J</dd>`);
      for (const [k, v] of Object.entries(energy.contributions)) {
        html.push(`<dt>${escapeHtml(k)}</dt><dd>${v.toFixed(4)} J</dd>`);
      }
      html.push(`<dt>total</dt><dd>${energy.total.toFixed(4)} J</dd>`);
      html.push(`<dt>drift</dt><dd>${energy.drift_pct.toFixed(4)} %</dd>`);
      html.push('</dl>');
      html.push('</div>');
    }

    // Phase A1: EM-scalar readout. The diagnostics channel is
    // observation-only (energy.js) — populated by the A0 flux/induction
    // producers (Φ_E, q_enc, Φ_B, dΦ_B/dt, EMF) and the circuit producer
    // (resistor power now; node V / branch I at A3). It is read here, NOT
    // the root `view.diagnostics` (which exists nowhere). Empty for non-EM
    // scenes ⇒ the group is omitted entirely.
    const diagnostics = energy && energy.diagnostics;
    if (diagnostics && Object.keys(diagnostics).length > 0) {
      html.push('<div class="group">');
      html.push('<h3>Fields &amp; flux (EM)</h3>');
      html.push('<dl>');
      for (const [k, v] of Object.entries(diagnostics)) {
        const { label, unit } = diagLabelUnit(k);
        const unitStr = unit ? ` ${unit}` : '';
        html.push(`<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(formatDiag(v) + unitStr)}</dd>`);
      }
      html.push('</dl>');
      html.push('</div>');
    }
    return html.join('');
  }

  // The body's INITIAL config from the loaded scene JSON — the values Reset
  // re-runs from (NOT the live/evolved view body). This is the source of truth
  // for the edit seed + the slider initial values. Keys match getEdits() /
  // mergeEditsIntoScene exactly. Missing position/velocity default to {x:0,y:0}
  // so a seed is never `undefined`. Returns null when currentScene has no
  // matching body (a synthetic test view built without setScene) so callers can
  // fall back to the live view body. `charge_C` is carried only for charge
  // bodies (present in the scene JSON, or type === 'charge').
  function sceneBodyConfig(bodyId) {
    const bj = (currentScene?.bodies ?? []).find((b) => b.id === bodyId);
    if (!bj) return null;
    const pos = bj.position_m ?? {};
    const vel = bj.velocity_m_per_s ?? {};
    const a = bj.applied_acceleration_m_per_s2;
    const cfg = {
      mass_kg: bj.mass_kg,
      position_m: { x: pos.x ?? 0, y: pos.y ?? 0 },
      velocity_m_per_s: { x: vel.x ?? 0, y: vel.y ?? 0 },
      // T9 — settable a₀. The engine body doesn't carry applied acceleration
      // (it becomes an AppliedAcceleration force at load), so the scene JSON is
      // the source of truth. This path was ALREADY scene-sourced and is
      // unchanged by the seed fix.
      applied_acceleration_m_per_s2: { x: a?.x ?? 0, y: a?.y ?? 0 }
    };
    if (bj.charge_C !== undefined || bj.type === 'charge') {
      cfg.charge_C = bj.charge_C;
    }
    return cfg;
  }

  // The scene body's a₀, defaulting to {x:0,y:0} when there is no scene entry.
  // Kept as a thin delegate so bodyEditBlock's a₀ sliders and the field/surface
  // paths that reference it stay behavior-identical (ONE scene-body lookup).
  function appliedAccelOf(bodyId) {
    const cfg = sceneBodyConfig(bodyId);
    return cfg ? cfg.applied_acceleration_m_per_s2 : { x: 0, y: 0 };
  }

  function bodyEditBlock(body) {
    const isCharge = typeof body.charge === 'number';
    const a0 = appliedAccelOf(body.id);
    // Slider initial values are the INITIAL conditions Reset re-runs from —
    // scene config when available, live body only as the no-scene fallback —
    // so the sliders and the editsForBody seed always agree. (The display
    // block, bodyDisplayBlock, still shows the LIVE state; only the EDIT
    // surface reads the scene config.)
    const cfg = sceneBodyConfig(body.id);
    const mass = cfg ? cfg.mass_kg : body.mass;
    const posX = cfg ? cfg.position_m.x : body.position.x;
    const posY = cfg ? cfg.position_m.y : body.position.y;
    const velX = cfg ? cfg.velocity_m_per_s.x : body.velocity.x;
    const velY = cfg ? cfg.velocity_m_per_s.y : body.velocity.y;
    const charge = cfg && cfg.charge_C !== undefined ? cfg.charge_C : body.charge;
    const html = [];
    html.push('<div class="group edit-group" data-section="body">');
    html.push(`<h3>Edit body — ${escapeHtml(body.id)}</h3>`);
    html.push('<p class="hint">These values apply on Reset. Drag the slider, type a value, or widen the range with the min/max boxes.</p>');
    html.push(sliderRowHtml('mass (kg)', 'mass_kg', mass));
    if (isCharge) {
      html.push(sliderRowHtml('charge (C)', 'charge_C', charge));
    }
    html.push(sliderRowHtml('position x (m)', 'position_x', posX));
    html.push(sliderRowHtml('position y (m)', 'position_y', posY));
    html.push(sliderRowHtml('velocity x (m/s)', 'velocity_x', velX));
    html.push(sliderRowHtml('velocity y (m/s)', 'velocity_y', velY));
    // T9 — set v₀ AND a₀, then Play to watch how the acceleration shapes the
    // motion (the ax/ay motion-graph subplots make the effect visible).
    html.push(sliderRowHtml('accel x (m/s²)', 'accel_x', a0.x));
    html.push(sliderRowHtml('accel y (m/s²)', 'accel_y', a0.y));
    html.push('</div>');
    return html.join('');
  }

  function fieldEditBlock(fieldJson) {
    // The scene JSON entry is the source of truth for editable
    // components. Show only components present in the scene — a B-only
    // field stays B-only; an E-only field stays E-only.
    const html = [];
    const id = fieldJson.id;
    const hasE = !!fieldJson.E_V_per_m;
    const hasB = !!fieldJson.B_T;
    if (!hasE && !hasB) return ''; // no editable parameters
    html.push(`<div class="group edit-group" data-section="field" data-field-id="${escapeHtml(id)}">`);
    html.push(`<h4>Field — ${escapeHtml(id)}</h4>`);
    if (hasE) {
      const E = fieldJson.E_V_per_m;
      html.push(sliderRowHtml('E_x (V/m)', 'E_x', E.x ?? 0));
      html.push(sliderRowHtml('E_y (V/m)', 'E_y', E.y ?? 0));
    }
    if (hasB) {
      const B = fieldJson.B_T;
      html.push(sliderRowHtml('B_x (T)', 'B_x', B.x ?? 0));
      html.push(sliderRowHtml('B_y (T)', 'B_y', B.y ?? 0));
      html.push(sliderRowHtml('B_z (T)', 'B_z', B.z ?? 0));
    }
    html.push('</div>');
    return html.join('');
  }

  function surfaceEditBlock(surfaceId, frictionForce) {
    const html = [];
    html.push(`<div class="group edit-group" data-section="surface" data-surface-id="${escapeHtml(surfaceId)}">`);
    html.push(`<h4>Surface — ${escapeHtml(surfaceId)}</h4>`);
    html.push(sliderRowHtml('µ_k', 'mu_k', frictionForce.mu_k));
    html.push('</div>');
    return html.join('');
  }

  function fieldsAndSurfacesSection() {
    if (!currentScene) return '';
    const html = [];
    const sceneFields = currentScene.fields ?? [];
    const sceneForces = currentScene.forces ?? [];
    const frictionForcesBySurface = new Map();
    for (const f of sceneForces) {
      if (f.type !== 'friction') continue;
      // First friction force per surface_id wins for the inspector;
      // the merge function rewrites every matching entry on edit.
      if (!frictionForcesBySurface.has(f.surface_id)) {
        frictionForcesBySurface.set(f.surface_id, f);
      }
    }

    if (sceneFields.length > 0) {
      html.push('<h3>Scene fields</h3>');
      for (const fj of sceneFields) {
        const block = fieldEditBlock(fj);
        if (block) html.push(block);
      }
    }
    if (frictionForcesBySurface.size > 0) {
      html.push('<h3>Surface friction</h3>');
      for (const [sid, ff] of frictionForcesBySurface) {
        html.push(surfaceEditBlock(sid, ff));
      }
    }
    return html.join('');
  }

  function renderBody(view, body) {
    clearAllEdits();
    const html = [];
    html.push(bodyDisplayBlock(view, body));
    if (isPaused) {
      html.push(bodyEditBlock(body));
      html.push(fieldsAndSurfacesSection());
    } else {
      html.push('<p class="hint">Pause the simulation to edit values.</p>');
    }
    root.innerHTML = html.join('');
    if (isPaused) {
      seedEditsAndWire(body);
    }
  }

  function renderNoBodySelected(view) {
    clearAllEdits();
    const html = [];
    html.push(`<h3>Inspector</h3>`);
    html.push('<p class="placeholder">Click a body in the scene to inspect.</p>');
    if (isPaused) {
      const sectionHtml = fieldsAndSurfacesSection();
      if (sectionHtml) html.push(sectionHtml);
    }
    root.innerHTML = html.join('');
    if (isPaused) {
      seedEditsAndWire(null);
    }
    // Suppress unused-param lint in the inert path.
    void view;
  }

  function seedEditsAndWire(body) {
    if (body) {
      const cfg = sceneBodyConfig(body.id);
      if (cfg) {
        // Seed from the scene's INITIAL config — the values Reset re-runs from.
        // Seeding from the live view body was the bug: at end-of-run the paused
        // re-render overwrote the seed with the evolved end-of-run state, and
        // doReset merged that phantom "edit" back in as the next run's initial
        // conditions.
        editsForBody = {
          body_id: body.id,
          mass_kg: cfg.mass_kg,
          position_m: { x: cfg.position_m.x, y: cfg.position_m.y },
          velocity_m_per_s: { x: cfg.velocity_m_per_s.x, y: cfg.velocity_m_per_s.y },
          // T9 — a₀ was already scene-sourced; unchanged.
          applied_acceleration_m_per_s2: cfg.applied_acceleration_m_per_s2
        };
        if (cfg.charge_C !== undefined) editsForBody.charge_C = cfg.charge_C;
      } else {
        // Fallback: no scene entry for this body (a synthetic test view built
        // without setScene). Seed from the live body to preserve those setups.
        const isCharge = typeof body.charge === 'number';
        editsForBody = {
          body_id: body.id,
          mass_kg: body.mass,
          position_m: { x: body.position.x, y: body.position.y },
          velocity_m_per_s: { x: body.velocity.x, y: body.velocity.y },
          applied_acceleration_m_per_s2: appliedAccelOf(body.id)
        };
        if (isCharge) editsForBody.charge_C = body.charge;
      }
    }
    // Seed field edits from the scene JSON (the canonical source).
    if (currentScene) {
      for (const fj of currentScene.fields ?? []) {
        const seed = { field_id: fj.id };
        if (fj.E_V_per_m) seed.E_V_per_m = { x: fj.E_V_per_m.x ?? 0, y: fj.E_V_per_m.y ?? 0 };
        if (fj.B_T) seed.B_T = { x: fj.B_T.x ?? 0, y: fj.B_T.y ?? 0, z: fj.B_T.z ?? 0 };
        editsForFields.set(fj.id, seed);
      }
      // Seed surface edits from friction forces — one entry per unique surface_id.
      const seenSurfaces = new Set();
      for (const force of currentScene.forces ?? []) {
        if (force.type !== 'friction') continue;
        if (seenSurfaces.has(force.surface_id)) continue;
        seenSurfaces.add(force.surface_id);
        editsForSurfaces.set(force.surface_id, {
          surface_id: force.surface_id,
          mu_k: force.mu_k
        });
      }
    }

    // Wire input listeners. Slider rows have four inputs per key
    // (min / slider / max / val); they update each other and feed the
    // edits map. Plain text inputs (legacy callers) still work via the
    // same dispatcher.
    const inputs = root.querySelectorAll('input[data-edit]');
    for (const inp of inputs) {
      inp.addEventListener('input', () => onSliderRowInput(inp));
    }
  }

  // Find the slider-row triplet (slider + val + min + max) for a given
  // input by walking up to the .slider-line container.
  function rowSiblings(inp) {
    const line = inp.closest('.slider-line');
    if (!line) return null;
    return {
      slider: line.querySelector('input[data-role="slider"]'),
      val:    line.querySelector('input[data-role="val"]'),
      min:    line.querySelector('input[data-role="min"]'),
      max:    line.querySelector('input[data-role="max"]')
    };
  }

  function onSliderRowInput(inp) {
    const role = inp.dataset.role;
    const sibs = rowSiblings(inp);
    if (sibs) {
      if (role === 'min') {
        const m = parseFloat(inp.value);
        if (Number.isFinite(m) && sibs.slider) sibs.slider.min = String(m);
      } else if (role === 'max') {
        const m = parseFloat(inp.value);
        if (Number.isFinite(m) && sibs.slider) sibs.slider.max = String(m);
      } else if (role === 'slider') {
        if (sibs.val) sibs.val.value = inp.value;
      } else if (role === 'val') {
        // Sync slider position; also widen slider bounds if the typed
        // value falls outside the current min/max so the slider stays
        // representative.
        const v = parseFloat(inp.value);
        if (Number.isFinite(v) && sibs.slider) {
          const mn = parseFloat(sibs.slider.min);
          const mx = parseFloat(sibs.slider.max);
          if (Number.isFinite(mn) && v < mn && sibs.min) {
            sibs.min.value = String(v);
            sibs.slider.min = String(v);
          }
          if (Number.isFinite(mx) && v > mx && sibs.max) {
            sibs.max.value = String(v);
            sibs.slider.max = String(v);
          }
          sibs.slider.value = inp.value;
        }
      }
    }
    // Only slider + val carry the value that flows into edits.
    if (role !== 'slider' && role !== 'val') return;
    const k = inp.dataset.edit;
    const val = parseFloat(inp.value);
    if (Number.isNaN(val)) return;
    const section = inp.closest('[data-section]')?.dataset.section;
    if (section === 'body') {
      if (!editsForBody) return;
      if (k === 'mass_kg') editsForBody.mass_kg = val;
      else if (k === 'charge_C') editsForBody.charge_C = val;
      else if (k === 'position_x') editsForBody.position_m.x = val;
      else if (k === 'position_y') editsForBody.position_m.y = val;
      else if (k === 'velocity_x') editsForBody.velocity_m_per_s.x = val;
      else if (k === 'velocity_y') editsForBody.velocity_m_per_s.y = val;
      else if (k === 'accel_x') editsForBody.applied_acceleration_m_per_s2.x = val;
      else if (k === 'accel_y') editsForBody.applied_acceleration_m_per_s2.y = val;
    } else if (section === 'field') {
      const fid = inp.closest('[data-field-id]')?.dataset.fieldId;
      const entry = editsForFields.get(fid);
      if (!entry) return;
      if (k === 'E_x') entry.E_V_per_m = { ...(entry.E_V_per_m ?? { x: 0, y: 0 }), x: val };
      else if (k === 'E_y') entry.E_V_per_m = { ...(entry.E_V_per_m ?? { x: 0, y: 0 }), y: val };
      else if (k === 'B_x') entry.B_T = { ...(entry.B_T ?? { x: 0, y: 0, z: 0 }), x: val };
      else if (k === 'B_y') entry.B_T = { ...(entry.B_T ?? { x: 0, y: 0, z: 0 }), y: val };
      else if (k === 'B_z') entry.B_T = { ...(entry.B_T ?? { x: 0, y: 0, z: 0 }), z: val };
    } else if (section === 'surface') {
      const sid = inp.closest('[data-surface-id]')?.dataset.surfaceId;
      const entry = editsForSurfaces.get(sid);
      if (!entry) return;
      if (k === 'mu_k') entry.mu_k = val;
    }
  }

  function update(view) {
    lastView = view;
    if (selectedBodyId === null) {
      renderNoBodySelected(view);
      return;
    }
    const body = view.bodies.find((b) => b.id === selectedBodyId);
    if (!body) {
      renderNoBodySelected(view);
      return;
    }
    renderBody(view, body);
  }

  return {
    root,
    select(bodyId) {
      selectedBodyId = bodyId;
      if (lastView) update(lastView);
      else renderEmpty();
    },
    /**
     * Readable current-selection accessor. `select()` is a write-only setter,
     * so consumers that need to FREEZE the currently-selected body at a moment
     * in time (the lab notebook's run-start body_id, sim_lab_notebook P2) read
     * it here. Null when nothing is selected.
     */
    getSelectedBodyId() { return selectedBodyId; },
    setPaused(paused) {
      isPaused = paused;
      if (lastView) update(lastView);
    },
    /**
     * The orchestrator hands the scene JSON in at scene-load. The
     * inspector reads it to enumerate which fields and surfaces have
     * editable parameters and to seed the input values.
     */
    setScene(scene) {
      currentScene = scene;
      if (lastView) update(lastView);
    },
    update,
    /**
     * Snapshot of pending edits. Returns null when not paused (the
     * orchestrator interprets null as "no edits to merge").
     * When paused, returns a structured object even if nothing has
     * been changed yet — re-validation against the original values is
     * harmless and idempotent.
     */
    getEdits() {
      if (!isPaused) return null;
      return {
        bodies: editsForBody ? [editsForBody] : [],
        fields: [...editsForFields.values()],
        surfaces: [...editsForSurfaces.values()]
      };
    },
    clearEdits() {
      clearAllEdits();
    }
  };
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Phase A1: map a diagnostics-channel key (flux_E_<id>, emf_<id>, …) to a
// human-readable physics label + SI unit for the inspector EM readout. The
// channel is open-keyed (energy.js): the A0 flux/induction producers emit
// Φ_E / q_enc / Φ_B / dΦ_B/dt / EMF; the circuit producer (live at A3)
// emits resistor power and, eventually, node V / branch I. An unrecognized
// key still renders (raw key, no unit) so a future producer is never
// silently dropped. Longest-prefix-first so `flux_E_`/`flux_B_` win before
// any shorter future `flux_` alias.
const DIAG_LABELS = [
  ['power_dissipated_resistor_', 'P', 'W'],
  ['dphi_dt_', 'dΦ_B/dt', 'Wb/s'],
  ['flux_E_', 'Φ_E', 'V·m'],
  ['flux_B_', 'Φ_B', 'Wb'],
  ['q_enc_', 'q_enc', 'C'],
  ['v_node_', 'V', 'V'],
  ['i_branch_', 'I', 'A'],
  ['emf_', 'EMF', 'V']
];

function diagLabelUnit(key) {
  for (const [prefix, label, unit] of DIAG_LABELS) {
    if (key.startsWith(prefix)) {
      const id = key.slice(prefix.length);
      return { label: id ? `${label} (${id})` : label, unit };
    }
  }
  return { label: key, unit: '' };
}

// Format a diagnostic value: fixed-decimal for ordinary magnitudes, but
// scientific for the very small (q_enc ≈ 1e-9 C would render as a
// meaningless 0.0000) or very large, so no channel collapses to zero.
function formatDiag(v) {
  if (!Number.isFinite(v)) return String(v);
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-3 || a >= 1e6)) return v.toExponential(3);
  return v.toFixed(4);
}

export const NAME = 'inspector';
