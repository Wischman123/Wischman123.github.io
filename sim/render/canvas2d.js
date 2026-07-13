// render/canvas2d.js
//
// Canvas2D scene renderer. Reads engine state (bodies, surfaces, fields)
// and draws them onto a <canvas>. Pure read-only — never mutates engine
// objects. The renderer owns no state beyond camera transform + style;
// re-rendering with a new `loaded` is just `render(loaded)` again.
//
// Coordinate system:
//   World — meters; +x right, +y UP (physics convention).
//   Pixels — Canvas2D default; +x right, +y DOWN.
// World-to-pixel transform flips y. The transform auto-fits the scene
// bounds (bodies + surfaces) plus a margin into the canvas, with equal
// scaling on x and y so circles stay round.
//
// Phase E. Future Phase 2 overlays (FBD, LOL, motion-graph) will wrap
// this renderer rather than replace it.
//
// Phase 2.1 adds the FBD overlay (sim/render/fbd_overlay.js). It is
// drawn AFTER bodies when `showFbd === true` so arrows sit on top of
// the body disks.
//
// Phase 2.2 adds the LOL energy-bar overlay (sim/render/lol_overlay.js).
// Drawn LAST so its top-right panel sits above any FBD that strays
// into that corner. Same render-layer-only contract: zero engine state
// added, zero engine files touched.
//
// Phase 2.3 adds the motion-graph overlay (sim/render/motion_graph.js).
// Drawn after the LOL overlay so its bottom-right panel always wins
// z-order in that corner. Same render-only contract.
//
// View-mode camera control. The renderer carries a `viewMode` flag
// with three values:
//   - 'fit-trajectory' (default) — main.js forward-simulates the full
//     duration at scene load + on Reset, computes the bounding box of
//     every visited body position, and calls fitToBounds(). The
//     camera then STAYS PUT for the entire run — the user sees the
//     full motion path framed in the canvas without any per-frame
//     tracking.
//   - 'fit-on-load' — autoFit on the t=0 state then stays put.
//   - 'follow-selected' — recenter origin on the selected body each
//     frame. Falls back to camera-stays-put when no body is selected.
//
// Wheel-zoom on the canvas (handled in main.js) anchors at the cursor
// via zoomAtPoint() and runs against any view mode. Reset / scene
// load re-applies the active view mode's fit, which overwrites manual
// zoom — that's the explicit reset path.

import { drawFbdOverlay } from './fbd_overlay.js';
import { drawLolOverlay } from './lol_overlay.js';
import { drawMotionGraphOverlay, drawSketchOverlay, sketchPanelAnchor, getBuffer } from './motion_graph.js';
import { drawKineticTheoryOverlay, isKineticTheoryScene, kineticTheoryBox } from './kinetic_theory_overlays.js';
import { isSketchActive, getSketchSession } from './sketch_state.js';
import { drawTraceOverlay } from './trajectory_trace.js';
import { drawFieldOverlay } from './field_overlay.js';
import { drawGhostTrails } from './ghost_store.js';
import { isRenderSuppressed } from './render_suppression.js';
import { arcSweepCanvas, drawnSurfaceGeometry } from './surface_geometry.js';
import { flowMarkerPositions, FLOW_DOT_RADIUS_PX } from './current_flow.js';
import { traceStreamline, drawArrow, drawWorldPolyline, STREAMLINE_EPS, FIELD_GRID_COUNT } from './render_primitives.js';
// Pure world<->pixel viewport math, shared with sim/render/optics_canvas2d.js so
// both renderers map coordinates through ONE convention (no drift). The three
// instance methods below (worldToPx / pxToWorld / fitToBounds) are thin callers.
import { projectWorldToPx, unprojectPxToWorld, computeFitTransform } from './viewport_transform.js';
// Re-export the streamline integrator from its new render_primitives home so
// existing importers (canvas2d_streamlines.test.js) keep resolving it here.
export { traceStreamline } from './render_primitives.js';
// Phase A5: extended-object (line/sheet/ring) suppression + anchor geometry.
// These live in the ENGINE layer (extent is computed there at load); the render
// layer imports DOWN (render→engine is the sanctioned direction).
import { collectSuppressedIds, extentCenter } from '../engine/extended_object_geometry.js';
// sim_buoyancy_fluids P3: iterate emFields() (not fields.values()) in the field
// render loops so a non-EM FluidField (no E_at/B_at) is skipped rather than
// crashing the field-arrow / streamline draw. The fluid stays in the Map for
// BuoyantForce; it is only excluded from EM sampling — the one shared accessor.
import { emFields } from '../engine/fields.js';

// ---- Render themes (k015_worksheet_parity_live_sim_v1 W3) ----------------
// The renderer palette + a few draw-behavior flags, selected ONCE at
// construction (`new Canvas2DRenderer(canvas, theme)`) and read everywhere via
// `this.style`. THEME_DEFAULT is the byte-for-byte-unchanged live look — the
// former module-level `STYLE` const, values verbatim — so any scene booted
// without `&theme=worksheet` renders EXACTLY as before. THEME_WORKSHEET repaints
// ONLY the terrain / ball / velocity / label surface into the printed-worksheet
// visual language (tan hill + ground, red ball + velocity, serif-italic
// labels); it INHERITS every other color unchanged (fields, circuits, and — via
// lol_overlay.js's own locked LOL_COLORS, which this file never touches — the
// energy bars).
//
// Palette provenance — SOURCE CONSTANTS, never sampled pixels (cited file:sym):
//   tan   C8B88A = GRC  tools/claude_tools/diagrams/style.py:GRC  (hill/ground fill)
//   label 2C3E50 = SC   tools/claude_tools/diagrams/style.py:SC   (shape/label color)
//   stroke 555555= SFC  tools/claude_tools/diagrams/style.py:SFC  (surface borders) —
//                       the same '555555' literal problems/units/energy/diagrams/
//                       diagrams_KAP.py strokes the K015 ramp/structure lines with.
//   red   E74C3C = RC   tools/claude_tools/diagrams/style.py:RC — the default fill of
//                       draw_ball (tools/claude_tools/diagrams/blocks.py:draw_ball,
//                       `fill_color=RC`) AND the K015 launch/velocity-arrow color
//                       ('E74C3C' in diagrams_KAP.py); used for BOTH ball + velocity.
//   blue  2980B9 = BLC  tools/claude_tools/diagrams/style.py:BLC — the K015 R-line /
//                       measurement color ('2980B9' in diagrams_KAP.py). It already
//                       equals the default charge_neg/bfield blue, so no override.
//
// v1 RESTRICTION: the worksheet terrain fill is validated ONLY for
// single-convex-arc, K015-shaped scenes (one convex `circular_arc`/`curved` hill
// + flat ground). Multi-arc scenes (e.g. the K020 coaster's several arcs) are
// OUT OF SCOPE for the worksheet theme in v1 — filling each convex arc's FULL
// circle is only geometrically valid for a lone hill dome, not a chain of arcs.
const THEME_DEFAULT = {
  bg:           '#fcfcfd',
  grid:         '#eef0f4',
  gridMajor:    '#dde1ea',
  surface:      '#3b414b',
  ground:       '#e7e2d4',
  particle:     '#2c3e50',
  particleEdge: '#1b262e',
  charge_pos:   '#c0392b',
  charge_neg:   '#2980b9',
  velocity:     '#27ae60',
  rod:          '#3b414b',   // rigid distance constraint — bar, matches surface
  spring:       '#6b7280',   // Spring force — steel-gray coil
  rope:         '#a87b4a',   // Tension force — tan flexible cord
  pivot:        '#3b414b',   // fixed-anchor attachment dot
  efield:       '#c0392b',
  bfield:       '#2980b9',
  bdot:         '#2980b9',
  bx:           '#2980b9',
  induction:    '#b87333',   // A4 — induction-loop conductor (copper wire)
  wire:         '#5a6573',    // A3b — schematic wire + ground rail (neutral slate)
  ckt_sym:      '#334155',    // A3b — element symbol stroke / value label
  ckt_node:     '#2563eb',    // A3b — node-voltage label (blue)
  ckt_curr:     '#b8860b',    // A3b — branch-current label + flow arrow (amber)
  flow_electron:'#1d4ed8',    // T7 — electron-flow marker color (blue, reversed)
  axis:         '#888',
  // Body/glyph label — today's EXACT values (default look unchanged).
  labelColor:   '#444',
  labelFont:    '11px system-ui, sans-serif',
  // Terrain-fill behavior. Default = stroke-only (both flags off = no change).
  fillConvexArc: false,       // fill a convex circular_arc's full circle (tan)
  fillFlatBand:  false,       // fill a tan band below a flat surface
  terrainFill:   '#c8b88a',   // GRC tan — inert while both flags are false
  // Worksheet annotation layer (k015_worksheet_parity_live_sim_v1 W4). The flag
  // is the whole "worksheet-only" decision — drawAnnotations early-returns when
  // it is false, so the sim's own default look draws ZERO annotations (the
  // anti-target, asserted as a positive condition in the renderer tests). The
  // colors/fonts live here (inert while the flag is off, like terrainFill) and
  // are SOURCE CONSTANTS from tools/claude_tools/diagrams/style.py:
  //   annLabelColor 2C3E50 = SC  (bold-serif position labels A / B; also v₀ = 0)
  //   annMeasure    333333 = DC  ("default dark line/text" — the h measure line
  //                               + its T-ticks read as near-black)
  //   annRadius     2980B9 = BLC (the dashed R construction line — the same K015
  //                               measurement blue as diagrams_KAP.py)
  annotationLayer: false,     // draw the worksheet annotation layer (OFF by default)
  annLabelFont:  'bold 14px "Times New Roman", Times, serif', // A / B — bold serif
  annLabelColor: '#2c3e50',   // SC  — position-label + v₀ text color
  annMeasure:    '#333333',   // DC  — h measure line + T-ticks (near-black)
  annRadius:     '#2980b9'    // BLC — dashed R radius line
};

const THEME_WORKSHEET = {
  ...THEME_DEFAULT,
  // Printed-worksheet visual language (source constants documented above).
  surface:   '#555555',                 // SFC — ramp / hill / ground outline stroke
  particle:  '#e74c3c',                 // RC — ball red
  velocity:  '#e74c3c',                 // RC — velocity-arrow red
  labelColor:'#2c3e50',                 // SC — label color
  labelFont: 'italic 11px "Times New Roman", Times, serif',
  fillConvexArc: true,
  fillFlatBand:  true,
  terrainFill:   '#c8b88a',             // GRC — tan hill dome + ground band
  annotationLayer: true                 // W4 — the worksheet annotation layer draws
};

const BODY_RADIUS_PX = 10;       // visual size; world size is mass-agnostic
const VELOCITY_SCALE_PX_PER_M_PER_S = 4;
// Worksheet annotation layer (k015_worksheet_parity_live_sim_v1 W4). Pixel
// constants for the static A/B labels, h/R measure lines, and v₀ = 0 text.
const ANN_LABEL_OFFSET_PX = 14;  // A/B/v₀ text offset from its world anchor (clears the 10px ball)
const ANN_TICK_HALF_PX = 5;      // T-tick cap half-length, ⊥ the measure line
const ANN_MEASURE_WIDTH_PX = 1.5;// measure/radius line stroke width
const ANN_LABEL_PAD_PX = 4;      // gap between a line's label and the line
const ANN_DASH = [6, 4];         // R radius-line dash pattern (construction line)
// FIELD_GRID_COUNT now single-sourced in ./render_primitives.js (imported
// above) so the arrow grid and the F1 overlay share one gridSpacing/rClip.
const FIELD_E_PX_PER_V_PER_M = 1.5;
// Phase 3.5 (Q7=D.1): in-plane B-arrow rendering. Pixels-per-Tesla
// scale chosen so a 1 T in-plane field renders as a comfortable
// canvas arrow at default zoom. Adjust if scenes with very weak or
// very strong in-plane B saturate the canvas.
const FIELD_B_PX_PER_T = 30;
const FIELD_B_TOKEN_RADIUS_PX = 4;
// Phase C1: a current_wire's azimuthal B is microtesla-scale, so absolute
// Tesla→px scaling renders sub-pixel (invisible) arrows. When the STRONGEST
// in-plane arrow in view would fall below this floor, drawFields switches
// that field's grid to an autoscale that shows DIRECTION + relative strength
// and paints a "not to scale" disclaimer. 6px ≈ 1.5× the 4px arrowhead —
// anything shorter reads as a dot, not an arrow. Fields ≥ ~0.2 T keep the
// absolute scale unchanged (existing scenes render byte-identically).
const B_ARROW_VISIBLE_FLOOR_PX = 6;
// Target length (px) of the strongest arrow in autoscale mode — the visual
// weight of a 1 T absolute-scale arrow. Grid spacing is ~0.106×canvasWidth
// (zoom-invariant) ≫ this, so autoscaled arrows never overlap neighbors.
const B_ARROW_AUTOSCALE_MAX_PX = 30;

// A6 — E/B field-line streamlines. A streamline follows the IN-PLANE field
// direction (F.x, F.y) only — the smooth-flow complement to the drawFields
// arrow grid. Scale constants mirror the FIELD_*_PX_PER_* precedent above; the
// per-field-type seeding rule (calculate-never-guess) is derived in
// docs/physics_briefs/a6_streamlines_brief.md §4.
const STREAMLINE_STEPS_ACROSS = 60;   // steps for a line to cross the view once
const STREAMLINE_MAX_STEPS = 240;     // hard cap on polyline length (~4× view)
// STREAMLINE_EPS now lives in ./render_primitives.js (single source; imported
// above for streamlineSeeds' use). Real in-view magnitudes are ≫ this
// (radial E ~10²–10³ V/m; uniform B ~1 T), so a legitimate line is never cut
// short, while a genuine zero-line / zero-crossing stops AT it.
const STREAMLINE_MIN_LINES = 4;       // floor so a weak field still reads
const STREAMLINE_MAX_LINES = 24;      // ceiling so a strong field doesn't saturate
const UNIFORM_E_LINES_PER_V_PER_M = 1.2;  // |E|=10 ⇒ 12 lines (charge_in_uniform_field)
const UNIFORM_B_LINES_PER_T = 8;          // |B|=1  ⇒ 8 lines (compass_needle in-plane B)
const RADIAL_LINES_PER_COULOMB = 1.2e7;   // |q|=1e-6 C ⇒ 12 rays (test_charge_orbit)
const LINEAR_GRADIENT_LINE_COUNT = 9;     // parallel lines ∥ axis (matches FIELD_GRID_COUNT)
const RADIAL_SEED_RADIUS_FRAC = 0.04;     // r₀ as a fraction of the view extent
const STREAMLINE_ALPHA = 0.5;             // translucent so the arrow grid stays legible

// Phase A2 — Gauss-surface render. A Gaussian surface is a MATHEMATICAL
// construct, so its outline is DASHED (distinct from physical `surfaces`,
// which are solid). The interior is sign-shaded by enclosed electric flux
// (warm = net +q enclosed, cool = net −q) at a FIXED translucent alpha:
// there is no natural maximum flux to normalize an intensity against, so
// magnitude is conveyed numerically (label + A1 inspector), not by opacity.
const GAUSS_FILL_ALPHA = 0.13;
const GAUSS_OUTLINE_ALPHA = 0.9;
const GAUSS_DASH = [6, 4];
// Below this |Φ_E| the net enclosed flux is treated as exactly zero
// (neutral shade, "0" label). Guards a charge-cancellation surface whose
// flux is FP-near-zero (~1e-13 V·m noise) from rendering a faint warm/cool
// tint + scientific-notation label. Any real single-charge flux here is
// O(100) V·m, so 1e-9 cleanly separates signal from FP noise.
const FLUX_ZERO_EPS = 1e-9; // V·m
// A4 — below this |EMF| (volts) the induced current is treated as zero (no
// circulation arrow). Same 1e-9 magnitude as FLUX_ZERO_EPS but a distinct
// unit (V, not V·m); shipped induction EMFs are 0 or ~1–2 V, far above it.
const EMF_ZERO_EPS = 1e-9; // V

// Phase A3b — circuit-schematic auto-layout. Circuit scenes carry a bare
// netlist (node names + from/to, NO coordinates), so positions are COMPUTED
// from the topology here (calculate-not-guess; see
// docs/physics_briefs/sim_a3b_circuit_render_brief.md §2). World-metre constants:
const CKT_COL_DX = 2.5;       // x-spacing between adjacent top-row node columns
const CKT_TOP_Y = 1.5;        // y of the top node row (rail at 0, pre-shift)
const CKT_RAIL_Y = 0;         // y of the ground rail (pre-shift)
const CKT_BRANCH_DX = 0.8;    // ⊥ offset between parallel verticals in one column
const CKT_BRANCH_DY = 0.8;    // ⊥ offset between parallel horizontals on one pair
const CKT_RAIL_MARGIN = 0.8;  // rail overhang past the outermost vertical branch
const CKT_SYM_HALF = 0.45;    // symbol half-length along the branch line
const CKT_LABEL_PAD = 0.6;    // bounds pad for V/I/value labels
const CKT_GAP = 1.0;          // vertical clearance between physical scene + schematic
const CKT_AMP = 0.2;          // symbol ⊥ amplitude (zigzag teeth / inductor humps)
const CKT_SRC_R = 0.32;       // current-source circle radius
const CKT_BATT_GAP = 0.10;        // half-gap between battery plates (inter-plate gap 0.20)
const CKT_BATT_LONG_HALF = 0.30;  // battery + plate (long, thin) half-height
const CKT_BATT_SHORT_HALF = 0.15; // battery − plate (short, thick) half-height
const CKT_BATT_THICK = 3.0;       // battery − plate stroke px (+ plate keeps the 1.75 default)
const CKT_PLATE_HALF = 0.28;  // capacitor plate half-height
const CKT_PLATE_GAP = 0.13;   // half-distance between the two capacitor plates
const CKT_ARROW_OFFSET = 0.42;// ⊥ offset of the current-flow arrow from the symbol
const CKT_ARROW_HALF = 0.28;  // half-length of the current-flow arrow shaft
const CKT_FAN_LABEL_STAGGER = 0.5; // along-axis lift of a fanned vertical branch's
                              // value label so it clears the current-label band
                              // in the narrow inter-sibling gap (network n3 column)
// Below this |i_branch| (A) the current is treated as zero: no flow arrow, a
// neutral "i = 0 A" label. Guards Math.sign(0)=0 → degenerate arrowhead (A3b
// review F-E) and the pre-first-solve / decayed-to-zero (rl) cases.
const CKT_I_ZERO_EPS = 1e-9;  // A

