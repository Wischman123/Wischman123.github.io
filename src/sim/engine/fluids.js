// engine/fluids.js
//
// Buoyancy geometry + closed-form potential — the PURE, cycle-free core of
// sim_buoyancy_fluids P3. Imports NOTHING (forces.js imports THIS; this imports
// nothing), so the physics is unit-testable as a pure predicate independent of
// the Force/scene machinery (physics/CLAUDE.md recurring-shape-bug rule: test
// the decision point, not the heuristic).
//
// Physics source of truth: docs/physics_briefs/sim_buoyancy_fluids_brief.md §5.
// Conventions: +y is up; a fluid occupies y < waterlineY; a prismatic body of
// full height h centred at y_c spans bottom (y_c − h/2) to top (y_c + h/2). Its
// out-of-plane depth is a UNIT 1 m (the engine is a 2-D vertical plane — plan
// anti-target #4), so waterplane area A_wp = width_m × 1 m and full submerged
// "volume" V_max = width_m × height_m × 1 m (an area × unit-depth prism, never a
// genuine 3-D displaced volume; no tilt / righting moment).
//
// PRISM-ONLY for this slice. Both scenes (submerged_block, bobbing_float) are
// prisms; the disk / circular-segment cross-section's potential is NOT derived
// here and is OUT OF SCOPE (plan anti-target #6). A `Particle` ALWAYS carries a
// `radius`, so a buoyancy body that omits width_m/height_m must NOT silently
// fall through to a disk model whose potential is underived (→ F_b ≠ −dU/dy →
// energy drift). Instead requirePrismDims THROWS, loudly and symmetrically, on
// both the force and energy paths.

// Require the two prism dims on a buoyancy body, or THROW. The disk / other-
// shape path is deferred (not silently modelled). Returns { w, h } (both > 0).
function requirePrismDims(body) {
  const w = body.width_m;
  const h = body.height_m;
  if (!(w > 0) || !(h > 0)) {
    throw new Error(
      `buoyancy body "${body.id}" needs positive width_m + height_m ` +
      `(got width_m=${w}, height_m=${h}); the disk / other-shape buoyancy ` +
      `cross-section is not derived in this slice, so its volume is not ` +
      `inferred — declare the prism dims or remove the buoyancy force.`
    );
  }
  return { w, h };
}

// The UNCLAMPED submerged depth of the body's bottom below the waterline:
//   d_raw = waterlineY − (y_c − h/2) = waterlineY − y_c + h/2
// d_raw ≤ 0 ⇒ fully out; 0 < d_raw < h ⇒ partial; d_raw ≥ h ⇒ fully submerged
// (and still grows as the body sinks deeper — the fully-submerged potential is
// linear in d_raw). The force uses the CLAMPED depth (V_sub saturates at V_max);
// the potential uses d_raw (it keeps rising past full submersion so
// F_b = −dU/dy stays the constant ρg·V_max — see the brief §5 Regime 3).
function rawSubmergedDepth(body, waterlineY) {
  const { h } = requirePrismDims(body);
  return waterlineY - (body.position.y - h / 2);
}

// submergedDepth(body, waterlineY) — the CLAMPED submerged depth
//   d = clamp(waterlineY − y_c + h/2, 0, h) ∈ [0, h].
// Exported for tests; both submergedVolume and the force read it.
export function submergedDepth(body, waterlineY) {
  const { h } = requirePrismDims(body);
  const d = rawSubmergedDepth(body, waterlineY);
  return Math.max(0, Math.min(d, h));
}

// submergedVolume(body, waterlineY) — the 2-D prism submerged volume V_sub
// (area × unit out-of-plane depth) each step. THE single supported shape:
// REQUIRES width_m + height_m (THROWS otherwise — never a silent 0, never a
// disk fall-through). V_sub = A_wp × clamp(d, 0, h) with A_wp = width_m × 1 m.
// Regimes: fully out (d ≤ 0 → 0), fully in (d ≥ h → V_max), straddling (partial).
export function submergedVolume(body, waterlineY) {
  const { w } = requirePrismDims(body);
  const d = submergedDepth(body, waterlineY);   // clamps + require-or-throw
  return w * 1 * d;                              // A_wp = w × unit depth
}

