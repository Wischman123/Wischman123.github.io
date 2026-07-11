// render/scatter_plot.js
//
// Standalone scatter helper for the lab-notebook "derive the model" surface
// (sim_lab_notebook P3). Unlike the motion-graph overlay, this helper OWNS its
// own small <canvas> — it is a self-contained plot element, NOT drawn into the
// main sim canvas. It renders one dot per recorded row at (xCol, yCol) with
// axis ticks and NOTHING else: no fitted line, no R², no "matches theory"
// annotation. Deriving the relationship from the dots is the student's job —
// that is the whole pedagogy (see sim/PEDAGOGY.md).
//
// Anti-Kohn: axes carry the student's chosen classroom labels only. No verdict,
// no target, no evaluative copy. Just dots and ranges.
//
// Render-layer contract (mirrors motion_graph.js): a UI panel in sim/ui drives
// this render helper — the sanctioned ui→render direction. This module never
// reaches up into sim/ui, and it holds no engine state.

// Inner-frame margins (CSS pixels). The <canvas> CSS box is sized by the panel
// stylesheet; these govern the axis-frame gutters inside that box.
const PAD_LEFT = 46;    // y-axis tick gutter
const PAD_RIGHT = 14;
const PAD_TOP = 18;     // headroom for the y-axis caption
const PAD_BOTTOM = 30;  // x-axis tick row + caption

// Symmetric window a degenerate (single-value / constant) extent is padded to,
// so the value maps to a finite pixel instead of a ÷0. Chosen so a lone datum
// or an all-equal column centers cleanly in the frame.
const DEGENERATE_EPSILON = 0.5;

// A hair of headroom on a real (nonzero) extent so dots at the exact min/max
// don't sit on the frame edge.
const EXTENT_HEADROOM = 0.05;

// Floor on any span used as a divisor — belt-and-suspenders against a caller
// that hands in an unpadded zero-width extent.
const SPAN_FLOOR = 1e-9;

const DOT_RADIUS = 3.2;
const DOT_FILL = '#2c6fbb';
const FRAME_STROKE = '#c3c8d2';
const TICK_COLOR = '#6b7280';
const CAPTION_COLOR = '#374151';
const AXIS_FONT = '11px system-ui, sans-serif';
const TICK_FONT = '10px system-ui, sans-serif';

// Compute { min, max } over an array of numbers, padding degenerate cases so
// the mapping never divides by zero:
//   - EMPTY / no-finite-values  → null. An empty set has no min/max, so the
//     caller MUST skip auto-scale (return null rather than fabricate ±Inf).
//   - ALL-EQUAL (constant column, or a single-row table where the one value is
//     the whole extent) → a symmetric window centered on the value.
//   - otherwise → the real range with a small symmetric headroom.
// Exported so the mapping can be asserted headlessly (calculate, never eyeball).
export function computeExtent(values) {
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  if (min === max) {
    const pad = Math.abs(min) * 0.1 + DEGENERATE_EPSILON;
    return { min: min - pad, max: max + pad };
  }
  const span = max - min;
  return { min: min - span * EXTENT_HEADROOM, max: max + span * EXTENT_HEADROOM };
}

// Inner axis-frame rectangle for a given CSS canvas size.
export function innerFrame(cssW, cssH) {
  return {
    x: PAD_LEFT,
    y: PAD_TOP,
    w: cssW - PAD_LEFT - PAD_RIGHT,
    h: cssH - PAD_TOP - PAD_BOTTOM
  };
}

// Map one (worldX, worldY) sample to a pixel inside `frame` {x,y,w,h}. Y is
// flipped (world-up → screen-down). Extents come pre-padded from computeExtent,
// so both spans are nonzero; the SPAN_FLOOR is a defensive guard so even a
// hand-built zero-width extent yields a finite pixel (no NaN, no ÷0).
// Exported and pure so the transform is unit-asserted, degenerate inputs and
// all.
export function mapSampleToPixel(worldX, worldY, xExtent, yExtent, frame) {
  const xSpan = Math.max(xExtent.max - xExtent.min, SPAN_FLOOR);
  const ySpan = Math.max(yExtent.max - yExtent.min, SPAN_FLOOR);
  const px = frame.x + ((worldX - xExtent.min) / xSpan) * frame.w;
  const py = frame.y + frame.h - ((worldY - yExtent.min) / ySpan) * frame.h;
  return { px, py };
}

// Read the CSS layout size the plot is drawn at. Prefers the client box (the
// laid-out CSS size); a canvas measured before its first layout pass (or a
// display:none panel) reports 0 / undefined here — the render guard treats that
// as "nothing to draw yet".
function cssSize(canvas) {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  return { w, h };
}

