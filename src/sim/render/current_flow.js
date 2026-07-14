// current_flow.js — T7: animated current-flow markers along a circuit branch.
//
// A small pure-geometry module (calculate-not-guess). Given a branch's wire
// path, the live signed branch current, the display convention, and the SIM
// clock, it returns the world-coordinate centers of the flowing markers.
// Render-only: it never reads or writes engine/scene state and is never
// sampled by serializeState — the clock enters as a per-call argument, so the
// animation stays deterministic and out of the state vector. canvas2d.js maps
// each returned center through worldToPx and fills a fixed-radius disk.
//
// Direction contract: `path` is oriented so index 0 → last is the branch's
// fromEnd → toEnd direction, which is the +current direction (this matches
// currentFlowDirection() in canvas2d.js). Positive current under the
// CONVENTIONAL display drifts markers along that direction; the ELECTRON
// display reverses it (electrons drift opposite to the conventional current).
// The convention is presentation-only: it changes only the drift direction and
// (via the caller) the marker color — never any plotted current value.

// World-metre spacing between consecutive markers on a branch. A vertical
// branch spans CKT_TOP_Y − CKT_RAIL_Y = 1.5 m in the canvas2d layout, so 0.5 m
// yields ~3 markers on a vertical drop and ~5 on a 2.5 m horizontal span.
export const FLOW_DOT_SPACING = 0.5; // world m between markers
// Drift speed scales with |i|: 1 A drifts markers 0.5 m per SIM-second, so a
// marker crosses one spacing in ~1 s at 1 A — a calm, readable pace. Because
// the clock is sim-time, this already inherits the playback-rate slowdown and
// freezes on pause (the runner scales dt by playbackRate before advancing t),
// so it must NOT be re-scaled by the rate a second time.
export const FLOW_SPEED_PER_AMP = 0.5; // world m per sim-s, per amp
// Cap so a very large current does not smear the markers into a blur.
export const FLOW_MAX_SPEED = 3.0; // world m per sim-s
// |i| below this is treated as no current → no markers. Mirrors
// CKT_I_ZERO_EPS in canvas2d.js so the markers and the flow arrow agree.
export const FLOW_I_EPS = 1e-9; // A
// Fixed on-screen marker radius (px), zoom-independent, like the flow arrow.
export const FLOW_DOT_RADIUS_PX = 3; // px

// Cumulative arc length of a polyline, plus its total length. Pure.
function arcLengths(path) {
  const cum = [0];
  let total = 0;
  for (let k = 1; k < path.length; k++) {
    const dx = path[k].x - path[k - 1].x;
    const dy = path[k].y - path[k - 1].y;
    total += Math.hypot(dx, dy);
    cum.push(total);
  }
  return { cum, total };
}

// World position at arc length s (0 ≤ s ≤ total) along the polyline. Pure.
function positionAtArcLength(path, cum, s) {
  for (let k = 1; k < path.length; k++) {
    if (s <= cum[k] || k === path.length - 1) {
      const segLen = cum[k] - cum[k - 1];
      const f = segLen > 0 ? (s - cum[k - 1]) / segLen : 0;
      return {
        x: path[k - 1].x + (path[k].x - path[k - 1].x) * f,
        y: path[k - 1].y + (path[k].y - path[k - 1].y) * f,
      };
    }
  }
  return { x: path[0].x, y: path[0].y };
}

// The ONE flow helper (plan T7): (branchPathGeometry, currentMagnitudeAndSign,
// conventionFlag, t) → world-coord marker centers. Returns an empty array when
// there is no current to show (|i| < eps or non-finite) or the path is
// degenerate (fewer than 2 vertices / zero length).
export function flowMarkerPositions(path, current, convention, t) {
  if (!Array.isArray(path) || path.length < 2) return [];
  if (typeof current !== 'number' || !Number.isFinite(current)) return [];
  if (Math.abs(current) < FLOW_I_EPS) return [];
  const { cum, total } = arcLengths(path);
  if (!(total > 0)) return [];

  // Even spacing that divides the path so markers wrap seamlessly at the ends.
  const n = Math.max(1, Math.round(total / FLOW_DOT_SPACING));
  const spacing = total / n;

  // Drift direction along the path: +current flows index 0 → last under the
  // conventional display; the electron display reverses it.
  const conventionSign = convention === 'electron' ? -1 : 1;
  const dir = Math.sign(current) * conventionSign;
  const speed = Math.min(FLOW_SPEED_PER_AMP * Math.abs(current), FLOW_MAX_SPEED);
  const drift = dir * speed * (Number.isFinite(t) ? t : 0);

  const out = [];
  for (let k = 0; k < n; k++) {
    let s = (k * spacing + drift) % total;
    if (s < 0) s += total;
    out.push(positionAtArcLength(path, cum, s));
  }
  return out;
}
