// engine/energy.js
//
// Energy bookkeeping. K from each Particle's velocity; U contributions
// queried from each Force's potentialEnergy(); dissipated power
// integrated for non-conservative forces (Drag, Friction).
//
// The contributions map is OPEN — Phase 5 (full E&M) adds U_electric
// for charge-charge potential without changing this API. Each Force
// declares its energyKey, and the tracker sums per-key over forces +
// bodies.
//
// Conservation drift = (E_total(t) - E_total(0)) / E_total(0).
// Reported as a diagnostic; the integrator does NOT correct it.
//
// Phase 5.D Step 0b.7 — channel split: `current()` exposes TWO sibling
// maps, `contributions` and `diagnostics`.
//
//   - `contributions` is the energy-conservation channel. Forces declare
//     `energyKey` + `potentialEnergy(body, sceneCtx)`; the tracker sums
//     per key. CLOSURE INVARIANT: `total = K + Σ contributions[k]`.
//
//   - `diagnostics` is the observation-only channel. Producers (forces,
//     fields, induction loops, …) declare `contributeDiagnostics(map,
//     sceneCtx)` and write transient readings — Φ_B, EMF, dΦ/dt under
//     Phase 5.D induction (Step 4(b)2) — into `map`. Open-keyed; the
//     producer chooses its own keys. EXCLUDED from `total` and from
//     `drift_pct` by contract — adding a transient driver to the
//     conservation budget would make drift meaningless.
//
// Mixing the two would pollute the conservation bus that 5.C will
// inherit. Keep diagnostics observational; keep contributions closed.
//
// Phase S item S1 — producer dispatch generalization. A "producer" is a
// subsystem MODULE (circuit, flux, induction) that emits diagnostic
// readings but is NOT a force — it has no body to apply to and no
// `appliesTo`/`applyTo` surface. Before S1 the only way to reach the
// diagnostics channel was to masquerade as a force in `this.forces`
// (the circuit producer's `contributeDiagnostics` therefore never ran
// at runtime — it was a standalone export nobody registered, so
// `view.energy.diagnostics` was always empty for circuit scenes). S1
// adds an explicit `producers` list the tracker walks alongside
// `this.forces`, so one dispatch generalization serves every EM
// producer instead of per-module hacks. The producer's conservation-
// channel contribution (`contributeEnergy`) is deliberately NOT
// dispatched yet: circuit stored energy must not enter `total` until
// the MNA solver actually steps live (Phase A3), or closure would
// account energy the live sim never computes.
//
// Phase S item S2 — external work + discrete dissipation. Two new
// budget entry points close energy accounting for IMPULSIVE and DRIVEN
// scenes, which the time-integral `_dissipated += -P·dt` alone cannot:
//
//   - `addDissipated(ΔJ)` — an INSTANTANEOUS thermal deposit. A
//     restitution collision (B1) or perfectly-inelastic merge (B4)
//     loses ΔK = K_before − K_after in a single tick with NO continuous
//     power to integrate; the resolver hands that ΔK straight to the
//     thermal pool so `total` stays closed across the discrete jump.
//
//   - `W_external` — net work done BY an external driver ON the system.
//     A driver force (E1's `TimeVaryingForce`) has `energyKey = null`
//     and no potential to recover, so it pumps energy into K+U with no
//     channel to balance it — `drift_pct` would then track real driver
//     work, not numerical error. The tracker integrates each driver's
//     `F·v` into `_W_external` and SUBTRACTS it from `total`, so the
//     CLOSED budget `K + Σcontributions − W_external` is conserved and
//     `drift_pct` is meaningful for driven scenes too. `addExternalWork`
//     is the discrete sibling (B5 rocket thrust impulses).
//
//   Opt-in, NOT "every energyKey=null force": Tension (constraint
//   reaction) and LorentzForce (magnetic ⊥ v; electric recovered via
//   the energy cross-check) are also energyKey=null but do NO external
//   work — counting their F·v would corrupt the budget. Only a force
//   that declares `powerExternal(body, sceneCtx)` is integrated.
//   Closed-form: with no driver and no discrete deposit both terms are
//   0, so `total` is byte-identical to the pre-S2 baseline.

