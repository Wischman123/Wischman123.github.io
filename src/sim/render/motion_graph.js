// render/motion_graph.js
//
// Motion-graph overlay. Renders stacked sub-plots vs sim-time, anchored at
// the BOTTOM-left of the canvas. Plots are fed by a rolling 10-second
// buffer; older samples drop.
//
// Two subplot SOURCES share one panel engine (Phase 3 item T6):
//   - body source   — the inspector-selected body's x/y/vₓ/vᵧ/aₓ/aᵧ.
//                      Buffer keyed by `body.id`, sample {t,x,y,vx,vy,ax,ay}.
//                      SUPPRESSED for a pinned body: its motion is constant,
//                      so six flat lines teach nothing (DEF-2 — the circuit
//                      placeholder-body bug).
//   - channel source — any scalar diagnostic the scene declares in
//                      `graph_channels` (current/voltage/EMF/flux). Buffer
//                      keyed `chan:<diagnosticKey>`, sample {t,value}, read
//                      each tick from `loaded.tracker.current().diagnostics`.
//                      This is how a circuit / induction scene graphs its
//                      REAL changing quantity instead of a dummy body.
// Both feed the same `drawPanel` / `drawSubplot` / `computeAxisRange`
// machinery — the panel is source-agnostic; an entry carries its own buffer
// and a scalar `accessor`.
//
// Render-layer-only contract: the buffer lives inside this module, the
// renderer never owns engine state, and `sim/engine/` is byte-identical
// after Phase 2.3. Acceleration is RECOMPUTED at sample time by summing
// forces (mirroring derivState in scene.js + the FBD overlay's
// computeBodyForces) — no `body.lastAcceleration` field is added.
//
// Sampling cadence: callers invoke `recordSample(loaded, t)` once per
// `runner.tick()` callback (~60 Hz at 1x playback). NOT per
// `_advanceOne()` — that would accumulate 10K samples in the spring
// oscillator (1000 Hz internal rate) over a single 10 s window.
//
// Anti-Kohn: axes are labeled with classroom notation only. No
// "your best run", no "trial number", no evaluative percent-error
// readout. Just curves and ranges.

const MAX_BUFFER_S = 10.0;

// Module-local map keyed by EITHER a body id (body source, sample
// {t,x,y,vx,vy,ax,ay}) OR a namespaced channel key `chan:<diagnosticKey>`
// (channel source, sample {t,value}). The `chan:` prefix keeps the two
// namespaces disjoint, so a body whose id happened to equal a diagnostic
// key can never collide with that channel's buffer. Lives outside any
// renderer instance so the universality contract holds (engine state
// untouched). `clearBuffers` wipes both; `getBuffer` reads both.
const buffers = new Map();

// Channel-buffer namespace. A scene's `graph_channels[i].key` is a raw
// diagnostics-map key (e.g. `i_branch_R1`); its buffer is stored under
// `chan:i_branch_R1`. Exported so the Playwright harness can introspect a
// channel buffer by the same rule.
export function channelBufferKey(diagnosticKey) {
  return `chan:${diagnosticKey}`;
}

// Default stroke for a channel subplot when the scene declares no `color`.
// A neutral slate that reads on the panel background without colliding with
// the body-source palette below.
const DEFAULT_CHANNEL_COLOR = '#34495e';

// Pull the plotted scalar out of a channel sample.
const channelAccessor = (s) => s.value;

// Layout constants (CSS pixels — same convention as the LOL + FBD
// overlays). Bottom-right placement keeps overlays distributed
// (FBD per-body, LOL top-right, motion-graph bottom-right).
// 6 subplots (x, y, vx, vy, ax, ay) need a taller panel.
const PANEL_W_PX = 240;
const PANEL_H_PX = 380;
const PANEL_MARGIN_PX = 16;
// Per-subplot height. Derived so a 6-subplot (full body motion) panel is
// exactly PANEL_H_PX tall, byte-identical to the pre-T6 layout; channel
// panels with fewer subplots shrink proportionally.
const SUBPLOT_H_PX = (PANEL_H_PX - 18) / 6; // 18 = TITLE_BAR_PX (defined below)
const PANEL_BG = 'rgba(252, 252, 253, 0.92)';
const PANEL_BORDER = '#dde0e7';

const TITLE_FONT = 'bold 12px system-ui, sans-serif';
const TITLE_COLOR = '#2d3138';
const SUBPLOT_TITLE_FONT = '10px system-ui, sans-serif';
const SUBPLOT_TITLE_COLOR = '#4a4f59';
const TICK_FONT = '9px system-ui, sans-serif';
const TICK_COLOR = '#888';
const AXIS_BOX_COLOR = '#cdd1da';
const ZERO_BASELINE_COLOR = '#e1e4eb';
const PLACEHOLDER_FONT = 'italic 10px system-ui, sans-serif';
const PLACEHOLDER_COLOR = '#888';

const TITLE_BAR_PX = 18;       // headroom for the panel title
const PLOT_LEFT_PAD = 38;      // y-axis label gutter
const PLOT_RIGHT_PAD = 10;
const PLOT_TOP_PAD = 11;       // sub-plot title row
const PLOT_BOTTOM_PAD = 6;     // gap below each subplot (no t-ticks here)
const PLOT_BOTTOM_PAD_LAST = 16; // t-tick row only on the bottommost subplot

