// field_sampler.js — pure superposition sampler (engine layer).
//
// sampleField(point, sceneCtx, opts) sums the electric field E and scalar
// potential V of EVERY source in a scene at an arbitrary world point:
//   • every registered field's E_at / potential_at (RadialField contributes
//     k_e·Q/r² and k_e·Q/r; UniformField / DipoleField / magnetic fields
//     contribute 0 to V by their gauge — see the exclusion caveat below), and
//   • the Coulomb E and V of every charged body, via the shared
//     pointChargeField helper. This charged-body loop AUTOMATICALLY covers
//     extended-charge line/sheet/ring objects, because those are render_groups
//     of pinned Charge bodies that live in sceneCtx.bodies.
//
// The sampler is PURE and side-effect-free. It is the single engine helper the
// render-layer overlay (sim/render/field_overlay.js, roadmap F1) samples on a
// grid to draw superposed field lines, equipotential contours, and a vector
// field. Library-first: the raw single-charge math is NOT re-inlined here — it
// is imported from fields.js::pointChargeField.
//
// ============================================================================
// Known limitations / debt (the ONE durable, code-discoverable home for the
// caveats this module and the roadmap-F1 plan raise — the plan draft is
// archived after execution; a future maintainer reads THIS block):
//
// (a) k_e triple-duplication. COULOMB_DEFAULT_K_E is now exported from
//     fields.js and imported here (one canonical k_e for the sampler). But
//     forces.js STILL re-declares its own 8.9876e9 literal in the Coulomb
//     constructor default AND in the static Coulomb.pairEnergy — plus
//     sim/validation/em_validation.js carries a copy. Those 3+ copies predate
//     roadmap F1; F1 deliberately does NOT "fix" forces.js (out of scope). If
//     a future change consolidates k_e, migrate all copies to a shared
//     ./constants.js and delete this note.
//
// (b) pointChargeField formula-duplication. forces.js::Coulomb.applyTo and
//     Coulomb.potentialEnergy still carry the single-charge field/potential
//     math inline (as force/energy cousins). fields.js::pointChargeField is
//     the factored-out home; this sampler imports and uses it. forces.js may
//     later adopt it as `force = q_test · E` (a cycle-free forces.js →
//     fields.js import, because fields.js imports nothing). Until then the
//     formula lives in two places.
//
// (c) UniformField / DipoleField equipotential exclusion. BOTH
//     UniformField.potential_at and DipoleField.potential_at return 0 (a
//     magnetic gauge — each primarily models a B field). For a genuine
//     ELECTRIC uniform field the true potential is V = −E·r ≠ 0, and for a
//     dipole it is the non-zero dipole potential, so summing 0 makes
//     E ≠ −∇V and the equipotential overlay would be SILENTLY WRONG. Such
//     scenes are therefore OUT OF SCOPE for the equipotential reveal.
//     assertEquipotentialValid() below is the execution-start gate that
//     rejects them so a silently-wrong contour can never render. A future
//     phase may teach the sampler a uniform-E / dipole-E potential.
// ============================================================================

import {
  pointChargeField,
  COULOMB_DEFAULT_K_E,
  RadialField,
  DipoleField,
  UniformField,
  emFields,
} from './fields.js';

export { COULOMB_DEFAULT_K_E };

// Engine-layer fallback for the mask radius when the caller supplies no
// opts.rClip. The IDEAL mask radius (0.5·gridSpacing) is a RENDER/VIEW
// quantity the pure engine cannot see without an inward-invariant-violating
// up-import, so the render callers (P2/P4) always pass opts.rClip explicitly.
// This fallback is derived ONLY from sceneCtx geometry: a small fraction of
// the minimum inter-source spacing, floored at an absolute epsilon. It exists
// so direct engine/test callers get a sane (never render-derived) default.
const DEFAULT_RCLIP_SPACING_FRACTION = 0.1;
const DEFAULT_RCLIP_FLOOR_M = 1e-9;

// A masked (singular) cell: E is zeroed, V is NaN, singular is true. Every
// consumer MUST branch on `singular` before reading E / V.
function maskedSample() {
  return { E: { x: 0, y: 0 }, V: NaN, singular: true };
}

