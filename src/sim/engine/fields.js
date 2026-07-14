// engine/fields.js
//
// Field types. Phase D shipped UniformField. Phase 3.2 extends with
// RadialField (point-source E, 1/r² falloff) — a non-uniform field
// representing the electric field of a fixed source charge. Phase 3.3
// adds DipoleField (axial magnetic dipole source, 1/r³ B-field falloff).
// Phase 3.5 adds LinearGradientField (B = B_0 + g_grad·r̂_dir along a
// principal axis; non-Maxwell-physical but pedagogically clean).
//
// Phase D (E&M proof slice). Fields are registered by id in a Map on
// sceneCtx; LorentzForce references one via its `field_id`. The Map
// pattern matches sceneCtx.surfaces — the loader is the single owner.
//
// Interface (every Field subclass):
//   - id : string
//   - type : string (matches the `type` enum in scene.schema.json)
//   - E_at(point) : vec3 {x, y, z} of the electric field at point
//       (Phase 5.B Step 4(b) substep 3 widened from vec2 → vec3 across
//       all four field classes, additive z=0; the new flux integrator
//       requires vec3 samples for ∫ E·n̂ dA over 3D Gaussian surfaces.
//       Existing 2D consumers — canvas2d.js, fbd_overlay.js, forces.js
//       — were verified at Step 0c to use member-access (.x / .y) and
//       remain unaffected. assertVec3Field — paired with assertScalarTau
//       in vec.js — is the runtime guard at flux-integrator sample sites.)
//   - B_at(point) : 3D vector {x, y, z} of the magnetic field at point
//   - potential_at(point) : scalar V/q for the electric field at point
//       (gauge: V → 0 at infinity for non-uniform fields; UniformField
//        and DipoleField return 0 — magnetic vector potential A is
//        gauge-dependent and out of v0 scope)
//
// Optional methods:
//   - gradB_z_at(point) : 2D vec2 {x, y} — in-plane gradient of the
//       scalar B_z field. DipoleField-only at v0 (Phase 3.3 SD-3).
//       Phase 3.5: kept for backward compat; new dipole-in-field
//       force uses gradB_at instead.
//   - gradB_at(point) : 2x2 tensor {xx, xy, yx, yy} — in-plane
//       gradient of the in-plane B vector. Element naming:
//       grad.ij = ∂_i B_j (row index = spatial-derivative direction,
//       column index = field-direction). Phase 3.5 (Q3=A): added to
//       DipoleField AND LinearGradientField. UniformField does NOT
//       implement this (∇B = 0); UniformField declares
//       `static capabilities = { gradient: false }` (Q10=A) so the
//       force class can fall back to F = 0 by capability check
//       instead of duck-typing.
//
// Phase 3.5 capability convention (Q10=A): every Field class declares
// `static capabilities` with at least `{ gradient: boolean }`. ANY
// Field class that lacks BOTH `gradB_at` AND
// `capabilities.gradient === false` is a scene-load error — the
// validation gate fires once at scene-load time (NOT per substep).
//
// UniformField returns the same vectors regardless of point. Position-
// dependent fields override these methods.

export class UniformField {
  // Phase 3.5 (Q10=A): capability struct on the class. `gradient: false`
  // tells DipoleInField (and any future gradient-consuming force) that
  // this field has ∇B ≡ 0 by construction — fall back to F = 0 instead
  // of throwing on `field.gradB_at` lookup. NEW debt-id:
  // `capability-flag-convention` — every future Field class must
  // declare a sibling capabilities struct.
  static capabilities = { gradient: false };

  constructor({ id, type, E_V_per_m, B_T }) {
    if (type !== 'uniform') {
      throw new Error(
        `UniformField requires type="uniform" (got "${type}"). ` +
        `Other field types (point_charge) are deferred to ` +
        `long-range Phase 5.`
      );
    }
    this.id = id;
    this.type = type;
    // E is 2D in v1 (the engine is 2D); the schema's vec2 carries no
    // load-bearing z component for E. Default missing components to
    // zero so a scene with B-only or E-only is well-formed.
    this.E = E_V_per_m
      ? { x: E_V_per_m.x ?? 0, y: E_V_per_m.y ?? 0 }
      : { x: 0, y: 0 };
    // B is 3D — a charge moving in-plane with a z-component magnetic
    // field experiences an in-plane Lorentz force. LorentzForce throws
    // a clear error if a Bx/By component would yield an out-of-plane
    // force on a 2D body.
    this.B = B_T
      ? { x: B_T.x ?? 0, y: B_T.y ?? 0, z: B_T.z ?? 0 }
      : { x: 0, y: 0, z: 0 };
  }

  E_at(/* point */) {
    // Phase 5.B Step 4(b) substep 3: vec3 widening (additive z=0).
    return { x: this.E.x, y: this.E.y, z: 0 };
  }

  B_at(/* point */) {
    return { x: this.B.x, y: this.B.y, z: this.B.z };
  }

  // Uniform-field scalar potential. The "true" potential is V = -E·r in
  // 2D, but that's path-dependent (V depends on the chosen origin) and
  // the cycloid scene's energy.total has always been excluded from the
  // drift-budget closure check via SKIP. Returning 0 here is a deliberate
  // gauge choice that keeps Phase 3.2's LorentzForce.potentialEnergy
  // wiring backwards-compatible: q × 0 = 0 → cycloid energy.total
  // unchanged, drift-budget continues to SKIP. Non-uniform fields (which
  // have an unambiguous V → 0 at infinity gauge) override this.
  potential_at(/* point */) {
    return 0;
  }
}

// RadialField — point-source electric field. E ∝ 1/r² along the
// separation vector from a fixed `center` carrying charge `charge_C`.
// B is identically zero (radial fields are purely electric in v1).
//
// Singularity policy: evaluating any of E_at, B_at, potential_at AT the
// center throws Error('RadialField evaluated at center'). Bodies cannot
// occupy the source-charge location physically; surfacing the failure at
// query time is preferable to silently masking it as 0.
//
// Phase 3.2 deliverable §3.2.3. Tests in `__tests__/radial_field.test.js`.
export class RadialField {
  // Phase 3.5 (Q10=A): RadialField is purely electric (B ≡ 0 by
  // construction). Magnetic-gradient consumers (DipoleInField) treat
  // B = 0 → ∇B = 0 → F = 0 — same outcome as UniformField. Declaring
  // `gradient: false` documents that intent.
  static capabilities = { gradient: false };

  constructor({ id, type, center, charge_C }) {
    if (type !== 'radial') {
      throw new Error(
        `RadialField requires type="radial" (got "${type}").`
      );
    }
    this.id = id;
    this.type = type;
    this.center = { x: center.x, y: center.y };
    this.charge_C = charge_C;
  }

  _separation(point) {
    const dx = point.x - this.center.x;
    const dy = point.y - this.center.y;
    const r2 = dx * dx + dy * dy;
    if (r2 === 0) {
      throw new Error('RadialField evaluated at center');
    }
    return { dx, dy, r: Math.sqrt(r2), r2 };
  }