// Conservation-drift denominator policy. Drift is normally RELATIVE: (E(t) −
// E₀)/|E₀|. That divides by ~0 and explodes when |E₀| ≈ 0 — the canonical case
// being a pendulum released at pivot height (θ₀ = 90°), where choosing the pivot
// as the U_g reference makes E_total(0) ≈ 0 (a floating-point cos(π/2) artifact
// ~1e-16 J) even though the bob swings through mgL of kinetic energy.
//
// The test for "E₀ is an artifact" is SCALE-RELATIVE, not an absolute Joule
// floor: |E₀| < this ratio × the characteristic energy scale (peak |K|/|total|
// in play). An absolute floor (tried first) wrongly caught the dipole_orbit AP-C
// fixture, whose ~5e-5 J total is a GENUINELY small, well-conserved energy
// (|E₀| is a third of its peak K) with a hand-calibrated D_pred — there ÷|E₀| is
// meaningful and must stay. The pendulum's ratio is ~6e-18; dipole_orbit's is
// ~0.33; 1e-9 sits far below any real scene yet far above float artifacts, so
// only artifact-E₀ scenes take the fallback and every real scene is unchanged.
const E0_ARTIFACT_REL_THRESHOLD = 1e-9;

// Conservation drift as a percent, split out as a PURE predicate so its
// artifact-vs-real-small-energy boundary is unit-testable in isolation, the
// negative case included (recurring-shape-bug rule; mirrors the band_verdict.py
// split). `total`/`initialTotal` are the current and first-snapshot closed-
// budget totals (J); `maxScale` is the running max |K|/|total| = the energy
// actually in play, consulted ONLY when E₀ is a ÷~0 artifact (see
// E0_ARTIFACT_REL_THRESHOLD). denom = 0 (a static zero-energy scene) → 0.
export function conservationDriftPct(total, initialTotal, maxScale) {
  const initialAbs = Math.abs(initialTotal);
  const e0IsArtifact = initialAbs < E0_ARTIFACT_REL_THRESHOLD * maxScale;
  const denom = e0IsArtifact ? maxScale : initialAbs;
  return denom > 0 ? 100 * (total - initialTotal) / denom : 0;
}

export class ConservationTracker {
  constructor({ bodies, forces, sceneCtx = {}, producers = [] }) {
    this.bodies = bodies;
    this.forces = forces;
    // Phase S item S1: subsystem modules (circuit now; flux/induction in
    // Phase A0) that emit diagnostics but are not forces. Empty for
    // every non-EM scene, so this is a zero-cost addition there.
    this.producers = producers;
    this.sceneCtx = sceneCtx;
    this._dissipated = 0; // cumulative work removed by non-conservative forces
    this._W_external = 0; // Phase S item S2: cumulative net work done BY external drivers ON the system
    this._initialTotal = null;
    // Running characteristic energy scale = max |K| / |total| seen so far. Only
    // load-bearing on the near-zero-E₀ drift path (see NEAR_ZERO_ENERGY_J): it
    // is the reference-frame-robust "energy in play" the drift is measured
    // against when |E₀| ≈ 0 (e.g. peak KE = mgL for a 90° pendulum). Never
    // consulted when |E₀| ≥ the floor, so it cannot perturb any committed scene.
    this._maxScale = 0;
    this._history = { times: [], totals: [], drifts_pct: [] };
  }

