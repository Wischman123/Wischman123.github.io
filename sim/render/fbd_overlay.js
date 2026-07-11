// render/fbd_overlay.js
//
// Free-body diagram overlay. For each body in the scene, computes the
// list of forces acting on it at the body's CURRENT state (post-tick,
// after syncBodies), renders a small FBD anchored to the right of the
// body, with arrows scaled proportional to magnitude and labeled in
// the classroom notation.
//
// The overlay is RENDER-LAYER ONLY — it does not mutate engine state.
// Forces are recomputed by calling each Force class's `applyTo(body,
// sceneCtx)` against already-synced body positions/velocities. This
// avoids attaching state to the integrator hot path; the universality
// test still holds (no engine files changed).
//
// Notation parity with problems/lib/fbd.py and PEDAGOGY.md:
//   mg   — near-surface gravity (constant_g model)
//   F_g  — universal gravitation (Phase D+)
//   n    — normal contact force from a Surface (lowercase; conflicts
//          with Newtons unit if uppercase)
//   f    — friction (lowercase italic)
//   T    — tension (rope/rod)
//   F_s  — spring restoring force
//   F_d  — drag (linear or quadratic)
//   F_E  — electric portion of the Lorentz force (qE)
//   F_B  — magnetic portion of the Lorentz force (qv × B)
//
// Arrow scaling: proportional to magnitude, with a 25% minimum floor
// (mirrors _MIN_SCALE in problems/lib/fbd.py) so very small forces
// remain visible.
//
// Anti-Kohn: labels are notation, not evaluation. No copy in this
// module needs sanitizing because we never emit prose.

import { LorentzForce, Tension as TensionForce } from '../engine/forces.js';
import { RodConstraint, StringConstraint } from '../engine/constraints.js';
import { assertScalarTau } from '../engine/vec.js';

// Locked palette (handoff §"Locked design decisions"):
//   weight gray, normal blue, friction red, tension green, applied purple.
// E&M-specific entries reuse the field-arrow colors from canvas2d.js
// for visual continuity.
export const FBD_COLORS = {
  mg: '#666666',
  F_g: '#666666',
  n: '#2E75B6',
  f: '#E74C3C',
  T: '#2E8B57',
  F_s: '#7C4DFF',
  F_d: '#888888',
  F_E: '#c0392b',
  F_B: '#2980b9',
  F_mu: '#16a085', // magnetic-dipole-in-field force (Phase 3.3); matches U_magnetic teal
  // Phase 3.4 (Q5=B): magnetic-dipole-in-field torque label. Distinct
  // purple from the teal F_µ to keep force / torque visually separable
  // when both arrows are drawn for the same body (compass-needle scene).
  'τ_µ': '#9B59B6'
};

// Layout constants (CSS pixels, not DPR-scaled — the canvas context
// already accounts for DPR via setTransform).
const ANCHOR_OFFSET_PX = 64;     // distance from body center to FBD origin
const FBD_DOT_RADIUS_PX = 4;
const FBD_ARROW_FULL_LEN_PX = 30;
const FBD_ARROW_HEAD_PX = 5;
const FBD_LABEL_GAP_PX = 8;
const FBD_LABEL_FONT = 'italic bold 11px "Times New Roman", serif';
const FBD_DISCLAIMER_FONT = 'italic 9px system-ui, sans-serif';
const FBD_DOT_COLOR = '#bbbbbb';
const FBD_DISCLAIMER_COLOR = '#999999';
const MIN_SCALE = 0.25;          // 25% floor on proportional arrow scaling
const MAG_EPS = 1e-9;            // ignore forces below this magnitude
const RIGHT_VS_LEFT_BIAS = 0.05; // tiny bias to break ties for body picking

