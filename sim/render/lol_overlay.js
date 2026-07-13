// render/lol_overlay.js
//
// LOL energy-bar overlay. Renders the system's current energy
// composition as one vertical bar per store (K + U_g + U_e + U_thermal +
// any future contributions) anchored at the BOTTOM-LEFT of the canvas.
//
// There is deliberately NO total-energy reference line. An earlier build
// drew the initial total as a horizontal rule across the bars; on a scene
// whose datum makes a store negative it floats mid-panel and reads as a
// stray axis, and it competes with the bars for attention without telling a
// student anything the bar heights don't. Conservation is still reported —
// as the `total` and `drift` text readouts under the bars. If a reference
// line ever comes back it belongs behind a flag, not on the story embed.
//
// The overlay is RENDER-LAYER ONLY — it reads `loaded.tracker.current()`
// (already computed by the runner each step) and draws. Zero engine
// state added; zero engine files touched. Mirrors the universality
// pattern established by sim/render/fbd_overlay.js.
//
// The contributions map is OPEN: ConservationTracker emits whatever
// keys the active Force classes provide (`U_g`, `U_e`, `U_thermal`,
// future `U_electric`, etc.). The overlay dispatches against the
// keys present at render time — no hardcoded list — so a new Force
// class lights up here automatically without touching this file.
//
// Anti-Kohn: bars are labeled by quantity, not by judgment. No
// "energy lost" framing for U_thermal — it is just another
// contribution to the total. Drift is reported as a neutral
// diagnostic, not as an evaluative percent-error metric.

// Locked palette (handoff §"Locked design decisions" for Phase 2.2):
//   K green, U_g blue, U_e purple, U_thermal red. Family-keyed against
//   the FBD palette so a teacher who toggles both overlays sees the
//   same color associations carry across (T=green, n=blue, F_s=purple,
//   f=red).
//
// Unknown contribution keys (from a future Force class that ships
// before this map is updated) fall back to FALLBACK_BAR_COLOR — the
// bar still renders so nothing silently disappears.
export const LOL_COLORS = {
  K:         '#2E8B57',
  K_trans:   '#1ABC9C',  // cyan — Phase 3.5 (Q9=A) translational piece of K
  K_rot:     '#F39C12',  // orange — Phase 3.5 (Q9=A) rotational piece of K
  U_g:       '#2980b9',
  U_e:       '#7C4DFF',
  U_thermal: '#E74C3C',
  U_c:       '#F39C12',  // chemical, future
  U_electric:'#c0392b',  // charge-charge, Phase 5 (future)
  U_magnetic:'#16a085'   // magnetic dipole, Phase 3.3 (SD-13: teal, distinct from U_electric red)
};
const FALLBACK_BAR_COLOR = '#888888';

// Layout constants (CSS pixels — same convention as fbd_overlay.js).
// Side-by-side layout (one bar per energy contribution); panel width
// auto-grows to fit N bars. Worksheet/quiz convention: K, U_g, U_e,
// U_thermal each get their own bar; a dashed reference line at the
// initial-total height crosses all bars so drift is visible.
const PANEL_W_BASE_PX = 70;    // headroom for title + drift label
const PANEL_W_PER_BAR_PX = 42; // each bar reserves this much width
const PANEL_H_PX = 200;
const PANEL_MARGIN_PX = 16;
const PANEL_BG = 'rgba(252, 252, 253, 0.92)';
const PANEL_BORDER = '#dde0e7';

const TITLE_FONT = 'bold 12px system-ui, sans-serif';
const TITLE_COLOR = '#2d3138';
const BAR_LABEL_FONT = '10px "Times New Roman", serif';
const BAR_LABEL_COLOR = '#1f2329';
const VALUE_LABEL_FONT = '9px system-ui, sans-serif';
const VALUE_LABEL_COLOR = '#4a4f59';
const DRIFT_FONT = '10px system-ui, sans-serif';
const DRIFT_COLOR = '#4a4f59';

const BAR_X_PAD_PX = 12;       // gutter from panel left edge
const BAR_W_PX = 28;           // visible bar width
const BAR_TOP_INSET_PX = 26;   // headroom for the title
const BAR_BOTTOM_INSET_PX = 62;// footroom for quantity + value labels + total + drift readouts
const BAR_AREA_H_PX = PANEL_H_PX - BAR_TOP_INSET_PX - BAR_BOTTOM_INSET_PX;
// ~15% extra vertical headroom above the tallest bar so bars that grow
// (e.g. accumulated U_thermal) don't clip the top.
const BAR_OVERSCALE = 1.15;

const SEGMENT_BORDER = 'rgba(0, 0, 0, 0.18)';

