// ui/predict.js
//
// Predict-before-run panel. The student types a value they expect for
// some quantity at the end of the run; after the simulation completes,
// the panel shows the simulation's result and the difference. The
// framing is descriptive, NOT evaluative — see sim/PEDAGOGY.md.
//
// Anti-Kohn requirements (non-negotiable — see sim/PEDAGOGY.md):
//   - No extrinsic-motivation tokens, retry counters, success indicators.
//   - No comparative ranking against peers; no percentile framing.
//   - No "good guess" / "way off" / "close enough" wording.
//   - No language that implies a measured-against-a-key outcome.
//   - The panel is OPT-IN: nothing on the screen suggests the student
//     SHOULD predict. The button is unobtrusive.
//   - Error-shading is FORBIDDEN (LOAD-BEARING for a future sketch↔real
//     graph overlay — no overlay ships this phase, but the guardrail must
//     already exist). A sketch/real graph comparison renders BOTH curves
//     in one frame and nothing else — no fill between them, and none of:
//       * a shaded gap between the prediction and simulation curves;  // kohn-ok: names a forbidden error-shading term this contract prohibits
//       * a color-coded error region;                                 // kohn-ok: names a forbidden error-shading term this contract prohibits
//       * a closeness metric or percent-match readout.                // kohn-ok: names two forbidden error-shading terms this contract prohibits
//     The overlay IS the feedback: two curves, drawn plainly, together.
//     (Lint: FORBIDDEN_ERROR_SHADING in sim/__tests__/no_kohn_drift.test.js.)
//
// Comparison wording is descriptive: "Your prediction: 4.2 m. Simulation:
// 4.85 m. Difference: 0.65 m (~15 %)." Followed by an open invitation
// to consider why the values differ — no leading suggestion of which
// is "right" (the simulation is itself an idealization; whether the
// student's prediction better captures a real-world setup is a teacher
// conversation, not a panel verdict).

// QUANTITIES and the quantity resolver live in the shared quantities module
// (sim/ui/quantities.js) so predict and the lab notebook read the SAME code.
// `resolveQuantity(view, prediction)` is the thin predict-facing wrapper there;
// predict's behavior is byte-identical to the pre-extraction inline copy.
import { QUANTITIES, resolveQuantity } from './quantities.js';
import { BoundsPickerController } from './sketch_capture.js';
// Sketch-eligibility filter lives with the sketch store (render layer): the
// charter limits sketching to v-t OR x-t (POSITION and VELOCITY only). Importing
// the SAME predicate the store uses keeps the panel's offering and the reveal's
// buffer-read in lockstep. ui→render is the sanctioned down-import (main.js does
// it too).
import { isSketchableQuantity } from '../render/sketch_state.js';
// sim_numerical_chaos P4a — the predict-before-run reveal reuses the ONE
// descriptive copy generator the drift overlay renders from (library-first: a
// single source of truth for the readout, consumed by both render and ui).
// ui→render is the sanctioned down-import (main.js does it too).
import { describeDrift } from '../render/integrator_drift_overlay.js';
// sim_numerical_chaos P4b — the divergence-foil reveal reuses the ONE
// descriptive copy generator the divergence overlay renders from (library-first:
// one source of truth for the readout, consumed by both render and ui).
import { describeDivergence } from '../render/divergence_foil_overlay.js';

// --- Predict-the-graph student-facing copy (sim_predict_graph P4) ---
// Symmetric to the reveal prose: a concrete, neutral, predict-BEFORE-run
// invitation so the sketch is framed as a committed prediction, not a button
// press. Both strings MUST pass the P1 anti-Kohn lint (none of the error-shading
// vocabulary the lint forbids) — they are scanned in place here and recorded in
// sim/PEDAGOGY.md §Predict-the-graph.
export function sketchInvitation(quantity) {
  const noun = typeof quantity === 'string' && quantity.startsWith('position') ? 'position' : 'velocity';
  return `Before you run it: sketch how you think ${noun} changes over time.`;
}
// Fixed reveal prose — the overlay itself is the feedback; this only names what
// the two curves are. No verdict, no evaluative language.
export const SKETCH_REVEAL_COPY = 'The simulation produced this curve. Your sketch is shown dashed.';
export const SKETCH_REVEAL_FOLLOWUP = 'What in the motion produced this shape?';

