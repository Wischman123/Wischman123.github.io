// main.js
//
// Browser entry point. Wires the renderer + runner + toolbar + inspector
// + scenario loader + predict-before-run panel into a working UI.
// Imported as a module from sim/index.html.
//
// Architecture rule (plan §Phase E): rendering layers READ engine state;
// they never own state-shape decisions. The state.json snapshot
// serializer lives in sim/engine/scene.js and is shared with the CLI.

import { loadScene, serializeState } from './engine/scene.js';
import { makeIntegrator } from './engine/integrator.js';
import { SimRunner } from './engine/runner.js';
import { TrajectoryRecorder, sceneHasAtOutputs } from './engine/output_events.js';
import { Canvas2DRenderer, sceneBounds } from './render/canvas2d.js';
import { clearBuffers as clearMotionGraphBuffers, recordSample as recordMotionGraphSample, getBuffer as getMotionGraphBuffer, channelBufferKey, snapshotBuffers, frozenAxisRange, pxToPlotFrozen, sketchGeometry, subplotStyleForKey, SKETCH_STROKE_COLOR } from './render/motion_graph.js';
import { triggerDownload } from './render/download.js';
import { anyOverlayActive, formatClockText, composeWhiteboardCard, cardToBlob } from './render/whiteboard_card.js';
import { recordTracePoint, clearTraceBuffers, setMaxTracePath, getTrace as getTraceBuffer, tracePathCapForBounds, snapshotTraces } from './render/trajectory_trace.js';
import { captureGhost, clearGhosts, shouldCaptureGhost, getGhosts, ghostLol } from './render/ghost_store.js';
import { ghostLabel } from './ui/ghost_label.js';
import { computeBars } from './render/lol_overlay.js';
import { idealizeScene, IDEALIZED_GHOST_LABEL } from './ui/idealize_scene.js';
import { makeBaselineController } from './ui/baseline.js';
import { makeToolbar } from './ui/toolbar.js';
import { makeInspector } from './ui/inspector.js';
import { mergeEditsIntoScene } from './ui/inspector_edits.js';
import { seekTo as timelineSeekTo, shouldEnableSlider } from './ui/timeline_scrub.js';
import { makeScenarioLoader, SCENARIOS_LIST } from './ui/scenario_loader.js';
import { resolveBootSceneId, resolveEmbedChrome, installEmbedControls } from './ui/embed_boot.js';
import { makePresetSelector } from './ui/preset_selector.js';
import { makePredictPanel } from './ui/predict.js';
import { makeLabNotebook } from './ui/lab_notebook.js';
import { requiresOverlay } from './ui/preset_gating.js';
import { PointerDragController } from './ui/pointer_drag.js';
import { SketchCaptureController } from './ui/sketch_capture.js';
import { enterSketch, exitSketch, isSketchActive, getSketchSession, setSketchCurve, revealSketch, clearSketchForReenter, sampleKeyForQuantity } from './render/sketch_state.js';
import { validateScene } from './validate_scene_browser.js';

const root = document.getElementById('app');
if (!root) throw new Error('Missing #app element in index.html');

// --- Build DOM scaffold ---
root.innerHTML = `
  <header>
    <strong>Physics Simulator</strong>
    <span class="subtitle">v1 foundation</span>
  </header>
  <div id="scenario-row"></div>
  <div id="banner-row"></div>
  <div id="toolbar-row"></div>
  <main>
    <div id="canvas-wrap"><canvas id="scene"></canvas></div>
    <aside>
      <div id="predict-row"></div>
      <div id="notebook-row"></div>
      <div id="inspector-row"></div>
    </aside>
  </main>
`;

const sceneRow = document.getElementById('scenario-row');
const bannerRow = document.getElementById('banner-row');
const toolbarRow = document.getElementById('toolbar-row');
const canvas = document.getElementById('scene');
const predictRow = document.getElementById('predict-row');
const notebookRow = document.getElementById('notebook-row');
const inspectorRow = document.getElementById('inspector-row');

// --- Wire components ---
const renderer = new Canvas2DRenderer(canvas);
let currentScene = null;        // last loaded scene JSON
let currentLoaded = null;       // engine view of currentScene
let currentRunner = null;       // SimRunner over currentLoaded
let lastFrameTime = null;
// P2/P3 — true while the no-overlay export hint banner is the one currently
// shown. Set at the SINGLE show-site in prepareCard() (P3 moved it here from
// the old inline doExportCard gate, so both the PNG and print paths share it)
// and cleared by maybeClearOverlayHint() once an overlay turns on, so the hint
// dismiss never clobbers an unrelated banner raised through the same seam.
let noOverlayHintShown = false;
// sim_trace_ghost P3 — the idealized-baseline action's per-frame relay. Set by
// startBaselineRun and called every frame inside the loadAndStart onTick closure
// so the baseline controller can count ticks against its termination ceiling;
// cleared by stopBaselineRun / restoreScene. Null (default) ⇒ zero cost when no
// baseline chain is in flight. The four-stage async chain + re-entrancy lock live
// in the injected baselineController (ui/baseline.js), constructed below.
let baselineTickRelay = null;

const inspector = makeInspector();
inspectorRow.appendChild(inspector.root);

const predictPanel = makePredictPanel({
  // sim_predict_graph P4 — the panel gathers the student's mode/quantity/bounds
  // choice; main.js owns the frozen frame (Easy hidden pre-run / Hard bounds),
  // the controller mount, and the reveal trigger. (startSketch/clearSketch/
  // cancelSketch are hoisted function declarations below.)
  sketch: {
    onStart: (cfg) => startSketch(cfg),
    onClear: () => clearSketch(),
    onCancel: () => cancelSketch(),
  },
});
predictRow.appendChild(predictPanel.root);

// sim_lab_notebook P2 — lab-notebook panel beside predict. It appends ONE row
// per completed run (the varied INPUT + the final-state output scalars). The
// run-start body_id is FROZEN from the inspector's currently-selected body
// (getSelectedBodyId is the readable accessor added in P2; select() is
// write-only), with a fallback to the primary body inside the panel.
const notebook = makeLabNotebook({ getSelectedBodyId: () => inspector.getSelectedBodyId() });
notebookRow.appendChild(notebook.root);

const scenarioLoader = makeScenarioLoader({
  onLoad: (json, _scenario) => loadAndStart(json)
});
// T1 (#1) — curriculum preset selector at the top-left of the scenario
// row, BEFORE the "Scenario:" dropdown. Its own UI module owns the DOM;
// scenario_loader exposes only the preset-switch command (setPreset),
// which rebuilds the scenario picker for the chosen curriculum.
const presetSelector = makePresetSelector({
  onPresetChange: (preset) => scenarioLoader.setPreset(preset)
});
sceneRow.append(presetSelector.root, scenarioLoader.loaderRoot);
bannerRow.appendChild(scenarioLoader.bannerRoot);

