// engine/flux.js
//
// Phase 5.B (Q1=α / Q3=γ) deliverable. Sole owner of `runFluxCheck` —
// the new chokepoint that computes ∮ E·dA over a user-declared closed
// surface (sphere, cylinder, pillbox) and cross-checks against
// Q_enc/ε₀.
//
// First new-physics phase post-foundation: introduces a new analytic
// claim (Gauss's law) with no preceding engine representation, a new
// geometric primitive (closed surface in 3D), and a new validator
// chokepoint signature (returns a residual, not a per-sample comparison).
//
// Locked decisions:
//   - Q1=α: trio only (sphere + cylinder + pillbox).
//   - Q3=γ: BOTH analytic AND discrete paths (analytic-primary, discrete cross-check).
//   - Q4=β: render overlay (flux_overlay.js) deferred to 5.B.UI sub-phase.
//   - Q7: per-shape × per-method tolerance bands (see TOLERANCE_BANDS below).
//   - field_kind 'magnetic' → phi_predicted = 0 (Gauss-B; no monopoles).
//   - VACUUM_PERMITTIVITY pinned in sim/engine/constants.js (Step 0b.3).
//   - assertVec3Field lives in sim/engine/vec.js (Step 0b.1) — flux.js imports it
//     for runtime verification of field samples at every quadrature point.
//
// Pillbox-cap floating-point cancellation mitigation (LOCKED for 5.B):
// the discrete integrator's pillbox path uses per-face accumulators
// that combine analytically-zero terms LAST. Specifically: sum the
// two cap contributions first (which carry the real flux), then add
// the side contribution (which should cancel to ~0 for a sheet
// scenario). Reversing the order causes catastrophic cancellation
// when |phi_side| ≫ |phi_caps|. Locked by the
// `pillbox_face_accumulator_order_locks_zero_side_flux` regression
// test in flux.test.js. JSDoc on `_pillboxDiscrete` documents the
// ordering invariant.

import { vec3, assertVec3Field } from './vec.js';
import { VACUUM_PERMITTIVITY } from './constants.js';
import {
  pointInSphere,
  pointInCylinder,
  pointInPillbox,
  pillboxCapArea
} from './containment.js';

// Default tolerance bands (Q7 lock). Per-shape × per-method.
const TOLERANCE_BANDS = {
  sphere: { analytic: 1e-12, discrete_low: 1e-3, discrete_high: 1e-6 },
  cylinder: { analytic: 1e-12, discrete_low: 1e-3, discrete_high: 1e-6 },
  pillbox: { analytic: 1e-12, discrete_low: 3e-3, discrete_high: 1e-6 }
};

// EPSILON_ABS (Q7) — below this, residual_kind switches to absolute.
const EPSILON_ABS_DEFAULT = 1e-23; // V·m
// Absolute mode tolerance is a constant fraction of EPSILON_ABS.
const TOLERANCE_ABS_DEFAULT_FRACTION = 1 / 100;

// Default discrete quadrature N for cross-check.
const N_QUADRATURE_DEFAULT = 128;

// Fold N to discrete-low or discrete-high band selection. Q7 lock:
// N ≥ 4096 → discrete_high; else discrete_low.
const DISCRETE_HIGH_N = 4096;

// ---------------------------------------------------------------------
// gaussFluxAnalytic
// ---------------------------------------------------------------------

/**
 * gaussFluxAnalytic(surfaceSpec, q_enc) → number.
 *
 * Closed-form ∮ E·dA = q_enc / ε₀ (electric Gauss). Surface-shape-
 * agnostic — any closed surface enclosing q_enc gives the same flux
 * (that IS Gauss's law). The `surfaceSpec` parameter is kept on the
 * signature for API symmetry with `gaussFluxDiscrete` (which DOES
 * inspect the geometry); analytic-mode just needs q_enc.
 *
 * @param {Object} _surfaceSpec — surface descriptor (unused for analytic mode)
 * @param {number} q_enc — net enclosed charge in coulombs
 * @returns {number} flux in V·m
 */
