// render/integrator_drift_overlay.js
//
// Spring integrator-drift DESCRIPTIVE overlay (sim_numerical_chaos P4a, the
// serves:discovery payload). It surfaces P2's per-integrator comparison to a
// student as plain, descriptive feedback — which integrator keeps the spring's
// total energy bounded, and which sheds it one way — with NO evaluative framing.
//
// ----- What it draws -----
// One stacked sub-plot PER integrator record, each showing that method's signed
// energy drift |E-E0|-with-sign vs time, pinned to its OWN drift range so the
// student reads the SHAPE (a bounded rise-and-fall that returns, versus a steady
// one-way ramp that does not) rather than a size race. The two methods differ in
// drift magnitude by ~20x on this spring, so a shared axis would hide the shape
// that carries the lesson; the honest comparison is shape-to-shape.
//
// Each sub-plot's title is a DESCRIPTIVE legend interpolated from the record —
// the method name comes from record.name (never a hardcoded 'rk4'/'verlet') and
// the bounded-vs-secular phrasing comes from record.driftKind. A headline and a
// one-line caption frame the pair.
//
// ----- Library reuse -----
// The curve, axis frame, zero baseline, and ticks are drawn by the SHARED frozen
// sub-plot renderer (drawSubplot) already proven for the predict-the-graph
// overlay; subplotPlotRect gives the matching plot rectangle so the behavioral
// no-shading guard sees the exact box drawSubplot drew into. No per-scene copy of
// the sub-plot machinery.
//
// ----- Anti-Kohn (see sim/PEDAGOGY.md) -----
// Every emitted string is descriptive. A difference between methods is attributed
// to the METHOD (RK4 is not symplectic), never to the student. RK4's drift on
// this spring is an energy loss — the copy states the direction from the sign of
// the data and never says a non-symplectic method "gains" energy. The two curves
// live in separate sub-plots and NOTHING is filled between them; the behavioral
// guard assertNoFillBetweenCurves is wired per sub-plot in the overlay test.

import { drawSubplot, subplotPlotRect } from './motion_graph.js';

// --- Layout (CSS pixels). The panel stacks: headline row, N sub-plots, caption. ---
export const PANEL_W_PX = 300;
const HEADLINE_H_PX = 22;
const SUBPLOT_H_PX = 96;
const CAPTION_H_PX = 34;

// Two equally-valid identity colors — a blue and a teal from the existing render
// palette family. DELIBERATELY not a red-vs-green (bad-vs-good) pairing: neither
// method is being marked; the color is only a curve identity so a glance tells the
// two sub-plots apart. Cycled for any longer integrator list.
const CURVE_PALETTE = ['#2c6fbb', '#178a80', '#7C4DFF', '#b06f2a'];

const PANEL_BG = 'rgba(252, 252, 253, 0.94)';
const PANEL_BORDER = '#dde0e7';
const HEADLINE_FONT = 'bold 12px system-ui, sans-serif';
const HEADLINE_COLOR = '#2d3138';
const CAPTION_FONT = '10px system-ui, sans-serif';
const CAPTION_COLOR = '#4a4f59';

// Fraction of the drift span added as headroom above/below so the curve does not
// sit on the frame edge. CALCULATE, not eyeball: the span is measured from the
// data, the pad is a fixed fraction of it.
const RANGE_HEADROOM = 0.08;
const SPAN_FLOOR = 1e-9;

// --- Adapter: one producer shape -> the overlay's curve input --------------
// P2 hands each integrator a record { name, driftHistory:{times,totals,
// drifts_pct}, earlyHalfMaxDrift, lateHalfMaxDrift, driftKind }. The spring's
// energy history IS record.driftHistory (P1-general-4 folded totals into it), so
// this adapter reads energy straight from the record — it starts NO second
// tracker run. drifts_pct is the SIGNED metric 100*(E-E0)/|E0| (P1), so a
// downward curve reads as a loss and an oscillation reads as a return.
//
// (P4b's two-trajectory producer shape — { trajA, trajB } near-identical-theta0
// display curves — is a SIBLING adapter that maps onto this same sub-plot layer;
// it is Increment 2 and intentionally not built here.)
export function driftCurveFromRecord(record) {
  const name = String(record?.name ?? '');
  const dh = record?.driftHistory ?? {};
  const times = Array.isArray(dh.times) ? dh.times : [];
  const drifts = Array.isArray(dh.drifts_pct) ? dh.drifts_pct : [];
  const n = Math.min(times.length, drifts.length);
  const samples = [];
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(times[i]) && Number.isFinite(drifts[i])) {
      samples.push({ t: times[i], v: drifts[i] });
    }
  }
  const duration = samples.length > 0 ? samples[samples.length - 1].t : 0;
  return {
    name,
    driftKind: typeof record?.driftKind === 'string' ? record.driftKind : 'indeterminate',
    samples,
    peakAbs: Number.isFinite(record?.lateHalfMaxDrift) ? record.lateHalfMaxDrift : 0,
    fixedRange: driftFixedRange(samples, duration),
  };
}

// Pin the value axis to this method's own drift envelope, always including 0 —
// the zero line is the conserved-energy reference the curve either returns to
// (bounded) or walks away from (secular).
function driftFixedRange(samples, duration) {
  let vMin = 0;
  let vMax = 0;
  for (const s of samples) {
    if (s.v < vMin) vMin = s.v;
    if (s.v > vMax) vMax = s.v;
  }
  const span = Math.max(vMax - vMin, SPAN_FLOOR);
  const pad = span * RANGE_HEADROOM;
  const tMax = Number.isFinite(duration) && duration > 0 ? duration : SPAN_FLOOR;
  return { tMin: 0, tMax, vMin: vMin - pad, vMax: vMax + pad };
}

