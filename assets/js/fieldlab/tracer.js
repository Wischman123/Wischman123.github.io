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

// ---- equipotential level-family constants (plan §4a numeric contract) -------
// The drawn equipotentials are a UNIFORM-ΔV family k·ΔV (k integer, includes 0)
// with ΔV = Vcap_strong / N_SIDE, Vcap_strong = |q_strong| / R_MIN,
// R_MIN = R_MIN_FACTOR·r0. These literals are frozen and MUST match the P3
// Python fixture generator byte-for-byte (the 1e-12 cross-language level match
// silently depends on r0 being identical on both sides).
export const R_MIN_FACTOR = 2.5;   // R_MIN = 2.5·r0 = 25 px at r0=10
export const N_SIDE = 6;           // rings per side of the strongest charge

// Membership slack for the integer-side k-range (plan §4a): reused as the
// endpoint-inclusion tolerance so k_max = floor((Vcap_pos + slack)/ΔV) lands on
// the promised endpoint even when Vcap_pos/ΔV sits one ULP under an integer.
export const LEVEL_MEMBERSHIP_REL = 1e-9;   // × Vcap_strong

// Null-point (E≈0 saddle) bail for the equip tracer (plan §4c-iv). Below this
// |E| the Newton correction s=(V−V0)/|E| and the perpendicular direction are
// ill-conditioned, so the trace bails (bidirectional tracing then draws the
// contour up to the saddle from both sides). MEASURED in P1, recorded in the
// state-dir evidence epsilon_E_measurement_2026-07-10.txt (all 5 presets ×
// canonical / minSep-clamp / dragged):
//   * the smallest |E| on any VISIBLE kept-contour point is 1.594e-6 — the
//     +1/−1 minSep V=0 separatrix at the canvas edge; the canonical & dragged
//     minima are >= 8.4e-6 (far-field tails that dip toward 1e-6 lie in the
//     invisible padded margin and escape the box regardless);
//   * the true on-axis saddle has |E|->0, staying below 1e-6 within ~1 equipStep
//     of it (measured growth 5e-7–2e-5 /px across +2/−1, +3/−1, +3/−2).
// So 1e-6 sits below every legitimate VISIBLE contour field (no visible
// truncation) yet bails within one step of a threaded null.
export const EQUIP_EPS_E = 1e-6;

// Seed-precision V-residual disjunct (plan §4c-i). The seed bisection stops on the
// bracket-width disjunct (≤ 0.05 px) OR this V residual; the seed then gets ONE
// Newton correction before it enters the polyline, so check (c) samples the
// Newton-bound residual, never the bisection-bound one. FROZEN in P2 at 0.1·tol_c:
// P2 measured check (c)'s frozen tolerance tol_c = 1e-5 (max off-level residual
// |V(p)−level| across every traced point of all 5 presets = 1.6445e-6, at the +3/−2
// innermost ring 23.5 px from the strong charge — see the state-dir record
// P2_step0_shipped_family_2026-07-10.txt), so the seed contributes at most 10% of
// tol_c. (P1 shipped a provisional 1e-7; this replaces it with the principled
// 0.1·tol_c per §4c-i's freeze-order note.)
export const EQUIP_SEED_V_RESID = 1e-6;   // = 0.1 · tol_c (tol_c = 1e-5, P2-frozen)

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

// ---------------------------------------------------------------------------
// LEVEL-FIRST EQUIPOTENTIALS (plan fieldlab_equipotential_levels_v1, §4a–4d)
//
// The equipotential layer is chosen as potential VALUES, not seed geometry: a
// uniform-ΔV family (so spacing honestly encodes |E|), seeded by scanning the
// charge axis for every level's crossings, traced level-true and bidirectionally
// so open and mid-band contours (incl. the V=0 separatrix) render in full.
// ---------------------------------------------------------------------------

