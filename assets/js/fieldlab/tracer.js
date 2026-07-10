// tracer.js — the portfolio field-lab's PURE Coulomb field/equipotential model.
//
// PROVENANCE: lifted verbatim (physics unchanged) from the Fig. 1 hero tracer
// that shipped inline in public/index.html — the page's OWN numerical tracer,
// NOT the private physics-engine source. Per portfolio plan decision d4
// (2026-07-10): engine-source publication is FROZEN/under review, so the
// interactive field lab (P3) is built on this page tracer, and no physics/sim/
// code is vendored anywhere on the site. This module is the single source of
// truth for the math: the browser controller (fieldlab.js) AND the headless
// test (site/tools/test_fieldlab.py via fieldlab_validate.mjs) both call
// `computeScene` here, so the live demo and the mechanical gate share one code
// path — a green test cannot diverge from what the reader sees.
//
// Physics: superposed 3-D Coulomb point-charge field, sampled in a 2-D plane
// (the classic field-line drawing convention). `chs` is [[x, y, q], ...] in
// screen pixels (y increases downward). No DOM, no imports, no network — it
// runs identically under node (the test harness) and in the browser.
//
// The math is VERIFIED, not assumed (plan constraint 6): fieldlab_validate.mjs
// checks it against analytic cases with computed tolerances —
//   (1) a lone point charge traces perfectly radial lines (angular deviation
//       ~0, i.e. the superposition direction is exactly correct);
//   (2) an equal/opposite dipole (+1/−1) terminates EVERY field line on the
//       sink and none escape (Gauss: net-zero enclosed charge);
//   (3) unequal ratios terminate lines on the sink in the Gauss proportion
//       |q_sink|/|q_source| within a measured tolerance.

// Field lines seeded PER UNIT of source charge (Gauss's-law line density): a
// +2 source seeds 16 lines, +3 seeds 24, etc. This is the "line count ∝ charge"
// convention the hero caption states.
export const LINES_PER_UNIT = 8;

// Default trace parameters — identical to the shipped hero tracer so the
// default (+2 / −1) scene is pixel-for-pixel the figure that was already live.
export const DEFAULTS = Object.freeze({
  r0: 10,            // charge disc radius = seed radius = sink-termination radius
  fieldStep: 2.2,    // Euler step for field lines (fallback: 2.5, see the gate)
  fieldMargin: 60,   // escape margin past the canvas edge before a line stops
  fieldMaxSteps: 3000,
  equipStep: 2.0,
  equipMargin: 40,
  equipMaxSteps: 2400,
});

// gauss_expected(q1, q2): the number of field lines seeded — and therefore the
// expected len(traces_per_charge) at the model layer. Only the positive
// (source) charge seeds lines, so this is LINES_PER_UNIT × |source charge|.
export function gaussExpected(q1, q2) {
  const qs = Math.max(q1 > 0 ? q1 : 0, q2 > 0 ? q2 : 0);
  return LINES_PER_UNIT * Math.abs(qs);
}

// terminationsExpected(q1, q2): Gauss's law — lines that terminate on the sink
// ∝ |sink charge|. Used by the physics check, not the seeding.
export function terminationsExpected(q1, q2) {
  const qsink = Math.min(q1 < 0 ? q1 : 0, q2 < 0 ? q2 : 0);
  return LINES_PER_UNIT * Math.abs(qsink);
}

// Index of the source (largest positive) charge; -1 if there is none.
export function sourceIndex(chs) {
  let idx = -1;
  let best = 0;
  for (let i = 0; i < chs.length; i++) {
    if (chs[i][2] > best) { best = chs[i][2]; idx = i; }
  }
  return idx;
}