// Is this field a point-like ELECTRIC source that blows up at its center?
// RadialField (k_e·Q/r³ E) and DipoleField (~1/r³ E) both do, and both expose
// an accessible `.center`. UniformField (position-independent, no center) and
// magnetic fields (E ≡ 0) do not, so they are never masked by proximity.
function isPointLikeElectric(field) {
  return field instanceof RadialField || field instanceof DipoleField;
}

// Collect every point source's world position (RadialField centers + charged
// body positions). Used only by the geometry-derived default rClip.
function collectSourcePositions(sceneCtx) {
  const positions = [];
  const fields = sceneCtx.fields;
  if (fields) {
    // emFields() (not fields.values()) so a non-EM entry (a FluidField) is
    // never treated as a point source — sim_buoyancy_fluids P3.
    for (const f of emFields(fields)) {
      if (isPointLikeElectric(f) && f.center) positions.push(f.center);
    }
  }
  for (const b of sceneCtx.bodies ?? []) {
    if (typeof b.charge === 'number' && b.charge !== 0 && b.position) {
      positions.push(b.position);
    }
  }
  return positions;
}

// Geometry-derived fallback mask radius (see DEFAULT_RCLIP_* above). O(n²) in
// source count, but only evaluated when the caller omits opts.rClip; render
// callers always pass an explicit view-derived rClip and never hit this.
export function defaultRClip(sceneCtx) {
  const positions = collectSourcePositions(sceneCtx);
  if (positions.length < 2) return DEFAULT_RCLIP_FLOOR_M;
  let minSpacing = Infinity;
  for (let i = 0; i < positions.length; i++) {
    for (let j = i + 1; j < positions.length; j++) {
      const dx = positions[i].x - positions[j].x;
      const dy = positions[i].y - positions[j].y;
      const d = Math.hypot(dx, dy);
      if (d < minSpacing) minSpacing = d;
    }
  }
  if (!Number.isFinite(minSpacing) || minSpacing === 0) return DEFAULT_RCLIP_FLOOR_M;
  return Math.max(DEFAULT_RCLIP_SPACING_FRACTION * minSpacing, DEFAULT_RCLIP_FLOOR_M);
}

// sampleField(point, sceneCtx, opts) -> { E:{x,y}, V, singular }
//
// opts.rClip — optional world-distance mask radius. Any point within rClip of
// a point-like source (a charged body, or a RadialField/DipoleField center)
// masks. Absent → defaultRClip(sceneCtx) (never a render/view quantity).
//
// Masking is UNIFORM across all point sources with a SINGLE early-exit: the
// moment any of these trips, return the masked sentinel and stop accumulating —
//   (a) an E_at / potential_at throws (a RadialField at its exact center);
//   (b) r < rClip to any charged body;
//   (c) r < rClip to the CENTER of any point-like electric field.
export function sampleField(point, sceneCtx, opts = {}) {
  const rClip = opts.rClip ?? defaultRClip(sceneCtx);
  const rClip2 = rClip * rClip;

  let Ex = 0;
  let Ey = 0;
  let V = 0;

  // --- Fields loop ---------------------------------------------------------
  const fields = sceneCtx.fields;
  if (fields) {
    // emFields() (not fields.values()) is the LOAD-BEARING fix: a FluidField
    // has no E_at/potential_at, so the raw loop would throw on it and the
    // try/catch below would mask EVERY grid point → a blank overlay on any
    // scene with both a fluid and the overlay (sim_buoyancy_fluids P3).
    for (const f of emFields(fields)) {
      // Guard (c): mask near a point-like electric field center BEFORE
      // evaluating, so a near-center 1/r³ blow-up never leaks in unmasked.
      if (isPointLikeElectric(f) && f.center) {
        const dcx = point.x - f.center.x;
        const dcy = point.y - f.center.y;
        if (dcx * dcx + dcy * dcy < rClip2) return maskedSample();
      }
      // Guard (a): a throw (e.g. RadialField exactly at center) masks.
      try {
        const E = f.E_at(point);
        Ex += E.x;
        Ey += E.y;
        V += f.potential_at(point);
      } catch {
        return maskedSample();
      }
    }
  }

  // --- Charged-body loop (mirrors Coulomb.applyTo iteration) ---------------
  for (const b of sceneCtx.bodies ?? []) {
    const q = b.charge;
    // Skip neutral / non-charged bodies BEFORE the distance + clip logic, so a
    // neutral body never raises a spurious singular flag.
    if (typeof q !== 'number' || q === 0) continue;
    const dx = point.x - b.position.x;
    const dy = point.y - b.position.y;
    const r2 = dx * dx + dy * dy;
    // Guard (b): mask within rClip of a charged body.
    if (r2 < rClip2) return maskedSample();
    const { E, V: Vb } = pointChargeField(point, q, b.position, COULOMB_DEFAULT_K_E);
    Ex += E.x;
    Ey += E.y;
    V += Vb;
  }

  return { E: { x: Ex, y: Ey }, V, singular: false };
}