// Friendlier per-quantity labels for the sketch selector (the QUANTITIES labels
// read "final velocity x" which is the final-scalar framing, not the v-t curve).
const SKETCH_QUANTITY_LABELS = {
  'position.x': 'position x  (x-t)',
  'position.y': 'position y  (x-t)',
  'velocity.x': 'velocity vₓ  (v-t)',
  'velocity.y': 'velocity vᵧ  (v-t)',
};

const STYLE = `
.sim-predict {
  font-family: system-ui, sans-serif;
  font-size: 0.9rem;
  border: 1px solid #dde0e7;
  border-radius: 6px;
  padding: 0.75rem;
  margin-bottom: 0.75rem;
  background: #f8f9fc;
}
.sim-predict h3 {
  margin: 0 0 0.5rem;
  font-size: 1rem;
  font-weight: 600;
}
.sim-predict .row {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 0.5rem;
  align-items: center;
  margin-bottom: 0.4rem;
}
.sim-predict select, .sim-predict input {
  min-height: 36px;
  padding: 0.25rem 0.4rem;
  border: 1px solid #c5c9d2;
  border-radius: 4px;
  font: inherit;
  font-variant-numeric: tabular-nums;
}
.sim-predict button {
  min-height: 44px;
  padding: 0.5rem 1rem;
  border: 1px solid #c5c9d2;
  border-radius: 6px;
  background: #fff;
  font: inherit;
  cursor: pointer;
}
.sim-predict button.primary {
  background: #e7eaf3;
  border-color: #96a0b9;
}
.sim-predict .compare {
  margin-top: 0.6rem;
  padding-top: 0.6rem;
  border-top: 1px dashed #c5c9d2;
  font-variant-numeric: tabular-nums;
}
.sim-predict .compare dl {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 0.25rem 0.75rem;
  margin: 0.25rem 0;
}
.sim-predict .compare dt { font-weight: 600; color: #4a4f59; }
.sim-predict .compare dd { margin: 0; }
.sim-predict .compare .followup {
  margin: 0.5rem 0 0;
  font-style: italic;
  color: #555;
}
.sim-predict .hidden { display: none; }
.sim-predict .sketch {
  margin-top: 0.6rem;
  padding-top: 0.6rem;
  border-top: 1px dashed #c5c9d2;
}
.sim-predict .sketch .invite {
  margin: 0 0 0.5rem;
  font-style: italic;
  color: #4a4f59;
}
.sim-predict .sketch .bounds input { width: 5.5rem; }
.sim-predict .sketch .reveal {
  margin-top: 0.5rem;
  padding-top: 0.4rem;
  border-top: 1px dashed #c5c9d2;
}
.sim-predict .sketch .reveal .followup {
  margin: 0.3rem 0 0;
  font-style: italic;
  color: #555;
}
.sim-predict .toggle {
  background: none;
  border: none;
  padding: 0.25rem 0;
  font: inherit;
  color: #4a4f59;
  cursor: pointer;
  text-decoration: underline;
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

export function makePredictPanel({ onClose, sketch } = {}) {
  injectStyles();
  const root = document.createElement('div');
  root.className = 'sim-predict';

  let prediction = null;       // { quantity, body_id, value, unit }
  let lastResult = null;       // { sim_value, prediction_value, difference, rel_pct }
  // Sketch callbacks (main.js owns the frozen frame + controller + reveal
  // trigger); the panel only gathers the student's mode/quantity/bounds choice.
  const sketchCb = sketch ?? {};

  // The sketchable quantities (v-t / x-t only) — the panel never offers a
  // quantity the reveal cannot read.
  const sketchQuantities = QUANTITIES.filter((q) => isSketchableQuantity(q.value));

  function renderInputs(view) {
    const html = [];
    html.push('<h3>Predict</h3>');
    html.push('<p style="margin:0 0 0.5rem;">Type a value you expect at the end of the simulation.</p>');
    html.push('<div class="row"><span>Body</span><select data-id="body"></select></div>');
    html.push('<div class="row"><span>Quantity</span><select data-id="quantity">');
    for (const q of QUANTITIES) html.push(`<option value="${q.value}">${q.label}</option>`);
    html.push('</select></div>');
    html.push('<div class="row"><span>Your value</span><input data-id="value" type="number" step="any" /></div>');
    html.push('<button data-id="record" class="primary">Record prediction</button>');
    html.push('<div class="compare hidden" data-id="compare"></div>');

    // --- Predict-the-graph sketch section ---
    const firstSketchable = sketchQuantities[0]?.value ?? 'velocity.x';
    html.push('<div class="sketch" data-id="sketch">');
    html.push('<h3>Predict the graph</h3>');
    html.push(`<p class="invite" data-id="sketch-invite">${escapeHtml(sketchInvitation(firstSketchable))}</p>`);
    html.push('<div class="row"><span>Sketch</span><select data-id="sketch-quantity">');
    for (const q of sketchQuantities) {
      const label = SKETCH_QUANTITY_LABELS[q.value] ?? q.label;
      html.push(`<option value="${q.value}">${escapeHtml(label)}</option>`);
    }
    html.push('</select></div>');
    html.push('<div class="row"><span>Mode</span><select data-id="sketch-mode">');
    html.push('<option value="easy">Easy — bounds given</option>');
    html.push('<option value="hard">Hard — set your own bounds</option>');
    html.push('</select></div>');
    html.push('<div class="row bounds hidden" data-id="sketch-bounds"><span>Axis range</span><span>');
    html.push('<input data-id="sketch-vmin" type="number" step="any" placeholder="lowest" /> to ');
    html.push('<input data-id="sketch-vmax" type="number" step="any" placeholder="highest" />');
    html.push('</span></div>');
    html.push('<button data-id="sketch-start" class="primary">Start sketch</button>');
    html.push('<button data-id="sketch-clear" class="hidden">Sketch again</button>');
    html.push('<button data-id="sketch-cancel" class="hidden">Done</button>');
    html.push('<div class="reveal hidden" data-id="sketch-reveal"></div>');
    html.push('</div>');

    root.innerHTML = html.join('');

    const bodySel = root.querySelector('[data-id="body"]');
    if (view) {
      for (const b of view.bodies) {
        const o = document.createElement('option');
        o.value = b.id; o.textContent = b.id;
        bodySel.appendChild(o);
      }
    }

    const recordBtn = root.querySelector('[data-id="record"]');
    recordBtn.addEventListener('click', () => {
      const body_id = bodySel.value;
      const quantity = root.querySelector('[data-id="quantity"]').value;
      const value = parseFloat(root.querySelector('[data-id="value"]').value);
      if (Number.isNaN(value)) return;
      const q = QUANTITIES.find((x) => x.value === quantity);
      prediction = { body_id, quantity, value, unit: q.unit };
      // Acknowledge — not evaluate.
      const compare = root.querySelector('[data-id="compare"]');
      compare.classList.remove('hidden');
      compare.innerHTML =
        `<p>Recorded: ${quantity} for <code>${escapeHtml(body_id)}</code> = ${value} ${q.unit}.</p>` +
        `<p>Run the simulation to compare.</p>`;
    });

    wireSketchSection(bodySel);
  }

  // Wire the sketch section's controls. Gathering-only: the panel hands
  // {mode, quantity, bodyId, bounds} to main.js's onStart, which owns the
  // hidden pre-run / bounds→frozen-frame + controller mount + reveal.
  function wireSketchSection(bodySel) {
    const qSel = root.querySelector('[data-id="sketch-quantity"]');
    const modeSel = root.querySelector('[data-id="sketch-mode"]');
    const boundsRow = root.querySelector('[data-id="sketch-bounds"]');
    const invite = root.querySelector('[data-id="sketch-invite"]');
    const vminInput = root.querySelector('[data-id="sketch-vmin"]');
    const vmaxInput = root.querySelector('[data-id="sketch-vmax"]');
    const startBtn = root.querySelector('[data-id="sketch-start"]');
    const clearBtn = root.querySelector('[data-id="sketch-clear"]');
    const cancelBtn = root.querySelector('[data-id="sketch-cancel"]');

    // Invitation follows the selected quantity's family (v-t / x-t).
    qSel.addEventListener('change', () => { invite.textContent = sketchInvitation(qSel.value); });
    // Hard mode reveals the bounds inputs; Easy hides them (bounds are given).
    modeSel.addEventListener('change', () => {
      boundsRow.classList.toggle('hidden', modeSel.value !== 'hard');
    });

    startBtn.addEventListener('click', () => {
      const mode = modeSel.value;
      const quantity = qSel.value;
      const bodyId = bodySel.value;
      let bounds = null;
      if (mode === 'hard') {
        const vMin = parseFloat(vminInput.value);
        const vMax = parseFloat(vmaxInput.value);
        if (Number.isNaN(vMin) || Number.isNaN(vMax)) return; // need both bounds
        // Wire the P3 BoundsPickerController (UX-agnostic: it consumes the two
        // typed bounds, orders them, and emits the range that feeds the frozen
        // `range` path). A draggable-handle widget could swap in later without
        // touching the controller — it is flagged for teacher review.
        const picker = new BoundsPickerController({ onRange: (r) => { bounds = r; } });
        picker.setBounds({ vMin, vMax });
        picker.commit();
        if (!bounds) return;
      }
      const started = sketchCb.onStart?.({ mode, quantity, bodyId, bounds });
      if (started === false) return;
      // Enter the drawing state: hide Start, show Sketch-again + Done.
      startBtn.classList.add('hidden');
      clearBtn.classList.remove('hidden');
      cancelBtn.classList.remove('hidden');
    });

    clearBtn.addEventListener('click', () => {
      sketchCb.onClear?.();
      // Re-entering after a reveal blanks the frame; hide the reveal copy.
      root.querySelector('[data-id="sketch-reveal"]').classList.add('hidden');
    });

    cancelBtn.addEventListener('click', () => {
      sketchCb.onCancel?.();
      resetSketchUI();
    });
  }

  function resetSketchUI() {
    const startBtn = root.querySelector('[data-id="sketch-start"]');
    const clearBtn = root.querySelector('[data-id="sketch-clear"]');
    const cancelBtn = root.querySelector('[data-id="sketch-cancel"]');
    const reveal = root.querySelector('[data-id="sketch-reveal"]');
    if (startBtn) startBtn.classList.remove('hidden');
    if (clearBtn) clearBtn.classList.add('hidden');
    if (cancelBtn) cancelBtn.classList.add('hidden');
    if (reveal) { reveal.classList.add('hidden'); reveal.innerHTML = ''; }
  }

  function showComparison(view) {
    if (!prediction) return;
    const sim_value = resolveQuantity(view, prediction);
    if (sim_value === null || Number.isNaN(sim_value)) {
      const compare = root.querySelector('[data-id="compare"]');
      compare.classList.remove('hidden');
      compare.innerHTML =
        `<p>Simulation finished but the requested quantity ` +
        `(<code>${escapeHtml(prediction.quantity)}</code> on ` +
        `<code>${escapeHtml(prediction.body_id)}</code>) wasn't resolvable.</p>`;
      return;
    }
    const diff = sim_value - prediction.value;
    const denom = Math.max(Math.abs(prediction.value), Math.abs(sim_value), 1e-6);
    const relPct = 100 * diff / denom;
    lastResult = {
      sim_value,
      prediction_value: prediction.value,
      difference: diff,
      rel_pct: relPct
    };
    const compare = root.querySelector('[data-id="compare"]');
    compare.classList.remove('hidden');
    const u = prediction.unit;
    compare.innerHTML = `
      <h3 style="font-size:0.95rem;margin:0 0 0.4rem;">Comparison</h3>
      <dl>
        <dt>Quantity</dt><dd><code>${escapeHtml(prediction.quantity)}</code> on <code>${escapeHtml(prediction.body_id)}</code></dd>
        <dt>Your prediction</dt><dd>${prediction.value.toFixed(3)} ${u}</dd>
        <dt>Simulation</dt><dd>${sim_value.toFixed(3)} ${u}</dd>
        <dt>Difference</dt><dd>${diff.toFixed(3)} ${u} (${relPct.toFixed(2)} %)</dd>
      </dl>
      <p class="followup">What in the setup might explain a difference of this size?
      You can pause, edit the body, and run again.</p>
    `;
  }

  return {
    root,
    update(view) { /* no-op for now; selectors built once */ },
    initWith(view) { renderInputs(view); },
    onSimComplete(view) { showComparison(view); },
    // sim_trace_ghost P3 — NEW descriptive two-run path (distinct from
    // showComparison, which needs a typed student prediction and cannot frame a
    // real-vs-ideal contrast). Reads each run's U_thermal from the VALUE
    // snapshots the caller threads in (sourced from the runs' computeBars/LoL
    // snapshots), NOT from getResult(). No verdict language.
    showRunComparison(realResult, idealResult) {
      const lines = formatRunComparison(realResult, idealResult);
      const compare = root.querySelector('[data-id="compare"]');
      if (!compare) return;
      compare.classList.remove('hidden');
      compare.innerHTML = `
        <h3 style="font-size:0.95rem;margin:0 0 0.4rem;">${escapeHtml(lines.title)}</h3>
        <dl>
          <dt>Real run</dt><dd>${escapeHtml(lines.real)}</dd>
          <dt>Idealized run</dt><dd>${escapeHtml(lines.ideal)}</dd>
          <dt>Difference</dt><dd>${escapeHtml(lines.difference)}</dd>
        </dl>
        <p class="followup">${escapeHtml(lines.followup)}</p>
      `;
    },
    getPrediction() { return prediction; },
    getResult() { return lastResult; },
    // sim_predict_graph P4 — the reveal fired by main.js on the student's Run end
    // (the reveal TRIGGER; the real curve is drawn on the canvas by
    // drawSketchOverlay). Shows the fixed, descriptive reveal prose beside the
    // overlay — the overlay itself is the feedback; this only names the curves.
    showSketchReveal() {
      const reveal = root.querySelector('[data-id="sketch-reveal"]');
      if (!reveal) return;
      reveal.classList.remove('hidden');
      reveal.innerHTML =
        `<p>${escapeHtml(SKETCH_REVEAL_COPY)}</p>` +
        `<p class="followup">${escapeHtml(SKETCH_REVEAL_FOLLOWUP)}</p>`;
    },
    // Reset the sketch section's controls (Cancel / scenario swap).
    resetSketch() { resetSketchUI(); },
    reset() {
      prediction = null;
      lastResult = null;
      const compare = root.querySelector('[data-id="compare"]');
      if (compare) {
        compare.classList.add('hidden');
        compare.innerHTML = '';
      }
      const valueInput = root.querySelector('[data-id="value"]');
      if (valueInput) valueInput.value = '';
      resetSketchUI();
    }
  };
}

