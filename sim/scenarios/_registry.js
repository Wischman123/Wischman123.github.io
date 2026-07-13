// scenarios/_registry.js
//
// Phase 3.7 (Q3=C lockstep, Path α full graduation): single source of
// truth for scene enumeration. Three downstream sites import their
// view of this registry:
//
//   1. sim/__tests__/capture-drift-baseline.js — `SCENES` (paths only,
//      sorted by `id` at write time inside the capture script).
//   2. sim/ui/scenario_loader.js — `SCENARIOS` (id + path + preset, in
//      the dropdown's display order).
//   3. package.json `sim:check-bands` chain — generated via the runner
//      `sim/scripts/run_per_scene.js`, which calls
//      `sim/validation/cli_headless.js` per entry below using the
//      `bandsSnapshots` value.
//
// Adding a scene: add ONE entry here. Touch ONE file (this one) and the
// scene flows to all three downstream sites simultaneously. Phase 3.7's
// `feedback_phase_3_6_lessons.md` audit identified three-place lockstep
// (capture-drift + scenario_loader + sim:check-bands) as a
// FORBIDDEN-partial-graduation site per Protocol P1; this file is the
// graduation.
//
// Underscore prefix: this is data-as-code, NOT a test file. The
// underscore prefix matches the project convention for fixture-data
// directories like `sim/__tests__/_baselines/`. (Test files would
// silently fail to run if `package.json test:engine` omitted them — that
// risk does not apply to a non-test data module.)
//
// Field semantics:
//
//   id              — stable scene identifier; matches scene JSON's `id`
//                     field (snake_case, ASCII).
//   path            — relative to `sim/`; consumed by `loadScene` via
//                     `JSON.parse(readFileSync(...))` in capture-drift,
//                     and by `fetch` in `scenario_loader.js`.
//   preset          — '1st_year' | 'ap_c' | null. Mirrors scene JSON's
//                     `preset_required` value. UI uses for filter
//                     gating; CLI ignores. Null = preset-agnostic
//                     (no scene currently uses null).
//   bandsSnapshots  — int. The `--snapshots=N` flag value passed to
//                     `cli_headless.js` for the `sim:check-bands`
//                     invocation. Use 0 to omit the flag entirely.
//                     Most periodic / oscillator scenes need 101 to
//                     resolve their analytic comparison samples; flat
//                     scenes (hello_world, projectile_motion,
//                     ramp_with_friction) run without snapshots.
//   published       — bool. OPTIONAL; defaults to `true` when omitted.
//                     Phase 5.C Step 4(b)2 — engine-smoke-fixture
//                     convention introduced under `scenarios/_test_only/`.
//                     Curriculum-facing tooling (UI dropdowns, packet
//                     scaffolders, problem catalog enumerators) MUST
//                     filter to `published !== false` so smoke fixtures
//                     stay invisible to teachers and students.
//                     Capture-drift-baseline + sim:check-bands ignore
//                     this field — smoke fixtures DO appear in the
//                     rolling baseline (their tracker emissions count
//                     as scene-keyed deltas; alternative architecture
//                     was REJECTED at plan §919-922).
//   trustGateFatal  — bool. OPTIONAL; defaults to `false` when omitted.
//                     sim_oracle_fidelity Phase P4 — the oracle-trust
//                     convergence gate (`sim:check-trust`,
//                     run_per_scene.js::runCheckTrust) CHECKS every
//                     non-skipCheckBands scene, but only a scene marked
//                     `trustGateFatal: true` causes a non-zero exit when
//                     its declared ANSWER quantity is UNTRUSTED (does not
//                     converge under dt→dt/2 Richardson extrapolation).
//                     Opt-in, like `skipCheckBands` — a curated allowlist
//                     of KNOWN-CONVERGING references verified TRUSTED with
//                     many orders of margin (see P4 ship-record). Every
//                     other scene's UNTRUSTED is ADVISORY (printed,
//                     non-fatal): typically a near-zero energy-component
//                     output the author should focus with the schema
//                     `answer: true` flag. Ignored by capture-drift +
//                     sim:check-bands.
//   skipDriftBaseline — bool. OPTIONAL; defaults to `false` when omitted.
//                     sim_numerical_chaos P3 — EXCLUDES the scene from
//                     capture-drift-baseline.js's byte-identical t_final
//                     snapshot (via the DRIFT_BASELINE_SCENE_PATHS filtered
//                     export). A CHAOTIC scene's t_final lands PAST its
//                     divergence horizon, so a byte-pinned baseline would
//                     red-fail on any future 1-ULP engine change —
//                     re-introducing the exact sensitive-dependence
//                     false-fail skipCheckBands opts out of. DEDICATED flag
//                     (not skipCheckBands, which also tags NON-chaotic scenes
//                     whose valid t_final baselines must be kept).
//
// Phase 3.7 Commit 1 lands this file with 13 entries (post-3.6 reality;
// damped_compass_needle was added to UI + check-bands in Phase 3.6 but
// silently omitted from capture-drift's manual SCENES list — the audit
// was Phase 3.6's open issue, the registry-ization closes it). Commit 2
// appends the 14th entry (stern_gerlach) when the new scene's
// supporting JSON, brief, and tests land.
export const SCENES = [
  {
    id: 'hello_world',
    path: 'scenarios/hello_world.json',
    preset: '1st_year',
    bandsSnapshots: 0
  },
  {
    id: 'projectile_motion',
    path: 'scenarios/1st_year/projectile_motion.json',
    preset: '1st_year',
    bandsSnapshots: 0,
    // P4 oracle-trust gate-fatal reference. RK4 integrates constant-g
    // projectile motion EXACTLY (a degree-2 polynomial in t), so the answer
    // at dt vs dt/2 agrees to ~1e-14 — Richardson error ~11 orders below the
    // trust threshold. The plan's named positive convergence anchor.
    trustGateFatal: true
  },
  {
    id: 'ramp_with_friction',
    path: 'scenarios/1st_year/ramp_with_friction.json',
    preset: '1st_year',
    bandsSnapshots: 0
  },
  {
    id: 'spring_oscillator',
    path: 'scenarios/1st_year/spring_oscillator.json',
    preset: '1st_year',
    bandsSnapshots: 101
  },
  {
    id: 'pendulum_small_angle',
    path: 'scenarios/1st_year/pendulum_small_angle.json',
    preset: '1st_year',
    bandsSnapshots: 101
  },
  {
    id: 'pendulum_full_angle',
    path: 'scenarios/1st_year/pendulum_full_angle.json',
    preset: '1st_year',
    bandsSnapshots: 101
  },
  // Phase B item B1 — 1-D collisions (body-body penalty contact). Both
  // emit energy.total (drift_budget closure gate applies) AND a
  // conserved.p_linear block (momentum closure check applies). Flat
  // end-state outputs → bandsSnapshots: 0. The inelastic scene runs at
  // dt=1e-5 (10× finer) so the stiff-contact U_thermal time-integral
  // lands the closure drift under the 0.15% gate — see the brief §6.
  {
    id: 'two_cart_elastic',
    path: 'scenarios/1st_year/two_cart_elastic.json',
    preset: '1st_year',
    bandsSnapshots: 0
  },
  {
    id: 'two_cart_inelastic',
    path: 'scenarios/1st_year/two_cart_inelastic.json',
    preset: '1st_year',
    bandsSnapshots: 0
  },
  // Phase B item B4 — perfectly-inelastic (e=0) discrete merge: the carts stick
  // and move together at v_cm. No contact force; a `collisions` block drives a
  // step-3 resolver (set both to v_cm, deposit ΔK via addDissipated). Force-free
  // before and after the merge ⇒ zero integrator drift, so energy.total holds
  // 9 J and conserved.p_linear drift is exactly 0. Flat end-state ⇒ snapshots 0.
  {
    id: 'two_cart_perfectly_inelastic',
    path: 'scenarios/1st_year/two_cart_perfectly_inelastic.json',
    preset: '1st_year',
    bandsSnapshots: 0
  },
  // Phase B item B2 — 2-D glancing collision via the discrete restitution-impulse
  // resolver (mode='restitution', e=1). Equal 1 kg pucks, one at rest, off-axis
  // (impact parameter 0.12 m ⇒ a 3-4-5 contact normal) scatter at the textbook
  // 90°. No contact force; a `collisions` block drives an equal-and-opposite
  // impulse along the contact normal. Σp=(4,0) and K=8 J both conserved (e=1 ⇒
  // ΔK=0); the 90° separation (v_a'·v_b'=0) is a detection-tick-independent
  // invariant. Flat end-state ⇒ snapshots 0.
  {
    id: 'two_cart_glancing_elastic',
    path: 'scenarios/1st_year/two_cart_glancing_elastic.json',
    preset: '1st_year',
    bandsSnapshots: 0
  },
  // Phase B item B3 — centre of mass + system momentum (non-collision opt-in).
  // Two free gliders (no force, no contact, no collision) that opt into the
  // momentum diagnostic via `diagnostics.system_momentum`; the loader registers
  // the linear-momentum tracker + emits the read-only `com` block. System p=(6,0)
  // conserved ⇒ v_cm=(2,0) constant while the parts drift apart; force-free ⇒
  // machine-precision exact. Validates the opt-in path that B1/B4 collision scenes
  // bypass. Flat end-state ⇒ snapshots 0.
  {
    id: 'two_body_com_drift',
    path: 'scenarios/1st_year/two_body_com_drift.json',
    preset: '1st_year',
    bandsSnapshots: 0
  },
  // Phase P5.1 (sim_body_coupling_atwood) — the two-body-COUPLING consuming
  // scenes: the FIRST scenes to exercise the new `string` constraint (Atwood,
  // P2) and `body_spring` force (coupled oscillator, P3). All mechanics scenes
  // with a REAL expected.values band gate (velocity/energy end-state + the
  // energy.total closure budget), exactly like ramp_with_friction / rolling_disk,
  // so NO skipCheckBands.
  //   atwood_machine   — m1=3.0 / m2=2.0 over an ideal pulley; a=(m1−m2)g/(m1+m2)
  //                      =1.96 m/s²; ideal string does zero net work ⇒ U_thermal=0,
  //                      energyKey=null. Non-periodic uniform-a end state ⇒
  //                      bandsSnapshots 0.
  //   atwood_modified  — SAME closed form, LARGER ratio m1=4.0 / m2=1.0 ⇒ a=5.88
  //                      m/s² (duration trimmed to 0.5 s so the lighter mass never
  //                      reaches the pulley). bandsSnapshots 0.
  //   coupled_oscillator — m1=2.0 / m2=1.0 joined by one body_spring (k=50 N/m,
  //                      L0=2.0 m), gravity off; ω=√(k/μ)=8.660 rad/s, E=½kA₀²=2.25 J
  //                      conserved, CoM fixed. Periodic ⇒ bandsSnapshots 101.
  // Penalty params carried into each Atwood scene JSON per the P5.1 value-flow
  // lock: k_constraint=1e5, c_damping=2√(k·μ) from the scene's OWN reduced mass μ
  // (692.82 for 3/2; 565.69 for 4/1). Deeper physics (equal tension T, slack,
  // T≥0, CoM/ω) pinned in string_constraint.test.js + body_spring.test.js. Briefs:
  // docs/physics_briefs/{atwood_machine,coupled_oscillator}_brief.md.
  {
    id: 'atwood_machine',
    path: 'scenarios/1st_year/atwood_machine.json',
    preset: '1st_year',
    bandsSnapshots: 0
  },
  {
    id: 'atwood_modified',
    path: 'scenarios/1st_year/atwood_modified.json',
    preset: '1st_year',
    bandsSnapshots: 0
  },
  {
    id: 'coupled_oscillator',
    path: 'scenarios/1st_year/coupled_oscillator.json',
    preset: '1st_year',
    bandsSnapshots: 101
  },
  // sim_buoyancy_fluids P4 — the two EXTENSION_TESTS "Fluid parcel" scenes,
  // first consumers of the BuoyantForce + FluidField engine surface (P3).
  //   bobbing_float    — 0.5×0.5 prism (ρ=600, m=150) released 0.10 m above
  //                      equilibrium in water (ρ=1000). Partial-submersion
  //                      regime ⇒ linear restoring force ⇒ genuine SHM about
  //                      y_eq=−0.05 (d_eq=0.30), T=2π√(m/ρg·A_wp)=1.099 s,
  //                      energy.total flat at 171.5 J (K+U_g+U_buoyant closure).
  //                      Real expected.values band gate (final-state + periodic
  //                      drift budget), so NO skipCheckBands. Periodic ⇒
  //                      bandsSnapshots 101. Period + g-parity + regime-crossing
  //                      drift pinned in sim/engine/__tests__/buoyancy.test.js.
  //   submerged_block  — dense free block (ρ=2000) + explicit floor; fully-
  //                      submerged constant-F_b regime; sinks and settles.
  // Brief: docs/physics_briefs/sim_buoyancy_fluids_brief.md.
  {
    id: 'bobbing_float',
    path: 'scenarios/1st_year/bobbing_float.json',
    preset: '1st_year',
    bandsSnapshots: 101
  },
  // submerged_block — dense free block (m=320, ρ=2000) fully submerged, sinks
  // through water and settles on an explicit floor. A gentle linear drag
  // (b=4000 ⇒ v_terminal=0.39 m/s) models fluid resistance AND tames the
  // engine's penalty-contact damping (c_damping=632 is tuned for ~1 kg bodies;
  // ζ=1/√m ⇒ a 320 kg block is severely underdamped and would bounce for many
  // seconds without it). At rest drag=0, so the force balance is exact:
  // n = k_contact·depth = 1e5·0.01568 = 1568 N = mg − F_b (apparent weight).
  // Surface contact resolves at the body CENTER (vs. the surface line, not the
  // block's extent), so the floor sits at −0.80 (= brief y_c,rest) and the block
  // center rests there. Fully
  // submerged throughout (constant F_b regime) ⇒ NO regime crossing. Non-
  // periodic settle ⇒ bandsSnapshots 0. energy.total is deliberately NOT emitted
  // (surface-contact damping is untracked → not an energy-closure scene; the
  // conservation payload is bobbing_float). NO skipCheckBands — the settle
  // (position.y/velocity.y → rest) IS the band gate.
  {
    id: 'submerged_block',
    path: 'scenarios/1st_year/submerged_block.json',
    preset: '1st_year',
    bandsSnapshots: 0
  },
  // bobbing_float_damped — the SAME float as bobbing_float + one linear drag
  // (b=300 ⇒ ζ≈0.175 underdamped). Shows damped SHM decaying to equilibrium
  // (y_eq=−0.05) AND — the pedagogical payload — that energy.total is CONSERVED
  // (drift ~1e-7%): buoyancy's work lives in U_buoyant (conservative), drag's in
  // U_thermal (grows 0→24.5 J = ½·k_eff·A²), and the two channels are ORTHOGONAL
  // (no double-count). If buoyancy were wrongly ALSO dissipative, total would
  // drift. Non-periodic (decaying) ⇒ periodic=false, per-second drift budget,
  // bandsSnapshots 0. Undamped period is asserted on bobbing_float only (the
  // damped ω_d ≠ ω₀); this scene's payload is the energy closure, not T.
  {
    id: 'bobbing_float_damped',
    path: 'scenarios/1st_year/bobbing_float_damped.json',
    preset: '1st_year',
    bandsSnapshots: 0
  },
  {
    id: 'charge_in_uniform_field',
    path: 'scenarios/em_proof/charge_in_uniform_field.json',
    preset: 'ap_c',
    bandsSnapshots: 101
  },
  {
    id: 'coulomb_two_body',
    path: 'scenarios/ap_c/coulomb_two_body.json',
    preset: 'ap_c',
    bandsSnapshots: 101,
    // P4 oracle-trust gate-fatal reference (AP-C central-force orbit). RK4 at
    // the committed dt converges the in-plane orbit answer to ~1e-7 of the
    // trust threshold — a verified converging AP-C anchor.
    trustGateFatal: true
  },
  {
    id: 'test_charge_orbit',
    path: 'scenarios/ap_c/test_charge_orbit.json',
    preset: 'ap_c',
    bandsSnapshots: 101
  },
  // Gravitation Phase D — first universal-gravity (GMm/r²) scene. A 1 kg
  // planet in a circular orbit around a heavy star at the origin; clean
  // unit numbers (GM=1 ⇒ v=1 m/s, T=2π s, K=0.5 J, U_g=−1 J, E=−0.5 J,
  // F=1 N). Mirrors coulomb_two_body's in-plane orbit pattern (energy
  // half-counting valid — both bodies in applies_to), so it carries a full
  // expected.values band-check (bandsSnapshots=101), unlike the deferred
  // out-of-plane charged_line_test_orbit. Verifies Kepler's 3rd law +
  // energy conservation. Force/PE coverage in gravity_universal.test.js.
  {
    id: 'gravitational_orbit',
    path: 'scenarios/ap_c/gravitational_orbit.json',
    preset: 'ap_c',
    bandsSnapshots: 101,
    // P4 oracle-trust gate-fatal reference (universal-gravity circular orbit).
    // RK4 converges the orbit answer to ~1e-9 of the trust threshold — a
    // verified converging gravitation anchor.
    trustGateFatal: true
  },
  // sim_orbital_angular_momentum P4 — Kepler-II equal-areas ellipse. Forks
  // gravitational_orbit (same GM=1 star) with a sub-circular tangential v0=0.8
  // at apoapsis (1,0), giving a bound ellipse (e=0.36, T=3.9616 s) with
  // conserved orbital L=0.8. Registers BOTH conserved channels so the state
  // file RENDERS the contrast: spin-only L_angular ≡ 0 (point masses, I=ω=0)
  // beside the total L_total=0.8 that proves equal areas. Periodic conservative
  // orbit ⇒ bandsSnapshots 101. The physics markers (L_total/energy tolerance,
  // L_angular≡0, apoapsis-return) live in kepler_second_law_markers.test.js and
  // assert the P1-derived PERIAPSIS band (kepler_second_law.tol.json), NOT the
  // inherited circular band. No trustGateFatal (advisory trust check only).
  {
    id: 'kepler_second_law',
    path: 'scenarios/ap_c/kepler_second_law.json',
    preset: 'ap_c',
    bandsSnapshots: 101
  },
  // dawn_last_burn_live_sim_v1 D2 — verification fixture for the scheduled
  // impulsive-Δv burn primitive. A scaled circular orbit (GM=1, r=1, v=1) + one
  // prograde `maneuvers` burn (Δv/v = F001's 0.0802413) reshapes into the analytic
  // ellipse r_apo/r = 1.400733. The burn books ΔK_burn via addExternalWork, so the
  // scene EMITS energy.total and the SINGLE global closure holds across the burn
  // (drift_budget ~1e-12) — NO skipCheckBands; the energy.total closure IS a primary
  // weld. End-state + non-periodic drift budget ⇒ bandsSnapshots 0. published:false —
  // a verification fixture (like the _proof scenes), out of the public dropdown.
  {
    id: 'maneuver_verify_orbit',
    path: 'scenarios/ap_c/maneuver_verify_orbit.json',
    preset: 'ap_c',
    bandsSnapshots: 0,
    published: false
  },
  // dawn_last_burn_live_sim_v1 D3 — the full F001 "Dawn's Last Burn" story as one
  // welded scene: Dawn in a scaled circular orbit (GM=1, r0=1, v_A=1) fires a
  // scheduled prograde `maneuvers` burn (Δv/v_A = F001's 0.0802) that reshapes the
  // circle into an ellipse (r_C/r0 = 1.40072), coasts to apoapsis C, where a
  // GRAVITY-BOUND debris fragment sticks (perfectly_inelastic, ΔK → U_thermal). ONE
  // global energy.total closure: the burn books ΔK via addExternalWork, the merge
  // deposits ΔK via addDissipated, so the drift budget holds across the WHOLE run
  // (~5e-12). A burn injects EXTERNAL momentum, so this scene opts OUT of the
  // collision-triggered p_linear closure (scene.js maneuver exclusion) — like a
  // box_wall gas. End-state + non-periodic drift budget ⇒ bandsSnapshots 0.
  // Published 2026-07-13 by user decision at the D4 gate ("publish it; I can take
  // it down if I don't like it") — the live dropdown IS the review surface. Emitted
  // by the orbit_burn_collision archetype — re-run
  // tools/sim_authoring/emit_dawn_last_burn.py to regenerate.
  {
    id: 'dawn_last_burn',
    path: 'scenarios/ap_c/dawn_last_burn.json',
    preset: 'ap_c',
    bandsSnapshots: 0
  },
  // Quick-win pack — quadratic-drag terminal velocity. The cv² Drag model
  // was implemented + unit-tested (forces.js) but had no committed scene.
  // 1 kg sphere falling from 100 m: F_drag=cv² (c=0.2) balances mg at
  // v_terminal=√(mg/c)=7 m/s. Non-periodic + dissipative (energy → U_thermal,
  // total conserved), so bandsSnapshots=0 like projectile/ramp. Engine
  // output matches the closed-form tanh solution to ~1e-15.
  {
    id: 'terminal_velocity_quadratic',
    path: 'scenarios/ap_c/terminal_velocity_quadratic.json',
    preset: 'ap_c',
    bandsSnapshots: 0
  },
  // Quick-win pack — uniform circular motion via the existing RodConstraint
  // (the simple-pendulum mechanism), no engine change. 1 kg puck on a
  // frictionless top-down table (gravity off), tethered by a rigid 1 m rod;
  // a 1 m/s tangential push gives uniform circular motion (a_c=v²/L=1 m/s²,
  // F_c=mv²/L=1 N, T=2πL/v=2π s). Mechanical-tension twin of
  // gravitational_orbit (same T), so periodic + conservative ⇒
  // bandsSnapshots=101. Rod is critically damped (c=632=2√(km)); RodConstraint
  // coverage already lives in the pendulum scenes.
  {
    id: 'uniform_circular_rod',
    path: 'scenarios/ap_c/uniform_circular_rod.json',
    preset: 'ap_c',
    bandsSnapshots: 101
  },
  // Quick-win pack — first time-dependent force. A 1 kg free particle
  // driven by F(t)=F₀sin(ωt) (new TimeVaryingForce, primed by derivState
  // via setTime(t)) so a(t)=sin t, v(t)=1−cos t, x(t)=t−sin t (the cycloid
  // functions). External driving ⇒ mechanical energy not conserved, so —
  // like the cycloid scene — it emits position/velocity only and the
  // drift-budget check SKIPs. Non-periodic ⇒ bandsSnapshots=0.
  {
    id: 'driven_particle_1d',
    path: 'scenarios/ap_c/driven_particle_1d.json',
    preset: 'ap_c',
    bandsSnapshots: 0
  },
  {
    id: 'dipole_orbit',
    path: 'scenarios/ap_c/dipole_orbit.json',
    preset: 'ap_c',
    bandsSnapshots: 101
  },
  {
    id: 'compass_needle',
    path: 'scenarios/ap_c/compass_needle.json',
    preset: 'ap_c',
    bandsSnapshots: 101
  },
  {
    id: 'dipole_in_linear_gradient',
    path: 'scenarios/ap_c/dipole_in_linear_gradient.json',
    preset: 'ap_c',
    bandsSnapshots: 101
  },
  {
    id: 'damped_compass_needle',
    path: 'scenarios/ap_c/damped_compass_needle.json',
    preset: 'ap_c',
    bandsSnapshots: 101
  },
  {
    id: 'stern_gerlach',
    path: 'scenarios/ap_c/stern_gerlach.json',
    preset: 'ap_c',
    bandsSnapshots: 101
  },
  {
    id: 'damped_dipole_drag_translation',
    path: 'scenarios/ap_c/damped_dipole_drag_translation.json',
    preset: 'ap_c',
    bandsSnapshots: 101
  },
  {
    id: 'damped_compass_needle_critical',
    path: 'scenarios/ap_c/damped_compass_needle_critical.json',
    preset: 'ap_c',
    bandsSnapshots: 101
  },
  {
    id: 'damped_compass_needle_overdamped_zeta4',
    path: 'scenarios/ap_c/damped_compass_needle_overdamped_zeta4.json',
    preset: 'ap_c',
    bandsSnapshots: 101
  },
  {
    id: 'damped_compass_needle_overdamped_zeta10',
    path: 'scenarios/ap_c/damped_compass_needle_overdamped_zeta10.json',
    preset: 'ap_c',
    bandsSnapshots: 101
  },
  // Phase 5.A.6 — three new scenes for Q1=ε + Q3=γ. Static-field scenes
  // carry duration_s=1e-3 (single integrator step; bandsSnapshots=0 since
  // there is no time evolution to sample). Orbit scene carries
  // duration_s=T_analytic≈1.497s; bandsSnapshots=101 matches the AP-C
  // orbit convention. The orbit scene's drift-budget gate is currently
  // todo (geometric incompatibility with 2D-coplanar embedding); see
  // §5.A.5 ship-record.
  {
    id: 'charged_line_perpendicular',
    path: 'scenarios/ap_c/charged_line_perpendicular.json',
    preset: 'ap_c',
    bandsSnapshots: 0
  },
  {
    id: 'charged_sheet_perpendicular',
    path: 'scenarios/ap_c/charged_sheet_perpendicular.json',
    preset: 'ap_c',
    bandsSnapshots: 0
  },
  {
    id: 'charged_line_test_orbit',
    path: 'scenarios/ap_c/charged_line_test_orbit.json',
    preset: 'ap_c',
    bandsSnapshots: 101
    // Re-tuned 2026-05-04 (Path B fix). Original orbit setup was
    // geometrically infeasible (2D-coplanar embedding cannot host a
    // 3D-perpendicular line orbit; 1.897% drift over T=1.497 s).
    // Replaced with release-from-rest radial drop: probe at (0, 4) m,
    // v=0, falls along perpendicular bisector for T=0.9 s. Trajectory
    // is geometrically valid in 2D; deterministic; energy drift -0.0000%.
    // The id 'charged_line_test_orbit' is RETAINED so historical
    // baselines and tests that key on it stay valid (rename would
    // create false "removed + added" diffs in Phase G workflows).
    // Engine-side cure for the original geometric obstruction is
    // deferred — see docs/sketches/active/physics_simulator_engine_adaptive_dt_singularity_regularization.md
    // and docs/sketches/active/physics_simulator_phase_5_e_em_closure.md §E.
  },
  // Phase 5.B Step 4(b) — three new gauss-surface scenes (Q1=α trio:
  // sphere ↔ point, cylinder ↔ line, pillbox ↔ sheet). Static-field
  // scenes (duration_s=1e-3, single integrator step; bandsSnapshots=0
  // since there is no time evolution to sample). The flux residual is
  // verified in `sim/engine/__tests__/flux.test.js` (per-scene
  // runFluxCheck calls), NOT via sim:check-bands — these scenes carry
  // no `expected.values` block. `skipCheckBands: true` keeps them
  // registry-listed (UI + capture-drift-baseline) without dragging
  // them through the check-bands gate.
  {
    id: 'point_charge_gauss_sphere',
    path: 'scenarios/ap_c/point_charge_gauss_sphere.json',
    preset: 'ap_c',
    bandsSnapshots: 0,
    skipCheckBands: true
  },
  {
    id: 'line_charge_gauss_cylinder',
    path: 'scenarios/ap_c/line_charge_gauss_cylinder.json',
    preset: 'ap_c',
    bandsSnapshots: 0,
    skipCheckBands: true
  },
  {
    id: 'sheet_charge_gauss_pillbox',
    path: 'scenarios/ap_c/sheet_charge_gauss_pillbox.json',
    preset: 'ap_c',
    bandsSnapshots: 0,
    skipCheckBands: true
  },
  // Phase 5.D Step 4(b)3 — first induction scene fixture (Q1=a, Scene 1).
  // Bar-on-rails motional EMF: uniform B=1.0 T ẑ, L=0.5 m, x₀=0.4 m, v=+2.0 m/s;
  // predicted EMF = -B·L·v = -1.0 V (Lenz sign locked by +ẑ normal). Bodies
  // are pinned (single integrator step; bandsSnapshots=0). The motional-EMF
  // verification lives in sim/engine/__tests__/induction_motional_1.scene.test.js
  // (mirrors the 5.B Gauss-scene pattern: registry-listed for capture-drift +
  // UI; physics verification in a dedicated test file rather than via
  // sim:check-bands). `skipCheckBands: true` keeps the scene out of the
  // expected.values gate.
  {
    id: 'induction_motional_1',
    path: 'scenarios/ap_c/induction_motional_1.json',
    preset: 'ap_c',
    bandsSnapshots: 0,
    skipCheckBands: true
  },
  // Phase 5.D Step 4(b)4 — second induction scene fixture (Q1=a, Scene 2).
  // Time-varying-uniform-B EMF: B(t)=B₀ sin(ωt) ẑ with B₀=1.0 T, ω=2π rad/s
  // (T_period=1.0 s), circular loop R=0.30 m in xy-plane, normal +ẑ. Predicted
  // EMF(t) = -A·B₀·ω·cos(ωt) ≈ -1.7765·cos(2π·t) V (Lenz sign locked by +ẑ
  // normal; at t=0, dB/dt>0 ⇒ Φ rising ⇒ EMF<0). Bodies are pinned (single
  // integrator step; bandsSnapshots=0). Aliasing guard satisfied: dt=1e-3 s
  // ≤ T_period/100 = 1e-2 s per 0c JSON discrete_dt_max_rule. Physics
  // verification lives in sim/engine/__tests__/induction_time_varying_b_1.scene.test.js;
  // `skipCheckBands: true` keeps the scene out of the expected.values gate
  // (same convention as Scene 1 and 5.B Gauss scenes).
  {
    id: 'induction_time_varying_b_1',
    path: 'scenarios/ap_c/induction_time_varying_b_1.json',
    preset: 'ap_c',
    bandsSnapshots: 0,
    skipCheckBands: true
  },
  // Phase 5.C Step 4(b)2 — RC charging smoke fixture (FIRST production-engine
  // caller of runCircuitCheck). V_0=1V, R=1Ω, C=1F; closure at t=τ=1 s asserts
  // |v_C(t=1) − (1−e⁻¹)| / V_0 < 1e-3 (smoke band) in
  // sim/engine/__tests__/rc_smoke_2node.scene.test.js. Engine-smoke-fixture
  // convention: lives under scenarios/_test_only/, registered with
  // `published: false` so curriculum tooling skips it (no precedent in
  // 5.A/5.B/5.D — 5.C establishes it). bandsSnapshots=0 + skipCheckBands=true
  // mirror the 5.B Gauss + 5.D induction static-snapshot pattern: physics
  // verification lives in the dedicated scene-test file, not via the
  // expected.values band-check gate. Capture-drift-baseline DOES include this
  // scene (alternative architecture rejected at plan §919-922); its tracker
  // emissions count as the FIRST scene-keyed delta in the rolling-baseline
  // contract.
  {
    id: 'rc_smoke_2node',
    path: 'scenarios/_test_only/rc_smoke_2node.json',
    preset: null,
    bandsSnapshots: 0,
    skipCheckBands: true,
    published: false
  },
  // Phase 5.C Step 4(b)3 — canonical pedagogical RC charging scene
  // (curriculum-facing sibling of the 4(b)2 smoke fixture). V_0=5V, R=1Ω,
  // C=1F; tau=1s; closure assertion: |v_C(t) − 5·(1 − e^(−t/τ))| / V_0 <
  // 1e-4 over t ∈ [0, 5τ] at dt=τ/100=0.01 s (per 0c JSON
  // per_scene_tolerances.rc_charging_1). Verification lives in
  // sim/engine/__tests__/rc_charging_1.scene.test.js (SST contract — parses
  // JSON once, feeds parsed params to BOTH runCircuitCheck and rcCharging).
  // bandsSnapshots=0 + skipCheckBands=true mirror the smoke fixture and 5.B
  // Gauss + 5.D induction static-snapshot pattern; rolling-baseline tracker
  // emissions count as +N additive scene-keyed deltas (predicted N=5 per
  // 0c JSON predicted_baseline_deltas.rc_charging_1.additive_keys, pending
  // 5B-shipped tracker wiring per first_caller_bookmarks.runCircuitCheck).
  // `published` omitted — defaults true; visible to curriculum tooling.
  {
    id: 'rc_charging_1',
    path: 'scenarios/ap_c/rc_charging_1.json',
    preset: 'ap_c',
    bandsSnapshots: 0,
    skipCheckBands: true
  },
  // Phase 5.C Step 4(b)4 — canonical pedagogical RL relaxation scene
  // (curriculum-facing; no smoke-band sibling — RL did not need a first-
  // fire smoke pass since the SST scaffold is inherited intact from
  // 4(b)3). I_0=1A, R=1Ω, L=1H; tau=L/R=1s; closure assertion:
  // |i_L(t) − I_0·(1 − e^(−t/τ))| / I_0 < 1e-4 over t ∈ [0, 5τ] at
  // dt=τ/100=0.01 s (per 0c JSON per_scene_tolerances.rl_relaxation_1 —
  // tolerances harmonize with rc_charging_1 since both are first-order
  // exponentials). Verification lives in
  // sim/engine/__tests__/rl_relaxation_1.scene.test.js (SST contract —
  // parses JSON once, feeds parsed params to BOTH runCircuitCheck and
  // rlRelaxation). bandsSnapshots=0 + skipCheckBands=true mirror 4(b)3
  // and the 5.B Gauss + 5.D induction static-snapshot pattern; rolling-
  // baseline tracker emissions count as +N additive scene-keyed deltas
  // (predicted N=5 per 0c JSON predicted_baseline_deltas
  // .rl_relaxation_1.additive_keys, pending 5B-shipped tracker wiring
  // per first_caller_bookmarks.runCircuitCheck). `published` omitted —
  // defaults true; visible to curriculum tooling.
  {
    id: 'rl_relaxation_1',
    path: 'scenarios/ap_c/rl_relaxation_1.json',
    preset: 'ap_c',
    bandsSnapshots: 0,
    skipCheckBands: true
  },
  // Phase 5.C Step 4(b)5 — canonical pedagogical RLC underdamped relaxation
  // scene (curriculum-facing; no smoke-band sibling — RLC did not need a
  // first-fire smoke pass since the SST scaffold is inherited intact from
  // 4(b)3 / 4(b)4 via copy-and-substitute → extractRLCParams). V_0=5V,
  // R=0.2Ω, L=1H, C=1F (cap pre-charged, no source); α=R/(2L)=0.1 s⁻¹,
  // ω_d≈0.99499 rad/s, T_d≈6.31479 s, τ_env=1/α=10 s; closure assertion:
  // |v_C(t) − rlcUnderdamped(t,V_0,R,L,C)| / max(|predicted|,V_0) < 1e-3
  // over t ∈ [0, 5/α=50 s] at dt=T_d/200≈0.0316 s (per 0c JSON
  // per_scene_tolerances.rlc_underdamped_1 — relative_tol loosens to 1e-3
  // because oscillatory phase drift accumulates over many cycles; dt
  // tightens vs. 0c JSON's T_d/100 upper bound because phase drift over
  // ~8 cycles at the upper bound exceeds 1e-3 budget; T_d/200 cuts phase
  // error 4× and leaves headroom). Verification lives in
  // sim/engine/__tests__/rlc_underdamped_1.scene.test.js (SST contract —
  // parses JSON once, feeds parsed params to BOTH runCircuitCheck and
  // rlcUnderdamped; predictor signature is parametric — computes α, ω_d
  // internally via rlcDiscriminant; no τ scalar). Sign-flip discipline:
  // i_branch_L1 ≈ −rlcBranchCurrent(t) at every tick (cap passive sign
  // convention vs. inductor active in from→to direction). bandsSnapshots
  // =0 + skipCheckBands=true mirror 4(b)3 / 4(b)4 and the 5.B Gauss +
  // 5.D induction static-snapshot pattern; rolling-baseline tracker
  // emissions count as +N additive scene-keyed deltas (predicted N=6 per
  // 0c JSON predicted_baseline_deltas.rlc_underdamped_1.additive_keys,
  // pending 5B-shipped tracker wiring per first_caller_bookmarks
  // .runCircuitCheck). `published` omitted — defaults true; visible to
  // curriculum tooling.
  {
    id: 'rlc_underdamped_1',
    path: 'scenarios/ap_c/rlc_underdamped_1.json',
    preset: 'ap_c',
    bandsSnapshots: 0,
    skipCheckBands: true
  },
  // Phase 5.C Step 4(b)6 — canonical induced-current scene (curriculum-
  // facing; Q4=a CONDITIONAL — first 5.D runInductionCheck consumer
  // integration test). Couples 5.D's motional-bar configuration (B=1.0 T
  // ẑ, L_bar=0.5 m, v=+2.0 m/s — same as induction_motional_1) into a
  // 5.C series VS — R — L circuit as a constant motional EMF =
  // -B·L_bar·v = -1.0 V; externally added R=1 Ω, L_ind=1 H; tau_RL=1 s;
  // closure assertion: |i_loop(t) − (EMF/R)·(1 − e^(−t/τ_RL))| /
  // max(|predicted|, |EMF/R|) < 1e-4 over t ∈ [0, 5·tau_RL=5 s] at
  // dt=tau_RL/10=0.1 s (per 0c JSON
  // per_scene_tolerances.induced_current_1; first-order exponential band
  // tightens vs. RLC's 1e-3 back to RC/RL's 1e-4 since constant-EMF
  // motional bar is single-exponential). Verification lives in
  // sim/engine/__tests__/induced_current_1.scene.test.js (SST contract —
  // parses JSON once, feeds parsed params to BOTH runCircuitCheck and
  // inducedCurrentRL; cad-1 callable .value installed on VS1 via the
  // 4(b)6-prep widening; round-trip byte-equal pin asserts EMF_circuit_input
  // == manual-staging EMF for both EMF_t and EMF_t_plus_dt at every
  // tick). Sign convention: VS(from=n_top, to=gnd, value=-1) sets
  // v_n_top=-1; current flows positive in n_top→R→n_mid→L→gnd direction
  // when EMF<0, so i_branch_L1 < 0 throughout (asymptotes to -1 A).
  // bandsSnapshots=0 + skipCheckBands=true mirror 4(b)3-4(b)5 and the
  // 5.B Gauss + 5.D induction static-snapshot pattern; rolling-baseline
  // tracker emissions count as +N additive scene-keyed deltas (predicted
  // N=5 per 0c JSON predicted_baseline_deltas.induced_current_1
  // .additive_keys, pending 5B-shipped tracker wiring per
  // first_caller_bookmarks.runCircuitCheck). `published` omitted —
  // defaults true; visible to curriculum tooling.
  {
    id: 'induced_current_1',
    path: 'scenarios/ap_c/induced_current_1.json',
    preset: 'ap_c',
    bandsSnapshots: 0,
    skipCheckBands: true
  },
  // Phase 5.C Step 4(b)7 — canonical multi-mesh resistor-network scene
  // (curriculum-facing; Q1=b CONDITIONAL — last canonical scene before
  // the 4(c) atom rollup). Pure resistive linear network: 4 nodes (n1,
  // n2, n3, gnd), 6 elements (2 VS + 4 R), 3 meshes. V_VS1=10V grounded
  // to n1; V_VS2=2V grounded to n3; R1=10Ω n1↔n2, R2=20Ω n2↔gnd,
  // R3=5Ω n2↔n3, R4=25Ω n3↔gnd. Closed-form node-voltage solve (KCL at
  // n2 — sole unknown): V_n2 = (V_n1/R1 + V_n3/R3)/(1/R1 + 1/R2 + 1/R3)
  // = 4 V exactly. Branch currents: I_R1=+0.6, I_R2=+0.2, I_R3=+0.4,
  // I_R4=+0.08, I_VS1=+0.6 (delivering), I_VS2=-0.32 A (absorbing —
  // pedagogical counter-example to "every source delivers"). Power
  // balance: ΣP_R = ΣP_VS_delivered = 5.36 W. Per-scene tolerance LOCKED
  // in 0c JSON: relative_tol=1e-6 (LU-decomposition precision floor;
  // tightens 100× vs. the first-order RC/RL/induced_current 1e-4 band
  // because there is no time-truncation error in a static linear
  // network — the only residual is LU round-off on a well-conditioned
  // 3-unknown reduced system, kappa ≈ 11). dt_pin_rule per 0c JSON: dt
  // does not affect closure (steady state in 1 trapezoidal tick); pin
  // dt=1e-3 s for snapshot determinism only. t_horizon=10·dt=10e-3 s
  // for tracker-channel coverage (11 ticks). NO 5.D coupling — VS
  // sources are static numeric `value`; the cad-1 callable widening
  // shipped at 97053e9 is regression-tested in components.test.js and
  // is not exercised here. Verification lives in
  // sim/engine/__tests__/network_resistor_1.scene.test.js (SST contract —
  // parses JSON once, feeds parsed object to BOTH runCircuitCheck and
  // networkResistor1SteadyState; analytic predictor lives in
  // sim/scenarios/ap_c/_derivations/network_resistor_analytic.js).
  // bandsSnapshots=0 + skipCheckBands=true mirror 4(b)3-4(b)6 and the
  // 5.B Gauss + 5.D induction static-snapshot pattern; rolling-baseline
  // tracker emissions count as +N additive scene-keyed deltas
  // (predicted N=8 per 0c JSON predicted_baseline_deltas
  // .network_resistor_1.additive_keys, pending 5B-shipped tracker
  // wiring per first_caller_bookmarks.runCircuitCheck). `published`
  // omitted — defaults true; visible to curriculum tooling.
  {
    id: 'network_resistor_1',
    path: 'scenarios/ap_c/network_resistor_1.json',
    preset: 'ap_c',
    bandsSnapshots: 0,
    skipCheckBands: true
  },
  // T5 (sim_t5_rail_brake_coupled_ode) — coupled induction rod-on-rails magnetic
  // brake (Option B: the loop current I is a TRUE first-order integrator ODE
  // state, deterministic in headless AND browser — no MNA). brake_1 is critically
  // damped (τ=1 s, current peaks 0.736 A at t=1 s); brake_2 is the overdamped
  // generality consumer (L=0.25 H, same machinery, param-only difference). Both
  // published (they replace review item 8's "barely moves / current persists"
  // placeholder with honest physics). induction_motional_1 (above) stays
  // PUBLISHED — its retirement, if any, is a separate curriculum decision, NOT a
  // side effect of this engine extension (plan §Phase 3 decision gate). Briefs:
  // docs/physics_briefs/induction_rail_brake_{1,2}_brief.md. skipCheckBands +
  // bandsSnapshots:0 mirror the induction/circuit static-snapshot fixtures; the
  // engine-vs-analytic gate is _derivations/rail_brake_analytic.test.js.
  {
    id: 'induction_rail_brake_1',
    path: 'scenarios/ap_c/induction_rail_brake_1.json',
    preset: 'ap_c',
    bandsSnapshots: 0,
    skipCheckBands: true
  },
  {
    id: 'induction_rail_brake_2',
    path: 'scenarios/ap_c/induction_rail_brake_2.json',
    preset: 'ap_c',
    bandsSnapshots: 0,
    skipCheckBands: true
  },
  // Phase C1 (sim_phase_c_magnetism, Stage ②) — first magnetism-from-currents
  // scene. Static viz of a straight wire's azimuthal B (current_wire field,
  // |B| = mu0*I/2*pi*r) rendered via the existing in-plane B-arrow draw leg; a
  // single pinned probe body carries the (trivial) tick. skipCheckBands +
  // bandsSnapshots:0 mirror the static-field fixtures — the closed-form
  // magnitude is pinned by sim/engine/__tests__/current_wire_field.test.js,
  // NOT by check-bands (whose quantity vocabulary has no field-magnitude band).
  // Brief: docs/physics_briefs/c1_current_wire_field_brief.md.
  {
    id: 'current_wire_straight',
    path: 'scenarios/ap_c/current_wire_straight.json',
    preset: 'ap_c',
    bandsSnapshots: 0,
    skipCheckBands: true
  },
  // Phase C1b (sim_phase_c_magnetism, Stage ②) — `solenoid` mode of the
  // current_wire field. Idealized-INFINITE solenoid, axis in-plane along x:
  // uniform interior B = mu0*n*I inside the bore |y| < R, 0 outside, rendered
  // via the existing in-plane B-arrow draw leg. Four pinned probes frame the
  // bore (the ±x pair sit inside, the ±y pair just outside). skipCheckBands +
  // bandsSnapshots:0 mirror the static-field fixtures — the closed-form
  // interior magnitude and the interior/exterior boundary are pinned by
  // sim/engine/__tests__/current_wire_field.test.js (check-bands has no
  // field-magnitude band). Brief: docs/physics_briefs/sim_phase_c_magnetism_brief.md.
  {
    id: 'solenoid_field',
    path: 'scenarios/ap_c/solenoid_field.json',
    preset: 'ap_c',
    bandsSnapshots: 0,
    skipCheckBands: true
  },
  // Phase C loop follow-on (sim_phase_c_magnetism, Stage ②) — `loop` mode of
  // the current_wire field. A single circular loop, axis in-plane along x: the
  // EXACT off-axis B via complete elliptic integrals K(k)/E(k) (Simpson's
  // form, helper `ellipke`), NOT a dipole approximation. Renders via the
  // in-plane B-arrow leg — interior +x, reversing to -x outside the loop. Four
  // pinned probes frame the loop (on-axis ±x pair; exterior ±y pair).
  // skipCheckBands + bandsSnapshots:0 mirror the static-field fixtures — the
  // on-axis closed form, far-field dipole limit, and elliptic integrals are
  // pinned by sim/engine/__tests__/current_wire_field.test.js (check-bands has
  // no field-magnitude band). Brief:
  // docs/physics_briefs/sim_phase_c_loop_field_brief.md.
  {
    id: 'loop_field',
    path: 'scenarios/ap_c/loop_field.json',
    preset: 'ap_c',
    bandsSnapshots: 0,
    skipCheckBands: true
  },
  // Phase C solenoid follow-on (sim_phase_c_magnetism, Stage ②) —
  // `solenoid_finite` mode of the current_wire field. A FINITE-length solenoid,
  // axis in-plane along x: the EXACT off-axis B by integrating the single-loop
  // kernel over the length via composite Simpson (reuses loopFieldInPlane), so
  // it FRINGES (interior not exactly uniform), unlike the idealized-infinite
  // `solenoid`. Renders via the in-plane B-arrow leg. Four pinned probes: on-axis
  // center + end (end ~ half center) + on-axis exterior + off-axis equator
  // exterior (-x return). skipCheckBands + bandsSnapshots:0 mirror the static-
  // field fixtures — the on-axis closed form, fringing, far-field dipole, and
  // winding throw are pinned by sim/engine/__tests__/current_wire_field.test.js
  // (check-bands has no field-magnitude band). Brief:
  // docs/physics_briefs/sim_phase_c_solenoid_variants_brief.md.
  {
    id: 'solenoid_finite_field',
    path: 'scenarios/ap_c/solenoid_finite_field.json',
    preset: 'ap_c',
    bandsSnapshots: 0,
    skipCheckBands: true
  },
  // Phase C solenoid follow-on (sim_phase_c_magnetism, Stage ②) —
  // `solenoid_perp` mode of the current_wire field. An idealized-INFINITE
  // solenoid whose axis is ⊥ the plane (along z): bore = disk r < R, interior
  // uniform B = mu0*n*I along z, 0 outside. Renders as DOT tokens inside the
  // disk via the Bz dot/cross leg (NOT in-plane arrows) — the first current_wire
  // mode that renders as tokens. Four pinned probes: two inside the disk, two
  // outside. skipCheckBands + bandsSnapshots:0 mirror the static-field fixtures —
  // the interior magnitude and interior/exterior boundary are pinned by
  // sim/engine/__tests__/current_wire_field.test.js (check-bands has no
  // field-magnitude band). Brief:
  // docs/physics_briefs/sim_phase_c_solenoid_variants_brief.md.
  {
    id: 'solenoid_perp_field',
    path: 'scenarios/ap_c/solenoid_perp_field.json',
    preset: 'ap_c',
    bandsSnapshots: 0,
    skipCheckBands: true
  },
  // Phase C2 (sim_phase_c_magnetism, Stage ②) — magnetism-from-currents FORCES.
  // (1) parallel_wires: two wires ⊥ the plane; the new `current_in_field` force
  //     (F = I·L×B, L ⊥ plane) reproduces Ampère's force law
  //     |F| = mu0*I1*I2*Lz/(2*pi*d). Both wires pinned → static force viz.
  // (2) motor_loop: a current loop's motor torque tau = (mu x B).z via the
  //     EXISTING RotatingDipole + dipole_in_field path (mu = I*A), uniform
  //     in-plane B. Librating (no commutator) — demonstrates the torque.
  // skipCheckBands + bandsSnapshots:0: the closed-form force magnitude and the
  // torque→omega integration are pinned by
  // sim/engine/__tests__/current_in_field.test.js (check-bands has no band for
  // force magnitude; compass_needle already covers the dipole energy drift).
  // Brief: docs/physics_briefs/sim_phase_c_magnetism_brief.md.
  {
    id: 'parallel_wires',
    path: 'scenarios/ap_c/parallel_wires.json',
    preset: 'ap_c',
    bandsSnapshots: 0,
    skipCheckBands: true
  },
  {
    id: 'motor_loop',
    path: 'scenarios/ap_c/motor_loop.json',
    preset: 'ap_c',
    bandsSnapshots: 0,
    skipCheckBands: true
  },
  // Phase D2 (sim_phase_d_rotation, Stage ③) — rolling with / without slipping.
  // First scenes to exercise the new `rolling_contact` force (a slip-velocity
  // PENALTY that couples a rigid body's translation + rotation through the
  // contact patch; rides the shipped {F, tau} stride-6 torque routing). Unlike
  // the magnetism/circuit fixtures these carry a REAL expected.values band gate
  // (mechanics scenes with energy.total closure, exactly like ramp_with_friction),
  // so NO skipCheckBands — the energy-closure + end-state bands run in the
  // sim:check-bands sweep. Flat non-periodic end-state ⇒ bandsSnapshots 0.
  //   rolling_disk_incline  — µ_s=0.5, rolls: v=ωR (K_rot/K_trans=½=I/MR²),
  //                           spurious penalty heat 0.0167 J (drift 8e-4%).
  //   rolling_disk_slipping — µ_s=0.1 < tanθ/3, skids: σ=v+ωR≈5.7 m/s at 2 s,
  //                           real kinetic-friction heat 3.9 J (drift 1.4e-3%).
  // Deeper physics (a=⅔g sinθ, v=ωR throughout, slip growth) pinned in
  // sim/engine/__tests__/rolling_contact.test.js. Brief:
  // docs/physics_briefs/sim_phase_d2_rolling_brief.md.
  {
    id: 'rolling_disk_incline',
    path: 'scenarios/ap_c/rolling_disk_incline.json',
    preset: 'ap_c',
    bandsSnapshots: 0
  },
  {
    id: 'rolling_disk_slipping',
    path: 'scenarios/ap_c/rolling_disk_slipping.json',
    preset: 'ap_c',
    bandsSnapshots: 0
  },
  // Phase D4 — physical pendulum (uniform rod pivoted at one end, θ₀=20°). The
  // reusable seam is selective translational-DOF SUPPRESSION: a pivoted
  // RigidBody's CoM is slaved to θ (never free-falls) and gravity's net force is
  // folded into a moment about the pivot, so it rotates about the pivot with
  // I_pivot = ⅓ML². Carries a REAL expected.values band gate (energy.total
  // closure — the un-narrowed total tracked energy, the regression guard against
  // the two-oscillator double-count), so NO skipCheckBands. Snapshotted over one
  // small-angle period ⇒ bandsSnapshots 101. Period T = 2π√(I_pivot/MgD) =
  // 1.6388 s (true swing 0.77% longer at 20°, inside the 2% warn band) and the
  // slaving invariant |CoM−pivot|=D are pinned in
  // sim/engine/__tests__/integrator_rotational.test.js. Brief:
  // docs/physics_briefs/sim_phase_d4_pendulum_brief.md.
  {
    id: 'physical_pendulum_rod',
    path: 'scenarios/ap_c/physical_pendulum_rod.json',
    preset: 'ap_c',
    bandsSnapshots: 101
  },
  // Phase G (sim_phase_g_authoring, runbook Stage ④) — scene-authoring scaffold
  // proof set. Five verifying twins auto-STUBBED from existing energy problems
  // by tools/sim_scene_scaffold.py (deterministic, no metered API). Each scene's
  // duration_s is tuned so the engine's final state lands on the problem's
  // analytical answer moment (fall-time / slide-time / quarter-period / traverse).
  // published:false — verification fixtures, not curriculum (curriculum tooling
  // filters published!==false). NO skipCheckBands: their emitted expected.values
  // run through sim:check-bands as the anti-drift forcing function (Tier-1 self-
  // consistency). bandsSnapshots:0 — final-state check, no analytic-sample
  // resolution needed (verified: `cli_headless --check-against` passes without
  // --snapshots). The CORRECTNESS gate (engine output vs hand-derived closed
  // form) lives in tools/sim_scene_scaffold.py + tools/sim_authoring/
  // frozen_reference.json, proven in tools/sim_authoring/__tests__/. Brief:
  // docs/physics_briefs/sim_phase_g_proofset_brief.md.
  {
    id: 'proof_energy_a001_free_fall',
    path: 'scenarios/_proof/proof_energy_a001_free_fall.json',
    preset: '1st_year',
    bandsSnapshots: 0,
    published: false
  },
  // energy-B004 (Hoover Dam) verifying scene — closeout C2 batch-1 weld. Models
  // part (b) ONLY: the idealized free fall through the h=160 m head, v=sqrt(2gh)
  // =56.0 m/s. The engine models no turbine; the power/efficiency parts are
  // arithmetic. Frozen analytical reference + the deliberate omission of a
  // position.y check (0.001 m floor vs final-step residue) are derived in
  // docs/physics_briefs/energy-B004_brief.md.
  {
    id: 'proof_energy_b004_free_fall',
    path: 'scenarios/_proof/proof_energy_b004_free_fall.json',
    preset: '1st_year',
    bandsSnapshots: 0,
    published: false
  },
  // energy-B002 (Tesla emergency stop) verifying scene — closeout C2 batch-2 weld.
  // The car is seated at the EXACT penalty-contact equilibrium depth
  // (mg/k_contact = 0.17248 m): the flat road sits at y=+0.17248 and the car at
  // y=0, so N = mg = 17248 N constant, v_normal stays 0 (the contact damping term
  // never fires), and U_g = 0. A body placed ON the surface line would get N = 0
  // and NO friction at all; dropped on, a 1760 kg body bounces (zeta = 0.024) for
  // the whole run. Derivation + the deliberate omission of a velocity.x check
  // (analytic 0 vs the 0.01 m/s floor) are in docs/physics_briefs/energy-B002_brief.md.
  {
    id: 'proof_energy_b002_flat_brake',
    path: 'scenarios/_proof/proof_energy_b002_flat_brake.json',
    preset: '1st_year',
    bandsSnapshots: 0,
    published: false
  },
  // energy-B001 (Kingda Ka) verifying scene — closeout C2 batch-2. Gravity-only
  // vertical projectile; duration is the ASCENDING root of h = v0 t - g t^2/2, so
  // the final state is the first arrival at the 139 m tower top (v = +22.904 m/s).
  // No surface => no penalty contact => energy.total is exactly conserved and safe
  // to freeze. Brief: docs/physics_briefs/energy-B001_brief.md.
  {
    id: 'proof_energy_b001_vertical_launch',
    path: 'scenarios/_proof/proof_energy_b001_vertical_launch.json',
    preset: '1st_year',
    bandsSnapshots: 0,
    published: false
  },
  // energy-B007 (Fibonacci's spring cart) verifying scene — closeout C2 batch-2.
  // The engine's Spring is TWO-SIDED and cannot release the cart, so the launcher
  // is represented by its energy-equivalent launch speed v0 = x*sqrt(k/m) at the
  // release point. Exact for every frozen quantity: friction is constant along the
  // path, so Ue = f*d_total regardless of how the push is distributed. mu_k is
  // GIVEN and d is PREDICTED (8.1633 m) — a stronger oracle than B002, where mu_k
  // was fixed by d. Brief: docs/physics_briefs/energy-B007_brief.md.
  {
    id: 'proof_energy_b007_spring_flat',
    path: 'scenarios/_proof/proof_energy_b007_spring_flat.json',
    preset: '1st_year',
    bandsSnapshots: 0,
    published: false
  },
  // energy-B005 (Herschel's playground slide) verifying scene — closeout C2 batch-4.
  // Body slides from REST down a rough incline, arriving at a GIVEN speed (8 m/s);
  // mu_k is inferred from the arrival speed and an author-chosen slope angle
  // (theta=35 deg — the problem states only h and v). The angle-INVARIANT oracle is
  // U_thermal = mgh - K = 1206 J (= f*L for every theta yielding v=8.0); arrival
  // speed is the consistency check. Like D001, energy.total is not frozen (penalty
  // contact damping is untracked). Brief: docs/physics_briefs/energy-B005_brief.md.
  {
    id: 'proof_energy_b005_slide',
    path: 'scenarios/_proof/proof_energy_b005_slide.json',
    preset: '1st_year',
    bandsSnapshots: 0,
    published: false
  },
  // energy-C005 (Ramanujan's incline spring) verifying scene — closeout C2 batch-2.
  // Same spring idealization as B007. Answer moment is a TURNING POINT, not rest:
  // mg sin(30) > mu*N, so the block slides back down — duration is exactly v0/a_up
  // with NO settle margin. The block starts on the ideal slope line (U_g = 0) and
  // only the SURFACE is offset by depth*n (depth = mg cos(theta)/k_contact), so the
  // frozen positions stay exactly d*cos/d*sin. Brief: docs/physics_briefs/energy-C005_brief.md.
  {
    id: 'proof_energy_c005_spring_incline',
    path: 'scenarios/_proof/proof_energy_c005_spring_incline.json',
    preset: '1st_year',
    bandsSnapshots: 0,
    published: false
  },
  // energy-C001 (bungee) verifying scene — closeout C2 batch-2. Resolves C1's
  // one-sided-cord caveat rather than dodging it: a real cord goes slack below its
  // natural length while the engine's Spring is two-sided, but this run STARTS at
  // exactly len = L moving downward and the stretch grows monotonically to 30 m, so
  // the slack regime is never entered. k = 2mgH/s^2 is cross-checked independently
  // against the SHM amplitude (s_eq + A = 30.000000 m). The scene is shifted so the
  // lowest point sits at y = 5 m, keeping position.y and energy.total off their
  // absolute floors. Brief: docs/physics_briefs/energy-C001_brief.md.
  {
    id: 'proof_energy_c001_bungee',
    path: 'scenarios/_proof/proof_energy_c001_bungee.json',
    preset: '1st_year',
    bandsSnapshots: 0,
    published: false
  },
  // ── C2 cluster 3: universal gravity + charged launcher (ap_c preset) ──
  // AP-energy-C001 (Tsiolkovsky's orbital plunge). Satellite in a circular HIGH
  // orbit (r1 = R+800km) under universal gravity; the two-body star/planet
  // template is scenarios/ap_c/gravitational_orbit.json. Speed sqrt(GM/r) and
  // energy.total -GMm/2r are constant around the orbit, so the answer is
  // duration-independent; the run covers a quarter period so a wrong launch speed
  // would visibly drift r and speed. No surface => energy.total exactly conserved.
  // Brief: docs/physics_briefs/AP-energy-C001_brief.md.
  {
    id: 'proof_ap_energy_c001_orbit',
    path: 'scenarios/_proof/proof_ap_energy_c001_orbit.json',
    preset: 'ap_c',
    bandsSnapshots: 0,
    published: false
  },
  // energy-K013 (Kepler's asteroid). Rock thrown straight up from the surface;
  // rises to r_max where Ug=mgy is invalid and -GMm/r is required. Radial (x=0
  // for all t). Answer moment = apex (v=0), so velocity is NOT frozen; position.y
  // = r_max is stationary there (2nd-order duration insensitivity). duration =
  // radial-Kepler rise time. Brief: docs/physics_briefs/energy-K013_brief.md.
  {
    id: 'proof_energy_k013_asteroid_launch',
    path: 'scenarios/_proof/proof_energy_k013_asteroid_launch.json',
    preset: 'ap_c',
    bandsSnapshots: 0,
    published: false
  },
  // energy-K018 (Halley's probe). Probe released from rest at height R (start
  // radius 2R), falls radially to the surface; impact speed = sqrt(GM/R) is
  // non-zero so it is frozen as speed. The impact is at full speed (not an apex),
  // so duration is the exact radial-Kepler fall time (= rise time by symmetry). No
  // surface primitive. Brief: docs/physics_briefs/energy-K018_brief.md.
  {
    id: 'proof_energy_k018_moon_fall',
    path: 'scenarios/_proof/proof_energy_k018_moon_fall.json',
    preset: 'ap_c',
    bandsSnapshots: 0,
    published: false
  },
  // energy-K006 (Cavendish's lunar launch). Models the LAUNCHER phase only: a
  // charged probe accelerated from rest by a uniform E-field over d=200 m, gravity
  // off (like the horizontal spring launcher). Final speed sqrt(2qEd/m) = the
  // launch speed needed to reach orbit. The uniform field cannot be spatially
  // bounded to the launcher, so the coast-to-orbit is not one integrable scene;
  // the orbital-speed claim is universal_gravity_orbit physics (AP-energy-C001).
  // Brief: docs/physics_briefs/energy-K006_brief.md.
  {
    id: 'proof_energy_k006_field_launch_orbit',
    path: 'scenarios/_proof/proof_energy_k006_field_launch_orbit.json',
    preset: 'ap_c',
    bandsSnapshots: 0,
    published: false
  },
  // energy-K012 (Hertz's cut pendulum) verifying scene — closeout C2 batch-4.
  // Charged pendulum in a uniform DOWNWARD field: the field adds qE, so the bob
  // swings under g_eff = g + qE/m and v_B = sqrt(2 g_eff L (1-cos60)) = 4.20 m/s.
  // Models the SWING only (rod + gravity + field on a charge); the string-cut
  // projectile is a separate ballistic phase, hand-verified. energy.total not
  // emitted (field work not in U_g). Brief: docs/physics_briefs/energy_K012_brief.md.
  {
    id: 'proof_energy_k012_charged_pendulum',
    path: 'scenarios/_proof/proof_energy_k012_charged_pendulum.json',
    preset: 'ap_c',
    bandsSnapshots: 0,
    published: false
  },
  // energy-K014 (Van de Graaff's electromagnetic brake) verifying scene — batch-4.
  // A charge slides on a flat surface under BOTH friction (mu=0.20) and an opposing
  // constant field (qE=2.0 N), to its max distance d = 3.289 m. Answer moment is a
  // TURNING POINT (qE > mu_s*mg, so the field drives it back), not settle-to-rest.
  // energy.total not emitted (field does non-conservative work). First scene to
  // combine charge + surface friction. Brief: docs/physics_briefs/energy_K014_brief.md.
  {
    id: 'proof_energy_k014_field_brake',
    path: 'scenarios/_proof/proof_energy_k014_field_brake.json',
    preset: 'ap_c',
    bandsSnapshots: 0,
    published: false
  },
  // energy-E002 (Franklin's ice ramp) verifying scene — closeout C2 batch-4.
  // ramp -> frictionless ice -> up-ramp. Models the FINAL up-ramp leg only (part c:
  // max height 5.299 m): sharp surface junctions collide away the normal velocity a
  // fillet/arc would conserve (deferred with the circular_arc cluster), so the exact
  // ice speed (11.20 m/s) is folded into entry_speed. Turning point mechanics (block
  // slides back). energy.total closed but not frozen (untracked contact damping, cf.
  // D001/B005). Brief: docs/physics_briefs/energy-E002_brief.md.
  {
    id: 'proof_energy_e002_ramp_ice_ramp',
    path: 'scenarios/_proof/proof_energy_e002_ramp_ice_ramp.json',
    preset: '1st_year',
    bandsSnapshots: 0,
    published: false
  },
  // energy-K015 (Euler's Hilltop) verifying scene — the FIRST scene to use the
  // circular_arc (convex) surface. A bead crests a frictionless hill and leaves
  // it when the normal force reaches zero. The approach track is folded into the
  // entry speed (same sharp-junction reason as E002 above). duration = t_sep, so
  // the final state IS the answer: separation at cos(theta)=14/15 exactly.
  // Separation needs no event machinery — penalty contact is one-sided, so when N
  // would go negative the bead simply rises off the arc. energy.total closed but
  // not frozen (untracked contact damping, cf. E002/D001/B005).
  // Brief: docs/physics_briefs/energy-K015_brief.md.
  {
    id: 'proof_energy_k015_hilltop',
    path: 'scenarios/_proof/proof_energy_k015_hilltop.json',
    preset: '1st_year',
    bandsSnapshots: 0,
    published: false
  },
  // energy-K007 (Millikan's Charged Hilltop) verifying scene. A charge crests a
  // convex hill in a uniform UPWARD field, so it moves under g_eff = g - qE/m =
  // 7.8 m/s^2 (the engine carries real gravity + a Lorentz force; g_eff is the
  // shared analytical shortcut). The base->apex climb is folded into the apex
  // entry speed v_B (part b); the scene slides down the far side to the N=0
  // separation. energy.total NOT emitted (uniform field does unbooked work).
  // Brief: docs/physics_briefs/energy_K007_brief.md.
  {
    id: 'proof_energy_k007_field_hilltop',
    path: 'scenarios/_proof/proof_energy_k007_field_hilltop.json',
    preset: 'ap_c',
    bandsSnapshots: 0,
    published: false
  },
  // energy-K010 (Maxwell's Charged Dome) verifying scene. A charge slides off a
  // convex dome in a uniform DOWNWARD field, g_eff = g + qE/m = 14.8 m/s^2. It is
  // nudged from the apex and separates when N reaches zero at cos(theta)=2/3
  // (field-independent). n=0 separation is a free consequence of the one-sided
  // penalty contact. energy.total NOT emitted (uniform field does unbooked work).
  // Brief: docs/physics_briefs/energy_K010_brief.md.
  {
    id: 'proof_energy_k010_field_dome',
    path: 'scenarios/_proof/proof_energy_k010_field_dome.json',
    preset: 'ap_c',
    bandsSnapshots: 0,
    published: false
  },
  // energy-K017 (Descartes's Vertical Circle) verifying scene. A ball on a rigid
  // rod travels the half circle from the bottom to the top; the answer is the top
  // speed v_B = sqrt(v_A^2 - 4gL). The rod stays in tension throughout, so rod and
  // taut string are equivalent. Stiff rod k_constraint=1e8 at verlet dt=2e-5 (the
  // half-circle peaks at ~4x the K012 swing tension, so it needs a stiffer rod than
  // K012's 1e7; the K012 penalty-rod convergence finding). The top is a speed
  // extremum and position.y a maximum, so
  // both are 2nd-order insensitive to the exact landing. energy.total NOT emitted
  // (untracked penalty-rod contact damping, cf. the pendulum builders).
  // Brief: problems/docs/physics_briefs/energy_K017_brief.md.
  {
    id: 'proof_energy_k017_vertical_circle',
    path: 'scenarios/_proof/proof_energy_k017_vertical_circle.json',
    preset: '1st_year',
    bandsSnapshots: 0,
    published: false
  },
  // energy-K003 (Electrostatic Launcher) verifying scene. A charged sphere is
  // accelerated horizontally by a capacitor (field only between the plates) then
  // rides the INSIDE of a frictionless vertical loop (circular_arc_concave) from
  // the bottom B to the top C. The capacitor work folds into v_B = sqrt(2qEd/m) =
  // 4.0 m/s and the loop is pure gravity, so the loop body is modeled uncharged.
  // Answer = top speed v_C = sqrt(v_B^2 - 4gR) = 2.490 m/s. The one-sided concave
  // contact gives loop departure for free (too slow -> N<0 -> body lifts inward).
  // The top is a speed extremum and position.y a maximum, so both are 2nd-order
  // insensitive to the exact landing. energy.total NOT emitted (untracked penalty
  // contact damping). Derivation: docs/physics_briefs/concave_loop_welds_brief.md.
  {
    id: 'proof_energy_k003_field_loop',
    path: 'scenarios/_proof/proof_energy_k003_field_loop.json',
    preset: '1st_year',
    bandsSnapshots: 0,
    published: false
  },
  // energy-K004 (Electrostatic Updraft) verifying scene. A charged sphere runs
  // down a ramp into a vertical loop (circular_arc_concave) under a uniform UPWARD
  // field throughout, so the whole motion is at g_eff = g - qE/m = 5.8 m/s^2. The
  // ramp folds into v_B = sqrt(2 g_eff h) = 3.406 m/s; answer = top speed v_C =
  // sqrt(v_B^2 - 4 g_eff R) = 2.408 m/s. The scene carries real gravity + the
  // Lorentz force of the +y field; g_eff is the analytical shortcut the seating
  // and transit agree on. energy.total NOT emitted (field work off the U_g books +
  // untracked contact damping). Derivation: docs/physics_briefs/concave_loop_welds_brief.md.
  {
    id: 'proof_energy_k004_field_loop',
    path: 'scenarios/_proof/proof_energy_k004_field_loop.json',
    preset: 'ap_c',
    bandsSnapshots: 0,
    published: false
  },
  // energy-K009 (Coulomb's Charged Loop) verifying scene. A charged ball runs down
  // a ramp into a vertical loop (circular_arc_concave) under a uniform DOWNWARD
  // field throughout, so the motion is at g_eff = g + qE/m = 11.8 m/s^2. Ramp folds
  // into v_B = sqrt(2 g_eff h) = 5.950 m/s; answer = top speed v_C = sqrt(v_B^2 -
  // 4 g_eff R) = 3.435 m/s. Heavier body (m=0.50 kg) than K003/K004: N_B = 41.3 N
  // -> 0.41 mm seating depth (still under the 1 mm position floor). Scene carries
  // real gravity + the Lorentz force of the -y field. energy.total NOT emitted.
  // Derivation: docs/physics_briefs/concave_loop_welds_brief.md.
  {
    id: 'proof_energy_k009_field_loop',
    path: 'scenarios/_proof/proof_energy_k009_field_loop.json',
    preset: 'ap_c',
    bandsSnapshots: 0,
    published: false
  },
  // energy-C002 (Lovelace's Loop) verifying scene. A 500 kg coaster released from
  // rest at H=35 m rides the INSIDE of a vertical loop (circular_arc_concave, R=10
  // m); answer (part d) = top speed v_C = sqrt(2gH - 4gR) = sqrt(294) = 17.146 m/s.
  // Both frozen quantities are mass-independent. The heavy body seats N_B/k=0.39 m
  // deep at the default k -> a 3.2% top-speed error, so the loop surface carries a
  // per-surface k_contact=1e7 override (error scales ~1/k -> ~0.03%). Derivation:
  // docs/physics_briefs/concave_loop_welds_brief.md.
  {
    id: 'proof_energy_c002_loop',
    path: 'scenarios/_proof/proof_energy_c002_loop.json',
    preset: '1st_year',
    bandsSnapshots: 0,
    published: false
  },
  // energy-K005 (Faraday's Charged Ramp) verifying scene. A charged sphere runs
  // down a frictionless quarter-ramp in a DOWNWARD field (g_eff=g+qE/m=13.8),
  // exits horizontally at v_B=sqrt(2 g_eff R)=3.715 m/s, then LEAVES the field to
  // a pure-gravity projectile from H=1.2 m. The ramp+field fold into v_B; the
  // scene models the projectile and verifies the RANGE (part d) = v_B*sqrt(2H/g)
  // = 1.838 m + the impact speed. rk4 is exact for the parabola. Derivation:
  // docs/physics_briefs/k005_projectile_weld_brief.md.
  {
    id: 'proof_energy_k005_field_curved',
    path: 'scenarios/_proof/proof_energy_k005_field_curved.json',
    preset: '1st_year',
    bandsSnapshots: 0,
    published: false
  },
  // --- out-of-scope re-triage welds (2026-07-11) ---
  // Four problems whose DEFINING physics is out of engine scope (bending pole /
  // multi-body Goldberg chain / 3-D banked turn / v^2 stopping-distance table)
  // but which ASK a numeric question answered by a plain 2-D trajectory the
  // engine already models faithfully. Same B004/E002 precedent: weld the one
  // modelable part; the rest is arithmetic. Derivation (two-way oracle):
  // docs/physics_briefs/out_of_scope_retriage_welds_brief.md +
  // docs/physics_briefs/out_of_scope_retriage_oracle.py.
  //
  // energy-C006 (v^2 speed-trap). Part b/d: at 60 mph (26.8 m/s) the car stops in
  // 60.0 m -- exactly 4x the 15 m at 30 mph (the v^2 punchline). Braking decel is
  // calibrated from the given anchor (13.4 m/s -> 15 m => a=5.985 m/s^2) and 60 m
  // is PREDICTED. Same flat_friction_brake pattern as B002 (whose part d is this
  // same lesson): car seated at mg/k_contact=0.147 m so N=mg constant. Only the
  // mass-independent stop distance (position.x=60.0) is frozen; U_thermal depends
  // on the arbitrary mass and is not.
  {
    id: 'proof_energy_c006_speed_trap_brake',
    path: 'scenarios/_proof/proof_energy_c006_speed_trap_brake.json',
    preset: '1st_year',
    bandsSnapshots: 0,
    published: false
  },
  // energy-C007 (Goldberg's chain). Part a: the 0.20 kg ball released from rest at
  // the top of the frictionless stage-1 ramp (h=1.0 m) reaches sqrt(2gh)=4.427 m/s
  // at the bottom -- the D002 incline pattern. Stages 2-4 (spring hand-off to a
  // second ball, projectile, friction slide) are the multi-body chain the engine
  // does not integrate as one scene; the weld covers stage 1 only.
  {
    id: 'proof_energy_c007_stage1_ramp',
    path: 'scenarios/_proof/proof_energy_c007_stage1_ramp.json',
    preset: '1st_year',
    bandsSnapshots: 0,
    published: false
  },
  // energy-K008 (Volta's banked turn). Part b: the 0.30 kg ball released from rest
  // at the top of the frictionless ramp (h=0.70 m) reaches sqrt(2gh)=3.704 m/s at
  // location B. The E-field lives only in the curve and does no work (centripetal),
  // so the ramp descent is pure gravity -- the D002 incline pattern. Parts c/d/e
  // (banked-curve FBD, normal force) are 3-D horizontal-circle geometry, out of
  // the 2-D vertical plane; the weld covers part b only.
  {
    id: 'proof_energy_k008_ramp_entry',
    path: 'scenarios/_proof/proof_energy_k008_ramp_entry.json',
    preset: '1st_year',
    bandsSnapshots: 0,
    published: false
  },
  // energy-B003 (Duplantis pole vault). Part b/c: "if K were the only energy
  // source" -- the pole is explicitly removed -- an 80 kg vaulter launched
  // straight up at v0=10 m/s from COM height 1.0 m peaks at 6.102 m. The B001
  // vertical_launch pattern (gravity-only, no surface => energy.total exactly
  // conserved). The 5.10 m rise falls short of the 5.31 m record rise, which is
  // the pedagogical crux: K alone is not enough, so the pole IS required. The
  // bending-pole elastic storage is the out-of-scope core; the weld covers the
  // counterfactual K-only launch the question actually poses.
  {
    id: 'proof_energy_b003_konly_launch',
    path: 'scenarios/_proof/proof_energy_b003_konly_launch.json',
    preset: '1st_year',
    bandsSnapshots: 0,
    published: false
  },
  // energy-C003 (Gauss's Atwood) verifying scene. Unlike the duration-tuned
  // proof scenes above, this resolves its per-body outputs at t*=1.2777531s via
  // the sim_oracle_fidelity numeric `at` selector (no duration hand-tuning).
  // Pulley at y=6.0 gives 2.24 m clearance so the run never hits the string
  // singularity. Brief: docs/physics_briefs/energy-C003_brief.md.
  {
    id: 'proof_energy_c003_atwood',
    path: 'scenarios/_proof/proof_energy_c003_atwood.json',
    preset: '1st_year',
    bandsSnapshots: 0,
    published: false
  },
  {
    id: 'proof_energy_d002_incline',
    path: 'scenarios/_proof/proof_energy_d002_incline.json',
    preset: '1st_year',
    bandsSnapshots: 0,
    published: false
  },
  {
    id: 'proof_energy_k019_pendulum',
    path: 'scenarios/_proof/proof_energy_k019_pendulum.json',
    preset: '1st_year',
    bandsSnapshots: 0,
    published: false
  },
  {
    id: 'proof_energy_k016_spring',
    path: 'scenarios/_proof/proof_energy_k016_spring.json',
    preset: '1st_year',
    bandsSnapshots: 0,
    published: false
  },
  {
    id: 'proof_energy_d001_incline_friction',
    path: 'scenarios/_proof/proof_energy_d001_incline_friction.json',
    preset: '1st_year',
    bandsSnapshots: 0,
    published: false
  },
  {
    id: 'proof_energy_k001_ski_jump',
    path: 'scenarios/_proof/proof_energy_k001_ski_jump.json',
    preset: '1st_year',
    bandsSnapshots: 0,
    published: false
  },
  {
    id: 'proof_energy_k020_coaster',
    path: 'scenarios/_proof/proof_energy_k020_coaster.json',
    preset: '1st_year',
    bandsSnapshots: 0,
    published: false
  },
  {
    id: 'proof_energy_e003_spring',
    path: 'scenarios/_proof/proof_energy_e003_spring.json',
    preset: '1st_year',
    bandsSnapshots: 0,
    published: false
  },
  {
    id: 'proof_energy_k011_spring',
    path: 'scenarios/_proof/proof_energy_k011_spring.json',
    preset: '1st_year',
    bandsSnapshots: 0,
    published: false
  },
  {
    id: 'proof_energy_k002_pendulum',
    path: 'scenarios/_proof/proof_energy_k002_pendulum.json',
    preset: '1st_year',
    bandsSnapshots: 0,
    published: false
  },
  // sim_buoyancy_fluids P5 — the FLUIDS weld twin. Verifying sibling of the P4
  // bobbing_float scene, run to exactly t=T/4 (dt=1e-4) so the buoy passes
  // equilibrium at MAXIMUM speed: final velocity.y = −v_max = −x₀·ω = −0.5715
  // m/s (x₀=0.10 m, ω=√(ρg·A_wp/m)=5.7155 rad/s). This is the weldable answer
  // for fluids-F001 "The Bobbing Buoy" (the SHM ΣF→ω payload, no LOL part a).
  // The engine lands velocity.y within 1e-6 of the analytical v_max. published
  // false (verification fixture, not curriculum); bandsSnapshots 0 (final-state
  // check). Frozen analytical answer: tools/sim_authoring/frozen_reference.json
  // entry fluids-F001 (velocity.y = −0.57154761). Welded via
  // tools/verify_problem.py fluids-F001.
  {
    id: 'proof_fluids_bobbing_vmax',
    path: 'scenarios/_proof/proof_fluids_bobbing_vmax.json',
    preset: '1st_year',
    bandsSnapshots: 0,
    published: false
  },
  // sim_kinetic_theory_thermo P4 — the DISCOVERY kinetic-theory box: a gas of
  // N=150 elastic disks (box_wall_reflection walls + elastic_gas inter-particle
  // collisions) whose single-speed launch relaxes toward the 2-D Maxwell–Boltzmann
  // speed distribution while pressure P (windowed wall-impulse) and temperature
  // T = ⟨K⟩ emerge as descriptive overlays. NOT a self-consistency band scene —
  // there is no analytic end-state to pin (the emergent distribution is the
  // payload, watched, not asserted), so skipCheckBands + bandsSnapshots:0 (mirrors
  // the static-snapshot fixtures; excludes it from check-bands AND check-trust).
  // Offline-generated by sim/scenarios/_thermo/generate_kinetic_theory_box.mjs (no
  // runtime PRNG). The overlay + its no-shading invariant live in
  // sim/render/__tests__/kinetic_theory_overlay.test.js; energy closure (K
  // conserved, drift 0.0000%) verified by the headless run. `published` omitted —
  // defaults true; visible in the UI dropdown as a 1st-year discovery scene.
  {
    id: 'kinetic_theory_box',
    path: 'scenarios/_thermo/kinetic_theory_box.json',
    preset: '1st_year',
    bandsSnapshots: 0,
    skipCheckBands: true
  },
  // sim_numerical_chaos P3 — the DISCOVERY double-pendulum chaos scene
  // (SYSTEM channel: sensitive dependence on initial conditions). Two 1 kg
  // bobs, both arms released horizontal from rest, coupled by an anchor rod
  // (pivot↔bob1) + the new body_rod (bob1↔bob2, sim_body_coupling_atwood /
  // Idea-12 deliverable). Both rods UNDAMPED (c_damping:0) so the budget is
  // energy-clean. Verified with BOTH prongs, never a pinned LONG-horizon
  // position band (sensitive dependence guarantees a false-fail past the
  // ~20 s divergence horizon):
  //   * ENERGY drift < driftCeilingPctUndamped (3.0%) — run-confirmed 1.08%
  //     of peak K (double_pendulum_energy.test.js);
  //   * SHORT-horizon determinism snapshot vs an INDEPENDENT Taylor reference
  //     (double_pendulum_reference.test.js).
  // skipCheckBands:true also excludes it from sim:check-trust (chaos cannot
  // survive Richardson convergence past divergence). skipDriftBaseline:true
  // excludes it from capture-drift-baseline's byte-identical t_final snapshot.
  // rodEnergyModel:'undamped' is the machine-readable signal the energy test
  // SELECTS the ceiling on (P3 owns it — a registry field, NOT the frozen
  // chaos_gate_constants.js). published (omitted ⇒ true): a 1st-year
  // discovery scene, visible in the UI dropdown.
  {
    id: 'double_pendulum_chaos',
    path: 'scenarios/1st_year/double_pendulum_chaos.json',
    preset: '1st_year',
    bandsSnapshots: 0,
    skipCheckBands: true,
    skipDriftBaseline: true,
    rodEnergyModel: 'undamped'
  },
  // k015_worksheet_parity_live_sim_v1 Phase W2 — the FULL-STORY K015 scene:
  // rest at A → straight ramp → concave polyline valley → convex circular hill
  // → lift-off at separation → ballistic tail, emitted by the archetype
  // tools/sim_authoring/archetypes.py::_circular_hilltop_full. W1 proved the
  // chain clears the welded-scene drift band at 0.5°/kink; this scene runs it
  // end to end (77 surfaces, duration 2.925 s, drift −0.176%). Band-checked via
  // sim:check-bands (bandsSnapshots 0 — the at-selectors build the recorder
  // regardless; energy closure reads the tracker history). published:false until
  // the W6 verdict (the standalone app's public scene list is user-visible, so
  // the conservative default holds until Brendan approves). skipDriftBaseline:
  // a 2.9 s multi-surface penalty-contact run's byte-identical t_final would
  // false-fail on any future 1-ULP engine change (same fragility rationale the
  // chaos scene skips for) — the drift-budget closure is the durable gate.
  {
    id: 'k015_eulers_hilltop_full',
    path: 'scenarios/1st_year/k015_eulers_hilltop_full.json',
    preset: '1st_year',
    bandsSnapshots: 0,
    published: false,
    skipDriftBaseline: true
  }
];

// SCENE_PATHS: convenience export (all registered paths, in declaration order).
export const SCENE_PATHS = SCENES.map((s) => s.path);

// DRIFT_BASELINE_SCENE_PATHS: the subset capture-drift-baseline.js captures a
// byte-identical t_final snapshot for — EXCLUDES `skipDriftBaseline` scenes
// (chaotic scenes whose t_final is past the divergence horizon; see the field
// doc above). This is the single filter site for the lockstep exclusion.
export const DRIFT_BASELINE_SCENE_PATHS = SCENES
  .filter((s) => s.skipDriftBaseline !== true)
  .map((s) => s.path);

// SCENES_BY_ID: convenience export for callers that index by scene id.
export const SCENES_BY_ID = Object.fromEntries(SCENES.map((s) => [s.id, s]));