// Raw superposed E-field at (px, py). Returns [ex, ey, magnitude] or null when
// too close to a charge (near-bail r2 < 1) or the field is ~0.
export function fieldRaw(px, py, chs) {
  let ex = 0, ey = 0;
  for (let i = 0; i < chs.length; i++) {
    const dx = px - chs[i][0], dy = py - chs[i][1];
    const r2 = dx * dx + dy * dy;
    if (r2 < 1) return null;
    const r3 = Math.pow(r2, 1.5);
    ex += chs[i][2] * dx / r3;
    ey += chs[i][2] * dy / r3;
  }
  const m = Math.hypot(ex, ey);
  if (m === 0) return null;
  return [ex, ey, m];
}

// Scalar potential V = Σ q/r (r floored at 1). Used to Newton-correct
// equipotentials back onto their level set.
export function potentialAt(px, py, chs) {
  let v = 0;
  for (let i = 0; i < chs.length; i++) {
    let r = Math.hypot(px - chs[i][0], py - chs[i][1]);
    if (r < 1) r = 1;
    v += chs[i][2] / r;
  }
  return v;
}

// Index + unit direction at a fractional arc length (the midline arrow spot).
export function arcMeta(pts, frac) {
  const cum = [0];
  let i;
  for (i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  }
  const target = frac * cum[cum.length - 1];
  for (i = 1; i < pts.length - 1 && cum[i] < target; i++) { /* advance */ }
  const dx = pts[i][0] - pts[i - 1][0], dy = pts[i][1] - pts[i - 1][1];
  const m = Math.hypot(dx, dy) || 1;
  return { idx: i, x: pts[i][0], y: pts[i][1], ux: dx / m, uy: dy / m };
}

// Seed angles around the source: uniform Δθ with a half-step offset so the seed
// pattern is mirror-symmetric about the horizontal axis (the hero convention).
export function seedAngles(nLines) {
  const half = Math.PI / nLines;
  const out = [];
  for (let i = 0; i < nLines; i++) out.push(half + 2 * Math.PI * i / nLines);
  return out;
}

// Trace ONE field line from (sx, sy) along E by fixed-step Euler. Stops when it
// enters r0 of ANY negative (sink) charge — recording that charge's index — or
// when it escapes the padded canvas, or on hitting maxSteps (the
// escape-to-edge / max-path-length stop the unequal-charge case needs so an
// un-terminated excess line cannot hang or draw garbage).
export function traceOneField(chs, sx, sy, opts) {
  const step = opts.fieldStep, margin = opts.fieldMargin, maxSteps = opts.fieldMaxSteps;
  const w = opts.w, h = opts.h, r0 = opts.r0;
  let px = sx, py = sy;
  const pts = [[px, py]];
  let terminatedOn = -1;
  for (let k = 0; k < maxSteps; k++) {
    const f = fieldRaw(px, py, chs);
    if (!f) break;
    px += (f[0] / f[2]) * step;
    py += (f[1] / f[2]) * step;
    pts.push([px, py]);
    // Terminate on a sink (negative charge) within r0.
    let hit = -1;
    for (let i = 0; i < chs.length; i++) {
      if (chs[i][2] < 0 && Math.hypot(px - chs[i][0], py - chs[i][1]) < r0) { hit = i; break; }
    }
    if (hit >= 0) { terminatedOn = hit; break; }
    // Escape the padded canvas.
    if (px < -margin || px > w + margin || py < -margin || py > h + margin) break;
  }
  return { pts, terminatedOn };
}

// Seed and trace all field lines out of the source charge. Returns an array of
// { pts, arrow, terminatedOn }; its length is gaussExpected(...) — the model-
// layer count the gate asserts.
export function traceField(chs, opts) {
  const src = opts.sourceIdx != null ? opts.sourceIdx : sourceIndex(chs);
  if (src < 0) return [];
  const cx = chs[src][0], cy = chs[src][1], q = chs[src][2];
  const nLines = LINES_PER_UNIT * Math.abs(q);
  const r0 = opts.r0;
  const lines = [];
  for (const a of seedAngles(nLines)) {
    const sx = cx + r0 * Math.cos(a);
    const sy = cy + r0 * Math.sin(a);
    const { pts, terminatedOn } = traceOneField(chs, sx, sy, opts);
    lines.push({ pts, arrow: arcMeta(pts, 0.5), terminatedOn });
  }
  return lines;
}