  E_at(point) {
    const { dx, dy, r, r2 } = this._separation(point);
    // E = k_e × Q × r̂ / r² = k_e × Q × (dx, dy) / r³
    const r3 = r2 * r;
    const k = COULOMB_DEFAULT_K_E * this.charge_C / r3;
    // Phase 5.B Step 4(b) substep 3: vec3 widening (additive z=0).
    // The radial source's center is in-plane; in 5.B's 2D-projected
    // gauss scenes the field has no axial component.
    return { x: k * dx, y: k * dy, z: 0 };
  }

  B_at(point) {
    // Even though B is identically zero, validate the singularity for a
    // consistent contract — querying at center is always a scene bug.
    this._separation(point);
    return { x: 0, y: 0, z: 0 };
  }

  potential_at(point) {
    const { r } = this._separation(point);
    return COULOMB_DEFAULT_K_E * this.charge_C / r;
  }
}

// Coulomb constant SI value, N·m²/C². Mirrors the constant exported by
// `sim/validation/em_validation.js` (which Phase 3.1 uses for Coulomb-
// pair PE). Re-declared here to avoid a cycle: validation/em_validation
// already imports from engine paths in tests, and a back-import would
// fail on Node's ESM module resolution.
// EXPORTED (roadmap F1 / sim_equipotential_overlay P1) so field_sampler.js
// imports ONE canonical k_e rather than hand-copying a 4th literal. See the
// "Known limitations / debt" block in sim/engine/field_sampler.js for the
// pre-existing k_e triple-duplication (forces.js re-declares its own
// 8.9876e9 in the Coulomb ctor + static pairEnergy) — F1 does NOT touch
// forces.js; that duplication predates this work and is recorded as debt.
export const COULOMB_DEFAULT_K_E = 8.9876e9;

// pointChargeField — shared single point-charge electric field + potential
// at an arbitrary world point. This is the factored-out single-charge math
// that RadialField.E_at / potential_at above already implement inline and
// that Coulomb.applyTo / Coulomb.potentialEnergy (forces.js) still carry as
// force/energy cousins. field_sampler.js (roadmap F1) IMPORTS and USES this
// so the sampler does not hand-copy the formula a third time; forces.js may
// later adopt it as `force = q_test · E` (a forces.js → fields.js import,
// which is cycle-free because fields.js imports nothing). Returns a 2-D E
// {x, y} (the sampler contract is 2-D), NOT the vec3 {x, y, z:0} that
// RadialField.E_at returns.
//   E = k_e · q · (dx, dy) / r³ ,  V = k_e · q / r ,  (dx, dy) = point − center
// Throws at the exact charge location (r² === 0), mirroring RadialField's
// center-singularity contract; callers that mask a clip radius never reach
// the throw (they distance-test first).
export function pointChargeField(point, q, center, k_e = COULOMB_DEFAULT_K_E) {
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  const r2 = dx * dx + dy * dy;
  if (r2 === 0) {
    throw new Error('pointChargeField evaluated at charge location');
  }
  const r = Math.sqrt(r2);
  const r3 = r2 * r;
  const k = k_e * q / r3;
  return {
    E: { x: k * dx, y: k * dy },
    V: k_e * q / r,
  };
}

// Magnetic constant μ₀ / (4π), SI. Exact by definition: 10⁻⁷ T·m/A.
// Used by DipoleField for B = -(μ₀/4π) μ_s/r³ × ẑ at in-plane samples.
const MU0_OVER_4PI = 1e-7;

// Magnetic constant μ₀ / (2π), SI. Exact by definition: 2×10⁻⁷ T·m/A
// (= 2 × MU0_OVER_4PI). Used by CurrentWireField for the infinite
// straight-wire Ampère law B = (μ₀/2π) I / r · φ̂ at in-plane samples.
const MU0_OVER_2PI = 2e-7;

// Magnetic constant μ₀, SI. Exact by definition: 4π × 10⁻⁷ T·m/A
// (= 4π × MU0_OVER_4PI). Used by CurrentWireField's `solenoid` mode for the
// idealized-infinite interior field B = μ₀ n I (uniform inside the bore, 0
// outside). Phase C1b.
const MU0 = 4 * Math.PI * MU0_OVER_4PI;

// DipoleField — axial magnetic dipole source. μ_source pinned along ẑ
// (Q2=a constraint at v0). At any in-plane sample point:
//   B(r⃗) = -(μ₀/4π) × μ_s / r³ × ẑ          (pure ẑ; in-plane components zero)
//   ∇B_z(r⃗) = +3(μ₀/4π) × μ_s / r⁴ × r̂      (in-plane gradient; vec2)
//
// The plus sign on ∇B_z reflects ∂/∂r [-(μ₀/4π) μ_s / r³] = +3(μ₀/4π) μ_s / r⁴
// projected onto r̂. The DipoleInField force computes F = μ_z × ∇B_z,
// giving F < 0 (radially inward, attractive) for opposite-sign moments.
//
// Singularity policy (SD-8): all four public methods (B_at, E_at,
// potential_at, gradB_z_at) route through _separation and throw at
// r=0. Bodies cannot occupy the source-dipole location physically;
// surfacing the failure at query time is preferable to silently
// masking with 0.
//
// Phase 3.3 deliverable §3.3.3. Tests in `__tests__/dipole_field.test.js`.
export class DipoleField {
  // Phase 3.5 (Q10=A): DipoleField has a real gradient. Force classes
  // can read `DipoleField.capabilities.gradient` to know `gradB_at` is
  // implemented without duck-typing.
  static capabilities = { gradient: true };

  constructor({ id, type, center, mu_z_J_per_T }) {
    if (type !== 'dipole') {
      throw new Error(
        `DipoleField requires type="dipole" (got "${type}").`
      );
    }
    this.id = id;
    this.type = type;
    this.center = { x: center.x, y: center.y };
    this.mu_z_J_per_T = mu_z_J_per_T;
  }

  _separation(point) {
    const dx = point.x - this.center.x;
    const dy = point.y - this.center.y;
    const r2 = dx * dx + dy * dy;
    if (r2 === 0) {
      throw new Error('DipoleField evaluated at center');
    }
    const r = Math.sqrt(r2);
    return { dx, dy, r, r2 };
  }

  E_at(point) {
    // SD-8: even though E is identically zero (a static magnetic dipole
    // produces no electric field in this approximation), validate the
    // singularity for a consistent contract — querying at center is
    // always a scene bug. Mirror RadialField.B_at's belt-and-suspenders.
    this._separation(point);
    // Phase 5.B Step 4(b) substep 3: vec3 widening (additive z=0).
    return { x: 0, y: 0, z: 0 };
  }

  B_at(point) {
    const { r, r2 } = this._separation(point);
    // r³ via r × r²; avoids one Math.sqrt vs Math.pow(r, 3).
    const r3 = r * r2;
    const Bz = -MU0_OVER_4PI * this.mu_z_J_per_T / r3;
    // SD-7: vec3 with explicit zero in-plane components — mirrors
    // UniformField.B_at and RadialField.B_at so consumers reading
    // B.x / B.y / B.z (LorentzForce, render layers) work uniformly.
    return { x: 0, y: 0, z: Bz };
  }