// The Play toolbar button's handler, extracted so the embed Restart path
// (embedRestart) can drive the EXACT same launch the button does — a replay is
// "press Reset, then press Play". Kept a named function (not inline in the
// toolbar config) so both call sites share one source of truth.
function doPlay() {
  currentRunner?.play();
  // sim_lab_notebook P2 — the launch moment (AFTER the student's inspector
  // edits, which are applied on Reset). onRunStart freezes body_id + captures
  // the chosen independent value + arms the once-per-run row, but ONLY on a
  // genuine fresh launch: a mid-run resume or a replay-via-Play re-enters this
  // SAME handler and the panel no-ops (see lab_notebook.js dedupe notes).
  if (currentRunner) notebook.onRunStart(currentRunner.view());
  toolbar.setPlaying(true);
  inspector.setPaused(false);
  refreshScrubEnabled();
}

const toolbar = makeToolbar({
  onPlay: () => doPlay(),
  onPause: () => {
    currentRunner?.pause();
    toolbar.setPlaying(false);
    inspector.setPaused(true);
    refreshScrubEnabled();
  },
  onStep: () => {
    currentRunner?.step();
    toolbar.setPlaying(false);
    inspector.setPaused(true);
    refreshScrubEnabled();
  },
  onReset: () => doReset(),
  onSnapshot: () => doSnapshot(),
  onExportCard: () => doExportCard(),
  onPrintCard: () => doPrintCard(),
  onBaseline: () => doIdealizedBaseline(),
  onPlaybackRateChange: (rate) => { currentRunner?.setPlaybackRate(rate); },
  onFbdToggle: (enabled) => {
    renderer.setFbdEnabled(enabled);
    drawFrame();
    maybeClearOverlayHint();
  },
  onLolToggle: (enabled) => {
    renderer.setLolEnabled(enabled);
    drawFrame();
    maybeClearOverlayHint();
  },
  onGraphsToggle: (enabled) => {
    renderer.setGraphsEnabled(enabled);
    drawFrame();
    maybeClearOverlayHint();
  },
  onTraceToggle: (enabled) => {
    renderer.setTraceEnabled(enabled);
    drawFrame();
  },
  onFieldOverlayToggle: (enabled) => {
    // roadmap F1 — student turns the Field/V discovery overlay on/off.
    renderer.setFieldOverlayEnabled(enabled);
    drawFrame();
    maybeClearOverlayHint();
  },
  onCurrentConvention: (mode) => {
    renderer.setCurrentConvention(mode);
    drawFrame();
  },
  onViewModeChange: (mode) => {
    renderer.setViewMode(mode);
    refit();
    drawFrame();
  },
  onZoomIn: () => {
    renderer.zoomAtPoint(1.5, { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 });
    drawFrame();
  },
  onZoomOut: () => {
    renderer.zoomAtPoint(1 / 1.5, { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 });
    drawFrame();
  },
  onZoomFit: () => {
    refit();
    drawFrame();
  },
  onTimelineScrub: (targetT) => {
    if (!currentRunner) return;
    // Pause first so the rAF loop's tick() returns 0 while we
    // re-run. The disable-on-playing rule already prevents this
    // path when playing; this is a belt-and-suspenders guard.
    currentRunner.pause();
    toolbar.setPlaying(false);
    inspector.setPaused(true);
    timelineSeekTo(currentRunner, targetT);
    drawFrame();
    refreshScrubEnabled();
  },
  // T1 (#1) — preset switching moved to ui/preset_selector.js, wired to
  // scenarioLoader.setPreset where the selector is constructed.
});

function refreshScrubEnabled() {
  const enabled = shouldEnableSlider({
    sceneLoaded: Boolean(currentRunner),
    isPlaying: Boolean(currentRunner?.playing)
  });
  toolbar.setScrubEnabled(enabled);
}
toolbarRow.appendChild(toolbar.root);

// --- Body picking on canvas click ---
canvas.addEventListener('click', (ev) => {
  // While sketching, a tap lays down no curve and must not select a body — the
  // sketch controller owns the canvas pointer stream.
  if (isSketchActive()) return;
  if (!currentLoaded) return;
  const rect = canvas.getBoundingClientRect();
  const px = { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  const body = renderer.pickBodyAt(currentLoaded, px);
  const id = body ? body.id : null;
  inspector.select(id);
  renderer.setSelectedBodyId(id);
  drawFrame();
});

// --- T8 (#5, #8c) + T9 (#8): live pointer-drag → pokeBody seam ---
// The DOM binding for the pointer→edit adapter (ui/pointer_drag.js). It
// turns a canvas drag into a continuous stream of live position pokes on
// the RUNNING engine — no scene rebuild, no t reset, no buffer clear
// (contrast doReset). All I/O is injected so the gesture logic stays
// headless-testable.
//
// T9 play-vs-drag state machine (upgrades T8's whole-tick freeze):
//   - The rAF loop RUNS the integrator during a playing drag, but
//     derivState PINS the dragged body's motion via
//     currentLoaded.sceneCtx.draggingBodyId (set on pointerdown, cleared on
//     up/Esc), so the coupled induction/circuit solve keeps integrating
//     from the poked velocity while the rod itself follows the pointer.
//   - The drag POKE is recomputed once per rAF FRAME (not per pointermove)
//     from (x_now − x_prev)/wall_dt, so a held-still pointer yields v=0 ⇒
//     EMF=0 (no stale velocity). pointermove only records the latest px in
//     `lastPointerPx`; the rAF loop pokes it.
//   - Release under Play keeps the released velocity (end({keepVelocity})).
let isDragging = false;
let lastPointerPx = null;
const dragController = new PointerDragController({
  pickBody: (px) => (currentLoaded ? renderer.pickBodyAt(currentLoaded, px) : null),
  pxToWorld: (px) => renderer.pxToWorld(px),
  pokeBody: (poke) => (currentRunner ? currentRunner.pokeBody(poke) : { ok: false, reason: 'no_runner' }),
});

const canvasPx = (ev) => {
  const rect = canvas.getBoundingClientRect();
  return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
};
// Pointer event timestamps are monotonic ms from the browser — use them
// (not Date.now) for the velocity dt so the estimate is drift-free.
const evSeconds = (ev) => (ev.timeStamp ?? 0) / 1000;

function refreshAfterPoke() {
  if (currentRunner) inspector.update(currentRunner.view());
  drawFrame();
}

// Set / clear the engine-side drag pin so derivState holds the dragged
// body while the coupled solve keeps running (T9). Guarded on sceneCtx so a
// scene without one (or a null loaded) is a safe no-op.
function setDragPin(id) {
  if (currentLoaded?.sceneCtx) currentLoaded.sceneCtx.draggingBodyId = id;
}

canvas.addEventListener('pointerdown', (ev) => {
  // sim_predict_graph P4 — pointer arbitration. main.js binds ONE canvas pointer
  // stream; while sketching, route it to the sketch controller and SHORT-CIRCUIT
  // dragController (return before dragController.begin) so the two never contend
  // on the one stream. The sketch owns setPointerCapture; input is captured over
  // the WHOLE canvas (a stray drag outside the subplot is clamped to the box edge
  // by the controller, never toward an answer).
  if (isSketchActive() && sketchController) {
    sketchController.begin(canvasPx(ev), ev.pointerId);
    canvas.setPointerCapture?.(ev.pointerId);
    return;
  }
  if (!currentLoaded || !currentRunner) return;
  const px = canvasPx(ev);
  const id = dragController.begin(px, evSeconds(ev));
  if (id == null) return;                 // nothing draggable here → plain click/select
  isDragging = true;
  lastPointerPx = px;                     // seed the per-frame velocity source
  setDragPin(id);                         // pin the body in the integrator (T9)
  canvas.setPointerCapture?.(ev.pointerId);
  // Grabbing a body selects it, so the inspector tracks it while dragging.
  inspector.select(id);
  renderer.setSelectedBodyId(id);
  drawFrame();
});

// pointermove only records the latest pointer position — the rAF loop does
// the actual per-frame poke (T9), so a held-still pointer decays v→0.
canvas.addEventListener('pointermove', (ev) => {
  // sim_predict_graph P4 — bind pointermove DIRECTLY to the controller, ONE
  // sample per move (NOT via a per-frame lastPointerPx): P3's interpolation
  // assumes it sees every move, so the per-frame poke cadence used by the drag
  // path would discard intra-frame path detail. onSample redraws the overlay.
  if (isSketchActive() && sketchController) {
    sketchController.move(canvasPx(ev), ev.pointerId);
    return;
  }
  if (!isDragging) return;
  lastPointerPx = canvasPx(ev);
});

function finishDrag(ev, canceled) {
  if (!isDragging) return;
  isDragging = false;
  setDragPin(null);                       // release the integrator pin (T9)
  try { canvas.releasePointerCapture?.(ev.pointerId); } catch { /* not captured */ }
  // Release UNDER PLAY resumes from the released velocity; a paused release
  // rests at the release point (end() default). Esc always rolls back.
  const playing = Boolean(currentRunner?.playing);
  if (canceled ? dragController.cancel() : dragController.end({ keepVelocity: playing })) {
    refreshAfterPoke();
  }
}
// Pointer-up / pointer-cancel COMMIT IN PLACE; only Esc rolls back.
canvas.addEventListener('pointerup', (ev) => {
  if (isSketchActive() && sketchController) {
    sketchController.end(ev.pointerId);          // commits the stroke as a segment
    try { canvas.releasePointerCapture?.(ev.pointerId); } catch { /* not captured */ }
    return;
  }
  finishDrag(ev, false);
});
canvas.addEventListener('pointercancel', (ev) => {
  if (isSketchActive() && sketchController) {
    sketchController.cancel();                    // discards the in-progress stroke
    try { canvas.releasePointerCapture?.(ev.pointerId); } catch { /* not captured */ }
    return;
  }
  finishDrag(ev, false);
});
window.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && isDragging) {
    isDragging = false;
    setDragPin(null);
    if (dragController.cancel()) refreshAfterPoke();
  }
});