// sim_trace_ghost P3 — pure descriptive composition for the idealized-baseline
// two-run contrast. Reads U_thermal off each run's VALUE snapshot ({ U_thermal,
// source }) and frames a neutral difference ("thermal energy the real run moved
// into heat"). NO verdict / PASS-FAIL / better-worse language — the real run and
// the idealized run are both descriptions, not a reference the other is judged against.
// Exported so the predict test can assert the copy without a DOM.
export function formatRunComparison(realResult, idealResult) {
  const real = realResult && Number.isFinite(realResult.U_thermal) ? realResult.U_thermal : 0;
  const ideal = idealResult && Number.isFinite(idealResult.U_thermal) ? idealResult.U_thermal : 0;
  const difference = real - ideal;
  return {
    title: 'Two-run energy comparison',
    real: `thermal energy — real run: ${real.toFixed(3)} J`,
    ideal: `idealized run (f = 0, drag = 0): ${ideal.toFixed(3)} J`,
    difference: `difference: ${difference.toFixed(3)} J`,
    followup: 'That difference is the energy the real run moved into thermal energy. What in the setup produced it?'
  };
}

// --- sim_numerical_chaos P4a: spring integrator-drift predict-before-run -------
// The ACTIVE discovery element for the sibling-free increment. The student
// commits a prediction — which method keeps the spring's total energy bounded
// over a long run — BEFORE the descriptive readout is revealed. The reveal is the
// SAME descriptive story for every student, attributed to the METHOD, never to the
// student: no comparison of the prediction to an outcome, no verdict, no delta.
//
// buildDriftPredictionChoices + formatDriftReveal are pure and exported so the
// overlay test asserts the affordance is present and neutral without a DOM.