  potential_at(point) {
    // SD-8: route through _separation so center queries throw consistently.
    // Magnetic vector potential A is gauge-dependent and out of v0 scope;
    // returning 0 mirrors UniformField's gauge choice and keeps any future
    // LorentzForce.potentialEnergy wiring backwards-compatible.
    this._separation(point);
    return 0;
  }

  // Optional Field-interface method (SD-3: DipoleField-only at v0).
  // Returns the in-plane gradient of B_z as a vec2 {x, y}. Forces using
  // this method must type-check at runtime — see DipoleInField in
  // forces.js for the clear-error pattern.
  //
  // Phase 3.5 (Q3=A): retained for backward compat with the 3.3
  // axial-only DipoleInField branch. The new full-tensor
  // `gradB_at` is the canonical Phase-3.5+ path; new force classes
  // use `gradB_at`. NEW debt-id: `dipolefield-api-duplication` —
  // collapse to a single tensor method (axial as a slice) at Phase 5+
  // once no caller depends on the vec2 form.
  gradB_z_at(point) {
    const { dx, dy, r, r2 } = this._separation(point);
    // r⁴ via (r²)²; avoids Math.pow(r, 4).
    const r4 = r2 * r2;
    // ∇B_z = +3(μ₀/4π) μ_s / r⁴ × r̂, where r̂ = (dx, dy)/r.
    const k = 3 * MU0_OVER_4PI * this.mu_z_J_per_T / (r4 * r);
    return { x: k * dx, y: k * dy };
  }

  // Phase 3.5 (Q3=A): full in-plane gradient of the in-plane B vector
  // as a 2x2 tensor `{xx, xy, yx, yy}` where `tensor.ij = ∂_i B_j`
  // (row index = spatial-derivative direction, column index =
  // field-direction).
  //
  // For an axial dipole (μ_source pinned along ẑ), the in-plane B at
  // any in-plane sample point is identically zero (B = (0, 0, B_z)).
  // The in-plane field components are zero everywhere → their
  // in-plane gradients are zero everywhere. Returning the all-zero
  // tensor is correct and load-bearing for the Phase 3.5 element-wise
  // F formula `F_i = μ_j · ∂_i B_j`: with μ ∈ in-plane (RotatingDipole)
  // AND B_x = B_y = 0 → F = 0 contribution from the in-plane μ
  // components. The axial μ_z·∂_i B_z piece is what gives DipoleField
  // a nonzero force on a 3.3-style axial dipole; Phase 3.5's wider
  // formula picks up that piece via the existing `gradB_z_at` chain
  // (DipoleInField widens to combine both contributions).
  //
  // SD-8: routes through _separation for consistent center-singularity
  // throw behavior.
  gradB_at(point) {
    this._separation(point);
    return { xx: 0, xy: 0, yx: 0, yy: 0 };
  }
}

// Complete elliptic integrals of the first (K) and second (E) kind — used by
// CurrentWireField's `loop` mode for the exact off-axis field. Argument is the
// PARAMETER m = k² (not the modulus k), m ∈ [0, 1). Evaluated by the
// arithmetic–geometric-mean recurrence (Abramowitz & Stegun 17.6), which
// converges quadratically (~7 iterations to double precision):
//   a₀=1, b₀=√(1−m), c₀=√m;  aₙ=(a+b)/2, bₙ=√(ab), cₙ=(a−b)/2
//   K = π/(2 a_N),   E = K·[1 − Σₙ 2ⁿ⁻¹ cₙ²]
// Exported for direct unit testing against known K/E values.
//
// Termination is machine-precision convergence (|cₙ| ≤ ε·aₙ) with a hard
// 25-iteration backstop. This is LOAD-BEARING for E: cₙ plateaus at the
// ~1e-16 floating-point floor of (a−b)/2 (it never reaches exactly 0), and
// the E-sum weight 2ⁿ⁻¹ doubles each step — iterating past convergence lets
// that weight amplify the floor and corrupt E (a naïve long loop mis-computes
// E(m=0.5) by ~5e-3). K depends only on a_N and is unaffected.
export function ellipke(m) {
  if (!(m >= 0) || m >= 1) {
    throw new Error(`ellipke: parameter m must be in [0, 1) (got ${m}).`);
  }
  let a = 1;
  let b = Math.sqrt(1 - m);
  let c = Math.sqrt(m);            // c₀
  let sum = 0.5 * c * c;           // 2⁻¹ c₀²
  let weight = 1;                  // 2ⁿ⁻¹ for n = 1 → 2⁰
  for (let n = 1; n <= 25; n++) {
    const aNext = (a + b) / 2;
    const bNext = Math.sqrt(a * b);
    const cNext = (a - b) / 2;     // cₙ
    sum += weight * cNext * cNext;
    a = aNext; b = bNext; c = cNext;
    weight *= 2;
    if (Math.abs(cNext) <= Number.EPSILON * Math.abs(a)) break;
  }
  const K = Math.PI / (2 * a);
  const E = K * (1 - sum);
  return { K, E };
}

// loopFieldInPlane — exact in-plane B of ONE circular current loop of radius
// `a` carrying current `I`, whose axis lies IN the 2-D plane along `direction`
// ∈ {x, y} through loop center (cx, cy), sampled at `point`. Simpson's exact
// off-axis form via complete elliptic integrals K(k)/E(k) (helper `ellipke`).
// Returns the in-plane vector {x, y, z:0} (B_axial along `direction`, B_perp
// along the ⊥ screen axis carrying sign of the perpendicular offset). Throws on
// the loop wire (α² = 0) — the caller decides how to surface that. Shared by
// CurrentWireField's `loop` mode (single loop) AND the `solenoid_finite`
// quadrature (which sums this over shifted-center loops along the length).
export function loopFieldInPlane(a, I, direction, cx, cy, point) {
  const zeta = direction === 'x' ? point.x - cx : point.y - cy;  // axial offset
  const s = direction === 'x' ? point.y - cy : point.x - cx;     // signed ⊥ offset
  const rho = Math.abs(s);
  const rho2 = s * s;
  const zeta2 = zeta * zeta;
  const a2 = a * a;
  const alpha2 = a2 + rho2 + zeta2 - 2 * a * rho;   // (a − ρ)² + ζ²
  if (alpha2 === 0) {
    throw new Error('current loop evaluated on the wire (α = 0)');
  }
  const beta2 = a2 + rho2 + zeta2 + 2 * a * rho;    // (a + ρ)² + ζ²
  const beta = Math.sqrt(beta2);
  const m = 1 - alpha2 / beta2;                      // k² = 4aρ/β² ∈ [0, 1)
  const { K, E } = ellipke(m);
  const C = MU0 * I / Math.PI;                       // μ₀ I / π
  const Baxial = (C / (2 * alpha2 * beta)) *
    ((a2 - rho2 - zeta2) * E + alpha2 * K);
  let Bperp = 0;
  if (rho > 0) {
    // B_radial (outward +); folding 1/ρ · sign(s) gives the signed screen
    // component. On the axis (s = 0) the bracket → 0 like ρ², so Bperp = 0.
    const Brho = (C * zeta / (2 * alpha2 * beta * rho)) *
      ((a2 + rho2 + zeta2) * E - alpha2 * K);
    Bperp = Math.sign(s) * Brho;
  }
  return direction === 'x'
    ? { x: Baxial, y: Bperp, z: 0 }
    : { x: Bperp, y: Baxial, z: 0 };
}

