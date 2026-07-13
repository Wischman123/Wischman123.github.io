// engine/ground_plane.js
//
// ONE decision point: "is y = 0 really the GROUND in this scene?"
//
// Two app-layer legs used to answer that question independently, and both
// answered it WRONG the same way:
//
//   sim/main.js::probeScene       detectLanding = hasGravity && !hasSurfaces
//   sim/render/canvas2d.js        drawImplicitGround: same derivation
//
// That is a PROJECTILE heuristic ("the ball hit the ground") applied to every
// gravity-bearing, surface-free scene. probeScene then ENDS the run at the
// first body with (y <= 0 && v_y < 0). An ORBIT crosses y = 0 downward once
// per revolution, so the live app truncated orbits mid-flight — and the
// renderer painted a cosmetic ground line straight through the central body.
// Headless never saw it (cli_headless.js does not call planScene), so a scene
// could be band-green and still be cut in half in the browser. Eight registered
// scenes were truncated, including the shipped gravitational_orbit (ran 50% of
// its duration), kepler_second_law (47%), maneuver_verify_orbit (52%),
// dawn_last_burn (31%), bobbing_float (1.7%), bobbing_float_damped (2.5%),
// proof_energy_k012_charged_pendulum (0.0%) and proof_fluids_bobbing_vmax (67%).
//
// The fix is this module: the predicate lives in exactly ONE place and both
// legs import it. Re-deriving it anywhere else re-opens the bug.
//
// PURE by contract — takes raw scene JSON, touches no DOM, no IO, no loaded-
// engine objects, and has no side effects, so the decision point unit-tests at
// its boundary without a browser (sim/engine/__tests__/ground_plane.test.js).
//
// ---------------------------------------------------------------------------
// STABILITY CONTRACT (why the renderer must NOT call this per frame)
// ---------------------------------------------------------------------------
// Clause 5 reads the bodies' INITIAL authored positions (`position_m`). Asking
// the same question per-frame against CURRENT body positions would make the
// ground line flicker on and off as a body crosses y = 0. So loadScene()
// evaluates this ONCE at load and stashes the answer on `loaded.hasImplicitGround`;
// the renderer READS that flag and never re-derives.
//
// ---------------------------------------------------------------------------
// SAFETY RAIL — clause 2b (this predicate may only ever DISARM, never ARM)
// ---------------------------------------------------------------------------
// scene.js::loadScene AUTO-ADDS gravity whenever scene_defaults.gravity_model
// !== 'off', even when `json.forces` carries no explicit gravity entry. So the
// old `forces.some(f => f.type === 'gravity')` test UNDER-detects gravity, and
// reading the ACCURATE source of truth (gravity_model) would newly ARM landing
// detection on scenes that run un-clipped today — newly TRUNCATING working
// scenes. That is a regression and is not acceptable.
//
// MEASURED, not assumed. The safety-rail audit
// (docs/plans/state/dawn_last_burn_live_sim_v1/d4_review/d4_ground_plane_safety_rail.mjs)
// found 10 registered scenes where hasGravity_old !== hasGravity_true. Six of
// them would be NEWLY ARMED by the accurate gravity source, and THREE would
// actually be newly CLIPPED:
//
//     proof_energy_c003_atwood   cut at t=0.9034 of 1.5000  (60% of the scene)
//     proof_energy_k002_pendulum cut at t=0.0002 of 0.5297  (~0%)
//     double_pendulum_chaos      cut at t=0.0020 of 20.0000 (~0%)
//
// DECISION: keep the conservative behavior — clause 2b requires an EXPLICIT
// gravity force entry, exactly reproducing today's ARMING condition as a
// NECESSARY condition. Every clause below can then only turn arming OFF. Net
// effect is guaranteed one-directional: strictly fewer clipped scenes than
// today, zero newly-clipped scenes.
//
// The conservative choice is also the physically-right answer for the six
// scenes it excludes: they are hanging pendulums (the bob dangles below the
// pivot), Atwood machines (a mass descends past the origin) and a chaotic
// double pendulum. y = 0 is not a floor in any of them, so declining to arm
// there is correct on the merits, not merely safe. Consequence to note: those
// scenes also STOP drawing the cosmetic ground line they draw today (the old
// renderer inspected the LOADED forces, which include the auto-added gravity).
// That is a cosmetic correction in the same direction, never a truncation.
//
// If a future scene genuinely wants an implicit floor while relying on the
// gravity default, the right move is to author an explicit gravity force in its
// JSON — not to loosen clause 2b, which is what holds the rail in place.

