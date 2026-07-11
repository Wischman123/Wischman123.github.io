// render/sketch_state.js
//
// Predict-the-graph (plan sim_predict_graph, Phase P4) — the SINGLE OWNER of the
// sketch SESSION: the `sketchMode` flag, the captured sketch curve, the frozen
// `fixedRange`, and the per-session render descriptors (which quantity, which
// colors, whether the real curve is revealed yet).
//
// WHY a module-scope store (not three per-module copies). The render loop is
// stateless-per-frame — `canvas2d.js` redraws every overlay fresh each frame —
// so the sketched curve and the "are we sketching?" flag must live in a
// persistent home to survive the ~60 Hz redraws, exactly as the motion-graph
// curve survives via the module-scope `buffers` Map in `motion_graph.js`.
// `canvas2d.js` READS this every frame to route to `drawSketchOverlay`;
// `main.js` READS it to short-circuit `dragController` on `pointerdown`;
// `predict.js`/`main.js` WRITE it across the sketch lifecycle. One owner, one
// home — no divergent copy.
//
// WHY it lives in `sim/render/` (not `sim/ui/`). `canvas2d.js` (render layer)
// must import it every frame, and the render layer NEVER imports up into
// `sim/ui/` (render→engine is the only sanctioned down-import; render→ui is
// backwards). The `buffers` curve store already lives in the render layer for
// the same reason, so this store sits beside its precedent. `main.js` and
// `predict.js` are UI-layer and import DOWN into render freely (as `main.js`
// already does), so they can write through the accessors below.
//
// The sketch controller (ui/sketch_capture.js) has NO runner: unlike
// PointerDragController.end() which commits to the runner and nulls its gesture
// state (the RUNNER then owns the result), the completed sketch curve must
// survive the controller's end() and be handed HERE, or the later reveal has
// nothing to draw. `onSample(curve)` writes via setSketchCurve; the reveal reads
// it via getSketchSession().

// The active session, or null when not sketching. Shape:
//   {
//     mode:       'easy' | 'hard',
//     quantity:   'position.x' | 'position.y' | 'velocity.x' | 'velocity.y',
//     bodyId,               // whose live motion-graph buffer reveals the real
//                           //   curve in Hard mode
//     sampleKey:  'x'|'y'|'vx'|'vy',  // reads a body sample {t,x,y,vx,vy,ax,ay}
//     title,                // subplot y-axis title (from the SUBPLOTS palette)
//     realColor,            // SOLID real-curve stroke color (SUBPLOTS palette)
//     sketchColor,          // DASHED neutral sketch stroke color (never red/green)
//     fixedRange,           // { tMin, tMax, vMin, vMax } — frozen for the session
//     cachedBuffer,         // EASY: the hidden pre-run buffer [{t,v}] (revealed
//                           //   as-is, deterministic, immune to the live 10 s
//                           //   rolling-eviction); HARD: null (reveal pulls the
//                           //   live buffer)
//     sketchCurve,          // segmented [[{t,v},…],…] — written by onSample
//     revealed,             // has the student's Run revealed the real curve?
//   }
let session = null;

// The four buffer-sample keys the sketch can plot, keyed by the student-facing
// quantity. This is BOTH the sketch-eligibility filter (charter limits sketching
// to v-t OR x-t — POSITION and VELOCITY only) AND the real-buffer read key. A
// quantity absent here (speed, energy.K, energy.total, any future acceleration)
// is NOT sketchable, so the panel never offers an unsupported quantity.
const SAMPLE_KEY_FOR = {
  'position.x': 'x',
  'position.y': 'y',
  'velocity.x': 'vx',
  'velocity.y': 'vy',
};

// Sketch-eligibility predicate (charter: v-t OR x-t only). Exactly the four
// keys above — the buffer reality (recordSample stores x,y,vx,vy) and the filter
// agree by construction, so the panel can never offer a quantity the reveal
// cannot read.
export function isSketchableQuantity(quantity) {
  return Object.prototype.hasOwnProperty.call(SAMPLE_KEY_FOR, quantity);
}

// Map a student-facing quantity to its body-sample key, or null when the
// quantity is not sketchable.
export function sampleKeyForQuantity(quantity) {
  return SAMPLE_KEY_FOR[quantity] ?? null;
}

// Enter sketch mode with a fully-specified session. Always starts un-revealed
// with an empty sketch curve. Overwrites any prior session (a fresh Start is a
// clean session — no retry counter, no accumulated state).
export function enterSketch(config) {
  session = {
    mode: config.mode,
    quantity: config.quantity,
    bodyId: config.bodyId ?? null,
    sampleKey: config.sampleKey,
    title: config.title,
    realColor: config.realColor,
    sketchColor: config.sketchColor,
    fixedRange: config.fixedRange,
    cachedBuffer: config.cachedBuffer ?? null,
    sketchCurve: [],
    revealed: false,
  };
  return session;
}

// Leave sketch mode entirely (Cancel / scenario swap). The normal motion-graph
// overlay resumes.
export function exitSketch() {
  session = null;
}

// The `sketchMode` flag — the SINGLE accessor canvas2d.js / main.js read.
export function isSketchActive() {
  return session !== null;
}

// The whole session (read-only from the caller's perspective — mutate only via
// the setters below). Null when not sketching.
export function getSketchSession() {
  return session;
}

// onSample writes the freshly-captured SEGMENTED curve here; drawSketchOverlay
// reads it back next frame. No-op when not sketching (a late onSample after
// exit cannot resurrect a session).
export function setSketchCurve(curve) {
  if (!session) return;
  session.sketchCurve = Array.isArray(curve) ? curve : [];
}

// Reveal the real curve (the student's Run reached its end). Idempotent.
export function revealSketch() {
  if (!session) return;
  session.revealed = true;
}

// Re-enter after a reveal: CLEAR the revealed real curve back to the blank
// frozen frame AND drop the prior sketch, so the student never draws on top of
// the shown answer (a trace-the-answer path that would defeat predict-before-run
// — an anti-target). Keeps the SAME frozen frame (fixedRange, cachedBuffer) so
// the axes do not move, and increments NO retry counter (there is none).
export function clearSketchForReenter() {
  if (!session) return;
  session.revealed = false;
  session.sketchCurve = [];
}

// Re-freeze the frame in place (Hard-mode bounds re-commit, or the scenario-
// change cascade that recomputes fixedRange for the NEW scenario). Discards the
// in-progress sketch and un-reveals, since the old sketch was drawn against the
// stale frame.
export function reframeSketch({ fixedRange, cachedBuffer = null } = {}) {
  if (!session) return;
  if (fixedRange) session.fixedRange = fixedRange;
  session.cachedBuffer = cachedBuffer;
  session.sketchCurve = [];
  session.revealed = false;
}

export const NAME = 'sketch_state';
