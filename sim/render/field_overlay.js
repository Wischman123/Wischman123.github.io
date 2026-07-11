// field_overlay.js — the F1 field/potential overlay (render layer).
//
// One shared render module that samples a grid via the pure engine sampler
// (field_sampler.js) and produces three toggleable layers — superposed field
// lines, equipotential contours, and a vector field — masking singular cells.
// It is a STUDENT-TOGGLE discovery layer (never auto-shown; see preset_gating
// / toolbar), so it reveals the E/V structure a student has been reasoning
// about for a calibration-not-evaluation comparison to their own prediction.
//
// Layering (imports DOWN only — the sanctioned render→engine direction):
//   field_overlay.js → field_sampler.js (engine), fields.js (engine, source
//   enumeration), render_primitives.js (shared render leaf), and
//   field_overlay_geometry.js (pure geometry). It is imported BY canvas2d.js's
//   render() (P4) — a strictly one-directional edge, because the shared
//   primitives were lifted into render_primitives.js to break the cycle.
//
// This module renders NO user-facing TEXT. It draws only geometry (field
// lines, contours, arrows). All overlay labels and the descriptive prediction-
// comparison string live in sim/ui/ and are rendered there — which is exactly
// what the P3 no_kohn_drift binding asserts (field_overlay.js emits no bare
// user-facing strings), so the sim/ui/-scoped anti-Kohn scan suffices.
//
// See field_sampler.js's "Known limitations / debt" block for the k_e and
// pointChargeField duplication and the UniformField/DipoleField equipotential
// exclusion. Extended-charge artifact: a line/sheet/ring source is N pinned
// point charges, so near it the overlay shows N lumps + N masked spots, not a
// smooth line-charge field — rClip is kept large enough to hide the per-charge
// singularities; this is a known limitation of the reveal for extended-charge
// scenes.

import {
  traceStreamline,
  drawArrow,
  drawWorldPolyline,
  FIELD_GRID_COUNT,
} from './render_primitives.js';
import { sampleField } from '../engine/field_sampler.js';
import { RadialField, emFields } from '../engine/fields.js';
import { marchingSquares, seedRing } from './field_overlay_geometry.js';

// --- Module constants (single-sourced; a maintainer tunes contour density or
// mask size by editing THIS labelled block) -------------------------------
const RCLIP_GRID_FRACTION = 0.5;      // rClip = RCLIP_GRID_FRACTION · gridSpacing
// Equipotential levels are a UNIFORM-ΔV family (equal potential steps) so
// contour DENSITY reads as field strength — bunched where |E| is strong, spread
// where it is weak (the classroom convention; matches the site field lab and
// em_field_map.py::even_levels). LEVEL_COUNT contours span a V-range trimmed by
// LEVEL_TRIM_FRAC on each end so the near-singular V→∞ cells beside a charge
// cannot blow up ΔV. Tune contour density / trim by editing these two.
const LEVEL_COUNT = 12;               // ~contours across the robust V-range (≈6 per side, signed)
const LEVEL_TRIM_FRAC = 0.02;         // trim this fraction of near-singular samples off each end before sizing ΔV

const SEED_RING_COUNT = 12;           // field-line seeds ringed around each source
const SEED_RING_RADIUS_FRACTION = 0.75; // ring radius as ×gridSpacing (> rClip=0.5·gridSpacing so seeds aren't masked)
const BG_SEED_GRID = 4;               // background field-line seed grid (per axis); trace along +E
const OVERLAY_STEPS_ACROSS = 60;      // integrator steps for a line to cross the view once
const OVERLAY_MAX_STEPS = 400;        // hard cap on a field line's vertex count
const ARROW_LEN_FRACTION = 0.4;       // vector-field arrow length as ×gridSpacing (world)
const ARROW_HEAD_PX = 4;              // arrowhead barb length (px)

// Draw styles (geometry only — no text). Kept local so this module never
// imports canvas2d.js (which would re-form the cycle).
const FIELDLINE_STYLE = '#2E75B6';    // superposed field lines (blue)
const CONTOUR_STYLE = '#C0504D';      // equipotentials (muted red)
const ARROW_STYLE = '#3B7A57';        // vector field (green)
const OVERLAY_ALPHA = 0.6;

// View world-rect for the overlay grid — the SAME 85%-of-viewport rect that
// drawStreamlines/drawFields use, read off the renderer (render-layer state).
function overlayView(renderer) {
  const halfW = (renderer.cssWidth / 2 / renderer.scale) * 0.85;
  const halfH = (renderer.cssHeight / 2 / renderer.scale) * 0.85;
  return {
    left: renderer.originX - halfW,
    right: renderer.originX + halfW,
    bot: renderer.originY - halfH,
    top: renderer.originY + halfH,
  };
}

