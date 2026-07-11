// engine/constants.js
//
// Phase 5.B Step 0b.3 deliverable: pinned physical constants for the
// SIM engine. Created cold — there is no prior numeric definition of
// ε₀ anywhere in `sim/`. Values come from CODATA-2018 (the most recent
// recommended-value compilation that pre-dates the 2019 SI redefinition
// of fixed constants; ε₀ is no longer exact post-redefinition but
// CODATA-2018's recommended value is the authoritative best-known
// determination).
//
// Why this module exists: Phase 5.B introduces Gauss's-law flux
// scoring (φ_E = Q_enc/ε₀), which is the engine's first numeric use
// of the vacuum permittivity. The plan's Q9 lock requires ε₀ live in a
// single canonical place, NOT inline at the call site. Step 0c's
// canonical-source audit will grep `sim/` for the ε₀ literal and
// confirm `sim/engine/constants.js` is its only home. The grep pattern
// must be more discriminating than `8\.8541` alone — that substring
// hits the unrelated coordinate value `18.854163352030334` inside
// `sim/scenarios/em_proof/charge_in_uniform_field.state.json` (lines
// 1112, 1115). A pattern like `(^|[^0-9])8\.8541878128e-12` (or
// scoping the grep to `*.js`) avoids the false-fire.
//
// Forbid-redefinition note: do NOT add a parallel ε₀ constant in any
// scene/scenario file, validator, or scoring module. If Gauss's-law
// scoring needs the value, import `VACUUM_PERMITTIVITY` from this
// module. If a scene needs to override (e.g., dielectric medium
// future work), the override must be a documented per-scene field —
// not a redefined constant.

/**
 * Vacuum permittivity (electric constant) ε₀.
 *
 * Units: F/m  (= C² / (N·m²)).
 *
 * Source: CODATA-2018 recommended value, 8.8541878128(13) × 10⁻¹² F/m.
 * Reference: https://physics.nist.gov/cgi-bin/cuu/Value?ep0
 *
 * Used by: Phase 5.B Gauss's-law flux scoring (φ_E = Q_enc / ε₀).
 *
 * @type {number}
 */
export const VACUUM_PERMITTIVITY = 8.8541878128e-12;

/**
 * Newtonian gravitational constant G.
 *
 * Units: m³ / (kg·s²)  (= N·m²/kg²).
 *
 * Source: CODATA-2018 recommended value, 6.67430(15) × 10⁻¹¹.
 * Reference: https://physics.nist.gov/cgi-bin/cuu/Value?bg
 *
 * Used by: the universal gravity model (Gravity with model='universal',
 * F = G m₁m₂/r²). The near-surface constant_g model does NOT use this —
 * it uses the per-scene `g` acceleration directly. Default for the
 * `Gravity` constructor's `G` parameter; a scene never overrides it in
 * v1 (a "universal" scene picks its central mass, not a custom G).
 *
 * Forbid-redefinition note (mirrors VACUUM_PERMITTIVITY above): do NOT
 * add a parallel G literal in any scene, validator, or force module.
 * Import this symbol instead.
 *
 * @type {number}
 */
export const GRAVITATIONAL_CONSTANT = 6.67430e-11;

/**
 * Penalty-method contact stiffness, k_contact (N/m).
 *
 * NOT a physical constant — an engine numerical-method tuning parameter,
 * promoted here (Phase B item B1) from a scene.js local so the Surface
 * contact (constraints.js, via sceneCtx.k_contact) and the body-body
 * ContactForce (forces.js) share ONE default rather than duplicating the
 * 1e5 literal. Chosen so a 1 kg body at static equilibrium under gravity
 * penetrates ~0.1 mm — well under the 0.8 mm spike threshold. Higher k =
 * stiffer/shallower contact but needs a smaller dt to integrate.
 *
 * @type {number}
 */
export const DEFAULT_K_CONTACT = 1e5;

/**
 * Penalty-method contact damping, c_damping (N·s/m), for SURFACE contact.
 *
 * 2·√(k·m) ≈ 632 N·s/m for m = 1 kg critically damps the surface contact
 * spring (no bounce-back ringing). Promoted here alongside k_contact for
 * a single home. NOTE: the body-body ContactForce does NOT default to
 * this — it defaults c to 0 (perfectly elastic), and a scene opts into
 * inelasticity with an explicit c_N_s_per_m.
 *
 * @type {number}
 */
