// validate_scene_browser.js
//
// Pure-JS scene validator for browser use. Mirrors the constraints
// enforced by `sim/validate_scene.js` (which uses ajv against
// `sim/scene.schema.json`), but without any external dependency so it
// runs from disk via `<script type="module">`.
//
// This is a SUBSET validator. It enforces every check the inspector +
// scenario loader rely on for the paused-edit re-validation rule and
// for surfacing malformed scenarios with a banner. Full schema
// validation (every enum, every minimum/maximum, every additionalProperties)
// is the CLI's job — Phase F can vendor ajv into the browser build if
// richer validation is wanted.
//
// Returns { valid: boolean, errors: [{path, message}] }. The shape
// mimics ajv's so the calling UI code can stay the same when/if we
// swap in real ajv later.

const VALID_INTEGRATORS = new Set(['rk4', 'verlet', 'semi_implicit_euler']);
const VALID_BODY_TYPES = new Set(['particle', 'rigid_body', 'charge', 'magnetic_dipole', 'rotating_dipole']);
const VALID_GRAVITY_MODELS = new Set(['constant_g', 'universal', 'off']);
const VALID_SURFACE_SHAPES = new Set(['flat', 'inclined', 'curved', 'circular_arc', 'circular_arc_concave']);
const VALID_FIELD_TYPES = new Set(['uniform', 'radial', 'dipole', 'current_wire', 'linear_gradient', 'time_varying_uniform', 'fluid']);
const VALID_FORCE_TYPES = new Set(['gravity', 'spring', 'drag', 'friction', 'rolling_contact', 'tension', 'lorentz', 'coulomb', 'dipole_in_field', 'current_in_field', 'time_varying', 'contact', 'body_spring', 'rail_induction', 'buoyancy']);
// Geometric constraints. Ships 'rod' (single body, rigid distance from a
// fixed anchor — the simple pendulum) and 'string' (two bodies, inextensible
// string over an ideal point pulley — the Atwood machine, added
// sim_body_coupling_atwood P4). Must stay lockstep with
// scene.schema.json $defs.constraint.properties.type.enum
// (sim/__tests__/schema_browser_lockstep.test.js pair 5).
const VALID_CONSTRAINT_TYPES = new Set(['rod', 'string', 'body_rod']);
// k015_worksheet_parity_live_sim_v1 W4 — worksheet-annotation record types.
// dawn_worksheet_parity_live_sim_v1 D2 added orbit_path + vector_arrow.
// Must stay lockstep with scene.schema.json $defs.annotation.properties.type.enum
// (sim/__tests__/schema_browser_lockstep.test.js pair 8).
const VALID_ANNOTATION_TYPES = new Set(['position_label', 'measure_line', 'radius_line', 'text_label', 'orbit_path', 'vector_arrow']);
// dawn_worksheet_parity_live_sim_v1 D2 — vector_arrow SEMANTIC roles (never a hex
// colour; the worksheet theme maps role→colour). Must stay lockstep with
// scene.schema.json $defs.annotation.oneOf[vector_arrow].properties.role.enum
// (sim/__tests__/schema_browser_lockstep.test.js — the role pair). Widening
// VALID_ANNOTATION_TYPES alone is NOT enough: without this Set + the per-type key
// allowlist below, the EMBED (which boots through this validator, not Ajv) would
// wave through an unknown role or a literal `color` hex that Ajv rejects.
const VALID_ANNOTATION_ROLES = new Set(['velocity', 'exhaust', 'incoming']);
// HOW an exhaust plume is painted (render_shape.exhaust.glyph). Absent ⇒ 'arrow' —
// the printed page's labelled vector. Lockstepped with scene.schema.json's
// render_shape/exhaust/glyph enum (schema_browser_lockstep.test.js).
const VALID_EXHAUST_GLYPHS = new Set(['arrow', 'flame']);
// dawn_last_burn_live_sim_v1 D2 — scheduled-burn heading enum. Must stay lockstep
// with scene.schema.json $defs.maneuver.properties.direction.oneOf[0].enum AND
// with MANEUVER_DIRECTIONS (sim/engine/maneuvers.js) — asserted by
// maneuver_schema.test.js so a node-only patch cannot pass headless while the
// embed rejects the scene at load.
const VALID_MANEUVER_DIRECTIONS = new Set(['prograde', 'retrograde']);
// sim_oracle_fidelity Phase P1 — `outputs[].at` predicate identifiers.
// MUST stay lockstep with scene.schema.json (outputs.at.oneOf enums) AND
// with Object.keys(PREDICATES) in sim/engine/output_events.js — asserted by
// sim/engine/__tests__/output_events.test.js. Parameter-free ids ride as a
// bare `at` string; parameterized ids ride as `at.event` on an object.
const AT_PARAMETER_FREE_PREDICATES = new Set(['apex', 'first_return', 'vx_zero']);
const AT_PARAMETERIZED_EVENTS = new Set(['contact', 'charge_fraction']);
const AT_OBJECT_KEYS = new Set(['event', 'target', 'fraction']);
const ID_PATTERN = /^[a-z0-9_]+$/;