// Compute the list of forces acting on a single body, returning a
// list of { label, vec, mag, color }. The vector is in world units
// (Newtons). Forces with magnitude under MAG_EPS are dropped.
//
// The function is exported so unit tests can drive it directly without
// a Canvas context.
export function computeBodyForces(body, loaded) {
  const out = [];
  const sceneCtx = loaded.sceneCtx;

  // Engine "Force" objects (gravity, spring, drag, friction, tension,
  // lorentz). Lorentz is split into electric + magnetic so students
  // can see both components separately on the FBD; the underlying
  // physics is unchanged (sum equals what LorentzForce.applyTo would
  // return).
  for (const force of loaded.forces) {
    if (!force.appliesTo(body.id)) continue;

    if (force instanceof LorentzForce) {
      const split = lorentzBreakdown(force, body, sceneCtx);
      if (split.E && (Math.abs(split.E.x) > MAG_EPS || Math.abs(split.E.y) > MAG_EPS)) {
        out.push(makeEntry('F_E', split.E));
      }
      if (split.B && (Math.abs(split.B.x) > MAG_EPS || Math.abs(split.B.y) > MAG_EPS)) {
        out.push(makeEntry('F_B', split.B));
      }
      continue;
    }

    // Phase 3.4 (Q5=B): every Force.applyTo returns {F, tau}. The FBD
    // overlay only renders the F vec here; torque is rendered as a
    // separate curved arrow by drawTorqueOverlay() (see below).
    const { F } = force.applyTo(body, sceneCtx);
    if (Math.abs(F.x) <= MAG_EPS && Math.abs(F.y) <= MAG_EPS) continue;

    const label = labelForForce(force);
    out.push(makeEntry(label, F));
  }

  // Surface contact normals (penalty-method n). One entry per contacting
  // surface — multi-surface stacks (rare in v1) get one arrow each.
  if (loaded.surfaces && sceneCtx) {
    for (const surface of loaded.surfaces.values()) {
      const Fc = surface.contactForce(body, sceneCtx.k_contact, sceneCtx.c_damping);
      if (Fc.normal_force_mag > MAG_EPS) {
        out.push(makeEntry('n', { x: Fc.Fx, y: Fc.Fy }));
      }
    }
  }

  // Constraints. RodConstraint (single-body pendulum bar) and
  // StringConstraint (two-body Atwood string) are both tension-type — label
  // them T. applyTo takes sceneCtx as its 2nd arg so a StringConstraint can
  // read its partner body; pass the canonical `loaded.sceneCtx` (the SAME
  // object handed to force.applyTo above), NOT an ad-hoc lite shape, so one
  // context spans every constraint call site. RodConstraint ignores it.
  if (loaded.constraints) {
    for (const c of loaded.constraints) {
      if (!c.appliesTo(body.id)) continue;
      const F = c.applyTo(body, sceneCtx);
      if (Math.abs(F.x) <= MAG_EPS && Math.abs(F.y) <= MAG_EPS) continue;
      const label = (c instanceof RodConstraint || c instanceof StringConstraint) ? 'T' : 'F_c';
      out.push(makeEntry(label, F));
    }
  }

  return out;
}

// Map a Force instance to its FBD label. Rather than exposing a label
// field on every Force class (engine concern bleeding into render
// concern), we centralize the mapping here. New force types (Phase D+
// universal gravitation, Phase 5 charge-charge) extend this switch.
function labelForForce(force) {
  const ctorName = force?.constructor?.name ?? '';
  switch (ctorName) {
    case 'Gravity':
      return force.model === 'universal' ? 'F_g' : 'mg';
    case 'Spring':
      return 'F_s';
    case 'BodySpring':
      // Two-body coupling spring (coupled oscillator). Same notation as the
      // single-body Spring — students see F_s for any spring force.
      return 'F_s';
    case 'Drag':
      return 'F_d';
    case 'Friction':
      return 'f';
    case 'Tension':
      return 'T';
    case 'Coulomb':
      return 'F_C';
    case 'DipoleInField':
      // Phase 3.3 — magnetic-dipole-in-field force. The label uses 'F_mu'
      // (ASCII) so the LaTeX-free CSS render can scale; UI rendering can
      // map this to F_µ if a Greek-aware font is available.
      return 'F_mu';
    case 'AppliedAcceleration':
      // T9 — the settable a₀ applied-acceleration force (F = m·a).
      return 'F_a';
    default:
      return 'F';
  }
}

function makeEntry(label, vec) {
  const mag = Math.hypot(vec.x, vec.y);
  return {
    label,
    vec: { x: vec.x, y: vec.y },
    mag,
    color: FBD_COLORS[label] ?? '#444444'
  };
}

// Split LorentzForce into electric (qE) and magnetic (qv × B) parts.
// Mirrors the math in LorentzForce.applyTo without re-throwing on the
// 3D-warning case — if a scene ever reaches the renderer with that
// configuration the engine has already errored and we wouldn't be
// rendering it.
function lorentzBreakdown(force, body, sceneCtx) {
  const fields = sceneCtx?.fields;
  if (!fields) return { E: null, B: null };
  const field = fields.get(force.field_id);
  if (!field || typeof body.charge !== 'number') return { E: null, B: null };
  const q = body.charge;
  const E = field.E_at(body.position);
  const B = field.B_at(body.position);
  const v = body.velocity;
  return {
    E: { x: q * E.x, y: q * E.y },
    B: { x: q * v.y * B.z, y: -q * v.x * B.z }
  };
}

