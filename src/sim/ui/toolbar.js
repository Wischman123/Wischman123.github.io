// ui/toolbar.js
//
// Play / Pause / Step / Reset / Snapshot toolbar. Buttons are styled
// with ≥ 44px hit targets per iOS HIG. Pure DOM — no engine import,
// no simulator state ownership; the toolbar just emits events.
//
// Anti-Kohn note: button labels are functional, not evaluative.
// "Snapshot end-state" is a description of what happens, not a
// "good job!" reward. PEDAGOGY.md is the charter; toolbar.js sticks
// to it.
//
// Phase 2.7 — adds the curriculum preset selector and the
// programmatic toggle setters (setFbdToggle / setLolToggle /
// setGraphsToggle) so main.js can sync the visual button state when
// scene.feature_toggles_required forces an overlay on at scene load.

const STYLE = `
.sim-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: center;
  padding: 0.5rem;
  background: #f3f4f8;
  border-bottom: 1px solid #d8dbe1;
}
.sim-toolbar button {
  min-height: 44px;
  min-width: 44px;
  padding: 0.5rem 1rem;
  border: 1px solid #c5c9d2;
  border-radius: 6px;
  background: #fff;
  font: inherit;
  cursor: pointer;
}
.sim-toolbar button:hover { background: #f0f3fa; }
.sim-toolbar button:active { background: #e2e6f0; }
.sim-toolbar button[disabled] { opacity: 0.5; cursor: default; }
.sim-toolbar button[aria-pressed="true"] {
  background: #dde3f2;
  border-color: #8a99c2;
}
.sim-toolbar .play-pause { min-width: 110px; font-weight: 600; }
.sim-toolbar .clock {
  margin-left: auto;
  font-variant-numeric: tabular-nums;
  font-size: 0.95rem;
  color: #4a4f59;
}
.sim-toolbar select {
  min-height: 44px;
  padding: 0.5rem;
  border: 1px solid #c5c9d2;
  border-radius: 6px;
  background: #fff;
  font: inherit;
}
.sim-toolbar label {
  font-size: 0.85rem;
  color: #4a4f59;
  display: flex;
  gap: 0.25rem;
  align-items: center;
}
.sim-toolbar input[type="range"] {
  min-height: 36px;
  width: 12rem;
  vertical-align: middle;
}
.sim-toolbar input[type="range"][disabled] {
  opacity: 0.5;
  cursor: default;
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

// T2 (#6) — playback-rate options. Coupled to the engine clamp: every
// value here must be >= MIN_PLAYBACK_RATE (sim/engine/constants.js), the
// floor SimRunner.setPlaybackRate enforces — listing a sub-clamp value
// would silently clamp with no UI feedback. Asserted in
// sim/ui/__tests__/playback_rates.test.js. Ascending (slowest first); the
// 0.02x / 0.05x slow-motion options were added for close reading of fast
// transients. 1x stays the default selection.
export const PLAYBACK_RATES = [0.02, 0.05, 0.1, 0.25, 0.5, 1, 2, 4];

export function makeToolbar({ onPlay, onPause, onStep, onReset, onSnapshot, onExportCard, onPrintCard, onBaseline, onPlaybackRateChange, onFbdToggle, onLolToggle, onGraphsToggle, onTraceToggle, onFieldOverlayToggle, onViewModeChange, onCurrentConvention, onTimelineScrub, onZoomIn, onZoomOut, onZoomFit }) {
  injectStyles();
  const root = document.createElement('div');
  root.className = 'sim-toolbar';

  const playBtn = document.createElement('button');
  playBtn.className = 'play-pause';
  playBtn.textContent = 'Play';
  playBtn.setAttribute('aria-label', 'Play simulation');
  playBtn.addEventListener('click', () => {
    if (playBtn.dataset.state === 'playing') onPause?.();
    else onPlay?.();
  });

  const stepBtn = document.createElement('button');
  stepBtn.textContent = 'Step';
  stepBtn.setAttribute('aria-label', 'Advance one timestep');
  stepBtn.addEventListener('click', () => onStep?.());

  const resetBtn = document.createElement('button');
  resetBtn.textContent = 'Reset';
  resetBtn.setAttribute('aria-label', 'Reset simulation to t = 0');
  resetBtn.addEventListener('click', () => onReset?.());

  const snapBtn = document.createElement('button');
  snapBtn.textContent = 'Snapshot end-state';
  snapBtn.setAttribute('aria-label', 'Save current state to JSON');
  snapBtn.addEventListener('click', () => onSnapshot?.());

  // P2 — "Whiteboard card" export. Composites the live canvas (with any
  // active overlay) into a titled PNG card for whiteboarding discussion.
  // Functional label per PEDAGOGY.md (describes the artifact, not a
  // reward). ≥44px hit target via the shared `.sim-toolbar button` CSS.
  const exportBtn = document.createElement('button');
  exportBtn.textContent = 'Whiteboard card';
  exportBtn.setAttribute('aria-label', 'Save whiteboard card image');
  exportBtn.addEventListener('click', () => onExportCard?.());

  // P3 — "Print" sends the same whiteboard card straight to paper via the
  // browser print dialog (whiteboard-meeting handout). Same functional-label
  // and overlay-gate wiring as the card export; ≥44px hit target via the
  // shared `.sim-toolbar button` CSS.
  const printBtn = document.createElement('button');
  printBtn.textContent = 'Print';
  printBtn.setAttribute('aria-label', 'Print whiteboard card');
  printBtn.addEventListener('click', () => onPrintCard?.());

  // FBD toggle. Default OFF, session-only (does not persist across reloads).
  // When ON, the renderer draws a free-body diagram next to each body
  // showing the forces acting on it at the current state.
  const fbdBtn = document.createElement('button');
  fbdBtn.textContent = 'FBD';
  fbdBtn.setAttribute('aria-label', 'Toggle free-body diagrams');
  fbdBtn.setAttribute('aria-pressed', 'false');
  fbdBtn.dataset.fbd = 'off';
  fbdBtn.addEventListener('click', () => {
    const next = fbdBtn.dataset.fbd === 'on' ? 'off' : 'on';
    fbdBtn.dataset.fbd = next;
    fbdBtn.setAttribute('aria-pressed', next === 'on' ? 'true' : 'false');
    onFbdToggle?.(next === 'on');
  });

  // LOL toggle. Default OFF, session-only. When ON, the renderer draws
  // a stacked energy-bar panel in the top-right corner showing K plus
  // each U_* contribution against the initial-total reference line.
  const lolBtn = document.createElement('button');
  lolBtn.textContent = 'LOL';
  lolBtn.setAttribute('aria-label', 'Toggle energy bar overlay');
  lolBtn.setAttribute('aria-pressed', 'false');
  lolBtn.dataset.lol = 'off';
  lolBtn.addEventListener('click', () => {
    const next = lolBtn.dataset.lol === 'on' ? 'off' : 'on';
    lolBtn.dataset.lol = next;
    lolBtn.setAttribute('aria-pressed', next === 'on' ? 'true' : 'false');
    onLolToggle?.(next === 'on');
  });

  // Graphs toggle. Default OFF, session-only. When ON, the renderer
  // draws three stacked motion sub-plots (x-t / v-t / a-t) for the
  // inspector-selected body in the bottom-right corner. The graph
  // buffer fills as the runner advances; press Reset to clear it.
  const graphsBtn = document.createElement('button');
  graphsBtn.textContent = 'Graphs';
  graphsBtn.setAttribute('aria-label', 'Toggle motion graph overlay');
  graphsBtn.setAttribute('aria-pressed', 'false');
  graphsBtn.dataset.graphs = 'off';
  graphsBtn.addEventListener('click', () => {
    const next = graphsBtn.dataset.graphs === 'on' ? 'off' : 'on';
    graphsBtn.dataset.graphs = next;
    graphsBtn.setAttribute('aria-pressed', next === 'on' ? 'true' : 'false');
    onGraphsToggle?.(next === 'on');
  });

  // Trace toggle. Default OFF, session-only. When ON, the renderer strokes
  // each traceable body's fading past-path trail — a projectile's parabola,
  // an orbit's closed ellipse. The trail fills as the runner advances; press
  // Reset to clear it. Mirrors the Graphs toggle wiring.
  const traceBtn = document.createElement('button');
  traceBtn.textContent = 'Trace';
  traceBtn.setAttribute('aria-label', 'Toggle trajectory trace overlay');
  traceBtn.setAttribute('aria-pressed', 'false');
  traceBtn.dataset.trace = 'off';
  traceBtn.addEventListener('click', () => {
    const next = traceBtn.dataset.trace === 'on' ? 'off' : 'on';
    traceBtn.dataset.trace = next;
    traceBtn.setAttribute('aria-pressed', next === 'on' ? 'true' : 'false');
    onTraceToggle?.(next === 'on');
  });

  // Field & potential overlay toggle. Default OFF, session-only, NEVER
  // auto-shown (roadmap F1 / sim_equipotential_overlay). When ON, the renderer
  // reveals the superposed electric field lines, equipotential contours, and a
  // vector field so a student can compare the real structure to their own
  // sketch — a calibration, not an evaluation. A scene listing 'field-overlay'
  // in feature_toggles_required only makes this toggle AVAILABLE; the student
  // still turns it on. Functional label (describes what it reveals, not a
  // reward — PEDAGOGY.md). Mirrors the Graphs/Trace toggle wiring.
  const fieldOverlayBtn = document.createElement('button');
  fieldOverlayBtn.textContent = 'Field/V';
  fieldOverlayBtn.setAttribute('aria-label', 'Toggle electric field and potential overlay');
  fieldOverlayBtn.setAttribute('aria-pressed', 'false');
  fieldOverlayBtn.dataset.fieldOverlay = 'off';
  fieldOverlayBtn.addEventListener('click', () => {
    const next = fieldOverlayBtn.dataset.fieldOverlay === 'on' ? 'off' : 'on';
    fieldOverlayBtn.dataset.fieldOverlay = next;
    fieldOverlayBtn.setAttribute('aria-pressed', next === 'on' ? 'true' : 'false');
    onFieldOverlayToggle?.(next === 'on');
  });

  // sim_trace_ghost P3 — "Idealized baseline" action (NOT a toggle). Zeroes
  // friction + drag on the current scene, runs that idealized copy to completion
  // and freezes it as a faded ghost, then restores + reruns the real scene and
  // shows a descriptive two-run energy comparison. Functional label (describes
  // the action, not a reward — PEDAGOGY.md). setBaselineEnabled disables it while
  // a chain is in flight so a second press cannot register a competing chain.
  const baselineBtn = document.createElement('button');
  baselineBtn.textContent = 'Idealized baseline';
  baselineBtn.setAttribute('aria-label', 'Compare against the idealized (frictionless, drag-free) baseline');
  baselineBtn.addEventListener('click', () => onBaseline?.());

  // Playback rate selector — useful for slow-motion review.
  const rateLabel = document.createElement('label');
  rateLabel.textContent = 'speed';
  const rateSel = document.createElement('select');
  for (const r of PLAYBACK_RATES) {
    const o = document.createElement('option');
    o.textContent = `${r}×`;
    o.value = String(r);
    rateSel.appendChild(o);
  }
  rateSel.value = '1';
  rateSel.addEventListener('change', () => {
    onPlaybackRateChange?.(parseFloat(rateSel.value));
  });
  rateLabel.appendChild(rateSel);

  // T1 (#1) — the curriculum preset selector moved OUT of the toolbar to
  // the top-left of the scenario row (ui/preset_selector.js), so it is the
  // first choice a teacher makes rather than a mid-toolbar control.

  // View-mode selector. Default `fit-trajectory`: at scene load,
  // forward-simulate the full duration, fit the bounding box of every
  // visited body position, and the camera stays put. `fit-on-load`
  // frames only the t=0 state. `follow-selected` recenters on the
  // inspector-selected body each frame.
  const viewLabel = document.createElement('label');
  viewLabel.textContent = 'view';
  const viewSel = document.createElement('select');
  viewSel.setAttribute('aria-label', 'Camera view mode');
  for (const [value, text] of [
    ['fit-trajectory', 'Fit motion (default)'],
    ['fit-on-load', 'Fit on load'],
    ['follow-selected', 'Follow selected']
  ]) {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = text;
    viewSel.appendChild(o);
  }
  viewSel.value = 'fit-trajectory';
  viewSel.addEventListener('change', () => {
    onViewModeChange?.(viewSel.value);
  });
  viewLabel.appendChild(viewSel);

  // T7 — current-flow display convention. Circuit scenes animate flowing
  // markers along each branch; this selects whether they drift in the
  // conventional (+I, amber) or electron (reversed, blue) direction. It is
  // presentation-only — it never changes a plotted current value. Default
  // conventional; session-only.
  const currentLabel = document.createElement('label');
  currentLabel.textContent = 'current';
  const currentSel = document.createElement('select');
  currentSel.setAttribute('aria-label', 'Current-flow display direction');
  for (const [value, text] of [
    ['conventional', 'Conventional (default)'],
    ['electron', 'Electron flow']
  ]) {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = text;
    currentSel.appendChild(o);
  }
  currentSel.value = 'conventional';
  currentSel.addEventListener('change', () => {
    onCurrentConvention?.(currentSel.value);
  });
  currentLabel.appendChild(currentSel);

  // Zoom controls. Wheel-zoom on the canvas anchors at the cursor; the
  // buttons here zoom about canvas center. "Fit" re-applies the active
  // view-mode's load-time fit.
  const zoomOutBtn = document.createElement('button');
  zoomOutBtn.textContent = '−';
  zoomOutBtn.setAttribute('aria-label', 'Zoom out');
  zoomOutBtn.addEventListener('click', () => onZoomOut?.());
  const zoomInBtn = document.createElement('button');
  zoomInBtn.textContent = '+';
  zoomInBtn.setAttribute('aria-label', 'Zoom in');
  zoomInBtn.addEventListener('click', () => onZoomIn?.());
  const zoomFitBtn = document.createElement('button');
  zoomFitBtn.textContent = 'Fit';
  zoomFitBtn.setAttribute('aria-label', 'Reset camera to fit');
  zoomFitBtn.addEventListener('click', () => onZoomFit?.());

  // Phase 2.6 — timeline scrubbing. Drag-while-paused range slider
  // re-runs the simulation from t=0 to the released value. Disabled
  // when no scene is loaded OR the runner is playing (the rAF loop
  // would race the re-run). Updates on `change` (release) only — NOT
  // `input` (drag) — to avoid burning ~12 K integrator steps per
  // drag pixel on the cycloid scene. The slider's visual position
  // can still update during drag without the runner doing work.
  // Anti-Kohn: notation only — `t` / `s`. NO "rewind", NO "undo".
  const scrubLabel = document.createElement('label');
  scrubLabel.textContent = 't';
  const scrubSlider = document.createElement('input');
  scrubSlider.type = 'range';
  scrubSlider.min = '0';
  scrubSlider.max = '1';
  scrubSlider.step = 'any';
  scrubSlider.value = '0';
  scrubSlider.disabled = true;
  scrubSlider.setAttribute('aria-label', 'Scrub simulation time');
  scrubSlider.addEventListener('change', () => {
    const targetT = parseFloat(scrubSlider.value);
    if (Number.isFinite(targetT)) onTimelineScrub?.(targetT);
  });
  scrubLabel.appendChild(scrubSlider);

  const clock = document.createElement('div');
  clock.className = 'clock';
  clock.textContent = 't = 0.000 s';

  root.append(playBtn, stepBtn, resetBtn, snapBtn, exportBtn, printBtn, fbdBtn, lolBtn, graphsBtn, traceBtn, fieldOverlayBtn, baselineBtn, rateLabel, viewLabel, currentLabel, zoomOutBtn, zoomInBtn, zoomFitBtn, scrubLabel, clock);

  return {
    root,
    setPlaying(playing) {
      if (playing) {
        playBtn.dataset.state = 'playing';
        playBtn.textContent = 'Pause';
        playBtn.setAttribute('aria-label', 'Pause simulation');
      } else {
        playBtn.dataset.state = 'paused';
        playBtn.textContent = 'Play';
        playBtn.setAttribute('aria-label', 'Play simulation');
      }
    },
    setClock(t, duration) {
      clock.textContent = `t = ${t.toFixed(3)} / ${duration.toFixed(2)} s`;
    },
    setEndOfRun(atEnd) {
      stepBtn.disabled = atEnd;
      if (atEnd) {
        playBtn.disabled = true;
      } else {
        playBtn.disabled = false;
      }
    },
    // Phase 2.6 — timeline scrub controls. main.js calls these on
    // scene load (bounds), every onTick (value follow), and every
    // play/pause edge (enable state).
    setScrubBounds(durationSec, dtSec) {
      scrubSlider.min = '0';
      scrubSlider.max = String(durationSec);
      // Step at scene's dt granularity so the slider snaps to
      // integrator boundaries. Falls back to a sensible value if
      // dt is missing (shouldn't happen in practice — schema requires
      // simulation.dt_s — but defensive).
      scrubSlider.step = dtSec && dtSec > 0 ? String(dtSec) : 'any';
    },
    setScrubValue(t) {
      scrubSlider.value = String(t);
    },
    setScrubEnabled(enabled) {
      scrubSlider.disabled = !enabled;
    },
    // Phase 2.7 — programmatic sync of overlay button visual state
    // when scene.feature_toggles_required force-enables an overlay
    // on scene load. These setters do NOT fire onFbdToggle /
    // onLolToggle / onGraphsToggle — main.js calls the renderer
    // directly to avoid the round-trip + duplicate render.
    setFbdToggle(on) {
      const next = on ? 'on' : 'off';
      fbdBtn.dataset.fbd = next;
      fbdBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    },
    setLolToggle(on) {
      const next = on ? 'on' : 'off';
      lolBtn.dataset.lol = next;
      lolBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    },
    setGraphsToggle(on) {
      const next = on ? 'on' : 'off';
      graphsBtn.dataset.graphs = next;
      graphsBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    },
    setTraceToggle(on) {
      const next = on ? 'on' : 'off';
      traceBtn.dataset.trace = next;
      traceBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    },
    // roadmap F1 — sync the Field/V button when a scene forces availability
    // state (it never force-enables; the student toggles it). Mirrors the
    // other toggle setters so main.js can reflect programmatic state.
    setFieldOverlayToggle(on) {
      fieldOverlayBtn.dataset.fieldOverlay = on ? 'on' : 'off';
      fieldOverlayBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    },
    // sim_trace_ghost P3 — enable/disable the "Idealized baseline" button. The
    // baseline controller disables it at the top of its chain and re-enables it
    // on EVERY exit path (success or abort), so a second press is a no-op while
    // a chain is in flight.
    setBaselineEnabled(on) {
      baselineBtn.disabled = !on;
    }
    // T1 (#1) — setPresetValue moved to ui/preset_selector.js along with
    // the preset control it set.
  };
}

export const NAME = 'toolbar';
