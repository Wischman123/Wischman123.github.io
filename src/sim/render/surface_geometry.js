// Pure surface-geometry predicates for the renderer.
//
// These two functions are the DECISION POINTS behind two rendering bugs that
// shipped to the showcase (findings F4 and F2 of showcase_live_sim_v1's L8
// completeness check). They live here — split from canvas2d.js and from any
// drawing side effect — so each can be unit-tested directly against the engine's
// own conventions instead of being eyeballed in a PNG.
//
// COORDINATE CONVENTIONS (the source of both bugs):
//   world  — y is UP, angles measured counter-clockwise from +x (standard math).
//   canvas — y is DOWN. A world point at angle θ about a centre therefore lands
//            at canvas angle φ = −θ. The y-flip is fully expressed by that one
//            negation; applying it a SECOND time (e.g. also inverting a sweep
//            flag) silently draws the complementary arc. That was F4.

/**
 * Map a world-space circular-arc sweep to the three arguments CanvasRenderingContext2D.arc()
 * needs: (startAngle, endAngle, anticlockwise).
 *
 * The engine parameterizes an arc as `thetaStart` plus a signed `thetaSweep`
 * (positive = counter-clockwise in WORLD space). Canvas angles are the negation
 * of world angles (see the header), so:
 *
 *   startCanvas = −thetaStart
 *   endCanvas   = −(thetaStart + thetaSweep) = startCanvas − thetaSweep
 *
 * With the endpoints already negated, the direction follows for free. A world
 * sweep of +90° makes the canvas angle DECREASE by 90°; canvas treats decreasing
 * angle as anticlockwise. So:
 *
 *   anticlockwise = (thetaSweep > 0)
 *
 * F4 was `!(thetaSweep > 0)` — the y-flip applied twice. With a −120° crest that
 * inverted flag made ctx.arc() travel the other way around the circle, stroking
 * the complementary 240° and leaving the ridden hilltop undrawn.
 *
 * @param {number} thetaStart world start angle (radians)
 * @param {number} thetaSweep signed world sweep (radians; + = CCW in world)
 * @returns {{startCanvas: number, endCanvas: number, anticlockwise: boolean}}
 */
export function arcSweepCanvas(thetaStart, thetaSweep) {
  const startCanvas = -thetaStart;
  const endCanvas = -(thetaStart + thetaSweep);
  // Already-negated endpoints ⇒ the flag is the world sense, NOT its inverse.
  const anticlockwise = thetaSweep > 0;
  return { startCanvas, endCanvas, anticlockwise };
}

const TWO_PI = 2 * Math.PI;
const normalize = (a) => ((a % TWO_PI) + TWO_PI) % TWO_PI;

/**
 * Does the canvas sweep that arcSweepCanvas() asks for actually TRAVERSE the
 * world-space angle `theta`?
 *
 * This is the F4 regression predicate in one pure call: the apex a body rides
 * must lie on the arc the renderer strokes. Any point strictly inside the
 * engine's swept sector must answer true; a point in the complementary sector
 * must answer false. An inverted flag flips both answers, so this catches the
 * bug in either direction.
 *
 * @param {number} thetaStart world start angle (radians)
 * @param {number} thetaSweep signed world sweep (radians)
 * @param {number} theta      world angle to test (radians)
 * @returns {boolean}
 */
export function canvasSweepTraverses(thetaStart, thetaSweep, theta) {
  const { startCanvas, endCanvas, anticlockwise } = arcSweepCanvas(thetaStart, thetaSweep);
  const target = -theta; // world → canvas
  // Angle actually travelled, measured in the direction ctx.arc() will move.
  const travelled = anticlockwise
    ? normalize(startCanvas - endCanvas)
    : normalize(endCanvas - startCanvas);
  const toTarget = anticlockwise
    ? normalize(startCanvas - target)
    : normalize(target - startCanvas);
  return toTarget <= travelled + 1e-9;
}

