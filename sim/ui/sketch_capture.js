// ui/sketch_capture.js
//
// Predict-the-graph (plan sim_predict_graph, Phase P3) — the HEADLESS input
// HALF of the feature: it turns a pointer/touch drag across the FROZEN motion
// subplot into a sampled predicted curve, with zero rendering and zero DOM
// import. It is the sketch sibling of ui/pointer_drag.js: same injected-I/O
// pattern (all mapping + emit hooks are injected, so the whole gesture machine
// is unit-tested headless), but instead of poking a live body it CAPTURES a
// path into a segmented curve for P4 to overlay.
//
// Two controllers live here, both injected-I/O and both headless-tested:
//
//   SketchCaptureController — mode-agnostic curve capture. It inverts each
//     pointer sample through an injected `pxToPlot(px) => {t, v}` (the caller
//     binds P2's exported `pxToPlotFrozen` with THIS session's fixed frame plus
//     the live subplot geometry) and accumulates the drawn path into a SEGMENTED
//     curve `[[{t, v}, …], …]` — one v per t-bin, one sub-curve per contiguous
//     drawn run. Serves BOTH P0 modes (Easy + Hard).
//
//   BoundsPickerController — the HARD-mode pre-step only. The student chooses
//     the axis bounds; this controller emits the chosen `{ vMin, vMax }` (plus
//     an optional scenario-authored `tMax`) that feeds P2's
//     `frozenAxisRange({ range }, tMax)` `range` path to freeze the frame. It is
//     UX-agnostic: it consumes abstract setter calls and emits a range; the
//     actual widget is P4's concern. In EASY mode this step is SKIPPED — the
//     frame comes from P4's hidden pre-run buffer via
//     `frozenAxisRange({ buffer }, tMax)` instead.
//
// --- Single source of truth for geometry + mapping ---
// This module NEVER re-derives the plot geometry or the px↔plot map. The caller
// binds the injected `pxToPlot` to P2's `pxToPlotFrozen(px, fixedRange, geom)`
// where `geom = subplotGeometry(panelAnchor, entriesCount, index)` — the exact
// inverse of the forward map the frame is drawn with — so capture and overlay
// bind identical geometry.
//
// --- Geometry is NOT known at construction and MUST be re-bindable ---
// `subplotGeometry` (the subplot `{ x0, y0, w, h }`) is supplied by P4's
// canvas2d render layout, not at P3 construction, and it can SHIFT mid-sketch.
// Every cause below moves `x0, y0, w, h`, and a stale binding would map a
// pointer px to the WRONG `{ t, v }`. On ANY of these, the caller MUST call
// `rebind(...)` with a freshly-bound `pxToPlot` (and the px-width-derived
// `binCount`) BEFORE the next sample is taken:
//   1. canvas resize            (w, h and origin move)
//   2. device-pixel-ratio (DPR) change (backing-store scale shifts px)
//   3. panel reflow mid-sketch  (stacking anchor moves y0)
//   4. P4 moving the subplot     (multi-subplot routing repositions it)
// The controller is headless, so it CANNOT observe these itself — the P4 DOM
// binding listens for them and calls `rebind`. There is deliberately no pinned
// fixed-size assumption: the re-bind contract makes any geometry change safe.
//
// --- t-bin resolution: computed, not hardcoded ---
// The default bin count is ONE bin per plotting-column, i.e.
// `binCount = Math.max(1, Math.round(geom.w))` — available under BOTH P0
// options and computed from the frozen frame's px-width, NOT keyed to a
// real-curve sample count (the real curve does not exist yet at sketch time
// under the Easy pre-run-after-sketch flow). The overlay does not require
// matching bin counts — `drawSubplot` maps each curve's samples independently —
// so this is purely a sketch-fidelity choice. The caller passes it (and re-passes
// it on `rebind` when `geom.w` changes); a defensive fallback constant applies
// only when the caller omits it.
//
// --- Gaps vs. fills: pen-lift is the ONLY break ---
// A student may draw only part of `[0, tMax]`, or lift mid-stroke and resume
// further right, leaving interior empty bins. Those un-drawn interior bins are
// a real GAP and must NOT be bridged — the output is SEGMENTED so P4 strokes
// each run separately with no connecting line across the gap. But a fast
// horizontal drag emits SPARSE `pointermove` events that skip interior bins
// WITHIN one continuous stroke; those are a sampling gap, NOT a pen-lift, so we
// FILL them by interpolating v along the pointer path between consecutive
// samples. A segment break is recorded ONLY on a pen-up → pen-down transition
// (end → begin). Result: a two-sample fast drag spanning many bins yields ONE
// segment; a lift-and-resume yields TWO.
//
// --- Clamp semantics (aligned with P0/P2) ---
// A pointer outside the plotting box is CLAMPED to the box edge (the generous
// frozen frame `[0, tMax] × [vMin, vMax]`), never dropped and never clamped
// toward any answer band — an over-prediction still draws, bounded.