  step(dt, t = null) {
    // Integrate dissipated power from each non-conservative force
    // (Drag, Friction, DipoleInField damping torque). Forces that need
    // scene context (Friction needs a surface lookup for its normal
    // force) receive sceneCtx.
    //
    // Phase S item S2: `t` (post-step time) is threaded so a time-
    // dependent external driver can be primed before its `F·v` is
    // sampled (see the external-work loop below). Legacy callers pass
    // step(dt) → t = null → the priming is skipped (no driver present).
    //
    // Phase 3.6 (Anti-drift item 3 NaN-poisoning guard): each force's
    // powerDissipated return is checked with Number.isFinite BEFORE
    // U_thermal accumulation. A non-finite return aborts the step with
    // an error naming the offending force class — silent NaN poisoning
    // is rejected so tolerance_eb cannot masquerade as a "tolerance
    // exceeded" message when the real bug is upstream.
    for (const f of this.forces) {
      if (typeof f.powerDissipated !== 'function') continue;
      for (const body of this.bodies) {
        if (!f.appliesTo(body.id)) continue;
        const P = f.powerDissipated(body, this.sceneCtx); // negative for dissipative forces
        if (!Number.isFinite(P)) {
          throw new Error(
            `ConservationTracker: force class ` +
            `"${f.constructor?.name ?? 'unknown'}" returned non-finite ` +
            `powerDissipated=${P} on body "${body.id}". ` +
            `Aborting step — silent NaN poisoning of U_thermal is rejected.`
          );
        }
        // U_thermal grows as energy leaves the kinetic+potential pool.
        // dE_thermal = -P dt = -(F . v) dt = positive number when F opposes v.
        this._dissipated += -P * dt;
      }
    }
    // Phase S item S2: external-work integration. A force OPTS IN by
    // exposing `powerExternal(body, sceneCtx)` = F·v (work rate done BY
    // the driver ON the body). Only genuine drivers declare it —
    // Tension and LorentzForce are energyKey=null but do NO external
    // work, so they are deliberately NOT integrated here. The running
    // integral feeds `_W_external`, which `current()` subtracts from
    // `total` to keep the budget closed for driven scenes.
    for (const f of this.forces) {
      if (typeof f.powerExternal !== 'function') continue;
      // Prime a time-dependent driver to the POST-step time so F is
      // sampled at the same instant as the post-step velocity — a
      // consistent right-endpoint rectangular sum, matching the
      // dissipation integral's accuracy class. No-op when t is null
      // (legacy callers) or the force has no setTime (time-independent
      // driver).
      if (t !== null && typeof f.setTime === 'function') f.setTime(t);
      for (const body of this.bodies) {
        if (!f.appliesTo(body.id)) continue;
        const P = f.powerExternal(body, this.sceneCtx); // F·v done BY the driver
        if (!Number.isFinite(P)) {
          throw new Error(
            `ConservationTracker: force class ` +
            `"${f.constructor?.name ?? 'unknown'}" returned non-finite ` +
            `powerExternal=${P} on body "${body.id}". ` +
            `Aborting step — silent NaN poisoning of W_external is rejected.`
          );
        }
        this._W_external += P * dt;
      }
    }
  }

  // Phase S item S2: discrete-loss entry point for an INSTANTANEOUS
  // thermal deposit (no continuous power to integrate). A restitution
  // collision (B1) or perfectly-inelastic merge (B4) computes
  // ΔK = K_before − K_after in one tick and routes it here, so `total`
  // stays closed across the velocity jump. A positive deltaJoules
  // removes mechanical energy into the thermal pool (the usual case).
  addDissipated(deltaJoules) {
    if (!Number.isFinite(deltaJoules)) {
      throw new Error(
        `ConservationTracker.addDissipated: deltaJoules must be finite; ` +
        `got ${deltaJoules}. A non-finite discrete loss would poison U_thermal.`
      );
    }
    this._dissipated += deltaJoules;
  }

  // Phase S item S2: discrete sibling of the W_external integral, for an
  // IMPULSIVE driver (B5 rocket thrust applied as a velocity jump). A
  // positive deltaJoules is net work done BY the driver ON the system;
  // `current()` SUBTRACTS it from `total`, preserving the closed budget.
  addExternalWork(deltaJoules) {
    if (!Number.isFinite(deltaJoules)) {
      throw new Error(
        `ConservationTracker.addExternalWork: deltaJoules must be finite; ` +
        `got ${deltaJoules}. A non-finite work term would poison W_external.`
      );
    }
    this._W_external += deltaJoules;
  }

