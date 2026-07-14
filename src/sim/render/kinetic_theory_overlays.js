// render/kinetic_theory_overlays.js
//
// P2/P4 (kinetic-theory box) — render-layer transforms for the emergent
// macroscopic readouts of a gas of elastic disks.
//
// The engine exposes pressure's RAW signal as a per-tick, instantaneous
// wall-impulse (the `wall_impulse` diagnostic, Σ|J| over the four walls THIS
// tick — see engine/kinetic_theory.js). Turning that jittery per-tick stream
// into a steady pressure reading is a windowing/time-averaging step, which is a
// render-time concern (the overlay owns the sample buffer and the window). This
// module holds that transform as a NAMED, pure, unit-tested function so it is
// not buried un-located inside a draw call — box_wall_reflection.test.js pins it
// against the P1 physics brief's pressure identity.

// Panel-machinery reuse (P4). The P and T subplots are scalar-vs-time channels,
// so they reuse the motion-graph channel buffers + the exact subplot draw path;
// the speed histogram is NEW binning+draw panel code below. drawSubplot is the
// single subplot renderer; subplotPlotRect is its inner-frame math (so the
// no-shading invariant tests exactly what was drawn).
import { getBuffer, channelBufferKey, drawSubplot, subplotPlotRect } from './motion_graph.js';

// windowedWallPressure — average the per-tick wall-impulse samples into a 2-D
// pressure P (force per unit wall length).
//
// Physics (2-D, from the P1 brief §3): each elastic wall hit delivers a normal
// impulse |J| = 2m|v_n|. Over a window of duration Δt = samples·dt, the total
// impulse delivered to all four walls is Σ|J|, so the time-averaged total wall
// force is (Σ|J|)/Δt. In 2-D each of the four walls has length `wallLength` and
// feels an average force P·wallLength, so summed over the four walls the total
// force is 4·P·wallLength. Solving for P:
//
//     P = (Σ|J|) / (samples · dt · 4 · wallLength)
//
// This closes with the ideal-gas relation P·A = N⟨K⟩ (A = wallLength²) at the
// dilute limit, which is exactly what the derivation test cross-checks.
//
// @param {number[]} instSamples — per-tick `wall_impulse` values over the window
//                                 (Σ|J| on all four walls, one entry per tick).
// @param {number}   wallLength  — the length of one wall (the box side, box units).
// @param {number}   dt          — the integrator step (seconds per sample).
// @returns {number} the windowed 2-D pressure P (finite; 0 for an empty window
//                   or a non-positive geometry, so the overlay never shows NaN).
export function windowedWallPressure(instSamples, wallLength, dt) {
  if (!Array.isArray(instSamples) || instSamples.length === 0) return 0;
  let jSum = 0;
  for (const j of instSamples) jSum += j;
  return pressureFromImpulseSum(jSum, instSamples.length, wallLength, dt);
}

// The ONE pressure formula, factored out so windowedWallPressure (a single
// trailing window, unit-tested against the P1 identity) and buildPressureSeries
// (P4 — the same window slid across the whole buffer to make a P-vs-time curve)
// share it and cannot drift. Total wall force = ΣJ / (sampleCount·dt); split over
// four walls of length `wallLength` gives P = force/(4·wallLength).
//
// @param {number} jSum        — Σ|J| over the window (sum of per-tick wall_impulse)
// @param {number} sampleCount — ticks in the window
// @param {number} wallLength  — one wall's length (box side, box units)
// @param {number} dt          — integrator step (seconds per tick)
// @returns {number} 2-D pressure P, or 0 for a degenerate window (never NaN).
export function pressureFromImpulseSum(jSum, sampleCount, wallLength, dt) {
  if (!(sampleCount > 0) || !(wallLength > 0) || !(dt > 0)) return 0;
  return jSum / (sampleCount * dt * 4 * wallLength);
}