// Every charged source's world position + charge SIGN — RadialField centers and
// charged bodies of BOTH signs. Field lines are seeded around each so a single-
// signed scene (e.g. a lone −Q) still gets radial coverage.
function collectSeedSources(loaded) {
  const sources = [];
  if (loaded.fields) {
    for (const f of emFields(loaded.fields)) {  // skip non-EM (fluid) entries — sim_buoyancy_fluids P3
      if (f instanceof RadialField && typeof f.charge_C === 'number' && f.charge_C !== 0) {
        sources.push({ x: f.center.x, y: f.center.y, sign: Math.sign(f.charge_C) });
      }
    }
  }
  for (const b of loaded.bodies ?? []) {
    if (typeof b.charge === 'number' && b.charge !== 0) {
      sources.push({ x: b.position.x, y: b.position.y, sign: Math.sign(b.charge) });
    }
  }
  return sources;
}

// Seed set for the superposed field lines: a sign-tagged ring around every
// source (radius > rClip so the first sample isn't masked) plus a background
// grid (sign +1). A + source's ring traces along +E (outward); a − source's
// ring traces along −E (also emanating outward from that source).
function buildSeeds(loaded, view, gridSpacing) {
  const seeds = [];
  const ringRadius = SEED_RING_RADIUS_FRACTION * gridSpacing;
  for (const src of collectSeedSources(loaded)) {
    for (const p of seedRing(src.x, src.y, ringRadius, SEED_RING_COUNT)) {
      seeds.push({ seed: p, sign: src.sign });
    }
  }
  const { left, right, bot, top } = view;
  if (BG_SEED_GRID >= 2) {
    const bdx = (right - left) / (BG_SEED_GRID - 1);
    const bdy = (top - bot) / (BG_SEED_GRID - 1);
    for (let i = 0; i < BG_SEED_GRID; i++) {
      for (let j = 0; j < BG_SEED_GRID; j++) {
        seeds.push({ seed: { x: left + j * bdx, y: bot + i * bdy }, sign: 1 });
      }
    }
  }
  return seeds;
}

// Equipotential contour-value selection over a scalar V grid (NaN = masked).
// UNIFORM-ΔV family: LEVEL_COUNT contours at integer multiples of a single ΔV,
// so consecutive contour levels are EXACTLY ΔV apart (equal potential steps) and their
// spatial density honestly encodes |E|. All statistics use the FINITE samples
// only, so a masked NaN never poisons the family or defeats the empty-case
// guard. The [vLo, vHi] range is trimmed by LEVEL_TRIM_FRAC on each end so the
// near-singular V→∞ cells beside a charge cannot blow up ΔV. 0 is included iff
// the scene straddles it (signed) — that draws the separatrix while keeping the
// ladder uniform THROUGH zero (see em_field_map.py::even_levels/validate_v_levels).
export function selectLevels(Vgrid) {
  const finite = [];
  for (const row of Vgrid) {
    for (const v of row) if (Number.isFinite(v)) finite.push(v);
  }
  if (finite.length < 2) return [];                         // <2 finite samples → nothing to contour
  finite.sort((a, b) => a - b);
  if (finite[0] === finite[finite.length - 1]) return [];   // single-value grid → empty-case guard

  // Robust range: trim the near-singular tail on each end before sizing ΔV.
  const vLo = quantile(finite, LEVEL_TRIM_FRAC);
  const vHi = quantile(finite, 1 - LEVEL_TRIM_FRAC);
  if (!(vHi > vLo)) return [];

  // One uniform step across the robust range; every contour level is an integer
  // multiple of it (k·ΔV), so ΔV is identical between adjacent pairs and k=0
  // lands in the family exactly when the scene is signed.
  const dV = (vHi - vLo) / LEVEL_COUNT;
  if (!(dV > 0)) return [];
  const contourVs = [];
  for (let k = Math.ceil(vLo / dV); k <= Math.floor(vHi / dV); k++) contourVs.push(k * dV);
  return contourVs;
}