// Compute the stacked-bar entries from `loaded.tracker.current()`.
// Returns { bars, total, initialTotal, drift_pct, anyNegative }.
//
//   bars — list of { key, value, color, label } in render order:
//          K first, then contribution keys in the order the tracker
//          emitted them (Object.entries preserves insertion). Negative
//          contributions are kept in the list (so they're visible in
//          the drift readout) but excluded from the stack heights to
//          avoid an "upside-down" segment that confuses the picture.
//
// Exported so unit tests can drive it directly without a Canvas
// context — same pattern as `computeBodyForces` in fbd_overlay.js.
export function computeBars(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    return { bars: [], total: 0, initialTotal: 0, drift_pct: 0, anyNegative: false };
  }
  const bars = [];
  let anyNegative = false;
  const k = snapshot.K ?? 0;
  // Phase 3.5 (Q9=A): split K into K_trans (cyan) + K_rot (orange) when
  // any body has a nonzero rotational K. The tracker emits both K
  // (total) and K_rot (rotational only); K_trans = K − K_rot. Scenes
  // without rotational bodies (every prior-phase scene) have
  // K_rot === 0 and skip the split — preserves the legacy single-bar
  // K rendering.
  const k_rot = snapshot.K_rot ?? 0;
  if (k_rot > 0) {
    const k_trans = k - k_rot;
    bars.push(makeBar('K_trans', k_trans));
    bars.push(makeBar('K_rot', k_rot));
    if (k_trans < 0) anyNegative = true;
    if (k_rot < 0) anyNegative = true;
  } else {
    bars.push(makeBar('K', k));
    if (k < 0) anyNegative = true;
  }

  const contributions = snapshot.contributions ?? {};
  for (const key of Object.keys(contributions)) {
    const value = contributions[key];
    if (typeof value !== 'number') continue;
    bars.push(makeBar(key, value));
    if (value < 0) anyNegative = true;
  }

  const total = snapshot.total ?? bars.reduce((s, b) => s + b.value, 0);
  const drift_pct = snapshot.drift_pct ?? 0;
  // The initial total is total / (1 + drift/100). Recover it so the
  // reference line stays anchored at the t=0 value rather than tracking
  // the shifting current total. Falls back to `total` when drift is 0.
  const initialTotal = drift_pct === 0
    ? total
    : total / (1 + drift_pct / 100);
  return { bars, total, initialTotal, drift_pct, anyNegative };
}

function makeBar(key, value) {
  return {
    key,
    value,
    color: LOL_COLORS[key] ?? FALLBACK_BAR_COLOR,
    label: labelFor(key)
  };
}

// Map an energy key to its display string. Subscript syntax ("U_g") is
// mirrored from the FBD overlay's labelling — base + subscript are
// drawn separately so the subscript renders smaller. K is bare.
//
// DISPLAY != DATA KEY. The tracker's key is `U_thermal` (a stable contract the
// Force classes provide and lol_overlay.test.js pins), but the curriculum's
// notation — physics/CLAUDE.md, "Physics Notation" — is that thermal energy
// DISPLAYS as U_th everywhere a student sees it, never a spelled-out subscript.
// The .docx LOL path already decouples the two through LOL_DISPLAY_LABELS
// (`Ut -> ('U','th')`); this renderer is the THIRD LOL path and never got the
// mapping, so it drew "Uthermal" on every scene — including the story block on
// the front page. Same rule, same place: one display map, keyed by data key.
const DISPLAY_LABEL = {
  U_thermal: 'U_th',
};

function labelFor(key) {
  return DISPLAY_LABEL[key] || key;
}

// Compute panel width given N bars. Exported so the render entry can
// position the panel before drawOneLol picks up the work.
export function panelWidthFor(nBars) {
  return PANEL_W_BASE_PX + Math.max(1, nBars) * PANEL_W_PER_BAR_PX;
}

// Render entry called from Canvas2DRenderer.render() after the FBD
// overlay (so the LOL panel sits on top of any FBD that strays into
// the bottom-left corner). The renderer passes itself in for the canvas
// context + dimensions.
export function drawLolOverlay(renderer, loaded) {
  if (!loaded || !loaded.tracker) return;
  const ctx = renderer.ctx;
  const snapshot = loaded.tracker.current();
  const composition = computeBars(snapshot);
  if (composition.bars.length === 0) return;

  drawOneLol(ctx, lolPanelAnchor(renderer.cssHeight), composition);
}

// Panel top-left corner for a BOTTOM-LEFT anchored panel, in CSS pixels.
// Pure (takes the canvas height, not the renderer) so the placement is
// unit-testable without a Canvas — the sketch overlay's sketchPanelAnchor
// uses the same shape. Clamped so a canvas shorter than the panel pins it at
// the top margin instead of drawing off the top edge.
export function lolPanelAnchor(cssHeight) {
  return {
    x: PANEL_MARGIN_PX,
    y: Math.max(PANEL_MARGIN_PX, cssHeight - PANEL_H_PX - PANEL_MARGIN_PX)
  };
}

