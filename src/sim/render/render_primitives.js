// render_primitives.js — shared render helpers (render layer).
//
// These primitives were extracted from canvas2d.js (roadmap F1 /
// sim_equipotential_overlay P2) to BREAK a would-be import cycle: the new
// field_overlay.js REUSES the streamline integrator + arrow/polyline drawers,
// while canvas2d.js's render() CALLS field_overlay.js::drawFieldOverlay. If
// these primitives stayed in canvas2d.js the two modules would import each
// other (canvas2d ↔ field_overlay) — a real init-order hazard ES live-bindings
// only paper over. With the primitives here, BOTH canvas2d.js and
// field_overlay.js import DOWN into render_primitives.js and the
// canvas2d → field_overlay edge stays strictly one-directional.
//
// This module imports nothing from the render layer (it is a leaf), so it can
// never participate in a render-layer cycle.
//
// Known duplication (debt, pre-existing, out of F1 scope): fbd_overlay.js
// carries its OWN local drawArrow free function of the same shape. F1 does not
// consolidate it (that is unrelated churn); a future cleanup could route
// fbd_overlay at this drawArrow.

// |field| below this ⇒ terminate the trace (0/0 = NaN would poison a draw).
// Single-sourced here; canvas2d.js imports it for streamlineSeeds too.
export const STREAMLINE_EPS = 1e-9;

// Sample-grid resolution (samples per axis) for the arrow grid AND the F1
// field/potential overlay. Single-sourced here so canvas2d.js's drawFields and
// field_overlay.js's computeFieldOverlay derive the SAME gridSpacing (and hence
// the same view-derived rClip) instead of drifting apart.
export const FIELD_GRID_COUNT = 9;

// Field-agnostic streamline integrator. Walks a polyline from `seed` by asking
// the closure `sampleDir(pos)` for the local IN-PLANE field vector {x,y} and
// stepping `stepM` along its unit direction. World coords in and out; the SAME
// helper serves E_at and B_at and the superposed field sampler.
//
// Two DISTINCT termination guards:
//   (a) sampleDir THROWS  → singularity (a source at r=0). Caught and stops.
//   (b1) |field| < eps     → genuine non-throwing zero (a masked/zero sample or
//        a field null). Terminate BEFORE normalizing — this is exactly why a
//        masked E:{0,0} from the superposition sampler terminates cleanly with
//        no NaN vertex (the eps guard fires before the ux=v.x/mag divide).
//   (b2) direction reversal → a fixed-arclength step carried us ACROSS a field
//        null; stop AT the crossing rather than oscillating over it.
// Returns a polyline of ≥1 world vertex (the seed); never a NaN coordinate.
export function traceStreamline(sampleDir, seed, stepM, maxSteps, eps = STREAMLINE_EPS) {
  const verts = [{ x: seed.x, y: seed.y }];
  let p = verts[0];
  let prevUx = null, prevUy = null;
  for (let step = 0; step < maxSteps; step++) {
    let v;
    try {
      v = sampleDir(p);
    } catch {
      break;                                  // guard (a): singularity thrown
    }
    if (!v) break;
    const mag = Math.hypot(v.x, v.y);
    if (!(mag >= eps)) break;                 // guard (b1): zero-magnitude / NaN
    const ux = v.x / mag, uy = v.y / mag;
    // guard (b2): reversal ⇒ we stepped across a field null.
    if (prevUx !== null && ux * prevUx + uy * prevUy < 0) break;
    const nx = p.x + ux * stepM;
    const ny = p.y + uy * stepM;
    if (!Number.isFinite(nx) || !Number.isFinite(ny)) break;   // belt + suspenders
    p = { x: nx, y: ny };
    verts.push(p);
    prevUx = ux; prevUy = uy;
  }
  return verts;
}

// Draw a single arrow (shaft + two barbs) from `tail` to `head` in PIXEL
// space. `headLen` is the barb length in px. No-op for a sub-pixel shaft. The
// caller sets strokeStyle / lineWidth / globalAlpha before calling.
export function drawArrow(ctx, tail, head, headLen = 5) {
  const dx = head.x - tail.x;
  const dy = head.y - tail.y;
  const len = Math.hypot(dx, dy);
  if (len < 1) return;
  ctx.beginPath();
  ctx.moveTo(tail.x, tail.y);
  ctx.lineTo(head.x, head.y);
  const ux = dx / len;
  const uy = dy / len;
  const ang = Math.atan2(uy, ux);
  const left = ang + Math.PI - 0.42;
  const right = ang + Math.PI + 0.42;
  ctx.lineTo(head.x + Math.cos(left) * headLen, head.y + Math.sin(left) * headLen);
  ctx.moveTo(head.x, head.y);
  ctx.lineTo(head.x + Math.cos(right) * headLen, head.y + Math.sin(right) * headLen);
  ctx.stroke();
}

// Stroke a world-space polyline, mapping each vertex to pixels via `toPx`
// (a function world-loc -> pixel-loc). No-op for fewer than 2 vertices.
// The caller sets strokeStyle / lineWidth / globalAlpha before calling.
export function drawWorldPolyline(ctx, toPx, worldPts) {
  if (!worldPts || worldPts.length < 2) return;
  ctx.beginPath();
  const p0 = toPx(worldPts[0]);
  ctx.moveTo(p0.x, p0.y);
  for (let k = 1; k < worldPts.length; k++) {
    const pk = toPx(worldPts[k]);
    ctx.lineTo(pk.x, pk.y);
  }
  ctx.stroke();
}

export const NAME = 'render_primitives';