// ---------------------------------------------------------------------------
// Execution-start assertions (NOT per-sample runtime guards). Call these once
// when wiring the overlay to a scene (or in tests); they surface a scene that
// would double-count a source or render a silently-wrong equipotential.
// ---------------------------------------------------------------------------

// Source-disjointness. A physical charge is represented as EITHER a
// RadialField OR a pinned Charge body — never both — because the sampler sums
// BOTH loops. A RadialField and a charged body are the SAME source (a
// double-count) iff they either (i) share an explicit source id, or (ii) are
// co-located within rClip AND carry EQUAL SIGNED charge. Either trips the
// guard. This is an assert-at-execution-start check, not a per-sample dedup:
// all in-scope gated scenes are confirmed disjoint, so the sampler adds NO
// per-sample de-duplication; a future author who introduces an overlapping
// representation is caught HERE, deterministically, not silently summed.
export function assertSourceDisjoint(sceneCtx, rClip) {
  const clip = typeof rClip === 'number' ? rClip : defaultRClip(sceneCtx);
  const clip2 = clip * clip;
  const radialFields = [];
  if (sceneCtx.fields) {
    for (const f of emFields(sceneCtx.fields)) {  // skip non-EM (fluid) entries
      if (f instanceof RadialField) radialFields.push(f);
    }
  }
  const charged = (sceneCtx.bodies ?? []).filter(
    (b) => typeof b.charge === 'number' && b.charge !== 0
  );
  for (const rf of radialFields) {
    for (const body of charged) {
      const sharedId = rf.id != null && body.id != null && rf.id === body.id;
      const dx = rf.center.x - body.position.x;
      const dy = rf.center.y - body.position.y;
      const coLocated = dx * dx + dy * dy < clip2;
      const equalCharge = rf.charge_C === body.charge; // sign included
      if (sharedId || (coLocated && equalCharge)) {
        throw new Error(
          `sampleField source-disjointness violated: RadialField "${rf.id}" ` +
          `and Charge body "${body.id}" represent the SAME physical source ` +
          `(${sharedId ? 'shared id' : 'co-located within rClip AND equal signed charge'}). ` +
          `A charge must be EITHER a RadialField OR a Charge body, never both — ` +
          `the sampler sums both loops and would double-count it.`
        );
      }
    }
  }
}

// Equipotential validity. Reject a scene whose electric structure includes a
// DipoleField or an ELECTRIC UniformField (non-zero E): both have
// potential_at ≡ 0, so E ≠ −∇V and the equipotential contours would be
// silently wrong (see debt note (c)). This binds the out-of-scope exclusion so
// the equipotential reveal can never render an incorrect contour.
export function assertEquipotentialValid(sceneCtx) {
  if (!sceneCtx.fields) return;
  for (const f of emFields(sceneCtx.fields)) {  // skip non-EM (fluid) entries
    if (f instanceof DipoleField) {
      throw new Error(
        `equipotential overlay invalid: field "${f.id}" is a DipoleField, ` +
        `whose potential_at returns 0 (magnetic gauge) while its E is a ` +
        `non-zero dipole field — E ≠ −∇V, so the contours would be wrong. ` +
        `Dipole-E scenes are out of scope for the equipotential reveal.`
      );
    }
    if (f instanceof UniformField && (f.E.x !== 0 || f.E.y !== 0)) {
      throw new Error(
        `equipotential overlay invalid: field "${f.id}" is an electric ` +
        `UniformField (E = (${f.E.x}, ${f.E.y})) whose potential_at returns 0 ` +
        `while the true uniform potential is V = −E·r ≠ 0 — E ≠ −∇V, so the ` +
        `contours would be wrong. Uniform-E scenes are out of scope for the ` +
        `equipotential reveal.`
      );
    }
  }
}

export const NAME = 'field_sampler';