/**
 * Where a surface is DRAWN, given that the body riding it is drawn as a disk of
 * radius `radiusWorld` rather than as the dimensionless point mass the engine
 * integrates.
 *
 * ----- Why the surface moves instead of the ball (the F2 rewrite) -----
 *
 * The engine's body is a point mass; the renderer's glyph is a 10 px disk. Something
 * has to give, or the disk straddles the surface line it is riding — half buried.
 *
 * The FIRST answer (F2) lifted the BALL by one radius while it was touching a
 * surface. That offset has to switch off again in free flight, and every way of
 * switching it off pops the glyph by up to a full radius on the frame it
 * happens. The ramp patched the separation case; the segment clip then broke it
 * again at K015's hilltop — at lift-off the parabola OSCULATES the circle (N = 0
 * ⇒ curvatures match), so the ball is still ~4 mm off the arc when its projection
 * runs off the arc's END. The hill went ineligible, the lift died at nearly full
 * magnitude, and the disk dropped 10 px into the hill fill — on precisely the
 * frame the exhibit exists to show. Two bugs, one decision point.
 *
 * The SECOND answer — this one — removes the decision. Read the geometry the way
 * the physics already means it:
 *
 *   The engine's point mass IS the ball's CENTRE, and the surfaces are the curve the
 *   CENTRE follows. A real ball of radius r rolling on a hill has its centre one
 *   radius ABOVE the hill. So the hill is DRAWN one radius BELOW the constraint
 *   curve, and the ball is ALWAYS drawn at its true position.
 *
 * The ball then rests exactly on the drawn surface while riding, flies the exact
 * parabola once free, and never moves relative to its own trajectory — because no
 * state-dependent offset exists to switch off. The pop is not fixed; it is
 * unrepresentable.
 *
 * Every shape has an EXACT offset — no polygon-offsetting, no approximation:
 *
 *   flat / inclined  → both endpoints shift by −r · n̂ (into the solid side)
 *   convex arc       → same centre, radius R − r   (dome shrinks under the ball)
 *   concave arc      → same centre, radius R + r   (loop grows around the ball;
 *                      its normal aims inward, so −r · n̂ is outward)
 *
 * This is a DRAW-TIME transform only: it never feeds the engine, and scene bounds
 * / autoFit still key off the raw surfaces.
 *
 * @param {object} surface      an engine Surface instance
 * @param {number} radiusWorld  glyph radius in world metres (0 ⇒ no offset)
 * @returns {object} duck-typed surface geometry — the same fields the drawing code
 *                   reads off a Surface (shape, p1, p2, center, radius, thetaStart,
 *                   thetaSweep, chordTangent, chordNormal), with the offset applied.
 */
export function drawnSurfaceGeometry(surface, radiusWorld) {
  const raw = {
    id: surface.id,
    shape: surface.shape,
    p1: surface.p1,
    p2: surface.p2,
    center: surface.center,
    radius: surface.radius,
    thetaStart: surface.thetaStart,
    thetaSweep: surface.thetaSweep,
    chordTangent: surface.chordTangent,
    chordNormal: surface.chordNormal
  };
  if (!(radiusWorld > 0)) return raw;

  if (surface.shape === 'flat' || surface.shape === 'inclined') {
    // The outward normal is constant along a straight surface, so both endpoints
    // shift by the same vector — the drawn line stays parallel, one radius into
    // the solid side.
    const n = surface.normalAt(surface.p1);
    const dx = -n.x * radiusWorld;
    const dy = -n.y * radiusWorld;
    return {
      ...raw,
      p1: { x: surface.p1.x + dx, y: surface.p1.y + dy },
      p2: { x: surface.p2.x + dx, y: surface.p2.y + dy }
    };
  }

  // Arc shapes. The outward normal is radial, so offsetting by −r · n̂ is exactly
  // a change of radius about the SAME centre — the swept angles are untouched.
  const concave = surface.shape === 'circular_arc_concave';
  const drawnRadius = concave
    ? surface.radius + radiusWorld   // inward normal ⇒ −r · n̂ aims outward
    : surface.radius - radiusWorld;
  // Degenerate guard: a glyph wider than the arc it rides (absurd zoom-out) would
  // invert the dome. Fall back to the un-offset radius rather than draw garbage.
  if (!(drawnRadius > 0)) return raw;

  // Keep p1/p2 consistent with the drawn radius for any consumer that reads them.
  const onDrawnArc = (p) => {
    const dx = p.x - surface.center.x;
    const dy = p.y - surface.center.y;
    const len = Math.hypot(dx, dy);
    if (len === 0) return { x: p.x, y: p.y };
    return {
      x: surface.center.x + (dx / len) * drawnRadius,
      y: surface.center.y + (dy / len) * drawnRadius
    };
  };
  return {
    ...raw,
    radius: drawnRadius,
    p1: onDrawnArc(surface.p1),
    p2: onDrawnArc(surface.p2)
  };
}