export function validateScene(scene) {
  const errors = [];
  const push = (path, message) => errors.push({ path, message });

  if (typeof scene !== 'object' || scene === null) {
    push('/', 'scene must be a JSON object');
    return { valid: false, errors };
  }
  if (scene.schema_version !== '0.1') {
    push('/schema_version', `must be "0.1" (got "${scene.schema_version}")`);
  }
  if (typeof scene.id !== 'string' || !ID_PATTERN.test(scene.id)) {
    push('/id', 'must be a snake_case ASCII string');
  }
  if (typeof scene.title !== 'string' || scene.title.length === 0) {
    push('/title', 'must be a non-empty string');
  }

  // scene_defaults
  const sd = scene.scene_defaults;
  if (typeof sd !== 'object' || sd === null) {
    push('/scene_defaults', 'required object');
  } else {
    if (!VALID_GRAVITY_MODELS.has(sd.gravity_model)) {
      push('/scene_defaults/gravity_model', `must be one of ${[...VALID_GRAVITY_MODELS].join(', ')}`);
    }
    if (typeof sd.g !== 'number' || sd.g < 0 || sd.g > 20) {
      push('/scene_defaults/g', 'must be a number in [0, 20]');
    }
    // Optional declared U_g zero line. Unbounded (a scene may put its origin
    // anywhere), so the only failure mode is a non-number — which would make
    // `y - datum_y` NaN and silently poison every energy readout.
    if (sd.gravity_datum_y !== undefined && typeof sd.gravity_datum_y !== 'number') {
      push('/scene_defaults/gravity_datum_y', 'must be a number when present');
    }
    for (const k of ['air_resistance', 'spring_mass', 'rope_mass']) {
      if (typeof sd[k] !== 'boolean') push(`/scene_defaults/${k}`, 'required boolean');
    }
  }

  // bodies
  if (!Array.isArray(scene.bodies) || scene.bodies.length === 0) {
    push('/bodies', 'must be a non-empty array');
  } else {
    scene.bodies.forEach((b, i) => validateBody(b, `/bodies/${i}`, push));
  }

  // surfaces (optional)
  if (scene.surfaces !== undefined) {
    if (!Array.isArray(scene.surfaces)) {
      push('/surfaces', 'must be an array');
    } else {
      scene.surfaces.forEach((s, i) => validateSurface(s, `/surfaces/${i}`, push));
    }
  }

  // fields (optional)
  if (scene.fields !== undefined) {
    if (!Array.isArray(scene.fields)) {
      push('/fields', 'must be an array');
    } else {
      scene.fields.forEach((f, i) => validateField(f, `/fields/${i}`, push));
    }
  }

  // forces (optional)
  if (scene.forces !== undefined) {
    if (!Array.isArray(scene.forces)) {
      push('/forces', 'must be an array');
    } else {
      scene.forces.forEach((f, i) => validateForce(f, `/forces/${i}`, push));
    }
  }

  // constraints (optional)
  if (scene.constraints !== undefined) {
    if (!Array.isArray(scene.constraints)) {
      push('/constraints', 'must be an array');
    } else {
      scene.constraints.forEach((c, i) => validateConstraint(c, `/constraints/${i}`, push));
    }
  }

  // annotations (optional) — k015_worksheet_parity_live_sim_v1 W4. Mirrors the
  // scene.schema.json $defs.annotation oneOf so the iframe embed (which boots
  // through THIS validator, never Ajv) rejects a malformed worksheet annotation
  // with a field-named message, exactly like the CLI. A scene WITHOUT the block
  // is untouched (the whole leg is skipped when the key is absent).
  if (scene.annotations !== undefined) {
    if (!Array.isArray(scene.annotations)) {
      push('/annotations', 'must be an array');
    } else {
      scene.annotations.forEach((a, i) => validateAnnotation(a, `/annotations/${i}`, push));
    }
  }

  // maneuvers (optional) — dawn_last_burn_live_sim_v1 D2. Mirrors
  // scene.schema.json $defs.maneuver so the iframe embed (which boots through
  // THIS validator, never Ajv) rejects a malformed scheduled burn with a
  // field-named message, exactly like the CLI. A node-only patch would pass
  // headless yet fail in-app without this leg — maneuver_schema.test.js's
  // validator-agreement test is the regression guard. A scene WITHOUT the block
  // is untouched (the whole leg is skipped when the key is absent).
  if (scene.maneuvers !== undefined) {
    if (!Array.isArray(scene.maneuvers)) {
      push('/maneuvers', 'must be an array');
    } else {
      scene.maneuvers.forEach((m, i) => validateManeuver(m, `/maneuvers/${i}`, push));
    }
  }

  // simulation
  const sim = scene.simulation;
  if (typeof sim !== 'object' || sim === null) {
    push('/simulation', 'required object');
  } else {
    if (typeof sim.duration_s !== 'number' || sim.duration_s <= 0 || sim.duration_s > 3600) {
      push('/simulation/duration_s', 'must be a number in (0, 3600]');
    }
    if (!VALID_INTEGRATORS.has(sim.integrator)) {
      push('/simulation/integrator', `must be one of ${[...VALID_INTEGRATORS].join(', ')}`);
    }
    if (typeof sim.dt_s !== 'number' || sim.dt_s <= 0 || sim.dt_s > 0.1) {
      push('/simulation/dt_s', 'must be a number in (0, 0.1]');
    }
    if (typeof sim.adaptive_dt !== 'boolean') {
      push('/simulation/adaptive_dt', 'required boolean');
    }
    // sim_oracle_fidelity Phase P3 (F2) — verlet + adaptive_dt is rejected at
    // load, mirroring the scene.schema.json if/then. verletStep's uniform-
    // spacing recurrence is silently wrong under variable dt, so adaptive is
    // restricted to rk4 / semi_implicit_euler.
    if (sim.adaptive_dt === true && sim.integrator === 'verlet') {
      push('/simulation/adaptive_dt', 'adaptive_dt is not supported with the "verlet" integrator (its uniform-spacing recurrence is invalid under variable dt); use rk4 or semi_implicit_euler');
    }
    // sim_oracle_fidelity Phase P3 (F5) — the browser sim-block check has no
    // additionalProperties, so the OPTIONAL adaptive knobs are validated by
    // hand to match the CLI's Ajv schema (both positive numbers). Defaults live
    // in sim/engine/constants.js; absence is fine.
    if (sim.driftBudgetPct !== undefined &&
        (typeof sim.driftBudgetPct !== 'number' || !Number.isFinite(sim.driftBudgetPct) || sim.driftBudgetPct <= 0)) {
      push('/simulation/driftBudgetPct', 'must be a finite number > 0 when present');
    }
    if (sim.dtFloor !== undefined &&
        (typeof sim.dtFloor !== 'number' || !Number.isFinite(sim.dtFloor) || sim.dtFloor <= 0)) {
      push('/simulation/dtFloor', 'must be a finite number > 0 when present');
    }
  }

  // outputs
  if (!Array.isArray(scene.outputs) || scene.outputs.length === 0) {
    push('/outputs', 'must be a non-empty array');
  } else {
    scene.outputs.forEach((o, i) => {
      if (typeof o.quantity !== 'string' || o.quantity.length === 0) {
        push(`/outputs/${i}/quantity`, 'required non-empty string');
      }
      // sim_oracle_fidelity Phase P1 — hand-coded `at` / `answer` validation
      // so the browser matches the CLI's Ajv schema (which now allows both).
      // Without this the browser silently accepts any at/answer the schema
      // would reject (F5). Both fields are OPTIONAL.
      if (o.at !== undefined) validateAtSelector(o.at, `/outputs/${i}/at`, push);
      if (o.answer !== undefined && typeof o.answer !== 'boolean') {
        push(`/outputs/${i}/answer`, 'must be a boolean when present');
      }
    });
  }

  return { valid: errors.length === 0, errors };
}