// selectEquipLevels(chs, opts): the uniform-ΔV family, PURE and depending ONLY
// on the charge MAGNITUDES (never positions — the level-set is drag-invariant,
// plan §4a). ΔV = Vcap_strong / N_SIDE, Vcap_strong = |q_strong| / R_MIN,
// R_MIN = R_MIN_FACTOR·r0. The k-range is computed INTEGER-SIDE (plan §4a's
// mandatory form) — the keep-if SCAN form is forbidden because it coin-flips an
// endpoint by 1 ULP. Levels are RAW doubles k·ΔV: no rounding (NOT
// even_levels()'s 6-dp rounding, which breaks uniform-ΔV for non-decimal ΔV).
// Returns the levels plus the constants the P3 fixture and check (g) cross-check.
export function selectEquipLevels(chs, opts) {
  const o = Object.assign({}, DEFAULTS, opts);
  const r0 = o.r0;
  const R_MIN = R_MIN_FACTOR * r0;
  let qPos = 0, qNeg = 0;                 // strongest +charge, most-negative charge
  for (let i = 0; i < chs.length; i++) {
    const q = chs[i][2];
    if (q > qPos) qPos = q;
    if (q < qNeg) qNeg = q;
  }
  const qStrong = Math.max(qPos, Math.abs(qNeg));
  if (qStrong <= 0) {
    return { levels: [], dV: 0, kMin: 0, kMax: 0, VcapStrong: 0, VcapPos: 0, VcapNeg: 0, r0, R_MIN, N_SIDE };
  }
  const VcapStrong = qStrong / R_MIN;
  const dV = VcapStrong / N_SIDE;
  const VcapPos = qPos / R_MIN;           // 0 when there is no positive charge
  const VcapNeg = Math.abs(qNeg) / R_MIN; // 0 when there is no negative charge
  const slack = LEVEL_MEMBERSHIP_REL * VcapStrong;   // ties on a ULP-boundary preset
  // Single-signed degenerate branch needs NO separate code: a missing sign's
  // Vcap is 0, so k_min = −floor((0+slack)/ΔV) = −floor(6e-9) = 0 (plan §4a).
  const kMax = Math.floor((VcapPos + slack) / dV);
  const kMin = -Math.floor((VcapNeg + slack) / dV);
  const levels = [];
  for (let k = kMin; k <= kMax; k++) levels.push(k * dV);
  return { levels, dV, kMin, kMax, VcapStrong, VcapPos, VcapNeg, r0, R_MIN, N_SIDE };
}

// clipLineToBox(bx, by, dx, dy, xlo, xhi, ylo, yhi): the [tMin, tMax] param
// range for which (bx,by)+t·(dx,dy) lies inside the box, or null. Used to extend
// the charge-axis scan across the full padded canvas (slab / Liang-Barsky clip).
function clipLineToBox(bx, by, dx, dy, xlo, xhi, ylo, yhi) {
  let tmin = -Infinity, tmax = Infinity;
  if (Math.abs(dx) < 1e-12) {
    if (bx < xlo || bx > xhi) return null;
  } else {
    let ta = (xlo - bx) / dx, tb = (xhi - bx) / dx;
    if (ta > tb) { const s = ta; ta = tb; tb = s; }
    tmin = Math.max(tmin, ta); tmax = Math.min(tmax, tb);
  }
  if (Math.abs(dy) < 1e-12) {
    if (by < ylo || by > yhi) return null;
  } else {
    let ta = (ylo - by) / dy, tb = (yhi - by) / dy;
    if (ta > tb) { const s = ta; ta = tb; tb = s; }
    tmin = Math.max(tmin, ta); tmax = Math.min(tmax, tb);
  }
  if (tmin > tmax) return null;
  return [tmin, tmax];
}

