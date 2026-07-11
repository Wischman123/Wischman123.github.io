// engine/vec.js
//
// Minimal 2D vector helpers + a Phase 5.R1 vec3 namespace for
// rotational quantities (τ today, ω in R3). Functions are pure (no
// mutation) to keep the integrator's RK4 stages reasoning straightforward.
//
// Scope policy: the {x, y} 2D form remains the engine's scene-JSON
// serialization shape — schema policy keeps F (force) at vec2 because
// no scene declares an out-of-plane force vector. The vec3 namespace
// covers in-memory τ summation across forces; widening τ to vec3 is
// structurally needed once anything other than DipoleInField produces
// an out-of-plane torque (Phase 3.b damping was z-only by short-circuit;
// Phase 5.B+ may not be).
//
// Phase 5.R1 (Q4=α): vec3 helpers are PURE allocation (each operation
// returns a fresh object). The hot-path allocation cost (~128 allocs
// per derivState pass per body) is forecast for Step 6 lessons; if a
// future profiler shows GC pressure, an in-place addInPlace can land
// without changing call-site shapes.

export const zero = () => ({ x: 0, y: 0 });

export const v = (x, y) => ({ x, y });

export const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });

export const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });

export const scale = (a, s) => ({ x: a.x * s, y: a.y * s });

export const dot = (a, b) => a.x * b.x + a.y * b.y;

export const mag = (a) => Math.hypot(a.x, a.y);

export const mag2 = (a) => a.x * a.x + a.y * a.y;

export const normalize = (a) => {
  const m = mag(a);
  if (m === 0) return zero();
  return { x: a.x / m, y: a.y / m };
};

// Phase 5.R1 (Q4=α): vec3 namespace. Pure helpers; no mutation. NOT
// called at the DipoleInField τ-compute site — Q4 lock preserves the
// z-only formula `tau.z = µ.x * B.y - µ.y * B.x` bit-identically.
// Full vec3.cross would produce nonzero in-plane components for in-
// plane μ in B-along-ẑ → fires assertScalarTau immediately on every
// dipole scene.
//
// Phase 5.B Step 0b.1 (Q13): `dot` and `norm` added for the Gauss-flux
// integrator (∫ E·n̂ dA needs dot product; surface-element vectors need
// L2 norm). `norm` is Euclidean L2 (sqrt of sum-of-squares); a future
// `normSq` may land if squared-norm comparisons become load-bearing in
// the integrator (deferred per Q13 lock).
export const vec3 = {
  zero: () => ({ x: 0, y: 0, z: 0 }),
  add: (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }),
  cross: (a, b) => ({
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x
  }),
  scale: (a, s) => ({ x: a.x * s, y: a.y * s, z: a.z * s }),
  dot: (a, b) => a.x * b.x + a.y * b.y + a.z * b.z,
  norm: (a) => Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z)
};

// Phase 5.R1 (Q2=γ): runtime guard. τ is vec3 in v1's 2D engine but
// MUST remain scalar-along-ẑ at every dispatch + summation site —
// nonzero in-plane components (τ.x or τ.y) are unphysical for a 2D
// body and indicate a sign-convention slip or a misrouted force return.
// Called per-force inside scene.js's τ loop AND at the dispatch site
// AND inside computeBodyTorque (render layer).
//
// Phase 5.D Step 0b.2a: EPSILON-flip discharged. The pre-route comment
// in 5.R1 anticipated that 5.D would relax the strict-zero check to
// absorb floating-point round-off in time-varying-field flux integration.
// 5.D's actual scenes (motional EMF + stationary loop in B(t)) keep μ
// in-plane and B along ẑ, so the τ-compute site at DipoleInField
// remains analytically z-only — but the finite-difference dΦ/dt loop
// (Q14=a) accumulates O(dt²) round-off that can leak into in-plane
// components if a future force returns τ via vec3.cross under non-
// axially-aligned μ. IN_PLANE_TAU_EPS is the tolerance band: 1e-12 N·m
// matches Q7's analytic precision target and is 4 orders of magnitude
// looser than ε_machine·O(scene_torque) so true sign-convention slips
// (which produce O(1) in-plane components) still surface immediately.
// Strict ≥ comparison (not >) keeps the legacy `1e-12` boundary case
// rejecting, preserving the 5.R1 test pin at line 514 of
// dipole_in_field.test.js.
export const IN_PLANE_TAU_EPS = 1e-12;

