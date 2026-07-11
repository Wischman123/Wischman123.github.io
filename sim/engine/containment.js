// engine/containment.js
//
// Phase 5.B (Q5 Containment rules) — pure geometric containment
// predicates for Gauss-surface enclosure computations. Library home for
// per-shape `pointIn*` predicates and source-vs-surface alignment
// checks. The validator `gauss_surface_encloses_source` (in
// em_validation.js) imports these by name and uses them to compute
// Q_enc; flux.js's analytic / discrete integrators reuse the predicates
// for sample-point inclusion checks.
//
// Purity contract: every export is a pure function returning a boolean
// or a finite number. No allocations beyond return values; no module
// state. Reusable by 5.D induction + a future arbitrary-surface
// sub-phase without re-implementation (per project library-first rule).
//
// Vector convention: every input vector is a vec3 `{x, y, z}`. The
// engine's scene-JSON `position_m` is vec2 `{x, y}` for 2D scenes —
// callers MUST widen to vec3 (with z=0) before passing in. See
// `_position_to_vec3()` callers in em_validation.js.
//
// Axis-vector unit-tolerance: `axis` arguments to cylinder + pillbox
// predicates are NOT auto-normalized here. Callers must validate
// `||axis| − 1| < AXIS_UNIT_EPSILON` upstream (the
// `gauss_surface_encloses_source` validator does this, throwing a
// descriptive error before any predicate call).

import { vec3 } from './vec.js';

const TINY = 1e-30;

// ---------------------------------------------------------------------
// Sphere
// ---------------------------------------------------------------------

/**
 * pointInSphere(p, center, radius) → boolean.
 * Strict-inside test: `|p − center| < radius`. A point ON the sphere
 * (distance == radius) is OUT — Q_enc treats the boundary as excluded
 * to keep the residual gate well-defined for analytic test cases.
 */
export function pointInSphere(p, center, radius) {
  const dx = p.x - center.x;
  const dy = p.y - center.y;
  const dz = p.z - center.z;
  return (dx * dx + dy * dy + dz * dz) < radius * radius;
}

// ---------------------------------------------------------------------
// Cylinder
// ---------------------------------------------------------------------

/**
 * pointInCylinder(p, center, axis, radius, length) → boolean.
 * Cylinder is finite, capped (top + bottom). `axis` is a unit vec3
 * pointing along the cylinder's symmetry axis; `length` is total
 * cylinder length (cap-to-cap), so the body extends ±length/2 along
 * `axis` from `center`.
 *
 * Test: project (p − center) onto `axis` and into the perpendicular
 * plane. Inside iff perpendicular-distance < radius AND
 * |axial-component| < length/2.
 */
export function pointInCylinder(p, center, axis, radius, length) {
  const dx = p.x - center.x;
  const dy = p.y - center.y;
  const dz = p.z - center.z;
  const along = dx * axis.x + dy * axis.y + dz * axis.z;
  if (Math.abs(along) >= length / 2) return false;
  // Perpendicular component: r⃗_perp = r⃗ − (r⃗·axis) axis
  const px = dx - along * axis.x;
  const py = dy - along * axis.y;
  const pz = dz - along * axis.z;
  const perp2 = px * px + py * py + pz * pz;
  return perp2 < radius * radius;
}

// ---------------------------------------------------------------------
// Pillbox
// ---------------------------------------------------------------------

/**
 * pointInPillbox(p, center, axis, cap_shape, cap_dim, thickness) → boolean.
 * Pillbox = thin cylinder with disk OR square caps. `axis` is the
 * pillbox normal (cap-face normal). For `cap_shape='disk'` the cap is
 * a disk of radius `cap_dim`; for `cap_shape='square'` the cap is a
 * square of side `cap_dim`. `thickness` is total cap-to-cap distance.
 */