// --- Frozen-frame constants (predict-the-graph, sim_predict_graph P2) ---
// Shared span floor. The px mappings divide by tSpan and valSpan; a zero span
// is a divide-by-zero. Every span consumer (drawSubplot forward map,
// plotToPxFrozen, pxToPlotFrozen) floors through this SAME constant so the
// forward draw and its inverse use an identical denominator.
const AXIS_SPAN_EPS = 1e-9;
// Hard-mode headroom fraction `m` (CALCULATE, NEVER GUESS). The student's
// chosen bounds are the PLAUSIBLE PREDICTION BAND [nominalMin, nominalMax];
// the frozen value axis is that band widened by m·span on each side so a
// normal over/under-prediction renders inside the frame without clamping,
// while a gross misprediction still honestly runs off the edge. Recorded in
// PEDAGOGY.md §Predict-the-graph so the headroom is reproducible per scenario.
const HARD_RANGE_HEADROOM_M = 0.25;
// tMax divide-by-zero safety net (symmetric to the valSpan floor). A
// mis-authored nominal duration of 0/negative (or a zero-length hidden
// pre-run) would make tSpan = tMax = 0. Well-authored scenarios ALWAYS pass
// the real run duration (asserted by the exit-gate fit test); this floor only
// keeps the math finite for a mis-authored input — it is not a display default.
const MIN_FROZEN_TMAX = AXIS_SPAN_EPS;

// Sub-plot definitions. Order is locked to match Modeling Instruction
// teaching order: position → velocity → acceleration. Each quantity
// gets two stacked subplots — x first, then y — so projectile motion
// (and any 2D scene) reads top-to-bottom as x-row → y-row at each
// derivative. Colors mirror the FBD/LOL palette family (position
// dark navy, velocity green like the canvas velocity arrow,
// acceleration purple to match F_s); y-rows use lighter shades so a
// glance distinguishes x from y.
const SUBPLOTS = [
  { key: 'x',  title: 'x (m)',      color: '#2c3e50' },
  { key: 'y',  title: 'y (m)',      color: '#7f8c98' },
  { key: 'vx', title: 'vₓ (m/s)',   color: '#27ae60' },
  { key: 'vy', title: 'vᵧ (m/s)',   color: '#7fc99a' },
  { key: 'ax', title: 'aₓ (m/s²)', color: '#7C4DFF' },
  { key: 'ay', title: 'aᵧ (m/s²)', color: '#b8a2ff' }
];

// Look up a subplot's { title, color } by its sample key (x/y/vx/vy/ax/ay).
// Predict-the-graph (P4) reuses this so the sketch overlay's REAL curve is drawn
// in the SAME palette color the motion-graph subplot uses for that quantity —
// the color is the quantity's own identity, NEVER red/green error coding. Falls
// back to a neutral slate for an unknown key.
export function subplotStyleForKey(sampleKey) {
  const sp = SUBPLOTS.find((s) => s.key === sampleKey);
  return sp ? { title: sp.title, color: sp.color } : { title: '', color: DEFAULT_CHANNEL_COLOR };
}

// --- Predict-the-graph sketch overlay constants (sim_predict_graph P4) ---
// The sketch curve is DASHED + NEUTRAL so it never reads as a red/green
// right/wrong signal; the real curve is SOLID in the quantity's palette color.
// The two strokes ARE the whole feedback — nothing is drawn between them.
const SKETCH_DASH = [5, 4];
const SKETCH_STROKE_W = 1.75;
// Neutral slate (the subplot-title gray family) — deliberately NOT from the
// red/green semantic space. Exported so main.js stamps the same color onto the
// session that drawSketchOverlay defaults to, keeping capture + draw in lockstep.
export const SKETCH_STROKE_COLOR = '#4a4f59';
// The sketch panel is a SINGLE subplot (Option a: sketch mode REPLACES the whole
// motion-graph overlay with just the one sketched quantity — one quantity per
// session, focused). Its panel height is the title bar plus one subplot row.
const SKETCH_PANEL_H_PX = TITLE_BAR_PX + SUBPLOT_H_PX;

// Public: clear every body's buffer. Called from main.js when the scene
// changes or the user presses Reset, so a fresh run starts with a clean
// graph.
export function clearBuffers() {
  buffers.clear();
}

// Public: read-only accessor for tests + Playwright introspection. The
// returned array is the live buffer — do not mutate.
export function getBuffer(bodyId) {
  return buffers.get(bodyId) ?? [];
}

// sim_trace_ghost P2 — snapshot EVERY key→buffer in the module-local `buffers`
// Map (per-body AND the per-channel keys produced internally by
// channelBufferKey), for ghost_store.captureGhost to deep-copy at Reset.
// Returns a fresh (shallow) Map so a later clearBuffers / new-run refill cannot
// change the snapshot's key SET; the consumer deep-copies the inner arrays.
//
// This is the ONLY accessor that hands over the channel keys: `getBuffer(key)`
// reads one known key and `clearBuffers` wipes all, but the per-channel keys
// are NOT derivable from a loaded scene's bodies, so captureGhost must be handed
// the whole Map rather than re-deriving the channel enumeration. Pure additive
// export — the sole existing `buffers` reader (getBuffer) is unchanged. ONE
// canonical name; no bufferKeys() alias is shipped (no concrete caller needs
// the key list alone).
export function snapshotBuffers() {
  return new Map(buffers);
}