// Render the scatter into `canvas`. `samples` is an array of { x, y } with
// FINITE numbers only — the caller (sim/ui/lab_notebook.js) has already dropped
// any row whose X or Y cell is null, so a blank cell is SKIPPED, never plotted
// at 0. `opts` carries { xLabel, yLabel, dpr }.
//
// Returns true when it drew, false when it BAILED on a degenerate canvas size.
// The size guard is distinct from the data-extent guard: computeExtent guards
// the DATA (empty / constant), this guards the CANVAS (un-laid-out box). Both
// must hold or the transform produces NaN.
export function renderScatter(canvas, samples, opts = {}) {
  if (!canvas || typeof canvas.getContext !== 'function') return false;

  const { w: cssW, h: cssH } = cssSize(canvas);
  // GUARD the canvas extent. A 0 / undefined / non-finite client size gives a
  // degenerate frame (÷0 / NaN) that the data guards below do NOT cover. Bail
  // early — draw nothing, throw nothing — and let the caller redraw once a real
  // size exists.
  if (!Number.isFinite(cssW) || !Number.isFinite(cssH) || cssW <= 0 || cssH <= 0) {
    return false;
  }

  const dpr = Number.isFinite(opts.dpr) && opts.dpr > 0
    ? opts.dpr
    : (globalThis.devicePixelRatio || 1);

  // SIZE the drawing buffer from the intended (CSS) plot size scaled by dpr, and
  // invert that scale in the transform, so world→pixel math stays in CSS units
  // while the buffer stays crisp. Setting the width/height ATTRIBUTES (not CSS)
  // is what avoids a buffer-vs-CSS mismatch (blurry dots, a disagreeing
  // transform).
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);

  const ctx = canvas.getContext('2d');
  if (!ctx) return false;
  if (typeof ctx.setTransform === 'function') ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (typeof ctx.clearRect === 'function') ctx.clearRect(0, 0, cssW, cssH);

  const frame = innerFrame(cssW, cssH);
  drawFrame(ctx, frame);
  drawCaptions(ctx, frame, cssW, cssH, opts.xLabel ?? '', opts.yLabel ?? '');

  // Auto-scale to the data extent. An empty sample set has NO extent
  // (computeExtent → null); render the bare axes box and stop — never
  // auto-scale over an empty set (that is where ±Inf / NaN would come from).
  const xExtent = computeExtent(samples.map((s) => s.x));
  const yExtent = computeExtent(samples.map((s) => s.y));
  if (!xExtent || !yExtent) return true;

  drawTicks(ctx, frame, xExtent, yExtent);

  ctx.fillStyle = DOT_FILL;
  for (const s of samples) {
    const { px, py } = mapSampleToPixel(s.x, s.y, xExtent, yExtent, frame);
    if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
    ctx.beginPath();
    ctx.arc(px, py, DOT_RADIUS, 0, Math.PI * 2);
    ctx.fill();
  }
  return true;
}

function drawFrame(ctx, frame) {
  ctx.strokeStyle = FRAME_STROKE;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.rect(frame.x, frame.y, frame.w, frame.h);
  ctx.stroke();
}

function drawCaptions(ctx, frame, cssW, cssH, xLabel, yLabel) {
  ctx.fillStyle = CAPTION_COLOR;
  ctx.font = AXIS_FONT;
  // x caption centered under the frame.
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText(xLabel, frame.x + frame.w / 2, cssH - 2);
  // y caption at the top-left, above the frame (drawn horizontally — no
  // rotate() dependency, so the headless stub stays tiny).
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(yLabel, 2, 2);
}

function drawTicks(ctx, frame, xExtent, yExtent) {
  ctx.fillStyle = TICK_COLOR;
  ctx.font = TICK_FONT;
  // x-axis min (left) / max (right), just under the frame.
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.fillText(fmtTick(xExtent.min), frame.x, frame.y + frame.h + 3);
  ctx.textAlign = 'right';
  ctx.fillText(fmtTick(xExtent.max), frame.x + frame.w, frame.y + frame.h + 3);
  // y-axis max (top) / min (bottom), in the left gutter.
  ctx.textAlign = 'right';
  ctx.textBaseline = 'top';
  ctx.fillText(fmtTick(yExtent.max), frame.x - 3, frame.y);
  ctx.textBaseline = 'bottom';
  ctx.fillText(fmtTick(yExtent.min), frame.x - 3, frame.y + frame.h);
}

// Compact axis-range formatter (mirrors motion_graph's tick style).
function fmtTick(v) {
  if (!Number.isFinite(v)) return '?';
  const abs = Math.abs(v);
  if (abs === 0) return '0';
  if (abs >= 100) return v.toFixed(0);
  if (abs >= 10) return v.toFixed(1);
  if (abs >= 0.1) return v.toFixed(2);
  return v.toExponential(1);
}

export const NAME = 'scatter_plot';