// Mirror scene.schema.json outputs.at.oneOf: a finite number, a
// parameter-free predicate string, or a parameterized predicate object
// { event, target?, fraction? } with no extra keys.
function validateAtSelector(at, base, push) {
  if (typeof at === 'number') {
    if (!Number.isFinite(at)) push(base, 'numeric "at" must be a finite number (absolute time in s)');
    return;
  }
  if (typeof at === 'string') {
    if (!AT_PARAMETER_FREE_PREDICATES.has(at)) {
      push(base, `string "at" must be one of ${[...AT_PARAMETER_FREE_PREDICATES].join(', ')}`);
    }
    return;
  }
  if (typeof at === 'object' && at !== null && !Array.isArray(at)) {
    if (!AT_PARAMETERIZED_EVENTS.has(at.event)) {
      push(`${base}/event`, `must be one of ${[...AT_PARAMETERIZED_EVENTS].join(', ')}`);
    }
    for (const k of Object.keys(at)) {
      if (!AT_OBJECT_KEYS.has(k)) push(`${base}/${k}`, 'unknown key (additionalProperties: false)');
    }
    return;
  }
  push(base, 'must be a number, a predicate identifier string, or a predicate object');
}

function isVec2(v, withZ = false) {
  if (typeof v !== 'object' || v === null) return false;
  if (typeof v.x !== 'number' || Number.isNaN(v.x)) return false;
  if (typeof v.y !== 'number' || Number.isNaN(v.y)) return false;
  if (withZ && (typeof v.z !== 'number' || Number.isNaN(v.z))) return false;
  return true;
}

function validateBody(b, base, push) {
  if (typeof b !== 'object' || b === null) { push(base, 'must be an object'); return; }
  if (!ID_PATTERN.test(b.id ?? '')) push(`${base}/id`, 'snake_case ASCII required');
  if (!VALID_BODY_TYPES.has(b.type)) {
    push(`${base}/type`, `must be one of ${[...VALID_BODY_TYPES].join(', ')}`);
  }
  if (typeof b.mass_kg !== 'number' || b.mass_kg <= 0 || Number.isNaN(b.mass_kg)) {
    push(`${base}/mass_kg`, 'must be a positive number');
  }
  if (b.type === 'charge') {
    if (typeof b.charge_C !== 'number' || Number.isNaN(b.charge_C)) {
      push(`${base}/charge_C`, 'required finite number for charge bodies');
    }
  }
  if (b.type === 'magnetic_dipole') {
    if (typeof b.mu_z_J_per_T !== 'number' || Number.isNaN(b.mu_z_J_per_T)) {
      push(`${base}/mu_z_J_per_T`, 'required finite number for magnetic_dipole bodies');
    }
  }
  if (b.type === 'rotating_dipole') {
    // Phase 3.4 (Q3=B): rotational sibling of magnetic_dipole.
    if (typeof b.mu_z_J_per_T !== 'number' || Number.isNaN(b.mu_z_J_per_T)) {
      push(`${base}/mu_z_J_per_T`, 'required finite number for rotating_dipole bodies');
    }
    if (typeof b.I_kg_m2 !== 'number' || Number.isNaN(b.I_kg_m2) || b.I_kg_m2 <= 0) {
      push(`${base}/I_kg_m2`, 'required finite, positive number (must be > 0) for rotating_dipole bodies');
    }
    if (typeof b.theta_rad !== 'number' || Number.isNaN(b.theta_rad)) {
      push(`${base}/theta_rad`, 'required finite number for rotating_dipole bodies (SI radians)');
    }
    if (typeof b.omega_rad_per_s !== 'number' || Number.isNaN(b.omega_rad_per_s)) {
      push(`${base}/omega_rad_per_s`, 'required finite number for rotating_dipole bodies (SI rad/s)');
    }
  }
  if (b.type === 'rigid_body') {
    // Phase D1: 2-D planar rigid body. theta/omega required; inertia via
    // EXACTLY ONE of I_kg_m2 or inertia_spec (mirrors the schema oneOf and the
    // RigidBody constructor, so browser + Ajv + engine reject the same shapes).
    if (typeof b.theta_rad !== 'number' || Number.isNaN(b.theta_rad)) {
      push(`${base}/theta_rad`, 'required finite number for rigid_body bodies (SI radians)');
    }
    if (typeof b.omega_rad_per_s !== 'number' || Number.isNaN(b.omega_rad_per_s)) {
      push(`${base}/omega_rad_per_s`, 'required finite number for rigid_body bodies (SI rad/s)');
    }
    const hasI = b.I_kg_m2 !== undefined;
    const hasSpec = b.inertia_spec !== undefined;
    if (hasI === hasSpec) {
      push(`${base}/I_kg_m2`, 'rigid_body needs EXACTLY ONE of I_kg_m2 or inertia_spec');
    } else if (hasI) {
      if (typeof b.I_kg_m2 !== 'number' || Number.isNaN(b.I_kg_m2) || b.I_kg_m2 <= 0) {
        push(`${base}/I_kg_m2`, 'required finite, positive number (must be > 0) for rigid_body bodies');
      }
    } else {
      const spec = b.inertia_spec;
      if (typeof spec !== 'object' || spec === null) {
        push(`${base}/inertia_spec`, 'must be an object {shape, R_m|L_m}');
      } else if (['disk', 'hoop', 'solid_sphere'].includes(spec.shape)) {
        if (typeof spec.R_m !== 'number' || Number.isNaN(spec.R_m) || spec.R_m <= 0) {
          push(`${base}/inertia_spec/R_m`, `shape "${spec.shape}" requires R_m > 0 (metres)`);
        }
      } else if (['rod_center', 'rod_end'].includes(spec.shape)) {
        if (typeof spec.L_m !== 'number' || Number.isNaN(spec.L_m) || spec.L_m <= 0) {
          push(`${base}/inertia_spec/L_m`, `shape "${spec.shape}" requires L_m > 0 (metres)`);
        }
      } else {
        push(`${base}/inertia_spec/shape`, 'must be one of disk, hoop, solid_sphere, rod_center, rod_end');
      }
    }
    // Phase D4: OPTIONAL physical-pendulum pivot. Mirror the RigidBody
    // constructor's geometry/velocity guards so browser + Ajv + engine reject
    // the same shapes (θ=0 ≡ CoM straight down from the pivot, +CCW; velocity
    // slaved to 0 — swing speed is carried by omega_rad_per_s).
    if (b.pivot !== undefined) {
      if (!isVec2(b.pivot)) {
        push(`${base}/pivot`, 'must be {x, y} with finite numbers (physical-pendulum pivot)');
      } else if (isVec2(b.position_m) && typeof b.theta_rad === 'number' && !Number.isNaN(b.theta_rad)) {
        const dx = b.position_m.x - b.pivot.x;
        const dy = b.position_m.y - b.pivot.y;
        const D = Math.hypot(dx, dy);
        if (!(D > 0)) {
          push(`${base}/pivot`, 'pivot must differ from position_m (D=0 is not a pendulum)');
        } else {
          const thetaGeom = Math.atan2(dx, -dy);
          const gap = Math.abs(Math.atan2(Math.sin(thetaGeom - b.theta_rad), Math.cos(thetaGeom - b.theta_rad)));
          if (gap > 1e-6) {
            push(`${base}/theta_rad`, `disagrees with pivot geometry (position_m implies θ=${thetaGeom}; θ=0 is CoM straight down, +CCW)`);
          }
        }
      }
      if (isVec2(b.velocity_m_per_s) && Math.hypot(b.velocity_m_per_s.x, b.velocity_m_per_s.y) > 1e-9) {
        push(`${base}/velocity_m_per_s`, 'a pivoted rigid_body must have velocity {0, 0} (swing speed is set by omega_rad_per_s)');
      }
    }
  }
  if (!isVec2(b.position_m)) push(`${base}/position_m`, 'required {x, y} object with finite numbers');
  if (!isVec2(b.velocity_m_per_s)) push(`${base}/velocity_m_per_s`, 'required {x, y} object with finite numbers');
  // T9 — optional settable a₀ (see scene.schema.json). Present ⇒ must be a
  // finite {x, y} so a malformed inspector edit can't reach the engine as NaN.
  if (b.applied_acceleration_m_per_s2 !== undefined && !isVec2(b.applied_acceleration_m_per_s2)) {
    push(`${base}/applied_acceleration_m_per_s2`, 'optional {x, y} object with finite numbers');
  }
  // dawn_worksheet_parity_live_sim_v1 D7 — the two NEW render_shape channels
  // (velocity_vector / exhaust) are validated in lockstep with Ajv. The rest of
  // render_shape stays Ajv-only, as it always has been (brief §3).
  if (b.render_shape !== undefined) {
    validateRenderShape(b.render_shape, `${base}/render_shape`, push);
  }
}