// Composite-Simpson panel count for the `solenoid_finite` length integral.
// N=200 vs N=800 agree to 1e-6 off the winding (harness §3.8), so 400 is
// comfortably converged; on-axis matches the closed form to ≤1e-7 rel.
const SOLENOID_QUAD_PANELS = 400;

// Relative band for the `solenoid_finite` winding test (|perp| vs R_m). Far
// above FP coordinate-subtraction noise (~1e-16·R) so a point mathematically on
// the winding is caught despite a non-representable R_m, yet far below any
// physical grid/probe spacing (1e-9·R ≈ sub-nanometre) so genuinely near-winding
// points still return the finite (autoscaled) field. See _onWinding.
const WINDING_REL_TOL = 1e-9;

// CurrentWireField — infinite straight wire carrying steady current I,
// running PERPENDICULAR to the 2-D simulation plane (along ±ẑ) through
// `center`. Phase C1 (Stage ②, sim_phase_c_magnetism). Brief:
// docs/physics_briefs/c1_current_wire_field_brief.md.
//
// At any in-plane sample point, with r⃗ = point − center = (dx, dy),
// r = |r⃗|, and current I along +ẑ:
//   B(r⃗) = (μ₀/2π) · I / r · φ̂ ,   φ̂ = ẑ × r̂ = (−dy, dx, 0)/r
//         = (μ₀/2π) · I / r² · (−dy, dx, 0)          (in-plane; B_z = 0)
//   |B|   = μ₀ I / 2π r                              (Ampère's law)
// The direction is r̂ rotated +90° (CCW) — the right-hand-rule circulation
// for current out of the page. A negative I flips the whole vector (current
// into the page ⇒ CW). E ≡ 0 (steady current, no electric field here).
//
// 2-D honesty: the field is IN-PLANE (B.x/B.y ≠ 0), so it is renderable by
// the existing in-plane B-arrow draw leg but INCOMPATIBLE with the Lorentz
// out-of-plane guard (needs B ∥ ẑ). C1 is therefore VIZ/STATIC-ONLY — no
// dynamics. Charge-near-wire motion is deferred to Phase H1; force-on-current
// (I L×B) is Phase C2.
//
// Modes:
//   - `straight` — infinite wire ⊥ the plane through `center`; azimuthal
//     B = μ₀I/2πr, exact at every in-plane point (r > 0). Singular at r = 0.
//   - `solenoid` — idealized-INFINITE solenoid whose axis lies IN the plane
//     along `direction` ∈ {x, y} through `center`, bore half-width `R_m`,
//     `n_turns_per_m` turns/m. The 2-D vertical slice contains the axis, so
//     the bore cross-section is the strip |perp − center_perp| < R_m. Inside:
//     B = μ₀ n I along `direction` (uniform — exactly, no fringing, because
//     it is idealized-infinite → 2-D-honest). Outside: B = 0. No singularity
//     (the field is bounded everywhere), so solenoid mode never throws.
//   - `loop` (Phase C loop follow-on) — a single circular current LOOP whose
//     axis lies IN the plane along `direction` ∈ {x, y} through `center`,
//     radius `R_m`. Edge-on: the 2-D slice cuts the loop's two wire crossings
//     at center ± R_m along the perpendicular axis. In-plane B (axial +
//     radial, B_z = 0) from the EXACT off-axis form via complete elliptic
//     integrals K(k)/E(k) (Simpson's form, helper `ellipke`) — NOT a dipole
//     approximation. Singular on the two crossings (α² = 0). On-axis it
//     reduces to μ₀ I R_m²/2(R_m²+ζ²)^{3/2}; far field → magnetic dipole
//     (both verified). Brief: docs/physics_briefs/sim_phase_c_loop_field_brief.md.
//   - `solenoid_finite` — a FINITE-length solenoid, axis IN the plane along
//     `direction` ∈ {x, y} through `center`, bore radius `R_m`, length `L_m`,
//     `n_turns_per_m` turns/m. Off-axis B is the exact single-loop kernel
//     (loopFieldInPlane) integrated over the length via composite Simpson — it
//     FRINGES (interior NOT exactly uniform), unlike the idealized-infinite
//     `solenoid`. On-axis reduces to the closed form B_axial(ζ) =
//     (μ₀nI/2)[(L/2−ζ)/√(R²+(L/2−ζ)²) + (L/2+ζ)/√(R²+(L/2+ζ)²)]; far field →
//     dipole (m = nLI·πR²). Singular on the winding (|perp| = R, |ζ| ≤ L/2).
//   - `solenoid_perp` — an idealized-INFINITE solenoid whose axis is ⊥ the
//     plane (along ẑ) through `center`, bore radius `R_m`, `n_turns_per_m`
//     turns/m. The slice cuts the bore as a disk r < R_m; interior B = μ₀ n I
//     along ẑ (uniform — idealized-infinite), 0 outside → renders as dot/cross
//     tokens via the Bz leg (NOT in-plane arrows). No `direction` (axis is z).
//     Bounded everywhere, so it never throws.
//     Both solenoid_finite/solenoid_perp brief:
//     docs/physics_briefs/sim_phase_c_solenoid_variants_brief.md.
//
// Singularity policy (SD-8, mirroring RadialField/DipoleField): for `straight`,
// B_at/E_at/potential_at all route through _separation and throw at r=0; for
// `loop`, they route through _loopGeom and throw on the two wire crossings
// (α² = 0); for `solenoid_finite` they throw on the winding (|perp| = R,
// |ζ| ≤ L/2, where the ring-stack integral diverges). A body cannot occupy a
// wire; surface the bug at query time rather than mask 0. The two idealized-
// infinite solenoids (`solenoid`, `solenoid_perp`) are bounded and never throw.
export class CurrentWireField {
  // Sibling capability struct (Phase 3.5 Q10=A convention). `gradient: false`
  // means this class does not expose `gradB_at`, so a (mis-wired)
  // DipoleInField force falls back to F = 0 instead of throwing at scene
  // load. C1 ships no dipole-in-current-wire dynamics; this is good hygiene.
  static capabilities = { gradient: false };