// Trace one equipotential from (sx, sy): step perpendicular to E, then
// Newton-correct back onto the level set V0 (V decreases along E, so the
// correction is s = (V − V0) / |E|). Closes the loop when it returns near the
// seed. Mirrors the hero tracer exactly.
export function traceEquip(sx, sy, chs, opts) {
  const step = opts.equipStep, margin = opts.equipMargin, maxSteps = opts.equipMaxSteps;
  const w = opts.w, h = opts.h;
  const pts = [[sx, sy]];
  let px = sx, py = sy;
  const V0 = potentialAt(sx, sy, chs);
  for (let k = 0; k < maxSteps; k++) {
    let f = fieldRaw(px, py, chs);
    if (!f) break;
    px += (-f[1] / f[2]) * step;   // perpendicular to E
    py += (f[0] / f[2]) * step;
    f = fieldRaw(px, py, chs);
    if (!f) break;
    let s = (potentialAt(px, py, chs) - V0) / f[2];
    if (s > step) s = step; else if (s < -step) s = -step;
    px += (f[0] / f[2]) * s;       // Newton-correct back onto V0
    py += (f[1] / f[2]) * s;
    pts.push([px, py]);
    if (k > 14 && Math.hypot(px - sx, py - sy) < step * 1.5) { pts.push([sx, sy]); break; }
    if (px < -margin || px > w + margin || py < -margin || py > h + margin) break;
  }
  return pts;
}

// Seed points for equipotential rings: nested rings OUTWARD from each charge
// (away from the other charge), count/spacing scaling with |charge| so a bigger
// charge gets more, larger rings. Seeding relative to the LIVE charge positions
// is what makes the equipotentials RECOMPUTE on every drag / ratio change.
export function equipSeeds(chs, opts) {
  const r0 = opts.r0;
  const seeds = [];
  for (let i = 0; i < chs.length; i++) {
    // Outward = away from the nearest other charge (falls back to +x if alone).
    let ox = 1, oy = 0;
    let bestD2 = Infinity, oj = -1;
    for (let j = 0; j < chs.length; j++) {
      if (j === i) continue;
      const dx = chs[i][0] - chs[j][0], dy = chs[i][1] - chs[j][1];
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) { bestD2 = d2; oj = j; }
    }
    if (oj >= 0) {
      const dx = chs[i][0] - chs[oj][0], dy = chs[i][1] - chs[oj][1];
      const m = Math.hypot(dx, dy) || 1;
      ox = dx / m; oy = dy / m;
    }
    const m = Math.abs(chs[i][2]);
    const nRings = Math.min(5, 2 + Math.round(m));
    const spread = Math.sqrt(m);
    for (let k = 1; k <= nRings; k++) {
      const off = r0 + k * 13 * spread;
      seeds.push([chs[i][0] + ox * off, chs[i][1] + oy * off]);
    }
  }
  return seeds;
}

// The single entry point the browser controller AND the headless test both
// call. Returns everything needed to draw or to assert on the scene.
export function computeScene(chs, opts) {
  const o = Object.assign({}, DEFAULTS, opts);
  const src = sourceIndex(chs);
  o.sourceIdx = src;
  const lines = traceField(chs, o);
  const equips = equipSeeds(chs, o).map((s) => traceEquip(s[0], s[1], chs, o));
  const tracesPerCharge = {};
  tracesPerCharge[src] = lines.length;
  const terminated = lines.filter((l) => l.terminatedOn >= 0).length;
  return { sourceIdx: src, lines, equips, tracesPerCharge, terminated, escaped: lines.length - terminated };
}

export const NAME = 'fieldlab_tracer';