// equipSeedsForLevels(chs, levels, opts): axis-scan seeding (plan §4b). Sample V
// densely along the full charge axis extended to the padded canvas; per level,
// bracket sign changes of V−level and bisect to a stopping rule; ONE Newton
// correction lands the seed on the level (the seed IS a trace point, §4c-i).
// COMPLETENESS: two point-charge equipotentials are surfaces of revolution about
// the charge axis, so every planar component crosses that line — axis-scan
// cannot miss a component. That argument holds ONLY for N<=2 (asserted).
// SEED-DROP guard (§4b): drop crossings within r_drop ≈ 15·equipStep/(2π) ≈ 5 px
// of a charge — sized from the trace's own failure modes (fieldRaw r<1 bail;
// rings too small for the >14-step closure window), NOT from R_MIN, so the +3/−1
// k=−2 endpoint (axis crossings at r≈19–20 px) and the minSep separatrix survive.
// Each returned seed carries its TARGET level for level-true tracing.
export function equipSeedsForLevels(chs, levels, opts) {
  if (chs.length > 2) {
    throw new Error('equipSeedsForLevels: axis-scan completeness holds only for '
      + 'N<=2 point charges; N>' + 2 + ' needs pairwise scan lines + off-axis '
      + 'component handling (plan §4b N<=2 precondition)');
  }
  const o = Object.assign({}, DEFAULTS, opts);
  const w = o.w, h = o.h, margin = o.equipMargin;
  if (!chs.length) return [];
  // Scan line: through both charges (N=2), or +x through the single charge (N=1,
  // trivially complete by spherical symmetry).
  let bx = chs[0][0], by = chs[0][1], dx = 1, dy = 0;
  if (chs.length === 2) { dx = chs[1][0] - chs[0][0]; dy = chs[1][1] - chs[0][1]; }
  const dm = Math.hypot(dx, dy) || 1;
  dx /= dm; dy /= dm;
  const box = clipLineToBox(bx, by, dx, dy, -margin, w + margin, -margin, h + margin);
  if (!box) return [];
  const [t0, t1] = box;
  const nSamp = 2000;
  const ts = new Array(nSamp), vs = new Array(nSamp);
  for (let i = 0; i < nSamp; i++) {
    const t = t0 + (t1 - t0) * i / (nSamp - 1);
    ts[i] = t;
    vs[i] = potentialAt(bx + dx * t, by + dy * t, chs);
  }
  const rDrop = 15 * o.equipStep / (2 * Math.PI);   // ~5 px at equipStep=2 (§4b)
  const seeds = [];
  for (let li = 0; li < levels.length; li++) {
    const level = levels[li];
    for (let i = 1; i < nSamp; i++) {
      const fa = vs[i - 1] - level, fb = vs[i] - level;
      if (fa === 0 || (fa < 0) !== (fb < 0)) {
        // bisect the [i-1, i] bracket to the P1 stopping rule
        let ta = ts[i - 1], tb = ts[i], fA = fa;
        for (let it = 0; it < 60; it++) {
          if (Math.abs(tb - ta) <= 0.05) break;      // bracket-width disjunct (px)
          const tm = 0.5 * (ta + tb);
          const fm = potentialAt(bx + dx * tm, by + dy * tm, chs) - level;
          if (Math.abs(fm) <= EQUIP_SEED_V_RESID) { ta = tb = tm; break; }
          if ((fm < 0) === (fA < 0)) { ta = tm; fA = fm; } else { tb = tm; }
        }
        const tmid = 0.5 * (ta + tb);
        let sx = bx + dx * tmid, sy = by + dy * tmid;
        // ONE Newton correction of the seed onto the level (seed IS a trace point)
        const fr = fieldRaw(sx, sy, chs);
        if (fr && fr[2] >= EQUIP_EPS_E) {
          let s = (potentialAt(sx, sy, chs) - level) / fr[2];
          if (s > o.equipStep) s = o.equipStep; else if (s < -o.equipStep) s = -o.equipStep;
          sx += (fr[0] / fr[2]) * s;
          sy += (fr[1] / fr[2]) * s;
        }
        // seed-drop guard
        let tooClose = false;
        for (let c = 0; c < chs.length; c++) {
          if (Math.hypot(sx - chs[c][0], sy - chs[c][1]) < rDrop) { tooClose = true; break; }
        }
        if (!tooClose) seeds.push({ x: sx, y: sy, level });
      }
    }
  }
  return seeds;
}