// Compute per-arrow lengths (CSS pixels) given a list of force entries.
// Returns { lengths, anyClipped }. `anyClipped` is true when the 25%
// floor engaged on at least one arrow — used to show the "not to scale"
// disclaimer.
export function computeArrowLengths(entries) {
  if (entries.length === 0) return { lengths: [], anyClipped: false };
  const maxMag = Math.max(...entries.map(e => e.mag));
  if (!(maxMag > 0)) {
    return { lengths: entries.map(() => FBD_ARROW_FULL_LEN_PX), anyClipped: false };
  }
  let anyClipped = false;
  const lengths = entries.map((e) => {
    const ratio = e.mag / maxMag;
    if (ratio < MIN_SCALE) anyClipped = true;
    return FBD_ARROW_FULL_LEN_PX * Math.max(ratio, MIN_SCALE);
  });
  return { lengths, anyClipped };
}

// Pick an anchor offset (in CSS pixels, canvas-y-down) for a body's FBD.
// Default is to the right; if the body is already near the right edge
// of the canvas, mirror to the left so the FBD stays in view.
function pickAnchor(bodyPx, canvasW) {
  const right = bodyPx.x + ANCHOR_OFFSET_PX;
  const left = bodyPx.x - ANCHOR_OFFSET_PX;
  // Reserve enough margin on the chosen side for arrows + labels.
  const margin = FBD_ARROW_FULL_LEN_PX + 20;
  const rightFits = right + margin <= canvasW;
  const leftFits = left - margin >= 0;
  if (rightFits) return { x: right, y: bodyPx.y };
  if (leftFits) return { x: left, y: bodyPx.y };
  // Both sides crowded — fall back to right with a small bias so picks
  // are stable (a body at the exact edge always picks one direction).
  return { x: bodyPx.x + ANCHOR_OFFSET_PX * (1 - RIGHT_VS_LEFT_BIAS), y: bodyPx.y };
}

// Canvas drawing primitive: stroke an arrow from tail to head with a
// small triangular head. Same shape as Canvas2DRenderer.drawArrow but
// stroke + fill are independently set by the caller.
function drawArrow(ctx, tail, head, headLen) {
  const dx = head.x - tail.x;
  const dy = head.y - tail.y;
  const len = Math.hypot(dx, dy);
  if (len < 1) return;
  ctx.beginPath();
  ctx.moveTo(tail.x, tail.y);
  ctx.lineTo(head.x, head.y);
  const ang = Math.atan2(dy, dx);
  const left = ang + Math.PI - 0.42;
  const right = ang + Math.PI + 0.42;
  ctx.lineTo(head.x + Math.cos(left) * headLen, head.y + Math.sin(left) * headLen);
  ctx.moveTo(head.x, head.y);
  ctx.lineTo(head.x + Math.cos(right) * headLen, head.y + Math.sin(right) * headLen);
  ctx.stroke();
}

// Render one label with subscript handling. "F_s" → "F" italic + "s"
// subscript. "mg" → plain italic "mg". "T" → italic "T".
function drawLabel(ctx, anchor, label, color) {
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (label.includes('_')) {
    const [base, sub] = label.split('_', 2);
    // Measure each piece so we can lay them out side-by-side, centered
    // on `anchor`.
    ctx.font = FBD_LABEL_FONT;
    const baseW = ctx.measureText(base).width;
    ctx.font = subscriptFont(FBD_LABEL_FONT);
    const subW = ctx.measureText(sub).width;
    const total = baseW + subW;
    const baseX = anchor.x - total / 2 + baseW / 2;
    const subX = baseX + baseW / 2 + subW / 2;
    ctx.font = FBD_LABEL_FONT;
    ctx.fillText(base, baseX, anchor.y);
    ctx.font = subscriptFont(FBD_LABEL_FONT);
    ctx.fillText(sub, subX, anchor.y + 3);
  } else {
    ctx.font = FBD_LABEL_FONT;
    ctx.fillText(label, anchor.x, anchor.y);
  }
}

