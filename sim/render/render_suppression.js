// render/render_suppression.js
//
// ONE shared render-layer suppression predicate. `isRenderSuppressed` is the
// single home of the "this body is folded into an extended-object render
// group (line / sheet / ring), so the standard body layer must NOT draw it a
// second time" rule — the exact set canvas2d's drawBodies has always used via
// `collectSuppressedIds(loaded.render_groups)`.
//
// Extracting it here means drawBodies (the renderer) AND isTraceable (the
// trajectory-trace layer) AND the future ghost layer all delegate to ONE
// function. Adding a suppressed group kind is then a one-site edit, never a
// mirrored pair that silently drifts (a body the renderer hides but the trace
// still draws, or vice-versa).
//
// SCOPE NOTE (traced through the live scenes before writing this): drawBodies
// draws `pinned` bodies and any `placeholder` body — e.g. induced_current_1's
// pinned `moving_bar` is drawn here as its "conducting rod" render_shape and
// has no other draw path. So `isRenderSuppressed` deliberately does NOT fold
// in pinned/placeholder: doing so would delete that rod from the renderer.
// Those two are pedagogical TRACE-only exclusions (a pinned body's trail
// teaches nothing — the same DEF-2 rationale motion_graph uses to drop a
// pinned body), so they live in `isTraceable` (trajectory_trace.js), layered
// on top of this shared render-group rule — not inside it.

import { collectSuppressedIds } from '../engine/extended_object_geometry.js';

// Reserved id for the dummy body a pure-circuit scene parks at the origin
// (see canvas2d `hasRealPhysicalContent`). Exported so the trace/ghost layers
// name it once instead of hard-coding the literal.
export const PLACEHOLDER_BODY_ID = 'placeholder';

// True when the standard body-draw layer suppresses `body` because it belongs
// to an extended-object render group. `loadedOrSet` is EITHER the loaded scene
// (we derive the suppressed set) OR a precomputed Set — drawBodies /
// drawTraceOverlay build the set ONCE per frame and pass it in so we do not
// re-run `collectSuppressedIds` for every body (O(N) not O(N^2)).
export function isRenderSuppressed(body, loadedOrSet) {
  if (!body) return true;
  const set = loadedOrSet instanceof Set
    ? loadedOrSet
    : collectSuppressedIds(loadedOrSet?.render_groups);
  return set.has(body.id);
}

export const NAME = 'render_suppression';
