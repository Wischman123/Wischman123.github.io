// render/divergence_foil_overlay.js
//
// sim_numerical_chaos P4b — the double-pendulum DIVERGENCE foil (the SYSTEM
// channel of the serves:discovery payload). It surfaces P4b's two-trajectory
// display run ({ trajA, trajB } from sim/validation/divergence_run.js) to a
// student as plain, descriptive feedback: two near-identical pendulums whose
// paths track together, then separate — sensitive dependence on initial
// conditions.
//
// ----- What it draws -----
// One sub-plot PER run, stacked on a SHARED value range, each showing that run's
// bob-2 horizontal position vs time. The shared range is deliberate: the two
// curves read as identical early and visibly separate late only when both are
// scaled the same way. A headline and a multi-line caption frame the pair.
//
// ----- Library reuse -----
// Curves, axis frame, zero baseline, and ticks come from the SHARED frozen
// sub-plot renderer (drawSubplot) already proven for the predict-the-graph and
// P4a drift overlays; subplotPlotRect gives the matching plot rectangle so the
// behavioral no-shading guard sees the exact box drawSubplot drew into. No
// per-scene copy of the sub-plot machinery.
//
// ----- Anti-Kohn (see sim/PEDAGOGY.md) -----
// Every emitted string is descriptive. The divergence is attributed to the
// SYSTEM (sensitive dependence), NEVER to the student and NEVER to a numerical
// flaw — an exact integrator would diverge too. The two runs are framed as
// equally valid; neither is privileged. The two curves live in separate
// sub-plots and NOTHING is filled between them (no shaded divergence region);
// the behavioral guard assertNoFillBetweenCurves is wired per sub-plot in the
// overlay test.

import { drawSubplot, subplotPlotRect } from './motion_graph.js';

// --- Layout (CSS pixels): headline row, 2 sub-plots, multi-line caption. ---
export const PANEL_W_PX = 300;
const HEADLINE_H_PX = 22;
const SUBPLOT_H_PX = 96;
const CAPTION_LINE_H_PX = 13;
const CAPTION_PAD_PX = 8;

// Two equally-valid identity colors (blue + teal) — DELIBERATELY not a
// red-vs-green (bad-vs-good) pairing: neither run is being marked, the color is
// only a curve identity.
const CURVE_PALETTE = ['#2c6fbb', '#178a80'];

const PANEL_BG = 'rgba(252, 252, 253, 0.94)';
const PANEL_BORDER = '#dde0e7';
const HEADLINE_FONT = 'bold 12px system-ui, sans-serif';
const HEADLINE_COLOR = '#2d3138';
const CAPTION_FONT = '10px system-ui, sans-serif';
const CAPTION_COLOR = '#4a4f59';

const RANGE_HEADROOM = 0.08;
const SPAN_FLOOR = 1e-9;

// --- Adapter: the { trajA, trajB } producer shape -> the overlay curve input ---
// Each trajectory is { name, times:[], positions:[{x,y}] }. The plotted scalar is
// bob-2's horizontal position x(t). Both curves share ONE value range (computed
// over both) so the eye compares like with like — the crux of the foil.
export function divergenceCurvesFromPair(pair) {
  const trajs = [pair?.trajA, pair?.trajB].filter(Boolean);
  const series = trajs.map((tr) => {
    const times = Array.isArray(tr.times) ? tr.times : [];
    const positions = Array.isArray(tr.positions) ? tr.positions : [];
    const n = Math.min(times.length, positions.length);
    const samples = [];
    for (let i = 0; i < n; i++) {
      const x = positions[i]?.x;
      if (Number.isFinite(times[i]) && Number.isFinite(x)) samples.push({ t: times[i], v: x });
    }
    return { name: String(tr.name ?? ''), samples };
  });

  // Shared value + time range over BOTH series.
  let vMin = Infinity, vMax = -Infinity, tMax = 0;
  for (const s of series) {
    for (const p of s.samples) {
      if (p.v < vMin) vMin = p.v;
      if (p.v > vMax) vMax = p.v;
      if (p.t > tMax) tMax = p.t;
    }
  }
  if (!Number.isFinite(vMin)) { vMin = 0; vMax = 0; }
  const span = Math.max(vMax - vMin, SPAN_FLOOR);
  const pad = span * RANGE_HEADROOM;
  const sharedRange = { tMin: 0, tMax: tMax > 0 ? tMax : SPAN_FLOOR, vMin: vMin - pad, vMax: vMax + pad };

  return { curves: series.map((s) => ({ ...s, fixedRange: sharedRange })), sharedRange };
}

