// render/trajectory_trace.js
//
// Persistent trajectory-trace overlay. A fading breadcrumb of each traceable
// body's past world positions that reveals the SHAPE of the motion — a
// projectile's parabola, an orbit's closed ellipse.
//
// Mirrors the motion_graph.js shape: a module-local `traceBuffers` Map keyed
// by `body.id`, populated once per runner tick from main.js. Render-layer
// only — the buffer lives here, the engine owns no trace state, sim/engine/ is
// byte-identical.
//
// The load-bearing new idea is a PATH-LENGTH ring buffer (not a time buffer):
// each tick pushes the body's `{x,y}`; when the cumulative segment length from
// the newest sample backward exceeds a PER-SCENE `maxTracePathM`, the oldest
// samples are spliced off. Bounding by arc length (not by timestamp) keeps a
// fixed LENGTH of trail on screen, so a slow orbit and a fast bounce both read
// as a full curve — a time buffer would show a stub of the orbit and a smear
// of the bounce. A hard `MAX_TRACE_POINTS` ceiling is the second, absolute
// bound: a slow oscillator whose every sample differs (dedupe never fires) yet
// whose net travel stays small (arc cap rarely trips) still cannot append one
// sample per tick forever.
//
// Anti-Kohn: draws only a neutral trail in the body-disk palette. No trial
// counter, no run comparison, no evaluative readout.

import {
  isRenderSuppressed,
  PLACEHOLDER_BODY_ID
} from './render_suppression.js';
import { collectSuppressedIds } from '../engine/extended_object_geometry.js';

// --- Tuning constants (named — one edit site each; revisit against real
// scene extents once several curricula ship). ---

// Hard ceiling on retained samples per body. The ONE true module constant
// bound (the path cap below is per-scene). Guards the slow-oscillator case
// where neither the dedupe nor the arc cap ever evicts. Revisit if a long
// low-amplitude scene reads as a truncated curve.
export const MAX_TRACE_POINTS = 2000;

// Per-scene arc cap = TRACE_PATH_CAP_MULTIPLIER x max(width, height) of the
// scene's probed trajectory box, so one full orbit / loop of THIS scene fits
// with margin. Hoisted here (not an inline 2) so the margin is one edit.
export const TRACE_PATH_CAP_MULTIPLIER = 2;

// Fallback arc cap (metres) when the probe box is null (probe fell back) OR
// degenerate (an all-stationary scene returns width == height == 0, which
// would set the cap to 0 and evict every sample). Benign for a truly
// motionless scene — no trail is wanted there anyway.
export const DEFAULT_MAX_TRACE_PATH_M = 20;

// Fade ramp: alpha rises from oldest to newest sample across the trail.
export const TRACE_ALPHA_OLDEST = 0.1;
export const TRACE_ALPHA_NEWEST = 0.85;

// Stroke style — reuse the body-disk navy so the trail reads as "where this
// body has been", not a new brand color.
const TRACE_COLOR = '#2c3e50';
const TRACE_LINE_WIDTH_PX = 2;

// Degenerate-box epsilon (metres). max(width, height) <= EPS counts as "no
// meaningful extent" and takes the fixed default.
const DEGENERATE_EXTENT_EPS_M = 1e-6;

// --- Module-local state (outside any renderer instance, mirroring
// motion_graph's buffers, so the render-only universality contract holds). ---

// Keyed by body.id; value is an ordered array of {x,y} world samples,
// oldest first, newest last.
const traceBuffers = new Map();

// Per-scene arc cap in metres, set on scene load via `setMaxTracePath`.
// Starts at the fixed default so a call before load still behaves.
let maxTracePathM = DEFAULT_MAX_TRACE_PATH_M;

// --- Public API ---

// Clear every body's trace. Called from main.js on scene swap / Reset.
export function clearTraceBuffers() {
  traceBuffers.clear();
}

// Read-only accessor for tests + Playwright introspection. Returns the live
// buffer array (do not mutate); empty array when the body has no trace yet.
export function getTrace(bodyId) {
  return traceBuffers.get(bodyId) ?? [];
}

// sim_trace_ghost P2 — snapshot EVERY per-body trace buffer as one Map, for
// ghost_store.captureGhost to deep-copy at Reset. Returns a fresh (shallow)
// Map so a later clearTraceBuffers / new-run refill cannot change the snapshot's
// key SET; the consumer deep-copies the inner arrays. ONE canonical export name
// (no getTraceBuffers alias) so producer and consumer cannot disagree on it —
// the parallel of motion_graph.snapshotBuffers on the trace side. captureGhost
// consumes this Map rather than hardcoding the body enumeration.
export function snapshotTraces() {
  return new Map(traceBuffers);
}

// Set the per-scene arc cap (metres). Defensive: a non-finite / non-positive
// value (a caller passing a degenerate 0, NaN, or null) falls back to the
// fixed default so the arc cap never silently evicts every sample.
export function setMaxTracePath(metres) {
  maxTracePathM = (typeof metres === 'number' && Number.isFinite(metres) && metres > 0)
    ? metres
    : DEFAULT_MAX_TRACE_PATH_M;
}

// Current per-scene arc cap (metres). Exported for tests / introspection.
export function getMaxTracePath() {
  return maxTracePathM;
}

// Derive the per-scene arc cap from the probe's trajectory box
// {minX,minY,maxX,maxY}. Pure — main.js feeds it `planScene(sceneJson).bounds`
// and passes the result to `setMaxTracePath`. Null box (probe fell back) or a
// degenerate box (all-stationary scene, extent <= EPS) → the fixed default;
// otherwise TRACE_PATH_CAP_MULTIPLIER x the larger scene dimension.
export function tracePathCapForBounds(bounds) {
  if (!bounds) return DEFAULT_MAX_TRACE_PATH_M;
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  const maxDim = Math.max(width, height);
  if (!(maxDim > DEGENERATE_EXTENT_EPS_M)) return DEFAULT_MAX_TRACE_PATH_M;
  return TRACE_PATH_CAP_MULTIPLIER * maxDim;
}