function validateSurface(s, base, push) {
  if (typeof s !== 'object' || s === null) { push(base, 'must be an object'); return; }
  if (!ID_PATTERN.test(s.id ?? '')) push(`${base}/id`, 'snake_case ASCII required');
  if (!VALID_SURFACE_SHAPES.has(s.shape)) {
    push(`${base}/shape`, `must be one of ${[...VALID_SURFACE_SHAPES].join(', ')}`);
  }
  if (!isVec2(s.p1)) push(`${base}/p1`, 'required {x, y}');
  if (!isVec2(s.p2)) push(`${base}/p2`, 'required {x, y}');
  // Optional per-surface penalty-stiffness override (mirrors scene.schema.json
  // surface.k_contact exclusiveMinimum 0). Omit = scene default.
  if (s.k_contact !== undefined &&
      (typeof s.k_contact !== 'number' || !(s.k_contact > 0))) {
    push(`${base}/k_contact`, 'if present must be a positive number (N/m); omit to use the scene default');
  }
  if (s.shape === 'curved' || s.shape === 'circular_arc') {
    if (typeof s.fillet_radius_m !== 'number' || s.fillet_radius_m <= 0) {
      push(`${base}/fillet_radius_m`, 'required positive number for arc surfaces');
    }
  }
  if (s.shape === 'circular_arc_concave') {
    // Full-circle loop interior: p1..p2 is the DIAMETER, so they must differ
    // (radius = |p2 - p1| / 2). fillet_radius_m is DERIVED — optional, but if
    // present the engine cross-checks it against the diameter.
    if (isVec2(s.p1) && isVec2(s.p2) &&
        Math.hypot(s.p2.x - s.p1.x, s.p2.y - s.p1.y) < 1e-9) {
      push(`${base}/p2`, 'circular_arc_concave: p1 and p2 must be distinct (they define the loop diameter)');
    }
    if (s.fillet_radius_m !== undefined &&
        (typeof s.fillet_radius_m !== 'number' || s.fillet_radius_m <= 0)) {
      push(`${base}/fillet_radius_m`, 'if present must be a positive number (else omit — derived from the p1..p2 diameter)');
    }
  }
}