// Convert a font shorthand to a smaller-size variant for subscripts.
// "italic bold 11px ..." → "italic bold 8px ..." — robust against extra
// keywords (style, variant, weight, stretch) by replacing the first
// `<n>px` token.
function subscriptFont(font) {
  return font.replace(/(\d+(?:\.\d+)?)px/, (_m, n) => `${Math.max(7, Math.round(parseFloat(n) * 0.75))}px`);
}

// Convert a world-space force vector into a canvas-space arrow tip
// offset. The renderer's worldToPx flips +y, so a force pointing up in
// world coords (+Fy) becomes a screen-up arrow (negative dy).
function arrowTipOffsetPx(vec, lenPx) {
  const mag = Math.hypot(vec.x, vec.y);
  if (mag === 0) return { dx: 0, dy: 0 };
  const ux = vec.x / mag;
  const uy = vec.y / mag;
  return { dx: ux * lenPx, dy: -uy * lenPx };
}

// Public render entry. Called from Canvas2DRenderer.render() after
// drawBodies() when the FBD toggle is on. The renderer passes itself
// in so we can reuse worldToPx and the canvas context.
export function drawFbdOverlay(renderer, loaded) {
  if (!loaded || !loaded.bodies) return;
  const ctx = renderer.ctx;
  const canvasW = renderer.cssWidth;

  for (const body of loaded.bodies) {
    const entries = computeBodyForces(body, loaded);
    if (entries.length > 0) {
      const bodyPx = renderer.worldToPx(body.position);
      const anchor = pickAnchor(bodyPx, canvasW);
      drawOneFbd(ctx, anchor, entries);
    }
    // Phase 3.4 (Q5=B): if the body declares rotational state, render
    // a torque arrow alongside the FBD. Sum τ across all forces that
    // apply to this body.
    if (typeof body.theta === 'number' && typeof body.omega === 'number') {
      const totalTau = computeBodyTorque(body, loaded);
      if (Math.abs(totalTau) > MAG_EPS) {
        const bodyPx = renderer.worldToPx(body.position);
        drawTorqueArc(ctx, bodyPx, totalTau);
      }
    }
  }
}

// Sum τ across every Force that applies to this body. Mirrors
// derivState in scene.js but reads-only; the engine itself has
// already advanced state.
//
// Phase 5.R1 (Q2=γ): τ is a vec3. The render layer extracts the
// `.z` component for the curved arrow; the per-force `assertScalarTau`
// guard mirrors scene.js's dispatch-site policy so a force returning
// a malformed τ surfaces here too. The pre-5.R1 guard
// `typeof r.tau === 'number'` silently returned 0 for every dipole
// scene (because τ was never a number again after the widening) —
// /refine HC2 named that the silent-zero-render hazard, not the
// guarded one.
export function computeBodyTorque(body, loaded) {
  let tau = 0;
  const sceneCtx = loaded.sceneCtx;
  for (const force of loaded.forces) {
    if (!force.appliesTo(body.id)) continue;
    // LorentzForce / Coulomb / etc. all return tau=vec3.zero() in v0;
    // only DipoleInField returns nonzero tau.z on a RotatingDipole.
    const r = force.applyTo(body, sceneCtx);
    if (r && r.tau && typeof r.tau.z === 'number') {
      assertScalarTau(r.tau);
      tau += r.tau.z;
    }
  }
  return tau;
}

// Curved arrow indicating ±τ direction around the body's center.
// Counter-clockwise arc for positive τ (CCW about ẑ by sign convention),
// clockwise for negative. Magnitude maps to arc-sweep length: full
// sweep at the largest |τ| in the scene; minimum sweep at the 25%
// floor (mirrors the FBD arrow scaling).
//
// Phase 3.4 (Q5=B). Color `#9B59B6` purple — distinct from the teal
// F_µ (`#16a085`) so a teacher with both overlays on can tell force
// vs torque apart.
const TORQUE_ARC_RADIUS_PX = 22;
const TORQUE_ARC_FULL_SWEEP = 1.6 * Math.PI; // ~290° at full magnitude
const TORQUE_ARC_MIN_SWEEP = 0.4 * Math.PI;  // 72° floor
const TORQUE_LINE_WIDTH = 2;
const TORQUE_HEAD_PX = 6;