  constructor({ id, type, center, I_A, mode = 'straight', direction, R_m, L_m, n_turns_per_m }) {
    if (type !== 'current_wire') {
      throw new Error(
        `CurrentWireField requires type="current_wire" (got "${type}").`
      );
    }
    const MODES = ['straight', 'solenoid', 'loop', 'solenoid_finite', 'solenoid_perp'];
    if (!MODES.includes(mode)) {
      throw new Error(
        `CurrentWireField supports mode ${MODES.map((m) => `"${m}"`).join(', ')} ` +
        `(got "${mode}"). id="${id}".`
      );
    }
    if (typeof I_A !== 'number' || !Number.isFinite(I_A)) {
      throw new Error(
        `CurrentWireField.I_A must be a finite number (got ${I_A}). id="${id}".`
      );
    }
    this.id = id;
    this.type = type;
    this.mode = mode;
    this.center = { x: center.x, y: center.y };
    this.I_A = I_A;
    if (mode === 'solenoid') {
      // Axis lies IN the plane along `direction`; the bore cross-section is
      // the strip |perp − center_perp| < R_m. Reuses LinearGradientField's
      // direction ∈ {x, y} convention (no diagonal axes at this pass).
      if (direction !== 'x' && direction !== 'y') {
        throw new Error(
          `CurrentWireField solenoid requires direction "x" or "y" ` +
          `(got "${direction}"). id="${id}".`
        );
      }
      if (typeof R_m !== 'number' || !Number.isFinite(R_m) || R_m <= 0) {
        throw new Error(
          `CurrentWireField solenoid requires a positive finite R_m ` +
          `(bore half-width, got ${R_m}). id="${id}".`
        );
      }
      if (typeof n_turns_per_m !== 'number' || !Number.isFinite(n_turns_per_m) || n_turns_per_m <= 0) {
        throw new Error(
          `CurrentWireField solenoid requires a positive finite ` +
          `n_turns_per_m (got ${n_turns_per_m}). id="${id}".`
        );
      }
      this.direction = direction;
      this.R_m = R_m;
      this.n_turns_per_m = n_turns_per_m;
    }
    if (mode === 'loop') {
      // Single circular loop, axis IN the plane along `direction`, radius R_m,
      // centered at `center`. Reuses direction ∈ {x, y} (no diagonal axes) and
      // R_m — here the LOOP RADIUS, not a bore half-width. No n_turns_per_m
      // (single loop). Field via the exact elliptic-integral form (see _loopB).
      if (direction !== 'x' && direction !== 'y') {
        throw new Error(
          `CurrentWireField loop requires direction "x" or "y" ` +
          `(got "${direction}"). id="${id}".`
        );
      }
      if (typeof R_m !== 'number' || !Number.isFinite(R_m) || R_m <= 0) {
        throw new Error(
          `CurrentWireField loop requires a positive finite R_m ` +
          `(loop radius, got ${R_m}). id="${id}".`
        );
      }
      this.direction = direction;
      this.R_m = R_m;
    }
    if (mode === 'solenoid_finite') {
      // Finite-length solenoid, axis IN the plane along `direction`, bore radius
      // R_m, length L_m, n_turns_per_m turns/m. Off-axis B is the exact loop
      // kernel integrated over the length (see _finiteSolenoidB) — it FRINGES
      // (interior not exactly uniform), unlike the idealized-infinite `solenoid`.
      if (direction !== 'x' && direction !== 'y') {
        throw new Error(
          `CurrentWireField solenoid_finite requires direction "x" or "y" ` +
          `(got "${direction}"). id="${id}".`
        );
      }
      if (typeof R_m !== 'number' || !Number.isFinite(R_m) || R_m <= 0) {
        throw new Error(
          `CurrentWireField solenoid_finite requires a positive finite R_m ` +
          `(bore radius, got ${R_m}). id="${id}".`
        );
      }
      if (typeof L_m !== 'number' || !Number.isFinite(L_m) || L_m <= 0) {
        throw new Error(
          `CurrentWireField solenoid_finite requires a positive finite L_m ` +
          `(length, got ${L_m}). id="${id}".`
        );
      }
      if (typeof n_turns_per_m !== 'number' || !Number.isFinite(n_turns_per_m) || n_turns_per_m <= 0) {
        throw new Error(
          `CurrentWireField solenoid_finite requires a positive finite ` +
          `n_turns_per_m (got ${n_turns_per_m}). id="${id}".`
        );
      }
      this.direction = direction;
      this.R_m = R_m;
      this.L_m = L_m;
      this.n_turns_per_m = n_turns_per_m;
    }
    if (mode === 'solenoid_perp') {
      // Idealized-infinite solenoid whose axis is PERPENDICULAR to the 2-D
      // plane (along ẑ) through `center`. The slice cuts the bore as a disk
      // r < R_m; interior B = μ₀ n I along ẑ (uniform — idealized-infinite),
      // 0 outside → renders via the Bz dot/cross leg. Axis is always z, so
      // there is NO `direction` parameter (unlike the in-plane `solenoid`).
      if (typeof R_m !== 'number' || !Number.isFinite(R_m) || R_m <= 0) {
        throw new Error(
          `CurrentWireField solenoid_perp requires a positive finite R_m ` +
          `(bore radius, got ${R_m}). id="${id}".`
        );
      }
      if (typeof n_turns_per_m !== 'number' || !Number.isFinite(n_turns_per_m) || n_turns_per_m <= 0) {
        throw new Error(
          `CurrentWireField solenoid_perp requires a positive finite ` +
          `n_turns_per_m (got ${n_turns_per_m}). id="${id}".`
        );
      }
      this.R_m = R_m;
      this.n_turns_per_m = n_turns_per_m;
    }
  }

  _separation(point) {
    const dx = point.x - this.center.x;
    const dy = point.y - this.center.y;
    const r2 = dx * dx + dy * dy;
    if (r2 === 0) {
      throw new Error('CurrentWireField evaluated at wire (r = 0)');
    }
    return { dx, dy, r: Math.sqrt(r2), r2 };
  }

  // Returns true when `point` lies inside the idealized-infinite solenoid's
  // bore — the strip |perp − center_perp| < R_m, where `perp` is the
  // coordinate ⊥ the axis `direction`. Solenoid mode only. The strict `<`
  // treats the (measure-zero) boundary as exterior; grid cell-centers do not
  // land on it generically.
  _insideBore(point) {
    const perp = this.direction === 'x'
      ? point.y - this.center.y
      : point.x - this.center.x;
    return Math.abs(perp) < this.R_m;
  }

  // Loop-mode geometry helper. Maps a screen point to loop-cylindrical
  // coordinates about the in-plane axis `direction`: ζ (axial, along the
  // axis), s (signed perpendicular offset), ρ = |s|. Returns the Simpson
  // intermediates α² = (a−ρ)²+ζ² and β² = (a+ρ)²+ζ². Throws on the two wire
  // crossings (α² = 0), mirroring _separation's r=0 throw.
  _loopGeom(point) {
    const a = this.R_m;
    const zeta = this.direction === 'x'
      ? point.x - this.center.x
      : point.y - this.center.y;
    const s = this.direction === 'x'
      ? point.y - this.center.y
      : point.x - this.center.x;
    const rho2 = s * s;
    const zeta2 = zeta * zeta;
    const a2 = a * a;
    const rho = Math.abs(s);
    const alpha2 = a2 + rho2 + zeta2 - 2 * a * rho;   // (a − ρ)² + ζ²
    if (alpha2 === 0) {
      throw new Error('CurrentWireField loop evaluated on the wire (α = 0)');
    }
    const beta2 = a2 + rho2 + zeta2 + 2 * a * rho;    // (a + ρ)² + ζ²
    return { zeta, s, rho, rho2, zeta2, a2, alpha2, beta2 };
  }