export function gaussFluxAnalytic(_surfaceSpec, q_enc) {
  if (typeof q_enc !== 'number' || !Number.isFinite(q_enc)) {
    throw new Error(`gaussFluxAnalytic: q_enc must be a finite number (got ${q_enc})`);
  }
  return q_enc / VACUUM_PERMITTIVITY;
}

// ---------------------------------------------------------------------
// gaussFluxDiscrete
// ---------------------------------------------------------------------

/**
 * gaussFluxDiscrete(surfaceSpec, fieldFn, N) → number.
 *
 * Discrete-method ∫ E·n̂ dA approximation via per-shape quadrature.
 * Branches on `surfaceSpec.shape`. Each branch passes every sample
 * point through `assertVec3Field` so a partial vec2→vec3 widening
 * surfaces loudly with per-source attribution.
 *
 * @param {Object} surfaceSpec — surface descriptor (per-shape required fields per SCHEMA.md)
 * @param {Function} fieldFn — point → vec3 (E or B field-eval closure)
 * @param {number} N — quadrature point count
 * @returns {number} numerical flux
 */
export function gaussFluxDiscrete(surfaceSpec, fieldFn, N) {
  if (!surfaceSpec || typeof surfaceSpec !== 'object') {
    throw new Error('gaussFluxDiscrete: surfaceSpec must be an object');
  }
  if (typeof fieldFn !== 'function') {
    throw new Error('gaussFluxDiscrete: fieldFn must be a function (point → vec3)');
  }
  if (!Number.isInteger(N) || N < 1) {
    throw new Error(`gaussFluxDiscrete: N must be a positive integer (got ${N})`);
  }
  if (surfaceSpec.shape === 'sphere') return _sphereDiscrete(surfaceSpec, fieldFn, N);
  if (surfaceSpec.shape === 'cylinder') return _cylinderDiscrete(surfaceSpec, fieldFn, N);
  if (surfaceSpec.shape === 'pillbox') return _pillboxDiscrete(surfaceSpec, fieldFn, N);
  throw new Error(`gaussFluxDiscrete: unsupported shape "${surfaceSpec.shape}"`);
}

// ---------------------------------------------------------------------
// runFluxCheck — chokepoint
// ---------------------------------------------------------------------

/**
 * runFluxCheck(scene, surface, fieldFn, options) →
 *   { phi_numeric, phi_predicted, residual, residual_kind, passed }
 *
 * Wraps gaussFluxAnalytic + gaussFluxDiscrete and computes the
 * residual gate per Q7's two-mode policy (relative / absolute).
 *
 * Field-agnostic: pass `options.field_kind = 'magnetic'` for Gauss-B
 * (∮ B·dA = 0 by no-monopoles); 5.D induction inherits this without
 * re-litigation (locked by the B_at zero-flux unit test).
 *
 * @param {Object} scene — scene with bodies + scene_defaults; used to compute Q_enc when not passed
 * @param {Object} surface — gauss_surface entry
 * @param {Function} fieldFn — point → vec3
 * @param {Object} [options]
 * @param {number} [options.tolerance_rel] — relative-mode tolerance; default per-(shape, method) Q7 band
 * @param {number} [options.tolerance_abs] — absolute-mode tolerance; default EPSILON_ABS / 100
 * @param {number} [options.epsilon_abs] — switch from relative to absolute mode below this |phi_predicted|
 * @param {string} [options.method] — 'analytic' (default) | 'discrete'
 * @param {number} [options.N_quadrature] — N for discrete (default 128)
 * @param {string} [options.field_kind] — 'electric' (default) | 'magnetic'
 * @param {number} [options.q_enc] — explicit Q_enc (overrides scene-walk)
 */
