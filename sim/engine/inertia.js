// engine/inertia.js
//
// Phase D1 — shared moment-of-inertia library. ONE definition of each AP-C
// Unit 5 standard result, consumed by RigidBody construction (bodies.js),
// D3's L = Iω tracker, and D4's physical-pendulum I_pivot. No scene ever
// writes a raw inertia number it could get wrong: it either states an
// explicit `I_kg_m2` or an `inertia_spec` resolved HERE.
//
// All I are about the body's centre of mass, taken about the fixed
// out-of-plane (ẑ) axis, in kg·m². M is the body mass (kg); R a radius (m);
// L a full length (m). Formulas are written in division form (M·x²/k rather
// than (1/k)·M·x²) so the exact rational results — 3/12 = 0.25, 3/3 = 1.0 —
// come out exactly in IEEE-754 rather than accumulating a rounding step.
//
// Standard results:
//   hoop        I = M·R²           (thin ring / hoop about its axis)
//   disk        I = ½M·R²          (solid disk / solid cylinder about its axis)
//   solidSphere I = (2/5)M·R²
//   rodCenter   I = (1/12)M·L²     (uniform rod about its centre)
//   rodEnd      I = (1/3)M·L²      (uniform rod about one end)
//   parallelAxis(I_cm, M, d) = I_cm + M·d²   (shift the axis by distance d)

// Shared positivity guard for a mass or a linear dimension (radius/length):
// both must be finite and strictly > 0. A zero or negative value is a
// physics/authoring error, not a degenerate-but-valid case — fail loudly at
// the library boundary rather than returning a nonsensical I that
// NaN-propagates through the τ/I integrator division later.
function requirePositive(name, v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`inertia: ${name} must be a finite number (got ${v}).`);
  }
  if (!(v > 0)) {
    throw new Error(`inertia: ${name} must be > 0 (got ${v}).`);
  }
}

export function hoop(M, R) {
  requirePositive('mass M', M);
  requirePositive('radius R', R);
  return M * R * R;
}

export function disk(M, R) {
  requirePositive('mass M', M);
  requirePositive('radius R', R);
  return (M * R * R) / 2;
}

export function solidSphere(M, R) {
  requirePositive('mass M', M);
  requirePositive('radius R', R);
  return (2 * M * R * R) / 5;
}

export function rodCenter(M, L) {
  requirePositive('mass M', M);
  requirePositive('length L', L);
  return (M * L * L) / 12;
}

export function rodEnd(M, L) {
  requirePositive('mass M', M);
  requirePositive('length L', L);
  return (M * L * L) / 3;
}

// Parallel-axis theorem. I_cm may be 0 (a point mass has zero CoM inertia);
// d may be 0 (the shifted axis IS the CoM axis → no-op). Only M must be > 0.
export function parallelAxis(I_cm, M, d) {
  if (typeof I_cm !== 'number' || !Number.isFinite(I_cm) || I_cm < 0) {
    throw new Error(`inertia: I_cm must be a finite number >= 0 (got ${I_cm}).`);
  }
  requirePositive('mass M', M);
  if (typeof d !== 'number' || !Number.isFinite(d) || d < 0) {
    throw new Error(`inertia: distance d must be a finite number >= 0 (got ${d}).`);
  }
  return I_cm + M * d * d;
}

// Shape → helper dispatch, split by which linear dimension the shape needs.
// This mapping is the SINGLE place scene-facing shape names bind to the
// analytic helpers; RigidBody's constructor calls inertiaFromSpec, never a
// bare helper, so the name set stays consistent with the JSON schema enum.
const R_SHAPES = { disk, hoop, solid_sphere: solidSphere };
const L_SHAPES = { rod_center: rodCenter, rod_end: rodEnd };

// Resolve a scene `inertia_spec` ({shape, R_m | L_m}) to an I about the CoM,
// using the body's mass M (NOT a mass carried in the spec — the body has one
// mass, and I is taken about that mass). disk/hoop/solid_sphere need R_m;
// rod_center/rod_end need L_m. The individual helpers re-validate M and the
// dimension, so a non-positive value still fails loudly.
export function inertiaFromSpec(spec, M) {
  if (typeof spec !== 'object' || spec === null) {
    throw new Error(`inertia: inertia_spec must be an object {shape, R_m|L_m} (got ${spec}).`);
  }
  const shape = spec.shape;
  if (Object.prototype.hasOwnProperty.call(R_SHAPES, shape)) {
    if (typeof spec.R_m !== 'number') {
      throw new Error(
        `inertia: shape "${shape}" requires R_m (radius, metres) — got R_m=${spec.R_m}.`
      );
    }
    return R_SHAPES[shape](M, spec.R_m);
  }
  if (Object.prototype.hasOwnProperty.call(L_SHAPES, shape)) {
    if (typeof spec.L_m !== 'number') {
      throw new Error(
        `inertia: shape "${shape}" requires L_m (length, metres) — got L_m=${spec.L_m}.`
      );
    }
    return L_SHAPES[shape](M, spec.L_m);
  }
  throw new Error(
    `inertia: unknown shape "${shape}" — expected one of ` +
    `disk, hoop, solid_sphere (need R_m), rod_center, rod_end (need L_m).`
  );
}

export const NAME = 'inertia';