  // Exact in-plane B of a single circular loop (axis in-plane along
  // `direction`, radius R_m) via complete elliptic integrals — Simpson's
  // form. B_axial → the screen `direction` component; B_radial → the ⊥
  // screen component carrying sign(s); B_z = 0. Verified on-axis against
  // μ₀ I R²/2(R²+ζ²)^{3/2} and far-field against a magnetic dipole.
  _loopB(point) {
    // Delegates to the shared exact loop kernel (throws on the wire, α² = 0,
    // with a message matching /loop evaluated on the wire/). `_loopGeom` is
    // retained for the loop E_at/potential_at singularity check below.
    return loopFieldInPlane(
      this.R_m, this.I_A, this.direction, this.center.x, this.center.y, point
    );
  }

  // True when `point` lies inside the axis-⊥ solenoid's disk bore (r < R_m).
  // solenoid_perp only; the strict `<` treats the boundary as exterior.
  _insideDisk(point) {
    const dx = point.x - this.center.x;
    const dy = point.y - this.center.y;
    return dx * dx + dy * dy < this.R_m * this.R_m;
  }

  // True when `point` lies on the finite solenoid's winding: |perp| = R_m AND
  // |ζ| ≤ L/2 (ζ axial, perp = ⊥-axis offset from center). There the ring-stack
  // integral diverges (a loop at ζ'≈ζ passes through the point), so the public
  // methods throw — mirroring straight's r=0 and loop's α=0. A point at
  // |perp| = R_m BEYOND the ends (|ζ| > L/2) is a valid field point. solenoid_finite only.
  //
  // |perp| is tested against R_m within a small RELATIVE band (WINDING_REL_TOL)
  // rather than exact `===`: `perp` is a coordinate SUBTRACTION, so a point that
  // is mathematically on the winding lands within ~1e-16·R of R_m for a
  // non-representable R_m (e.g. 0.4) and an exact `===` would miss it — leaving
  // a quadrature node to hit α²=0 and throw the wrong (loop) message. The band
  // (1e-9·R ≈ sub-nanometre) is far above FP subtraction noise yet far below any
  // physical spacing, so genuinely near-winding points still fall through to the
  // finite (large, autoscaled) field, and this predicate guards all three
  // public methods identically.
  _onWinding(point) {
    const zeta = this.direction === 'x'
      ? point.x - this.center.x
      : point.y - this.center.y;
    const s = this.direction === 'x'
      ? point.y - this.center.y
      : point.x - this.center.x;
    return Math.abs(Math.abs(s) - this.R_m) <= WINDING_REL_TOL * this.R_m
      && Math.abs(zeta) <= this.L_m / 2;
  }

  _throwIfOnWinding(point) {
    if (this._onWinding(point)) {
      throw new Error(
        'CurrentWireField solenoid_finite evaluated on the winding ' +
        '(|perp| = R, |ζ| ≤ L/2)'
      );
    }
  }

  // Exact in-plane B of a finite-length solenoid: the single-loop kernel
  // (loopFieldInPlane) integrated over the length ζ' ∈ [−L/2, +L/2], where a
  // slab dζ' carries dI = n I dζ'. Composite Simpson, SOLENOID_QUAD_PANELS
  // panels. On-axis reduces to the closed form (brief §1). The _onWinding guard
  // above rejects on-winding points (where the integral diverges); off-winding,
  // every node has α² ≥ (R−ρ)² > 0, so no node throws and the field is finite
  // (near-winding cells render large-but-finite, autoscaled).
  _finiteSolenoidB(point) {
    this._throwIfOnWinding(point);
    const half = this.L_m / 2;
    const N = SOLENOID_QUAD_PANELS;
    const h = this.L_m / N;
    let ax = 0;
    let ay = 0;
    for (let k = 0; k <= N; k++) {
      const zp = -half + k * h;
      const w = (k === 0 || k === N) ? 1 : (k % 2 === 1 ? 4 : 2);  // Simpson 1,4,2,…,4,1
      const lcx = this.direction === 'x' ? this.center.x + zp : this.center.x;
      const lcy = this.direction === 'y' ? this.center.y + zp : this.center.y;
      const b = loopFieldInPlane(this.R_m, 1, this.direction, lcx, lcy, point);
      ax += w * b.x;
      ay += w * b.y;
    }
    const f = this.n_turns_per_m * this.I_A * (h / 3);  // Simpson h/3 × (n I)
    return { x: f * ax, y: f * ay, z: 0 };
  }

  B_at(point) {
    if (this.mode === 'loop') return this._loopB(point);
    if (this.mode === 'solenoid_finite') return this._finiteSolenoidB(point);
    if (this.mode === 'solenoid_perp') {
      // Axis-⊥ solenoid: uniform B along ẑ inside the disk bore, 0 outside.
      // Positive I ⇒ B_z > 0 (out of page → dots); negative ⇒ into page
      // (crosses). Purely out-of-plane → renders via the Bz dot/cross leg.
      const Bz = this._insideDisk(point) ? MU0 * this.n_turns_per_m * this.I_A : 0;
      return { x: 0, y: 0, z: Bz };
    }
    if (this.mode === 'solenoid') {
      // Idealized-infinite solenoid: uniform B = μ₀ n I along `direction`
      // inside the bore, exactly 0 outside. Sign of I flips the direction
      // (positive I ⇒ B along +direction). Bounded everywhere → no throw.
      if (!this._insideBore(point)) return { x: 0, y: 0, z: 0 };
      const B = MU0 * this.n_turns_per_m * this.I_A;
      return this.direction === 'x'
        ? { x: B, y: 0, z: 0 }
        : { x: 0, y: B, z: 0 };
    }
    const { dx, dy, r2 } = this._separation(point);
    // B = (μ₀/2π) · I / r² · (−dy, dx). Folding φ̂'s 1/r into r² keeps this
    // one division; magnitude is μ₀ I / 2π r (verified in the brief §2).
    const k = MU0_OVER_2PI * this.I_A / r2;
    return { x: -k * dy, y: k * dx, z: 0 };
  }

  E_at(point) {
    // Steady current ⇒ no electric field. Singularity contract per mode:
    // `straight` → _separation (r=0); `loop` → _loopGeom (α²=0 crossings, NOT
    // the center, a valid field point); `solenoid_finite` → throws on the
    // winding. The two idealized-infinite solenoids are bounded → never throw.
    if (this.mode === 'straight') this._separation(point);
    else if (this.mode === 'loop') this._loopGeom(point);
    else if (this.mode === 'solenoid_finite') this._throwIfOnWinding(point);
    return { x: 0, y: 0, z: 0 };
  }

  potential_at(point) {
    // Magnetic vector potential is gauge-dependent and out of v0 scope; return
    // 0 to match UniformField / DipoleField. Same singularity contract as E_at:
    // straight r=0, loop α²=0 crossings, solenoid_finite winding; `solenoid` /
    // `solenoid_perp` are non-singular.
    if (this.mode === 'straight') this._separation(point);
    else if (this.mode === 'loop') this._loopGeom(point);
    else if (this.mode === 'solenoid_finite') this._throwIfOnWinding(point);
    return 0;
  }
}