export function runFluxCheck(scene, surface, fieldFn, options = {}) {
  if (!surface || typeof surface !== 'object') {
    throw new Error('runFluxCheck: surface must be an object');
  }
  if (typeof fieldFn !== 'function') {
    throw new Error('runFluxCheck: fieldFn must be a function (point → vec3)');
  }
  const method = options.method ?? 'analytic';
  if (method !== 'analytic' && method !== 'discrete') {
    throw new Error(`runFluxCheck: unsupported method "${method}" (use 'analytic' or 'discrete')`);
  }
  const fieldKind = options.field_kind ?? 'electric';
  // 1. Predicted flux.
  let phi_predicted;
  if (fieldKind === 'magnetic') {
    // Gauss-B: ∮ B·dA = 0 (no monopoles). Locked field-agnostic API.
    phi_predicted = 0;
  } else {
    const q_enc = (options.q_enc !== undefined) ? options.q_enc : _computeQ_enc(scene, surface);
    phi_predicted = gaussFluxAnalytic(surface, q_enc);
  }
  // 2. Numerical flux.
  let phi_numeric;
  if (method === 'analytic') {
    phi_numeric = phi_predicted;
  } else {
    const N = options.N_quadrature ?? N_QUADRATURE_DEFAULT;
    phi_numeric = gaussFluxDiscrete(surface, fieldFn, N);
  }
  // 3. Residual gate (Q7 two-mode).
  const epsilon_abs = options.epsilon_abs ?? EPSILON_ABS_DEFAULT;
  const residual_kind = Math.abs(phi_predicted) < epsilon_abs ? 'absolute' : 'relative';
  let residual;
  let tolerance;
  if (residual_kind === 'relative') {
    residual = Math.abs(phi_numeric - phi_predicted) / Math.abs(phi_predicted);
    if (options.tolerance_rel !== undefined) {
      tolerance = options.tolerance_rel;
    } else {
      const band = TOLERANCE_BANDS[surface.shape];
      if (!band) {
        throw new Error(`runFluxCheck: no tolerance band for shape "${surface.shape}"`);
      }
      const N = options.N_quadrature ?? N_QUADRATURE_DEFAULT;
      tolerance = method === 'analytic' ? band.analytic
        : (N >= DISCRETE_HIGH_N ? band.discrete_high : band.discrete_low);
    }
  } else {
    residual = Math.abs(phi_numeric - phi_predicted);
    tolerance = options.tolerance_abs ?? (epsilon_abs * TOLERANCE_ABS_DEFAULT_FRACTION);
  }
  const passed = residual <= tolerance;
  return { phi_numeric, phi_predicted, residual, residual_kind, passed };
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function _toVec3(p) {
  if (!p || typeof p !== 'object') return p;
  return { x: p.x, y: p.y, z: typeof p.z === 'number' ? p.z : 0 };
}

function _computeQ_enc(scene, surface) {
  let q = 0;
  for (const b of scene?.bodies ?? []) {
    const pos = _toVec3(b?.position_m);
    if (!pos) continue;
    let inside = false;
    if (surface.shape === 'sphere') inside = pointInSphere(pos, surface.center, surface.radius);
    else if (surface.shape === 'cylinder') inside = pointInCylinder(pos, surface.center, surface.axis, surface.radius, surface.length);
    else if (surface.shape === 'pillbox') inside = pointInPillbox(pos, surface.center, surface.axis, surface.cap_shape, surface.cap_dim, surface.thickness);
    if (!inside) continue;
    const c = b?.charge_C;
    if (typeof c === 'number' && Number.isFinite(c)) q += c;
  }
  return q;
}

// ---------------------------------------------------------------------
// Per-shape discrete integrators
// ---------------------------------------------------------------------

/**
 * Sphere discrete integrator. N quadrature points distributed via
 * the Fibonacci sphere algorithm (uniform-on-sphere). Each surface
 * element has area dA = 4πR² / N; outward normal n̂ = r̂.
 */
function _sphereDiscrete(s, fieldFn, N) {
  const R = s.radius;
  const area_per_pt = (4 * Math.PI * R * R) / N;
  let phi = 0;
  // Fibonacci-sphere distribution.
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < N; i++) {
    const y_unit = 1 - (i / (N - 1)) * 2; // -1..+1
    const radius_xy = Math.sqrt(1 - y_unit * y_unit);
    const theta = golden * i;
    const x_unit = Math.cos(theta) * radius_xy;
    const z_unit = Math.sin(theta) * radius_xy;
    const point = {
      x: s.center.x + R * x_unit,
      y: s.center.y + R * y_unit,
      z: s.center.z + R * z_unit
    };
    const E = fieldFn(point);
    assertVec3Field(E, '_sphereDiscrete.fieldFn');
    // n̂ = unit-radial; dot E·n̂.
    const dot = E.x * x_unit + E.y * y_unit + E.z * z_unit;
    phi += dot * area_per_pt;
  }
  return phi;
}

