// viewport_transform.js — pure world<->pixel viewport math (render layer).
//
// Extracted from Canvas2DRenderer (sim/render/canvas2d.js) so that BOTH the
// dynamics renderer and the optics renderer (sim/render/optics_canvas2d.js)
// map coordinates through ONE convention — no silent drift between the two
// surfaces. Library-first: the math lives here once; each renderer is a thin
// caller.
//
// Frames:
//   World  — metres, +y UP (physics convention).
//   Pixels — Canvas2D default, +y DOWN.
// The forward map therefore FLIPS y: a LARGER world y lands at a SMALLER pixel
// y. Scaling is uniform (a single `scale` px/m on both axes) so circles stay
// round.
//
// A `view` is a plain bag of the five transform fields:
//   scale            — pixels per metre
//   originX, originY — the world coordinate that sits at the pixel-frame centre
//   cssWidth, cssHeight — CSS-pixel size of the drawable surface
// A Canvas2DRenderer / OpticsCanvas2DRenderer instance carries exactly these
// fields, so `this` is a valid `view`. These functions READ a view and never
// mutate it (the render layer is strictly read-only).

// Forward map: world coordinate -> pixel coordinate (with the y-flip).
export function projectWorldToPx(view, p) {
  return {
    x: (p.x - view.originX) * view.scale + view.cssWidth / 2,
    y: view.cssHeight / 2 - (p.y - view.originY) * view.scale
  };
}

// Inverse map: pixel coordinate -> world coordinate. The exact inverse of
// projectWorldToPx, so round-tripping recovers the input to float precision.
export function unprojectPxToWorld(view, p) {
  return {
    x: (p.x - view.cssWidth / 2) / view.scale + view.originX,
    y: (view.cssHeight / 2 - p.y) / view.scale + view.originY
  };
}

// Pure fit computation: the {scale, originX, originY} that frames a world rect
// `bounds` {minX, maxX, minY, maxY} into a cssWidth x cssHeight surface with a
// symmetric fractional `margin` on each side and a uniform scale.
//
//   - Non-finite extent -> returns null. The caller then leaves its transform
//     unchanged (identical to Canvas2DRenderer.fitToBounds' early return).
//   - Zero-area bounds (a single site) -> a fixed 50 px/m centred on it.
//
// This is the extraction of Canvas2DRenderer.fitToBounds' body, verbatim in
// arithmetic, so the dynamics render tests stay byte-identical.
export function computeFitTransform(bounds, cssWidth, cssHeight, margin = 0.1) {
  const wWorld = bounds.maxX - bounds.minX;
  const hWorld = bounds.maxY - bounds.minY;
  if (!Number.isFinite(wWorld) || !Number.isFinite(hWorld)) return null;
  if (wWorld === 0 && hWorld === 0) {
    return { scale: 50, originX: bounds.minX, originY: bounds.minY };
  }
  const scaleX = cssWidth / Math.max(wWorld * (1 + 2 * margin), 1e-6);
  const scaleY = cssHeight / Math.max(hWorld * (1 + 2 * margin), 1e-6);
  return {
    scale: Math.min(scaleX, scaleY),
    originX: (bounds.minX + bounds.maxX) / 2,
    originY: (bounds.minY + bounds.maxY) / 2
  };
}