export function assertScalarTau(tau) {
  if (!tau || typeof tau.x !== 'number' || typeof tau.y !== 'number' || typeof tau.z !== 'number') {
    throw new Error(
      `assertScalarTau: τ must be a vec3 with numeric x, y, z. Got ${JSON.stringify(tau)}.`
    );
  }
  if (Math.abs(tau.x) >= IN_PLANE_TAU_EPS || Math.abs(tau.y) >= IN_PLANE_TAU_EPS) {
    throw new Error(
      `assertScalarTau: τ has nonzero in-plane components (x=${tau.x}, y=${tau.y}, |·| ≥ ${IN_PLANE_TAU_EPS}); v1's 2D engine requires τ scalar-along-ẑ.`
    );
  }
}

// Phase 5.D Step 0b.2b: EPSILON-flip discharged. The 5.B carry-forward
// (Bundle 1) deferred a magnitude-band addition to the runtime helper
// alongside the structural CI-gate at `tools/ci/check_vec3_field_consumers.mjs`.
// `VEC3_FIELD_EPS` is the symmetric companion to `IN_PLANE_TAU_EPS`:
// 1e-12 (V/m for E-fields, T for B-fields) matches Q7's analytic precision
// band and is the floor below which 5.D's finite-difference dΦ/dt loop
// (Q14=a) can amplify FP cancellation into spurious in-plane components
// for nominally-axial fields. The constant is exported for downstream use
// by the induction integrator (Step 4(b)2) — it is NOT consumed by
// `assertVec3Field` itself, which preserves its 5.B three-throw
// categorical contract (shape / missing component / non-finite). The
// runtime helper stays bit-stable across the 5.B post-baseline; the
// EPSILON-flip lives at the integrator + CI-gate boundary instead.
// Strict ≥ comparison (matching IN_PLANE_TAU_EPS semantics) is the
// recommended convention for downstream consumers that band-check
// magnitudes against this constant.
export const VEC3_FIELD_EPS = 1e-12;

// Phase 5.B Step 0b.1: runtime guard for vec3 field samples returned by
// `E_at` / `B_at` (and any future field-evaluation surface). Pairs with
// 5.R1's `assertScalarTau` in the assertion-helper namespace; called at
// the flux integrator's per-sample site so a partial vec2→vec3 widening
// surfaces loudly with per-class attribution rather than silently
// producing NaN flux.
//
// Three-throw spec (distinct diagnostics):
//   1. shape-mismatch  — input is not a plain object (null, scalar,
//                        array, primitive); the call site passed
//                        something that isn't a vector at all.
//   2. missing component — `.x`, `.y`, or `.z` is undefined or
//                          non-numeric (this is the vec2-passed-where-
//                          vec3-expected case: `.z` missing).
//   3. non-finite       — any component is NaN or ±Infinity.
//
// `src` (optional) labels the call site (e.g., `"UniformField.E_at"`)
// so the thrown error attributes the failing producer.
//
// Phase 5.D Step 0b.2b: structural shape regressions (vec2-style
// destructure / bare in-plane component access / TimeVaryingUniformField
// B_at without preceding setTime) are now blocked statically by the
// `tools/ci/check_vec3_field_consumers.mjs` AST gate. The runtime helper
// is the in-process fallback; the gate is the build-time fence.
export function assertVec3Field(sample, src) {
  const tag = src ? ` (${src})` : '';
  // Throw 1: shape-mismatch — not a plain object.
  if (sample === null || sample === undefined || typeof sample !== 'object' || Array.isArray(sample)) {
    throw new Error(
      `assertVec3Field${tag}: expected vec3 object, got ${Array.isArray(sample) ? 'array' : typeof sample} (${JSON.stringify(sample)}).`
    );
  }
  // Throw 2: missing or non-numeric component (covers vec2-passed case).
  if (typeof sample.x !== 'number' || typeof sample.y !== 'number' || typeof sample.z !== 'number') {
    throw new Error(
      `assertVec3Field${tag}: missing or non-numeric component (x=${sample.x}, y=${sample.y}, z=${sample.z}); vec3 requires numeric x, y, z.`
    );
  }
  // Throw 3: non-finite component (NaN / ±Infinity).
  if (!Number.isFinite(sample.x) || !Number.isFinite(sample.y) || !Number.isFinite(sample.z)) {
    throw new Error(
      `assertVec3Field${tag}: non-finite component (x=${sample.x}, y=${sample.y}, z=${sample.z}); NaN or ±Infinity not permitted.`
    );
  }
}

export const NAME = 'vec';