/**
 * Cylinder discrete integrator. Splits N between side and the two
 * caps; sums caps first, then side (FP-cancellation locked order
 * per pillbox precedent — though for cylinder enclosing a line the
 * caps are typically the small contribution).
 *
 * For simplicity: split N ≈ 2/3 to side, 1/6 to each cap.
 */
function _cylinderDiscrete(s, fieldFn, N) {
  const N_side = Math.max(2, Math.floor(N * (2 / 3)));
  const N_cap = Math.max(1, Math.floor((N - N_side) / 2));
  const axis = s.axis;
  // Build orthonormal basis (axis, e1, e2).
  const { e1, e2 } = _orthonormalBasis(axis);
  // Caps first.
  let phi_cap_top = _diskCapDiscrete(s.center, axis, e1, e2, s.radius, fieldFn, N_cap, +1, s.length / 2);
  let phi_cap_bot = _diskCapDiscrete(s.center, axis, e1, e2, s.radius, fieldFn, N_cap, -1, s.length / 2);
  // Side last.
  let phi_side = _cylinderSideDiscrete(s.center, axis, e1, e2, s.radius, s.length, fieldFn, N_side);
  return (phi_cap_top + phi_cap_bot) + phi_side;
}

/**
 * Pillbox discrete integrator. **Per-face accumulator order locks
 * zero-side-flux**: sum the two cap contributions FIRST, then add
 * the side contribution. Reversing this order produces catastrophic
 * FP cancellation when the pillbox straddles a uniform-σ sheet:
 * |phi_side| should be ~0 from symmetry but can carry FP noise that
 * dwarfs |phi_caps| if added first. Locked by the
 * `pillbox_face_accumulator_order_locks_zero_side_flux` regression
 * test in flux.test.js.
 */
function _pillboxDiscrete(s, fieldFn, N) {
  const N_side = Math.max(2, Math.floor(N * (1 / 3)));
  const N_cap = Math.max(1, Math.floor((N - N_side) / 2));
  const axis = s.axis;
  const { e1, e2 } = _orthonormalBasis(axis);
  const half_t = s.thickness / 2;
  // Caps first (the load-bearing contribution).
  const phi_cap_top = _capDiscrete(s, axis, e1, e2, fieldFn, N_cap, +1, half_t);
  const phi_cap_bot = _capDiscrete(s, axis, e1, e2, fieldFn, N_cap, -1, half_t);
  const phi_caps = phi_cap_top + phi_cap_bot;
  // Side last (analytically-zero for the sheet scenario; FP residual).
  const phi_side = _pillboxSideDiscrete(s, axis, e1, e2, fieldFn, N_side);
  return phi_caps + phi_side;
}

// Cap quadrature dispatching by cap_shape.
function _capDiscrete(s, axis, e1, e2, fieldFn, N, sign, half_t) {
  if (s.cap_shape === 'disk') {
    return _diskCapDiscrete(s.center, axis, e1, e2, s.cap_dim, fieldFn, N, sign, half_t);
  }
  if (s.cap_shape === 'square') {
    return _squareCapDiscrete(s.center, axis, e1, e2, s.cap_dim, fieldFn, N, sign, half_t);
  }
  throw new Error(`_capDiscrete: unknown cap_shape "${s.cap_shape}"`);
}