// Public: record one sample for every body in the loaded scene at time t.
// Called from `main.js::onTick`. Acceleration is recomputed on demand to
// avoid attaching state to the integrator hot path (universality
// contract).
export function recordSample(loaded, t) {
  if (!loaded) return;
  if (Array.isArray(loaded.bodies)) {
    for (const body of loaded.bodies) {
      const a = computeAcceleration(body, loaded);
      let buf = buffers.get(body.id);
      if (!buf) {
        buf = [];
        buffers.set(body.id, buf);
      }
      buf.push({
        t,
        x: body.position.x,
        y: body.position.y,
        vx: body.velocity.x,
        vy: body.velocity.y,
        ax: a.x,
        ay: a.y
      });
      evictOlderThan(buf, t - MAX_BUFFER_S);
    }
  }
  recordChannelSamples(loaded, t);
}

// Phase 3 item T6: append one {t, value} sample per declared diagnostic
// channel. The live diagnostics map is fetched ONCE per tick and shared
// across every channel (so we never re-run the tracker per channel).
//
// Degenerate paths (spec §T6 "Degenerate paths") — all resolve to DROP,
// never fabricate:
//   - scene declares no channels        → no-op
//   - tracker absent / current() throws → skip this tick (no samples)
//   - diagnostics map absent            → skip this tick
//   - key missing from the map          → skip THAT channel (others still
//                                          record), so a partially-ready
//                                          solve graphs what it has
//   - value NaN / Inf                   → drop, so auto-scale is never
//                                          poisoned and the curve just gaps
function recordChannelSamples(loaded, t) {
  const channels = loaded?.graph_channels;
  if (!Array.isArray(channels) || channels.length === 0) return;
  let diagnostics;
  try {
    diagnostics = loaded.tracker?.current?.().diagnostics;
  } catch {
    diagnostics = null;
  }
  if (!diagnostics || typeof diagnostics !== 'object') return;
  for (const ch of channels) {
    const raw = diagnostics[ch.key];
    if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
    const key = channelBufferKey(ch.key);
    let buf = buffers.get(key);
    if (!buf) {
      buf = [];
      buffers.set(key, buf);
    }
    buf.push({ t, value: raw });
    evictOlderThan(buf, t - MAX_BUFFER_S);
  }
}

// Drop samples whose timestamp is strictly less than `cutoff`. Buffer
// is sorted by t (monotonic — runner.t never goes backwards), so we can
// splice from the front.
function evictOlderThan(buf, cutoff) {
  let i = 0;
  while (i < buf.length && buf[i].t < cutoff) i++;
  if (i > 0) buf.splice(0, i);
}

// Compute net acceleration on a single body by summing every applicable
// force divided by mass. Mirrors the body of derivState() in scene.js
// without re-running the integrator. Forces are passed `sceneCtx` so
// surface-tangent friction + field-driven Lorentz still resolve
// correctly.
export function computeAcceleration(body, loaded) {
  let Fx = 0, Fy = 0;
  const sceneCtx = loaded.sceneCtx;
  if (loaded.forces) {
    for (const f of loaded.forces) {
      if (!f.appliesTo(body.id)) continue;
      // Force.applyTo returns {F: {x, y}, tau} (Phase 3.4 wrapper); destructure.
      const { F } = f.applyTo(body, sceneCtx);
      Fx += F.x;
      Fy += F.y;
    }
  }
  if (loaded.surfaces) {
    for (const surface of loaded.surfaces.values()) {
      const Fc = surface.contactForce(body, sceneCtx?.k_contact, sceneCtx?.c_damping);
      Fx += Fc.Fx;
      Fy += Fc.Fy;
    }
  }
  if (loaded.constraints) {
    for (const c of loaded.constraints) {
      if (!c.appliesTo(body.id)) continue;
      // Pass sceneCtx (2nd arg) so a two-body StringConstraint can read its
      // partner body from sceneCtx.bodies; RodConstraint ignores it. Reuse the
      // canonical loaded.sceneCtx (same object as the force loop above).
      const F = c.applyTo(body, sceneCtx);
      Fx += F.x;
      Fy += F.y;
    }
  }
  return { x: Fx / body.mass, y: Fy / body.mass };
}

// Compute (min, max) for one quantity across the buffer, with 10%
// headroom. Constant-value runs (all samples equal) get symmetric
// padding so the curve doesn't degenerate to a flat line on the axis.
//
// Exported so unit tests can drive it without rendering.
export function computeAxisRange(buffer, keyOrAccessor) {
  if (buffer.length === 0) return { min: -1, max: 1 };
  // Accept a string key (body sample: s[key]) or a function accessor
  // (channel sample: s => s.value) so one range computer serves both
  // subplot sources.
  const read = typeof keyOrAccessor === 'function'
    ? keyOrAccessor
    : (s) => s[keyOrAccessor];
  let min = Infinity, max = -Infinity;
  for (const s of buffer) {
    const v = read(s);
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: -1, max: 1 };
  if (min === max) {
    const pad = Math.abs(min) * 0.1 + 0.5;
    return { min: min - pad, max: max + pad };
  }
  const span = max - min;
  return { min: min - span * 0.1, max: max + span * 0.1 };
}