// LinearGradientField — synthetic linear-gradient B field. Phase 3.5
// deliverable §3.5.4 (Q2=B locked). The B-field has a uniform component
// `B_0_T` along a chosen principal axis (`direction` ∈ {"x","y"}) PLUS
// a linear-in-coordinate slope `grad_T_per_m` along the same axis.
//
// Field shape (direction = "x"):
//   B(r⃗) = (B_0 + g_grad · x, 0, 0)
//   gradB(r⃗) = {xx: g_grad, xy: 0, yx: 0, yy: 0}   (∂_x B_x = g_grad)
//
// Field shape (direction = "y"):
//   B(r⃗) = (0, B_0 + g_grad · y, 0)
//   gradB(r⃗) = {xx: 0, xy: 0, yx: 0, yy: g_grad}   (∂_y B_y = g_grad)
//
// Maxwell physicality: ∇·B = ∂_x B_x + ∂_y B_y + ∂_z B_z = g_grad ≠ 0
// in either direction. The field is NOT Maxwell-physical (would
// require monopoles); it's a pedagogical analog used to make the
// linearized analytic amplitude exactly tractable in
// `dipole_in_linear_gradient.brief.md`. Q4.a's Maxwell-physical
// fixture (`B = ∇φ`) is handled in the dipole_in_field test, not
// here — the SCENE deliberately uses this synthetic field.
//
// E-field is zero everywhere (electrostatic potential is gauge 0).
//
// Phase 3.5 deliverable §3.5.4. Tests in
// `__tests__/dipole_in_field.test.js` + the new coupled scene's tests.
export class LinearGradientField {
  // Q10=A: real gradient → capability flag = true.
  static capabilities = { gradient: true };

  constructor({ id, type, B_0_T, grad_T_per_m, direction }) {
    if (type !== 'linear_gradient') {
      throw new Error(
        `LinearGradientField requires type="linear_gradient" (got "${type}").`
      );
    }
    if (typeof B_0_T !== 'number' || !Number.isFinite(B_0_T)) {
      throw new Error(
        `LinearGradientField.B_0_T must be a finite number (got ${B_0_T}).`
      );
    }
    if (typeof grad_T_per_m !== 'number' || !Number.isFinite(grad_T_per_m)) {
      throw new Error(
        `LinearGradientField.grad_T_per_m must be a finite number (got ${grad_T_per_m}).`
      );
    }
    if (direction !== 'x' && direction !== 'y') {
      throw new Error(
        `LinearGradientField.direction must be "x" or "y" (got "${direction}"). ` +
        `Diagonal / off-axis gradients are out of v0 scope.`
      );
    }
    this.id = id;
    this.type = type;
    this.B_0_T = B_0_T;
    this.grad_T_per_m = grad_T_per_m;
    this.direction = direction;
  }

  E_at(/* point */) {
    // Phase 5.B Step 4(b) substep 3: vec3 widening (additive z=0).
    return { x: 0, y: 0, z: 0 };
  }

  B_at(point) {
    const coord = this.direction === 'x' ? point.x : point.y;
    const Bcomp = this.B_0_T + this.grad_T_per_m * coord;
    return this.direction === 'x'
      ? { x: Bcomp, y: 0, z: 0 }
      : { x: 0, y: Bcomp, z: 0 };
  }

  potential_at(/* point */) {
    // Magnetic vector potential is gauge-dependent and out of v0 scope.
    // Mirrors UniformField / DipoleField gauge choice.
    return 0;
  }

  // Phase 3.5 (Q3=A): full in-plane ∂_i B_j tensor.
  // For direction = "x":
  //   ∂_x B_x = g_grad,  ∂_x B_y = 0,  ∂_y B_x = 0,  ∂_y B_y = 0
  // For direction = "y":
  //   ∂_x B_x = 0,  ∂_x B_y = 0,  ∂_y B_x = 0,  ∂_y B_y = g_grad
  // Position-independent (the gradient is constant — that's the
  // "linear" in LinearGradientField).
  gradB_at(/* point */) {
    if (this.direction === 'x') {
      return { xx: this.grad_T_per_m, xy: 0, yx: 0, yy: 0 };
    }
    return { xx: 0, xy: 0, yx: 0, yy: this.grad_T_per_m };
  }
}

// TimeVaryingUniformField — first time-dependent field class. Phase 5.D
// Step 0b.1 (Q3=a). B is uniform-in-space (like UniformField) but its
// magnitude varies sinusoidally in time:
//   B(t) = amplitude · sin(omega · t + phase)
// where `amplitude` is a vec3 (so the time-varying B can point along any
// axis), and the spatial argument to `B_at(point)` is ignored.
//
// **B_at(point) signature byte-stable** with all other field classes:
// the caller does NOT pass `t`. Instead, the integrator (or any caller)
// must invoke `setTime(t)` BEFORE sampling, per flux-sample. This keeps
// the field-agnostic flux integrator (`runFluxCheck`) working without
// signature changes — only the field's internal cache differs.
//
// Cache contract (Q3a sub-contract): `setTime(t)` computes B at t and
// stores it. `B_at(point)` returns the cached vector. A runtime guard
// throws if `B_at` is called before `setTime` has been invoked at least
// once (stale-cache state). The integrator-owned discipline is to call
// `setTime(t)` at every flux-sample step; this skeleton's guard catches
// the worst case (cache never primed) and provides the foundation for
// stricter epoch-based "stale relative to current step" checks at
// later steps. NEW debt-id: `time-varying-stale-cache-strict` —
// promote to per-step epoch tracking if a future scene exposes a
// stale-but-non-null bug.
//
// E_at returns zero (a varying B with no source charge has no static E
// at this layer; Maxwell's induction-of-E from ∂B/∂t is Phase 6+ scope).
// `gradient: false` since spatial gradient is identically zero.
//
// Phase 5.D §5.D.0b.1. Tests in
// `__tests__/time_varying_uniform_field.test.js`.
export class TimeVaryingUniformField {
  // Phase 3.5 capability flag convention: ∇B = 0 by construction (B is
  // uniform-in-space). Magnetic-gradient consumers (DipoleInField) treat
  // ∇B = 0 → F = 0, same outcome as UniformField.
  static capabilities = { gradient: false };