function validateField(f, base, push) {
  if (typeof f !== 'object' || f === null) { push(base, 'must be an object'); return; }
  if (!ID_PATTERN.test(f.id ?? '')) push(`${base}/id`, 'snake_case ASCII required');
  if (!VALID_FIELD_TYPES.has(f.type)) {
    push(`${base}/type`, `must be one of ${[...VALID_FIELD_TYPES].join(', ')}`);
    return;
  }
  if (f.type === 'uniform') {
    if (f.E_V_per_m !== undefined && !isVec2(f.E_V_per_m)) {
      push(`${base}/E_V_per_m`, 'must be {x, y}');
    }
    if (f.B_T !== undefined && !isVec2(f.B_T, true)) {
      push(`${base}/B_T`, 'must be {x, y, z}');
    }
  } else if (f.type === 'radial') {
    if (!isVec2(f.center)) {
      push(`${base}/center`, 'required {x, y}');
    }
    if (typeof f.charge_C !== 'number') {
      push(`${base}/charge_C`, 'required number');
    }
  } else if (f.type === 'dipole') {
    if (!isVec2(f.center)) {
      push(`${base}/center`, 'required {x, y}');
    }
    if (typeof f.mu_z_J_per_T !== 'number') {
      push(`${base}/mu_z_J_per_T`, 'required number');
    }
  } else if (f.type === 'linear_gradient') {
    // Phase 3.5 (Q2=B): synthetic linear-gradient B field.
    if (typeof f.B_0_T !== 'number' || Number.isNaN(f.B_0_T)) {
      push(`${base}/B_0_T`, 'required finite number for linear_gradient bodies');
    }
    if (typeof f.grad_T_per_m !== 'number' || Number.isNaN(f.grad_T_per_m)) {
      push(`${base}/grad_T_per_m`, 'required finite number for linear_gradient bodies');
    }
    if (f.direction !== 'x' && f.direction !== 'y') {
      push(`${base}/direction`, 'must be "x" or "y" (diagonal/off-axis gradients deferred)');
    }
  } else if (f.type === 'time_varying_uniform') {
    // Phase 5.D Step 0b.1 (Q3=a): time-varying uniform B field.
    if (!isVec2(f.B_amplitude_T, true)) {
      push(`${base}/B_amplitude_T`, 'required {x, y, z} (vec3 amplitude)');
    }
    if (typeof f.omega_rad_per_s !== 'number' || !Number.isFinite(f.omega_rad_per_s)) {
      push(`${base}/omega_rad_per_s`, 'required finite number (angular frequency, rad/s)');
    }
    if (f.phase_rad !== undefined &&
        (typeof f.phase_rad !== 'number' || !Number.isFinite(f.phase_rad))) {
      push(`${base}/phase_rad`, 'must be a finite number when provided');
    }
  } else if (f.type === 'fluid') {
    // sim_buoyancy_fluids P2 — a horizontal fluid region (waterline + density).
    // NOT an EM field: no E_at/potential_at, so the shared emFields() accessor
    // (P3) filters it out of field/V overlay sampling.
    if (typeof f.waterline_y_m !== 'number' || !Number.isFinite(f.waterline_y_m)) {
      push(`${base}/waterline_y_m`, 'required finite number (fluid free-surface y, +y up)');
    }
    if (typeof f.density_kg_per_m3 !== 'number' || !Number.isFinite(f.density_kg_per_m3) || f.density_kg_per_m3 <= 0) {
      push(`${base}/density_kg_per_m3`, 'required finite number > 0 (fluid density ρ_fluid)');
    }
  }
}

function validateForce(f, base, push) {
  if (typeof f !== 'object' || f === null) { push(base, 'must be an object'); return; }
  if (!VALID_FORCE_TYPES.has(f.type)) {
    push(`${base}/type`, `must be one of ${[...VALID_FORCE_TYPES].join(', ')}`);
  }
  if (!Array.isArray(f.applies_to) || f.applies_to.length === 0) {
    push(`${base}/applies_to`, 'must be a non-empty array');
  }
  if (f.type === 'spring') {
    if (typeof f.k_N_per_m !== 'number' || f.k_N_per_m <= 0) push(`${base}/k_N_per_m`, 'positive required');
    if (typeof f.rest_length_m !== 'number' || f.rest_length_m < 0) push(`${base}/rest_length_m`, 'non-negative required');
    if (!isVec2(f.anchor)) push(`${base}/anchor`, 'required {x, y}');
  } else if (f.type === 'drag') {
    if (!['linear', 'quadratic'].includes(f.model)) push(`${base}/model`, 'must be linear or quadratic');
  } else if (f.type === 'friction') {
    if (typeof f.mu_k !== 'number' || f.mu_k < 0) push(`${base}/mu_k`, 'non-negative required');
    if (typeof f.surface_id !== 'string' || f.surface_id.length === 0) push(`${base}/surface_id`, 'required string');
  } else if (f.type === 'rolling_contact') {
    // Phase D2 — no-slip rolling penalty (couples translation + rotation).
    // Mirrors friction's mu_k/surface_id, plus the rolling radius and the
    // required penalty stiffness (no default — stability depends on M, I, R, dt).
    if (typeof f.mu_k !== 'number' || f.mu_k < 0) push(`${base}/mu_k`, 'non-negative required');
    if (typeof f.surface_id !== 'string' || f.surface_id.length === 0) push(`${base}/surface_id`, 'required string');
    if (typeof f.radius_m !== 'number' || f.radius_m <= 0) push(`${base}/radius_m`, 'positive required');
    if (typeof f.slip_penalty_c !== 'number' || f.slip_penalty_c <= 0) push(`${base}/slip_penalty_c`, 'positive required');
  } else if (f.type === 'lorentz') {
    if (typeof f.field_id !== 'string' || f.field_id.length === 0) push(`${base}/field_id`, 'required string');
  } else if (f.type === 'buoyancy') {
    // sim_buoyancy_fluids P3 — buoyancy references its fluid region by id
    // (mirror lorentz). SEMANTIC feasibility (float 0<d_eq<h / floored sinker /
    // pinned; the fluid-type + body-dims cross-check) is a whole-scene check
    // enforced at engine load by sim/validation/fluid_validation.js — this
    // subset browser validator only shape-checks the force's own field_id.
    if (typeof f.field_id !== 'string' || f.field_id.length === 0) push(`${base}/field_id`, 'required string');
  } else if (f.type === 'dipole_in_field') {
    if (typeof f.field_id !== 'string' || f.field_id.length === 0) push(`${base}/field_id`, 'required string');
    // Phase 3.6 (Q1=B): damping_b_N_m_s_per_rad is optional; defaults
    // to 0 in the engine constructor. When present, must be a finite
    // non-negative number. Schema-level rejection avoids growing
    // em_validation.js (Anti-drift item 7's frozen-at-9 constraint).
    if (f.damping_b_N_m_s_per_rad !== undefined) {
      if (typeof f.damping_b_N_m_s_per_rad !== 'number' ||
          !Number.isFinite(f.damping_b_N_m_s_per_rad) ||
          f.damping_b_N_m_s_per_rad < 0) {
        push(`${base}/damping_b_N_m_s_per_rad`, 'must be a finite number ≥ 0');
      }
    }
  } else if (f.type === 'contact') {
    // Phase B item B1 — body-body penalty contact. Both params optional
    // (k defaults to the engine DEFAULT_K_CONTACT; c defaults to 0 =
    // elastic). When present they must be finite, k > 0, c ≥ 0. The
    // participating-body radius requirement is cross-scene state, checked
    // at engine load (ContactForce throws on a radius-less participant) —
    // this fast browser pre-check validates the force's own params only.
    if (f.k_N_per_m !== undefined &&
        (typeof f.k_N_per_m !== 'number' || !Number.isFinite(f.k_N_per_m) || f.k_N_per_m <= 0)) {
      push(`${base}/k_N_per_m`, 'must be a finite number > 0');
    }
    if (f.c_N_s_per_m !== undefined &&
        (typeof f.c_N_s_per_m !== 'number' || !Number.isFinite(f.c_N_s_per_m) || f.c_N_s_per_m < 0)) {
      push(`${base}/c_N_s_per_m`, 'must be a finite number ≥ 0');
    }
  } else if (f.type === 'body_spring') {
    // Phase P3 (sim_body_coupling_atwood) — pairwise two-body coupling spring.
    // Mirrors the schema body_spring oneOf branch (required k_N_per_m,
    // rest_length_m, applies_to length 2) and the loader's applies_to.length===2
    // + assertParticipantsResolve guard. k > 0, rest_length ≥ 0.
    if (!Array.isArray(f.applies_to) || f.applies_to.length !== 2 ||
        !f.applies_to.every((id) => typeof id === 'string' && id.length > 0)) {
      push(`${base}/applies_to`, 'must be exactly two body-id strings (body_spring is strictly pairwise)');
    }
    if (typeof f.k_N_per_m !== 'number' || !Number.isFinite(f.k_N_per_m) || f.k_N_per_m <= 0) {
      push(`${base}/k_N_per_m`, 'must be a finite number > 0');
    }
    if (typeof f.rest_length_m !== 'number' || !Number.isFinite(f.rest_length_m) || f.rest_length_m < 0) {
      push(`${base}/rest_length_m`, 'must be a finite number ≥ 0');
    }
  }
}