// The categorical, genuinely predict-able question + its options, built FROM the
// records so the method names are interpolated (never a hardcoded 'rk4'/'verlet').
export function buildDriftPredictionChoices(records) {
  const list = Array.isArray(records) ? records : [];
  const names = list.map((r) => String(r?.name ?? '')).filter((s) => s.length > 0);
  const choices = names.map((name) => ({ id: `method:${name}`, label: `${name} keeps the energy bounded` }));
  choices.push({ id: 'both', label: 'both keep the energy bounded' });
  choices.push({ id: 'neither', label: 'neither keeps the energy bounded' });
  return {
    prompt: "Before the reveal: which method do you think keeps the spring's total energy bounded over a long run?",
    choices,
  };
}

// The reveal copy shown AFTER the student commits. Delegates to the shared
// descriptive generator and adds a neutralizing lead so the readout reads as the
// same story for everyone — it never restates or judges the student's choice.
export function formatDriftReveal(records, opts = {}) {
  const copy = describeDrift(records, opts);
  return {
    lead: 'Here is what the simulation did — the same story for every student, whatever you predicted:',
    headline: copy.headline,
    lines: copy.lines,
    caption: copy.caption,
  };
}

// The interactive panel: a set of choices, a commit button, and a reveal region
// that shows the descriptive readout on reveal(). Extends the predict affordance
// (same module, styles, and escaping as makePredictPanel) rather than inventing a
// parallel one.
export function makeDriftPredictPanel({ records = [], duration, onCommit } = {}) {
  injectStyles();
  const root = document.createElement('div');
  root.className = 'sim-predict';

  const { prompt, choices } = buildDriftPredictionChoices(records);
  let committed = null;

  const html = [];
  html.push('<h3>Predict the drift</h3>');
  html.push(`<p style="margin:0 0 0.5rem;">${escapeHtml(prompt)}</p>`);
  for (const c of choices) {
    html.push(
      '<label class="row" style="grid-template-columns:max-content 1fr;">' +
      `<input type="radio" name="drift-choice" value="${escapeHtml(c.id)}" />` +
      `<span>${escapeHtml(c.label)}</span></label>`
    );
  }
  html.push('<button data-id="drift-record" class="primary">Record prediction</button>');
  html.push('<div class="reveal hidden" data-id="drift-reveal"></div>');
  root.innerHTML = html.join('');

  const recordBtn = root.querySelector('[data-id="drift-record"]');
  recordBtn.addEventListener('click', () => {
    const picked = root.querySelector('input[name="drift-choice"]:checked');
    committed = picked ? picked.value : null;
    onCommit?.(committed);
    // Acknowledge the commit — do not evaluate it.
    recordBtn.textContent = 'Prediction recorded';
  });

  function showReveal() {
    const reveal = formatDriftReveal(records, { duration });
    const el = root.querySelector('[data-id="drift-reveal"]');
    if (!el) return;
    el.classList.remove('hidden');
    const parts = [];
    parts.push(`<p>${escapeHtml(reveal.lead)}</p>`);
    parts.push(`<h3 style="font-size:0.95rem;margin:0.4rem 0 0.3rem;">${escapeHtml(reveal.headline)}</h3>`);
    parts.push('<dl>');
    for (const line of reveal.lines) {
      parts.push(`<dt>${escapeHtml(line.name)}</dt><dd>${escapeHtml(line.detail)}</dd>`);
    }
    parts.push('</dl>');
    parts.push(`<p class="followup">${escapeHtml(reveal.caption)}</p>`);
    el.innerHTML = parts.join('');
  }

  return {
    root,
    getPrediction() { return committed; },
    reveal() { showReveal(); },
  };
}