// MAX Euclidean bob-2 separation between the two runs over the whole display —
// the honest "how far apart did they get" number. The ENDPOINT separation
// understates it badly: two chaotic paths can momentarily near-pass at the last
// sample after having been metres apart, so the endpoint would read misleadingly
// small.
function maxSeparation(pair) {
  const a = pair?.trajA?.positions ?? [];
  const b = pair?.trajB?.positions ?? [];
  const n = Math.min(a.length, b.length);
  let m = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.hypot(a[i].x - b[i].x, a[i].y - b[i].y);
    if (d > m) m = d;
  }
  return m;
}

// --- Descriptive copy (single source of truth for canvas + the predict reveal) ---
// Pure and name-agnostic: run names are interpolated from the trajectory names,
// the initial and final separations from the data. Caption is an ARRAY of short
// lines so a canvas without text wrapping still fits it.
export function describeDivergence(pair, { duration } = {}) {
  const durStr = Number.isFinite(duration) && duration > 0 ? `${Math.round(duration)} s` : 'the run';
  const initSep = Number.isFinite(pair?.perturb) ? pair.perturb : 0;
  const maxSep = maxSeparation(pair);
  const nameA = String(pair?.trajA?.name ?? 'run A');
  const nameB = String(pair?.trajB?.name ?? 'run B');

  const headline = `Two almost-identical pendulums over ${durStr}`;
  const lines = [
    { name: nameA, legend: `${nameA}: bob-2 horizontal position` },
    { name: nameB, legend: `${nameB}: bob-2 horizontal position` },
  ];
  const caption = [
    `Both runs began almost identical (about ${initSep.toPrecision(2)} m apart) and`,
    `their bob-2 paths tracked together before separating — they grew as far as`,
    `${maxSep.toPrecision(2)} m apart. In a chaotic system tiny differences grow:`,
    `the system itself drives the paths apart, not a flaw in the simulation and`,
    `not your prediction. Neither run is privileged — both are equally valid runs`,
    `of the same rules.`,
  ];
  return { headline, lines, caption };
}

// --- The overlay -----------------------------------------------------------
// Draws the descriptive panel: headline, one bob-2-position sub-plot per run
// (shared range), then the multi-line caption. Returns the geometry + copy so
// the overlay test can drive the no-shading guard against each sub-plot's
// plotRect and read the emitted strings. `session` = { pair, duration }.
export function drawDivergenceFoilOverlay(ctx, panelAnchor, session) {
  const pair = session?.pair ?? {};
  const duration = session?.duration ?? pair?.duration;
  const copy = describeDivergence(pair, { duration });
  const { curves } = divergenceCurvesFromPair(pair);
  const N = curves.length;

  const captionH = CAPTION_PAD_PX + copy.caption.length * CAPTION_LINE_H_PX;
  const panelH = HEADLINE_H_PX + N * SUBPLOT_H_PX + captionH;

  // Panel background — a legitimate PLOT-BACKGROUND fill covering the whole panel
  // (fully contains every sub-plot rect, so the no-shading guard exempts it).
  ctx.fillStyle = PANEL_BG;
  ctx.strokeStyle = PANEL_BORDER;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.rect(panelAnchor.x, panelAnchor.y, PANEL_W_PX, panelH);
  ctx.fill();
  ctx.stroke();

  // Headline.
  ctx.fillStyle = HEADLINE_COLOR;
  ctx.font = HEADLINE_FONT;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(copy.headline, panelAnchor.x + 8, panelAnchor.y + 5);

  // One bob-2-position sub-plot per run (shared range).
  const subplots = [];
  for (let i = 0; i < N; i++) {
    const subAnchor = { x: panelAnchor.x, y: panelAnchor.y + HEADLINE_H_PX + i * SUBPLOT_H_PX };
    const isLast = i === N - 1;
    const color = CURVE_PALETTE[i % CURVE_PALETTE.length];
    drawSubplot(
      ctx, subAnchor, PANEL_W_PX, SUBPLOT_H_PX,
      curves[i].samples, (s) => s.v,
      copy.lines[i]?.legend ?? curves[i].name, color, isLast,
      null, curves[i].fixedRange
    );
    subplots.push({
      name: curves[i].name,
      plotRect: subplotPlotRect(subAnchor, PANEL_W_PX, SUBPLOT_H_PX, isLast),
    });
  }

  // Multi-line caption below the last sub-plot.
  ctx.fillStyle = CAPTION_COLOR;
  ctx.font = CAPTION_FONT;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  const captionY0 = panelAnchor.y + HEADLINE_H_PX + N * SUBPLOT_H_PX + CAPTION_PAD_PX / 2;
  for (let i = 0; i < copy.caption.length; i++) {
    ctx.fillText(copy.caption[i], panelAnchor.x + 8, captionY0 + i * CAPTION_LINE_H_PX);
  }

  return {
    panelRect: { x0: panelAnchor.x, y0: panelAnchor.y, x1: panelAnchor.x + PANEL_W_PX, y1: panelAnchor.y + panelH },
    subplots,
    curves,
    copy,
  };
}

export const NAME = 'divergence_foil_overlay';