// Predict-the-graph (sim_predict_graph P2): compute a FIXED axis range so the
// target frame cannot rescale under the student's drawn curve. Returns
// `{ tMin: 0, tMax, vMin, vMax }` — the time axis is always `[0, tMax]`.
//
// P0 resolved to a two-mode Easy/Hard toggle, so BOTH source shapes are LIVE
// (not one-chosen). Exactly ONE of `buffer` / `range` must be provided
// (buffer XOR range):
//   - EASY mode (`buffer`): the hidden pre-run's real buffer, run through the
//     existing `computeAxisRange` math (its 10% headroom already fits the real
//     curve). `accessor` picks the plotted scalar, same as `computeAxisRange`.
//   - HARD mode (`range` = { vMin, vMax }): the student's chosen bounds — the
//     PLAUSIBLE PREDICTION BAND — used DIRECTLY (no `computeAxisRange`-over-
//     buffer pass), then widened by the named `HARD_RANGE_HEADROOM_M` fraction
//     so a normal over/under-prediction renders without clamping.
//
// `tMax` is the run's time extent (EASY: the hidden pre-run duration; HARD: the
// scenario nominal run duration the real run must honor). Guards mirror the two
// px-mapping denominators: `valSpan == 0` (flat/constant curve) and `tMax <= 0`
// (zero time span) each get a floor so `drawSubplot` never divides by zero.
//
// Exported so unit tests can drive it without rendering.
export function frozenAxisRange({ buffer, range, accessor } = {}, tMax) {
  const hasBuffer = buffer != null;
  const hasRange = range != null;
  // buffer XOR range — never both, never neither. A buffer-only signature
  // would silently drop Hard mode; requiring the caller to pick keeps the P0
  // two-mode decision honest at the call site.
  if (hasBuffer === hasRange) {
    throw new Error(
      'frozenAxisRange: exactly one of { buffer, range } must be provided (buffer XOR range)'
    );
  }

  let vMin, vMax;
  if (hasBuffer) {
    // EASY — real curve through the existing range math (10% headroom, plus
    // its own constant-value symmetric pad → valSpan > 0 already).
    const r = computeAxisRange(buffer, accessor);
    vMin = r.min;
    vMax = r.max;
  } else {
    // HARD — student's plausible band, widened by m·span on each side.
    const nominalMin = Number(range.vMin);
    const nominalMax = Number(range.vMax);
    if (!Number.isFinite(nominalMin) || !Number.isFinite(nominalMax)) {
      throw new Error('frozenAxisRange: range must have finite { vMin, vMax }');
    }
    const span = nominalMax - nominalMin;
    vMin = nominalMin - HARD_RANGE_HEADROOM_M * span;
    vMax = nominalMax + HARD_RANGE_HEADROOM_M * span;
  }

  // valSpan floor (flat curve / degenerate or inverted band). computeAxisRange
  // already guarantees this for the buffer path; the explicit range path can
  // still hand us vMin == vMax (an at-rest prediction), so floor here too.
  if (!(vMax - vMin > 0)) {
    const mid = (vMin + vMax) / 2;
    const pad = Math.abs(mid) * 0.1 + 0.5; // mirror computeAxisRange's constant pad
    vMin = mid - pad;
    vMax = mid + pad;
  }

  // tMax floor (symmetric to the valSpan floor). tMin is fixed at 0, so
  // tSpan = tMax; a non-positive or non-finite tMax would divide by zero.
  let frozenTMax = Number(tMax);
  if (!Number.isFinite(frozenTMax) || frozenTMax <= 0) {
    frozenTMax = MIN_FROZEN_TMAX;
  }

  return { tMin: 0, tMax: frozenTMax, vMin, vMax };
}

// Pick the body whose curves to plot. Preference: inspector-selected
// body (if it exists in the loaded scene), else the first body.
//
// Exported for tests.
export function pickGraphBody(loaded, selectedBodyId) {
  if (!loaded || !loaded.bodies || loaded.bodies.length === 0) return null;
  if (selectedBodyId) {
    const found = loaded.bodies.find(b => b.id === selectedBodyId);
    if (found) return found;
  }
  return loaded.bodies[0];
}

// Public render entry. Called from Canvas2DRenderer.render() after the
// LOL overlay. The motion-graph panel is anchored at the BOTTOM-LEFT
// of the canvas — paired with the LOL overlay's TOP-RIGHT anchor so
// the two never collide on shorter canvases (the motion-graph grew to
// 6 subplots tall to cover x and y, which exceeded the visible canvas
// height with both panels on the right).
export function drawMotionGraphOverlay(renderer, loaded, selectedBodyId) {
  const { entries, panelTitle } = buildGraphEntries(loaded, selectedBodyId);
  // Nothing graphable — e.g. a circuit scene whose only body is a pinned
  // placeholder AND which declares no channels. Draw nothing rather than an
  // empty box.
  if (entries.length === 0) return;
  const panelH = TITLE_BAR_PX + entries.length * SUBPLOT_H_PX;
  const anchor = {
    x: PANEL_MARGIN_PX,
    y: renderer.cssHeight - panelH - PANEL_MARGIN_PX
  };
  drawPanel(renderer.ctx, anchor, entries, panelTitle, panelH);
}