  current() {
    let K = 0;
    let K_rot = 0;
    const contributions = { U_thermal: this._dissipated };
    // Phase 5.D Step 0b.7: observation-only sibling map. Populated below
    // by producer `contributeDiagnostics()` callbacks. Excluded from
    // `total` and from `drift_pct`.
    const diagnostics = {};
    for (const body of this.bodies) {
      K += body.kineticEnergy();
      // Phase 3.5 (Q9=A): per-DOF split. Particle.kineticEnergyRotational
      // returns 0; RotatingDipole returns ½Iω². K_trans = K − K_rot is
      // computed by the LOL overlay (so the tracker doesn't pin a
      // particular split convention).
      if (typeof body.kineticEnergyRotational === 'function') {
        K_rot += body.kineticEnergyRotational();
      }
    }
    for (const f of this.forces) {
      // Energy-conservation channel: `energyKey` + `potentialEnergy()`.
      if (f.energyKey && f.energyKey !== 'U_thermal') { // U_thermal handled by step()
        let U = 0;
        for (const body of this.bodies) {
          if (!f.appliesTo(body.id)) continue;
          U += f.potentialEnergy(body, this.sceneCtx);
        }
        contributions[f.energyKey] = (contributions[f.energyKey] ?? 0) + U;
      }
      // Diagnostics channel (Phase 5.D Step 0b.7): producer is fully in
      // control of which keys it writes. Receiver is the local
      // `diagnostics` map (a fresh object per `current()` call, so two
      // calls return isolated snapshots). The producer is opt-in — only
      // forces/fields that declare `contributeDiagnostics` participate;
      // 5.B's existing forces (Coulomb, LorentzForce, DipoleInField, …)
      // continue to feed `contributions` only.
      if (typeof f.contributeDiagnostics === 'function') {
        f.contributeDiagnostics(diagnostics, this.sceneCtx);
      }
    }
    // Phase S item S1: producer diagnostics dispatch. Producers are
    // subsystem modules (circuit, flux, induction) registered by the
    // scene loader, NOT forces — they receive the same `(map, sceneCtx)`
    // contract but have no per-body application. Walked here, alongside
    // `this.forces` above, so the circuit / flux / induction producers
    // reach the diagnostics channel without each one re-wiring the
    // tracker. Diagnostics-only by design (see header): a producer's
    // `contributeEnergy` is NOT dispatched until the subsystem steps
    // live, so `total` / `drift_pct` stay byte-identical to baseline.
    for (const p of this.producers) {
      if (typeof p.contributeDiagnostics === 'function') {
        p.contributeDiagnostics(diagnostics, this.sceneCtx);
      }
    }
    // CLOSURE INVARIANT: `total = K + Σ contributions[k] − W_external`.
    // `diagnostics` MUST NOT be added here (see header). Adding a
    // diagnostic value (Φ_B, EMF, dΦ/dt) would corrupt `drift_pct`.
    let total = K;
    for (const k of Object.keys(contributions)) total += contributions[k];
    // Phase S item S2: subtract external driver work so the CLOSED
    // budget is the conserved quantity. `_W_external` is 0 when no
    // driver/impulse acted, so non-driven scenes keep `total` byte-
    // identical to the pre-S2 baseline (the entire 25-scene band set).
    total -= this._W_external;

    if (this._initialTotal === null) {
      this._initialTotal = total;
    }
    // Update the running characteristic energy scale (peak |K| / |total|). K is
    // the frame-robust "energy in motion"; |total| covers scenes whose scale is
    // the (constant) total itself. Only load-bearing on the artifact-E₀ path.
    this._maxScale = Math.max(this._maxScale, Math.abs(K), Math.abs(total));
    const driftPct = conservationDriftPct(total, this._initialTotal, this._maxScale);
    return { K, K_rot, contributions, diagnostics, W_external: this._W_external, total, drift_pct: driftPct };
  }

  snapshot(t) {
    const c = this.current();
    this._history.times.push(t);
    this._history.totals.push(c.total);
    this._history.drifts_pct.push(c.drift_pct);
  }

  history() {
    return {
      times: this._history.times.slice(),
      totals: this._history.totals.slice(),
      drifts_pct: this._history.drifts_pct.slice()
    };
  }
}

export const NAME = 'energy';