  constructor({ id, type, B_amplitude_T, omega_rad_per_s, phase_rad }) {
    if (type !== 'time_varying_uniform') {
      throw new Error(
        `TimeVaryingUniformField requires type="time_varying_uniform" (got "${type}").`
      );
    }
    if (!B_amplitude_T || typeof B_amplitude_T !== 'object') {
      throw new Error(
        `TimeVaryingUniformField.B_amplitude_T must be a vec3-shaped object (got ${JSON.stringify(B_amplitude_T)}).`
      );
    }
    if (typeof omega_rad_per_s !== 'number' || !Number.isFinite(omega_rad_per_s)) {
      throw new Error(
        `TimeVaryingUniformField.omega_rad_per_s must be a finite number (got ${omega_rad_per_s}).`
      );
    }
    if (phase_rad !== undefined && (typeof phase_rad !== 'number' || !Number.isFinite(phase_rad))) {
      throw new Error(
        `TimeVaryingUniformField.phase_rad must be a finite number when provided (got ${phase_rad}).`
      );
    }
    this.id = id;
    this.type = type;
    // B amplitude is full vec3 — the time-varying B can point along any
    // axis. Default missing components to 0 so a scene with z-only
    // B(t) is well-formed: `{ B_amplitude_T: { z: 1 } }` → x=0, y=0.
    this.B_amplitude = {
      x: B_amplitude_T.x ?? 0,
      y: B_amplitude_T.y ?? 0,
      z: B_amplitude_T.z ?? 0
    };
    this.omega_rad_per_s = omega_rad_per_s;
    this.phase_rad = phase_rad ?? 0;
    // Stale-cache initial state: setTime has never been called. B_at
    // throws until setTime primes the cache.
    this._cached_t = null;
    this._cached_B = null;
  }

  // Integrator-owned cache primer. Call BEFORE B_at sampling at each
  // flux-sample step. Computes B(t) = amplitude · sin(ω·t + φ) and
  // stores in the cache. Successive calls overwrite — the most recent
  // setTime wins.
  setTime(t) {
    if (typeof t !== 'number' || !Number.isFinite(t)) {
      throw new Error(
        `TimeVaryingUniformField.setTime: t must be a finite number (got ${t}).`
      );
    }
    const factor = Math.sin(this.omega_rad_per_s * t + this.phase_rad);
    this._cached_t = t;
    this._cached_B = {
      x: this.B_amplitude.x * factor,
      y: this.B_amplitude.y * factor,
      z: this.B_amplitude.z * factor
    };
  }

  E_at(/* point */) {
    // Phase 5.D scope: induced E from ∂B/∂t is NOT modeled at this
    // layer (Maxwell's full coupling waits for Phase 6+). The static-
    // electric component of a time-varying-B-only scene is zero.
    return { x: 0, y: 0, z: 0 };
  }

  B_at(/* point */) {
    // Stale-cache guard: setTime must be called before sampling.
    // Catches the integrator-discipline failure (forgot to prime the
    // cache for this step) early and loudly with a precise diagnostic.
    if (this._cached_t === null || this._cached_B === null) {
      throw new Error(
        'TimeVaryingUniformField.B_at: stale-cache guard tripped — ' +
        'setTime(t) must be called before B_at sampling. ' +
        'Integrator-owned discipline: call field.setTime(t) at each flux-sample step.'
      );
    }
    // Return a fresh vec3 — callers may freeze or mutate; do not leak
    // the internal cache reference.
    return { x: this._cached_B.x, y: this._cached_B.y, z: this._cached_B.z };
  }

  potential_at(/* point */) {
    // Magnetic vector potential is gauge-dependent; v0 returns 0 to
    // match the gauge choice of UniformField / DipoleField.
    return 0;
  }
}

// FluidField — a horizontal fluid region (a free surface at `waterline_y_m`
// with density `density_kg_per_m3`), the authorable half of sim_buoyancy_fluids.
// It lives in the SAME sceneCtx.fields Map as the EM fields so BuoyantForce can
// reference it by id (`sceneCtx.fields.get(field_id)` — the LorentzForce
// precedent, no new top-level scene array + Map). It is NOT an EM field: it
// exposes NO E_at / B_at / potential_at, which is exactly why the shared
// emFields() accessor (below) filters it OUT of the field/V overlay sampling —
// a fluid in the Map must never be sampled as an electric field (plan
// anti-target: it would silently blank the equipotential/field overlay).
//
// Interface: id, type, and cheap accessors `waterlineY` / `density` that
// BuoyantForce reads. sim_buoyancy_fluids P3.
export class FluidField {
  // Capability struct (Phase 3.5 Q10=A convention): ∇B is meaningless for a
  // fluid, and it carries no B at all → gradient: false. A (mis-wired)
  // dipole_in_field force binding a fluid would thus fall back to F = 0 at the
  // scene-load capability check rather than throw — but the emFields() filter +
  // the semantic feasibility validator make that miswire unreachable in practice.
  static capabilities = { gradient: false };

  constructor({ id, type, waterline_y_m, density_kg_per_m3 }) {
    if (type !== 'fluid') {
      throw new Error(`FluidField requires type="fluid" (got "${type}").`);
    }
    if (typeof waterline_y_m !== 'number' || !Number.isFinite(waterline_y_m)) {
      throw new Error(
        `FluidField.waterline_y_m must be a finite number (got ${waterline_y_m}). id="${id}".`
      );
    }
    if (typeof density_kg_per_m3 !== 'number' || !Number.isFinite(density_kg_per_m3) || density_kg_per_m3 <= 0) {
      throw new Error(
        `FluidField.density_kg_per_m3 must be a finite number > 0 (got ${density_kg_per_m3}). id="${id}".`
      );
    }
    this.id = id;
    this.type = type;
    this.waterlineY = waterline_y_m;
    this.density = density_kg_per_m3;
  }
}

const FIELD_CTORS = {
  uniform: UniformField,
  radial: RadialField,
  dipole: DipoleField,
  current_wire: CurrentWireField,
  linear_gradient: LinearGradientField,
  time_varying_uniform: TimeVaryingUniformField,
  fluid: FluidField
};

// emFields(fieldsMap) — the SHARED capability-guard accessor over the widened
// fields Map. Returns ONLY the entries with a callable `E_at` (the EM fields) —
// the engine's own capability-guard idiom (induction.js guards with
// `typeof field.B_at !== 'function'`). Every consumer that iterates the fields
// to SAMPLE a field (field_sampler.js, render/field_overlay.js,
// render/canvas2d.js) routes its `fields.values()` loop through THIS instead of
// the raw Map, so a non-EM field (a FluidField, or any future temperature /
// pressure region) is filtered out of overlay sampling in ONE place — never
// per-consumer. The fluid STAYS in the Map (BuoyantForce still resolves it by
// id); it is only excluded from the E_at/potential_at sampling loops.
//
// WIDENED CONTRACT: `sceneCtx.fields` may now hold non-EM entries. Any NEW
// consumer that calls E_at / B_at / potential_at over the Map MUST iterate
// emFields(map), not map.values(), or it will throw on the first fluid.
//
// Chosen over a `kind:'em'` discriminant because the E_at-presence guard is
// FAIL-CLOSED-SAFE with zero backfill: every existing EM field already has
// E_at, so it is included with no schema/default change, whereas a
// `kind !== 'em'` predicate would silently exclude every EXISTING (kind-less)
// EM field and blank every current overlay.
export function emFields(fieldsMap) {
  const out = [];
  if (!fieldsMap) return out;
  for (const f of fieldsMap.values()) {
    if (typeof f.E_at === 'function') out.push(f);
  }
  return out;
}

export function buildField(json) {
  const Ctor = FIELD_CTORS[json.type];
  if (!Ctor) {
    throw new Error(
      `Field type "${json.type}" not implemented yet. ` +
      `Supported: ${Object.keys(FIELD_CTORS).join(', ')}.`
    );
  }
  return new Ctor(json);
}

export const NAME = 'fields';