// traceEquipDir: ONE directional equipotential trace from (sx, sy) along the
// perpendicular to E (dir = +1 or −1 chooses the side). Level-true: V0 = the
// requested LEVEL (§4c-i), NOT potentialAt(seed). Bails at the E≈0 null point
// (|E| < EQUIP_EPS_E, §4c-iv). Returns { pts, closed }.
function traceEquipDir(sx, sy, level, o, dir) {
  const step = o.equipStep, margin = o.equipMargin, maxSteps = o.equipMaxSteps;
  const w = o.w, h = o.h, chs = o.chs;
  const pts = [[sx, sy]];
  let px = sx, py = sy, closed = false;
  for (let k = 0; k < maxSteps; k++) {
    let f = fieldRaw(px, py, chs);
    if (!f || f[2] < EQUIP_EPS_E) break;         // null-point / near-charge bail
    px += dir * (-f[1] / f[2]) * step;           // perpendicular to E
    py += dir * (f[0] / f[2]) * step;
    f = fieldRaw(px, py, chs);
    if (!f || f[2] < EQUIP_EPS_E) break;
    let s = (potentialAt(px, py, chs) - level) / f[2];   // V0 = level
    if (s > step) s = step; else if (s < -step) s = -step;
    px += (f[0] / f[2]) * s;                      // Newton-correct onto the level
    py += (f[1] / f[2]) * s;
    pts.push([px, py]);
    if (k > 14 && Math.hypot(px - sx, py - sy) < step * 1.5) { pts.push([sx, sy]); closed = true; break; }
    if (px < -margin || px > w + margin || py < -margin || py > h + margin) break;
  }
  return { pts, closed };
}

// traceEquip(sx, sy, level, chs, opts): the full contour through the seed.
// Traces forward; if it did NOT close (margin escape, fieldRaw/null bail, or
// maxSteps exhaustion — regardless of reason, §4c-ii), re-traces the other
// direction and concatenates reversed, deduping the shared seed. Returns
// { level, pts, closed } (closed = endpoints within closure distance).
export function traceEquip(sx, sy, level, chs, opts) {
  const o = Object.assign({}, DEFAULTS, opts, { chs });
  const step = o.equipStep;
  const fwd = traceEquipDir(sx, sy, level, o, +1);
  if (fwd.closed) return { level, pts: fwd.pts, closed: true };
  const bwd = traceEquipDir(sx, sy, level, o, -1);
  const pts = bwd.pts.slice().reverse().concat(fwd.pts.slice(1)); // [...bwd, seed, ...fwd]
  const a = pts[0], b = pts[pts.length - 1];
  const closed = pts.length > 3 && Math.hypot(a[0] - b[0], a[1] - b[1]) < step * 1.5;
  return { level, pts, closed };
}

// Point-to-segment distance + "is (px,py) within tol of any polyline" — the
// per-level closed-contour dedup test (§4c-iii).
function pointSegDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
function nearAnyPolyline(px, py, polylines, tol) {
  for (let p = 0; p < polylines.length; p++) {
    const poly = polylines[p];
    for (let i = 1; i < poly.length; i++) {
      if (pointSegDist(px, py, poly[i - 1][0], poly[i - 1][1], poly[i][0], poly[i][1]) < tol) return true;
    }
  }
  return false;
}

// The single entry point the browser controller AND the headless test both
// call. `equips` is now the TAGGED shape [{ level, pts }, …] (plan §4d).
export function computeScene(chs, opts) {
  const o = Object.assign({}, DEFAULTS, opts);
  const src = sourceIndex(chs);
  o.sourceIdx = src;
  const lines = traceField(chs, o);

  // Level-first equipotentials: choose levels, seed by axis-scan, trace each.
  const { levels } = selectEquipLevels(chs, o);
  const seeds = equipSeedsForLevels(chs, levels, o);
  const equips = [];
  // Per-level dedup: a CLOSED loop crosses the axis twice, so its second seed
  // lies on the already-traced loop — skip it. Open/truncated polylines never
  // suppress later seeds (they may hold a level's untraced remainder, §4c-iii).
  const closedByLevel = new Map();
  for (let si = 0; si < seeds.length; si++) {
    const seed = seeds[si];
    const prior = closedByLevel.get(seed.level);
    if (prior && nearAnyPolyline(seed.x, seed.y, prior, 2 * o.equipStep)) continue;
    const tr = traceEquip(seed.x, seed.y, seed.level, chs, o);
    if (tr.pts.length < 2) continue;
    equips.push({ level: seed.level, pts: tr.pts });
    if (tr.closed) {
      let arr = closedByLevel.get(seed.level);
      if (!arr) { arr = []; closedByLevel.set(seed.level, arr); }
      arr.push(tr.pts);
    }
  }

  const tracesPerCharge = {};
  tracesPerCharge[src] = lines.length;
  const terminated = lines.filter((l) => l.terminatedOn >= 0).length;
  return {
    sourceIdx: src, lines, equips, levels,
    tracesPerCharge, terminated, escaped: lines.length - terminated,
  };
}

export const NAME = 'fieldlab_tracer';