// Linear-interpolated quantile of a PRE-SORTED ascending array (p in [0,1]).
// Used to trim the near-singular V tail before sizing the uniform ΔV.
function quantile(sorted, p) {
  if (sorted.length === 1) return sorted[0];
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// Pure DATA pass (no canvas). Samples a FIELD_GRID_COUNT grid over the explicit
// `view` world-rect and returns plain geometry:
//   { streamlines: [[{x,y}...]], contours: [[{x,y},{x,y}]...], arrows: [{x,y,ex,ey}] }
// `opts` = { fieldLines, equipotentials, vectors } (booleans). rClip is derived
// internally from `view` (render/view state absent from `loaded` and `opts`) and
// threaded into EVERY sampleField call.
export function computeFieldOverlay(loaded, view, opts = {}) {
  const { fieldLines = false, equipotentials = false, vectors = false } = opts;
  const { left, right, bot, top } = view;
  const extent = Math.max(right - left, top - bot);
  const gridSpacing = extent / FIELD_GRID_COUNT;
  const rClip = RCLIP_GRID_FRACTION * gridSpacing;
  const sampleOpts = { rClip };

  const result = { streamlines: [], contours: [], arrows: [] };
  if (!(extent > 0)) return result;

  const N = FIELD_GRID_COUNT;
  const dx = (right - left) / (N - 1);
  const dy = (top - bot) / (N - 1);

  // Sample the grid ONCE; reuse for equipotentials + vectors.
  const Vgrid = [];
  const samples = [];
  const pts = [];
  for (let i = 0; i < N; i++) {
    Vgrid[i] = [];
    samples[i] = [];
    pts[i] = [];
    const y = bot + i * dy;
    for (let j = 0; j < N; j++) {
      const x = left + j * dx;
      const p = { x, y };
      const s = sampleField(p, loaded, sampleOpts);
      pts[i][j] = p;
      samples[i][j] = s;
      Vgrid[i][j] = s.singular ? NaN : s.V;
    }
  }

  // Vector field — one arrow per non-singular grid cell.
  if (vectors) {
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        const s = samples[i][j];
        if (s.singular) continue;
        const mag = Math.hypot(s.E.x, s.E.y);
        if (!(mag > 0)) continue;
        result.arrows.push({ x: pts[i][j].x, y: pts[i][j].y, ex: s.E.x, ey: s.E.y });
      }
    }
  }

  // Equipotentials — marching-squares at the selected contour values (NaN corners skip).
  if (equipotentials) {
    for (const threshold of selectLevels(Vgrid)) {
      const segs = marchingSquares(Vgrid, threshold, left, bot, dx, dy);
      for (const seg of segs) result.contours.push(seg);
    }
  }

  // Field lines — trace the superposed E from every seed. A masked E:{0,0}
  // terminates the trace cleanly (render_primitives' eps guard), so a bare
  // sampleDir needs no terminate sentinel.
  if (fieldLines) {
    const stepM = extent / OVERLAY_STEPS_ACROSS;
    for (const { seed, sign } of buildSeeds(loaded, view, gridSpacing)) {
      const sampleDir = sign >= 0
        ? (pt) => sampleField(pt, loaded, sampleOpts).E
        : (pt) => {
            const E = sampleField(pt, loaded, sampleOpts).E;
            return { x: -E.x, y: -E.y };
          };
      const line = traceStreamline(sampleDir, seed, stepM, OVERLAY_MAX_STEPS);
      if (line.length >= 2) result.streamlines.push(line);
    }
  }

  return result;
}

// Thin DRAW pass. Extracts the view world-rect from `renderer`, computes the
// overlay geometry, and strokes each primitive via the shared render helpers.
export function drawFieldOverlay(renderer, loaded, opts = {}) {
  if (!loaded) return;
  const view = overlayView(renderer);
  const data = computeFieldOverlay(loaded, view, opts);
  const ctx = renderer.ctx;
  const toPx = (pt) => renderer.worldToPx(pt);
  const extent = Math.max(view.right - view.left, view.top - view.bot);
  const gridSpacing = extent / FIELD_GRID_COUNT;
  const arrowLenWorld = ARROW_LEN_FRACTION * gridSpacing;

  ctx.save();
  ctx.globalAlpha = OVERLAY_ALPHA;
  ctx.lineWidth = 1;

  // Field lines.
  ctx.strokeStyle = FIELDLINE_STYLE;
  for (const line of data.streamlines) drawWorldPolyline(ctx, toPx, line);

  // Equipotential contours.
  ctx.strokeStyle = CONTOUR_STYLE;
  for (const seg of data.contours) drawWorldPolyline(ctx, toPx, seg);

  // Vector field — fixed world-length arrows in the E direction, mapped to px.
  ctx.strokeStyle = ARROW_STYLE;
  for (const a of data.arrows) {
    const mag = Math.hypot(a.ex, a.ey);
    if (!(mag > 0)) continue;
    const ux = a.ex / mag;
    const uy = a.ey / mag;
    const tail = toPx({ x: a.x, y: a.y });
    const head = toPx({ x: a.x + ux * arrowLenWorld, y: a.y + uy * arrowLenWorld });
    drawArrow(ctx, tail, head, ARROW_HEAD_PX);
  }

  ctx.restore();
}

export const NAME = 'field_overlay';
