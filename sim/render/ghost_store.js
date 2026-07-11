// render/ghost_store.js
//
// sim_trace_ghost P2 — the ghost-run store. On Reset, a FINISHED run's frozen
// trajectory + motion-graph buffers + LoL snapshot are captured as a faded
// "ghost" so one edit yields a side-by-side before/after. A module-local FIFO
// of at most MAX_GHOSTS records; the oldest drops when a new one arrives.
//
// A ghost is a deep-COPY of the buffers the live run already filled (P1's
// trajectory trace + Phase-2.3 motion-graph buffers) plus a computeBars LoL
// snapshot — no engine involvement, no re-simulation. Deep-copying at capture
// time is what lets the still-live buffers be cleared for the very next run
// without disturbing the frozen ghost.
//
// captureGhost CONSUMES the three snapshots handed to it; it never reaches
// into the live module-local Maps itself. The per-channel motion-graph keys
// (produced by motion_graph.channelBufferKey) are NOT enumerable from a loaded
// scene, so the producer (snapshotBuffers / snapshotTraces) must hand over the
// whole key→buffer Map. ghost_store therefore imports NEITHER channelBufferKey
// nor any keying logic — it stores the raw snapshot Maps and hands them back to
// motion_graph to interpret. This keeps channelBufferKey defined in exactly one
// module for both the live and the ghost path.
//
// Anti-Kohn: a ghost is a neutral faded trail labeled with the classroom
// parameter value the frozen run ran at (see ui/ghost_label.js). No trial
// counter, no ranking, no evaluative readout — this file lives under
// sim/render/ and is scanned by the anti-Kohn drift lint.

import { computeBars } from './lol_overlay.js';
import { tracePixelPoints } from './trajectory_trace.js';

// FIFO capacity. ~3 keeps a readable before/after without clutter. One edit
// site; revisit if a curriculum wants a longer comparison stack.
export const MAX_GHOSTS = 3;

// Uniform ghost fade so the eye separates a frozen ghost from the live trail.
const GHOST_ALPHA = 0.3;
// Same body-disk navy as the live trace — a ghost reads as "an earlier path of
// this body", not a new brand color; the alpha alone distinguishes it.
const GHOST_COLOR = '#2c3e50';
const GHOST_LINE_WIDTH_PX = 2;
const GHOST_LABEL_FONT = '10px "Times New Roman", serif';
const GHOST_LABEL_COLOR = '#4a4f59';
const GHOST_LABEL_OFFSET_PX = 6;

// Module-local FIFO. Each record: { label, trace: Map, graph: Map, lol }.
//   trace — deep-copied per-body trajectory buffers (id → [{x,y}, ...])
//   graph — deep-copied motion-graph buffers, per-body AND per-channel
//   lol   — a computeBars() composition of the run's final LoL snapshot
//           (or null when the scene has no ConservationTracker)
const ghosts = [];

// Capture a finished run as a ghost. The caller passes:
//   traceSnapshot        — snapshotTraces()  from trajectory_trace.js
//   graphSnapshot        — snapshotBuffers() from motion_graph.js (per-body
//                          AND per-channel keys)
//   conservationSnapshot — the run's final ConservationTracker snapshot
//                          (currentRunner.view().energy at capture time — the
//                          SAME object computeBars consumes in drawLolOverlay)
//   label                — ghostLabel(edits, baseScene)
//
// Both buffer snapshots are deep-copied here (structuredClone) so a later
// clear/refill of the live buffers cannot mutate the frozen ghost. The LoL
// snapshot is reduced to a computeBars composition (freshly-built objects,
// independent of the live tracker). FIFO-drops the oldest past MAX_GHOSTS.
export function captureGhost(traceSnapshot, graphSnapshot, conservationSnapshot, label) {
  const record = {
    label: label ?? null,
    trace: structuredClone(traceSnapshot ?? new Map()),
    graph: structuredClone(graphSnapshot ?? new Map()),
    lol: conservationSnapshot ? computeBars(conservationSnapshot) : null
  };
  ghosts.push(record);
  while (ghosts.length > MAX_GHOSTS) ghosts.shift();
}