// Should this body leave a trail? Delegates the render-group decision to the
// shared `isRenderSuppressed` predicate (single source across renderer +
// trace + ghost), then adds the two TRACE-only exclusions: a `pinned` body's
// trail teaches nothing (it does not evolve), and the reserved circuit
// `placeholder` body is a dummy at the origin. `loadedOrSet` is the loaded
// scene OR a precomputed suppressed Set (drawTraceOverlay / recordTracePoint
// build it once per call).
export function isTraceable(body, loadedOrSet) {
  if (!body) return false;
  if (body.pinned) return false;
  if (body.id === PLACEHOLDER_BODY_ID) return false;
  return !isRenderSuppressed(body, loadedOrSet);
}

// Record one world sample per traceable body. Called from main.js::onTick
// (once per runner tick) and once at load to seed the newest sample.
//
// Dedupe: skip a push whose {x,y} EXACTLY equals the current newest sample.
// onTick also fires on reset(), which re-seeds the initial position from the
// SAME scene-JSON float (bit-identical, no arithmetic) — so the duplicate is
// exactly equal, and `===` suppresses it without injecting a teleport sample
// at t=0. Exact equality is DELIBERATE: an epsilon tolerance would over-dedupe
// a slow oscillator's tiny-but-real per-tick motion, collapsing genuine
// samples.
export function recordTracePoint(loaded) {
  if (!loaded || !Array.isArray(loaded.bodies)) return;
  const suppressed = collectSuppressedIds(loaded.render_groups);
  for (const body of loaded.bodies) {
    if (!isTraceable(body, suppressed)) continue;
    const x = body.position.x;
    const y = body.position.y;
    let buf = traceBuffers.get(body.id);
    if (!buf) {
      buf = [];
      traceBuffers.set(body.id, buf);
    }
    const newest = buf.length > 0 ? buf[buf.length - 1] : null;
    if (newest && newest.x === x && newest.y === y) continue; // exact dedupe
    buf.push({ x, y });
    evictByPathLength(buf);
    if (buf.length > MAX_TRACE_POINTS) {
      buf.splice(0, buf.length - MAX_TRACE_POINTS);
    }
  }
}

// Evict oldest samples so the retained cumulative arc length stays within
// `maxTracePathM`. Walk from the newest sample backward, summing segment
// lengths; once the sum exceeds the cap, the segment that tipped it over is
// dropped (its older endpoint is spliced off), leaving retained arc <= cap.
function evictByPathLength(buf) {
  if (buf.length < 2) return;
  let acc = 0;
  let keepFrom = 0;
  for (let i = buf.length - 1; i > 0; i--) {
    acc += Math.hypot(buf[i].x - buf[i - 1].x, buf[i].y - buf[i - 1].y);
    if (acc > maxTracePathM) {
      keepFrom = i; // drop [0 .. i-1]; retained arc excludes the tipping segment
      break;
    }
  }
  if (keepFrom > 0) buf.splice(0, keepFrom);
}

// PURE mapping helper: map the buffered world samples to an ordered pixel
// list [{px,py}...] through the supplied `worldToPx` (renderer.worldToPx).
// Lives apart from the stroke so a test can assert on the returned geometry —
// drawTraceOverlay draws straight to a context and exposes no observable list.
export function tracePixelPoints(trace, worldToPx) {
  const out = [];
  if (!Array.isArray(trace)) return out;
  for (const sample of trace) {
    const q = worldToPx(sample);
    out.push({ px: q.x, py: q.y });
  }
  return out;
}

// Thin stroke adapter. For each traceable body, map its trace via the pure
// `tracePixelPoints` helper and stroke the poly-line, fading alpha from
// oldest to newest. Called from Canvas2DRenderer.render() BEFORE drawBodies
// so the live body disk sits on top of its own trail. Reuses
// `renderer.worldToPx` — never recomputes the camera transform.
export function drawTraceOverlay(renderer, loaded) {
  if (!renderer || !loaded || !Array.isArray(loaded.bodies)) return;
  const ctx = renderer.ctx;
  if (!ctx) return;
  const suppressed = collectSuppressedIds(loaded.render_groups);
  const worldToPx = (p) => renderer.worldToPx(p);
  const prevAlpha = ctx.globalAlpha;
  ctx.strokeStyle = TRACE_COLOR;
  ctx.lineWidth = TRACE_LINE_WIDTH_PX;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (const body of loaded.bodies) {
    if (!isTraceable(body, suppressed)) continue;
    const trace = getTrace(body.id);
    if (trace.length < 2) continue;
    const pts = tracePixelPoints(trace, worldToPx);
    const n = pts.length;
    for (let i = 1; i < n; i++) {
      // Segment i connects vertex i-1 -> i; alpha ramps oldest -> newest.
      const frac = (n === 2) ? 1 : i / (n - 1);
      ctx.globalAlpha = TRACE_ALPHA_OLDEST + (TRACE_ALPHA_NEWEST - TRACE_ALPHA_OLDEST) * frac;
      ctx.beginPath();
      ctx.moveTo(pts[i - 1].px, pts[i - 1].py);
      ctx.lineTo(pts[i].px, pts[i].py);
      ctx.stroke();
    }
  }
  ctx.globalAlpha = prevAlpha;
}

export const NAME = 'trajectory_trace';