/**
 * Does this scene have an implicit ground plane at y = 0?
 *
 * TRUE  => y = 0 really is the ground: the renderer draws the cosmetic ground
 *          line, and probeScene arms landing detection (end the run when a body
 *          reaches the floor moving downward).
 * FALSE => y = 0 is just the origin / a waterline / a pivot height. No ground
 *          line, no landing detection, the scene runs its full declared duration.
 *
 * Pure: no IO, no DOM, no engine objects, no mutation of the input.
 *
 * @param {object} sceneJson raw scene JSON (schema 0.1), pre-load
 * @returns {boolean}
 */
export function hasImplicitGroundPlane(sceneJson) {
  if (!sceneJson || typeof sceneJson !== 'object') return false;

  const defaults = sceneJson.scene_defaults ?? {};
  const gravityModel = defaults.gravity_model ?? 'off';
  const forces = sceneJson.forces ?? [];
  const fields = sceneJson.fields ?? [];
  const bodies = sceneJson.bodies ?? [];
  const surfaces = sceneJson.surfaces ?? [];

  // Clause 1 — no gravity, no ground. Nothing falls, so nothing lands.
  if (gravityModel === 'off') return false;

  // Clause 2 — universal gravity is an ORBIT. There is no floor: y = 0 is just
  // the origin (usually the central body's own center). This is the clause that
  // un-truncates gravitational_orbit / kepler_second_law / maneuver_verify_orbit
  // / dawn_last_burn.
  if (gravityModel === 'universal') return false;

  // Clause 2b — SAFETY RAIL. See the module header: require an EXPLICIT gravity
  // force entry, reproducing today's arming condition as a NECESSARY condition
  // so this predicate can only ever DISARM, never newly ARM (and therefore never
  // newly truncate a working scene). Measured against all registered scenes.
  const hasExplicitGravity = forces.some((f) => f?.type === 'gravity');
  if (!hasExplicitGravity) return false;

  // Clause 3 — the scene brings its own ground. When it declares real surfaces,
  // contact is the engine's business (penalty-method surfaces, sim/SURFACES.md);
  // a cosmetic line at y = 0 would be a second, fake floor.
  if (surfaces.length > 0) return false;

  // Clause 4 — buoyancy / fluid: y = 0 is a WATERLINE, not a floor. A float bobs
  // THROUGH it every half-period by design (bobbing_float, bobbing_float_damped,
  // proof_fluids_bobbing_vmax). Both the force type and the field type are
  // checked: a fluid field is the waterline declaration, and buoyancy is the
  // force that samples it — either one alone is enough to say "this y = 0 is wet".
  const hasBuoyancy = forces.some((f) => f?.type === 'buoyancy');
  const hasFluidField = fields.some((f) => f?.type === 'fluid');
  if (hasBuoyancy || hasFluidField) return false;

  // Clause 5 — a body starts BELOW y = 0, so y = 0 cannot be a floor beneath
  // everything. This catches proof_energy_k012_charged_pendulum, whose charged
  // bob hangs at y = -0.6 from a rod pivoted at the origin: today the detector
  // fires on step one and the scene runs 0.0% of its duration.
  //
  // Two deliberate boundary choices:
  //
  //  (a) STRICTLY below (y < 0), not (y <= 0). A body sitting exactly AT y = 0
  //      is standing ON the ground — the launch-from-ground-level case, which is
  //      precisely the canonical projectile scene: projectile_motion's ball
  //      starts at (0, 0) and is thrown upward. Disqualifying y == 0 would
  //      destroy landing detection for the very scene class this feature exists
  //      to serve. A small epsilon absorbs authored float noise (a y of -1e-16
  //      is an authoring artifact, not a basement).
  //
  //  (b) PINNED bodies do not disqualify. A pinned anchor / pivot / post is
  //      scenery, not a falling object (scene.js surfaces `pinned` on every
  //      loaded body; probeScene already skips pinned bodies in both the camera
  //      fit and the landing scan). A pinned pivot at the origin must not kill a
  //      genuine projectile scene's ground.
  const EPS = 1e-9;
  for (const b of bodies) {
    if (b?.pinned === true) continue;
    const y = b?.position_m?.y;
    if (typeof y === 'number' && y < -EPS) return false;
  }

  // Constant-g, surface-free, dry, everything at or above the floor: y = 0 is
  // the ground. Draw the line; end the run when the ball lands.
  return true;
}