// ===========================================================================
// P4 — emergent P / T / speed-histogram overlay for the kinetic-theory box.
//
// Three EMERGENT readouts a student interprets unaided (physics/CLAUDE.md
// Modeling / anti-Kohn: descriptive, never a verdict):
//   • P — a 2-D pressure vs sim-time, the trailing-window average of the
//     wall_impulse channel (the raw per-tick Σ|J| the engine producer emits).
//   • T — ⟨K⟩ vs sim-time, the mean_K channel straight from the producer.
//   • speed histogram — the live particle-speed distribution with ⟨v⟩ and the
//     peak speed marked. A single-speed launch relaxes toward the 2-D
//     Maxwell–Boltzmann (Rayleigh) shape via elastic_gas — students WATCH it.
//
// Pressure sampling note (why feeding the frame-rate wall_impulse buffer to the
// dt-scaled formula is honest): the render layer records one wall_impulse sample
// per FRAME (~60 Hz), but the engine takes many dt-ticks per frame, so each
// sample is ONE tick's Σ|J| — a subsample of the tick stream. windowedWallPressure
// divides ΣJ by sampleCount·dt, so the subsampling factor cancels between the
// impulse sum and the window duration: the estimator is UNBIASED (just noisier,
// which the long trailing window smooths). Verified in box_wall_reflection.test.js
// against the P1 identity P·A = N⟨K⟩.

// Trailing window (samples) the pressure average slides over. At ~60 Hz this is
// ~4 s of impulse subsamples — long enough to smooth the once-per-frame
// subsampling variance into a steady reading.
const KT_PRESSURE_WINDOW = 240;
// A windowed average is only meaningful once enough samples have accrued: the
// FIRST few entries would average 1–2 jittery wall-impulse ticks into a wild
// transient spike (a momentary "P = 270" that misreads as pressure dropping).
// Emit no P until the trailing window holds at least this many samples, so the
// first shown reading is already a steady, honest average.
const KT_PRESSURE_MIN_SAMPLES = 60;
// Speed-histogram bin count. Enough resolution to read the Rayleigh shape at
// N=150 without starving individual bins.
const KT_HIST_BINS = 18;

// Panel geometry (CSS px) — the KT overlay owns its own layout (its histogram
// row is taller than a time-series subplot), independent of motion_graph's panel.
const KT_PANEL_W = 250;
const KT_PANEL_MARGIN = 16;
const KT_TITLE_H = 16;
const KT_SUB_H = 66;    // each of the P and T time-series subplots
const KT_HIST_H = 124;  // the speed-histogram panel
const KT_PANEL_BG = 'rgba(252, 252, 253, 0.92)';
const KT_PANEL_BORDER = '#dde0e7';
const KT_TITLE_FONT = 'bold 12px system-ui, sans-serif';
const KT_TITLE_COLOR = '#2d3138';
const KT_P_COLOR = '#2c6fbb';   // pressure — blue
const KT_T_COLOR = '#c77f3b';   // temperature — amber (never red/green semantics)
const KT_HIST_TITLE_FONT = '10px system-ui, sans-serif';
const KT_HIST_TITLE_COLOR = '#4a4f59';
const KT_HIST_FRAME = '#c3c8d2';
const KT_HIST_BAR = '#8fb5d6';
const KT_TICK_FONT = '9px system-ui, sans-serif';
const KT_TICK_COLOR = '#888';
const KT_MEAN_COLOR = '#4a4f59';   // ⟨v⟩ marker — neutral slate
const KT_PEAK_COLOR = '#2c6fbb';   // peak marker — matches the pressure blue

// The schema-declared box {min,max} for the gas — read from the scene's
// box_wall_reflection collision (NOT hardcoded). Returns null on a non-gas scene.
export function kineticTheoryBox(loaded) {
  const collisions = loaded?.scene?.collisions ?? [];
  for (const c of collisions) {
    if (c.mode === 'box_wall_reflection' && c.box && c.box.min && c.box.max) return c.box;
  }
  return null;
}

// A scene is a kinetic-theory gas iff it declares a box_wall_reflection wall.
export function isKineticTheoryScene(loaded) {
  return kineticTheoryBox(loaded) != null;
}

// One wall's length for the 2-D pressure identity (square box: x-span = y-span).
function kineticTheoryWallLength(loaded) {
  const box = kineticTheoryBox(loaded);
  return box ? box.max.x - box.min.x : 0;
}

// Slide the pressure window across the whole wall_impulse buffer to build a
// P-vs-time series. O(n) via a prefix sum; each entry is the trailing-window P
// ending at that sample. Non-finite samples count as 0 so one bad tick never
// poisons the running average.
export function buildPressureSeries(wallImpulseBuf, wallLength, dt, window = KT_PRESSURE_WINDOW) {
  const n = Array.isArray(wallImpulseBuf) ? wallImpulseBuf.length : 0;
  if (n === 0 || !(wallLength > 0) || !(dt > 0)) return [];
  const prefix = new Array(n + 1);
  prefix[0] = 0;
  for (let i = 0; i < n; i++) {
    const v = wallImpulseBuf[i].value;
    prefix[i + 1] = prefix[i] + (Number.isFinite(v) ? v : 0);
  }
  const minSamples = Math.min(KT_PRESSURE_MIN_SAMPLES, window);
  const out = [];
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - window + 1);
    const count = i - lo + 1;
    if (count < minSamples) continue; // window not yet meaningful — emit nothing
    const jSum = prefix[i + 1] - prefix[lo];
    out.push({ t: wallImpulseBuf[i].t, value: pressureFromImpulseSum(jSum, count, wallLength, dt) });
  }
  return out;
}