function validateConstraint(c, base, push) {
  if (typeof c !== 'object' || c === null) { push(base, 'must be an object'); return; }
  if (!VALID_CONSTRAINT_TYPES.has(c.type)) {
    push(`${base}/type`, `must be one of ${[...VALID_CONSTRAINT_TYPES].join(', ')}`);
  }
  if (c.type === 'rod') {
    // schema $defs.constraint allOf: rod requires body_id + anchor + length_m.
    // body_id is now ROD-CONDITIONAL (P4, sim_body_coupling_atwood) — a two-body
    // 'string' constraint has no body_id (it names body_a/body_b), so this check
    // moved out of the previously-unconditional path into the rod branch. Leaving
    // it unconditional would spuriously reject every valid string scene.
    if (typeof c.body_id !== 'string' || c.body_id.length === 0) {
      push(`${base}/body_id`, 'required string');
    }
    if (!isVec2(c.anchor)) push(`${base}/anchor`, 'required {x, y}');
    if (typeof c.length_m !== 'number' || c.length_m <= 0) push(`${base}/length_m`, 'positive required');
  } else if (c.type === 'string') {
    // schema $defs.constraint allOf: string requires body_a, body_b, pulley,
    // total_length_m (two-body inextensible string over an ideal point pulley
    // — the Atwood machine, StringConstraint).
    if (typeof c.body_a !== 'string' || c.body_a.length === 0) push(`${base}/body_a`, 'required string');
    if (typeof c.body_b !== 'string' || c.body_b.length === 0) push(`${base}/body_b`, 'required string');
    if (!isVec2(c.pulley)) push(`${base}/pulley`, 'required {x, y}');
    if (typeof c.total_length_m !== 'number' || c.total_length_m <= 0) push(`${base}/total_length_m`, 'positive required');
  } else if (c.type === 'body_rod') {
    // schema $defs.constraint allOf: body_rod requires body_a, body_b, length_m
    // (two-body rigid rod — the double pendulum's bob↔bob link,
    // BodyRodConstraint). No anchor and no pulley: the rod runs body_a ↔ body_b
    // directly.
    if (typeof c.body_a !== 'string' || c.body_a.length === 0) push(`${base}/body_a`, 'required string');
    if (typeof c.body_b !== 'string' || c.body_b.length === 0) push(`${base}/body_b`, 'required string');
    if (typeof c.length_m !== 'number' || c.length_m <= 0) push(`${base}/length_m`, 'positive required');
  }
  // Optional penalty params (schema: k_constraint > 0, c_damping ≥ 0). Shared
  // by rod + string.
  if (c.k_constraint !== undefined &&
      (typeof c.k_constraint !== 'number' || !Number.isFinite(c.k_constraint) || c.k_constraint <= 0)) {
    push(`${base}/k_constraint`, 'must be a finite number > 0');
  }
  if (c.c_damping !== undefined &&
      (typeof c.c_damping !== 'number' || !Number.isFinite(c.c_damping) || c.c_damping < 0)) {
    push(`${base}/c_damping`, 'must be a finite number ≥ 0');
  }
  // orbit_weld_on_contact — activate_on_contact: a BODY_ROD-ONLY channel (the rod
  // sleeps until its two bodies touch, then latches welded). Mirrors the schema's
  // allOf guard (scene.schema.json $defs.constraint): reject a non-boolean, and
  // reject the key outright on 'rod' (single body — nothing to touch) and 'string'
  // (one-sided: it pulls, never pushes, so a contact weld is meaningless). Rejecting
  // rather than silently ignoring is the point — a scene author who writes
  // activate_on_contact on a string has a WRONG mental model, and a silent no-op
  // would ship that misconception to the live embed.
  if (c.activate_on_contact !== undefined) {
    if (typeof c.activate_on_contact !== 'boolean') {
      push(`${base}/activate_on_contact`, 'must be a boolean');
    }
    if (c.type === 'rod' || c.type === 'string') {
      push(`${base}/activate_on_contact`,
        `not allowed on type "${c.type}" — body_rod only (a rod has no partner body to ` +
        `contact; a string is one-sided and cannot hold a weld)`);
    }
  }
}