// --- sim_numerical_chaos P4b: double-pendulum divergence predict-before-run ----
// The ACTIVE discovery element for the SYSTEM channel. Predicting a chaotic
// TRAJECTORY is impossible by design, so the prompt asks a genuinely predict-ABLE
// question about the PHENOMENON — will two near-identical pendulums stay together
// or drift apart? — whose honest answer (they drift apart) IS the sensitive-
// dependence lesson. The reveal is the SAME descriptive story for every student,
// attributed to the SYSTEM, never to the student: no comparison of the prediction
// to an outcome, no verdict, no delta.
//
// buildDivergencePredictionChoices + formatDivergenceReveal are pure and exported
// so the overlay test asserts the affordance is present and neutral without a DOM.

// The binary phenomenon question + its options. The phenomenon is predict-ABLE
// (they drift apart) even though the specific paths are unpredictable — the third
// option names that honestly and is not a lesser choice.
export function buildDivergencePredictionChoices() {
  return {
    prompt: 'Before you run it: will these two almost-identical pendulums stay together, or drift apart?',
    choices: [
      { id: 'together', label: 'they stay together' },
      { id: 'apart', label: 'they drift apart' },
      { id: 'cannot', label: 'you cannot predict the exact paths' },
    ],
  };
}

// The reveal copy shown AFTER the student commits. Delegates to the shared
// descriptive generator and adds a neutralizing lead so the readout reads as the
// same story for everyone — it never restates or judges the student's choice.
export function formatDivergenceReveal(pair, opts = {}) {
  const copy = describeDivergence(pair, opts);
  return {
    lead: 'Here is what the simulation did — the same story for every student, whatever you predicted:',
    headline: copy.headline,
    caption: copy.caption,
  };
}