// Bin the live particle speeds |v| into a fixed-width histogram over [0, v_max·1.05]
// with ⟨v⟩ and the peak (modal) speed marked. Pure — reads body velocities only.
export function speedHistogram(bodies, binCount = KT_HIST_BINS) {
  const empty = { bins: [], vMean: 0, vPeak: 0, maxCount: 0, binWidth: 0 };
  const speeds = [];
  for (const b of bodies ?? []) {
    const vx = b?.velocity?.x ?? 0;
    const vy = b?.velocity?.y ?? 0;
    const s = Math.hypot(vx, vy);
    if (Number.isFinite(s)) speeds.push(s);
  }
  if (speeds.length === 0) return empty;
  let vMax = 0, sum = 0;
  for (const s of speeds) { if (s > vMax) vMax = s; sum += s; }
  const vMaxDisp = vMax > 0 ? vMax * 1.05 : 1; // headroom so the fastest bar isn't clipped
  const binWidth = vMaxDisp / binCount;
  const bins = [];
  for (let i = 0; i < binCount; i++) bins.push({ v0: i * binWidth, v1: (i + 1) * binWidth, count: 0 });
  for (const s of speeds) {
    let idx = Math.floor(s / binWidth);
    if (idx >= binCount) idx = binCount - 1;
    if (idx < 0) idx = 0;
    bins[idx].count++;
  }
  const vMean = sum / speeds.length;
  let maxCount = 0, peakIdx = 0;
  for (let i = 0; i < binCount; i++) if (bins[i].count > maxCount) { maxCount = bins[i].count; peakIdx = i; }
  const vPeak = (bins[peakIdx].v0 + bins[peakIdx].v1) / 2;
  return { bins, vMean, vPeak, maxCount, binWidth };
}

// Pure prep: assemble every readout the overlay draws, so the invariant + the
// render test can inspect the exact data without a canvas. P/T come from the
// motion-graph channel buffers (mean_K, wall_impulse — filled by recordSample);
// the histogram from the live bodies.
export function buildKineticTheoryReadouts(loaded, { pressureWindow = KT_PRESSURE_WINDOW, binCount = KT_HIST_BINS } = {}) {
  const wallImpulseBuf = getBuffer(channelBufferKey('wall_impulse')) ?? [];
  const tBuf = getBuffer(channelBufferKey('mean_K')) ?? [];
  const wallLength = kineticTheoryWallLength(loaded);
  const dt = loaded?.simulation?.dt_s ?? loaded?.scene?.simulation?.dt_s ?? 0;
  const pSeries = buildPressureSeries(wallImpulseBuf, wallLength, dt, pressureWindow);
  const tSeries = tBuf.map((s) => ({ t: s.t, value: s.value }));
  const histogram = speedHistogram(loaded?.bodies ?? [], binCount);
  return { pSeries, tSeries, histogram, wallLength };
}