function drawTorqueArc(ctx, bodyPx, tau) {
  const sweep = Math.min(
    TORQUE_ARC_FULL_SWEEP,
    Math.max(TORQUE_ARC_MIN_SWEEP, TORQUE_ARC_FULL_SWEEP * Math.tanh(Math.abs(tau)))
  );
  ctx.save();
  ctx.strokeStyle = FBD_COLORS['τ_µ'];
  ctx.fillStyle = FBD_COLORS['τ_µ'];
  ctx.lineWidth = TORQUE_LINE_WIDTH;
  // Canvas y is flipped: positive τ (CCW about ẑ in world) becomes
  // CCW in screen coords too (canvas2d flips y at draw time, so a
  // visually-CCW arc matches the physical rotation direction the
  // student sees on the canvas).
  const startAngle = -Math.PI / 4;
  const endAngle = startAngle + (tau > 0 ? sweep : -sweep);
  ctx.beginPath();
  ctx.arc(
    bodyPx.x, bodyPx.y, TORQUE_ARC_RADIUS_PX,
    startAngle, endAngle, tau <= 0
  );
  ctx.stroke();
  // Arrowhead at the end of the arc.
  const tipX = bodyPx.x + TORQUE_ARC_RADIUS_PX * Math.cos(endAngle);
  const tipY = bodyPx.y + TORQUE_ARC_RADIUS_PX * Math.sin(endAngle);
  // Tangent direction at the arc end. For CCW (tau > 0) the tangent
  // lies perpendicular to the radius in the +sweep direction.
  const tangent = tau > 0
    ? { x: -Math.sin(endAngle), y: Math.cos(endAngle) }
    : { x: Math.sin(endAngle), y: -Math.cos(endAngle) };
  ctx.beginPath();
  ctx.moveTo(tipX, tipY);
  const headBackAngle = Math.atan2(-tangent.y, -tangent.x);
  const left = headBackAngle - 0.42;
  const right = headBackAngle + 0.42;
  ctx.lineTo(tipX + Math.cos(left) * TORQUE_HEAD_PX, tipY + Math.sin(left) * TORQUE_HEAD_PX);
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(tipX + Math.cos(right) * TORQUE_HEAD_PX, tipY + Math.sin(right) * TORQUE_HEAD_PX);
  ctx.stroke();
  // τ_µ label near the arc midpoint, outside the radius.
  const midAngle = (startAngle + endAngle) / 2;
  const labelR = TORQUE_ARC_RADIUS_PX + FBD_LABEL_GAP_PX + 2;
  const labelAnchor = {
    x: bodyPx.x + labelR * Math.cos(midAngle),
    y: bodyPx.y + labelR * Math.sin(midAngle)
  };
  drawLabel(ctx, labelAnchor, 'τ_µ', FBD_COLORS['τ_µ']);
  ctx.restore();
}

// Internal: draw one FBD at the given anchor (CSS pixels) given its
// entries. Exported as a named function for tests so we can drive it
// against a stub canvas.
export function drawOneFbd(ctx, anchor, entries) {
  const { lengths, anyClipped } = computeArrowLengths(entries);

  // Center dot.
  ctx.fillStyle = FBD_DOT_COLOR;
  ctx.beginPath();
  ctx.arc(anchor.x, anchor.y, FBD_DOT_RADIUS_PX, 0, 2 * Math.PI);
  ctx.fill();

  // Arrows + labels.
  ctx.lineWidth = 2;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const lenPx = lengths[i];
    const { dx, dy } = arrowTipOffsetPx(e.vec, lenPx);
    const head = { x: anchor.x + dx, y: anchor.y + dy };
    ctx.strokeStyle = e.color;
    drawArrow(ctx, anchor, head, FBD_ARROW_HEAD_PX);

    // Label sits beyond the arrowhead along the same direction.
    if (lenPx > 0) {
      const ux = dx / lenPx;
      const uy = dy / lenPx;
      const labelAnchor = {
        x: head.x + ux * FBD_LABEL_GAP_PX,
        y: head.y + uy * FBD_LABEL_GAP_PX
      };
      drawLabel(ctx, labelAnchor, e.label, e.color);
    }
  }

  // "Arrows not to scale" disclaimer when the 25% floor engaged on at
  // least one arrow. Mirrors the disclaimer rule in problems/lib/fbd.py.
  if (anyClipped) {
    ctx.fillStyle = FBD_DISCLAIMER_COLOR;
    ctx.font = FBD_DISCLAIMER_FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(
      'Arrows not to scale',
      anchor.x,
      anchor.y + FBD_ARROW_FULL_LEN_PX + 4
    );
  }
}

export const NAME = 'fbd_overlay';