// DEF-1 — coupled-circuit-scene inset panel. A "coupled" scene carries BOTH a
// circuit netlist AND real physical content (an induction loop / surface / a
// non-placeholder body). The wide schematic (~5 m in layout units) must NOT
// share the metric auto-fit with the small physical scene (a 0.5 m loop+rod),
// or the fit zooms out to frame the schematic and collapses the loop+rod to a
// few px (the DEF-1 "tiny disconnected box"). So in a coupled scene the
// schematic is routed to its OWN pixel inset panel on the right, and the metric
// auto-fit reserves CIRCUIT_INSET_FRAC of the frame for it (sceneBounds pads
// maxX) — the physical scene fits the left portion at full size, the inset
// fills the reserved right band. Pure-circuit scenes are unaffected (the
// schematic IS the scene; it keeps the in-world render + full-canvas fit).
const CIRCUIT_INSET_FRAC = 0.4;     // share of the frame reserved for the inset
const CKT_PANEL_MARGIN_PX = 14;     // inset's inset from the canvas edges (px)
const CKT_PANEL_GAP_PX = 12;        // gap between physical content and the inset (px)
const CKT_PANEL_TITLE_PX = 20;      // headroom for the inset title bar (px)
const CKT_PANEL_MIN_W_PX = 200;     // floor width so a narrow band still reads
const CKT_PANEL_FIT_MARGIN = 0.08;  // fractional margin fitting the layout into the inset
const CKT_PANEL_BG = 'rgba(252, 252, 253, 0.93)';
const CKT_PANEL_BORDER = '#dde0e7';
const CKT_PANEL_TITLE_COLOR = '#5b6472';

// ----- Sim-interactivity T4: per-body shape rendering --------------------
// `body.renderShape` (render-only passthrough; see bodies.js) lets a body
// draw as something other than the default 10px disk. The geometry below is
// PURE (unit-tested in canvas2d_shape.test.js — calculate-never-guess) and
// the dispatch is a registry keyed by shape kind, so a future shape (A5:
// line/sheet/ring/sphere) registers as ONE entry instead of a new if-branch.

// World-space endpoints of an oriented rod: centre `position`, total length
// `lengthM`, long axis `angleRad` CCW from +x̂. Returns the two tip ends in
// world metres; the renderer maps each through worldToPx (handling y-flip /
// zoom / pan). angleRad = π/2 → a vertical rod (bar on horizontal rails).
export function rodEndpointsWorld(position, lengthM, angleRad = 0) {
  const half = lengthM / 2;
  const dx = half * Math.cos(angleRad);
  const dy = half * Math.sin(angleRad);
  return {
    a: { x: position.x - dx, y: position.y - dy },
    b: { x: position.x + dx, y: position.y + dy }
  };
}

// ----- A6: field-line streamlines (pure) ---------------------------------
// Pure, unit-tested (canvas2d_streamlines.test.js) so the physics/geometry is
// calculated, never eyeballed. `traceStreamline` walks the polyline;
// `streamlineSeeds` decides where lines start per field type. The render leg
// (drawStreamlines) only maps their world output through worldToPx.

// traceStreamline moved to ./render_primitives.js (roadmap F1 P2 cycle break;
// imported + re-exported above). Its two termination guards (a: sampleDir
// throws; b1: |field| < eps; b2: direction reversal) are documented there.

function clampLineCount(n) {
  if (!Number.isFinite(n)) return STREAMLINE_MIN_LINES;
  return Math.max(STREAMLINE_MIN_LINES, Math.min(STREAMLINE_MAX_LINES, Math.round(n)));
}

// Uniform / time-varying-uniform seeds: |F| is spatially constant, so seed N
// parallel lines (N ∝ |F|) on a row ⊥ to F at the UPSTREAM edge, each tracing
// downstream across the view → spacing ∝ 1/|F|. Returns [] when the in-plane
// component is zero (e.g. a z-only B field — that renders as ⊙/⊗ tokens, not
// lines). For time_varying the caller primes setTime(t) before this runs.
function uniformStreamlineSeeds(field, channel, cx, cy, extent) {
  let v;
  try {
    v = channel === 'E' ? field.E_at({ x: cx, y: cy }) : field.B_at({ x: cx, y: cy });
  } catch {
    return [];
  }
  const mag = Math.hypot(v.x, v.y);
  if (!(mag >= STREAMLINE_EPS)) return [];       // no in-plane component
  const perUnit = channel === 'E' ? UNIFORM_E_LINES_PER_V_PER_M : UNIFORM_B_LINES_PER_T;
  const n = clampLineCount(perUnit * mag);
  const ux = v.x / mag, uy = v.y / mag;          // unit field direction
  const px = -uy, py = ux;                        // unit perpendicular
  const seeds = [];
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : i / (n - 1) - 0.5;    // -0.5 .. 0.5 across the row
    seeds.push({
      x: cx + px * t * extent - ux * extent / 2,  // upstream by half a view
      y: cy + py * t * extent - uy * extent / 2
    });
  }
  return seeds;
}

// Radial-E seeds: Gauss's-law convention — line count ∝ enclosed |charge|. N
// rays at equal angular spacing about `center`, seeded at a small radius r₀.
// The integrator follows E_at, which aims outward for +Q (rays leave) and
// inward for −Q (rays walk to center → singularity guard terminates cleanly).
function radialStreamlineSeeds(field, extent) {
  const q = Math.abs(field.charge_C);
  if (!(q > 0)) return [];
  const n = clampLineCount(RADIAL_LINES_PER_COULOMB * q);
  const r0 = extent * RADIAL_SEED_RADIUS_FRAC;
  const seeds = [];
  for (let i = 0; i < n; i++) {
    const theta = (2 * Math.PI * i) / n;
    seeds.push({
      x: field.center.x + r0 * Math.cos(theta),
      y: field.center.y + r0 * Math.sin(theta)
    });
  }
  return seeds;
}

// Linear-gradient-B seeds: the field is one-axial (B ∥ x or ∥ y). Seed a fixed
// row of parallel lines ⊥ to the axis at the upstream edge; each traces along
// the axis and TERMINATES where B_0 + g·coord → 0 (the ε guard) — that
// termination is how magnitude-crowding reads for a gradient field.
function axialStreamlineSeeds(field, bounds, cx, cy) {
  const n = LINEAR_GRADIENT_LINE_COUNT;
  let sample;
  try {
    sample = field.B_at({ x: cx, y: cy });
  } catch {
    return [];
  }
  const seeds = [];
  if (field.direction === 'x') {
    const span = bounds.top - bounds.bot;
    const startX = sample.x >= 0 ? bounds.left : bounds.right;    // upstream edge
    for (let i = 0; i < n; i++) {
      const t = n === 1 ? 0.5 : i / (n - 1);
      seeds.push({ x: startX, y: bounds.bot + t * span });
    }
  } else {
    const span = bounds.right - bounds.left;
    const startY = sample.y >= 0 ? bounds.bot : bounds.top;
    for (let i = 0; i < n; i++) {
      const t = n === 1 ? 0.5 : i / (n - 1);
      seeds.push({ x: bounds.left + t * span, y: startY });
    }
  }
  return seeds;
}

// Per-field-type streamline seeding (brief §4). Returns world-coord seed sites
// for the given channel ('E' | 'B'); [] when that channel has no in-plane field
// to trace (dipole is pure-ẑ B + zero E → [] for both — brief §3). `bounds` =
// the view world-rect {left,right,bot,top} (as drawFields computes at :567).
export function streamlineSeeds(field, channel, bounds) {
  const cx = (bounds.left + bounds.right) / 2;
  const cy = (bounds.bot + bounds.top) / 2;
  const extent = Math.max(bounds.right - bounds.left, bounds.top - bounds.bot);
  switch (field.type) {
    case 'radial':
      return channel === 'E' ? radialStreamlineSeeds(field, extent) : [];
    case 'uniform':
      return uniformStreamlineSeeds(field, channel, cx, cy, extent);
    case 'time_varying_uniform':
      return channel === 'B'
        ? uniformStreamlineSeeds(field, channel, cx, cy, extent)
        : [];
    case 'linear_gradient':
      return channel === 'B' ? axialStreamlineSeeds(field, bounds, cx, cy) : [];
    case 'dipole':
    default:
      return [];   // dipole: pure-ẑ B (⊙/⊗ tokens) + zero E → no in-plane lines
  }
}

// Shape-dispatch registry — UNIFIED contract `drawer(renderer, geom, pxAnchor)`
// (Phase A5 Step 0). `geom` is polymorphic by kind:
//   - `rod`               → geom is a BODY (single moving body; endpoints are
//                           recomputed each frame from its live position).
//   - `line`/`sheet`/`ring` → geom is a RENDER-GROUP entry (a cloud of N pinned
//                           charges; its world `extent` was computed ONCE at
//                           load — the drawer only maps that extent through
//                           worldToPx, never recomputing from member positions).
// Each drawer paints the GLYPH and returns the label-anchor {x,y[,baseline]}.
// For a `rod` body, drawBodies draws the shared velocity/orientation overlays
// AFTER the glyph; the extended kinds are drawn by drawExtendedObjects (their
// member bodies are suppressed from drawBodies entirely). Add a kind here to
// teach every scene the new shape — ONE entry, never an if-chain.
const SHAPE_DRAWERS = {
  rod: (r, geom, p) => r._drawRodBody(geom, p),
  line: (r, geom, p) => r._drawExtendedLine(geom, p),
  sheet: (r, geom, p) => r._drawExtendedSheet(geom, p),
  ring: (r, geom, p) => r._drawExtendedRing(geom, p)
};

// The decision site, isolated for direct unit testing: resolve a shape kind
// to its drawer, or null for absent/unknown (→ default disk). Negative case
// (unknown kind → null) is the regression this guards.
export function shapeDrawerFor(kind) {
  return (kind && SHAPE_DRAWERS[kind]) || null;
}

// ----- Sim-interactivity T5: sliding-rail (rod-on-rails magnetic brake) -----
// A rail-brake induction loop draws NOT as its declared static rectangle (which
// would detach from the rod once it slides metres away) but as two horizontal
// RAILS at the conducting rod's endpoint y's, closed at the resistor (left) end,
// with the rod (its T4 render_shape) sliding along them so the enclosed
// rod–rails–resistor area visibly GROWS — matching the motional-EMF physics.
// The trigger is an explicit render-layer hint (`loop.render.kind ===
// 'sliding_rail''`), NEVER the physics `rl_branch` block (scene.js render-layer
// rule: rendering reads state, never branches on a state-shape schema attr).
// All geometry is PURE + unit-tested (calculate-never-guess).

const RAIL_RESISTOR_TEETH = 6;      // zigzag segment count of the resistor symbol
const RAIL_RESISTOR_AMP_M = 0.06;   // world-m ⊥ amplitude of the zigzag teeth

// The resistor symbol: a vertical N-tooth zigzag closing the two rails at the
// left (x) end, running from the lower rail (y0) to the upper rail (y1). Teeth
// alternate ±amplitude in x̂. Endpoints land EXACTLY on the rails so the symbol
// reads as a continuous conductor. Returns a polyline of world vertices.
function resistorZigzag(x, y0, y1) {
  const pts = [{ x, y: y0 }];
  const dy = (y1 - y0) / RAIL_RESISTOR_TEETH;
  for (let i = 1; i < RAIL_RESISTOR_TEETH; i++) {
    const sign = i % 2 === 1 ? 1 : -1;
    pts.push({ x: x + sign * RAIL_RESISTOR_AMP_M, y: y0 + i * dy });
  }
  pts.push({ x, y: y1 });
  return pts;
}

// Pure sliding-rail geometry (unit-tested — calculate-never-guess). Inputs:
//   loop    — the induction loop; its center/width fix the closed (resistor)
//             end x0 = center.x − width/2, and its `render.rail_length_m` fixes
//             the rail span.
//   rodEnds — {a, b} world endpoints of the conducting rod (from
//             rodEndpointsWorld); their y's set the rail separation. Because the
//             rod is ⊥ to its motion, the y's are motion-invariant, so the rails
//             stay put while the rod slides along them (they never detach).
// Returns world-metre geometry: the two rail y's, the rail x-span [x0, x1], and
// the resistor zigzag polyline.
export function railGeometry(loop, rodEnds) {
  const y_top = Math.max(rodEnds.a.y, rodEnds.b.y);
  const y_bottom = Math.min(rodEnds.a.y, rodEnds.b.y);
  const halfW = (loop.width ?? 0) / 2;
  const x0 = loop.center.x - halfW;                 // closed / resistor end
  const x1 = x0 + (loop.render?.rail_length_m ?? 0); // far (open) end
  return { y_top, y_bottom, x0, x1, resistor: resistorZigzag(x0, y_bottom, y_top) };
}

// Resolve a sliding-rail loop's decorative geometry from the live scene: find
// its moving rod body, take the rod's world endpoints, hand off to railGeometry.
// Returns null when the loop is not a sliding_rail, or its rod body / rod
// render_shape is missing (so both the draw path and the camera-bounds path fail
// closed instead of throwing). Single owner of "loop → rail geometry" so the
// draw and the camera fit can never disagree on where the rails are.
export function slidingRailGeometryForLoop(loaded, loop) {
  if (!loop || loop.render?.kind !== 'sliding_rail') return null;
  const bodyId = loop.moving_segment?.body_id;
  if (!bodyId) return null;
  const body = (loaded?.bodies ?? []).find((b) => b.id === bodyId);
  const rs = body?.renderShape;
  if (!rs || rs.kind !== 'rod') return null;
  const ends = rodEndpointsWorld(body.position, rs.length_m, rs.angle_rad ?? 0);
  return railGeometry(loop, ends);
}

// Connector render registry — the SINGLE source of truth for which engine
// connector classes drawConnectors() draws, plus the scene.schema.json `type`
// each maps to. drawConnectors() iterates this instead of the old inline
// constructor.name literals, and schema_browser_lockstep.test.js reads the
// derived DRAWN_* sets below to gate the previously-SILENT render-drift seam:
// a two-body constraint (or connector force) with an engine primitive but no
// render branch used to draw as floating masses with no rope/pulley/coil, the
// plan's "invisible engine capacity" anti-target — caught before only by manual
// per-scene PNG review. Now adding a connector is ONE registry entry (draw fn +
// type + source) so dispatch and the CI gate can never drift apart.
//   className — engine constructor.name probed at render time (decoupled from
//               the engine module, matching drawImplicitGround).
//   type      — the scene.schema.json constraint/force type string.
//   source    — which loaded array the object lives in ('constraints'|'forces').
//   draw      — (renderer, obj, bodyById, loaded) => void; bespoke per-connector
//               geometry. Body endpoints go through renderer.bodyAnchorPx(body,
//               loaded), NOT worldToPx(body.position): a body resting on a surface
//               is drawn lifted by one glyph radius (F2), so a connector anchored
//               to the raw position would dangle a radius clear of the glyph it
//               attaches to. `loaded` is threaded through for exactly that.
const CONNECTOR_RENDER_ENTRIES = [
  {
    className: 'RodConstraint', type: 'rod', source: 'constraints',
    draw(self, c, bodyById, loaded) {
      if (!c.anchor) return;
      const body = bodyById.get(c.body_id);
      if (!body) return;
      self.drawRod(self.worldToPx(c.anchor), self.bodyAnchorPx(body, loaded));
    }
  },
  {
    // Two-body string over a pulley (Atwood — StringConstraint). Unlike a rod
    // (anchor → body), the rope bends OVER the pulley: two segments
    // body_a → pulley → body_b, plus a pulley marker at `.pulley`.
    className: 'StringConstraint', type: 'string', source: 'constraints',
    draw(self, c, bodyById, loaded) {
      if (!c.pulley) return;
      const pulleyPx = self.worldToPx(c.pulley);
      const bodyA = bodyById.get(c.body_a);
      const bodyB = bodyById.get(c.body_b);
      if (bodyA) self.drawRope(pulleyPx, self.bodyAnchorPx(bodyA, loaded));
      if (bodyB) self.drawRope(pulleyPx, self.bodyAnchorPx(bodyB, loaded));
      self.drawPulley(pulleyPx);
    }
  },
  {
    // Two-body RIGID rod (double pendulum bob↔bob — BodyRodConstraint). Unlike
    // the anchor rod (anchor → body) or the string (rope bent over a pulley),
    // the bar runs directly body_a ↔ body_b, drawn with the same rigid-rod
    // primitive as the anchor rod.
    className: 'BodyRodConstraint', type: 'body_rod', source: 'constraints',
    draw(self, c, bodyById, loaded) {
      const bodyA = bodyById.get(c.body_a);
      const bodyB = bodyById.get(c.body_b);
      if (!bodyA || !bodyB) return;
      self.drawRod(self.bodyAnchorPx(bodyA, loaded), self.bodyAnchorPx(bodyB, loaded));
    }
  },
  {
    // Two-body coupling spring (coupled oscillator — BodySpring). No anchor: the
    // coil runs directly body_a ↔ body_b (the two ids in applies_to).
    className: 'BodySpring', type: 'body_spring', source: 'forces',
    draw(self, f, bodyById, loaded) {
      if (!Array.isArray(f.applies_to)) return;
      const bodyA = bodyById.get(f.applies_to[0]);
      const bodyB = bodyById.get(f.applies_to[1]);
      if (!bodyA || !bodyB) return;
      self.drawSpringCoil(self.bodyAnchorPx(bodyA, loaded), self.bodyAnchorPx(bodyB, loaded));
    }
  },
  {
    // Anchored spring force — anchor → body + pivot dot.
    //
    // F3: the glyph is chosen by the connector's PHYSICAL ROLE, declared on the
    // scene (`glyph: 'coil' | 'cord'`), not by its force type. A bungee cord is a
    // Hooke-law spring force — the engine is right to model it as one — but the
    // renderer drew every spring as a steel zig-zag coil, so C001's bungee jumper
    // hung from a coil spring. Brendan: "there's no spring in this problem."
    // Scenes that say nothing keep the coil, so every existing scene is unchanged.
    className: 'Spring', type: 'spring', source: 'forces',
    draw(self, f, bodyById, loaded) {
      if (!f.anchor || !Array.isArray(f.applies_to)) return;
      const aPx = self.worldToPx(f.anchor);
      const drawStrand = f.glyph === 'cord'
        ? (a, b) => self.drawRope(a, b)
        : (a, b) => self.drawSpringCoil(a, b);
      for (const id of f.applies_to) {
        const body = bodyById.get(id);
        if (!body) continue;
        drawStrand(aPx, self.bodyAnchorPx(body, loaded));
        self.drawPivot(aPx);
      }
    }
  },
  {
    // Tension force — flexible rope line anchor → body + pivot dot.
    className: 'Tension', type: 'tension', source: 'forces',
    draw(self, f, bodyById, loaded) {
      if (!f.anchor || !Array.isArray(f.applies_to)) return;
      const aPx = self.worldToPx(f.anchor);
      for (const id of f.applies_to) {
        const body = bodyById.get(id);
        if (!body) continue;
        self.drawRope(aPx, self.bodyAnchorPx(body, loaded));
        self.drawPivot(aPx);
      }
    }
  }
];

