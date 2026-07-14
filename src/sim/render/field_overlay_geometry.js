// field_overlay_geometry.js — PURE geometry for the F1 field/potential overlay.
//
// This module holds ONLY array→polyline geometry: marching-squares contour
// extraction and seed-ring geometry. It does NOT sample the field
// (no field_sampler import) and does NOT draw (no canvas). That keeps it a
// pure, directly unit-testable leaf — the one sub-module in roadmap F1 that
// warrants genuine test-first treatment (marching-squares is a new domain with
// no codebase precedent, unlike the reused traceStreamline).
//
// Note the two DIFFERENT purities the overlay split keeps apart:
//   • THIS module is pure GEOMETRY (no sampling, no canvas), and
//   • computeFieldOverlay (in field_overlay.js) is pure DATA (no canvas) but
//     DOES sample.
// They are not the same purity, so they live in different files.

// Linear interpolation of the crossing location where a contour at `threshold`
// crosses the edge between corner A (value vA) and corner B (value vB). Only
// ever called on an edge that IS crossed (vA on one side, vB on the other), so
// vA !== vB and the divide is safe.
function interp(threshold, pA, vA, pB, vB) {
  const t = (threshold - vA) / (vB - vA);
  return { x: pA.x + t * (pB.x - pA.x), y: pA.y + t * (pB.y - pA.y) };
}

// Marching-squares contour extraction for ONE V-threshold over a scalar grid.
//
// grid[i][j] is the scalar value (e.g. potential V) at world location
// (x0 + j·dx, y0 + i·dy) — row index i runs along +y, column index j along +x.
// A corner value of NaN marks a MASKED (singular) grid node; any cell touching
// a NaN corner is skipped (no-contour), so a masked node poisons only its up-to-
// four adjacent cells — never the whole contour.
//
// Returns an array of SEGMENTS, each a 2-vertex world polyline [{x,y},{x,y}].
// Segments (not stitched polylines) are sufficient both to draw the contour and
// to read a local contour TANGENT (a segment's direction) for the ⟂-to-E test.
export function marchingSquares(grid, threshold, x0, y0, dx, dy) {
  const segments = [];
  const rows = grid.length;
  if (rows < 2) return segments;
  for (let i = 0; i < rows - 1; i++) {
    const cols = Math.min(grid[i].length, grid[i + 1].length);
    for (let j = 0; j < cols - 1; j++) {
      // Cell corners: BL, BR, TR, TL (counter-clockwise from bottom-left).
      const vBL = grid[i][j];
      const vBR = grid[i][j + 1];
      const vTR = grid[i + 1][j + 1];
      const vTL = grid[i + 1][j];
      // Skip any cell touching a masked (NaN) node.
      if (Number.isNaN(vBL) || Number.isNaN(vBR) || Number.isNaN(vTR) || Number.isNaN(vTL)) {
        continue;
      }
      const xL = x0 + j * dx;
      const xR = x0 + (j + 1) * dx;
      const yB = y0 + i * dy;
      const yT = y0 + (i + 1) * dy;
      const pBL = { x: xL, y: yB };
      const pBR = { x: xR, y: yB };
      const pTR = { x: xR, y: yT };
      const pTL = { x: xL, y: yT };

      const code =
        (vBL >= threshold ? 1 : 0) |
        (vBR >= threshold ? 2 : 0) |
        (vTR >= threshold ? 4 : 0) |
        (vTL >= threshold ? 8 : 0);
      if (code === 0 || code === 15) continue; // wholly above or below → no crossing

      const bottom = () => interp(threshold, pBL, vBL, pBR, vBR);
      const right = () => interp(threshold, pBR, vBR, pTR, vTR);
      const top = () => interp(threshold, pTR, vTR, pTL, vTL);
      const left = () => interp(threshold, pTL, vTL, pBL, vBL);

      switch (code) {
        case 1: case 14: segments.push([left(), bottom()]); break;
        case 2: case 13: segments.push([bottom(), right()]); break;
        case 3: case 12: segments.push([left(), right()]); break;
        case 4: case 11: segments.push([right(), top()]); break;
        case 6: case 9: segments.push([bottom(), top()]); break;
        case 7: case 8: segments.push([left(), top()]); break;
        case 5: {
          // Saddle (BL & TR above): disambiguate by the cell-center average.
          const center = (vBL + vBR + vTR + vTL) / 4;
          if (center >= threshold) {
            segments.push([left(), top()], [bottom(), right()]);
          } else {
            segments.push([left(), bottom()], [right(), top()]);
          }
          break;
        }
        case 10: {
          // Saddle (BR & TL above).
          const center = (vBL + vBR + vTR + vTL) / 4;
          if (center >= threshold) {
            segments.push([left(), bottom()], [right(), top()]);
          } else {
            segments.push([left(), top()], [bottom(), right()]);
          }
          break;
        }
        default: break;
      }
    }
  }
  return segments;
}

// A ring of `count` seeds evenly spaced on a circle of `radius` around
// (cx, cy). Used to anchor field-line seeds around each charged source so a
// single-signed scene still gets radial coverage (a background grid alone would
// leave a lone −Q's field undrawn).
export function seedRing(cx, cy, radius, count) {
  const ring = [];
  const n = Math.max(1, Math.floor(count));
  for (let k = 0; k < n; k++) {
    const theta = (2 * Math.PI * k) / n;
    ring.push({ x: cx + radius * Math.cos(theta), y: cy + radius * Math.sin(theta) });
  }
  return ring;
}

export const NAME = 'field_overlay_geometry';