// --- Predict-the-graph sketch capture wiring (sim_predict_graph P4) ---
// The sketch controller is the sketch sibling of dragController: injected-I/O,
// headless-tested in ui/__tests__/sketch_capture.test.js. main.js supplies the
// real geometry + the reveal trigger; the store (render/sketch_state.js) owns
// the flag + curve + frozen frame so canvas2d can read them every frame.
let sketchController = null;

// Bind P2's pxToPlotFrozen with THIS session's fixedRange and the LIVE sketch
// geometry (read fresh from renderer.cssHeight so a resize is reflected). Both
// this inverse (capture) and canvas2d's forward draw derive the box from
// sketchGeometry(cssHeight), so they can never drift.
//
// FIELD-CONVENTION SEAM: canvasPx() yields DOM pointer px as { x, y }, but
// pxToPlotFrozen consumes screen px as { px, py } (its docstring + the
// sketch_capture unit-test reference adapter). This is the ONE place the two
// conventions meet, so convert here — passing { x, y } straight through makes
// pxToPlotFrozen read undefined .px/.py → NaN → every sample clamps to the box
// floor (the student's whole sketch collapses to a dot). Mirrors the unit
// test's `pxToPlotFrozen({ px: pt.x, py: pt.y }, ...)`.
function makeSketchPxToPlot(fixedRange) {
  return ({ x, y }) => pxToPlotFrozen({ px: x, py: y }, fixedRange, sketchGeometry(renderer.cssHeight));
}

// EASY hidden pre-run — run the sim ONCE, offscreen, only to SIZE the frame.
// This needs NO sim/engine change: it drives the existing loadScene / SimRunner
// exactly as probeScene does, sampling the sketched scalar per tick into a local
// buffer (never the shared motion-graph `buffers`). The engine is deterministic
// (fixed-dt integrators, no RNG), so the student's later Run reproduces this
// trajectory — but we REVEAL this cached buffer directly, which also sidesteps
// the live buffer's 10 s rolling-eviction on longer runs.
function sketchPreRunBuffer(sceneJson, bodyId, sampleKey) {
  const effectiveJson = planScene(sceneJson).effectiveJson;
  const loaded = loadScene(effectiveJson);
  const integrator = makeIntegrator(effectiveJson.simulation.integrator);
  const dt = effectiveJson.simulation.dt_s;
  const runner = new SimRunner({ loaded, integrator, dt });
  const readV = (b) => {
    if (!b) return NaN;
    if (sampleKey === 'x') return b.position.x;
    if (sampleKey === 'y') return b.position.y;
    if (sampleKey === 'vx') return b.velocity.x;
    if (sampleKey === 'vy') return b.velocity.y;
    return NaN;
  };
  const bodyOf = () => loaded.bodies.find((b) => b.id === bodyId) ?? loaded.bodies[0];
  const buffer = [{ t: 0, v: readV(bodyOf()) }];
  runner.play();
  let iter = 0;
  while (runner.t < runner.duration) {
    runner.tick(dt);
    buffer.push({ t: runner.t, v: readV(bodyOf()) });
    if (++iter > 100000) break; // belt-and-suspenders
  }
  return { buffer, tMax: buffer[buffer.length - 1].t };
}

function mountSketchController(fixedRange) {
  const geom = sketchGeometry(renderer.cssHeight);
  sketchController = new SketchCaptureController({
    pxToPlot: makeSketchPxToPlot(fixedRange),
    onSample: (curve) => { setSketchCurve(curve); drawFrame(); },
    fixedRange,
    binCount: Math.max(1, Math.round(geom.w)),
  });
}