// Draw the speed histogram into its panel. Bars are the whole readout; the mean
// and peak markers are descriptive; NOTHING is overlaid to compare the bars
// against (enforced by assertNoHistogramReferenceCurve). Returns the inner rect.
function drawSpeedHistogram(ctx, anchor, width, height, hist) {
  const padL = 30, padR = 12, padT = 14, padB = 22;
  const x0 = anchor.x + padL;
  const y0 = anchor.y + padT;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const rect = { x0, y0, x1: x0 + plotW, y1: y0 + plotH };

  // Panel caption.
  ctx.fillStyle = KT_HIST_TITLE_COLOR;
  ctx.font = KT_HIST_TITLE_FONT;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('speed distribution (m/s)', anchor.x + 4, anchor.y + 1);

  // Frame.
  ctx.strokeStyle = KT_HIST_FRAME;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.rect(x0, y0, plotW, plotH);
  ctx.stroke();

  const n = hist.bins.length;
  if (n === 0) {
    ctx.fillStyle = KT_TICK_COLOR;
    ctx.font = KT_TICK_FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('press Play to record', x0 + plotW / 2, y0 + plotH / 2);
    return rect;
  }

  const vMaxDisp = hist.bins[n - 1].v1 || 1;
  const maxCount = Math.max(hist.maxCount, 1);
  const barW = plotW / n;

  // Bars (fills — never strokes, so they are not swept curves).
  ctx.fillStyle = KT_HIST_BAR;
  for (let i = 0; i < n; i++) {
    const c = hist.bins[i].count;
    const bh = (c / maxCount) * plotH;
    if (bh > 0) ctx.fillRect(x0 + i * barW + 1, y0 + plotH - bh, Math.max(1, barW - 2), bh);
  }

  // ⟨v⟩ and peak markers — single-x vertical guides.
  const vToX = (v) => x0 + Math.max(0, Math.min(1, v / vMaxDisp)) * plotW;
  const marker = (v, color, label, labelSide) => {
    const mx = vToX(v);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    ctx.moveTo(mx, y0);
    ctx.lineTo(mx, y0 + plotH);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.font = KT_TICK_FONT;
    ctx.textBaseline = 'top';
    ctx.textAlign = labelSide === 'left' ? 'right' : 'left';
    ctx.fillText(label, labelSide === 'left' ? mx - 2 : mx + 2, y0 + 1);
  };
  marker(hist.vMean, KT_MEAN_COLOR, '⟨v⟩', 'left');   // ⟨v⟩
  marker(hist.vPeak, KT_PEAK_COLOR, 'v_peak', 'right');

  // x-axis end ticks (0 and v_max of the display range).
  ctx.fillStyle = KT_TICK_COLOR;
  ctx.font = KT_TICK_FONT;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.fillText('0', x0, y0 + plotH + 2);
  ctx.textAlign = 'right';
  ctx.fillText(vMaxDisp.toFixed(1), x0 + plotW, y0 + plotH + 2);

  return rect;
}

// Public render entry — the kinetic-theory REPLACEMENT for the motion-graph
// overlay (canvas2d dispatches this instead when isKineticTheoryScene, because a
// single disk's x/y/v is noise for a gas). Anchored bottom-left like the motion
// graph. Returns { pRect, tRect, histRect } — the drawn frames, for the invariant.
export function drawKineticTheoryOverlay(renderer, loaded) {
  const ctx = renderer.ctx;
  const readouts = buildKineticTheoryReadouts(loaded);

  const panelH = KT_TITLE_H + 2 * KT_SUB_H + KT_HIST_H;
  const anchor = { x: KT_PANEL_MARGIN, y: renderer.cssHeight - panelH - KT_PANEL_MARGIN };

  // Panel background (covers every sub-rect ⇒ a legitimate background, exempt
  // from the between-curves fill guard).
  ctx.fillStyle = KT_PANEL_BG;
  ctx.fillRect(anchor.x, anchor.y, KT_PANEL_W, panelH);
  ctx.strokeStyle = KT_PANEL_BORDER;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.rect(anchor.x, anchor.y, KT_PANEL_W, panelH);
  ctx.stroke();

  // Panel title.
  ctx.fillStyle = KT_TITLE_COLOR;
  ctx.font = KT_TITLE_FONT;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('Gas — emergent readings', anchor.x + 6, anchor.y + 2);

  // P subplot (pressure vs time).
  const pAnchor = { x: anchor.x, y: anchor.y + KT_TITLE_H };
  drawSubplot(ctx, pAnchor, KT_PANEL_W, KT_SUB_H, readouts.pSeries, (s) => s.value,
    'P (wall-impulse rate)', KT_P_COLOR, false);
  const pRect = subplotPlotRect(pAnchor, KT_PANEL_W, KT_SUB_H, false);

  // T subplot (⟨K⟩ vs time).
  const tAnchor = { x: anchor.x, y: anchor.y + KT_TITLE_H + KT_SUB_H };
  drawSubplot(ctx, tAnchor, KT_PANEL_W, KT_SUB_H, readouts.tSeries, (s) => s.value,
    'T = ⟨K⟩ per particle', KT_T_COLOR, false);
  const tRect = subplotPlotRect(tAnchor, KT_PANEL_W, KT_SUB_H, false);

  // Speed histogram.
  const histAnchor = { x: anchor.x, y: anchor.y + KT_TITLE_H + 2 * KT_SUB_H };
  const histRect = drawSpeedHistogram(ctx, histAnchor, KT_PANEL_W, KT_HIST_H, readouts.histogram);

  return { pRect, tRect, histRect, readouts };
}