import {
  clampSampleToBox,
  binIndexForT,
  binCenterT,
  normalizeBinCount,
} from './sketch_geometry.js';

// A press that never travels this far (CSS px) stays a tap — it selects /
// does nothing but does NOT lay down a curve. Mirrors pointer_drag.js:48.
export const DRAG_THRESHOLD_PX = 3;

// Fill every bin the segment prev→curr crosses with v interpolated ALONG the
// pointer path, writing into `bins` (a Map<binIndex, v>) latest-wins. Both
// samples are already clamped to the box. This is the WITHIN-stroke fill that
// turns sparse fast-drag samples back into one continuous line; it is NOT the
// forbidden cross-gap bridge (that only ever happens across a pen-lift, which
// this never spans — it only fills between two samples of ONE stroke).
function fillSpan(bins, prev, curr, fixedRange, binCount) {
  const iA = binIndexForT(prev.t, fixedRange, binCount);
  const iB = binIndexForT(curr.t, fixedRange, binCount);
  const lo = Math.min(iA, iB);
  const hi = Math.max(iA, iB);
  const dt = curr.t - prev.t;
  for (let i = lo; i <= hi; i++) {
    let v;
    if (dt === 0) {
      // Vertical move (same t-bin, back-track in v): the latest v wins.
      v = curr.v;
    } else {
      const tc = binCenterT(i, fixedRange, binCount);
      let frac = (tc - prev.t) / dt;
      if (frac < 0) frac = 0;
      if (frac > 1) frac = 1;
      v = prev.v + (curr.v - prev.v) * frac;
    }
    bins.set(i, v);
  }
  // Pin the endpoint bin to the exact sample value so the drawn endpoint is
  // faithful (interpolation at the bin center can drift a hair off).
  bins.set(iB, curr.v);
}

// Bin ONE stroke's ordered raw samples into a Map<binIndex, v>. Samples are
// processed in event order so a back-track (non-monotonic t) OVERWRITES the
// revisited bins rather than doubling back — the output stays single-valued in
// t (a function graph). Interior bins between consecutive samples are filled
// (see fillSpan). A stroke's occupied bins are therefore one contiguous run.
function binStroke(samples, fixedRange, binCount) {
  const bins = new Map();
  if (samples.length === 0) return bins;
  const first = samples[0];
  bins.set(binIndexForT(first.t, fixedRange, binCount), first.v);
  for (let i = 1; i < samples.length; i++) {
    fillSpan(bins, samples[i - 1], samples[i], fixedRange, binCount);
  }
  return bins;
}

// Merge each stroke's bins into ONE global Map in stroke order. Later strokes
// overwrite overlapping bins (a redraw over the same t-region wins). Because a
// stroke only ever fills ITS OWN contiguous bin span, the un-drawn bins between
// two pen-lifted strokes stay empty — the gap survives, ready to segment.
function mergeStrokeBins(strokes, fixedRange, binCount) {
  const global = new Map();
  for (const samples of strokes) {
    const b = binStroke(samples, fixedRange, binCount);
    for (const [i, v] of b) global.set(i, v);
  }
  return global;
}

// Split a global Map<binIndex, v> into SEGMENTED sub-curves: one array of
// `{ t, v }` per contiguous run of occupied bins, sorted by t. A single
// occupied bin yields a one-sample segment. An empty Map yields `[]`. This is
// the shape the whole feature forbids P4 from bridging across.
export function segmentBins(global, fixedRange, binCount) {
  const indices = [...global.keys()].sort((a, b) => a - b);
  const segments = [];
  let run = null;
  let prevIdx = null;
  for (const idx of indices) {
    if (prevIdx === null || idx !== prevIdx + 1) {
      run = [];
      segments.push(run);
    }
    run.push({ t: binCenterT(idx, fixedRange, binCount), v: global.get(idx) });
    prevIdx = idx;
  }
  return segments;
}