// Assemble the ordered subplot entries for the current scene. Each entry is
// { title, color, buffer, accessor } — source-agnostic, so the panel engine
// never branches on body-vs-channel. Body motion subplots come first (when
// present), then one subplot per declared diagnostic channel.
//
// DEF-2: a PINNED body contributes NO motion subplots — its position is
// fixed, so x/y/vₓ/vᵧ/aₓ/aᵧ are all constant and would render as six flat,
// meaningless lines (the original circuit placeholder-body bug). Channels
// fill the panel instead.
//
// sim_trace_ghost P2 — an OPTIONAL `ghostBufferMap` (the raw deep-copied
// snapshot Map from a captured ghost, per-body AND per-channel) attaches a
// parallel `ghostBuffer` to each entry so drawSubplot can render it as a faded
// underlay BEHIND the live curve. The ghost Map is interpreted HERE with
// motion_graph's OWN channelBufferKey — the same key on the render side as on
// the capture side — so ghost_store never re-keys and channelBufferKey stays
// defined in exactly one module. Defaults to none so the sole current caller
// (drawMotionGraphOverlay, below) and drawOneMotionGraph are byte-unaffected.
//
// Exported for unit tests.
export function buildGraphEntries(loaded, selectedBodyId, ghostBufferMap = null) {
  const entries = [];
  const body = pickGraphBody(loaded, selectedBodyId);
  let panelTitle = 'Diagnostics';
  if (body && !body.pinned) {
    const buf = getBuffer(body.id);
    const ghostBuf = ghostBufferMap ? (ghostBufferMap.get(body.id) ?? null) : null;
    for (const sp of SUBPLOTS) {
      const key = sp.key;
      entries.push({
        title: sp.title,
        color: sp.color,
        buffer: buf,
        accessor: (s) => s[key],
        ghostBuffer: ghostBuf
      });
    }
    panelTitle = `Motion: ${body.id}`;
  }
  const channels = Array.isArray(loaded?.graph_channels) ? loaded.graph_channels : [];
  for (const ch of channels) {
    const key = channelBufferKey(ch.key);
    const buf = getBuffer(key);
    const ghostBuf = ghostBufferMap ? (ghostBufferMap.get(key) ?? null) : null;
    const title = ch.units ? `${ch.label} (${ch.units})` : ch.label;
    entries.push({
      title,
      color: ch.color ?? DEFAULT_CHANNEL_COLOR,
      buffer: buf,
      accessor: channelAccessor,
      ghostBuffer: ghostBuf
    });
  }
  return { entries, panelTitle };
}

// --- Single-source geometry + forward-mapping primitives ---
//
// These three pure helpers are the ONE source of truth for (a) the inner
// plot-box pad math, (b) the per-subplot stacking anchor, and (c) the
// plot→px forward map. drawSubplot, subplotGeometry (P3's inverse binding),
// and plotToPxFrozen all route through them, so the drawn frame, the exported
// geometry, and the inverse P3 consumes can never drift.

// Inner plot box: strip the pads off a subplot's outer rect. The bottommost
// subplot reserves a taller bottom pad for its t-tick row.
function plotBox(anchorX, anchorY, width, height, isLast) {
  const bottomPad = isLast ? PLOT_BOTTOM_PAD_LAST : PLOT_BOTTOM_PAD;
  return {
    x0: anchorX + PLOT_LEFT_PAD,
    y0: anchorY + PLOT_TOP_PAD,
    w: width - PLOT_LEFT_PAD - PLOT_RIGHT_PAD,
    h: height - PLOT_TOP_PAD - bottomPad
  };
}

// Public {x0,y0,x1,y1} form of a subplot's INNER plot rect, for overlays that
// reuse drawSubplot with their own panel geometry (sim_kinetic_theory P4) and
// need the exact drawn frame to hand to a behavioral overlay invariant. Single
// source of the pad math — the KT overlay and its no-shading guard can never
// drift from what drawSubplot actually strokes.
export function subplotPlotRect(anchor, width, height, isLast) {
  const b = plotBox(anchor.x, anchor.y, width, height, isLast);
  return { x0: b.x0, y0: b.y0, x1: b.x0 + b.w, y1: b.y0 + b.h };
}

// Per-subplot outer anchor within a panel. Mirrors drawPanel's stacking loop
// under the canonical panel height (panelH = TITLE_BAR_PX + N·SUBPLOT_H_PX),
// which every real caller (drawMotionGraphOverlay sizes panelH from the entry
// count; drawOneMotionGraph passes the 6-subplot PANEL_H_PX) satisfies.
function subAnchorFor(panelAnchor, index) {
  return {
    x: panelAnchor.x,
    y: panelAnchor.y + TITLE_BAR_PX + index * SUBPLOT_H_PX
  };
}

// THE forward map: plot coords (t, v) → screen px within a plot box. Used by
// drawSubplot's curve/ghost strokes AND by plotToPxFrozen, so pxToPlotFrozen
// provably inverts the exact formula the frame is drawn with.
function forwardPx(t, v, tMin, tSpan, vMin, valSpan, box) {
  return {
    px: box.x0 + ((t - tMin) / tSpan) * box.w,
    py: box.y0 + box.h - ((v - vMin) / valSpan) * box.h
  };
}

