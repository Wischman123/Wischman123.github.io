// sim/engine/extended_object_geometry.js
//
// Phase A5 — pure world-geometry for EXTENDED charge objects (line / sheet /
// ring). An extended object ships as a CLOUD of N pinned point-charge bodies
// (e.g. charged_line_perpendicular = 100 `line_*` bodies); rendering each as a
// 10 px disk reads as a dotted row, not a solid line. This module derives a
// compact `extent` descriptor from the members' world positions so the render
// layer can draw ONE glyph at the object's true shape/extent instead.
//
// WHY THIS LIVES IN THE ENGINE LAYER (not beside rodEndpointsWorld in the
// render layer): the extent is `read-only` scene geometry computed ONCE at
// scene LOAD (scene.js) — never in a per-frame draw leg (the read-only render
// invariant; anti-target #2 / risk #2 of the A5 plan). Because BOTH the loader
// (engine, at load) and the renderer (render, at draw) consume it, it must live
// where both can import it WITHOUT the engine depending on the render layer.
// render→engine is the sanctioned direction (canvas2d.js already imports many
// engine modules); engine→render would be a layering inversion. rodEndpointsWorld
// stays in canvas2d.js precisely because it is render-only (used solely by the
// sliding-rail draw path); these helpers have a different, dual-layer consumer
// profile, so they belong in the shared-downward (engine) layer.
//
// Every function here is PURE (positions in → geometry out, no ctx, no state
// mutation) and unit-tested against known coordinates (calculate-never-guess).

/**
 * Endpoints of a set of (nominally collinear) member positions.
 *
 * Uses the double-sweep diameter method: from an arbitrary seed find the
 * farthest point p1, then from p1 find the farthest point p2 — for a collinear
 * set p1/p2 are exactly the two ends, in O(n), independent of member ORDER
 * (so we never assume line_0…line_99 are stored end-to-end).
 *
 * @param {{x:number,y:number}[]} positions
 * @returns {{a:{x,y}, b:{x,y}}} the two extreme endpoints (world metres)
 */
export function lineExtentWorld(positions) {
  if (!positions || positions.length === 0) {
    throw new Error('lineExtentWorld: needs at least one position');
  }
  if (positions.length === 1) {
    const p = positions[0];
    return { a: { x: p.x, y: p.y }, b: { x: p.x, y: p.y } };
  }
  const farFrom = (idx) => {
    let best = idx;
    let bestD = -1;
    for (let j = 0; j < positions.length; j++) {
      const dx = positions[j].x - positions[idx].x;
      const dy = positions[j].y - positions[idx].y;
      const d = dx * dx + dy * dy;
      if (d > bestD) {
        bestD = d;
        best = j;
      }
    }
    return best;
  };
  const i1 = farFrom(0);
  const i2 = farFrom(i1);
  const a = positions[i1];
  const b = positions[i2];
  return { a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y } };
}

/**
 * Axis-aligned bounding-box corners of a set of member positions (a sheet is a
 * 2-D grid of charges). Corners are returned CCW starting bottom-left, so the
 * render layer can stroke/fill them as a closed rectangle.
 *
 * @param {{x:number,y:number}[]} positions
 * @returns {{corners:{x,y}[]}} four corners: BL, BR, TR, TL (world metres)
 */
export function sheetCornersWorld(positions) {
  if (!positions || positions.length === 0) {
    throw new Error('sheetCornersWorld: needs at least one position');
  }
  let xmin = Infinity;
  let xmax = -Infinity;
  let ymin = Infinity;
  let ymax = -Infinity;
  for (const p of positions) {
    if (p.x < xmin) xmin = p.x;
    if (p.x > xmax) xmax = p.x;
    if (p.y < ymin) ymin = p.y;
    if (p.y > ymax) ymax = p.y;
  }
  return {
    corners: [
      { x: xmin, y: ymin },
      { x: xmax, y: ymin },
      { x: xmax, y: ymax },
      { x: xmin, y: ymax }
    ]
  };
}

/**
 * Centre + radius of a set of member positions arranged on a ring. Centre is
 * the centroid; radius is the mean distance from the centroid (robust to the
 * discrete sampling of the ring). No shipped scene uses `ring` yet — this
 * helper ships unit-tested so the registry entry is real (charter generality),
 * per the A5 DoD scoping.
 *
 * @param {{x:number,y:number}[]} positions
 * @returns {{center:{x,y}, radius:number}} (world metres)
 */
export function ringPointsWorld(positions) {
  if (!positions || positions.length === 0) {
    throw new Error('ringPointsWorld: needs at least one position');
  }
  let sx = 0;
  let sy = 0;
  for (const p of positions) {
    sx += p.x;
    sy += p.y;
  }
  const center = { x: sx / positions.length, y: sy / positions.length };
  let sr = 0;
  for (const p of positions) {
    sr += Math.hypot(p.x - center.x, p.y - center.y);
  }
  return { center, radius: sr / positions.length };
}

/**
 * Dispatch: compute the `extent` descriptor for a render-group KIND from its
 * members' world positions. The single decision site (mirrors shapeDrawerFor),
 * isolated so an unknown kind fails LOUD at load rather than silently drawing
 * nothing.
 *
 * @param {'line'|'sheet'|'ring'} kind
 * @param {{x:number,y:number}[]} positions
 */
export function computeExtent(kind, positions) {
  switch (kind) {
    case 'line':
      return lineExtentWorld(positions);
    case 'sheet':
      return sheetCornersWorld(positions);
    case 'ring':
      return ringPointsWorld(positions);
    default:
      throw new Error(`computeExtent: unknown render-group kind "${kind}"`);
  }
}

/**
 * Centre point of a computed extent (world metres) — the glyph's label/anchor
 * origin. Pure; kind-aware because the extent shape differs per kind.
 */
export function extentCenter(kind, extent) {
  switch (kind) {
    case 'line':
      return { x: (extent.a.x + extent.b.x) / 2, y: (extent.a.y + extent.b.y) / 2 };
    case 'sheet': {
      const c = extent.corners;
      return {
        x: (c[0].x + c[2].x) / 2,
        y: (c[0].y + c[2].y) / 2
      };
    }
    case 'ring':
      return { x: extent.center.x, y: extent.center.y };
    default:
      throw new Error(`extentCenter: unknown render-group kind "${kind}"`);
  }
}

/**
 * The member ids of EVERY render group, unioned into a Set. This is the
 * suppression DECISION POINT (isolated for direct unit testing, like
 * shapeDrawerFor): a body whose id is in this set is drawn ONCE as its group's
 * glyph, so drawBodies must skip its ENTIRE per-body iteration (glyph, velocity
 * arrow, orientation arrow, AND label) — else a member with no renderShape
 * prints its bare internal id (`line_47`), violating classroom-notation.
 *
 * @param {{member_ids?:string[]}[]|undefined} renderGroups
 * @returns {Set<string>}
 */
export function collectSuppressedIds(renderGroups) {
  const ids = new Set();
  for (const g of renderGroups ?? []) {
    for (const id of g.member_ids ?? []) ids.add(id);
  }
  return ids;
}