export class SketchCaptureController {
  // Injected I/O — mirrors PointerDragController's DI shape:
  //   pxToPlot(px) => { t, v }  — P2's pxToPlotFrozen pre-bound with THIS
  //                               session's fixedRange + the live subplot geom.
  //   onSample(curve)           — called with the current SEGMENTED curve
  //                               whenever it changes (each move past threshold,
  //                               each pen-up, cancel, reset).
  //   fixedRange { tMin, tMax, vMin, vMax } — the frozen frame from
  //                               frozenAxisRange; used to CLAMP to the box edge.
  //                               Frozen for the session (only geom changes).
  //   binCount                  — one bin per plotting-column, Math.round(geom.w).
  constructor({ pxToPlot, onSample, fixedRange, binCount } = {}) {
    if (typeof pxToPlot !== 'function') {
      throw new Error('SketchCaptureController requires a pxToPlot(px) => {t, v} function');
    }
    if (typeof onSample !== 'function') {
      throw new Error('SketchCaptureController requires an onSample(curve) callback');
    }
    if (!fixedRange
      || !Number.isFinite(fixedRange.tMax)
      || !Number.isFinite(fixedRange.vMin)
      || !Number.isFinite(fixedRange.vMax)) {
      throw new Error('SketchCaptureController requires a fixedRange { tMin, tMax, vMin, vMax }');
    }
    this.pxToPlot = pxToPlot;
    this.onSample = onSample;
    // Normalize tMin to 0 if the caller passed only { tMax, vMin, vMax }.
    this.fixedRange = {
      tMin: Number.isFinite(fixedRange.tMin) ? fixedRange.tMin : 0,
      tMax: fixedRange.tMax,
      vMin: fixedRange.vMin,
      vMax: fixedRange.vMax,
    };
    this.binCount = normalizeBinCount(binCount);
    // Committed strokes: array of ordered raw-sample arrays (one per ended
    // stroke). Raw {t,v} are stored (NOT pre-binned) so a binCount change on
    // rebind re-bins consistently at emit time.
    this._strokes = [];
    // In-progress stroke, or null. { pointerId, startPx, moved, samples[] }.
    this._stroke = null;
    // Count of accepted move events this session (one raw sample per move) —
    // exposed so a test can assert one-sample-per-move (NOT one-per-frame).
    this._moveCount = 0;
  }

  get sketching() { return this._stroke !== null; }
  get activePointerId() { return this._stroke ? this._stroke.pointerId : null; }
  get moveSampleCount() { return this._moveCount; }

  // The current SEGMENTED curve `[[{t,v},…],…]` over committed strokes plus the
  // in-progress stroke (if it has crossed the threshold). Re-derived on read so
  // a mid-sketch binCount change (rebind) re-bins everything consistently.
  get curve() {
    const strokes = this._effectiveStrokes();
    const global = mergeStrokeBins(strokes, this.fixedRange, this.binCount);
    return segmentBins(global, this.fixedRange, this.binCount);
  }

  _effectiveStrokes() {
    if (this._stroke && this._stroke.moved && this._stroke.samples.length > 0) {
      return [...this._strokes, this._stroke.samples];
    }
    return this._strokes;
  }

  // Invert a raw pointer px through the CURRENT injected map, then clamp to the
  // frozen box edge. Every sample flows through here, so a rebind between two
  // samples is honored the moment it lands.
  _sample(px) {
    return clampSampleToBox(this.pxToPlot(px), this.fixedRange);
  }

  // Rebind the geometry-dependent inputs after ANY geom change (see header for
  // the four causes). Pass a freshly-bound pxToPlot and the px-width-derived
  // binCount. Captured samples keep their {t,v} (physics coords, geom-free); only
  // FUTURE samples and re-binning use the new mapping/resolution. Named `rebind`;
  // it plays the "setGeometry" role but takes the pre-bound closure so this
  // module never imports the renderer.
  rebind({ pxToPlot, binCount } = {}) {
    if (typeof pxToPlot === 'function') this.pxToPlot = pxToPlot;
    if (binCount !== undefined) this.binCount = normalizeBinCount(binCount);
    return this;
  }

  // Pen-down. Starts a stroke and latches the pointer id (primary-pointer-only:
  // once a stroke is active, a DIFFERENT pointer id is ignored so a second touch
  // cannot perturb the sketch). Returns the latched id, or null if ignored.
  begin(px, pointerId = 0) {
    if (this._stroke) return null; // a stroke is already active — ignore extras
    this._stroke = {
      pointerId,
      startPx: { x: px.x, y: px.y },
      moved: false,
      samples: [],
    };
    return pointerId;
  }