// Exported per-subplot geometry `{ x0, y0, w, h }` — the single seam P3 binds
// pxToPlotFrozen against and P4 composes its overlay against. DERIVED FROM the
// SAME subAnchorFor + plotBox math drawSubplot uses internally, so the inverse
// uses the exact geometry the forward draw used (no re-derived copy).
export function subplotGeometry(panelAnchor, entriesCount, index) {
  const a = subAnchorFor(panelAnchor, index);
  const isLast = index === entriesCount - 1;
  return plotBox(a.x, a.y, PANEL_W_PX, SUBPLOT_H_PX, isLast);
}

// Forward map exposed for P4 composition + tests: plot { t, v } → { px, py }
// under a frozen frame. Thin wrapper over the shared forwardPx so the frozen
// map and the live draw are one formula.
export function plotToPxFrozen(sample, fixedRange, geom) {
  const tSpan = Math.max(fixedRange.tMax - fixedRange.tMin, AXIS_SPAN_EPS);
  const valSpan = Math.max(fixedRange.vMax - fixedRange.vMin, AXIS_SPAN_EPS);
  return forwardPx(sample.t, sample.v, fixedRange.tMin, tSpan, fixedRange.vMin, valSpan, geom);
}

// Inverse map for P3's pointer capture: screen { px, py } → plot { t, v }.
// Algebraic inverse of forwardPx (the same formula plotToPxFrozen / the live
// draw use), with the SAME AXIS_SPAN_EPS span floors so the round-trip is exact.
export function pxToPlotFrozen(screen, fixedRange, geom) {
  const tSpan = Math.max(fixedRange.tMax - fixedRange.tMin, AXIS_SPAN_EPS);
  const valSpan = Math.max(fixedRange.vMax - fixedRange.vMin, AXIS_SPAN_EPS);
  const t = fixedRange.tMin + ((screen.px - geom.x0) / geom.w) * tSpan;
  const v = fixedRange.vMin + ((geom.y0 + geom.h - screen.py) / geom.h) * valSpan;
  return { t, v };
}

// Compose one subplot into a FROZEN frame at panel index `index`, positioned by
// subplotGeometry so its strokes land on exactly the px pxToPlotFrozen inverts
// (P4's overlay seam; P3 binds pointer capture against the SAME subplotGeometry
// call). A thin wrapper: it derives the subAnchor with the shared subAnchorFor
// and hands drawSubplot the fixedRange, so the drawn box === subplotGeometry(...).
export function drawFrozenSubplot(ctx, panelAnchor, entriesCount, index, buffer, accessor, title, color, fixedRange) {
  const a = subAnchorFor(panelAnchor, index);
  const isLast = index === entriesCount - 1;
  drawSubplot(ctx, a, PANEL_W_PX, SUBPLOT_H_PX, buffer, accessor, title, color, isLast, null, fixedRange);
}

// --- Predict-the-graph sketch overlay (sim_predict_graph P4) ---
//
// SINGLE-SUBPLOT panel anchor + geometry. Both the DRAW side (canvas2d.js calls
// drawSketchOverlay with sketchPanelAnchor) and the CAPTURE side (main.js binds
// P3's pxToPlotFrozen against sketchGeometry) derive the box from THIS one place,
// so the frame the student sketches on and the frame the overlay draws into can
// never drift (the exact P2/P3 forward↔inverse contract). Anchored bottom-left,
// mirroring drawMotionGraphOverlay so the sketch panel lands where the motion
// graph would (Option a: sketch mode REPLACES that overlay).
export function sketchPanelAnchor(cssHeight) {
  return { x: PANEL_MARGIN_PX, y: cssHeight - SKETCH_PANEL_H_PX - PANEL_MARGIN_PX };
}

// The single subplot's plotting box `{ x0, y0, w, h }` — subplotGeometry over a
// one-entry panel. main.js binds pxToPlotFrozen against THIS.
export function sketchGeometry(cssHeight) {
  return subplotGeometry(sketchPanelAnchor(cssHeight), 1, 0);
}