// The interactive panel: the binary phenomenon choice, a commit button, and a
// reveal region that shows the descriptive readout on reveal(). Extends the
// predict affordance (same module, styles, escaping) rather than inventing a
// parallel one.
export function makeDivergencePredictPanel({ pair = {}, duration, onCommit } = {}) {
  injectStyles();
  const root = document.createElement('div');
  root.className = 'sim-predict';

  const { prompt, choices } = buildDivergencePredictionChoices();
  let committed = null;

  const html = [];
  html.push('<h3>Predict the outcome</h3>');
  html.push(`<p style="margin:0 0 0.5rem;">${escapeHtml(prompt)}</p>`);
  for (const c of choices) {
    html.push(
      '<label class="row" style="grid-template-columns:max-content 1fr;">' +
      `<input type="radio" name="divergence-choice" value="${escapeHtml(c.id)}" />` +
      `<span>${escapeHtml(c.label)}</span></label>`
    );
  }
  html.push('<button data-id="divergence-record" class="primary">Record prediction</button>');
  html.push('<div class="reveal hidden" data-id="divergence-reveal"></div>');
  root.innerHTML = html.join('');

  const recordBtn = root.querySelector('[data-id="divergence-record"]');
  recordBtn.addEventListener('click', () => {
    const picked = root.querySelector('input[name="divergence-choice"]:checked');
    committed = picked ? picked.value : null;
    onCommit?.(committed);
    // Acknowledge the commit — do not evaluate it.
    recordBtn.textContent = 'Prediction recorded';
  });

  function showReveal() {
    const reveal = formatDivergenceReveal(pair, { duration });
    const el = root.querySelector('[data-id="divergence-reveal"]');
    if (!el) return;
    el.classList.remove('hidden');
    const parts = [];
    parts.push(`<p>${escapeHtml(reveal.lead)}</p>`);
    parts.push(`<h3 style="font-size:0.95rem;margin:0.4rem 0 0.3rem;">${escapeHtml(reveal.headline)}</h3>`);
    parts.push(`<p class="followup">${escapeHtml(reveal.caption.join(' '))}</p>`);
    el.innerHTML = parts.join('');
  }

  return {
    root,
    getPrediction() { return committed; },
    reveal() { showReveal(); },
  };
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export const NAME = 'predict';