// Disk cap quadrature: concentric-rings sampling. Each ring carries
// area-weight = annular-area / pts-on-ring; outward normal = sign·axis.
function _diskCapDiscrete(center, axis, e1, e2, radius, fieldFn, N, sign, offset_along_axis) {
  const cap_center = {
    x: center.x + sign * offset_along_axis * axis.x,
    y: center.y + sign * offset_along_axis * axis.y,
    z: center.z + sign * offset_along_axis * axis.z
  };
  const total_area = Math.PI * radius * radius;
  const dA = total_area / N;
  let phi = 0;
  // Stratified-uniform quadrature: sample on a quasi-random Sunflower
  // (Vogel) pattern in (r, theta) space inside the disk.
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < N; i++) {
    const r = radius * Math.sqrt((i + 0.5) / N);
    const theta = golden * i;
    const u1 = r * Math.cos(theta);
    const u2 = r * Math.sin(theta);
    const point = {
      x: cap_center.x + u1 * e1.x + u2 * e2.x,
      y: cap_center.y + u1 * e1.y + u2 * e2.y,
      z: cap_center.z + u1 * e1.z + u2 * e2.z
    };
    const E = fieldFn(point);
    assertVec3Field(E, '_diskCapDiscrete.fieldFn');
    const dot_with_axis = E.x * axis.x + E.y * axis.y + E.z * axis.z;
    phi += sign * dot_with_axis * dA;
  }
  return phi;
}

// Square cap quadrature: regular grid. side² area; dA = side²/N.
function _squareCapDiscrete(center, axis, e1, e2, side, fieldFn, N, sign, offset_along_axis) {
  const cap_center = {
    x: center.x + sign * offset_along_axis * axis.x,
    y: center.y + sign * offset_along_axis * axis.y,
    z: center.z + sign * offset_along_axis * axis.z
  };
  const total_area = side * side;
  const k = Math.max(1, Math.round(Math.sqrt(N)));
  const k2 = k * k;
  const dA = total_area / k2;
  const half = side / 2;
  let phi = 0;
  for (let i = 0; i < k; i++) {
    for (let j = 0; j < k; j++) {
      const u1 = (-half) + ((i + 0.5) / k) * side;
      const u2 = (-half) + ((j + 0.5) / k) * side;
      const point = {
        x: cap_center.x + u1 * e1.x + u2 * e2.x,
        y: cap_center.y + u1 * e1.y + u2 * e2.y,
        z: cap_center.z + u1 * e1.z + u2 * e2.z
      };
      const E = fieldFn(point);
      assertVec3Field(E, '_squareCapDiscrete.fieldFn');
      const dot_with_axis = E.x * axis.x + E.y * axis.y + E.z * axis.z;
      phi += sign * dot_with_axis * dA;
    }
  }
  return phi;
}

// Cylinder-side quadrature: side area = 2πR·L; dA = side_area/N.
// Outward normal at angle θ = cos(θ)·e1 + sin(θ)·e2 (radial-perp).
function _cylinderSideDiscrete(center, axis, e1, e2, radius, length, fieldFn, N) {
  const side_area = 2 * Math.PI * radius * length;
  const N_axial = Math.max(2, Math.round(Math.sqrt(N * length / (2 * Math.PI * radius))));
  const N_circ = Math.max(2, Math.floor(N / N_axial));
  const total = N_axial * N_circ;
  const dA = side_area / total;
  const half_L = length / 2;
  let phi = 0;
  for (let ia = 0; ia < N_axial; ia++) {
    const along = (-half_L) + ((ia + 0.5) / N_axial) * length;
    for (let ic = 0; ic < N_circ; ic++) {
      const theta = (ic / N_circ) * 2 * Math.PI;
      const c = Math.cos(theta);
      const s_ = Math.sin(theta);
      const nx = c * e1.x + s_ * e2.x;
      const ny = c * e1.y + s_ * e2.y;
      const nz = c * e1.z + s_ * e2.z;
      const point = {
        x: center.x + along * axis.x + radius * nx,
        y: center.y + along * axis.y + radius * ny,
        z: center.z + along * axis.z + radius * nz
      };
      const E = fieldFn(point);
      assertVec3Field(E, '_cylinderSideDiscrete.fieldFn');
      const dot = E.x * nx + E.y * ny + E.z * nz;
      phi += dot * dA;
    }
  }
  return phi;
}