// Stroke the student's SEGMENTED sketch curve, dashed + neutral. Each segment
// is its own stroke with NO connecting line across a pen-lift gap (P3 hands us
// the segments precisely so we never bridge them), and NOTHING is drawn between
// the sketch and the real curve — no fill of any kind (the behavioral
// invariant assertNoFillBetweenCurves guards this). A one-sample segment (a
// single occupied bin) has no line to stroke, so it is skipped rather than
// emitting a zero-length path.
function strokeSketchCurve(ctx, curve, fixedRange, geom, color) {
  if (!Array.isArray(curve) || curve.length === 0) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = SKETCH_STROKE_W;
  ctx.setLineDash(SKETCH_DASH);
  for (const segment of curve) {
    if (!Array.isArray(segment) || segment.length < 2) continue;
    ctx.beginPath();
    let started = false;
    for (const s of segment) {
      const v = typeof s.v === 'number' ? s.v : NaN;
      if (!Number.isFinite(s.t) || !Number.isFinite(v)) continue;
      const { px, py } = plotToPxFrozen({ t: s.t, v }, fixedRange, geom);
      if (!started) { ctx.moveTo(px, py); started = true; }
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }
  ctx.restore();
}

// THE overlay. Draws the student's sketch (dashed, neutral) and — once revealed
// — the real simulated curve (solid, palette color) in ONE frozen frame through
// the SAME drawFrozenSubplot mapping with P2's fixedRange, so both curves map
// through the identical fixedRange. Nothing is drawn between them.
//
// `session` = {
//   fixedRange, sketchCurve, realBuffer, realAccessor,
//   title, realColor, sketchColor, revealed
// }
//
// Reveal timing: `realBuffer` is passed EMPTY (`[]`) before the reveal, so
// drawFrozenSubplot renders only the scaled frame + ticks (no real curve) while
// the student sketches. On reveal, the caller passes the real buffer and the
// solid curve appears in place.
//
// Empty / null-sketch branch (resolved: option (b) — FALL BACK to the plain
// real-curve overlay). When `sketchCurve` is null/empty, strokeSketchCurve draws
// nothing and the frozen frame + real curve still render — a clean real-curve-
// only overlay with no crash, never a shaded region.
export function drawSketchOverlay(ctx, panelAnchor, session) {
  const {
    fixedRange, sketchCurve, realBuffer, realAccessor,
    title, realColor, sketchColor, revealed,
  } = session;
  const entriesCount = 1;
  const index = 0;

  // Panel background — a legitimate PLOT-BACKGROUND fill covering the whole
  // panel (so the frozen frame reads over the live scene). It fully contains the
  // plot box, so assertNoFillBetweenCurves exempts it as a background — it is NOT
  // a fill drawn between the two curves.
  ctx.fillStyle = PANEL_BG;
  ctx.strokeStyle = PANEL_BORDER;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.rect(panelAnchor.x, panelAnchor.y, PANEL_W_PX, SKETCH_PANEL_H_PX);
  ctx.fill();
  ctx.stroke();

  // Panel title row (neutral — no evaluative copy; the invitation + reveal prose
  // live in the predict panel).
  ctx.fillStyle = TITLE_COLOR;
  ctx.font = TITLE_FONT;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('Predict', panelAnchor.x + 8, panelAnchor.y + 4);

  // Frozen frame + (when revealed) the SOLID real curve. Empty realBuffer before
  // reveal → frame + ticks only (the drawSubplot frozen-empty path).
  const rb = revealed && Array.isArray(realBuffer) ? realBuffer : [];
  drawFrozenSubplot(ctx, panelAnchor, entriesCount, index, rb, realAccessor, title, realColor, fixedRange);

  // The student's sketch, dashed + neutral, on top.
  const geom = subplotGeometry(panelAnchor, entriesCount, index);
  strokeSketchCurve(ctx, sketchCurve, fixedRange, geom, sketchColor || SKETCH_STROKE_COLOR);
}

// Internal: render a panel of N stacked subplots at the given anchor (panel
// top-left in CSS pixels). `entries` is the source-agnostic list from
// buildGraphEntries; `panelH` is pre-sized by the caller.
function drawPanel(ctx, anchor, entries, panelTitle, panelH) {
  // --- Panel background ---
  ctx.fillStyle = PANEL_BG;
  ctx.strokeStyle = PANEL_BORDER;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.rect(anchor.x, anchor.y, PANEL_W_PX, panelH);
  ctx.fill();
  ctx.stroke();

  // --- Panel title ---
  ctx.fillStyle = TITLE_COLOR;
  ctx.font = TITLE_FONT;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(panelTitle, anchor.x + 8, anchor.y + 4);

  // --- Sub-plots stacked ---
  const subplotH = (panelH - TITLE_BAR_PX) / entries.length;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const subAnchor = {
      x: anchor.x,
      y: anchor.y + TITLE_BAR_PX + i * subplotH
    };
    const isLast = i === entries.length - 1;
    // `e.fixedRange` is absent for every current caller (buildGraphEntries /
    // drawOneMotionGraph never set it) → null → byte-identical legacy path.
    // P3/P4 attach a per-entry fixedRange to render frozen predict-the-graph
    // frames through this same panel engine.
    drawSubplot(ctx, subAnchor, PANEL_W_PX, subplotH, e.buffer, e.accessor, e.title, e.color, isLast, e.ghostBuffer, e.fixedRange ?? null);
  }
}

// Backward-compatible body-panel renderer: draws the six fixed motion
// subplots from a single body buffer, full PANEL_H_PX tall, titled
// "Motion: <id>". Kept as the test seam (same pattern as drawOneFbd /
// drawOneLol) and as a thin wrapper over the source-agnostic drawPanel.
export function drawOneMotionGraph(ctx, anchor, buffer, bodyId) {
  const entries = SUBPLOTS.map((sp) => ({
    title: sp.title,
    color: sp.color,
    buffer,
    accessor: (s) => s[sp.key]
  }));
  drawPanel(ctx, anchor, entries, `Motion: ${bodyId}`, PANEL_H_PX);
}