// Internal: draw the LOL panel at the given anchor (panel top-left in
// CSS pixels) given a composition object from `computeBars`. Exported
// for unit tests so we can drive it against a stub canvas.
//
// Side-by-side layout: each contribution gets its own vertical bar.
// Drift is reported in the text readout below the bars, not as a rule
// across them (see the module header).
export function drawOneLol(ctx, anchor, composition) {
  const { bars, total, initialTotal, drift_pct } = composition;
  const nBars = bars.length;
  const panelW = panelWidthFor(nBars);

  // --- Panel background ---
  ctx.fillStyle = PANEL_BG;
  ctx.strokeStyle = PANEL_BORDER;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.rect(anchor.x, anchor.y, panelW, PANEL_H_PX);
  ctx.fill();
  ctx.stroke();

  // --- Title ---
  ctx.fillStyle = TITLE_COLOR;
  ctx.font = TITLE_FONT;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('Energy', anchor.x + BAR_X_PAD_PX, anchor.y + 8);

  // --- Bar geometry ---
  // Reference value used to scale bar heights. Use the larger of the
  // current bar values, current total, and initial total so a single
  // big bar doesn't outgrow the frame as drift accumulates. Apply
  // BAR_OVERSCALE for headroom above the reference line.
  const peakBar = bars.reduce((m, b) => Math.max(m, Math.abs(b.value)), 0);
  const refValue = Math.max(peakBar, initialTotal, total, 1e-12);
  const scaleDenom = refValue * BAR_OVERSCALE;

  const barTop = anchor.y + BAR_TOP_INSET_PX;
  const barBottom = barTop + BAR_AREA_H_PX;
  // Distribute bars across the panel inner width.
  const innerLeft = anchor.x + BAR_X_PAD_PX;
  const innerRight = anchor.x + panelW - BAR_X_PAD_PX;
  const slotW = (innerRight - innerLeft) / nBars;

  // --- Draw each bar ---
  // One rect per bar: a colored fill from the baseline up for positive
  // values, or an empty outline for zero / negative bars (the slot
  // stays visible as a placeholder so the eye knows which contribution
  // is currently inactive).
  ctx.lineWidth = 0.75;
  for (let i = 0; i < nBars; i++) {
    const bar = bars[i];
    const slotCenterX = innerLeft + slotW * (i + 0.5);
    const barX = slotCenterX - BAR_W_PX / 2;
    if (bar.value > 0) {
      const barH = Math.min(
        BAR_AREA_H_PX,
        (bar.value / scaleDenom) * BAR_AREA_H_PX
      );
      const barTopY = barBottom - barH;
      ctx.fillStyle = bar.color;
      ctx.strokeStyle = SEGMENT_BORDER;
      ctx.beginPath();
      ctx.rect(barX, barTopY, BAR_W_PX, barH);
      ctx.fill();
      ctx.stroke();
    } else {
      ctx.strokeStyle = SEGMENT_BORDER;
      ctx.beginPath();
      ctx.rect(barX, barTop, BAR_W_PX, BAR_AREA_H_PX);
      ctx.stroke();
    }
    // Quantity label below the bar.
    ctx.fillStyle = BAR_LABEL_COLOR;
    ctx.font = BAR_LABEL_FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    drawBarLabel(ctx, slotCenterX, barBottom + 4, bar.label);
    // Numeric value below the quantity label.
    ctx.fillStyle = VALUE_LABEL_COLOR;
    ctx.font = VALUE_LABEL_FONT;
    ctx.textAlign = 'center';
    ctx.fillText(bar.value.toFixed(1), slotCenterX, barBottom + 17);
  }

  // --- Drift + total readout below the per-bar labels ---
  // (two separate lines so each can be matched independently). The
  // bar value labels live at barBottom + 4 and barBottom + 17; the
  // readouts go below those.
  ctx.fillStyle = DRIFT_COLOR;
  ctx.font = DRIFT_FONT;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(
    `total = ${total.toFixed(2)} J`,
    anchor.x + BAR_X_PAD_PX,
    barBottom + 32
  );
  ctx.fillText(
    `drift = ${drift_pct.toFixed(3)} %`,
    anchor.x + BAR_X_PAD_PX,
    barBottom + 45
  );
}

// Render a label that may carry a subscript ("U_g" → "U" italic + "g"
// subscript). Same convention as fbd_overlay.js.drawLabel.
function drawBarLabel(ctx, anchorX, anchorY, label) {
  const baseFont = ctx.font;
  if (label.includes('_')) {
    const [base, sub] = label.split('_', 2);
    const baseW = ctx.measureText(base).width;
    const subFont = subscriptFont(baseFont);
    ctx.font = subFont;
    const subW = ctx.measureText(sub).width;
    ctx.font = baseFont;
    if (ctx.textAlign === 'center') {
      const total = baseW + subW;
      const baseX = anchorX - total / 2 + baseW / 2;
      const subX = baseX + baseW / 2 + subW / 2;
      ctx.fillText(base, baseX, anchorY);
      ctx.font = subFont;
      ctx.fillText(sub, subX, anchorY + 2);
      ctx.font = baseFont;
    } else {
      ctx.fillText(label, anchorX, anchorY);
    }
  } else {
    ctx.fillText(label, anchorX, anchorY);
  }
}

// Convert a font shorthand to a smaller-size variant for subscripts.
// Robust against extra keywords by replacing the first `<n>px` token.
function subscriptFont(font) {
  return font.replace(/(\d+(?:\.\d+)?)px/, (_m, n) => `${Math.max(7, Math.round(parseFloat(n) * 0.75))}px`);
}

export const NAME = 'lol_overlay';