// --- Descriptive copy (single source of truth for canvas + the predict reveal) --
// Pure and name-agnostic: the method name is interpolated from record.name, the
// bounded/secular phrasing from record.driftKind, and the drift direction from
// the SIGN of the late-half mean drift (so the wording matches the data — a
// non-symplectic method that sheds energy is described as drifting downward,
// never as gaining). Returns short legends for the canvas and longer detail for
// the DOM reveal.
export function describeDrift(records, { duration } = {}) {
  const list = Array.isArray(records) ? records : [];
  const durStr = Number.isFinite(duration) && duration > 0 ? `${Math.round(duration)} s` : 'the run';
  const headline = `Total energy drift over ${durStr}`;
  const lines = list.map((r) => describeOne(r));
  const caption =
    'A drift that returns each cycle stays bounded; a drift that only grows one ' +
    'way builds up without bound — the shape of the energy, not its size, is the tell.';
  return { headline, lines, caption };
}

function describeOne(record) {
  const name = String(record?.name ?? '');
  const peak = fmtPct(record?.lateHalfMaxDrift);
  const kind = typeof record?.driftKind === 'string' ? record.driftKind : 'indeterminate';

  if (kind === 'secular') {
    const trend = lateMeanSignedDrift(record);
    const dirWord = trend > 0 ? 'upward' : 'downward';
    const changeWord = trend > 0 ? 'gain' : 'loss';
    return {
      name,
      driftKind: kind,
      legend: `${name}: secular — drifts one way`,
      detail:
        `Under ${name}, the total energy drifted ${dirWord} and the running energy ` +
        `${changeWord} grew to ${peak} by the end — a steady, one-way change that ` +
        `does not return. ${name} is not symplectic, so its drift builds up ` +
        `(secular) over the run.`,
    };
  }
  if (kind === 'bounded') {
    return {
      name,
      driftKind: kind,
      legend: `${name}: bounded — returns each cycle`,
      detail:
        `Under ${name}, the total energy rose and fell within a bounded band ` +
        `(up to ${peak}) and returned each cycle — it never runs away. ${name} ` +
        `keeps the energy bounded over the long run.`,
    };
  }
  return {
    name,
    driftKind: kind,
    legend: `${name}: drift kind undetermined`,
    detail:
      `Under ${name}, the total energy drift did not settle into a clear bounded ` +
      `or secular pattern over this run (up to ${peak}).`,
  };
}

// Mean SIGNED drift over the late half of the run — the honest read of which way
// a secular method is walking. Derived from record.driftHistory, no second run.
function lateMeanSignedDrift(record) {
  const dh = record?.driftHistory ?? {};
  const times = Array.isArray(dh.times) ? dh.times : [];
  const drifts = Array.isArray(dh.drifts_pct) ? dh.drifts_pct : [];
  const n = Math.min(times.length, drifts.length);
  if (n === 0) return 0;
  const split = times[n - 1] / 2;
  let sum = 0;
  let count = 0;
  for (let i = 1; i < n - 1; i++) {
    if (times[i] > split) { sum += drifts[i]; count++; }
  }
  return count > 0 ? sum / count : 0;
}

function fmtPct(v) {
  if (!Number.isFinite(v)) return 'n/a';
  return `${v.toFixed(1)}%`;
}

// --- The overlay -----------------------------------------------------------
// Draws the descriptive panel: headline, one frozen drift sub-plot per record
// (title = interpolated legend, curve pinned to its own range), then the caption.
// Returns the geometry + copy so the overlay test can drive the no-shading guard
// against each sub-plot's plotRect and read the emitted strings.
//
// `session` = { records, duration }.
export function drawIntegratorDriftOverlay(ctx, panelAnchor, session) {
  const records = Array.isArray(session?.records) ? session.records : [];
  const duration = session?.duration;
  const copy = describeDrift(records, { duration });
  const curves = records.map(driftCurveFromRecord);
  const N = curves.length;

  const panelH = HEADLINE_H_PX + N * SUBPLOT_H_PX + CAPTION_H_PX;

  // Panel background — a legitimate PLOT-BACKGROUND fill covering the whole panel
  // (it fully contains every sub-plot rect, so the no-shading guard exempts it as
  // a background, NOT a fill drawn between two curves).
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

  // One frozen drift sub-plot per record.
  const subplots = [];
  for (let i = 0; i < N; i++) {
    const subAnchor = {
      x: panelAnchor.x,
      y: panelAnchor.y + HEADLINE_H_PX + i * SUBPLOT_H_PX,
    };
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
      driftKind: curves[i].driftKind,
      plotRect: subplotPlotRect(subAnchor, PANEL_W_PX, SUBPLOT_H_PX, isLast),
    });
  }

  // Caption below the last sub-plot.
  ctx.fillStyle = CAPTION_COLOR;
  ctx.font = CAPTION_FONT;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(copy.caption, panelAnchor.x + 8, panelAnchor.y + HEADLINE_H_PX + N * SUBPLOT_H_PX + 6);

  return {
    panelRect: { x0: panelAnchor.x, y0: panelAnchor.y, x1: panelAnchor.x + PANEL_W_PX, y1: panelAnchor.y + panelH },
    subplots,
    curves,
    copy,
  };
}

export const NAME = 'integrator_drift_overlay';