// k015_worksheet_parity_live_sim_v1 W4 — mirror scene.schema.json $defs.annotation.
// position_label {text, world}; measure_line {label, p1, p2, ticks?};
// radius_line {label, p1, p2, dashed?}; text_label {text, world, italic?}.
// dawn_worksheet_parity_live_sim_v1 D2 added orbit_path {world, radius_m, dashed?}
// and vector_arrow {p1, p2, label?, role, italic?}. Every reject message names the
// offending field so a broken worksheet layer surfaces in the embed banner exactly
// as it does at the CLI.
//
// dawn_worksheet_parity_live_sim_v1 D2 — per-type key allowlist, one Set per
// discriminated-union branch, mirroring the schema's per-branch
// additionalProperties: false (cf. MANEUVER_KEYS at :620). VALID_ANNOTATION_TYPES
// gates the `type` field ONLY; without THIS loop the EMBED — the thing that ships —
// would wave through a stray key (e.g. a literal `color` hex) that Ajv rejects,
// leaving the no-hex-in-scenes anti-target enforced only at the CLI.
const ANNOTATION_KEYS = {
  position_label: new Set(['type', 'text', 'world']),
  text_label:     new Set(['type', 'text', 'world', 'italic']),
  measure_line:   new Set(['type', 'label', 'p1', 'p2', 'ticks']),
  radius_line:    new Set(['type', 'label', 'p1', 'p2', 'dashed']),
  orbit_path:     new Set(['type', 'world', 'radius_m', 'dashed']),
  vector_arrow:   new Set(['type', 'p1', 'p2', 'label', 'role', 'italic']),
};
function validateAnnotation(a, base, push) {
  if (typeof a !== 'object' || a === null) { push(base, 'must be an object'); return; }
  if (!VALID_ANNOTATION_TYPES.has(a.type)) {
    push(`${base}/type`, `must be one of ${[...VALID_ANNOTATION_TYPES].join(', ')}`);
    return;
  }
  // additionalProperties: false — reject a stray/misspelled field (e.g. a literal
  // `color` hex on a vector_arrow) so the two validators agree; see the schema's
  // per-branch closure and validate_scene_browser_annotations.test.js.
  const allowedKeys = ANNOTATION_KEYS[a.type];
  for (const k of Object.keys(a)) {
    if (!allowedKeys.has(k)) push(`${base}/${k}`, 'unknown key (additionalProperties: false)');
  }
  const nonEmptyStr = (v) => typeof v === 'string' && v.length > 0;
  if (a.type === 'position_label' || a.type === 'text_label') {
    if (!nonEmptyStr(a.text)) push(`${base}/text`, 'required non-empty string');
    if (!isVec2(a.world)) push(`${base}/world`, 'required {x, y} object with finite numbers');
    if (a.type === 'text_label' && a.italic !== undefined && typeof a.italic !== 'boolean') {
      push(`${base}/italic`, 'must be a boolean when present');
    }
  } else if (a.type === 'measure_line' || a.type === 'radius_line') {
    if (!nonEmptyStr(a.label)) push(`${base}/label`, 'required non-empty string');
    if (!isVec2(a.p1)) push(`${base}/p1`, 'required {x, y} object with finite numbers');
    if (!isVec2(a.p2)) push(`${base}/p2`, 'required {x, y} object with finite numbers');
    if (a.type === 'measure_line' && a.ticks !== undefined && typeof a.ticks !== 'boolean') {
      push(`${base}/ticks`, 'must be a boolean when present');
    }
    if (a.type === 'radius_line' && a.dashed !== undefined && typeof a.dashed !== 'boolean') {
      push(`${base}/dashed`, 'must be a boolean when present');
    }
  } else if (a.type === 'orbit_path') {
    if (!isVec2(a.world)) push(`${base}/world`, 'required {x, y} object with finite numbers');
    if (typeof a.radius_m !== 'number' || !Number.isFinite(a.radius_m) || a.radius_m <= 0) {
      push(`${base}/radius_m`, 'must be a finite number > 0');
    }
    if (a.dashed !== undefined && typeof a.dashed !== 'boolean') {
      push(`${base}/dashed`, 'must be a boolean when present');
    }
  } else if (a.type === 'vector_arrow') {
    if (!isVec2(a.p1)) push(`${base}/p1`, 'required {x, y} object with finite numbers');
    if (!isVec2(a.p2)) push(`${base}/p2`, 'required {x, y} object with finite numbers');
    // `role` is SEMANTIC — the theme owns the palette. A literal hex here is caught
    // as an unknown-role reject (not a colour), so no palette literal reaches a scene.
    if (!VALID_ANNOTATION_ROLES.has(a.role)) {
      push(`${base}/role`, `must be one of ${[...VALID_ANNOTATION_ROLES].join(', ')}`);
    }
    if (a.label !== undefined && !nonEmptyStr(a.label)) {
      push(`${base}/label`, 'must be a non-empty string when present');
    }
    if (a.italic !== undefined && typeof a.italic !== 'boolean') {
      push(`${base}/italic`, 'must be a boolean when present');
    }
  }
}