// Enter sketch mode. PRODUCES the session fixedRange (the precondition P3/P4 rest
// on): EASY sizes it from the hidden pre-run buffer; HARD from the student's
// chosen bounds. THEN mounts the controller. Returns false when it cannot start
// (no scene / bad quantity / missing Hard bounds) so the panel keeps its Start
// button.
function startSketch({ mode, quantity, bodyId, bounds }) {
  if (!currentScene) return false;
  const sampleKey = sampleKeyForQuantity(quantity);
  if (!sampleKey) return false;
  const bId = bodyId ?? currentLoaded?.bodies?.[0]?.id ?? null;
  const style = subplotStyleForKey(sampleKey);
  let fixedRange;
  let cachedBuffer = null;
  if (mode === 'hard') {
    if (!bounds || !Number.isFinite(bounds.vMin) || !Number.isFinite(bounds.vMax)) return false;
    const scenarioTMax = planScene(currentScene).effectiveJson.simulation.duration_s;
    fixedRange = frozenAxisRange({ range: { vMin: bounds.vMin, vMax: bounds.vMax } }, bounds.tMax ?? scenarioTMax);
  } else {
    const pre = sketchPreRunBuffer(currentScene, bId, sampleKey);
    fixedRange = frozenAxisRange({ buffer: pre.buffer, accessor: (s) => s.v }, pre.tMax);
    cachedBuffer = pre.buffer;
  }
  enterSketch({
    mode, quantity, bodyId: bId, sampleKey,
    title: style.title, realColor: style.color, sketchColor: SKETCH_STROKE_COLOR,
    fixedRange, cachedBuffer,
  });
  mountSketchController(fixedRange);
  // Sketch BEFORE running: rest paused at t=0.
  currentRunner?.pause();
  toolbar.setPlaying(false);
  inspector.setPaused(true);
  drawFrame();
  return true;
}

// Re-enter after a reveal: blank the frame back to the frozen box (never draw on
// the shown answer) and re-arm the controller. Keeps the SAME frozen frame; no
// retry counter.
function clearSketch() {
  if (!isSketchActive()) return;
  clearSketchForReenter();
  sketchController?.reset();
  drawFrame();
}

// Leave sketch mode entirely (Done). The normal motion-graph overlay resumes.
function cancelSketch() {
  exitSketch();
  sketchController = null;
  drawFrame();
}

// --- Window resize → re-fit camera ---
window.addEventListener('resize', () => {
  renderer.resize();
  if (currentScene) refit();
  // Re-bind the sketch controller's geometry (DPR / canvas-size change moves the
  // subplot box); the captured {t,v} samples are geometry-free and survive.
  if (isSketchActive() && sketchController) {
    const s = getSketchSession();
    const geom = sketchGeometry(renderer.cssHeight);
    sketchController.rebind({ pxToPlot: makeSketchPxToPlot(s.fixedRange), binCount: Math.max(1, Math.round(geom.w)) });
  }
  drawFrame();
});

// Re-apply the active view mode's load-time fit to the current scene.
// Re-runs the trajectory probe so the camera lands on the same frame
// the scene loaded with — no body-tracking, no zoom drift.
function refit() {
  if (!currentScene) return;
  const plan = planScene(currentScene);
  if (renderer.viewMode === 'fit-trajectory' && plan.bounds) {
    renderer.fitToBounds(plan.bounds);
  } else if (currentLoaded) {
    renderer.autoFit(currentLoaded);
  }
}