// Empty the store. Called from loadAndStart ONLY on a scene SWAP (incoming id
// differs from the outgoing scene id) — a same-scene Reset KEEPS ghosts so a
// before/after can build up.
export function clearGhosts() {
  ghosts.length = 0;
}

// Read-only accessor for tests + introspection. Returns a shallow copy of the
// record list (oldest first, newest last) so a caller can't mutate the FIFO.
export function getGhosts() {
  return ghosts.slice();
}

// Return each ghost's RAW motion-graph buffer Map + its label, for motion_graph
// to interpret with its OWN channelBufferKey. ghost_store does NOT re-key into
// the Map: a bodyId alone cannot reconstruct the per-channel keys, so re-keying
// here would force this module to duplicate channelBufferKey and silently break
// on any keying refactor. The consumer (P3's motion-graph ghost underlay) feeds
// each returned `buffers` Map into buildGraphEntries(..., ghostBufferMap).
// `bodyId` is accepted for the consumer's per-body pick; no keying happens here.
export function ghostGraphEntries(bodyId) {
  void bodyId;
  return ghosts.map((g) => ({ label: g.label, buffers: g.graph }));
}

// The captured LoL composition for the ghost at `index` (0 = oldest). Consumed
// by P3's energy-contrast render so a ghost's U_thermal stays visible while a
// later run is live. Null when the index is out of range or the scene had no
// tracker.
export function ghostLol(index) {
  const g = ghosts[index];
  return g ? g.lol : null;
}

// PURE capture decision — "should this finished run leave a ghost?". Extracted
// so the boundary (both branches) is unit-testable without driving the whole
// doReset seam (physics/CLAUDE.md: test the pure predicate, not the heuristic):
//   - a COMPLETE run (view.atEnd true) that was NOT blocked by invalid edits
//     → capture a ghost
//   - a mid-run Reset (atEnd false) → NO ghost (a truncated curve beside a full
//     next run would read as "stopped early" and mislead)
//   - a reset blocked by invalid edits → NO ghost (it never reloads)
export function shouldCaptureGhost({ atEnd, blockedByInvalidEdits } = {}) {
  return atEnd === true && blockedByInvalidEdits !== true;
}

// Stroke every captured ghost's trajectory as a uniformly-faded trail, drawn
// from Canvas2DRenderer.render() BEFORE the live trace overlay so ghosts sit
// UNDER the live trail. Reuses renderer.worldToPx and the pure tracePixelPoints
// mapper (never recomputes the camera transform). Each ghost trace Map already
// holds ONLY the bodies that were traceable at capture time (recordTracePoint
// applied isTraceable then), so no re-filtering is needed here. Labels each
// ghost once, near the end of its last trail.
export function drawGhostTrails(renderer) {
  if (!renderer) return;
  const ctx = renderer.ctx;
  if (!ctx) return;
  if (ghosts.length === 0) return;
  const worldToPx = (p) => renderer.worldToPx(p);
  const prevAlpha = ctx.globalAlpha;
  ctx.strokeStyle = GHOST_COLOR;
  ctx.lineWidth = GHOST_LINE_WIDTH_PX;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (const ghost of ghosts) {
    let labelAnchor = null;
    for (const trace of ghost.trace.values()) {
      if (!Array.isArray(trace) || trace.length < 2) continue;
      const pts = tracePixelPoints(trace, worldToPx);
      ctx.globalAlpha = GHOST_ALPHA;
      ctx.beginPath();
      ctx.moveTo(pts[0].px, pts[0].py);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].px, pts[i].py);
      ctx.stroke();
      labelAnchor = pts[pts.length - 1];
    }
    if (labelAnchor && ghost.label) {
      ctx.globalAlpha = 1;
      ctx.font = GHOST_LABEL_FONT;
      ctx.fillStyle = GHOST_LABEL_COLOR;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(ghost.label, labelAnchor.px + GHOST_LABEL_OFFSET_PX, labelAnchor.py);
    }
  }
  ctx.globalAlpha = prevAlpha;
}

export const NAME = 'ghost_store';