export const DEFAULT_C_DAMPING = 632;

/**
 * Penalty-method CONSTRAINT stiffness, k_constraint (N/m).
 *
 * NOT a physical constant — an engine numerical-method tuning parameter for
 * the stiff-penalty inextensibility constraints (RodConstraint, the pendulum
 * bar; StringConstraint, the two-body Atwood string). Promoted here
 * (sim_body_coupling_atwood Phase P2) from the RodConstraint default literal so
 * the single-body rod (constraints.js) and the two-body string share ONE
 * default rather than duplicating the 1e5 literal — the SAME rationale that put
 * DEFAULT_K_CONTACT here. 1×10⁵ N/m makes a ~1 kg body at static equilibrium
 * stretch only ~0.1 mm (well under the spike threshold) while staying integrable
 * at classroom dt. It is also the `k` the StringConstraint's DERIVED critical
 * damping c = 2·√(k·μ) depends on: without a real default here that self-default
 * would evaluate 2·√(undefined·μ) = NaN and silently poison the RK4 state.
 *
 * Distinct from DEFAULT_K_CONTACT (surface CONTACT) only by role/home — both are
 * 1e5 today; kept as separate named constants so the two tuning knobs can move
 * independently if a future scene needs it.
 *
 * @type {number}
 */
export const DEFAULT_K_CONSTRAINT = 1e5;

/**
 * Adaptive-dt per-step LOCAL error budget, in PERCENT.
 *
 * sim_oracle_fidelity Phase P3. This is the DEFAULT for a scene that turns
 * on `simulation.adaptive_dt: true` without an explicit
 * `simulation.driftBudgetPct`. It is the SINGLE authoritative home for the
 * default — the scene schema documents the field as optional and points HERE
 * (schema `default:` is deliberately absent because Ajv `useDefaults` is OFF,
 * so a schema default would never be applied and would only invite drift).
 * `adaptiveDtRunner` in integrator.js reads it as its `?? DEFAULT` fallback.
 *
 * Semantics: the controller estimates the LOCAL (this-step) error by step-
 * doubling (one step of h vs. two of h/2, a Richardson state compare) and
 * expresses it as a percent of the state's own magnitude scale. When that
 * per-step figure exceeds this budget, dt is halved and the step retried.
 * NOTE this is a PER-STEP local-error target, NOT the cumulative
 * energy-conservation drift that energy.js `conservationDriftPct` reports
 * (that one is measured from the first snapshot and cannot bound a single
 * step). 0.1 %/step is a conservative default for classroom scenes.
 *
 * @type {number}
 */
export const DEFAULT_ADAPTIVE_DRIFT_BUDGET_PCT = 0.1;

/**
 * Adaptive-dt stiffness FLOOR, in seconds — the smallest dt the halving
 * controller will descend to before it gives up and takes the step anyway.
 *
 * sim_oracle_fidelity Phase P3. DEFAULT for `simulation.dtFloor` when a
 * scene enables adaptive_dt without specifying one; single home for the
 * default, mirrored by nothing in the schema (see the budget constant
 * above for why). Below this dt a scene is declared "stiffer than the floor
 * allows": the step is accepted over-budget and the event recorded in the
 * stiffness readout (`floorHits`, `minDtReached`) so a floor-pinned scene is
 * visible rather than silently spending the run at a micro dt. Chosen well
 * below any classroom base dt (which the schema caps at 0.1 s), giving room
 * for ~17 halvings from the ceiling.
 *
 * @type {number}
 */
export const DEFAULT_ADAPTIVE_DT_FLOOR_S = 1e-6;

/**
 * Minimum playback rate (slow-motion floor), unitless multiplier on
 * sim-time per wall-clock second.
 *
 * SimRunner.setPlaybackRate clamps to this floor (T2 / plan
 * sim_interactivity_viz): below it the per-tick `targetSimDt` would round
 * to zero integrator steps and the sim would silently freeze. The toolbar
 * speed list (ui/toolbar.js PLAYBACK_RATES) is single-sourced against this
 * value — a CI test asserts every offered speed is >= MIN_PLAYBACK_RATE so
 * no listed option clamps without UI feedback. The legal boundary 0.01x
 * itself may be listed (>=, not >).
 *
 * @type {number}
 */
export const MIN_PLAYBACK_RATE = 0.01;