// --- Mouse wheel → zoom about cursor ---
canvas.addEventListener('wheel', (ev) => {
  if (!currentLoaded) return;
  ev.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const px = { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  // Scale by ~10% per wheel notch; clamp the deltaY contribution so a
  // single trackpad swipe doesn't catapult the camera.
  const k = Math.exp(-Math.max(-1, Math.min(1, ev.deltaY / 100)) * 0.2);
  renderer.zoomAtPoint(k, px);
  drawFrame();
}, { passive: false });

// --- Core actions ---
// sim_trace_ghost P3 — `onComplete(view)` is an OPTIONAL one-shot completion
// hook. It is invoked ONCE inside the `if (view.atEnd)` branch below, right after
// predictPanel.onSimComplete(view), so a caller reading the run result inside
// onComplete sees the panel already updated. Callers that don't pass it (the
// scenario loader, doReset) are byte-unaffected. The idealized-baseline chain
// installs its stage handlers through this seam (ui/baseline.js).
function loadAndStart(sceneJson, onComplete) {
  const v = validateScene(sceneJson);
  if (!v.valid) {
    const errs = v.errors.map((e) => `<code>${e.path}</code>: ${e.message}`).join('<br/>');
    scenarioLoader.showBanner(
      `Scene <code>${sceneJson.id ?? '(no id)'}</code> failed validation:<br/>${errs}`,
      'error'
    );
    return;
  }
  scenarioLoader.hideBanner();
  // sim_trace_ghost P2 — clear captured ghosts ONLY on a scene SWAP (incoming
  // id differs from the OUTGOING currentScene id). A same-id reload (Reset,
  // re-picking the same scenario) KEEPS ghosts so a before/after builds up.
  // Ordering is load-bearing: compare BEFORE currentScene is reassigned below
  // (an after-compare always sees equal ids ⇒ a swap would never clear) and
  // BEFORE the buffer clears. A ghost only makes sense across runs of the SAME
  // scene. (P3's idealizeScene preserves scene.id precisely so its baseline
  // reload does NOT trip this swap-clear and wipe the fresh idealized ghost.)
  if (currentScene?.id !== sceneJson?.id) {
    clearGhosts();
    // sim_lab_notebook P2 — a scene SWAP starts a new experiment, so wipe the
    // notebook here (the SOLE row-wipe site besides the explicit "Clear
    // notebook" button). A same-id reload (between-run Reset) does NOT reach
    // this branch, so accumulated rows survive a Reset.
    notebook.clearNotebook();
  }
  // sim_predict_graph P4 — scenario-change / Reset CASCADE: a scene swap or Reset
  // invalidates the frozen sketch frame (fixedRange, tMax) and the controller's
  // pxToPlot bound to the OLD frame, so DISCARD any in-progress sketch and detach
  // the controller here. The student re-enters via the panel, which recomputes
  // fixedRange for the NEW scenario (Easy re-runs the hidden pre-run) before any
  // input is re-accepted — a switch can never leave the controller mapping
  // pointers through a stale frame.
  exitSketch();
  sketchController = null;
  // Phase 2.3: clear motion-graph buffers on every scene swap or Reset
  // so a fresh run starts with empty curves. Buffers are populated by
  // `recordMotionGraphSample` in the onTick callback below.
  clearMotionGraphBuffers();
  // sim_trace_ghost P1 — clear the trajectory-trace ring buffers on every
  // scene swap or Reset, beside the motion-graph clear, so a fresh run
  // starts with an empty trail.
  clearTraceBuffers();
  currentScene = sceneJson;
  inspector.setScene(sceneJson);
  // sim_lab_notebook P2 — hand the notebook the current scene-config so its
  // scene-sourced descriptors (spring k / friction μ / incline angle) read the
  // run's actual values. In the Reset path this is the MERGED scene (inspector
  // edits already applied), so the run-start read stays accurate.
  notebook.setScene(sceneJson);
  // Probe the scene for its trajectory bounds and (for free-fall
  // scenes) the moment the body lands. The probe runs against a
  // fresh loadScene so the live runner's state isn't disturbed.
  // The effective scene clones the JSON with duration_s clipped to
  // the landing time when one was found, so the runner stops the
  // simulation exactly when the projectile motion ends — even if
  // the user dialed in a different launch via the inspector sliders
  // and pressed Reset.
  const plan = planScene(sceneJson);
  const effectiveJson = plan.effectiveJson;
  currentLoaded = loadScene(effectiveJson);
  const integrator = makeIntegrator(effectiveJson.simulation.integrator);
  currentRunner = new SimRunner({
    loaded: currentLoaded,
    integrator,
    dt: effectiveJson.simulation.dt_s,
    onTick: () => {
      const view = currentRunner.view();
      // sim_trace_ghost P3 — per-frame relay for the baseline controller's
      // termination ceiling (installed by startBaselineRun, cleared by
      // stopBaselineRun / restoreScene). No-op when no baseline is in flight.
      if (baselineTickRelay) baselineTickRelay(view);
      inspector.update(view);
      toolbar.setClock(view.t, view.duration);
      toolbar.setEndOfRun(view.atEnd);
      // Phase 2.6 — keep the scrub slider's visual position in sync
      // with runner.t so the user sees the playhead advance during
      // play. The slider itself is disabled while playing, so this
      // is a one-way display update.
      toolbar.setScrubValue(view.t);
      // Sample once per frame (NOT per integrator step). The runner's
      // onTick fires from tick() / step() / reset(), giving us
      // ~60 Hz at 1x playback regardless of internal dt.
      recordMotionGraphSample(currentLoaded, view.t);
      // sim_trace_ghost P1 — record one world sample per traceable body each
      // tick, beside the motion-graph sample. Dedupes an identical
      // consecutive position, so onTick firing on reset() injects no
      // teleport sample at t=0.
      recordTracePoint(currentLoaded);
      if (view.atEnd) {
        toolbar.setPlaying(false);
        inspector.setPaused(true);
        predictPanel.onSimComplete(view);
        // sim_predict_graph P4 — the student's Run reached its end: REVEAL the
        // real curve over the sketch. The engine is deterministic, so this reuses
        // the existing end-of-run hook as the reveal TRIGGER (P0's deterministic
        // path); the curve drawn is the cached hidden pre-run buffer (Easy) or the
        // live buffer (Hard), both through the SAME frozen frame.
        if (isSketchActive()) { revealSketch(); predictPanel.showSketchReveal(); }
        // sim_lab_notebook P2 — append this run's row (once). A recurring atEnd
        // (scrub-to-end, replay, resume-at-end) is swallowed by the panel's
        // once-per-run latch, so only a genuine completed run adds a row.
        notebook.onSimComplete(view);
        // sim_trace_ghost P3 — fire the one-shot completion seam ONCE on atEnd,
        // right after onSimComplete. The baseline chain's stage handlers ride
        // this; a same-tick capture and the next run's start cannot collide
        // because each stage's onComplete triggers the next stage's loadAndStart.
        onComplete?.(view);
        refreshScrubEnabled();
      }
    }
  });
  const initialView = currentRunner.view();
  predictPanel.reset();
  predictPanel.initWith(initialView);
  // sim_lab_notebook P2 — scene-load hook: register the picker columns present
  // in this scene and arm a fresh run. Rows are NOT wiped here (a between-run
  // Reset preserves the table); the row VALUE is captured later by onRunStart.
  notebook.initWith(initialView);
  inspector.update(initialView);
  const firstBodyId = currentLoaded.bodies[0]?.id ?? null;
  inspector.select(firstBodyId);
  renderer.setSelectedBodyId(firstBodyId);
  inspector.setPaused(true); // newly loaded → paused at t=0
  toolbar.setPlaying(false);
  toolbar.setEndOfRun(false);
  toolbar.setClock(0, effectiveJson.simulation.duration_s);
  // Phase 2.6 — set scrub slider bounds + step from the new scene.
  toolbar.setScrubBounds(effectiveJson.simulation.duration_s, effectiveJson.simulation.dt_s);
  toolbar.setScrubValue(0);
  refreshScrubEnabled();
  // Phase 2.7 — apply per-overlay defaults from the scene's
  // feature_toggles_required. Listed overlays force-enable on load;
  // overlays not listed retain the user's prior manual state (per the
  // Phase 2.7 handoff: "Don't remove the toggle entirely — that
  // breaks teacher exploration"). The setters update both the
  // renderer state and the toolbar button visual state without
  // firing the onXToggle callback (which would trigger a redundant
  // drawFrame and risk a re-entry loop).
  if (requiresOverlay(sceneJson, 'fbd')) {
    renderer.setFbdEnabled(true);
    toolbar.setFbdToggle(true);
  }
  if (requiresOverlay(sceneJson, 'lol')) {
    renderer.setLolEnabled(true);
    toolbar.setLolToggle(true);
  }
  if (requiresOverlay(sceneJson, 'motion-graph')) {
    renderer.setGraphsEnabled(true);
    toolbar.setGraphsToggle(true);
  }
  // roadmap F1 — 'field-overlay' is DELIBERATELY NOT force-enabled here. Unlike
  // fbd/lol/motion-graph, listing it in feature_toggles_required only makes the
  // toggle AVAILABLE; the discovery overlay is NEVER auto-shown (charter
  // anti-target "student-toggle only, default OFF"). The student turns it on via
  // the Field/V button. So there is no requiresOverlay(sceneJson,'field-overlay')
  // → setFieldOverlayEnabled(true) block, on purpose.
  // Seed the buffer with the t=0 sample so the panel doesn't read empty
  // until the first tick lands.
  recordMotionGraphSample(currentLoaded, 0);
  // sim_trace_ghost P1 — set THIS scene's trace arc cap from the same probe
  // box the camera fit consumes (plan.bounds), then seed the t=0 trace
  // sample so a trail exists before the first tick. tracePathCapForBounds
  // handles the null (probe fell back) and degenerate (all-stationary,
  // extent ~ 0) cases, returning the fixed default in both.
  setMaxTracePath(tracePathCapForBounds(plan.bounds));
  recordTracePoint(currentLoaded);

  renderer.resize();
  // Camera fit. fit-trajectory uses the bounds from the probe (which
  // already reflect the actual flight path including landing); other
  // modes just frame the t=0 state.
  if (renderer.viewMode === 'fit-trajectory' && plan.bounds) {
    renderer.fitToBounds(plan.bounds);
  } else {
    renderer.autoFit(currentLoaded);
  }
  drawFrame();
}

// Forward-simulate the scene and report two things back:
//   bounds       — the bounding box of every body position visited.
//                  Used by 'fit-trajectory' to frame the whole motion.
//   landingTime  — the first time any body crosses y ≤ 0 going
//                  downward, ONLY for "free-fall" scenes (gravity
//                  present, no surfaces). null for everything else.
//                  Used to clip runner.duration so a projectile sim
//                  ends exactly when the ball reaches the ground —
//                  regardless of the launch velocity / angle the
//                  user dials in via the inspector sliders.
//
// Free-fall scenes use a long probe horizon (max(JSON duration, 30s))
// so a slow / steep launch that exceeds the JSON's nominal duration
// still gets detected. Other scene types respect the JSON duration so
// pendulums and oscillators don't probe forever.
function probeScene(sceneJson) {
  const hasGravity = (sceneJson.forces ?? []).some((f) => f.type === 'gravity');
  const hasSurfaces = (sceneJson.surfaces ?? []).length > 0;
  const detectLanding = hasGravity && !hasSurfaces;

  const dt = sceneJson.simulation.dt_s;
  const probeMaxT = detectLanding
    ? Math.max(30, sceneJson.simulation.duration_s)
    : sceneJson.simulation.duration_s;
  const probeJson = detectLanding
    ? { ...sceneJson, simulation: { ...sceneJson.simulation, duration_s: probeMaxT } }
    : sceneJson;

  const probeLoaded = loadScene(probeJson);
  const integrator = makeIntegrator(probeJson.simulation.integrator);
  const runner = new SimRunner({ loaded: probeLoaded, integrator, dt });

  const bounds = sceneBounds(probeLoaded);
  const consume = (p) => {
    if (p.x < bounds.minX) bounds.minX = p.x;
    if (p.y < bounds.minY) bounds.minY = p.y;
    if (p.x > bounds.maxX) bounds.maxX = p.x;
    if (p.y > bounds.maxY) bounds.maxY = p.y;
  };
  // DEF-1 — skip `pinned` bodies in the trajectory fit. A pinned body is
  // conceptually static (it stays put only because its scene applies no net
  // force, not via a freeze — scene.js), so the camera must NOT chase its
  // drift: induced_current_1's "pinned" bar carries v=2 m/s and would
  // otherwise drag the fit across ~10 m, collapsing the loop+rod to a few px.
  // Its t=0 position is already framed via sceneBounds.
  for (const b of probeLoaded.bodies) if (!b.pinned) consume(b.position);

  // Step granularity. Landing detection demands per-step precision so
  // we don't overshoot the y=0 crossing by an integration stride;
  // bounds-only probes can subsample for speed.
  const totalSteps = Math.ceil(probeMaxT / dt);
  let stride = detectLanding ? 1 : Math.max(1, Math.floor(totalSteps / 500));

  // sim_oracle_fidelity Phase P1: at-outputs resolve against a DENSE
  // trajectory, so force per-step capture for such scenes. The BOUNDED
  // probe is the browser's `at`-resolution seam (the LIVE interactive
  // runner leaves at-outputs as a null / "pending" sentinel — an event may
  // lie in the user's future/past). Gated on at-scenes, so every existing
  // scene keeps its subsampled probe unchanged. (P1 records here for the
  // architectural seam; the UI consumer lands in a later phase.)
  const needsRecorder = sceneHasAtOutputs(probeJson);
  if (needsRecorder) {
    stride = 1;
    probeLoaded.recorder = new TrajectoryRecorder({
      bodyIds: probeLoaded.bodies.map((b) => b.id),
      offsets: probeLoaded.offsets,
      strides: probeLoaded.strides,
      integrator: probeJson.simulation.integrator,
      dt
    });
    probeLoaded.recorder.record(runner.state, runner.t); // t=0 sample
  }

  let landingTime = null;
  let iter = 0;
  runner.play();
  while (runner.t < runner.duration) {
    runner.tick(dt * stride);
    if (needsRecorder) probeLoaded.recorder.record(runner.state, runner.t);
    for (const b of probeLoaded.bodies) if (!b.pinned) consume(b.position);
    if (detectLanding && landingTime == null) {
      for (const b of probeLoaded.bodies) {
        if (b.position.y <= 0 && b.velocity.y < 0) {
          landingTime = runner.t;
          break;
        }
      }
      if (landingTime != null) break;
    }
    iter++;
    if (iter > 50000) break; // belt-and-suspenders
  }

  if (bounds.maxX - bounds.minX < 1e-3) { bounds.minX -= 1; bounds.maxX += 1; }
  if (bounds.maxY - bounds.minY < 1e-3) { bounds.minY -= 1; bounds.maxY += 1; }
  return { bounds, landingTime };
}

// Probe the scene, override duration to the landing time when one was
// detected, then return the effective scene + bounds. Used by
// loadAndStart so the live runner respects the dynamic stop and the
// camera fit reflects the actual flight path.
function planScene(sceneJson) {
  let probe;
  try {
    probe = probeScene(sceneJson);
  } catch (err) {
    console.warn('[sim] scene probe failed; falling back to JSON duration', err);
    return { effectiveJson: sceneJson, bounds: null };
  }
  const effectiveJson = probe.landingTime != null
    ? { ...sceneJson, simulation: { ...sceneJson.simulation, duration_s: probe.landingTime } }
    : sceneJson;
  return { effectiveJson, bounds: probe.bounds };
}

function doReset() {
  if (!currentScene) return;
  // sim_trace_ghost P3 — if an idealized-baseline chain is mid-flight, CANCEL it
  // FIRST so its pending one-shot atEnd handler no-ops (the lock clear) instead
  // of interleaving a competing chain with this reset's reload. The cancel also
  // detaches the per-frame relay, so this reset's fresh onTick closure relays
  // nothing. No-op when no chain is in flight.
  baselineController.cancel();
  // Pull paused-edits from the inspector and merge into a synthetic
  // copy of the scene JSON via mergeEditsIntoScene. Re-validate the
  // result through validate_scene_browser.js BEFORE re-loading; if
  // invalid, BLOCK the reset and surface the validator message in
  // the banner. Existing edits stay in inspector inputs so the user
  // can fix and press Reset again.
  const edits = inspector.getEdits();
  let nextScene = currentScene;
  if (edits) {
    nextScene = mergeEditsIntoScene(currentScene, edits);
    const v = validateScene(nextScene);
    if (!v.valid) {
      const msgs = v.errors.map((e) => `${e.path}: ${e.message}`).join('; ');
      scenarioLoader.showBanner(
        `Edits produced an invalid scene; reset blocked. ${msgs}`,
        'error'
      );
      return;
    }
    scenarioLoader.hideBanner();
  }
  // sim_trace_ghost P2 — capture the run that JUST finished as a faded ghost.
  // Placement is exact: AFTER the invalid-edits early return above (so a
  // blocked reset never spawns a ghost) and BEFORE inspector.clearEdits()
  // below (so the label diff still sees the pending edits). The label is the
  // value THIS run used — diff the edits against the OUTGOING currentScene and
  // format the BASE value (currentScene's), NEVER the pending next-run value.
  // Partial-run guard: capture ONLY when the outgoing run reached view.atEnd
  // (a complete run); a mid-run Reset leaves no ghost (a truncated curve beside
  // a full next run would mislead). Deep-copy of the still-live trace/graph
  // buffers happens inside captureGhost, BEFORE loadAndStart clears them.
  const outgoingView = currentRunner ? currentRunner.view() : null;
  if (outgoingView && shouldCaptureGhost({ atEnd: outgoingView.atEnd, blockedByInvalidEdits: false })) {
    captureGhost(
      snapshotTraces(),
      snapshotBuffers(),
      outgoingView.energy,
      ghostLabel(edits, currentScene)
    );
  }
  inspector.clearEdits();
  // sim_lab_notebook P2 — a between-run Reset ARMS the next fresh run and
  // PRESERVES accumulated rows (the model is "each Reset + run is a new row").
  // Named the OPPOSITE of clearNotebook so the wipe can never be wired here.
  notebook.onBetweenRunReset();
  loadAndStart(nextScene);
}

// sim_trace_ghost P3 — idealized-baseline run seams (the injected run primitives
// the baselineController drives). startBaselineRun installs the per-frame relay +
// threads the one-shot completion handler through loadAndStart, then plays;
// stopBaselineRun tears both down (pause + detach relay); restoreScene reloads a
// scene LIVE (paused at t=0, NO compare, NOT routed through doReset so it does
// not trigger the doReset auto-capture) for the stage-2 abort restore.
function startBaselineRun(sceneJson, hooks) {
  baselineTickRelay = hooks.onTick ?? null;
  loadAndStart(sceneJson, hooks.onComplete);
  currentRunner?.play();
  toolbar.setPlaying(true);
  inspector.setPaused(false);
  refreshScrubEnabled();
}
function stopBaselineRun() {
  baselineTickRelay = null;
  currentRunner?.pause();
  toolbar.setPlaying(false);
  inspector.setPaused(true);
  refreshScrubEnabled();
}
function restoreScene(sceneJson) {
  baselineTickRelay = null;
  loadAndStart(sceneJson);
}

// The dependency-injected baseline state machine (four stages + re-entrancy
// lock). Built with the REAL seams; the exit-gate tests build it with fakes.
// grounded snapshot: view.energy is the run's final ConservationTracker snapshot
// (the object computeBars consumes), so the ideal ghost + the real live LoL both
// source U_thermal from a real snapshot.
const baselineController = makeBaselineController({
  getCurrentScene: () => currentScene,
  getEdits: () => inspector.getEdits(),
  mergeEditsIntoScene,
  idealizeScene,
  validateScene,
  startRun: startBaselineRun,
  stopRun: stopBaselineRun,
  restoreScene,
  captureGhost,
  snapshotTraces,
  snapshotBuffers,
  getGhosts,
  ghostLol,
  computeBars,
  forceLolOn: () => {
    renderer.setLolEnabled(true);
    toolbar.setLolToggle(true);
    drawFrame();
  },
  showBanner: (message) => scenarioLoader.showBanner(message, 'warn'),
  showRunComparison: (realResult, idealResult) => predictPanel.showRunComparison(realResult, idealResult),
  setBaselineEnabled: (on) => toolbar.setBaselineEnabled(on),
  idealLabel: IDEALIZED_GHOST_LABEL
});

function doIdealizedBaseline() {
  baselineController.run();
}

function doSnapshot() {
  if (!currentRunner) return;
  const out = serializeState(currentLoaded, currentRunner.t);
  const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
  // P2 — the createElement('a') download dance now lives in the shared
  // render/download.js helper; the JSON snapshot and the PNG card both
  // route through triggerDownload (single download path).
  triggerDownload(blob, `${currentScene.id}.state.json`);
}

// P2/P3 — shared card-prep for BOTH the PNG export and the print path
// (anti-copy-paste: one place for the guard/gate change to land). Guards a
// loaded scene, applies the overlay-gate, renders the current frame, and
// composites the card. Returns the composed card, or null on either guarded
// path — and BOTH null-returns surface a visible banner, so a click with no
// scene / no overlay is never a silent dead-click.
function prepareCard() {
  if (!currentRunner) {
    scenarioLoader.showBanner('Load a scene before capturing a card.', 'warn');
    return null;
  }
  if (!anyOverlayActive({ fbd: renderer.showFbd, lol: renderer.showLol, graphs: renderer.showGraphs })) {
    // Descriptive hint — functional, no judgment. 'warn' is a kind
    // showBanner recognizes (only 'error' toggles the error class), so it
    // renders in the default visible style. This is the ONE show-site of the
    // no-overlay hint — doExportCard and doPrintCard both reach it through
    // prepareCard — so noOverlayHintShown is set HERE (travels with the gate),
    // letting maybeClearOverlayHint dismiss exactly this banner and no other.
    scenarioLoader.showBanner('Turn on FBD, LOL, or Graphs to include a model on the card.', 'warn');
    noOverlayHintShown = true;
    return null;
  }
  // drawFrame() renders SYNCHRONOUSLY (renderer.render, no rAF/timeout), so
  // the live canvas holds the current frame the instant composeWhiteboardCard
  // reads it right after.
  drawFrame();
  return composeWhiteboardCard({
    sourceCanvas: canvas,
    title: currentScene.title,
    clockText: formatClockText(currentRunner.t)
  });
}

// P2 — "Whiteboard card" export. Composite the current card and download the
// PNG. prepareCard surfaces the scene/overlay hints and returns null when it
// cannot build a card, so the terminal action only runs on a real card.
function doExportCard() {
  const card = prepareCard();
  if (!card) return;
  cardToBlob(card)
    .then((blob) => triggerDownload(blob, `${currentScene.id}.whiteboard.png`))
    .catch(() => scenarioLoader.showBanner('Could not build the card image — try again.', 'warn'));
}

// P3 — "Print" path. Same card via prepareCard, sent to the browser print
// dialog through the hidden #sim-print-card container.
function doPrintCard() {
  const card = prepareCard();
  if (!card) return;
  openCardForPrint(card);
}

// P3 — inject the card's data-URL image into the hidden #sim-print-card
// container and print. Lives in main.js (not sim/render/) because it uses the
// main.js-local scenarioLoader for its failure banners. Clears any prior
// content first so a repeated print never stacks a second <img> nor leaves a
// stale image when a later print's image fails to load. window.print() is
// gated on the image's load event — a data-URL <img> is not guaranteed to
// decode synchronously, so printing immediately after injection could capture
// an empty container. onerror surfaces the SAME banner as the export .catch
// (symmetric failure surfacing).
function openCardForPrint(card) {
  const host = document.getElementById('sim-print-card');
  if (!host) {
    scenarioLoader.showBanner('Could not open the print card.', 'warn');
    return;
  }
  host.replaceChildren();
  const img = document.createElement('img');
  img.onload = () => window.print();
  img.onerror = () => scenarioLoader.showBanner('Could not open the print card.', 'warn');
  img.src = card.toDataURL('image/png');
  host.appendChild(img);
}

// P2 — dismiss the no-overlay export hint, but ONLY when the currently
// shown banner IS that hint AND at least one overlay is now active.
// Called at the tail of the FBD / LOL / Graphs toggle callbacks, after
// each renderer.setXEnabled, so anyOverlayActive reads the just-updated
// flags. Conditional by design: a blind hideBanner() would clobber any
// banner raised through the shared scenarioLoader seam (scene-load
// errors, the export .catch error, the P3 print error).
function maybeClearOverlayHint() {
  if (noOverlayHintShown && anyOverlayActive({ fbd: renderer.showFbd, lol: renderer.showLol, graphs: renderer.showGraphs })) {
    scenarioLoader.hideBanner();
    noOverlayHintShown = false;
  }
}

// --- rAF tick + render ---
function drawFrame() {
  // T7 — thread sim-time so the circuit current-flow markers drift by the sim
  // clock (freezing on pause, slowing with the playback rate). currentRunner.t
  // is post-step; it is null before the first scene loads → fall back to 0.
  const simTime = currentRunner?.t ?? 0;
  renderer.render(currentLoaded ?? null, simTime);
}

function rAFTick(now) {
  if (lastFrameTime === null) lastFrameTime = now;
  const dt = Math.min(0.1, (now - lastFrameTime) / 1000);
  lastFrameTime = now;
  // T9: recompute the pointer velocity THIS frame ((x_now − x_prev)/wall_dt,
  // via the controller's move()) and poke it — so a held-still pointer
  // yields v=0 ⇒ EMF=0. Poking per rAF frame (not per pointermove) is what
  // makes the held-still case decay. The tick below then integrates the
  // coupled current from this velocity while derivState pins the rod.
  if (isDragging && currentRunner && lastPointerPx) {
    const verdict = dragController.move(lastPointerPx, now / 1000);
    // Paused drag fires no onTick, so refresh the inspector on the poke;
    // a playing drag's tick() (below) refreshes it via onTick — avoid the
    // double update.
    if (verdict && !currentRunner.playing) refreshAfterPoke();
  }
  // T9 surgical suspend: the tick RUNS during a playing drag (so the coupled
  // current keeps integrating + EMF diagnostics stay live); derivState pins
  // the dragged body's motion (sceneCtx.draggingBodyId set above), so the
  // integrator does not fight the pointer. Paused ⇒ tick() is a no-op.
  if (currentRunner) currentRunner.tick(dt);
  drawFrame();
  requestAnimationFrame(rAFTick);
}

// --- Embed pause/resume (showcase wing SW2) ---
// The publicity wing embeds this app in an <iframe> behind the a11y wrapper
// (site/assets/sim_embed.js), which posts { source:"sim_embed", type:"pause"|
// "resume" } when the reader engages, when the card scrolls offscreen, or when
// the tab is hidden. Honor those here so an embedded scene never animates
// unengaged/offscreen. Standalone (non-embedded) use posts no such messages,
// so this is inert outside an embed. The classify decision is the pure
// parseEmbedMessage in embed_boot.js (unit-tested); this only routes it to the
// same runner/toolbar state the Pause/Play toolbar buttons drive.
function embedPause() {
  currentRunner?.pause();
  toolbar.setPlaying(false);
  inspector.setPaused(true);
  refreshScrubEnabled();
}
function embedResume() {
  currentRunner?.play();
  toolbar.setPlaying(true);
  inspector.setPaused(false);
  refreshScrubEnabled();
}
// SW2 T1-b restart — replay the embedded scene from t=0. A bare
// currentRunner.reset()+play() would be WRONG: runner.reset() deliberately does
// NOT reset the tracker (its drift history would carry across the replay — see
// engine/runner.js reset()). So this mirrors the FULL reset-to-t0 path the
// Reset+Play toolbar buttons drive: doReset() rebuilds the runner from a fresh
// loadScene (clean tracker) and re-primes the inspector + toolbar state (paused
// at t=0), then doPlay() launches it exactly like the Play button. Inert
// outside an embed (no restart message is ever posted standalone).
function embedRestart() {
  doReset();
  doPlay();
}
installEmbedControls({
  target: window,
  onPause: embedPause,
  onResume: embedResume,
  onRestart: embedRestart,
});

// prefers-reduced-motion gate for embed autoplay (showcase wing W3). Mirrors
// the SW1 wrapper's reducedMotion() so both layers agree: a reader who asks
// for reduced motion gets NO autonomous motion (the wrapper's engage button
// reads "Step through" and it posts pause on load; this refuses to autoplay).
function prefersReducedMotion() {
  return !!(window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

// --- Boot ---
// Showcase wing SW2 — boot the `?scene=<id>` scene when embedded (falling back
// to DEFAULT_SCENARIO for any missing/unknown id and for standalone use). The
// resolved id is always a registered scene, so a typo can never load an
// unregistered scene.
const bootSceneId = resolveBootSceneId(
  window.location.search,
  SCENARIOS_LIST.map((s) => s.id),
  scenarioLoader.DEFAULT_SCENARIO.id);
// Showcase wing W3 — when embedded (&embed=1), strip the authoring chrome to
// canvas-only (the .sim-embed-minimal CSS in index.html) and, unless the
// reader prefers reduced motion, AUTOPLAY once the scene has loaded so a click
// on the poster lands on a live, moving scene. load() is async (it fetches the
// scene JSON), so the autoplay rides its resolution — currentRunner does not
// exist until onLoad runs. Standalone use sets neither, so the full UI and the
// paused-at-t0 boot are unchanged.
const embedChrome = resolveEmbedChrome(window.location.search);
if (embedChrome) document.body.classList.add('sim-embed-minimal');
scenarioLoader.load(bootSceneId).then((json) => {
  if (json && embedChrome && !prefersReducedMotion()) embedResume();
});
requestAnimationFrame(rAFTick);

// Useful in browser devtools.
window.__sim = {
  get scene() { return currentScene; },
  get loaded() { return currentLoaded; },
  get runner() { return currentRunner; },
  get renderer() { return renderer; },
  drawFrame,
  serializeState: () => serializeState(currentLoaded, currentRunner.t),
  validate: validateScene,
  // Phase 2.3 — motion-graph buffer access for Playwright introspection.
  recordMotionGraphSample: (t) => recordMotionGraphSample(currentLoaded, t),
  clearMotionGraphBuffers,
  // Phase 3 T6 — read a body or diagnostic-channel buffer. Pass a body id
  // for the motion buffer, or a raw diagnostic key for its `chan:`-namespaced
  // channel buffer (the harness asserts a non-flat current/voltage trace).
  getMotionGraphBuffer: (id) => getMotionGraphBuffer(id),
  getChannelBuffer: (diagnosticKey) => getMotionGraphBuffer(channelBufferKey(diagnosticKey)),
  // sim_trace_ghost P1 — trajectory-trace introspection for the manual /
  // Playwright render check (a body's trail is a non-empty world-sample list;
  // a suppressed / placeholder body has none).
  recordTracePoint: () => recordTracePoint(currentLoaded),
  clearTraceBuffers,
  getTrace: (id) => getTraceBuffer(id),
  // Phase 2.6 — scrub seek hook for Playwright introspection.
  timelineSeekTo: (t) => timelineSeekTo(currentRunner, t)
};