// Pillbox-side quadrature. The side wraps the axis like a thin
// cylinder/box of perimeter `P` × thickness. For disk-cap pillbox:
// side is a thin cylinder of radius cap_dim, length thickness.
// For square-cap pillbox: side is 4 rectangular faces of width
// cap_dim, height thickness.
function _pillboxSideDiscrete(s, axis, e1, e2, fieldFn, N) {
  if (s.cap_shape === 'disk') {
    return _cylinderSideDiscrete(s.center, axis, e1, e2, s.cap_dim, s.thickness, fieldFn, N);
  }
  // Square pillbox: 4 faces. Each face has width=cap_dim, height=thickness.
  // Outward normal = ±e1 or ±e2 depending on face.
  const half_d = s.cap_dim / 2;
  const half_t = s.thickness / 2;
  const N_face = Math.max(1, Math.floor(N / 4));
  // Treat each face as a regular grid; allocate quadrature points.
  const k_w = Math.max(1, Math.round(Math.sqrt(N_face)));
  const k_h = Math.max(1, Math.floor(N_face / k_w));
  const dA = (s.cap_dim * s.thickness) / (k_w * k_h);
  let phi = 0;
  // Helper: sample face given (face_normal, face_tangent, face_tangent_axial).
  const sampleFace = (n_dir, sign_n, t_dir) => {
    let local_phi = 0;
    for (let iw = 0; iw < k_w; iw++) {
      const u_t = (-half_d) + ((iw + 0.5) / k_w) * s.cap_dim;
      for (let ih = 0; ih < k_h; ih++) {
        const u_a = (-half_t) + ((ih + 0.5) / k_h) * s.thickness;
        // Position: center + u_a·axis + sign_n·half_d·n_dir + u_t·t_dir
        const point = {
          x: s.center.x + u_a * axis.x + sign_n * half_d * n_dir.x + u_t * t_dir.x,
          y: s.center.y + u_a * axis.y + sign_n * half_d * n_dir.y + u_t * t_dir.y,
          z: s.center.z + u_a * axis.z + sign_n * half_d * n_dir.z + u_t * t_dir.z
        };
        const E = fieldFn(point);
        assertVec3Field(E, '_pillboxSideDiscrete.fieldFn');
        const dot = sign_n * (E.x * n_dir.x + E.y * n_dir.y + E.z * n_dir.z);
        local_phi += dot * dA;
      }
    }
    return local_phi;
  };
  phi += sampleFace(e1, +1, e2);
  phi += sampleFace(e1, -1, e2);
  phi += sampleFace(e2, +1, e1);
  phi += sampleFace(e2, -1, e1);
  return phi;
}

/**
 * _orthonormalBasis(axis) → {e1, e2} — both perpendicular to `axis`,
 * mutually perpendicular, unit-length. Uses Gram-Schmidt against a
 * stable seed vector (smallest world-axis component). e2 = axis × e1.
 */
function _orthonormalBasis(axis) {
  const ax = Math.abs(axis.x);
  const ay = Math.abs(axis.y);
  const az = Math.abs(axis.z);
  let seed;
  if (ax <= ay && ax <= az) seed = { x: 1, y: 0, z: 0 };
  else if (ay <= az) seed = { x: 0, y: 1, z: 0 };
  else seed = { x: 0, y: 0, z: 1 };
  const cross1 = vec3.cross(axis, seed);
  const m1 = vec3.norm(cross1);
  if (m1 === 0) {
    throw new Error('_orthonormalBasis: degenerate axis');
  }
  const e1 = { x: cross1.x / m1, y: cross1.y / m1, z: cross1.z / m1 };
  const e2 = vec3.cross(axis, e1);
  // e2 is automatically unit since axis ⊥ e1 and both unit.
  return { e1, e2 };
}