export function pointInPillbox(p, center, axis, cap_shape, cap_dim, thickness) {
  const dx = p.x - center.x;
  const dy = p.y - center.y;
  const dz = p.z - center.z;
  const along = dx * axis.x + dy * axis.y + dz * axis.z;
  if (Math.abs(along) >= thickness / 2) return false;
  // Project onto the cap plane.
  const px = dx - along * axis.x;
  const py = dy - along * axis.y;
  const pz = dz - along * axis.z;
  if (cap_shape === 'disk') {
    return (px * px + py * py + pz * pz) < cap_dim * cap_dim;
  }
  if (cap_shape === 'square') {
    // Square caps need a 2D in-plane basis. Pick `e1` = any unit vec
    // perpendicular to `axis` (Gram-Schmidt against world axes), then
    // `e2 = axis × e1`. The square is bounded by |perp·e1| < cap_dim/2
    // AND |perp·e2| < cap_dim/2.
    const e1 = _perpUnit(axis);
    const e2 = vec3.cross(axis, e1);
    const c1 = px * e1.x + py * e1.y + pz * e1.z;
    const c2 = px * e2.x + py * e2.y + pz * e2.z;
    const half = cap_dim / 2;
    return Math.abs(c1) < half && Math.abs(c2) < half;
  }
  return false;
}

/**
 * pillboxCapArea(cap_shape, cap_dim) → number.
 * A_cap = π × cap_dim² for disk; cap_dim² for square. Used by
 * Q_enc = σ × A_cap and by the discrete integrator's per-cap area.
 */
export function pillboxCapArea(cap_shape, cap_dim) {
  if (cap_shape === 'disk') return Math.PI * cap_dim * cap_dim;
  if (cap_shape === 'square') return cap_dim * cap_dim;
  throw new Error(`pillboxCapArea: unknown cap_shape "${cap_shape}"`);
}

// ---------------------------------------------------------------------
// Alignment predicates
// ---------------------------------------------------------------------

/**
 * lineParallelToCylinderAxis(axis_line, axis_cyl, eps?) → boolean.
 * Both inputs are unit vec3. Returns true iff the axes are parallel
 * (anti-parallel counts) within absolute tolerance `eps` on
 * |dot - ±1|. Default eps = 1e-10.
 */
export function lineParallelToCylinderAxis(axis_line, axis_cyl, eps = 1e-10) {
  const d = axis_line.x * axis_cyl.x + axis_line.y * axis_cyl.y + axis_line.z * axis_cyl.z;
  return Math.abs(Math.abs(d) - 1) < eps;
}

/**
 * sheetPerpendicularToPillboxAxis(normal_sheet, axis_pillbox, eps?) → boolean.
 * Sheet is perpendicular to its own `normal_sheet`. The pillbox axis
 * must be parallel to the sheet normal for symmetry to hold. Returns
 * true iff |dot - ±1| < eps. Default eps = 1e-10.
 */
export function sheetPerpendicularToPillboxAxis(normal_sheet, axis_pillbox, eps = 1e-10) {
  const d = normal_sheet.x * axis_pillbox.x + normal_sheet.y * axis_pillbox.y + normal_sheet.z * axis_pillbox.z;
  return Math.abs(Math.abs(d) - 1) < eps;
}

// ---------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------

/**
 * _perpUnit(axis) — pick a unit vector perpendicular to `axis`. Used
 * by pillbox-square cap projection. Robust against `axis` aligned with
 * any single world axis: picks the world axis with smallest |axis·ê|
 * to avoid degenerate cross products.
 */
function _perpUnit(axis) {
  const ax = Math.abs(axis.x);
  const ay = Math.abs(axis.y);
  const az = Math.abs(axis.z);
  // Pick the smallest-component world axis; cross gives a stable
  // perpendicular.
  let seed;
  if (ax <= ay && ax <= az) seed = { x: 1, y: 0, z: 0 };
  else if (ay <= az) seed = { x: 0, y: 1, z: 0 };
  else seed = { x: 0, y: 0, z: 1 };
  const perp = vec3.cross(axis, seed);
  const m = vec3.norm(perp);
  if (m < TINY) {
    throw new Error('_perpUnit: degenerate axis (norm too small).');
  }
  return { x: perp.x / m, y: perp.y / m, z: perp.z / m };
}

export const NAME = 'containment';
