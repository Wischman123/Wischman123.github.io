// ui/sketch_geometry.js
//
// Pure, side-effect-free decision boundaries for the predict-the-graph sketch
// capture (plan sim_predict_graph, Phase P3). Split out from
// sketch_capture.js so each boundary — the box CLAMP and the t-BINNING — is a
// standalone pure function with a negative case, unit-tested directly (the
// "test the decision boundary, not the heuristic" convention). No DOM, no render
// import, no state.
//
// These map the FROZEN frame `fixedRange = { tMin, tMax, vMin, vMax }` (from
// P2's frozenAxisRange) and the caller's px-width-derived `binCount`. They do
// NOT re-derive the px↔plot geometry — that stays in P2's pxToPlotFrozen, which
// the controller injects. These only operate in plot coords (t, v) and bin
// indices, both geometry-free.

// Tiny span floor so a degenerate frame never divides by zero. Mirrors the
// intent of motion_graph.js's AXIS_SPAN_EPS (P2 already floors valSpan/tMax at
// frame-construction time, so this is a belt-and-suspenders guard).
const SPAN_EPS = 1e-9;

// Defensive default when the caller omits binCount. The PRIMARY path is
// caller-supplied `Math.max(1, Math.round(geom.w))` (one bin per plotting-
// column); this constant only keeps the controller from crashing if that is
// missing, and is deliberately coarse so a missing binCount is noticeable.
export const FALLBACK_BIN_COUNT = 120;

// Coerce an arbitrary binCount input to a usable positive integer. Non-finite,
// zero, or negative → the fallback. A fractional value rounds (the caller passes
// Math.round(geom.w), but a raw geom.w is tolerated).
export function normalizeBinCount(binCount) {
  const n = Math.round(Number(binCount));
  if (!Number.isFinite(n) || n < 1) return FALLBACK_BIN_COUNT;
  return n;
}

function clamp(x, lo, hi) {
  if (Number.isNaN(x)) return lo; // NaN (impossible from a real px) → box floor, never NaN
  if (x < lo) return lo;          // handles -Infinity → lo
  if (x > hi) return hi;          // handles +Infinity → hi
  return x;
}

// Clamp a plot sample to the frozen plotting BOX edge: t → [tMin, tMax],
// v → [vMin, vMax]. A pointer outside the box is BOUNDED to the edge, never
// dropped and never pulled toward any answer band — an over-prediction still
// draws. `fixedRange.tMin` defaults to 0 (frozenAxisRange always sets tMin: 0).
export function clampSampleToBox(sample, fixedRange) {
  const tMin = Number.isFinite(fixedRange.tMin) ? fixedRange.tMin : 0;
  return {
    t: clamp(sample.t, tMin, fixedRange.tMax),
    v: clamp(sample.v, fixedRange.vMin, fixedRange.vMax),
  };
}

// Map a (clamped) t to its bin index in [0, binCount-1]. One bin per plotting-
// column by default. t is expected pre-clamped to [tMin, tMax], so the index is
// clamped to the valid range as a final guard (t === tMax lands in the last bin,
// not an out-of-range binCount).
export function binIndexForT(t, fixedRange, binCount) {
  const tMin = Number.isFinite(fixedRange.tMin) ? fixedRange.tMin : 0;
  const span = Math.max(fixedRange.tMax - tMin, SPAN_EPS);
  let idx = Math.floor(((t - tMin) / span) * binCount);
  if (idx < 0) idx = 0;
  if (idx > binCount - 1) idx = binCount - 1;
  return idx;
}

// The t at the CENTER of a bin — where a bin's stored v is drawn. Inverse-ish of
// binIndexForT (bin center, not edge), so a round-tripped sample lands mid-bin.
export function binCenterT(binIndex, fixedRange, binCount) {
  const tMin = Number.isFinite(fixedRange.tMin) ? fixedRange.tMin : 0;
  const span = Math.max(fixedRange.tMax - tMin, SPAN_EPS);
  return tMin + ((binIndex + 0.5) / binCount) * span;
}