// Schema constraint types the renderer draws a connector for. EVERY constraint
// type is connector-class (rod → bar, string → rope+pulley), so the lockstep
// test asserts the FULL scene.schema.json constraint enum ⊆ this set — a new
// constraint type with no render branch fails CI instead of silently drawing as
// floating masses.
export const DRAWN_CONSTRAINT_TYPES = new Set(
  CONNECTOR_RENDER_ENTRIES.filter((e) => e.source === 'constraints').map((e) => e.type)
);
// Schema FORCE types that draw a connector — a strict SUBSET of the force enum
// (most forces: gravity, drag, friction, lorentz… draw no connector). The
// lockstep test asserts body_spring ∈ this set (the phase's new two-body force
// must render) and this set ⊆ the force enum (no render branch for a
// nonexistent force type).
export const DRAWN_CONNECTOR_FORCE_TYPES = new Set(
  CONNECTOR_RENDER_ENTRIES.filter((e) => e.source === 'forces').map((e) => e.type)
);

export class Canvas2DRenderer {
  constructor(canvas, theme = 'default') {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    // Render theme — the ONE indirection the worksheet parity rests on. Every
    // draw method reads `this.style.<key>`; the object is chosen here and never
    // mutated, so themes cannot fork the draw functions. Unknown / absent theme
    // coerces to the default look (the boot resolver only ever passes
    // 'worksheet' | 'default', but the coercion keeps a typo from wedging it).
    this.style = theme === 'worksheet' ? THEME_WORKSHEET : THEME_DEFAULT;
    // Transform: pixel = (world - origin) * scale + offset
    // The y-axis is flipped at draw time.
    this.scale = 50;     // pixels per meter (set by autoFit)
    this.originX = 0;    // world coords at pixel center
    this.originY = 0;
    this.devicePixelRatio = window.devicePixelRatio || 1;
    // Phase 2.1 / 2.2 / 2.3: per-overlay toggles. Default OFF — teachers
    // turn them on for instruction. Session-only (no localStorage, no
    // scene JSON).
    this.showFbd = false;
    this.showLol = false;
    this.showGraphs = false;
    // sim_trace_ghost P1 — persistent trajectory-trace overlay toggle.
    // Default OFF, session-only (mirrors showGraphs). When ON, render()
    // strokes each traceable body's fading breadcrumb trail.
    this.showTrace = false;
    // roadmap F1 (sim_equipotential_overlay) — student Field/V discovery
    // overlay toggle. Default OFF, session-only, NEVER auto-shown. When ON,
    // render() draws the superposed field lines + equipotential contours +
    // vector field (and suppresses the per-field streamlines for that frame).
    this.showFieldOverlay = false;
    // T7 — current-flow display convention: 'conventional' (amber, +I
    // direction, default) or 'electron' (blue, reversed). Presentation-only —
    // it changes only the flow-marker drift + color, never any plotted current
    // value. Session-only (no localStorage, no scene JSON).
    this.currentConvention = 'conventional';
    // Inspector-selected body id, used by the motion-graph overlay to
    // pick which body's curves to plot, and by `follow-selected` view
    // mode to pick the centered body. Falls back to first body / no-op
    // respectively when null. Updated externally via setSelectedBodyId().
    this.selectedBodyId = null;
    // View mode. 'fit-trajectory' (default) is one-shot — main.js
    // forward-simulates the scene to its full duration, computes the
    // bounding box of every visited body position, and the renderer
    // sets the camera to fit that box. The camera then STAYS PUT
    // regardless of where the bodies move; the user sees the full
    // motion path framed in the canvas.
    //
    // 'fit-on-load' fits only the t=0 state then stays put.
    // 'follow-selected' recenters on the inspector-selected body each
    // frame.
    this.viewMode = 'fit-trajectory';
    this.resize();
  }

  setFbdEnabled(enabled) {
    this.showFbd = !!enabled;
  }

  setLolEnabled(enabled) {
    this.showLol = !!enabled;
  }

  setGraphsEnabled(enabled) {
    this.showGraphs = !!enabled;
  }

  setTraceEnabled(enabled) {
    this.showTrace = !!enabled;
  }

  // roadmap F1 — enable/disable the student Field/V overlay. render() reads
  // this.showFieldOverlay at frame start. main.js wires the toolbar toggle here.
  setFieldOverlayEnabled(enabled) {
    this.showFieldOverlay = !!enabled;
  }

  // T7 — 'conventional' | 'electron'. Any other value falls back to
  // conventional (the amber, +I-direction default).
  setCurrentConvention(mode) {
    this.currentConvention = mode === 'electron' ? 'electron' : 'conventional';
  }

  setSelectedBodyId(bodyId) {
    this.selectedBodyId = bodyId ?? null;
  }

  // Accepts 'fit-trajectory' | 'fit-on-load' | 'follow-selected'.
  // Unknown values are coerced to the default so a typo on the
  // toolbar cannot wedge the camera.
  setViewMode(mode) {
    const allowed = ['fit-trajectory', 'fit-on-load', 'follow-selected'];
    this.viewMode = allowed.includes(mode) ? mode : 'fit-trajectory';
  }

  // Per-frame camera update for view modes that track. Called from
  // render() before drawing. 'fit-trajectory' and 'fit-on-load' are
  // one-shot — main.js sets the camera at scene load / reset and the
  // renderer leaves it alone here. Only 'follow-selected' updates
  // every frame.
  applyViewMode(loaded) {
    if (!loaded) return;
    if (this.viewMode === 'follow-selected') {
      if (!this.selectedBodyId) return;
      const body = (loaded.bodies ?? []).find((b) => b.id === this.selectedBodyId);
      if (!body) return;
      this.originX = body.position.x;
      this.originY = body.position.y;
    }
  }

  // Set the camera transform to fit the supplied world-space bounding
  // box (with a 10% margin) into the current canvas. Used by main.js
  // for both the t=0 autoFit and the trajectory-probe fit.
  fitToBounds(bounds) {
    // Delegate the arithmetic to the shared, pure computeFitTransform. A null
    // return (non-finite extent) leaves the transform unchanged — identical to
    // the former inline early return.
    const t = computeFitTransform(bounds, this.cssWidth, this.cssHeight);
    if (!t) return;
    this.scale = t.scale;
    this.originX = t.originX;
    this.originY = t.originY;
  }

  // Multiply zoom by `factor`, anchored at pixel `aboutPx` so the
  // world coordinate under that pixel does not move. `factor > 1`
  // zooms in. Called by the wheel handler in main.js and by the +/-
  // toolbar buttons (which pass canvas center as the anchor).
  zoomAtPoint(factor, aboutPx) {
    const f = Math.max(0.01, factor);
    const before = this.pxToWorld(aboutPx);
    this.scale *= f;
    // Solve worldToPx(before) === aboutPx for the new origin.
    this.originX = before.x - (aboutPx.x - this.cssWidth / 2) / this.scale;
    this.originY = before.y - (this.cssHeight / 2 - aboutPx.y) / this.scale;
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = this.devicePixelRatio;
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.cssWidth = rect.width;
    this.cssHeight = rect.height;
  }

  // Compute scene bounds (world coords) and set transform so they fit
  // with a 10% margin. Call once after loading a new scene.
  autoFit(loaded) {
    this.fitToBounds(sceneBounds(loaded));
  }

  // Thin callers of the shared viewport transform. `this` carries the five
  // transform fields (scale, originX, originY, cssWidth, cssHeight), so it is a
  // valid `view` for projectWorldToPx / unprojectPxToWorld.
  worldToPx(p) {
    return projectWorldToPx(this, p);
  }

  pxToWorld(p) {
    return unprojectPxToWorld(this, p);
  }

  render(loaded, simTime = 0) {
    const ctx = this.ctx;
    // Phase 2.4 — update camera before any drawing so the grid + axis
    // lines reflect the active view-mode transform.
    this.applyViewMode(loaded);
    ctx.fillStyle = this.style.bg;
    ctx.fillRect(0, 0, this.cssWidth, this.cssHeight);
    this.drawGrid();
    if (loaded) {
      this.drawImplicitGround(loaded);
      this.drawFields(loaded);
      // A6 — field-line streamlines, drawn over the arrow grid (translucent,
      // so both read). No-op on fieldless / z-only-field scenes.
      // roadmap F1 (sim_equipotential_overlay P4): when the student's Field/V
      // overlay is ON, its SUPERPOSED field lines + equipotential contours +
      // vector field REPLACE the per-field streamlines for this frame
      // (suppress-and-replace — the superposition is the single physically-
      // faithful field-line system to reveal, never two overlapping line sets).
      if (this.showFieldOverlay) {
        drawFieldOverlay(this, loaded, { fieldLines: true, equipotentials: true, vectors: true });
      } else {
        this.drawStreamlines(loaded, simTime);
      }
      // Phase A2 — Gauss surfaces sit between the field arrows (which
      // visibly "pierce" the translucent shade) and the bodies (charge
      // disks render on top, visible inside the surface).
      this.drawGaussSurfaces(loaded);
      // Phase A4 — induction loops (conductor boundary + Lenz-sign induced-
      // current circulation). Before drawBodies so a moving-bar body renders
      // on top of its loop edge.
      this.drawInductionLoops(loaded);
      // T5 — sliding rails + resistor for rail-brake loops (those carrying a
      // `render.kind==='sliding_rail'` hint). Drawn after the loops it replaces
      // and before drawBodies so the rod slides ON TOP of its rails. Zero draws
      // on any scene without the hint.
      this.drawSlidingRails(loaded);
      // Phase A3b — live circuit schematic (auto-laid-out from the netlist,
      // lifted ABOVE the physical scene content so it never collides with
      // bodies / loops / the placeholder). Render-only; zero draws on a
      // non-circuit scene.
      this.drawCircuit(loaded, simTime);
      this.drawSurfaces(loaded);
      // Kinetic-theory box walls, drawn before the bodies so the gas disks
      // render inside the boundary. No-op on non-gas scenes.
      this.drawKineticTheoryBox(loaded);
      this.drawConnectors(loaded);
      // Phase A5 — extended-object glyphs (charged line/sheet/ring) drawn as
      // ONE shape per group, just before drawBodies so their member charges are
      // suppressed there. No-op on scenes without render_groups.
      this.drawExtendedObjects(loaded);
      // sim_trace_ghost P2 — stroke the frozen ghost trails UNDER the live
      // trace (before drawTraceOverlay) so a captured prior run sits beneath
      // the current path. Gated on showTrace so ghosts appear/disappear with
      // the Trace toggle. Self-contained: reads its own module-local store.
      if (this.showTrace) drawGhostTrails(this);
      // sim_trace_ghost P1 — stroke each traceable body's past-path trail
      // BEFORE drawBodies so the live body disk sits on top of its own trace.
      if (this.showTrace) drawTraceOverlay(this, loaded);
      this.drawBodies(loaded);
      // k015_worksheet_parity_live_sim_v1 W4 — printed-worksheet annotation
      // layer (A/B labels, h/R measure lines, v₀ = 0). Drawn AFTER the bodies so
      // the labels sit on top of the ball, and gated ENTIRELY on the worksheet
      // theme flag inside drawAnnotations (zero draws in the default look — the
      // sim's own product surface is untouched).
      this.drawAnnotations(loaded);
      if (this.showFbd) drawFbdOverlay(this, loaded);
      if (this.showLol) drawLolOverlay(this, loaded);
      // Predict-the-graph (sim_predict_graph P4). Sketch mode REPLACES the whole
      // motion-graph overlay with the single sketched subplot (Option a — one
      // quantity per session, focused; the non-sketched subplots are
      // intentionally hidden while sketching). The sketch curve + frozen frame +
      // reveal flag live in the module-scope sketch_state store (persistent
      // across the stateless-per-frame redraw, mirroring the motion-graph
      // `buffers` Map). When not sketching, the normal motion-graph overlay draws.
      if (isSketchActive()) {
        this._drawSketchOverlay();
      } else if (isKineticTheoryScene(loaded)) {
        // A gas of N disks: a single disk's x/y/v is noise, so the kinetic-
        // theory overlay (emergent P / T / speed histogram) REPLACES the
        // per-body motion graph for this scene. Gated on the graphs toggle like
        // the motion graph it stands in for.
        if (this.showGraphs) drawKineticTheoryOverlay(this, loaded);
      } else if (this.showGraphs) {
        drawMotionGraphOverlay(this, loaded, this.selectedBodyId);
      }
    }
  }

  // Pull the frozen sketch session from the store and route it to the render-
  // layer overlay. The REAL curve source depends on the mode: EASY reveals the
  // cached hidden pre-run buffer as-is (deterministic, immune to the live 10 s
  // rolling-eviction); HARD reveals the live motion-graph buffer for the sketched
  // body. Both map through the SAME session fixedRange, so the sketch px and the
  // real px are guaranteed consistent (P2 forward map).
  _drawSketchOverlay() {
    const s = getSketchSession();
    if (!s) return;
    let realBuffer, realAccessor;
    if (s.cachedBuffer) {
      realBuffer = s.cachedBuffer;
      realAccessor = (sample) => sample.v;
    } else {
      realBuffer = getBuffer(s.bodyId);
      realAccessor = (sample) => sample[s.sampleKey];
    }
    drawSketchOverlay(this.ctx, sketchPanelAnchor(this.cssHeight), {
      fixedRange: s.fixedRange,
      sketchCurve: s.sketchCurve,
      realBuffer,
      realAccessor,
      title: s.title,
      realColor: s.realColor,
      sketchColor: s.sketchColor,
      revealed: s.revealed,
    });
  }

  // Visual-only ground indicator. Drawn at y=0 only when y=0 really IS the
  // ground — e.g. projectile_motion. The line is purely cosmetic; the engine
  // has no contact constraint here, so bodies still pass through it (matches
  // existing physics).
  //
  // The decision is NOT made here. `loaded.hasImplicitGround` is computed once
  // at load by engine/ground_plane.js::hasImplicitGroundPlane — the SAME
  // predicate that arms main.js::probeScene's landing detection. This leg used
  // to re-derive it as `hasGravity && surfaces.size === 0`, which painted a
  // ground line straight through the central body of every orbit and across the
  // waterline of every bobbing float. Two copies of one decision is the bug;
  // READ the stashed flag, never re-derive (and never re-ask per frame against
  // current body positions — the line would flicker as bodies cross y=0).
  drawImplicitGround(loaded) {
    if (!loaded.hasImplicitGround) return;
    const ctx = this.ctx;
    const left = 0;
    const right = this.cssWidth;
    const groundPx = this.worldToPx({ x: 0, y: 0 });
    if (groundPx.y < -10 || groundPx.y > this.cssHeight + 10) return;
    // Solid ground line.
    ctx.strokeStyle = this.style.surface;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(left, groundPx.y);
    ctx.lineTo(right, groundPx.y);
    ctx.stroke();
    // Hatching below.
    ctx.save();
    ctx.strokeStyle = this.style.surface;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.55;
    ctx.beginPath();
    const stride = 14;
    const tickLen = 6;
    for (let x = left; x <= right; x += stride) {
      ctx.moveTo(x, groundPx.y);
      ctx.lineTo(x - tickLen * 0.7, groundPx.y + tickLen * 0.7);
    }
    ctx.stroke();
    ctx.restore();
  }

  drawGrid() {
    const ctx = this.ctx;
    // Choose a grid spacing that lands on a nice number of meters.
    const targetPx = 60;
    const rawWorld = targetPx / this.scale;
    const exp = Math.floor(Math.log10(rawWorld));
    const base = rawWorld / Math.pow(10, exp);
    const niceBase = base < 1.5 ? 1 : (base < 3 ? 2 : (base < 7 ? 5 : 10));
    const dxWorld = niceBase * Math.pow(10, exp);
    const left = this.originX - this.cssWidth / 2 / this.scale;
    const right = this.originX + this.cssWidth / 2 / this.scale;
    const bot = this.originY - this.cssHeight / 2 / this.scale;
    const top = this.originY + this.cssHeight / 2 / this.scale;
    ctx.lineWidth = 1;
    ctx.strokeStyle = this.style.grid;
    ctx.beginPath();
    for (let xw = Math.ceil(left / dxWorld) * dxWorld; xw <= right; xw += dxWorld) {
      const p = this.worldToPx({ x: xw, y: 0 });
      ctx.moveTo(p.x, 0);
      ctx.lineTo(p.x, this.cssHeight);
    }
    for (let yw = Math.ceil(bot / dxWorld) * dxWorld; yw <= top; yw += dxWorld) {
      const p = this.worldToPx({ x: 0, y: yw });
      ctx.moveTo(0, p.y);
      ctx.lineTo(this.cssWidth, p.y);
    }
    ctx.stroke();
    // Axis lines (x=0, y=0).
    ctx.strokeStyle = this.style.gridMajor;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    const ox = this.worldToPx({ x: 0, y: 0 });
    ctx.moveTo(ox.x, 0); ctx.lineTo(ox.x, this.cssHeight);
    ctx.moveTo(0, ox.y); ctx.lineTo(this.cssWidth, ox.y);
    ctx.stroke();
    // Scale label (lower-right).
    ctx.fillStyle = this.style.axis;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    const label = dxWorld >= 1
      ? `${dxWorld} m`
      : `${(dxWorld * 100).toFixed(0)} cm`;
    ctx.fillText(`grid: ${label}`, this.cssWidth - 6, this.cssHeight - 4);
  }