// buoyantPotentialEnergy(body, waterlineY, density, g) — the closed-form
// piecewise antiderivative U_buoyant(y_c) with F_b = −dU/dy_c EXACTLY, across
// all THREE regimes with matched integration constants so it is C0-continuous
// at BOTH boundaries (d_raw = 0 and d_raw = h). Reference U = 0 fully out.
//   fully OUT   (d_raw ≤ 0): U = 0
//   PARTIAL     (0 < d_raw < h): U = ½·ρg·A_wp·d_raw²           (the SHM well)
//   SUBMERGED   (d_raw ≥ h): U = ρg·V_max·(d_raw − h/2)         (linear; = ½ρg·A_wp·h² at d_raw = h)
// Uses the UNCLAMPED depth d_raw (see rawSubmergedDepth) so the submerged branch
// keeps rising and −dU/dy = ρg·V_max (constant) matches the constant force.
export function buoyantPotentialEnergy(body, waterlineY, density, g) {
  const { w, h } = requirePrismDims(body);
  const A_wp = w * 1;
  const dRaw = rawSubmergedDepth(body, waterlineY);
  if (dRaw <= 0) return 0;                                   // fully OUT (reference)
  if (dRaw < h) return 0.5 * density * g * A_wp * dRaw * dRaw; // PARTIAL well
  const Vmax = A_wp * h;                                     // fully SUBMERGED
  return density * g * Vmax * (dRaw - h / 2);
}

// classifyBuoyancyBody — the PURE feasibility decision point for one buoyancy
// body against one fluid + the presence of a floor below the waterline. Split
// from all IO so fluid_validation.js's scene walk feeds it primitives and the
// three-branch boundary (float / sinker+floor / pinned, plus the degenerate
// width_m = 0 case) is unit-tested directly (physics/CLAUDE.md decision-point
// rule). d_eq = mass / (ρ_fluid · width_m · 1 m) is g-INDEPENDENT (Archimedes:
// a float displaces its own mass of fluid — the g's cancel in ρg·A_wp·d_eq =
// mg), so this needs no g. Returns { feasible, regime, d_eq, bodyDensity }.
//   regime ∈ { 'pinned', 'degenerate', 'float', 'sinker_floored', 'sinker_unfloored' }
// The boundary d_eq === height_m (neutrally buoyant, no freeboard) is classified
// as a sinker (needs a floor) — a strict float requires d_eq < height_m.
export function classifyBuoyancyBody({
  mass_kg, width_m, height_m, pinned, fluidDensity, hasFloorBelowWaterline,
}) {
  if (pinned === true) {
    return { feasible: true, regime: 'pinned', d_eq: null, bodyDensity: null };
  }
  if (!(width_m > 0) || !(height_m > 0)) {
    return {
      feasible: false, regime: 'degenerate', d_eq: NaN, bodyDensity: NaN,
    };
  }
  const d_eq = mass_kg / (fluidDensity * width_m * 1);
  const bodyDensity = mass_kg / (width_m * height_m * 1);
  if (d_eq < height_m) {
    return { feasible: true, regime: 'float', d_eq, bodyDensity };
  }
  // d_eq ≥ height_m ⇒ a sinker (ρ_body ≥ ρ_fluid): feasible ONLY with a floor.
  if (hasFloorBelowWaterline) {
    return { feasible: true, regime: 'sinker_floored', d_eq, bodyDensity };
  }
  return { feasible: false, regime: 'sinker_unfloored', d_eq, bodyDensity };
}

export const NAME = 'fluids';