// ---------------------------------------------------------------------
// contributeDiagnostics — Phase A0 producer surface
// ---------------------------------------------------------------------
//
// Phase A0 registers `flux.js` as a diagnostics PRODUCER: scene.js pushes
// this module onto the ConservationTracker's `producers` list when the
// scene declares `gauss_surfaces`, and the tracker walks it in `current()`
// with the shared `(map, sceneCtx)` contract — the same surface the
// circuit producer (circuits.js) uses. Before A0 the only EM producer
// registered was the circuit; Gauss flux was computed-but-invisible.
//
// For each declared Gaussian surface we emit, as OBSERVATION-ONLY
// diagnostics:
//
//   q_enc_<surface_id>  = Σ charge of live bodies inside the surface
//   flux_E_<surface_id> = q_enc / ε₀   (Gauss's law — shape-agnostic)
//
// Why the analytic flux (q_enc/ε₀) and NOT the discrete quadrature: this
// is a per-snapshot live readout for the inspector (A1) and canvas (A2),
// not a validation cross-check. Gauss's law makes the analytic flux EXACT
// for any closed surface enclosing q_enc, at O(bodies) cost — the discrete
// ∮E·dA (`gaussFluxDiscrete`, 128+ quadrature points per tick) is the
// validation path (em_validation.js) and is far too expensive to run every
// frame. magnetic Gauss surfaces (no monopoles) would give q_enc = 0 ⇒
// flux 0, consistent with `runFluxCheck`'s field_kind='magnetic' branch.
//
// q_enc is computed from LIVE engine bodies (`.position` + `.charge`), not
// the static scene JSON, so a moving charge crossing the surface updates
// the flux. (`_computeQ_enc` above reads the JSON `.position_m` /
// `.charge_C` shape for the validation path; this walks the runtime Body
// objects — same containment predicates, different source.)
//
// Pure read; never mutates engine state. Diagnostics-only by contract
// (energy.js header): nothing here touches `total` or `drift_pct`.
//
// @param {Object} map      — diagnostic-keyed map (mutated in place)
// @param {Object} sceneCtx — runner scene context; reads `gauss_surfaces`
//                            and the live `bodies` list.
export function contributeDiagnostics(map, sceneCtx) {
  const surfaces = sceneCtx?.gauss_surfaces;
  if (!Array.isArray(surfaces)) return;
  const bodies = sceneCtx?.bodies ?? [];
  for (const surface of surfaces) {
    const q_enc = _qEncFromLiveBodies(bodies, surface);
    map[`q_enc_${surface.id}`] = q_enc;
    map[`flux_E_${surface.id}`] = gaussFluxAnalytic(surface, q_enc);
  }
}

// Live-body sibling of `_computeQ_enc`. Walks the runtime Body objects
// (`.position` {x,y}, `.charge`) instead of the scene-JSON shape
// (`.position_m`, `.charge_C`), using the same per-shape containment
// predicates. Engine bodies are 2-D in-plane, so z defaults to 0.
function _qEncFromLiveBodies(bodies, surface) {
  let q = 0;
  for (const b of bodies) {
    const p = b?.position;
    if (!p) continue;
    const pos = { x: p.x, y: p.y, z: typeof p.z === 'number' ? p.z : 0 };
    let inside = false;
    if (surface.shape === 'sphere') {
      inside = pointInSphere(pos, surface.center, surface.radius);
    } else if (surface.shape === 'cylinder') {
      inside = pointInCylinder(pos, surface.center, surface.axis, surface.radius, surface.length);
    } else if (surface.shape === 'pillbox') {
      inside = pointInPillbox(pos, surface.center, surface.axis, surface.cap_shape, surface.cap_dim, surface.thickness);
    }
    if (!inside) continue;
    const c = b?.charge;
    if (typeof c === 'number' && Number.isFinite(c)) q += c;
  }
  return q;
}

export const NAME = 'flux';