  drawFields(loaded) {
    if (!loaded.fields || loaded.fields.size === 0) return;
    const ctx = this.ctx;
    // Determine field-grid extent in world coords.
    const left = this.originX - this.cssWidth / 2 / this.scale * 0.85;
    const right = this.originX + this.cssWidth / 2 / this.scale * 0.85;
    const bot = this.originY - this.cssHeight / 2 / this.scale * 0.85;
    const top = this.originY + this.cssHeight / 2 / this.scale * 0.85;
    const stepX = (right - left) / (FIELD_GRID_COUNT - 1);
    const stepY = (top - bot) / (FIELD_GRID_COUNT - 1);
    // Set when any field's in-plane B is too weak to render at absolute
    // Tesla→px scale and is autoscaled instead (see the in-plane B loop) —
    // drives the "not to scale" disclaimer painted after the field loop.
    let anyNotToScale = false;
    for (const field of emFields(loaded.fields)) {  // skip non-EM (fluid) entries
      // E-field rendering. Phase 3.2: gate the cached-vector
      // optimization on `type === 'uniform'`. Non-uniform fields do not
      // expose a cached `field.E` (their E varies with position); fall
      // through to always-render and let E_at compute zero arrows where
      // the field happens to be near zero.
      const isUniform = field.type === 'uniform';
      const renderE = isUniform
        ? (field.E && (field.E.x !== 0 || field.E.y !== 0))
        : true;
      if (renderE) {
        ctx.strokeStyle = this.style.efield;
        ctx.fillStyle = this.style.efield;
        ctx.lineWidth = 1.25;
        for (let i = 0; i < FIELD_GRID_COUNT; i++) {
          for (let j = 0; j < FIELD_GRID_COUNT; j++) {
            const xw = left + i * stepX;
            const yw = bot + j * stepY;
            // RadialField throws at center; render-time grid samples
            // can land arbitrarily close to the source charge, so skip
            // the singular sample gracefully instead of crashing.
            let E;
            try {
              E = field.E_at({ x: xw, y: yw });
            } catch {
              continue;
            }
            const tail = this.worldToPx({ x: xw, y: yw });
            const dx = E.x * FIELD_E_PX_PER_V_PER_M;
            const dy = -E.y * FIELD_E_PX_PER_V_PER_M;
            const head = { x: tail.x + dx, y: tail.y + dy };
            drawArrow(this.ctx, tail, head, 4);
          }
        }
      }
      // Phase 3.5 (Q7=D.1) — in-plane B-arrow rendering. Per-frame
      // guard: sample B(r) at every grid cell, render an arrow when
      // either in-plane component is nonzero. Mirrors the 3.4
      // `B.z !== 0` token-guard pattern, adapted to in-plane B for
      // bodies that translate (compass_needle had ∇B = 0 so the
      // dipole stayed at fixed position; Phase 3.5's coupled scene
      // has the dipole drift INTO/OUT of nonzero in-plane B mid-run,
      // so a per-frame query is the precise rendering path).
      // Skipped on UniformField when B.x === 0 && B.y === 0 (the
      // 3.4 compass_needle scene has B = (1, 0, 0) but the in-plane
      // arrow renders as a single uniform direction across the grid).
      if (typeof field.B_at === 'function') {
        // First pass: gather in-plane B samples (skip singular / zero cells)
        // and track the strongest in-plane magnitude. Deferring the draw lets
        // us choose the length scale from the whole grid — needed because a
        // current_wire's microtesla B renders sub-pixel at absolute scale.
        const bSamples = [];
        let maxInPlane = 0;
        for (let i = 0; i < FIELD_GRID_COUNT; i++) {
          for (let j = 0; j < FIELD_GRID_COUNT; j++) {
            const xw = left + i * stepX + stepX / 2;
            const yw = bot + j * stepY + stepY / 2;
            if (xw > right || yw > top) continue;
            let Bsample;
            try {
              Bsample = field.B_at({ x: xw, y: yw });
            } catch {
              continue;
            }
            const mag = Math.hypot(Bsample.x, Bsample.y);
            if (mag === 0) continue;
            bSamples.push({ xw, yw, bx: Bsample.x, by: Bsample.y, mag });
            if (mag > maxInPlane) maxInPlane = mag;
          }
        }
        if (bSamples.length > 0) {
          // Autoscale only when the strongest arrow would be sub-visible at
          // absolute scale — strong fields (≥ ~0.2 T) keep FIELD_B_PX_PER_T
          // and render byte-identically to before this change.
          const autoscale =
            maxInPlane * FIELD_B_PX_PER_T < B_ARROW_VISIBLE_FLOOR_PX;
          if (autoscale) anyNotToScale = true;
          ctx.strokeStyle = this.style.bfield;
          ctx.fillStyle = this.style.bfield;
          ctx.lineWidth = 1.5;
          for (const s of bSamples) {
            const tail = this.worldToPx({ x: s.xw, y: s.yw });
            let dx, dy;
            if (autoscale) {
              // sqrt(mag/maxInPlane) compresses the 1/r dynamic range so
              // distant arrows stay readable while a falloff cue remains;
              // direction is exact (unit vector × length).
              const len =
                B_ARROW_AUTOSCALE_MAX_PX * Math.sqrt(s.mag / maxInPlane);
              dx = (s.bx / s.mag) * len;
              dy = -(s.by / s.mag) * len;
            } else {
              dx = s.bx * FIELD_B_PX_PER_T;
              dy = -s.by * FIELD_B_PX_PER_T;
            }
            const head = { x: tail.x + dx, y: tail.y + dy };
            drawArrow(this.ctx, tail, head, 4);
          }
        }
      }
      // B (z-component): tokens at grid centers — dot if Bz>0 (out of
      // page, ⊙), cross if Bz<0 (into page, ⊗). Two paths:
      //   (a) Uniform fields use the cached field.B.z (skip if zero).
      //   (b) Non-uniform fields query field.B_at(p) per grid cell so
      //       a position-varying B_z (DipoleField — Phase 3.3) renders
      //       its proper distribution instead of being silently
      //       skipped. Radial fields have B identically zero so the
      //       per-cell query returns 0 and the token drawing is
      //       skipped per-cell with no visible effect.
      const renderB = isUniform
        ? (field.B && field.B.z !== 0)
        : true;
      if (renderB) {
        ctx.strokeStyle = this.style.bfield;
        ctx.fillStyle = this.style.bfield;
        ctx.lineWidth = 1.25;
        for (let i = 0; i < FIELD_GRID_COUNT; i++) {
          for (let j = 0; j < FIELD_GRID_COUNT; j++) {
            const xw = left + i * stepX + stepX / 2;
            const yw = bot + j * stepY + stepY / 2;
            if (xw > right || yw > top) continue;
            // Resolve B_z at this sample. Uniform path uses the cached
            // value; non-uniform path queries the field, which may
            // throw at singularities (e.g., DipoleField at center) —
            // skip those samples gracefully like the E-field path
            // does.
            let bz;
            if (isUniform) {
              bz = field.B.z;
            } else {
              try {
                bz = field.B_at({ x: xw, y: yw }).z;
              } catch {
                continue;
              }
            }
            if (bz === 0) continue;
            const bToken = bz > 0 ? 'dot' : 'cross';
            const c = this.worldToPx({ x: xw, y: yw });
            ctx.beginPath();
            ctx.arc(c.x, c.y, FIELD_B_TOKEN_RADIUS_PX, 0, 2 * Math.PI);
            if (bToken === 'dot') {
              ctx.fillStyle = this.style.bfield;
              ctx.fill();
            } else {
              ctx.stroke();
              ctx.beginPath();
              const r = FIELD_B_TOKEN_RADIUS_PX * 0.7;
              ctx.moveTo(c.x - r, c.y - r); ctx.lineTo(c.x + r, c.y + r);
              ctx.moveTo(c.x + r, c.y - r); ctx.lineTo(c.x - r, c.y + r);
              ctx.stroke();
            }
          }
        }
      }
    }
    // Phase C1: when any field was autoscaled (its true in-plane B is far too
    // small to render at absolute scale — a current_wire is microtesla-scale),
    // label the arrows "not to scale", mirroring the FBD "Arrows not to scale"
    // convention so the rendered length is never read as a true magnitude.
    if (anyNotToScale) {
      ctx.fillStyle = this.style.axis;
      ctx.font = 'italic 11px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillText('B arrows not to scale', 6, this.cssHeight - 4);
    }
  }

  // A6 — E/B field-line streamlines. The smooth-flow complement to the
  // drawFields arrow grid: one continuous polyline per seed, following the
  // IN-PLANE field direction, translucent so the arrows stay legible. Pure
  // read — samples E_at/B_at, never mutates engine state. (setTime primes a
  // display-only cache on time-varying fields; check-bands is engine-only, so
  // bands stay byte-identical.) Zero draws when a scene declares no field OR
  // its field is z-only / zero in-plane (extended-charge scenes: fields:[]).
  drawStreamlines(loaded, simTime = 0) {
    if (!loaded.fields || loaded.fields.size === 0) return;
    const ctx = this.ctx;
    // Same view world-rect as drawFields (:567) so seeds land in-view.
    const left = this.originX - this.cssWidth / 2 / this.scale * 0.85;
    const right = this.originX + this.cssWidth / 2 / this.scale * 0.85;
    const bot = this.originY - this.cssHeight / 2 / this.scale * 0.85;
    const top = this.originY + this.cssHeight / 2 / this.scale * 0.85;
    const bounds = { left, right, bot, top };
    const extent = Math.max(right - left, top - bot);
    const stepM = extent / STREAMLINE_STEPS_ACROSS;
    ctx.save();
    ctx.globalAlpha = STREAMLINE_ALPHA;
    ctx.lineWidth = 1;
    for (const field of emFields(loaded.fields)) {  // skip non-EM (fluid) entries
      // Time-varying fields cache B at a time — prime the display-time sample
      // before seeding OR tracing (setTime contract, fields.js:472).
      if (typeof field.setTime === 'function') {
        field.setTime(simTime);
      }
      for (const channel of ['E', 'B']) {
        const seeds = streamlineSeeds(field, channel, bounds);
        if (seeds.length === 0) continue;
        ctx.strokeStyle = channel === 'E' ? this.style.efield : this.style.bfield;
        const sampleDir = channel === 'E'
          ? (pt) => { const F = field.E_at(pt); return { x: F.x, y: F.y }; }
          : (pt) => { const F = field.B_at(pt); return { x: F.x, y: F.y }; };
        for (const seed of seeds) {
          const line = traceStreamline(sampleDir, seed, stepM, STREAMLINE_MAX_STEPS);
          drawWorldPolyline(ctx, (pt) => this.worldToPx(pt), line);
        }
      }
    }
    ctx.restore();
  }

  // Phase A2 — draw declared Gauss surfaces as dashed silhouettes whose
  // interior is sign-shaded by enclosed electric flux. Geometry comes
  // from the A0 stash (`loaded.gauss_surfaces`); the live flux Φ_E from
  // `loaded.tracker.current().diagnostics` (`flux_E_<id>`, flux.js). Pure
  // read — never mutates engine state. Zero draw calls when the scene
  // declares no Gauss surfaces, so every non-EM scene is unaffected.
  drawGaussSurfaces(loaded) {
    if (!loaded) return;
    const surfaces = loaded.gauss_surfaces;
    if (!Array.isArray(surfaces) || surfaces.length === 0) return;
    const ctx = this.ctx;
    // Live diagnostics (flux). Defensive: a missing tracker / diagnostics
    // map leaves the geometry renderable (outline only, no shade or label).
    let diagnostics = {};
    try {
      diagnostics = loaded.tracker?.current?.().diagnostics ?? {};
    } catch {
      diagnostics = {};
    }
    for (const surf of surfaces) {
      try {
        this._drawOneGaussSurface(ctx, surf, diagnostics);
      } catch {
        // A single malformed surface must never abort the whole frame.
        continue;
      }
    }
  }