// Render one labeled sub-plot. Empty / single-sample buffer falls back
// to a placeholder string so the panel reads as "waiting for samples"
// rather than empty boxes.
// Render one labeled sub-plot. Empty / single-sample buffer falls back to a
// placeholder string. Exported as the frozen-frame test seam (mirrors the
// drawOneMotionGraph seam pattern).
//
// `fixedRange` (predict-the-graph, P2): when provided ({ tMin, tMax, vMin,
// vMax } from frozenAxisRange) it PINS both axes — the box cannot rescale under
// the drawn curve. When ABSENT (null, every current caller) the range is the
// legacy buffer-derived one, byte-identical to pre-P2.
export function drawSubplot(ctx, anchor, width, height, buffer, accessor, title, color, isLast, ghostBuffer = null, fixedRange = null) {
  const box = plotBox(anchor.x, anchor.y, width, height, isLast);
  const { x0, y0, w, h } = box;

  // Y-axis label (sub-plot quantity).
  ctx.fillStyle = SUBPLOT_TITLE_COLOR;
  ctx.font = SUBPLOT_TITLE_FONT;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(title, anchor.x + 4, anchor.y + 1);

  // Plot frame.
  ctx.strokeStyle = AXIS_BOX_COLOR;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.rect(x0, y0, w, h);
  ctx.stroke();

  if (buffer.length < 2 && !fixedRange) {
    // Legacy placeholder (byte-identical): a LIVE buffer with < 2 samples has no
    // derived frame yet, so show "press Play to record" and bail. A FROZEN frame
    // (fixedRange present) does NOT depend on the buffer — its axes + ticks are
    // fully determined by frozenAxisRange — so it falls through below and renders
    // the empty scaled frame (predict-the-graph: the student sketches inside the
    // correctly-scaled box before any real curve exists).
    ctx.fillStyle = PLACEHOLDER_COLOR;
    ctx.font = PLACEHOLDER_FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('press Play to record', x0 + w / 2, y0 + h / 2);
    return;
  }

  // Frame source. A pre-frozen `fixedRange` pins BOTH axes (predict-the-graph);
  // otherwise the legacy buffer-derived range is used (byte-identical default).
  let tMin, tMax, range;
  if (fixedRange) {
    tMin = fixedRange.tMin;
    tMax = fixedRange.tMax;
    range = { min: fixedRange.vMin, max: fixedRange.vMax };
  } else {
    tMin = buffer[0].t;
    tMax = buffer[buffer.length - 1].t;
    range = computeAxisRange(buffer, accessor);
  }
  const tSpan = Math.max(tMax - tMin, AXIS_SPAN_EPS);
  const valSpan = Math.max(range.max - range.min, AXIS_SPAN_EPS);

  // Zero-baseline guide if 0 falls within the y-range.
  if (range.min <= 0 && range.max >= 0) {
    const zeroY = y0 + h - ((0 - range.min) / valSpan) * h;
    ctx.strokeStyle = ZERO_BASELINE_COLOR;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x0, zeroY);
    ctx.lineTo(x0 + w, zeroY);
    ctx.stroke();
  }

  // sim_trace_ghost P2 — faded ghost underlay. When a captured ghost carries a
  // buffer for this quantity (P3 feeds it through buildGraphEntries'
  // ghostBufferMap), stroke its curve FIRST — dashed and low-alpha — so it sits
  // BEHIND the live curve. Shares the live subplot's value range so magnitudes
  // read as comparable; maps the ghost's OWN time span across the plot width so
  // its full shape stays inside the frame. (P3 owns any shared-time-axis
  // refinement.)
  if (Array.isArray(ghostBuffer) && ghostBuffer.length >= 2) {
    const gT0 = ghostBuffer[0].t;
    const gSpan = Math.max(ghostBuffer[ghostBuffer.length - 1].t - gT0, 1e-9);
    ctx.save();
    ctx.globalAlpha = 0.35;
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    let started = false;
    for (const s of ghostBuffer) {
      const v = accessor(s);
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      const { px, py } = forwardPx(s.t, v, gT0, gSpan, range.min, valSpan, box);
      if (!started) { ctx.moveTo(px, py); started = true; }
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
    ctx.restore();
  }

  // Curve. Guarded so a FROZEN empty frame (fixedRange present, buffer < 2)
  // draws no curve but still renders its axis box + ticks below. Every legacy
  // caller reaches here only with buffer.length >= 2 (the placeholder branch
  // above returns otherwise), so this guard is a no-op for them.
  if (buffer.length >= 2) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < buffer.length; i++) {
      const s = buffer[i];
      const v = accessor(s);
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      const { px, py } = forwardPx(s.t, v, tMin, tSpan, range.min, valSpan, box);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }

  // Y-axis range labels (max top, min bottom).
  ctx.fillStyle = TICK_COLOR;
  ctx.font = TICK_FONT;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'top';
  ctx.fillText(formatTick(range.max), x0 - 3, y0 - 1);
  ctx.textBaseline = 'bottom';
  ctx.fillText(formatTick(range.min), x0 - 3, y0 + h + 1);

  // T-axis range labels (left + right under the plot) — only on the
  // bottommost subplot so the others can pack tighter.
  if (isLast) {
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(`t=${tMin.toFixed(1)}`, x0, y0 + h + 2);
    ctx.textAlign = 'right';
    ctx.fillText(`t=${tMax.toFixed(1)}`, x0 + w, y0 + h + 2);
  }
}

// Concise tick-label formatter: integer-friendly for big numbers, two
// decimals for sub-unit values, scientific notation for tiny ones.
function formatTick(v) {
  if (!Number.isFinite(v)) return '?';
  const abs = Math.abs(v);
  if (abs === 0) return '0';
  if (abs >= 100) return v.toFixed(0);
  if (abs >= 10) return v.toFixed(1);
  if (abs >= 0.1) return v.toFixed(2);
  return v.toExponential(1);
}

export const NAME = 'motion_graph';