// dawn_last_burn_live_sim_v1 D2 — mirror scene.schema.json $defs.maneuver.
// { body_id (non-empty string), t_burn_s (> 0), delta_v_m_per_s (> 0),
// direction ('prograde' | 'retrograde' | { x, y }) }. Every reject message names
// the offending field so a broken burn surfaces in the embed banner exactly as
// it does at the CLI. maneuver_schema.test.js asserts this agrees with Ajv on the
// same blocks, so a node-only patch can't silently pass headless.
const MANEUVER_KEYS = new Set(['body_id', 't_burn_s', 'delta_v_m_per_s', 'direction']);
function validateManeuver(m, base, push) {
  if (typeof m !== 'object' || m === null) { push(base, 'must be an object'); return; }
  // additionalProperties: false — reject a stray/misspelled field, matching the
  // schema $defs.maneuver (so the two validators agree; see maneuver_schema.test.js).
  for (const k of Object.keys(m)) {
    if (!MANEUVER_KEYS.has(k)) push(`${base}/${k}`, 'unknown key (additionalProperties: false)');
  }
  if (typeof m.body_id !== 'string' || m.body_id.length === 0) {
    push(`${base}/body_id`, 'required non-empty string');
  }
  if (typeof m.t_burn_s !== 'number' || !Number.isFinite(m.t_burn_s) || m.t_burn_s <= 0) {
    push(`${base}/t_burn_s`, 'must be a finite number > 0 (a burn cannot be scheduled at or before t=0)');
  }
  if (typeof m.delta_v_m_per_s !== 'number' || !Number.isFinite(m.delta_v_m_per_s) || m.delta_v_m_per_s <= 0) {
    push(`${base}/delta_v_m_per_s`, 'must be a finite magnitude > 0 (the heading is carried by direction)');
  }
  // direction: a named heading OR an explicit { x, y } unit-resolvable vector.
  const named = typeof m.direction === 'string' && VALID_MANEUVER_DIRECTIONS.has(m.direction);
  const vec = isVec2(m.direction);
  if (!named && !vec) {
    push(`${base}/direction`, `must be one of ${[...VALID_MANEUVER_DIRECTIONS].join(', ')} or an explicit {x, y} vector`);
  }
}

// dawn_worksheet_parity_live_sim_v1 D7 — the two NEW worksheet-only render_shape
// channels, validated in the browser twin so the iframe embed rejects a malformed
// velocity_vector / exhaust exactly as Ajv does (the schema/validator lockstep
// discipline; cf. MANEUVER_KEYS / ANNOTATION_KEYS). Each channel is a closed object
// (additionalProperties: false) and its `role` is SEMANTIC — reusing the SAME
// VALID_ANNOTATION_ROLES vocabulary as vector_arrow, so a literal hex here is caught
// as an unknown-role reject and no palette literal reaches a scene. The pre-existing
// render_shape fields (kind/role/label/length_m) stay Ajv-only as before — this
// validates ONLY the channels this phase adds. schema_browser_lockstep.test.js gates
// each channel's role enum against VALID_ANNOTATION_ROLES.
const RENDER_SHAPE_VELOCITY_VECTOR_KEYS = new Set(['label', 'lead_s', 'role']);
const RENDER_SHAPE_EXHAUST_KEYS = new Set(['label', 'window_s', 'role', 'glyph']);
function validateRenderShape(rs, base, push) {
  if (typeof rs !== 'object' || rs === null) return;  // Ajv owns the top-level shape
  const nonEmptyStr = (v) => typeof v === 'string' && v.length > 0;
  const vv = rs.velocity_vector;
  if (vv !== undefined) {
    if (typeof vv !== 'object' || vv === null) {
      push(`${base}/velocity_vector`, 'must be an object {role, lead_s, label?}');
    } else {
      for (const k of Object.keys(vv)) {
        if (!RENDER_SHAPE_VELOCITY_VECTOR_KEYS.has(k)) {
          push(`${base}/velocity_vector/${k}`, 'unknown key (additionalProperties: false)');
        }
      }
      if (!VALID_ANNOTATION_ROLES.has(vv.role)) {
        push(`${base}/velocity_vector/role`, `must be one of ${[...VALID_ANNOTATION_ROLES].join(', ')}`);
      }
      if (typeof vv.lead_s !== 'number' || !Number.isFinite(vv.lead_s) || vv.lead_s <= 0) {
        push(`${base}/velocity_vector/lead_s`, 'must be a finite number > 0 (arrow length = |v|·lead_s)');
      }
      if (vv.label !== undefined && !nonEmptyStr(vv.label)) {
        push(`${base}/velocity_vector/label`, 'must be a non-empty string when present');
      }
    }
  }
  const ex = rs.exhaust;
  if (ex !== undefined) {
    if (typeof ex !== 'object' || ex === null) {
      push(`${base}/exhaust`, 'must be an object {role, window_s, label?}');
    } else {
      for (const k of Object.keys(ex)) {
        if (!RENDER_SHAPE_EXHAUST_KEYS.has(k)) {
          push(`${base}/exhaust/${k}`, 'unknown key (additionalProperties: false)');
        }
      }
      if (!VALID_ANNOTATION_ROLES.has(ex.role)) {
        push(`${base}/exhaust/role`, `must be one of ${[...VALID_ANNOTATION_ROLES].join(', ')}`);
      }
      if (typeof ex.window_s !== 'number' || !Number.isFinite(ex.window_s) || ex.window_s <= 0) {
        push(`${base}/exhaust/window_s`, 'must be a finite number > 0 (the burn-window half-width in seconds)');
      }
      if (ex.label !== undefined && !nonEmptyStr(ex.label)) {
        push(`${base}/exhaust/label`, 'must be a non-empty string when present');
      }
      // Absent ⇒ 'arrow' (printed-page parity). Only an EXPLICIT bad value is an error,
      // so every pre-flame scene still validates untouched.
      if (ex.glyph !== undefined && !VALID_EXHAUST_GLYPHS.has(ex.glyph)) {
        push(`${base}/exhaust/glyph`, `must be one of ${[...VALID_EXHAUST_GLYPHS].join(', ')}`);
      }
    }
  }
}

export const NAME = 'validate_scene_browser';