  // Pointer-move. Below the threshold this is a no-op (a tap must lay down no
  // curve). On the first move past the threshold it seeds the pen-down sample,
  // then records this move's sample; each later move records exactly ONE sample.
  // A move from a non-latched pointer is ignored. Returns the clamped { t, v }
  // sample, or null when ignored / still below threshold.
  move(px, pointerId = 0) {
    const d = this._stroke;
    if (!d) return null;
    if (pointerId !== d.pointerId) return null; // secondary pointer ignored
    if (!d.moved) {
      const dpx = Math.hypot(px.x - d.startPx.x, px.y - d.startPx.y);
      if (dpx < DRAG_THRESHOLD_PX) return null;
      d.moved = true;
      d.samples.push(this._sample(d.startPx)); // seed the pen-down sample
    }
    const sample = this._sample(px);
    d.samples.push(sample);
    this._moveCount += 1;
    this.onSample(this.curve);
    return sample;
  }

  // Pen-up. Commits the in-progress stroke as its own segment (a later pen-down
  // begins a NEW segment — the ONLY place a break is recorded). A tap (never
  // past threshold) commits nothing. A move from a non-latched pointer is
  // ignored. Returns the committed SEGMENTED curve, or null on a tap / no stroke.
  end(pointerId = 0) {
    const d = this._stroke;
    if (!d) return null;
    if (pointerId !== d.pointerId) return null; // secondary pointer's up ignored
    this._stroke = null;
    if (!d.moved || d.samples.length === 0) return null; // tap → nothing
    this._strokes.push(d.samples);
    const curve = this.curve;
    this.onSample(curve);
    return curve;
  }

  // Pointercancel / lost capture — DISCARD the in-progress stroke (browsers fire
  // this on gesture interruption). Committed strokes stand. If a preview was
  // showing, re-emit the reverted curve so the overlay drops the abandoned line.
  cancel() {
    const d = this._stroke;
    this._stroke = null;
    if (!d) return null;
    if (d.moved) this.onSample(this.curve);
    return null;
  }

  // Clear the whole sketch (student redraws from scratch). Emits the now-empty
  // curve so the overlay clears.
  reset() {
    this._strokes = [];
    this._stroke = null;
    this._moveCount = 0;
    this.onSample(this.curve);
    return this;
  }
}

// HARD-mode axis-bounds picker. UX-agnostic, injected-I/O, headless: it consumes
// abstract setter calls and EMITS a chosen range that feeds P2's
// frozenAxisRange `range` path. The frozen frame it produces is
// `frozenAxisRange({ range: { vMin, vMax } }, tMax)` — P2 then widens the band by
// HARD_RANGE_HEADROOM_M so an over/under-prediction still draws. In EASY mode
// this controller is not instantiated at all (the frame comes from the hidden
// pre-run buffer path). The widget that drives it is P4's concern.
export class BoundsPickerController {
  constructor({ onRange, tMax = null, initial = null } = {}) {
    if (typeof onRange !== 'function') {
      throw new Error('BoundsPickerController requires an onRange(range) callback');
    }
    this.onRange = onRange;
    this.tMax = (tMax != null && Number.isFinite(Number(tMax))) ? Number(tMax) : null;
    this._vMin = null;
    this._vMax = null;
    if (initial) {
      if (Number.isFinite(Number(initial.vMin))) this._vMin = Number(initial.vMin);
      if (Number.isFinite(Number(initial.vMax))) this._vMax = Number(initial.vMax);
    }
  }

  setVMin(v) { if (Number.isFinite(Number(v))) this._vMin = Number(v); return this; }
  setVMax(v) { if (Number.isFinite(Number(v))) this._vMax = Number(v); return this; }

  setBounds({ vMin, vMax, tMax } = {}) {
    if (vMin != null) this.setVMin(vMin);
    if (vMax != null) this.setVMax(vMax);
    if (tMax != null && Number.isFinite(Number(tMax))) this.tMax = Number(tMax);
    return this;
  }

  // Both bounds chosen yet?
  get ready() { return this._vMin != null && this._vMax != null; }

  // The normalized chosen range, or null if not ready. vMin/vMax are ordered
  // (swapped if the student set them inverted — they are by definition the two
  // ends of an axis, not an answer, so ordering is a UX nicety not a clamp
  // toward anything). tMax is attached only when the scenario authored one.
  get range() {
    if (!this.ready) return null;
    let lo = this._vMin;
    let hi = this._vMax;
    if (lo > hi) { const t = lo; lo = hi; hi = t; }
    const r = { vMin: lo, vMax: hi };
    if (this.tMax != null) r.tMax = this.tMax;
    return r;
  }

  // Emit the chosen range via onRange and return it, or null (no emit) if the
  // student has not set both bounds. The caller feeds it to
  // frozenAxisRange({ range: { vMin, vMax } }, range.tMax ?? scenarioTMax).
  commit() {
    const r = this.range;
    if (!r) return null;
    this.onRange(r);
    return r;
  }
}