  _drawOneGaussSurface(ctx, surf, diagnostics) {
    const proj = projectGaussSurface(surf);
    if (!proj) return; // unsupported shape — skip gracefully
    const phi = diagnostics[`flux_E_${surf.id}`];
    const hasPhi = typeof phi === 'number' && Number.isFinite(phi);
    // Effectively-zero flux (incl. FP-near-zero cancellation) → neutral.
    const isZeroFlux = !hasPhi || Math.abs(phi) < FLUX_ZERO_EPS;
    // Sign → color. Neutral gray when the flux is (effectively) zero or unknown.
    let signColor = this.style.axis;
    if (!isZeroFlux && phi > 0) signColor = this.style.charge_pos;
    else if (!isZeroFlux && phi < 0) signColor = this.style.charge_neg;
    const shade = !isZeroFlux;

    ctx.save();
    // Silhouette path: circle (sphere / face-on cap) or oriented rect
    // (edge-on tube / box).
    ctx.beginPath();
    if (proj.kind === 'circle') {
      const c = this.worldToPx({ x: proj.cx, y: proj.cy });
      ctx.arc(c.x, c.y, proj.r * this.scale, 0, 2 * Math.PI);
    } else {
      const pts = proj.corners.map((p) => this.worldToPx(p));
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.closePath();
    }
    // Translucent sign-fill — only when the flux sign is known + nonzero.
    if (shade) {
      ctx.globalAlpha = GAUSS_FILL_ALPHA;
      ctx.fillStyle = signColor;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    // Dashed outline — mathematical-surface convention.
    ctx.setLineDash(GAUSS_DASH);
    ctx.globalAlpha = GAUSS_OUTLINE_ALPHA;
    ctx.strokeStyle = signColor;
    ctx.lineWidth = 1.75;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    ctx.restore();

    // Numeric flux label, centered above the silhouette. Skipped when no
    // diagnostics are available (the A1 inspector still surfaces the value).
    if (hasPhi) {
      const topPx = this.worldToPx({ x: proj.cx, y: proj.cy + proj.halfHt });
      ctx.fillStyle = signColor;
      ctx.font = '11px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(`Φ_E = ${formatFlux(phi)} V·m`, topPx.x, topPx.y - 4);
    }
  }

  // Phase A4 — draw declared induction loops: the conductor boundary
  // (solid copper wire) plus, once a flux history exists, the Lenz-sign
  // induced-current circulation and the EMF / dΦ_B/dt readout. Geometry
  // from the A0 stash (`loaded.induction_loops`); EMF/flux from
  // `loaded.tracker.current().diagnostics` (`emf_<id>`, `dphi_dt_<id>`,
  // `flux_B_<id>` — emf/dphi appear only after the 2nd tick). Pure read;
  // zero draw calls when the scene declares no loops.
  drawInductionLoops(loaded) {
    if (!loaded) return;
    const loops = loaded.induction_loops;
    if (!Array.isArray(loops) || loops.length === 0) return;
    const ctx = this.ctx;
    let diagnostics = {};
    try {
      diagnostics = loaded.tracker?.current?.().diagnostics ?? {};
    } catch {
      diagnostics = {};
    }
    for (const loop of loops) {
      // T5 — a sliding-rail loop draws via drawSlidingRails (rails + rod +
      // resistor), NOT as its declared static rectangle (which would sit,
      // detached, metres behind the sliding rod). Skip it here.
      if (loop.render?.kind === 'sliding_rail') continue;
      try {
        this._drawOneInductionLoop(ctx, loop, diagnostics);
      } catch {
        continue;
      }
    }
  }

  // T5 — draw the sliding rails + resistor for every rail-brake loop. Two
  // horizontal rails (neutral slate, matching schematic wire) at the rod's
  // endpoint y's spanning [x0, x1], closed at the left (resistor) end by a
  // zigzag (schematic-symbol color). Geometry from the pure railGeometry helper
  // via slidingRailGeometryForLoop; each loop is isolated so a malformed loop
  // can never abort the frame. Zero draws when no loop carries the hint.
  drawSlidingRails(loaded) {
    if (!loaded) return;
    const loops = loaded.induction_loops;
    if (!Array.isArray(loops) || loops.length === 0) return;
    const ctx = this.ctx;
    for (const loop of loops) {
      if (loop.render?.kind !== 'sliding_rail') continue;
      let geo = null;
      try {
        geo = slidingRailGeometryForLoop(loaded, loop);
      } catch {
        geo = null;
      }
      if (!geo) continue;
      ctx.save();
      // Two rails.
      ctx.strokeStyle = this.style.wire;
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      for (const y of [geo.y_top, geo.y_bottom]) {
        const a = this.worldToPx({ x: geo.x0, y });
        const b = this.worldToPx({ x: geo.x1, y });
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      // Resistor zigzag at the closed end.
      ctx.strokeStyle = this.style.ckt_sym;
      ctx.lineWidth = 2;
      ctx.beginPath();
      const p0 = this.worldToPx(geo.resistor[0]);
      ctx.moveTo(p0.x, p0.y);
      for (let i = 1; i < geo.resistor.length; i++) {
        const p = this.worldToPx(geo.resistor[i]);
        ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
      ctx.restore();
    }
  }

  _drawOneInductionLoop(ctx, loop, diagnostics) {
    const proj = projectInductionLoop(loop);
    if (!proj) return;
    const emf = diagnostics[`emf_${loop.id}`];
    const dphi = diagnostics[`dphi_dt_${loop.id}`];
    const fluxB = diagnostics[`flux_B_${loop.id}`];
    const hasEmf = typeof emf === 'number' && Number.isFinite(emf);

    // Conductor boundary — solid copper (a physical wire, unlike the dashed
    // mathematical Gauss surface).
    ctx.save();
    ctx.strokeStyle = this.style.induction;
    ctx.lineWidth = 2.25;
    ctx.lineCap = 'round';
    ctx.beginPath();
    if (proj.kind === 'circle') {
      const c = this.worldToPx({ x: proj.cx, y: proj.cy });
      ctx.arc(c.x, c.y, proj.r * this.scale, 0, 2 * Math.PI);
    } else if (proj.kind === 'rect') {
      const pts = proj.corners.map((p) => this.worldToPx(p));
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.closePath();
    } else { // 'line' — edge-on degradation
      const a = this.worldToPx(proj.p1);
      const b = this.worldToPx(proj.p2);
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
    }
    ctx.stroke();
    ctx.restore();

    // Lenz-sign induced-current circulation — only when face-on AND a
    // (non-zero) EMF is known. Parametrized in WORLD coords so worldToPx's
    // y-flip yields the faithful on-screen sense automatically.
    if (proj.faceOn && hasEmf && Math.abs(emf) >= EMF_ZERO_EPS) {
      this._drawCirculation(ctx, proj, emf);
    }

    // Readout, above the loop. EMF (headline) + dΦ_B/dt once the history
    // exists; before tick 2 fall back to Φ_B so the loop is never unlabelled.
    const lines = [];
    if (hasEmf) lines.push(`EMF = ${formatFlux(emf)} V`);
    if (typeof dphi === 'number' && Number.isFinite(dphi)) lines.push(`dΦ_B/dt = ${formatFlux(dphi)} Wb/s`);
    if (!hasEmf && typeof fluxB === 'number' && Number.isFinite(fluxB)) lines.push(`Φ_B = ${formatFlux(fluxB)} Wb`);
    if (lines.length > 0) {
      const topPx = this.worldToPx({ x: proj.cx, y: proj.cy + proj.halfHt });
      ctx.fillStyle = this.style.induction;
      ctx.font = '11px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      let y = topPx.y - 4;
      for (let i = lines.length - 1; i >= 0; i--) {
        ctx.fillText(lines[i], topPx.x, y);
        y -= 14;
      }
    }
  }

  // Draw N arrowheads around a circle of radius proj.circR at the loop
  // center, tangent to the induced-current circulation. WORLD-space
  // circulation sense: CCW when sign(emf)·sign(normal.z) > 0 (RHR with the
  // loop normal), CW otherwise. Sample points + tangents are built in world
  // coords and pushed through worldToPx — the canvas y-flip then renders the
  // faithful on-screen sense without manual orientation reasoning.
  _drawCirculation(ctx, proj, emf) {
    const r = proj.circR;
    if (!(r > 0)) return;
    const N = 8;
    const dHead = 0.16 * r; // world-space arrowhead reach
    ctx.save();
    ctx.strokeStyle = this.style.induction;
    ctx.fillStyle = this.style.induction;
    ctx.lineWidth = 1.75;
    for (let k = 0; k < N; k++) {
      const theta = (2 * Math.PI * k) / N;
      const px = proj.cx + r * Math.cos(theta);
      const py = proj.cy + r * Math.sin(theta);
      const t = inducedCirculationTangent(theta, emf, proj.signZ);
      const tail = this.worldToPx({ x: px - t.x * dHead * 0.5, y: py - t.y * dHead * 0.5 });
      const head = this.worldToPx({ x: px + t.x * dHead * 0.5, y: py + t.y * dHead * 0.5 });
      drawArrow(this.ctx, tail, head, 5);
    }
    ctx.restore();
  }

  // Phase A3b — draw the live circuit schematic. Auto-layout from the netlist
  // (`layoutCircuit`), then draw rail → per-branch (jogs + leads + symbol +
  // current arrow + I label) → node-voltage labels. Each phase is isolated in
  // try/catch (a malformed branch can never abort the frame). Geometry is built
  // in WORLD coords and pushed through `worldToPx` with the above-physical
  // y-shift — no ctx transforms (A3b review F-H). Diagnostics (`v_node_*` /
  // `i_branch_*`) are read defensively; absent → skeleton with no V/I numbers.
  // Zero draw calls when the scene has no `circuit_topology`.
  drawCircuit(loaded, simTime = 0) {
    if (!loaded) return;
    const ct = loaded.sceneCtx?.circuit_topology ?? loaded.scene?.circuit_topology;
    const layout = layoutCircuit(ct);
    if (!layout) return;
    const ctx = this.ctx;
    let diagnostics = {};
    try {
      diagnostics = loaded.tracker?.current?.().diagnostics ?? {};
    } catch {
      diagnostics = {};
    }
    // DEF-1 — choose the transform. A COUPLED scene (circuit + real physical
    // content) routes the schematic to its own pixel inset panel (own fit +
    // scale) so the metric physical scene keeps the full auto-fit. A pure-
    // circuit scene keeps the in-world render: layout-local → px WITH the
    // above-physical shift (circuitYBase) and the main camera scale.
    let W, cktScale;
    if (isCoupledCircuitScene(loaded)) {
      const rect = this._circuitInsetRect(loaded);
      this._drawCircuitPanelChrome(ctx, rect);
      const inner = {
        x: rect.x, y: rect.y + CKT_PANEL_TITLE_PX,
        w: rect.w, h: rect.h - CKT_PANEL_TITLE_PX
      };
      const fit = fitBoundsToRect(layout.bounds, inner);
      W = fit.W;
      cktScale = fit.scale;
    } else {
      const yBase = circuitYBase(loaded);
      W = (p) => this.worldToPx({ x: p.x, y: p.y + yBase });
      cktScale = this.scale;
    }

    // Phase 1 — ground rail.
    if (layout.rail) {
      try {
        ctx.save();
        ctx.strokeStyle = this.style.wire;
        ctx.lineWidth = 1.75;
        ctx.lineCap = 'round';
        const a = W({ x: layout.rail.x0, y: layout.rail.y });
        const b = W({ x: layout.rail.x1, y: layout.rail.y });
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        ctx.restore();
      } catch { /* rail isolated */ }
    }

    // Phase 2 — per-branch (jogs + leads + symbol + arrow + I label).
    for (const branch of layout.branches) {
      try {
        this._drawCircuitBranch(ctx, branch, diagnostics, W, cktScale, simTime);
      } catch {
        continue;
      }
    }

    // Phase 3 — node-voltage labels.
    try {
      this._drawCircuitNodeLabels(ctx, layout, diagnostics, W);
    } catch { /* labels isolated */ }
  }

  // DEF-1 — pixel rect for the coupled-scene circuit inset: the band to the
  // RIGHT of the physical content (which sceneBounds reserved by padding maxX),
  // full canvas height minus margins. Anchored at the physical content's right
  // edge in px (worldToPx of physicalSceneBounds.maxX), so the inset tracks the
  // actual fit. A floor width keeps a narrow band readable.
  _circuitInsetRect(loaded) {
    const pb = physicalSceneBounds(loaded);
    const contentRightPx = this.worldToPx({ x: pb.maxX, y: pb.maxY }).x;
    let x = contentRightPx + CKT_PANEL_GAP_PX;
    let w = this.cssWidth - x - CKT_PANEL_MARGIN_PX;
    if (w < CKT_PANEL_MIN_W_PX) {
      w = CKT_PANEL_MIN_W_PX;
      x = this.cssWidth - CKT_PANEL_MARGIN_PX - w;
    }
    return {
      x, w,
      y: CKT_PANEL_MARGIN_PX,
      h: this.cssHeight - 2 * CKT_PANEL_MARGIN_PX
    };
  }

  // DEF-1 — the inset's background card + title ("Circuit"). Opaque-ish so the
  // schematic reads over the field-dot grid regardless of what's behind it.
  _drawCircuitPanelChrome(ctx, rect) {
    ctx.save();
    ctx.fillStyle = CKT_PANEL_BG;
    ctx.strokeStyle = CKT_PANEL_BORDER;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.rect(rect.x, rect.y, rect.w, rect.h);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = CKT_PANEL_TITLE_COLOR;
    ctx.font = '12px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('Circuit', rect.x + 8, rect.y + 6);
    ctx.restore();
  }

  _drawCircuitBranch(ctx, branch, diagnostics, W, cktScale = this.scale, simTime = 0) {
    const g = branch.axis;                // geometric axis a→b (unit)
    const perp = { x: -g.y, y: g.x };     // in-plane ⊥ unit
    const sStart = { x: branch.mid.x - g.x * CKT_SYM_HALF, y: branch.mid.y - g.y * CKT_SYM_HALF };
    const sEnd = { x: branch.mid.x + g.x * CKT_SYM_HALF, y: branch.mid.y + g.y * CKT_SYM_HALF };

    // Jogs (offset branch → node) + the two leads (terminal → symbol edge).
    ctx.save();
    ctx.strokeStyle = this.style.wire;
    ctx.lineWidth = 1.75;
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (const [j0, j1] of branch.jogs ?? []) {
      const p0 = W(j0), p1 = W(j1);
      ctx.moveTo(p0.x, p0.y);
      ctx.lineTo(p1.x, p1.y);
    }
    const aPx = W(branch.a), bPx = W(branch.b), s0 = W(sStart), s1 = W(sEnd);
    ctx.moveTo(aPx.x, aPx.y); ctx.lineTo(s0.x, s0.y);
    ctx.moveTo(s1.x, s1.y); ctx.lineTo(bPx.x, bPx.y);
    ctx.stroke();
    ctx.restore();

    // T7 — animated current-flow markers along the branch, drifting at a pace
    // set by |i| and a direction set by the sign of i and the display
    // convention. Read the live branch current once here (reused by the arrow
    // + label below). Drawn BEFORE the symbol so the element overdraws the
    // markers crossing it (reads as current flowing through the component);
    // below CKT_I_ZERO_EPS the helper returns none, matching the flow arrow.
    const i = diagnostics[`i_branch_${branch.id}`];
    const marks = flowMarkerPositions([branch.fromEnd, branch.toEnd], i, this.currentConvention, simTime);
    if (marks.length) {
      ctx.save();
      ctx.fillStyle = this.currentConvention === 'electron' ? this.style.flow_electron : this.style.ckt_curr;
      for (const m of marks) {
        const p = W(m);
        ctx.beginPath();
        ctx.arc(p.x, p.y, FLOW_DOT_RADIUS_PX, 0, 2 * Math.PI);
        ctx.fill();
      }
      ctx.restore();
    }

    // Symbol (in the (g, ⊥) local frame, world→px — no ctx transform).
    this._drawCircuitSymbol(ctx, branch, W, g, perp, cktScale);

    // Current flow arrow — direction encodes the SIGN of the live current
    // (i<0 reverses), so the network passive-sign convention reads off the
    // canvas. Below CKT_I_ZERO_EPS no arrow is drawn.
    const flow = currentFlowDirection(branch.fromEnd, branch.toEnd, i);
    const arrowCtr = { x: branch.mid.x + perp.x * CKT_ARROW_OFFSET, y: branch.mid.y + perp.y * CKT_ARROW_OFFSET };
    if (flow) {
      ctx.save();
      ctx.strokeStyle = this.style.ckt_curr;
      ctx.fillStyle = this.style.ckt_curr;
      ctx.lineWidth = 1.75;
      const tail = W({ x: arrowCtr.x - flow.x * CKT_ARROW_HALF, y: arrowCtr.y - flow.y * CKT_ARROW_HALF });
      const head = W({ x: arrowCtr.x + flow.x * CKT_ARROW_HALF, y: arrowCtr.y + flow.y * CKT_ARROW_HALF });
      drawArrow(this.ctx, tail, head, 5);
      ctx.restore();
    }

    // Current label (amber, ⊥ side with the arrow) — only when finite.
    if (typeof i === 'number' && Number.isFinite(i)) {
      // Fanned verticals: the usual +⊥ reach (OFFSET+0.4) overshoots the gap to
      // the NEXT sibling's line (siblings are only CKT_BRANCH_DX = 0.8 apart) and
      // the label lands on its symbol. Pull the reach in to the arrow's offset
      // and drop the label BELOW the arrow (toward the rail), so value (lifted
      // up) / arrow (mid) / current (dropped down) occupy three separate bands
      // inside the narrow gap. Non-fanned branches keep the original placement.
      const fan = branch.orientation === 'v' && branch.fanned;
      const perpReach = fan ? CKT_ARROW_OFFSET : CKT_ARROW_OFFSET + 0.4;
      const drop = fan ? CKT_FAN_LABEL_STAGGER : 0;
      const lc = W({
        x: branch.mid.x + perp.x * perpReach + branch.axis.x * drop,
        y: branch.mid.y + perp.y * perpReach + branch.axis.y * drop,
      });
      ctx.fillStyle = this.style.ckt_curr;
      ctx.font = '10px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`i = ${formatCircuitVal(i)} A`, lc.x, lc.y);
    }

    // Element value label (slate, opposite ⊥ side) — a CONSTANT from the
    // netlist, so it renders even without diagnostics. Parenthesised (no "="),
    // so it is never mistaken for a live readout.
    const vt = this._circuitValueLabel(branch);
    if (vt) {
      // Fanned vertical branches (parallel siblings sharing a column) sit only
      // CKT_BRANCH_DX apart, so the left sibling's current label and the right
      // sibling's value label would land in the same narrow gap at the same
      // branch-mid height. Lift the value label along the branch axis (toward
      // the top node) into a separate horizontal band. This is autofit-proof:
      // it changes the vertical band, not the horizontal spacing that a width-
      // bound autofit would just rescale away. Single branches keep mid (rc/rlc
      // already read clean).
      const lift = (branch.orientation === 'v' && branch.fanned) ? CKT_FAN_LABEL_STAGGER : 0;
      const vc = W({
        x: branch.mid.x - perp.x * (CKT_ARROW_OFFSET + 0.05) - branch.axis.x * lift,
        y: branch.mid.y - perp.y * (CKT_ARROW_OFFSET + 0.05) - branch.axis.y * lift,
      });
      ctx.fillStyle = this.style.ckt_sym;
      ctx.font = '10px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(vt, vc.x, vc.y);
    }
  }

  _circuitValueLabel(branch) {
    const unit = { Resistor: 'Ω', Capacitor: 'F', Inductor: 'H', VoltageSource: 'V', CurrentSource: 'A' }[branch.type];
    if (!unit) return `${branch.id}`;
    if (!Number.isFinite(branch.value)) return `${branch.id}`;
    return `${branch.id} (${formatCircuitVal(branch.value)} ${unit})`;
  }

  // Draw the element symbol centred at branch.mid, oriented along the geometric
  // axis `g` with in-plane perpendicular `perp`. Local frame: world coord =
  // mid + s·g + q·perp (s along the line, q ⊥). Unknown types draw no symbol
  // (the plain lead wire already connects the terminals).
  _drawCircuitSymbol(ctx, branch, W, g, perp, cktScale = this.scale) {
    const mid = branch.mid;
    const L = (s, q) => W({ x: mid.x + g.x * s + perp.x * q, y: mid.y + g.y * s + perp.y * q });
    ctx.save();
    ctx.strokeStyle = this.style.ckt_sym;
    ctx.fillStyle = this.style.ckt_sym;
    ctx.lineWidth = 1.75;
    ctx.lineCap = 'round';
    switch (branch.type) {
      case 'Resistor': {
        const H = CKT_SYM_HALF, A = CKT_AMP, n = 6;
        ctx.beginPath();
        let p = L(-H, 0); ctx.moveTo(p.x, p.y);
        for (let k = 0; k < n; k++) {
          const s = -H + (k + 0.5) * (2 * H / n);
          p = L(s, k % 2 === 0 ? A : -A); ctx.lineTo(p.x, p.y);
        }
        p = L(H, 0); ctx.lineTo(p.x, p.y);
        ctx.stroke();
        break;
      }
      case 'Capacitor': {
        const gap = CKT_PLATE_GAP, ph = CKT_PLATE_HALF;
        ctx.beginPath();
        let a = L(-gap, -ph), b = L(-gap, ph); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
        a = L(gap, -ph); b = L(gap, ph); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
        // short leads from the symbol edge to each plate
        a = L(-CKT_SYM_HALF, 0); b = L(-gap, 0); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
        a = L(gap, 0); b = L(CKT_SYM_HALF, 0); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
        ctx.stroke();
        break;
      }
      case 'Inductor': {
        const H = CKT_SYM_HALF, A = CKT_AMP, humps = 4, seg = 6, total = humps * seg;
        ctx.beginPath();
        let p = L(-H, 0); ctx.moveTo(p.x, p.y);
        for (let k = 1; k <= total; k++) {
          const u = k / total;
          p = L(-H + u * 2 * H, A * Math.abs(Math.sin(u * humps * Math.PI)));
          ctx.lineTo(p.x, p.y);
        }
        ctx.stroke();
        break;
      }
      case 'VoltageSource': {
        // T3 (#3) — battery symbol: a long thin plate (+) and a short thick
        // plate (−), the standard cell schematic, replacing the old circle.
        // The plates sit near centre; the symbol draws its OWN short leads out
        // to s = ±CKT_SYM_HALF where the branch leads terminate, closing the
        // 0.13 m gap the radius-0.32 circle left against the 0.45 lead ends
        // (plan §0 #3). Inter-plate gap = 2·CKT_BATT_GAP = 0.20 m. Polarity
        // from vsPlusAtFrom(value): the long plate is the + terminal; value < 0
        // flips which end is +; value == 0 (null) → a neutral, symmetric
        // two-plate cell with no + / − (no defined polarity).
        const plusAtFrom = vsPlusAtFrom(branch.value);
        const neutral = plusAtFrom === null;
        // Along-axis direction (±1 in s) oriented toward the + terminal.
        const plusEnd = (plusAtFrom ?? true) ? branch.fromEnd : branch.toEnd;
        const sPlus = ((plusEnd.x - mid.x) * g.x + (plusEnd.y - mid.y) * g.y) >= 0 ? 1 : -1;
        const plusHalf = CKT_BATT_LONG_HALF;
        const minusHalf = neutral ? CKT_BATT_LONG_HALF : CKT_BATT_SHORT_HALF;
        // + plate (long, thin).
        let a = L(sPlus * CKT_BATT_GAP, -plusHalf), b = L(sPlus * CKT_BATT_GAP, plusHalf);
        ctx.lineWidth = 1.75;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        // − plate (short, thick) — equal length + thin in the neutral 0 V case.
        a = L(-sPlus * CKT_BATT_GAP, -minusHalf); b = L(-sPlus * CKT_BATT_GAP, minusHalf);
        ctx.lineWidth = neutral ? 1.75 : CKT_BATT_THICK;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        ctx.lineWidth = 1.75;
        // Short connecting leads: symbol edge (±CKT_SYM_HALF) → each plate.
        // These coincide with the branch lead endpoints and close the gap.
        ctx.beginPath();
        a = L(sPlus * CKT_SYM_HALF, 0); b = L(sPlus * CKT_BATT_GAP, 0); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
        a = L(-sPlus * CKT_SYM_HALF, 0); b = L(-sPlus * CKT_BATT_GAP, 0); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
        ctx.stroke();
        // + / − glyphs beside each plate (skipped when neutral). Placed between
        // the plate (s = ±CKT_BATT_GAP) and the symbol edge (s = ±CKT_SYM_HALF),
        // lifted in ⊥ off the connecting lead.
        if (!neutral) {
          ctx.font = 'bold 12px system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          const pPlus = L(sPlus * (CKT_BATT_GAP + 0.18), 0.16);
          const pMinus = L(-sPlus * (CKT_BATT_GAP + 0.18), 0.16);
          ctx.fillText('+', pPlus.x, pPlus.y);
          ctx.fillText('−', pMinus.x, pMinus.y);
        }
        break;
      }
      case 'CurrentSource': {
        const c = W(mid);
        ctx.beginPath();
        ctx.arc(c.x, c.y, CKT_SRC_R * cktScale, 0, 2 * Math.PI);
        ctx.stroke();
        // Internal arrow along from→to (its defined +I sense).
        const dx = branch.toEnd.x - branch.fromEnd.x, dy = branch.toEnd.y - branch.fromEnd.y;
        const l = Math.hypot(dx, dy) || 1, u = { x: dx / l, y: dy / l };
        const tail = W({ x: mid.x - u.x * CKT_SRC_R * 0.6, y: mid.y - u.y * CKT_SRC_R * 0.6 });
        const head = W({ x: mid.x + u.x * CKT_SRC_R * 0.6, y: mid.y + u.y * CKT_SRC_R * 0.6 });
        drawArrow(this.ctx, tail, head, 5);
        break;
      }
      default:
        break; // unknown type — leads already drawn; no symbol
    }
    ctx.restore();
  }

  _drawCircuitNodeLabels(ctx, layout, diagnostics, W) {
    ctx.save();
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    for (const n of layout.nodes) {
      const p = W({ x: n.x, y: n.y });
      if (n.isGround) {
        // Ground is the reference (MNA emits no v_node_gnd) — labelled 0 V,
        // below the rail.
        ctx.fillStyle = this.style.wire;
        ctx.textBaseline = 'top';
        ctx.fillText(`${n.id} = 0 V`, p.x, p.y + 6);
        continue;
      }
      const v = diagnostics[`v_node_${n.id}`];
      ctx.fillStyle = this.style.ckt_node;
      ctx.textBaseline = 'bottom';
      if (typeof v === 'number' && Number.isFinite(v)) {
        ctx.fillText(`${n.id} = ${formatCircuitVal(v)} V`, p.x, p.y - 8);
      } else {
        // skeleton: node id only, no number (no/NaN diagnostics — review F-F).
        ctx.fillText(n.id, p.x, p.y - 8);
      }
    }
    ctx.restore();
  }

  drawSurfaces(loaded) {
    const ctx = this.ctx;
    // Worksheet theme (v1 — single-convex-arc K015-shaped scenes ONLY; see the
    // THEME_* comment): paint the docx "solid terrain" fill UNDER the strokes —
    // a tan band below each flat surface, and the full tan disk of each convex
    // circular_arc — so the hill reads as a filled dome on filled ground. Both
    // flags are OFF in THEME_DEFAULT → this is skipped entirely and the render
    // is byte-identical to before.
    if (this.style.fillFlatBand || this.style.fillConvexArc) {
      this._fillWorksheetTerrain(loaded);
    }
    ctx.strokeStyle = this.style.surface;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    for (const s of loaded.surfaces.values()) {
      const drawn = this.drawnSurface(s);
      ctx.beginPath();
      if (drawn.shape === 'flat' || drawn.shape === 'inclined') {
        const p1 = this.worldToPx(drawn.p1);
        const p2 = this.worldToPx(drawn.p2);
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
      } else {
        // circular_arc / curved — convex arc with center on the side
        // OPPOSITE the chord normal.
        const cPx = this.worldToPx(drawn.center);
        const rPx = drawn.radius * this.scale;
        // Canvas y is flipped, so canvas angle = −world angle. That negation IS
        // the flip — the sweep flag must NOT invert it a second time (F4: it did,
        // and the renderer stroked the complementary arc, leaving K015's ridden
        // hilltop undrawn). arcSweepCanvas owns the conversion; it is unit-tested
        // against the engine's parameterization in surface_geometry.test.js.
        const { startCanvas, endCanvas, anticlockwise } =
          arcSweepCanvas(drawn.thetaStart, drawn.thetaSweep);
        ctx.arc(cPx.x, cPx.y, rPx, startCanvas, endCanvas, anticlockwise);
      }
      ctx.stroke();
      // Hatching on the back (opposite chordNormal) to suggest the
      // solid side. Short tick marks every ~14 px along the chord.
      this.hatchSurface(drawn);
    }
  }

  // Where a surface is DRAWN: one glyph radius into its solid side, so a body —
  // drawn as a disk at its true position — RESTS on the line instead of straddling
  // it. The engine's point mass is the ball's CENTRE; the surface it rides is the
  // curve the centre follows; the visible surface is one radius below that. All
  // three drawing legs (stroke, terrain fill, hatch) go through this one method so
  // they cannot drift apart. drawnSurfaceGeometry is pure + unit-tested; see its
  // docstring for why the old "lift the ball" offset was removed.
  drawnSurface(s) {
    return drawnSurfaceGeometry(s, BODY_RADIUS_PX / this.scale);
  }

  // Worksheet-theme terrain fill (behind drawSurfaces' strokes). Convex arcs
  // (circular_arc / curved) → their FULL circle, tan; flat surfaces → a tan band
  // from the (extended) surface line down to the bottom of the canvas. Both use
  // one flat colour (terrainFill = GRC), so a hill dome poking above the ground
  // band reads as one continuous tan terrain (overlap below ground is the same
  // colour). Concave arcs (loop interiors) and inclined ramp segments are left
  // stroke-only — the v1 rule is scoped to a lone hill + flat ground.
  _fillWorksheetTerrain(loaded) {
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = this.style.terrainFill;
    for (const s of loaded.surfaces.values()) {
      // The fill must use the SAME drawn geometry as the stroke, or the tan dome
      // would sit a glyph radius above its own outline.
      const drawn = this.drawnSurface(s);
      if (this.style.fillFlatBand && drawn.shape === 'flat') {
        this._fillGroundBand(drawn);
      } else if (
        this.style.fillConvexArc &&
        (drawn.shape === 'circular_arc' || drawn.shape === 'curved')
      ) {
        const cPx = this.worldToPx(drawn.center);
        const rPx = drawn.radius * this.scale;
        ctx.beginPath();
        ctx.arc(cPx.x, cPx.y, rPx, 0, 2 * Math.PI);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  // Fill the region BELOW a flat surface line (its solid side) down to the
  // canvas bottom, spanning the full canvas width. The surface line is extended
  // to the left/right canvas edges so the ground reads as a continuous plane,
  // not a segment. A (degenerate) vertical surface has no "below" band → skip.
  _fillGroundBand(s) {
    const ctx = this.ctx;
    const p1 = this.worldToPx(s.p1);
    const p2 = this.worldToPx(s.p2);
    const dx = p2.x - p1.x;
    if (Math.abs(dx) < 1e-6) return;              // vertical: no horizontal band
    const slope = (p2.y - p1.y) / dx;
    const yAt = (x) => p1.y + slope * (x - p1.x); // extended line's pixel-y at x
    ctx.beginPath();
    ctx.moveTo(0, yAt(0));
    ctx.lineTo(this.cssWidth, yAt(this.cssWidth));
    ctx.lineTo(this.cssWidth, this.cssHeight);
    ctx.lineTo(0, this.cssHeight);
    ctx.closePath();
    ctx.fill();
  }

  hatchSurface(s) {
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = this.style.surface;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.55;
    if (s.shape === 'flat' || s.shape === 'inclined') {
      const lengthPx = Math.hypot(
        (s.p2.x - s.p1.x) * this.scale,
        (s.p2.y - s.p1.y) * this.scale
      );
      const stride = 14;
      const tickLen = 6;
      // Hatch goes BELOW the surface (opposite chordNormal).
      const tx = s.chordTangent.x;
      const ty = s.chordTangent.y;
      // chordNormal direction is "up" (+y for a horizontal floor).
      // The solid side is OPPOSITE chordNormal — into the floor.
      const nxBack = -s.chordNormal.x;
      const nyBack = -s.chordNormal.y;
      const tickAngleX = (tx + nxBack) * 0.7;
      const tickAngleY = (ty + nyBack) * 0.7;
      ctx.beginPath();
      const n = Math.floor(lengthPx / stride);
      for (let i = 0; i <= n; i++) {
        const u = (i + 0.5) / (n + 1);
        const xw = s.p1.x + (s.p2.x - s.p1.x) * u;
        const yw = s.p1.y + (s.p2.y - s.p1.y) * u;
        const pStart = this.worldToPx({ x: xw, y: yw });
        const xwEnd = xw + tickAngleX * (tickLen / this.scale);
        const ywEnd = yw + tickAngleY * (tickLen / this.scale);
        const pEnd = this.worldToPx({ x: xwEnd, y: ywEnd });
        ctx.moveTo(pStart.x, pStart.y);
        ctx.lineTo(pEnd.x, pEnd.y);
      }
      ctx.stroke();
    }
    // Arc surfaces: omit hatching for v1 — the convex arc shape itself
    // makes "solid below" obvious; hatch placement on a curve adds
    // visual clutter.
    ctx.restore();
  }

  // ---- Worksheet annotation layer (k015_worksheet_parity_live_sim_v1 W4) -----
  // The printed-worksheet overlay: bold A/B position labels, the h height line
  // with T-ticks, the dashed blue R radius, and the italic v₀ = 0. Every record
  // is EMITTED from scene geometry by the archetype (loaded.annotations), never
  // hand-placed. Gated on `this.style.annotationLayer`, which is TRUE only under
  // the worksheet theme — so the default look draws ZERO annotations (the
  // anti-target). No-op on any scene without an annotations block.
  drawAnnotations(loaded) {
    if (!this.style.annotationLayer) return;   // worksheet theme only (anti-target)
    const anns = loaded && loaded.annotations;
    if (!Array.isArray(anns) || anns.length === 0) return;
    for (const a of anns) {
      switch (a.type) {
        case 'position_label': this._drawPositionLabel(a); break;
        case 'measure_line':   this._drawMeasureLine(a); break;
        case 'radius_line':    this._drawRadiusLine(a); break;
        case 'text_label':     this._drawTextLabel(a); break;
        default: break;                         // unknown type: skip (validators reject upstream)
      }
    }
  }

  // Bold-serif position label (A, B) centred above its world anchor so it clears
  // the ball disk.
  _drawPositionLabel(a) {
    const ctx = this.ctx;
    const p = this.worldToPx(a.world);
    ctx.save();
    ctx.fillStyle = this.style.annLabelColor;   // SC
    ctx.font = this.style.annLabelFont;         // bold serif
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(a.text, p.x, p.y - ANN_LABEL_OFFSET_PX);
    ctx.restore();
  }

  // Height measure line (h): a solid near-black segment with perpendicular T-tick
  // caps at both ends and an italic label at the midpoint. The tick direction is
  // COMPUTED from the endpoints (⊥ the line), never assumed vertical.
  _drawMeasureLine(a) {
    const ctx = this.ctx;
    const p1 = this.worldToPx(a.p1);
    const p2 = this.worldToPx(a.p2);
    ctx.save();
    ctx.strokeStyle = this.style.annMeasure;    // DC — near-black
    ctx.fillStyle = this.style.annMeasure;
    ctx.lineWidth = ANN_MEASURE_WIDTH_PX;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();
    // T-ticks (default on) — unit perpendicular to the line, in screen space.
    if (a.ticks !== false) {
      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const len = Math.hypot(dx, dy) || 1;
      const ux = -dy / len;
      const uy = dx / len;
      for (const e of [p1, p2]) {
        ctx.beginPath();
        ctx.moveTo(e.x - ux * ANN_TICK_HALF_PX, e.y - uy * ANN_TICK_HALF_PX);
        ctx.lineTo(e.x + ux * ANN_TICK_HALF_PX, e.y + uy * ANN_TICK_HALF_PX);
        ctx.stroke();
      }
    }
    this._drawLineLabel(a.label, p1, p2, this.style.annMeasure);
    ctx.restore();
  }

  // Radius line (R): a dashed blue construction segment (apex → centre) with an
  // italic label at the midpoint.
  _drawRadiusLine(a) {
    const ctx = this.ctx;
    const p1 = this.worldToPx(a.p1);
    const p2 = this.worldToPx(a.p2);
    ctx.save();
    ctx.strokeStyle = this.style.annRadius;     // BLC
    ctx.fillStyle = this.style.annRadius;
    ctx.lineWidth = ANN_MEASURE_WIDTH_PX;
    ctx.setLineDash(a.dashed === false ? [] : ANN_DASH);
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();
    ctx.setLineDash([]);
    this._drawLineLabel(a.label, p1, p2, this.style.annRadius);
    ctx.restore();
  }

  // Italic text label (v₀ = 0) below its world anchor, in the worksheet serif-
  // italic label font (SC).
  _drawTextLabel(a) {
    const ctx = this.ctx;
    const p = this.worldToPx(a.world);
    ctx.save();
    ctx.fillStyle = this.style.labelColor;      // SC (worksheet)
    // italic default; a non-italic text_label falls back to the bold-serif face.
    ctx.font = a.italic === false ? this.style.annLabelFont : this.style.labelFont;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(a.text, p.x, p.y + ANN_LABEL_OFFSET_PX);
    ctx.restore();
  }

  // Shared: an italic measurement label placed just past the midpoint of a line,
  // coloured to match the line so line + label read as one unit.
  _drawLineLabel(label, p1, p2, color) {
    const ctx = this.ctx;
    const mx = (p1.x + p2.x) / 2;
    const my = (p1.y + p2.y) / 2;
    ctx.fillStyle = color;
    ctx.font = this.style.labelFont;            // worksheet serif-italic
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, mx + ANN_TICK_HALF_PX + ANN_LABEL_PAD_PX, my);
  }

  // Kinetic-theory box walls (sim_kinetic_theory P4). The reflecting boundary is
  // the schema-declared box {min,max} on the box_wall_reflection collision —
  // drawn from there (NOT a hardcoded rect), so a re-authored box moves the walls
  // too. Same wall stroke as drawSurfaces; no-op on any non-gas scene.
  drawKineticTheoryBox(loaded) {
    const box = kineticTheoryBox(loaded);
    if (!box) return;
    const ctx = this.ctx;
    const a = this.worldToPx(box.min);
    const b = this.worldToPx(box.max);
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    const w = Math.abs(b.x - a.x);
    const h = Math.abs(b.y - a.y);
    ctx.save();
    ctx.strokeStyle = this.style.surface;
    ctx.lineWidth = 2.5;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.stroke();
    ctx.restore();
  }

  // Draw the connectors that tether bodies (to a fixed anchor/pulley or to
  // each other). One branch per CONNECTOR_RENDER_ENTRIES entry:
  //   - RodConstraint    (constraints) — rigid bar + pivot dot.
  //   - StringConstraint (constraints) — two rope segments over a pulley marker.
  //   - BodySpring       (forces)      — anchorless coil body_a ↔ body_b.
  //   - Spring force     (forces)      — zig-zag coil anchor→body + pivot dot.
  //   - Tension force    (forces)      — flexible rope line anchor→body + pivot dot.
  // Drawn between surfaces and bodies so the body disk covers the
  // connector's body-end. See the registry comment for the drift-gate rationale.
  drawConnectors(loaded) {
    if (!loaded) return;
    const bodyById = new Map();
    for (const b of loaded.bodies ?? []) bodyById.set(b.id, b);

    // Data-driven dispatch off CONNECTOR_RENDER_ENTRIES (module-level registry,
    // the single source of truth the lockstep gate reads). Iteration order is
    // the registry order — rods, strings, body springs, then anchored
    // springs/ropes — preserving the prior z-order (connectors under body
    // disks). Probes constructor.name (not instanceof) to stay decoupled from
    // the engine module. Read-only: never mutates engine objects.
    for (const entry of CONNECTOR_RENDER_ENTRIES) {
      const items = entry.source === 'constraints' ? loaded.constraints : loaded.forces;
      for (const obj of items ?? []) {
        if (!obj || obj.constructor?.name !== entry.className) continue;
        entry.draw(this, obj, bodyById, loaded);
      }
    }
  }

  // Filled dot marking a fixed attachment anchor.
  drawPivot(a) {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.arc(a.x, a.y, 3.5, 0, 2 * Math.PI);
    ctx.fillStyle = this.style.pivot;
    ctx.fill();
  }

  // Pulley wheel marker at the fixed pulley point of a StringConstraint. A
  // hollow rim (the wheel the rope rides over) with a filled hub dot, so the
  // Atwood rope reads as bending over a pulley rather than pinned to an anchor.
  drawPulley(p) {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 7, 0, 2 * Math.PI);
    ctx.strokeStyle = this.style.rod;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(p.x, p.y, 2.5, 0, 2 * Math.PI);
    ctx.fillStyle = this.style.pivot;
    ctx.fill();
  }

  // Rigid rod: solid bar from anchor to body, plus a pivot dot.
  drawRod(a, p) {
    const ctx = this.ctx;
    ctx.strokeStyle = this.style.rod;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    this.drawPivot(a);
  }

  // Flexible rope/string (Tension): solid thin line. Per the diagram
  // convention a present (taut) cord is solid; a cut/absent cord would
  // be dashed — but the engine only models an active Tension here.
  drawRope(a, p) {
    const ctx = this.ctx;
    ctx.strokeStyle = this.style.rope;
    ctx.lineWidth = 1.75;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
  }

  // Zig-zag spring coil from anchor a to body p. Geometry is computed
  // from the a→p axis: a straight lead at each end, then `nPeaks`
  // alternating peaks of amplitude `amp` perpendicular to the axis.
  // Below MIN_COIL_PX the segment is too short for a coil → straight line.
  drawSpringCoil(a, p) {
    const ctx = this.ctx;
    const dx = p.x - a.x;
    const dy = p.y - a.y;
    const L = Math.hypot(dx, dy);
    ctx.strokeStyle = this.style.spring;
    ctx.lineWidth = 1.75;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    const MIN_COIL_PX = 28;
    if (L < MIN_COIL_PX) {
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      return;
    }
    const ux = dx / L;
    const uy = dy / L;
    const nx = -uy;            // axis-perpendicular unit
    const ny = ux;
    const lead = Math.min(10, L * 0.18);
    const coilLen = L - 2 * lead;
    const nPeaks = Math.max(4, Math.min(10, Math.round(coilLen / 9)));
    const amp = 6;
    const c1x = a.x + ux * lead;
    const c1y = a.y + uy * lead;
    ctx.lineTo(c1x, c1y);      // straight lead-in
    for (let j = 0; j < nPeaks; j++) {
      const t = (j + 0.5) / nPeaks;
      const bx = c1x + ux * coilLen * t;
      const by = c1y + uy * coilLen * t;
      const sign = (j % 2 === 0) ? 1 : -1;
      ctx.lineTo(bx + nx * amp * sign, by + ny * amp * sign);
    }
    ctx.lineTo(a.x + ux * (lead + coilLen), a.y + uy * (lead + coilLen));
    ctx.lineTo(p.x, p.y);      // straight lead-out
    ctx.stroke();
  }

  drawBodies(loaded) {
    const ctx = this.ctx;
    // Phase A5: bodies that belong to an extended-object render group are drawn
    // ONCE as that group's glyph (drawExtendedObjects, before this leg). Skip
    // each such member's ENTIRE per-body iteration — glyph, velocity arrow,
    // orientation arrow, AND label — not just the disk. Skipping only the disk
    // still runs the label line (renderShape?.label ?? body.id), and the
    // 100/2500/200 members carry no renderShape, so the fallback would print
    // the bare internal id (line_47, sheet_1832) — violating classroom notation.
    // sim_trace_ghost P1 — the render-group suppression rule now lives ONCE
    // in the shared `isRenderSuppressed` predicate (render_suppression.js),
    // which the trace + ghost layers also delegate to, so the set can never
    // drift between the renderer and the trail. Behavior is identical: the
    // precomputed set is passed straight through.
    const suppressed = collectSuppressedIds(loaded.render_groups);
    for (const body of loaded.bodies) {
      if (isRenderSuppressed(body, suppressed)) continue;
      // Drawn position, not raw position: a body resting on a surface is lifted
      // by one glyph radius so it sits ON the surface (F2). Every overlay below
      // (velocity arrow, orientation arrow, label) hangs off this same anchor.
      const p = this.bodyAnchorPx(body, loaded);
      const isCharge = typeof body.charge === 'number';
      // Body glyph — T4 shape dispatch. Default = the 10px disk; a body
      // carrying a registered renderShape.kind (rod, …) draws its own
      // glyph. Each drawer returns the label-anchor {x,y} so the
      // shared label below sits just above whatever was drawn.
      const drawer = shapeDrawerFor(body.renderShape?.kind);
      const labelAnchor = drawer
        ? drawer(this, body, p)
        : this._drawBodyDisk(body, p, isCharge);
      // Velocity arrow (green) if non-zero — shared across every glyph,
      // drawn from the body centre.
      const vMag = Math.hypot(body.velocity.x, body.velocity.y);
      if (vMag > 1e-6) {
        ctx.strokeStyle = this.style.velocity;
        ctx.fillStyle = this.style.velocity;
        ctx.lineWidth = 2;
        const dx = body.velocity.x * VELOCITY_SCALE_PX_PER_M_PER_S;
        const dy = -body.velocity.y * VELOCITY_SCALE_PX_PER_M_PER_S;
        const head = { x: p.x + dx, y: p.y + dy };
        drawArrow(this.ctx, p, head, 6);
      }
      // Phase 3.4 (Q3=B): orientation arrow for rotating bodies.
      // Probe `body.theta` rather than instanceof so future rotational
      // body types (rolling cylinder, torsion pendulum) light up
      // automatically. The arrow shows where the dipole is pointing —
      // the needle aligns with B at θ=0 in compass-needle scenes.
      if (typeof body.theta === 'number') {
        ctx.strokeStyle = '#9B59B6'; // purple — matches FBD τ_µ color
        ctx.fillStyle = '#9B59B6';
        ctx.lineWidth = 2;
        // World-space orientation: at θ=0, arrow lies along +x̂.
        // World y is up; canvas y is down → flip dy.
        const ORIENTATION_LEN_PX = BODY_RADIUS_PX * 2.4;
        const dx = ORIENTATION_LEN_PX * Math.cos(body.theta);
        const dy = -ORIENTATION_LEN_PX * Math.sin(body.theta);
        const head = { x: p.x + dx, y: p.y + dy };
        drawArrow(this.ctx, p, head, 6);
      }
      // Label, just above the glyph. A shaped body shows its descriptive
      // renderShape.label (notation parity, e.g. "conducting rod"); a
      // plain body shows its id.
      // k015_worksheet_parity_live_sim_v1 W4: under the WORKSHEET theme the raw
      // internal body id ("ball") is authoring notation, not printed-diagram
      // notation — the annotation layer's position labels (A / B) name the
      // object instead, so suppress the id label here to avoid double-labelling
      // (and its collision with the A label). Gated on the worksheet flag, so the
      // default look draws the id label exactly as before (byte-identical).
      const showsAnnotationLabels =
        this.style.annotationLayer && !body.renderShape?.label;
      if (!showsAnnotationLabels) {
        const labelText = body.renderShape?.label ?? body.id;
        ctx.fillStyle = this.style.labelColor;
        ctx.font = this.style.labelFont;
        ctx.textAlign = 'center';
        // Drawer may request a baseline: disk labels sit ABOVE (default
        // 'bottom'); the rod labels BELOW its lower tip ('top') to clear
        // top-edge overlays like the induction-loop EMF label.
        ctx.textBaseline = labelAnchor.baseline ?? 'bottom';
        ctx.fillText(labelText, labelAnchor.x, labelAnchor.y);
      }
    }
  }

  // Default body glyph: the 10px disk (+ charge sign for charges). Returns
  // the label anchor just above the disk. Extracted from drawBodies so the
  // T4 shape registry can pick a different glyph without touching shared
  // overlays.
  _drawBodyDisk(body, p, isCharge) {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.arc(p.x, p.y, BODY_RADIUS_PX, 0, 2 * Math.PI);
    if (isCharge) {
      ctx.fillStyle = body.charge >= 0 ? this.style.charge_pos : this.style.charge_neg;
    } else {
      ctx.fillStyle = this.style.particle;
    }
    ctx.fill();
    ctx.strokeStyle = this.style.particleEdge;
    ctx.lineWidth = 1.25;
    ctx.stroke();
    if (isCharge) {
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(body.charge >= 0 ? '+' : '−', p.x, p.y + 0.5);
    }
    return { x: p.x, y: p.y - BODY_RADIUS_PX - 3 };
  }

  // Rod glyph (T4): an oriented bar of renderShape.length_m drawn as a thick
  // rounded segment with end nubs (reads as a solid conductor, not a wire).
  // Endpoint geometry is the pure rodEndpointsWorld helper → worldToPx, so
  // the bar tracks zoom/pan/y-flip and lands exactly on its rail span.
  // Returns the label anchor above the higher (smaller canvas-y) tip.
  _drawRodBody(body, p) {
    const ctx = this.ctx;
    const rs = body.renderShape;
    const ends = rodEndpointsWorld(body.position, rs.length_m, rs.angle_rad ?? 0);
    const pa = this.worldToPx(ends.a);
    const pb = this.worldToPx(ends.b);
    ctx.strokeStyle = this.style.rod;
    ctx.fillStyle = this.style.rod;
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.stroke();
    for (const e of [pa, pb]) {
      ctx.beginPath();
      ctx.arc(e.x, e.y, 3, 0, 2 * Math.PI);
      ctx.fill();
    }
    // Label below the rod's LOWER tip (baseline 'top' → text renders
    // downward into the clear space beneath the loop), so it never collides
    // with top-edge overlays such as the induction-loop EMF label.
    const bottom = pa.y >= pb.y ? pa : pb;
    return { x: bottom.x, y: bottom.y + 4, baseline: 'top' };
  }

  // Phase A5 — extended-object glyph pre-pass. Draws ONE glyph per render group
  // (a charged line/sheet/ring) at its true extent, so the N-body charge cloud
  // reads as a solid object instead of N overlapping disks. Runs BEFORE
  // drawBodies (which suppresses the member bodies). Read-only: it maps each
  // group's load-computed `extent` through worldToPx and strokes — it never
  // recomputes extent from member positions and never mutates state. No-op on
  // scenes with no render_groups (the vast majority).
  drawExtendedObjects(loaded) {
    if (!loaded) return;
    const groups = loaded.render_groups;
    if (!Array.isArray(groups) || groups.length === 0) return;
    const ctx = this.ctx;
    for (const group of groups) {
      const drawer = shapeDrawerFor(group.kind);
      if (!drawer) continue; // unknown kind (validated at load) → skip defensively
      const pxAnchor = this.worldToPx(extentCenter(group.kind, group.extent));
      const labelAnchor = drawer(this, group, pxAnchor);
      // Glyph label — classroom notation (e.g. "charged line"), never an
      // internal member id.
      ctx.fillStyle = this.style.labelColor;
      ctx.font = this.style.labelFont;
      ctx.textAlign = 'center';
      ctx.textBaseline = labelAnchor.baseline ?? 'bottom';
      ctx.fillText(group.label ?? group.kind, labelAnchor.x, labelAnchor.y);
    }
  }

  // Charge-tinted glyph color (matches the disk convention: red +, blue −;
  // neutral edge for an uncharged / mixed group).
  _chargeGlyphColor(sign) {
    if (sign > 0) return this.style.charge_pos;
    if (sign < 0) return this.style.charge_neg;
    return this.style.particleEdge;
  }

  // Extended `line` glyph: a thick charged segment between the load-computed
  // world endpoints. Returns the label anchor centred above the segment.
  _drawExtendedLine(group, _pxAnchor) {
    const ctx = this.ctx;
    const pa = this.worldToPx(group.extent.a);
    const pb = this.worldToPx(group.extent.b);
    ctx.strokeStyle = this._chargeGlyphColor(group.charge_sign);
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.stroke();
    return { x: (pa.x + pb.x) / 2, y: Math.min(pa.y, pb.y) - 6 };
  }

  // Extended `sheet` glyph: a translucent charged rectangle over the
  // load-computed corner extent, with an opaque outline. Label anchor centred
  // above the top edge.
  _drawExtendedSheet(group, _pxAnchor) {
    const ctx = this.ctx;
    const pts = group.extent.corners.map((c) => this.worldToPx(c));
    const col = this._chargeGlyphColor(group.charge_sign);
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.save();
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = col;
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = col;
    ctx.lineWidth = 2;
    ctx.stroke();
    const topY = Math.min(...pts.map((p) => p.y));
    return { x: (pts[0].x + pts[2].x) / 2, y: topY - 6 };
  }

  // Extended `ring` glyph: a charged circle from the load-computed centre +
  // radius. (No shipped scene uses `ring` yet; the drawer + its pure geometry
  // ship for charter generality — see the A5 plan DoD.)
  _drawExtendedRing(group, _pxAnchor) {
    const ctx = this.ctx;
    const c = this.worldToPx(group.extent.center);
    const rPx = group.extent.radius * this.scale;
    ctx.strokeStyle = this._chargeGlyphColor(group.charge_sign);
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(c.x, c.y, rPx, 0, 2 * Math.PI);
    ctx.stroke();
    return { x: c.x, y: c.y - rPx - 6 };
  }

  // drawArrow moved to ./render_primitives.js (roadmap F1 P2); call sites use
  // the free drawArrow(this.ctx, tail, head, headLen).

  // Where a body's glyph is actually DRAWN, in canvas px — the single source of
  // truth for the disk, its velocity/orientation arrows, its label anchor and
  // click-picking. It is the body's TRUE position, with no offset of any kind: the
  // glyph rests on a surface because the SURFACE is drawn one glyph radius into its
  // solid side (drawnSurface), not because the ball is lifted off it. The old lift
  // (F2) is gone — it had to switch off in free flight, and every switch-off popped
  // the glyph by a full radius. See drawnSurfaceGeometry's docstring.
  //
  // Kept as a method (rather than inlining worldToPx at ~8 call sites) so the
  // glyph, its arrows, its label and its hit-target can never disagree about where
  // the body is.
  bodyAnchorPx(body) {
    return this.worldToPx(body.position);
  }

  // Pick a body whose disk contains the given pixel coordinate (for inspector).
  pickBodyAt(loaded, pxPoint) {
    if (!loaded) return null;
    for (const body of loaded.bodies) {
      const p = this.bodyAnchorPx(body, loaded);
      const dx = pxPoint.x - p.x;
      const dy = pxPoint.y - p.y;
      if (Math.hypot(dx, dy) <= BODY_RADIUS_PX + 4) return body;
    }
    return null;
  }
}

// Phase A2 — project a 3-D Gauss surface spec to its 2-D silhouette in
// the xy-plane view (looking down −z). Returns one of:
//   { kind:'circle', cx, cy, r, halfHt }                  — sphere / face-on cap
//   { kind:'rect',   cx, cy, corners:[4×{x,y}], halfHt }  — edge-on tube / box
// or null for an unsupported shape. Pure geometry — this is the decision
// predicate, unit-tested directly (gauss_surface.test.js). cap_dim semantics
// per flux.js: disk → radius, square → side. The silhouette is z-stable
// (a sphere with center.z≠0 still renders at radius R). See
// docs/physics_briefs/sim_a2_gauss_render_brief.md §2.
export function projectGaussSurface(surf) {
  if (!surf || typeof surf !== 'object') return null;
  const cx = surf.center?.x ?? 0;
  const cy = surf.center?.y ?? 0;
  const EPS = 1e-9;
  if (surf.shape === 'sphere') {
    return { kind: 'circle', cx, cy, r: surf.radius, halfHt: surf.radius };
  }
  const axis = surf.axis ?? { x: 0, y: 0, z: 1 };
  const inplane = Math.hypot(axis.x, axis.y);
  if (!Number.isFinite(inplane)) return null; // NaN / ∞ axis → skip gracefully
  const axisAlongZ = inplane < EPS;
  // Along-axis half-extent FORESHORTENS by the axis's in-plane fraction:
  // an oblique axis projects a shorter segment onto the view plane than a
  // pure in-plane one. projected_half = half·inplane (= half for a pure
  // in-plane axis, inplane=1, so the shipped scenes are unchanged). The
  // perpendicular half-width does NOT foreshorten — the radius is ⊥ the
  // axis and its in-plane component still spans the full silhouette width.
  if (surf.shape === 'cylinder') {
    if (axisAlongZ) return { kind: 'circle', cx, cy, r: surf.radius, halfHt: surf.radius };
    return _rectSilhouette(cx, cy, axis.x / inplane, axis.y / inplane, (surf.length / 2) * inplane, surf.radius);
  }
  if (surf.shape === 'pillbox') {
    const capRound = surf.cap_shape === 'disk';
    // Perpendicular half-extent of the cap: disk → full radius cap_dim;
    // square → half-side cap_dim/2.
    const capHalfPerp = capRound ? surf.cap_dim : surf.cap_dim / 2;
    if (axisAlongZ) {
      if (capRound) return { kind: 'circle', cx, cy, r: surf.cap_dim, halfHt: surf.cap_dim };
      return _rectSilhouette(cx, cy, 1, 0, surf.cap_dim / 2, surf.cap_dim / 2);
    }
    return _rectSilhouette(cx, cy, axis.x / inplane, axis.y / inplane, (surf.thickness / 2) * inplane, capHalfPerp);
  }
  return null;
}

// Oriented-rectangle silhouette: half-length `halfLen` along the in-plane
// unit axis (ux,uy); half-width `halfWid` along the in-plane perpendicular.
function _rectSilhouette(cx, cy, ux, uy, halfLen, halfWid) {
  const px = -uy, py = ux; // in-plane perpendicular unit
  const corners = [
    { x: cx + halfLen * ux + halfWid * px, y: cy + halfLen * uy + halfWid * py },
    { x: cx + halfLen * ux - halfWid * px, y: cy + halfLen * uy - halfWid * py },
    { x: cx - halfLen * ux - halfWid * px, y: cy - halfLen * uy - halfWid * py },
    { x: cx - halfLen * ux + halfWid * px, y: cy - halfLen * uy + halfWid * py }
  ];
  let halfHt = 0;
  for (const c of corners) halfHt = Math.max(halfHt, Math.abs(c.y - cy));
  return { kind: 'rect', cx, cy, corners, halfHt };
}

// Compact signed flux formatter for the on-canvas label. O(100) V·m
// values render as e.g. "+112.9"; very small / very large fall back to
// scientific so the label never balloons. Uses U+2212 minus to match the
// charge-glyph convention in drawBodies.
function formatFlux(v) {
  const sign = v >= 0 ? '+' : '−';
  const a = Math.abs(v);
  if (a < FLUX_ZERO_EPS) return '0'; // FP-near-zero net flux → neutral "0"
  if (a >= 0.1 && a < 1e5) return `${sign}${a.toFixed(1)}`;
  return `${sign}${a.toExponential(2)}`;
}

// Phase A4 — project an induction loop to its 2-D xy-plane silhouette.
// Returns one of:
//   { kind:'circle', cx, cy, r, circR, halfHt, faceOn, signZ }
//   { kind:'rect',   cx, cy, corners, halfHt, circR, faceOn, signZ }
//   { kind:'line',   cx, cy, p1, p2, halfHt, faceOn:false, signZ }  (edge-on)
// or null (unsupported shape / NaN normal / degenerate axis_u). `faceOn` is
// true when the loop normal ∥ ẑ (every shipped loop); `signZ = sign(normal.z)`
// orients the Lenz circulation; `circR` is the radius of the circulation-arrow
// ring. See docs/physics_briefs/sim_a4_induction_loop_render_brief.md §2.
export function projectInductionLoop(loop) {
  if (!loop || typeof loop !== 'object') return null;
  const cx = loop.center?.x ?? 0;
  const cy = loop.center?.y ?? 0;
  const EPS = 1e-9;
  const normal = loop.normal ?? { x: 0, y: 0, z: 1 };
  const nInplane = Math.hypot(normal.x, normal.y);
  if (!Number.isFinite(nInplane)) return null; // NaN / ∞ normal → skip
  const faceOn = nInplane < EPS;               // normal ∥ ẑ → loop face-on
  const signZ = normal.z >= 0 ? 1 : -1;        // RHR circulation sense
  if (loop.shape === 'circle') {
    if (faceOn) {
      return { kind: 'circle', cx, cy, r: loop.radius, circR: loop.radius, halfHt: loop.radius, faceOn: true, signZ };
    }
    return _edgeOnLoopLine(cx, cy, normal, nInplane, loop.radius, signZ);
  }
  if (loop.shape === 'rectangle') {
    if (faceOn) {
      const a = loop.axis_u ?? { x: 1, y: 0, z: 0 };
      const aIn = Math.hypot(a.x, a.y);
      if (!Number.isFinite(aIn) || aIn < EPS) return null; // degenerate axis_u
      const proj = _rectSilhouette(cx, cy, a.x / aIn, a.y / aIn, loop.width / 2, loop.height / 2);
      proj.faceOn = true;
      proj.signZ = signZ;
      proj.circR = Math.min(loop.width, loop.height) / 2;
      return proj;
    }
    return _edgeOnLoopLine(cx, cy, normal, nInplane, Math.max(loop.width, loop.height) / 2, signZ);
  }
  return null;
}

// Phase A4 — world-space unit tangent of the induced-current circulation at
// boundary angle θ. The circulation is world-CCW when sign(emf)·signZ > 0
// (positive RHR circulation with the loop normal drives current that way when
// EMF>0), world-CW otherwise. Built in WORLD coords so worldToPx renders the
// faithful perceived sense (worldToPx maps world +y to screen-up, preserving
// orientation). Exported so the Lenz-direction decision is unit-tested
// directly against physics ground truth. Cross-check: emf<0 (rising +ẑ flux,
// the motional bar case) ⇒ CW ⇒ at θ=0 (right edge) tangent = (0,−1), current
// flows −ŷ (down) — the Lenz direction that opposes the rising flux.
export function inducedCirculationTangent(theta, emf, signZ) {
  const ccw = (Math.sign(emf) * signZ) > 0;
  return {
    x: (ccw ? -1 : 1) * Math.sin(theta),
    y: (ccw ? 1 : -1) * Math.cos(theta)
  };
}

// Edge-on silhouette of a flat loop whose normal has an in-plane component:
// a line through the center along n × ẑ (the direction in BOTH the loop plane
// and the view plane), length 2·halfLen. No circulation arrow (in-plane
// rotation is invisible in a 2-D view). Graceful degradation — no shipped
// scene reaches it (all loops have normal ∥ ẑ).
function _edgeOnLoopLine(cx, cy, normal, nInplane, halfLen, signZ) {
  const dx = normal.y / nInplane;
  const dy = -normal.x / nInplane;
  return {
    kind: 'line',
    cx, cy, faceOn: false, signZ,
    p1: { x: cx - halfLen * dx, y: cy - halfLen * dy },
    p2: { x: cx + halfLen * dx, y: cy + halfLen * dy },
    halfHt: Math.abs(halfLen * dy)
  };
}

// Phase A3b — compact value formatter for circuit V / I / element labels. O(1)
// values render trimmed ("5", "3.16", "0.6"); very small / very large fall back
// to scientific. U+2212 minus to match the project's glyph convention. Returns
// '' for non-finite (the caller then draws no number).
function formatCircuitVal(v) {
  if (!Number.isFinite(v)) return '';
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a < 0.01 || a >= 1e4) return v.toExponential(1).replace('-', '−');
  return v.toFixed(2).replace(/\.?0+$/, '').replace('-', '−');
}

// Phase A3b — world-unit direction of the current FLOW through a branch, from
// its `from`→`to` terminals, with sign(i_branch) folded in (i<0 reverses).
// Returns null when |i| is below `eps` (no arrow — Math.sign(0)=0 would give a
// degenerate arrowhead) or i is non-finite, OR the terminals coincide. Exported
// so the Lenz-of-circuits decision (which way the arrow faces) is unit-
// tested directly against ground truth, like inducedCirculationTangent.
export function currentFlowDirection(fromEnd, toEnd, i, eps = CKT_I_ZERO_EPS) {
  if (typeof i !== 'number' || !Number.isFinite(i) || Math.abs(i) < eps) return null;
  if (!fromEnd || !toEnd) return null;
  const dx = toEnd.x - fromEnd.x, dy = toEnd.y - fromEnd.y;
  const len = Math.hypot(dx, dy);
  if (!(len > 0)) return null;
  const s = Math.sign(i);
  // `+ 0` normalises a signed −0 component to +0 (a zero axis term times s=−1
  // yields −0, which Object.is / deepStrictEqual treat as distinct from 0).
  return { x: (dx / len) * s + 0, y: (dy / len) * s + 0 };
}

// Phase A3b — which terminal of a VoltageSource carries the "+". Engine
// convention: value = V_from − V_to, so `from` is the higher-potential terminal
// when value ≥ 0 (→ true), `to` when value < 0 (→ false). value == 0 (or
// non-numeric) → null (no polarity mark). Exported + unit-tested (review F-A:
// induced_current_1 ships value=−1, so its `+` belongs on `gnd`, not `n_top`).
export function vsPlusAtFrom(value) {
  if (typeof value !== 'number' || value === 0) return null;
  return value > 0;
}

// Phase A3b — vertical offset (world m) that lifts the circuit schematic ABOVE
// all NON-circuit scene content (bodies, surfaces, Gauss surfaces, induction
// loops) by CKT_GAP. Auto-layout anchors the schematic near the origin, which
// would collide with the induced_current_1 induction loop + moving bar, and with
// the pinned placeholder at (0,0) in pure-circuit scenes (review F-D). One
// source of truth, called by BOTH drawCircuit (draw shift) and sceneBounds
// (frame shift), so the two never drift. No physical content → just CKT_GAP.
export function circuitYBase(loaded) {
  let maxY = -Infinity;
  const bump = (y) => { if (Number.isFinite(y) && y > maxY) maxY = y; };
  for (const b of loaded?.bodies ?? []) if (b?.position) bump(b.position.y);
  for (const s of (loaded?.surfaces ?? new Map()).values()) {
    bump(s.p1?.y); bump(s.p2?.y);
    if (s.center && s.chordNormal) bump(s.center.y + s.chordNormal.y * s.radius);
  }
  for (const g of loaded?.gauss_surfaces ?? []) {
    const p = projectGaussSurface(g);
    if (!p) continue;
    if (p.kind === 'circle') bump(p.cy + p.r);
    else for (const c of p.corners) bump(c.y);
  }
  for (const lp of loaded?.induction_loops ?? []) {
    const p = projectInductionLoop(lp);
    if (!p) continue;
    if (p.kind === 'circle') bump(p.cy + p.r);
    else if (p.kind === 'rect') for (const c of p.corners) bump(c.y);
    else { bump(p.p1.y); bump(p.p2.y); }
  }
  return (Number.isFinite(maxY) ? maxY : 0) + CKT_GAP;
}

// Phase A3b — auto-layout a circuit netlist into world-coordinate geometry: a
// pure function of the topology alone (the decision predicate, unit-tested
// directly). TOTAL — never throws; returns null on any degenerate/malformed
// topology, because BOTH drawCircuit and sceneBounds call it unguarded and
// sceneBounds runs at scene load for EVERY scene (review F-C). Non-ground nodes
// sit on a top row in nodes[] order; ground is the bottom rail; an element with
// one ground endpoint drops vertically, an element between two top nodes spans
// horizontally; parallel branches on a shared column/pair fan out by BRANCH_DX
// /BRANCH_DY. See docs/physics_briefs/sim_a3b_circuit_render_brief.md §2.
export function layoutCircuit(topology) {
  if (!topology || typeof topology !== 'object') return null;
  const { nodes, ground_node, elements } = topology;
  if (!Array.isArray(nodes) || nodes.length === 0) return null;
  if (!Array.isArray(elements) || elements.length === 0) return null;
  if (typeof ground_node !== 'string' || !nodes.includes(ground_node)) return null;

  const topNodes = nodes.filter((n) => n !== ground_node);
  const colOf = new Map(topNodes.map((n, i) => [n, i]));
  const known = (n) => nodes.includes(n);
  const isGround = (n) => n === ground_node;

  // Classify; drop malformed elements (endpoint ∉ nodes / self-loop / both
  // ground) so a bad netlist degrades gracefully instead of crashing (F-G).
  const verticals = [];
  const horizontals = [];
  for (const el of elements) {
    const a = el?.from_node, b = el?.to_node;
    if (!known(a) || !known(b) || a === b) continue;
    const ga = isGround(a), gb = isGround(b);
    if (ga && gb) continue;
    if (ga || gb) {
      verticals.push({ el, topNode: ga ? b : a, fromIsGround: ga });
    } else {
      const ca = colOf.get(a), cb = colOf.get(b);
      const fromIsLeft = ca <= cb;
      horizontals.push({ el, leftNode: fromIsLeft ? a : b, rightNode: fromIsLeft ? b : a, fromIsLeft });
    }
  }
  if (verticals.length === 0 && horizontals.length === 0) return null;

  const branches = [];
  // Vertical drops — grouped by column so parallels (rl_relaxation's 3) fan out.
  const vByCol = new Map();
  for (const v of verticals) {
    const c = colOf.get(v.topNode);
    if (!vByCol.has(c)) vByCol.set(c, []);
    vByCol.get(c).push(v);
  }
  for (const [c, list] of vByCol) {
    const m = list.length;
    list.forEach((v, k) => {
      const lx = c * CKT_COL_DX + (k - (m - 1) / 2) * CKT_BRANCH_DX;
      const top = { x: lx, y: CKT_TOP_Y };
      const rail = { x: lx, y: CKT_RAIL_Y };
      const jogs = [];
      const nodeX = c * CKT_COL_DX;
      if (Math.abs(nodeX - lx) > 1e-9) jogs.push([{ x: nodeX, y: CKT_TOP_Y }, { x: lx, y: CKT_TOP_Y }]);
      branches.push({
        id: v.el.id, type: v.el.type, value: v.el.value, orientation: 'v', fanned: m > 1,
        a: top, b: rail, mid: { x: lx, y: (CKT_TOP_Y + CKT_RAIL_Y) / 2 }, axis: { x: 0, y: -1 },
        fromEnd: v.fromIsGround ? rail : top, toEnd: v.fromIsGround ? top : rail, jogs
      });
    });
  }
  // Horizontal spans — grouped by unordered column pair.
  const hByPair = new Map();
  for (const h of horizontals) {
    const key = `${colOf.get(h.leftNode)}-${colOf.get(h.rightNode)}`;
    if (!hByPair.has(key)) hByPair.set(key, []);
    hByPair.get(key).push(h);
  }
  for (const [, list] of hByPair) {
    const m = list.length;
    list.forEach((h, k) => {
      const ly = CKT_TOP_Y + (k - (m - 1) / 2) * CKT_BRANCH_DY;
      const xL = colOf.get(h.leftNode) * CKT_COL_DX;
      const xR = colOf.get(h.rightNode) * CKT_COL_DX;
      const left = { x: xL, y: ly }, right = { x: xR, y: ly };
      const jogs = [];
      if (Math.abs(ly - CKT_TOP_Y) > 1e-9) {
        jogs.push([{ x: xL, y: CKT_TOP_Y }, left]);
        jogs.push([{ x: xR, y: CKT_TOP_Y }, right]);
      }
      branches.push({
        id: h.el.id, type: h.el.type, value: h.el.value, orientation: 'h',
        a: left, b: right, mid: { x: (xL + xR) / 2, y: ly }, axis: { x: 1, y: 0 },
        fromEnd: h.fromIsLeft ? left : right, toEnd: h.fromIsLeft ? right : left, jogs
      });
    });
  }

  const lineXs = branches.filter((b) => b.orientation === 'v').map((b) => b.mid.x);
  const rail = lineXs.length
    ? { y: CKT_RAIL_Y, x0: Math.min(...lineXs) - CKT_RAIL_MARGIN, x1: Math.max(...lineXs) + CKT_RAIL_MARGIN }
    : null;
  const railCenterX = rail ? (rail.x0 + rail.x1) / 2 : 0;
  const layoutNodes = topNodes.map((n) => ({ id: n, x: colOf.get(n) * CKT_COL_DX, y: CKT_TOP_Y, isGround: false }));
  layoutNodes.push({ id: ground_node, x: railCenterX, y: CKT_RAIL_Y, isGround: true });

  // Bounds — every node, branch terminal, rail end, plus the ⊥ reach of the
  // flow arrow + label on either side, padded for text.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const eat = (p) => {
    if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
  };
  for (const n of layoutNodes) eat(n);
  for (const b of branches) {
    eat(b.a); eat(b.b);
    const px = -b.axis.y, py = b.axis.x, reach = CKT_ARROW_OFFSET + 0.45;
    eat({ x: b.mid.x + px * reach, y: b.mid.y + py * reach });
    eat({ x: b.mid.x - px * reach, y: b.mid.y - py * reach });
  }
  if (rail) { eat({ x: rail.x0, y: rail.y }); eat({ x: rail.x1, y: rail.y }); }
  const bounds = {
    minX: minX - CKT_LABEL_PAD, minY: minY - CKT_LABEL_PAD,
    maxX: maxX + CKT_LABEL_PAD, maxY: maxY + CKT_LABEL_PAD
  };
  return { nodes: layoutNodes, branches, rail, bounds };
}

// Raw world-space bounds of the PHYSICAL scene only — body positions, surface
// endpoints + arc extents, Gauss silhouettes, induction loops. The circuit
// schematic is NOT consumed here (it is metric-less; see sceneBounds). Returns
// possibly-Infinite extents (no fallback / pad); finalizeBounds applies those.
function physicalBoundsRaw(loaded) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const consume = (p) => {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  };
  for (const b of loaded.bodies ?? []) consume(b.position);
  for (const s of (loaded.surfaces ?? new Map()).values()) {
    consume(s.p1);
    consume(s.p2);
    if (s.center) {
      // Extremes on the convex arc lie along ±chordNormal from the
      // chord midpoint — the arc bulges along +chordNormal, so the
      // bound includes that apex.
      consume({
        x: s.center.x + s.chordNormal.x * s.radius,
        y: s.center.y + s.chordNormal.y * s.radius
      });
    }
  }
  // Phase A2 — include Gauss-surface silhouettes so autoFit frames the
  // WHOLE surface, not just the bodies it encloses: a Gauss surface
  // routinely extends well beyond its enclosed charge cluster (e.g. the
  // pillbox circle R=0.5 around a ±0.2 sheet), and without this the
  // camera clips most of it off-screen.
  for (const g of loaded.gauss_surfaces ?? []) {
    const proj = projectGaussSurface(g);
    if (!proj) continue;
    if (proj.kind === 'circle') {
      consume({ x: proj.cx - proj.r, y: proj.cy - proj.r });
      consume({ x: proj.cx + proj.r, y: proj.cy + proj.r });
    } else {
      for (const c of proj.corners) consume(c);
    }
  }
  // Phase A4 — same framing fix for induction loops (a loop can extend
  // beyond the bodies, e.g. a circle loop around a stationary witness).
  for (const lp of loaded.induction_loops ?? []) {
    // T5 — a sliding-rail loop is DRAWN as its rails, not its static rectangle,
    // so frame the rails (they extend to x1, well past the small declared rect)
    // — otherwise the far rail tail clips off-screen. Supersedes the rect proj.
    if (lp.render?.kind === 'sliding_rail') {
      const geo = slidingRailGeometryForLoop(loaded, lp);
      if (geo) {
        consume({ x: geo.x0, y: geo.y_bottom });
        consume({ x: geo.x1, y: geo.y_top });
        continue;
      }
    }
    const proj = projectInductionLoop(lp);
    if (!proj) continue;
    if (proj.kind === 'circle') {
      consume({ x: proj.cx - proj.r, y: proj.cy - proj.r });
      consume({ x: proj.cx + proj.r, y: proj.cy + proj.r });
    } else if (proj.kind === 'rect') {
      for (const c of proj.corners) consume(c);
    } else {
      consume(proj.p1);
      consume(proj.p2);
    }
  }
  return { minX, minY, maxX, maxY };
}

// Apply the empty-scene fallback + zero-extent pad to a raw bounds box.
// (Same two guards the pre-DEF-1 sceneBounds applied at its tail.)
function finalizeBounds(b) {
  let { minX, minY, maxX, maxY } = b;
  if (!isFinite(minX)) {
    // No bodies, no surfaces — fall back to a 10 m viewport at origin.
    return { minX: -5, maxX: 5, minY: -5, maxY: 5 };
  }
  // Pad zero-extent dimensions so divide-by-zero in autoFit is avoided.
  if (maxX - minX < 1e-3) { minX -= 1; maxX += 1; }
  if (maxY - minY < 1e-3) { minY -= 1; maxY += 1; }
  return { minX, minY, maxX, maxY };
}

// Public physical-only bounds (fallback + pad applied, circuit excluded). Used
// by the coupled-scene main-camera fit AND by drawCircuit to anchor the inset
// panel exactly past the physical content's right edge (DEF-1).
export function physicalSceneBounds(loaded) {
  return finalizeBounds(physicalBoundsRaw(loaded));
}

// DEF-1 — does the scene carry REAL physical content (an induction loop,
// surface, Gauss surface, or a body that is NOT the pinned 'placeholder' a
// pure-circuit scene parks at the origin)? Pure predicate, unit-tested directly.
export function hasRealPhysicalContent(loaded) {
  if (!loaded) return false;
  if ((loaded.induction_loops?.length ?? 0) > 0) return true;
  if ((loaded.surfaces?.size ?? 0) > 0) return true;
  if ((loaded.gauss_surfaces?.length ?? 0) > 0) return true;
  for (const b of loaded.bodies ?? []) {
    if (b?.id !== 'placeholder') return true;
  }
  return false;
}

// DEF-1 — "coupled circuit scene": carries BOTH a valid circuit netlist AND
// real physical content. The schematic is then routed to its own inset panel so
// the metric physical scene keeps the full auto-fit. Pure predicate (the render-
// routing decision boundary), unit-tested directly. A pure-circuit scene (no
// real physical content) returns false → unchanged in-world schematic render.
export function isCoupledCircuitScene(loaded) {
  if (!loaded) return false;
  const ct = loaded.sceneCtx?.circuit_topology ?? loaded.scene?.circuit_topology;
  if (!layoutCircuit(ct)) return false;
  return hasRealPhysicalContent(loaded);
}

// DEF-1 — fit a world-coord bounding box into a pixel rectangle (an inset
// panel), returning a coordinate transform W: worldPoint → panel px, and scalar
// `scale` (px per world-unit) for radius-style sizes (e.g. the current-source
// circle). Mirrors fitToBounds but targets an arbitrary rect, not the full
// canvas; y flips (canvas y grows downward). Pure — unit-tested directly.
export function fitBoundsToRect(bounds, rect, marginFrac = CKT_PANEL_FIT_MARGIN) {
  const wWorld = Math.max(bounds.maxX - bounds.minX, 1e-6);
  const hWorld = Math.max(bounds.maxY - bounds.minY, 1e-6);
  const scaleX = rect.w / (wWorld * (1 + 2 * marginFrac));
  const scaleY = rect.h / (hWorld * (1 + 2 * marginFrac));
  const scale = Math.min(scaleX, scaleY);
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  const ox = rect.x + rect.w / 2;
  const oy = rect.y + rect.h / 2;
  const W = (p) => ({ x: ox + (p.x - cx) * scale, y: oy - (p.y - cy) * scale });
  return { W, scale };
}

// World-space bounds of the scene. Used by autoFit + the trajectory probe
// (main.js) to pick the camera transform.
//   - non-coupled (pure-circuit or no circuit): physical content folded with
//     the circuit schematic (shifted above by circuitYBase) — BYTE-IDENTICAL to
//     the pre-DEF-1 behaviour.
//   - coupled (circuit + real physical content): the schematic is EXCLUDED (it
//     renders in its own inset panel) and the right CIRCUIT_INSET_FRAC of the
//     frame is reserved for that inset by padding maxX, so the physical scene
//     fits the left portion at full metric size (DEF-1).
export function sceneBounds(loaded) {
  if (isCoupledCircuitScene(loaded)) {
    const pb = physicalSceneBounds(loaded);
    const physW = pb.maxX - pb.minX;
    // Reserve the right band: content occupies (1 - FRAC) of the padded box.
    const pad = physW * (CIRCUIT_INSET_FRAC / (1 - CIRCUIT_INSET_FRAC));
    return { minX: pb.minX, minY: pb.minY, maxX: pb.maxX + pad, maxY: pb.maxY };
  }
  // Phase A3b — fold the circuit schematic in, shifted ABOVE the physical scene
  // content (circuitYBase) so the auto-layout is framed without colliding with
  // bodies / loops / the placeholder. Topology lives on sceneCtx/scene. No
  // circuit → layout null → physical bounds only (byte-identical to pre-DEF-1).
  const raw = physicalBoundsRaw(loaded);
  const cktTopology = loaded.sceneCtx?.circuit_topology ?? loaded.scene?.circuit_topology;
  const cktLayout = layoutCircuit(cktTopology);
  if (cktLayout) {
    const yBase = circuitYBase(loaded);
    if (cktLayout.bounds.minX < raw.minX) raw.minX = cktLayout.bounds.minX;
    if (cktLayout.bounds.maxX > raw.maxX) raw.maxX = cktLayout.bounds.maxX;
    if (cktLayout.bounds.minY + yBase < raw.minY) raw.minY = cktLayout.bounds.minY + yBase;
    if (cktLayout.bounds.maxY + yBase > raw.maxY) raw.maxY = cktLayout.bounds.maxY + yBase;
  }
  return finalizeBounds(raw);
}

export const NAME = 'canvas2d';
