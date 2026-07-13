// engine/scene.js
//
// Scene loader. Reads a schema-validated scene JSON and constructs the
// engine objects (bodies, forces, surfaces, energy tracker). Also
// exposes the derivative function that the integrator calls each step.
//
// The same loader runs in the browser AND in the Node CLI — pure ES
// modules with no DOM or Canvas dependency. That's the contract that
// keeps the user-facing simulator and the self-correction CLI on one
// source of truth.
//
// Phase C1 session 2: surfaces (penalty-method contact, see
// sim/SURFACES.md), Friction, Tension. Curved surfaces and
// RodConstraint-based scenarios land alongside Phase C2.
//
// Phase 3.4 (Q2=A / Q3=B / Q5=B): per-body stateSize. The flat state
// vector now contains heterogeneous per-body slices — translational-
// only bodies contribute 4 slots [x, y, vx, vy], `RotatingDipole`
// contributes 6 slots [x, y, vx, vy, θ, ω]. Per-body offsets are
// precomputed at load time. The derivative function unpacks
// `{F, tau}` from each Force.applyTo() and routes τ to the
// rotational state-derivative slots when the body declares
// `body.stateSize === 6`. RotatingDipole's runtime guard
// (InvalidMomentOfInertiaError) fires before the τ/I division.
//
// Phase 5.R1 (Q1=α / Q2=γ / Q5=α): τ widened scalar → vec3 across the
// engine. `assertScalarTau(tau)` runs per-force inside the τ loop AND
// at the dispatch site so the dω/dt computation reads `totalTau.z / I`
// only after both gates have cleared. F stays vec2 (Q1=α).

import { Particle, Charge, MagneticDipole, RotatingDipole, RigidBody } from './bodies.js';
import { Gravity, Spring, Drag, Friction, RollingContact, Tension, LorentzForce, Coulomb, DipoleInField, CurrentInFieldForce, TimeVaryingForce, ContactForce, AppliedAcceleration, BodySpring, BuoyantForce } from './forces.js';
import { Surface, RodConstraint, StringConstraint, BodyRodConstraint } from './constraints.js';
import { buildField } from './fields.js';
import { hasImplicitGroundPlane } from './ground_plane.js';
import { ConservationTracker } from './energy.js';
import * as circuitProducer from './circuits.js';
import * as kineticTheoryProducer from './kinetic_theory.js';
import { buildElementInstances, stepCircuitLive } from './circuits_check.js';
import * as fluxProducer from './flux.js';
import * as inductionProducer from './induction.js';
import { vec3, assertScalarTau } from './vec.js';
import { DEFAULT_K_CONTACT, DEFAULT_C_DAMPING } from './constants.js';
import { linearMomentumTracker, angularMomentumTracker, totalAngularMomentumTracker, centerOfMass } from './conserved.js';
import { runDiagnosticsChecks } from '../validation/diagnostics_validation.js';
import { runFluidChecks } from '../validation/fluid_validation.js';
import { PerfectlyInelasticMerge, RestitutionImpulse, BoxWallReflection, ElasticGasCollisions, COLLISION_MODES } from './collisions.js';
import { ScheduledImpulseBurn } from './maneuvers.js';
import { runRailLoopChecks } from '../validation/rail_loop_validation.js';
import { railLoopDeriv, RailInductionForce } from './rail_induction.js';
import { computeExtent } from './extended_object_geometry.js';
import {
  interpolateAt,
  PREDICATES,
  PredicateNotYetSupportedError,
  AtOutOfRangeError,
  EnergyAtNotSupportedError,
  EventNeverOccurredError
} from './output_events.js';

// Runtime force dispatch. EXPORTED so schema_browser_lockstep.test.js can
// assert Object.keys(FORCE_CTORS) === the scene.schema.json force type.enum —
// closing the hand-threaded runtime seam (a schema/browser type with no
// constructor here throws "not implemented yet" at load, but was previously
// ungated by CI). Adding a force type = one entry here + schema enum + oneOf +
// browser VALID_FORCE_TYPES (+ a render branch if it draws a connector).
export const FORCE_CTORS = {
  gravity: Gravity,
  spring: Spring,
  drag: Drag,
  friction: Friction,
  rolling_contact: RollingContact,
  tension: Tension,
  lorentz: LorentzForce,
  coulomb: Coulomb,
  dipole_in_field: DipoleInField,
  current_in_field: CurrentInFieldForce,
  time_varying: TimeVaryingForce,
  contact: ContactForce,
  body_spring: BodySpring,
  rail_induction: RailInductionForce,
  buoyancy: BuoyantForce
};

// Runtime constraint dispatch — the constraint-side mirror of FORCE_CTORS
// (introduced sim_body_coupling_atwood P4, replacing the former rod/string
// if-else). EXPORTED so the lockstep test asserts Object.keys(CONSTRAINT_CTORS)
// === scene.schema.json constraint type.enum. Per-type argument extraction
// (rod: body_id/anchor/length_m; string: body_a/body_b/pulley/total_length_m
// + the participant guard) still lives in the build loop below — this registry
// is the single source of truth for WHICH constraint types exist.
export const CONSTRAINT_CTORS = {
  rod: RodConstraint,
  string: StringConstraint,
  body_rod: BodyRodConstraint
};

// Penalty-method contact defaults (DEFAULT_K_CONTACT / DEFAULT_C_DAMPING)
// were promoted to engine/constants.js (Phase B item B1) so the Surface
// contact (here, via sceneCtx) and the body-body ContactForce (forces.js)
// share one source of truth. Imported above; see constants.js for the
// derivation (k for ~0.1 mm static penetration; c = 2√(km) critical).

// Resolve every id in `applies_to` against the loaded bodies, throwing on an
// unknown id. Shared by the contact-force (B1) and collision (B4) loaders: Ajv
// cannot cross-reference ids and NO other validator resolves applies_to → body
// (em_validation only checks the reverse charge-coverage direction), so without
// this a typo'd participant would pass load and silently no-op the
// force/collision at runtime (bodies.find → undefined). Fail loudly instead.
function assertParticipantsResolve(applies_to, bodies, kind) {
  for (const id of applies_to) {
    if (!bodies.some((b) => b.id === id)) {
      throw new Error(
        `Scene load: ${kind} participant "${id}" matches no body id. ` +
        `Check applies_to against the scene's bodies.`
      );
    }
  }
}

// Tunneling guard for a discrete-merge pair: contact is sampled once per tick,
// so if the pair closes more than its combined radius in one dt, both centres
// can cross within a single step with no tick ever observing
// contact-while-approaching — the normal then flips, vRel turns positive, and
// the merge is silently skipped (a pass-through with no error). Reject at load
// using the INITIAL closing speed along the line of centres: exact for a
// force-free approach (B4), a conservative first line for force-driven scenes.
// Authoring fix: shrink dt or grow the radii.
function assertNoTunneling(applies_to, bodies, dt) {
  const a = bodies.find((x) => x.id === applies_to[0]);
  const b = bodies.find((x) => x.id === applies_to[1]);
  const dx = b.position.x - a.position.x;
  const dy = b.position.y - a.position.y;
  const r = Math.hypot(dx, dy);
  if (r === 0) return; // coincident centres — already in contact; nothing to skip
  const nx = dx / r;
  const ny = dy / r; // unit vector a → b
  // Closing speed = component of (v_a − v_b) along a→b; positive ⟺ approaching.
  const closing = (a.velocity.x - b.velocity.x) * nx + (a.velocity.y - b.velocity.y) * ny;
  if (closing <= 0) return; // not approaching initially
  const perTick = closing * dt;
  const sumR = a.radius + b.radius;
  if (perTick >= sumR) {
    throw new Error(
      `Scene load: perfectly_inelastic pair (${applies_to[0]}, ${applies_to[1]}) ` +
      `closes ${perTick.toExponential(2)} m per tick (dt=${dt}s) but the combined ` +
      `radius is only ${sumR} m — the merge would tunnel undetected. ` +
      `Shrink simulation.dt_s or increase radius_m.`
    );
  }
}

// Group-mode tunneling guard (P2 walls + P3 inter-particle gas). The two-body
// assertNoTunneling above computes a pair's closing geometry, which a GROUP
// applies_to (≥1 wall body / ≥2 gas bodies, no fixed pair) cannot supply — so the
// group modes need their own load-time bound. Because the gas is elastic (every
// collision conserves K), the CONSERVED-ENERGY hard bound gives the worst possible
// single-body speed: all kinetic energy in the lightest disk,
// v_max = √(2·K_total / m_min). Contact (a wall OR another disk) is sampled once
// per tick, and BOTH failure modes reduce to the SAME inequality (derived in
// _thermo/_derivations/kinetic_theory_box.derivation.js):
//   - a body must not advance a full clearance (radius r) toward a wall in one dt,
//     or it skips from just-inside the band to past the wall undetected;
//   - two disks closing at up to 2·v_max must not skip their 2r overlap window
//     in one dt: 2·v_max·dt < 2r  ⟺  v_max·dt < r.
// So ONE guard serves both group modes: reject at load when v_max·dt ≥ r_min for
// ANY emergent distribution — no run-time guard needed (the deep-review bound;
// replaces assertNoTunneling's initial-speed-only check for these modes).
// Authoring fix: shrink dt or grow the radii.
function assertGroupNoTunneling(applies_to, bodies, dt, mode) {
  let kTotal = 0;
  let mMin = Infinity;
  let rMin = Infinity;
  for (const id of applies_to) {
    const b = bodies.find((x) => x.id === id);
    kTotal += 0.5 * b.mass * (b.velocity.x ** 2 + b.velocity.y ** 2);
    mMin = Math.min(mMin, b.mass);
    rMin = Math.min(rMin, b.radius);
  }
  const vMax = Math.sqrt((2 * kTotal) / mMin);
  const perTick = vMax * dt;
  if (perTick >= rMin) {
    throw new Error(
      `Scene load: ${mode} group could tunnel — the conserved-energy ` +
      `worst-case speed v_max=${vMax.toExponential(2)} advances ${perTick.toExponential(2)} ` +
      `per tick (dt=${dt}s) but the smallest clearance (radius) is only ${rMin} — ` +
      `a body could skip a wall or another disk undetected. Shrink simulation.dt_s or increase radius_m.`
    );
  }
}

export class InvalidMomentOfInertiaError extends Error {
  // bodyType is the concrete class name (RotatingDipole, RigidBody, …) so the
  // message reports the offending body type correctly. Call sites pass
  // `b.constructor.name`; it defaults to a generic label for hand construction.
  constructor(bodyId, value, bodyType = 'rotational') {
    super(
      `${bodyType} body "${bodyId}" has invalid momentOfInertia=${value} ` +
      `at runtime (must be > 0). Schema/constructor reject ≤0 at scene-load ` +
      `(exclusiveMinimum: 0); this guard catches mid-run mutation / ` +
      `hot-reload paths that bypass that validation.`
    );
    this.name = 'InvalidMomentOfInertiaError';
    this.bodyId = bodyId;
    this.bodyType = bodyType;
  }
}

// Phase A5: resolve authored render_groups into render-layer descriptors,
// computing each group's world `extent` (and a representative charge sign for
// glyph tinting) from its member bodies' positions AT LOAD — never in a draw
// leg (the read-only render invariant). member_ids are validated against real
// bodies here so a typo aborts the load naming the bad id, rather than silently
// drawing nothing. Returns [] for scenes with no extended objects (the vast
// majority) so their loaded shape is unchanged.
function buildRenderGroups(rawGroups, bodies) {
  if (!Array.isArray(rawGroups) || rawGroups.length === 0) return [];
  const byId = new Map(bodies.map((b) => [b.id, b]));
  return rawGroups.map((g) => {
    const positions = [];
    let chargeSum = 0;
    for (const id of g.member_ids) {
      const body = byId.get(id);
      if (!body) {
        throw new Error(
          `render_groups: member id "${id}" (kind "${g.kind}") does not resolve ` +
          `to a body in this scene`
        );
      }
      positions.push(body.position);
      if (typeof body.charge === 'number') chargeSum += body.charge;
    }
    return {
      kind: g.kind,
      member_ids: g.member_ids,
      label: g.label ?? g.kind,
      extent: computeExtent(g.kind, positions),
      charge_sign: Math.sign(chargeSum)
    };
  });
}

export function loadScene(json) {
  const bodies = json.bodies.map((b) => {
    let body;
    if (b.type === 'particle') body = new Particle(b);
    else if (b.type === 'charge') body = new Charge(b);
    else if (b.type === 'magnetic_dipole') body = new MagneticDipole(b);
    else if (b.type === 'rotating_dipole') body = new RotatingDipole(b);
    else if (b.type === 'rigid_body') body = new RigidBody(b);
    else {
      throw new Error(`Unknown body type "${b.type}".`);
    }
    // Surface the scene-declared `pinned` flag on every loaded body,
    // uniformly across body types (the constructors don't capture it).
    // No engine dynamics read it (a pinned body stays put because its
    // scene applies no net force, not because of a freeze) — it is a
    // render-/validator-facing attribute. The motion-graph overlay reads
    // it to suppress the meaningless flat x/y/v/a plots of a pinned
    // placeholder body (T6 DEF-2).
    body.pinned = b.pinned === true;
    return body;
  });

  // Phase 3.4: per-body offsets and total state-vector length.
  // strides[i] = bodies[i].stateSize. offsets[i] = sum of strides[0..i-1].
  const strides = bodies.map((b) => b.stateSize);
  const offsets = new Array(bodies.length);
  let totalStateLen = 0;
  for (let i = 0; i < bodies.length; i++) {
    offsets[i] = totalStateLen;
    totalStateLen += strides[i];
  }

  // T5 Phase 1 — auxiliary integrator state for coupled rail-brake loops.
  // Each induction loop carrying an `rl_branch` block contributes ONE first-order
  // ODE slot (its loop current I), appended to the flat state vector AFTER all
  // body slots. Build ONE ordered list (induction_loops DECLARATION order) + an
  // id→state-index map ONCE at load; that SAME single structure is threaded to
  // state0 seeding, the derivState unpack/write, and the syncBodies post-step
  // re-sync (the §3 ordering invariant — no consumer re-filters induction_loops
  // independently). `bodyStateLen` freezes the positional boundary of the body
  // region: aux slots live in [bodyStateLen, totalStateLen), structurally
  // unreachable by the body-strided loops, so the aux machinery is decoupled
  // from how many body-stride variants exist. RK4 is stride-agnostic
  // (integrator.js rk4Step), so it integrates the appended slots with no change;
  // siEuler/verlet (stride-based) cannot, which is why the Phase-0 validator
  // requires integrator:'rk4' for any rl_branch scene. Empty for every scene
  // with no rl_branch loop ⇒ totalStateLen / state0 / derivState are
  // byte-identical to baseline there.
  const auxLoops = (json.induction_loops ?? []).filter((l) => l && l.rl_branch);
  const bodyStateLen = totalStateLen;
  const auxOffset = new Map();
  for (const loop of auxLoops) {
    auxOffset.set(loop.id, totalStateLen);
    totalStateLen += 1; // one slot per rail loop: the loop current I
  }

  // Build the surfaces map. Friction looks up its surface_id here.
  const surfaces = new Map();
  for (const sj of json.surfaces ?? []) {
    surfaces.set(sj.id, new Surface(sj));
  }

  // Build the fields map. LorentzForce looks up its field_id here.
  const fields = new Map();
  for (const fj of json.fields ?? []) {
    fields.set(fj.id, buildField(fj));
  }

  // Phase 3.5 (Q10=A): once-per-scene capability check for any field
  // bound to a dipole_in_field force. The widened DipoleInField formula
  // requires either a `gradB_at` tensor method OR an explicit
  // `static capabilities = { gradient: false }` declaration on the
  // field class. ANY field class missing BOTH is a scene-load error
  // here — surfacing at scene-load (NOT per-substep) keeps the hot
  // path branch-free.
  for (const fj of json.forces ?? []) {
    if (fj.type !== 'dipole_in_field') continue;
    const field = fields.get(fj.field_id);
    if (!field) continue; // missing-field error fires later in applyTo
    const caps = field.constructor?.capabilities;
    const hasGradAt = typeof field.gradB_at === 'function';
    const declaresNoGradient = caps && caps.gradient === false;
    if (!hasGradAt && !declaresNoGradient) {
      throw new Error(
        `Scene load: dipole_in_field force binds field "${fj.field_id}" ` +
        `(class ${field.constructor?.name ?? 'unknown'}) which neither ` +
        `implements gradB_at(point) nor declares ` +
        `\`static capabilities = { gradient: false }\`. Add one of the ` +
        `two so DipoleInField can resolve the force formula safely.`
      );
    }
  }

  // Build the constraints list. Ships:
  //   - type='rod'    — rigid distance from a fixed anchor (RodConstraint),
  //     the simple pendulum. Single body.
  //   - type='string' — two-body inextensible string over an ideal point
  //     pulley (StringConstraint), the Atwood machine. Reads its partner body
  //     from sceneCtx.bodies at runtime.
  // Each constraint is applied as a force on the named body(ies) inside
  // derivState (which now threads sceneCtx so a two-body constraint can see
  // its partner).
  const constraints = [];
  for (const cj of json.constraints ?? []) {
    const CtorC = CONSTRAINT_CTORS[cj.type];
    if (!CtorC) {
      throw new Error(`Constraint type "${cj.type}" not implemented in v1.`);
    }
    if (cj.type === 'rod') {
      constraints.push(new CtorC({
        id: cj.id,
        body_id: cj.body_id,
        anchor: cj.anchor,
        length_m: cj.length_m,
        ...(cj.k_constraint !== undefined ? { k_constraint: cj.k_constraint } : {}),
        ...(cj.c_damping !== undefined ? { c_damping: cj.c_damping } : {})
      }));
    } else if (cj.type === 'string') {
      // Load-time participant guard (same helper the contact-force path uses):
      // a typo'd body_a/body_b ABORTS at load with a precise message instead
      // of warn-once free-falling to a silent zero string force at runtime.
      // The engine loader runs NO Ajv validation on the headless/inline-fixture
      // path, so this in-loader gate is the ONLY protection there.
      assertParticipantsResolve([cj.body_a, cj.body_b], bodies, 'string constraint');
      constraints.push(new CtorC({
        id: cj.id,
        body_a: cj.body_a,
        body_b: cj.body_b,
        pulley: cj.pulley,
        total_length_m: cj.total_length_m,
        ...(cj.k_constraint !== undefined ? { k_constraint: cj.k_constraint } : {}),
        ...(cj.c_damping !== undefined ? { c_damping: cj.c_damping } : {})
      }));
    } else if (cj.type === 'body_rod') {
      // Two-body rigid rod (bob ↔ bob — the double pendulum). Same load-time
      // participant guard the string path uses: a typo'd body_a/body_b ABORTS
      // at load rather than warn-once free-falling to a silent zero force.
      assertParticipantsResolve([cj.body_a, cj.body_b], bodies, 'body_rod constraint');
      constraints.push(new CtorC({
        id: cj.id,
        body_a: cj.body_a,
        body_b: cj.body_b,
        length_m: cj.length_m,
        ...(cj.k_constraint !== undefined ? { k_constraint: cj.k_constraint } : {}),
        ...(cj.c_damping !== undefined ? { c_damping: cj.c_damping } : {})
      }));
    }
  }

  const sceneCtx = {
    bodies,
    surfaces,
    fields,
    k_contact: DEFAULT_K_CONTACT,
    c_damping: DEFAULT_C_DAMPING,
    // Phase S item S1: thread the circuit topology so a registered
    // circuit producer can iterate its elements when the tracker
    // dispatches `contributeDiagnostics`. Undefined for non-circuit
    // scenes — the producer early-returns on a missing block.
    circuit_topology: json.circuit_topology,
    // Phase A0: geometry for the flux / induction diagnostics producers
    // (registered below). The flux producer reads `gauss_surfaces` + live
    // `bodies`; the induction producer reads `induction_loops` + `fields`
    // and the mutable `inductionFluxState` one-step history (advanced by
    // sampleLoopFluxes in the runner's step-3 slot, read in the producer's
    // contributeDiagnostics). Undefined / empty for non-EM scenes — the
    // producers early-return, so this is zero-cost there.
    gauss_surfaces: json.gauss_surfaces,
    induction_loops: json.induction_loops,
    inductionFluxState: new Map(),
    // P2 (kinetic-theory box): per-tick wall-impulse seam, keyed by wall id.
    // BoxWallReflection (a collision resolver — never visited by the tracker's
    // force/producer walk) writes THIS tick's |J| here in the step-3a slot;
    // engine/kinetic_theory.js's producer reads it at snapshot time. Lives on
    // sceneCtx (NOT the tracker) because the producer receives sceneCtx but not
    // the tracker. Rebuilt each tick in resolve(); .clear()ed on ctor + reset
    // (runner.js) so a timeline scrub / replay re-zeroes it (no cross-run leak).
    // Empty for non-gas scenes — the producer isn't registered there.
    wallImpulse: new Map(),
    // T5 Phase 1: per-loop coupled-brake current map, keyed by loop.id, holding
    // the loop current I. SEPARATE from inductionFluxState (different lifecycle:
    // railLoops[id].I is rewritten every RK4 sub-stage at derivState ENTRY and
    // re-synced from the integrated aux tail post-step in syncBodies, whereas
    // inductionFluxState advances ONCE per tick in the discrete flux sampler).
    // Pre-seeded at LOAD — one entry per rl_branch loop at its initial_current —
    // because fixedDtRunner calls onSnapshot(state, 0) at t=0 BEFORE any
    // integrator step, which drives the energy tracker (½·L·I²) and the i_loop
    // readout; an unset map would read undefined→NaN and poison totals[0]. {} for
    // scenes with no rl_branch loop (nothing reads it there).
    railLoops: Object.fromEntries(
      auxLoops.map((l) => [l.id, { I: l.rl_branch.initial_current ?? 0 }])
    ),
    // Phase A3: lumped-element instances built ONCE for the live MNA step
    // (`stepCircuitLive`, registered as a discrete update below). Element
    // classes are stateless data carriers — all per-tick solver state lives in
    // the engine-owned `circuitState`, so building once and reusing across
    // ticks is correct. null for non-circuit scenes.
    circuitInstances: json.circuit_topology
      ? buildElementInstances(json.circuit_topology.elements)
      : null,
    // T9 play-vs-drag state machine. The id of the body the UI is currently
    // pointer-dragging, or null. When set, derivState pins that body's
    // kinematic derivatives to 0 (its poked position/velocity are
    // pointer-controlled), while every OTHER derivative — including the
    // coupled rail-loop dI/dt — keeps integrating from the poked velocity,
    // so EMF→current→brake-force stay live during the drag. Null in every
    // non-drag tick ⇒ derivState is byte-identical to baseline (the T5
    // drift gate is unaffected). Set by sim/main.js on pointerdown/up.
    draggingBodyId: null
  };

  // T5 Phase 0 — coupled rail-brake (`rl_branch`) validation MUST run BEFORE
  // the FORCE_CTORS loop below. `rail_induction` is added to the schema/browser
  // enum in Phase 0 but its constructor is not registered until Phase 2, so a
  // deliberately-broken rail fixture would otherwise hit the generic "Force type
  // not implemented" throw and the rejection test would pass for the WRONG
  // reason. Running the validator here makes a bad rail scene abort with a
  // precise message FROM THE VALIDATOR. No-op for scenes with no rl_branch loop.
  // (cli_headless.js loads scenes WITHOUT a separate validate step, so this
  // in-loader gate is the only path that protects the headless run.)
  const railResult = runRailLoopChecks(json);
  if (!railResult.ok) {
    const errs = railResult.issues.filter((i) => i.level === 'error');
    throw new Error(
      `Scene load: rail_loop_validation rejected this scene:\n` +
      errs.map((i) => `  [${i.check}] ${i.message}`).join('\n')
    );
  }

  // sim_orbital_angular_momentum P3 — diagnostics.* schema guard. Runs BEFORE
  // the conserved-tracker registration block below so a malformed
  // orbital_angular_momentum opt-in aborts with a friendly scene-naming message
  // rather than the totalAngularMomentumTracker factory's raw throw. Like the
  // rail gate above, this is the only path that protects the headless run
  // (cli_headless.js loads scenes with no separate validate step).
  const diagResult = runDiagnosticsChecks(json);
  if (!diagResult.ok) {
    const errs = diagResult.issues.filter((i) => i.level === 'error');
    throw new Error(
      `Scene load: diagnostics_validation rejected scene "${json.id}":\n` +
      errs.map((i) => `  [${i.check}] ${i.message}`).join('\n')
    );
  }

  // sim_buoyancy_fluids P3 — semantic buoyancy feasibility (validator-first).
  // A buoyancy force must reference a fluid field, and every body it acts on
  // must be a feasible float (0 < d_eq < height_m), a floored sinker
  // (d_eq ≥ height_m WITH a floor below the waterline), or pinned. Runs HERE,
  // like the rail/diagnostics gates above, so a mis-authored fluid scene aborts
  // at load with a d_eq/height/density message instead of surfacing three
  // phases later as a mysterious SHM-band failure. cli_headless.js loads scenes
  // with no separate validate step, so this in-loader gate is the only path
  // that protects the headless run + the band runner + verify_problem.
  const fluidResult = runFluidChecks(json);
  if (!fluidResult.ok) {
    const errs = fluidResult.issues.filter((i) => i.level === 'error');
    throw new Error(
      `Scene load: fluid_validation rejected scene "${json.id}":\n` +
      errs.map((i) => `  [${i.check}] ${i.message}`).join('\n')
    );
  }

  // Add gravity automatically when scene_defaults.gravity_model = constant_g
  // unless an explicit gravity force already covers a body.
  const explicitGravity = (json.forces ?? []).filter((f) => f.type === 'gravity');
  const explicitlyCovered = new Set();
  for (const fg of explicitGravity) {
    for (const id of fg.applies_to) explicitlyCovered.add(id);
  }

  const forces = [];
  for (const fj of json.forces ?? []) {
    const Ctor = FORCE_CTORS[fj.type];
    if (!Ctor) {
      throw new Error(
        `Force type "${fj.type}" not implemented yet.`
      );
    }
    if (fj.type === 'gravity') {
      forces.push(new Gravity({
        applies_to: fj.applies_to,
        g: json.scene_defaults.g,
        model: json.scene_defaults.gravity_model,
        // Datum-source parity, same shape as the g-source parity below: the
        // U_g zero line is a SCENE-level declaration, so both this explicit
        // path and the implicit-gravity path below read the one knob. A
        // per-force datum is unrepresentable by construction — two gravity
        // forces in one scene cannot disagree about where the ground is.
        datum_y: json.scene_defaults.gravity_datum_y ?? 0
      }));
    } else if (fj.type === 'buoyancy') {
      // g-source parity (Option A, sim_buoyancy_fluids P3): inject the SAME
      // scene_defaults.g the gravity special-case above uses, so buoyancy and
      // gravity share one g BY CONSTRUCTION. The g-mismatch that would drift
      // equilibrium/period apart is unrepresentable — there is no per-force g
      // knob in the scene JSON, only scene_defaults.g. This also makes g the
      // single scene-level knob a future planet-preset toggle (Layer B) drives.
      forces.push(new BuoyantForce({
        applies_to: fj.applies_to,
        field_id: fj.field_id,
        g: json.scene_defaults.g
      }));
    } else {
      forces.push(new Ctor(fj));
    }
  }

  // Implicit gravity for any body not explicitly covered. Lets a scene
  // omit a gravity force if scene_defaults.gravity_model = constant_g
  // and rely on the default.
  if (json.scene_defaults.gravity_model !== 'off') {
    const uncovered = bodies.map((b) => b.id).filter((id) => !explicitlyCovered.has(id));
    if (uncovered.length > 0 && explicitGravity.length === 0) {
      forces.push(new Gravity({
        applies_to: uncovered,
        g: json.scene_defaults.g,
        model: json.scene_defaults.gravity_model,
        datum_y: json.scene_defaults.gravity_datum_y ?? 0
      }));
    }
  }

  // T9: per-body applied acceleration (the inspector's settable a₀). A body
  // carrying a nonzero `applied_acceleration_m_per_s2` gets a constant-accel
  // force F = m·a; the body integrates under it PLUS every other scene force
  // (the "hit play and see how it affects everything" the teacher asked for).
  // Absent / zero ⇒ no force is added, so every existing scene — including
  // the pure rail-brake the T5 drift gate checks — stays byte-identical.
  for (const bj of json.bodies ?? []) {
    const a = bj.applied_acceleration_m_per_s2;
    if (a && (a.x || a.y)) {
      forces.push(new AppliedAcceleration({ applies_to: [bj.id], a_m_per_s2: a }));
    }
  }

  // Phase B item B1: a body-body `contact` force needs a positive radius
  // on every participating body to detect penetration. Validate ONCE at
  // load (mirrors the dipole_in_field capability check above) rather than
  // per-substep in the hot derivState loop — keeps the integration path
  // branch-free and fails fast with the offending body id.
  const contactForces = (json.forces ?? []).filter((f) => f.type === 'contact');
  for (const cf of contactForces) {
    // Body-body contact is pairwise: a contact force only acts between bodies
    // that are BOTH in applies_to (applyTo filters `other` by appliesTo, so the
    // pair force stays equal-and-opposite — momentum is conserved by
    // construction). A single-body applies_to therefore produces NO contact at
    // all (the bodies silently pass through each other) — almost always an
    // authoring slip. Reject it loudly rather than fail silently.
    if (!Array.isArray(cf.applies_to) || cf.applies_to.length < 2) {
      throw new Error(
        `Scene load: a "contact" force needs at least 2 bodies in applies_to ` +
        `(got ${cf.applies_to?.length ?? 0}). Contact is pairwise — list BOTH ` +
        `colliding bodies, or the force does nothing.`
      );
    }
    // Every participant id must resolve to a real body. NO other validator does
    // this (Ajv cannot cross-reference ids; em_validation only checks the
    // reverse charge-coverage direction), so a typo'd id would otherwise pass
    // load and silently no-op the force at runtime (bodies.find → undefined).
    assertParticipantsResolve(cf.applies_to, bodies, 'contact force');
    for (const id of cf.applies_to) {
      const body = bodies.find((b) => b.id === id);
      if (!(body.radius > 0)) {
        throw new Error(
          `Scene load: contact force participant "${id}" has no positive ` +
          `radius_m. Body-body contact needs a physical size to detect ` +
          `penetration — add radius_m to that body.`
        );
      }
    }
  }

  // Phase P3 (sim_body_coupling_atwood): a body-body `body_spring` force is the
  // coupled-oscillator primitive — a pairwise ideal spring between EXACTLY two
  // bodies. Mirror the contact-force load-time guards (BodySpring copies
  // ContactForce's runtime applyTo faithfully, so it must copy the load-time
  // guard too):
  //   (1) The anti_target forbids >2-body chains and no engine code rejects a
  //       3-id applies_to (the pairwise sum stays generic), so the cardinality
  //       contract is enforced HERE — exactly 2 bodies, no more, no fewer.
  //   (2) Every participant id must resolve to a real body. The engine loader
  //       runs NO Ajv schema validation — cli_headless and the inline P3 fixture
  //       load DIRECTLY through this loader, so P4's schema applies_to check does
  //       NOT cover this path; assertParticipantsResolve is the ONLY gate that
  //       stops a typo'd partner id from silently leaving the pair uncoupled at
  //       runtime (appliesTo(other.id) never matches → zero force, no error).
  const bodySpringForces = (json.forces ?? []).filter((f) => f.type === 'body_spring');
  for (const bs of bodySpringForces) {
    if (!Array.isArray(bs.applies_to) || bs.applies_to.length !== 2) {
      throw new Error(
        `Scene load: a "body_spring" force couples EXACTLY 2 bodies ` +
        `(got ${bs.applies_to?.length ?? 0} in applies_to). A coupled spring ` +
        `is pairwise — list BOTH bodies; >2-body chains are out of scope.`
      );
    }
    assertParticipantsResolve(bs.applies_to, bodies, 'body_spring force');
  }

  // Phase B items B4 + B2: discrete collision resolvers. A collision is a
  // DISCRETE event (instant velocity jump + thermal deposit), NOT a continuous
  // force, so it is declared in a top-level `collisions` block rather than in
  // `forces`. Each resolver is STATE-MUTATING (it changes velocities), so it
  // goes in its own `collisionResolvers` list (run in every execution path +
  // followed by writebackState), distinct from the observation-only
  // `discreteUpdates` below. The per-collision validation (pairwise, known mode,
  // sized participants, ids resolve, no tunneling) is mode-AGNOSTIC and runs for
  // every entry; only the final resolver-construction dispatches on mode (B4
  // merge vs B2 restitution impulse). Resolver objects are built here; running
  // them (closing over the tracker) is implicit — the runner/CLI call resolve().
  const collisionResolvers = [];
  // P2: does any collision declare a box? Gates the kinetic-theory producer
  // registration below (the wall-impulse + mean-K diagnostics seam).
  let hasBoxWall = false;
  for (const cj of json.collisions ?? []) {
    if (!COLLISION_MODES.includes(cj.mode)) {
      throw new Error(
        `Scene load: collision mode "${cj.mode}" not implemented ` +
        `(supported: ${COLLISION_MODES.join(', ')}).`
      );
    }
    const isWall = cj.mode === 'box_wall_reflection';
    const isGas = cj.mode === 'elastic_gas';
    // Arity is per-mode. The two-body resolvers (B4 merge, B2 restitution) are
    // strictly pairwise — more than two would need a simultaneous-resolution
    // pass they don't model, so reject loudly. (Substring "exactly 2 bodies" is
    // pinned by body_merge.test.js — keep it for the legacy modes.) A wall
    // reflection (P2) is per-body independent, so its applies_to is a GROUP of
    // ≥1 body; an elastic gas (P3) is a GROUP of ≥2 particles (a collision needs
    // two). Relax the "exactly 2" guard for the group modes only.
    if (isWall) {
      if (!Array.isArray(cj.applies_to) || cj.applies_to.length < 1) {
        throw new Error(
          `Scene load: a "box_wall_reflection" collision needs at least 1 body ` +
          `in applies_to (got ${cj.applies_to?.length ?? 0}).`
        );
      }
    } else if (isGas) {
      if (!Array.isArray(cj.applies_to) || cj.applies_to.length < 2) {
        throw new Error(
          `Scene load: an "elastic_gas" collision needs at least 2 bodies ` +
          `in applies_to (got ${cj.applies_to?.length ?? 0}).`
        );
      }
    } else if (!Array.isArray(cj.applies_to) || cj.applies_to.length !== 2) {
      throw new Error(
        `Scene load: a "${cj.mode}" collision needs exactly 2 bodies ` +
        `in applies_to (got ${cj.applies_to?.length ?? 0}).`
      );
    }
    assertParticipantsResolve(cj.applies_to, bodies, `${cj.mode} collision`);
    for (const id of cj.applies_to) {
      const body = bodies.find((b) => b.id === id);
      if (!(body.radius > 0)) {
        throw new Error(
          `Scene load: collision participant "${id}" has no positive radius_m — ` +
          `contact detection needs a physical size.`
        );
      }
    }
    // Discrete contact is sampled once per tick: reject a dt that would let a
    // body tunnel undetected before building the resolver. The two-body modes
    // use the pair's closing geometry; the GROUP modes (wall reflection, elastic
    // gas) use the conserved-energy worst-case speed bound (a pair geometry can't
    // express a 1-/N-body group).
    if (isWall || isGas) {
      assertGroupNoTunneling(cj.applies_to, bodies, json.simulation.dt_s, cj.mode);
    } else {
      assertNoTunneling(cj.applies_to, bodies, json.simulation.dt_s);
    }
    // Dispatch on mode. B2's e default is applied HERE (`?? 1`), not via the
    // schema `default` — Ajv runs without useDefaults, so an omitted
    // coefficient_restitution would otherwise reach the resolver as undefined.
    if (cj.mode === 'perfectly_inelastic') {
      collisionResolvers.push(new PerfectlyInelasticMerge({ applies_to: cj.applies_to }));
    } else if (cj.mode === 'restitution') {
      collisionResolvers.push(new RestitutionImpulse({
        applies_to: cj.applies_to,
        coefficient_restitution: cj.coefficient_restitution ?? 1
      }));
    } else if (isWall) {
      // box is validated inside the constructor (schema-bypass paths run here too).
      collisionResolvers.push(new BoxWallReflection({ applies_to: cj.applies_to, box: cj.box }));
      hasBoxWall = true;
    } else if (isGas) {
      // Many-body elastic group (P3). e is fixed at 1 inside the resolver; the
      // ≥2 arity was validated above. Inter-particle collisions conserve Σp, so a
      // WALL-LESS gas correctly auto-registers the momentum-closure channel below;
      // a gas-in-a-box sets hasBoxWall and opts OUT (walls are external impulse).
      collisionResolvers.push(new ElasticGasCollisions({ applies_to: cj.applies_to }));
    }
  }

  // dawn_last_burn_live_sim_v1 D2: scheduled impulsive-Δv burn resolvers. A burn
  // is a DISCRETE state-mutating event (an impulsive velocity jump at a scheduled
  // tick), the same category as a collision merge, so it lives in the step-3 slot
  // in its own `maneuverResolvers` list — sibling of collisionResolvers, distinct
  // from the observation-only discreteUpdates. Shape (body_id / t_burn_s > 0 /
  // delta_v_m_per_s / direction) is guarded by the schema + browser validator; the
  // cross-reference (body_id resolves to a real body) is checked HERE, like the
  // collision participant check. The constructor re-validates t_burn_s > 0 and the
  // direction defensively (resolvers run on schema-bypass paths too).
  const maneuverResolvers = [];
  for (const mj of json.maneuvers ?? []) {
    assertParticipantsResolve([mj.body_id], bodies, 'maneuver');
    maneuverResolvers.push(new ScheduledImpulseBurn({
      body_id: mj.body_id,
      t_burn_s: mj.t_burn_s,
      delta_v_m_per_s: mj.delta_v_m_per_s,
      direction: mj.direction
    }));
  }

  // Phase S item S4 / B1 / B3: register a linear-momentum conserved-quantity
  // tracker. The equal-and-opposite contact force (B1) and the v_cm merge (B4)
  // BOTH conserve Σp by construction, so collision/contact scenes auto-register
  // and the channel reports p-drift ≈ 0 as the collision-correctness check. B3
  // adds a scene-level opt-in (`diagnostics.system_momentum`) so an ISOLATED
  // NON-collision momentum scene gets the same channel plus the CoM diagnostic.
  // The three triggers are OR-ed and only ONE tracker is pushed, so the opt-in on
  // a collision scene does NOT double-register. The same flag gates the serialized
  // `com` read-out below, so plain (non-tracked) scenes stay byte-identical.
  //
  // Opt-in CONTRACT: it ASSERTS momentum closure (the momentum_closure gate keys
  // on the serialized conserved.p_linear), so it is for isolated systems only — on
  // a net-external-force scene the gate correctly FAILs. The name "system_momentum"
  // (not "center_of_mass") makes that closure contract explicit; the CoM read-out
  // itself is computed independently (centerOfMass) and asserts nothing.
  //
  // P2 EXCLUSION: box_wall_reflection delivers an EXTERNAL impulse at each wall
  // (the box is not a body in the system), so a scene with any wall reflection
  // does NOT conserve total momentum — even alongside momentum-conserving
  // inter-particle collisions. Auto-registering the closure-asserting p_linear
  // channel there would make the momentum_closure gate FAIL a physically correct
  // gas. So a wall scene opts OUT of the collision-triggered auto-registration
  // (a user who genuinely wants the CoM read-out can still set system_momentum).
  //
  // MANEUVER EXCLUSION (dawn_last_burn_live_sim_v1 D3): a scheduled Δv burn
  // (maneuverResolvers) injects EXTERNAL momentum Δp = m·Δv from unmodeled fuel
  // — the same category as a wall's external impulse — so a scene combining a
  // burn WITH a collision (the first is dawn_last_burn) does NOT conserve total
  // momentum, and auto-registering the closure-asserting p_linear channel would
  // FAIL a physically correct scene. Mirror the box_wall opt-out. (The energy
  // book stays honest via addExternalWork; there is no external-impulse ledger,
  // so the closure is opted out rather than corrected — matching box_wall.) No
  // existing scene has both a burn and a collision, so this is inert elsewhere.
  const trackSystemMomentum = contactForces.length > 0
    || (collisionResolvers.length > 0 && !hasBoxWall && maneuverResolvers.length === 0)
    || json.diagnostics?.system_momentum === true;
  const conservedTrackers = [];
  if (trackSystemMomentum) {
    const pTracker = linearMomentumTracker(bodies);
    // Capture the baseline NOW, at load: the body objects still hold their
    // initial JSON state (nothing has integrated yet), so this is the t=0
    // momentum. Without it the FIRST current() call would be in
    // serializeState at the END of the run — capturing initial = final and
    // reporting a trivially-zero drift. The energy tracker dodges this by
    // being sampled at t=0 by the run harness (cli_headless onSnapshot /
    // SimRunner ctor); the conserved trackers are not on that path, so they
    // self-baseline here. ConservedQuantityTracker.current() is read-only
    // apart from the one-time _initial capture, so this is side-effect-safe.
    pTracker.current();
    conservedTrackers.push(pTracker);
  }

  // Phase D3: opt-in SPIN angular-momentum channel (serialized
  // conserved.L_angular). L = Σ I·ω omits the orbital term Σ m(r × v), so
  // this is the conserved quantity ONLY for pure-spin, zero-net-torque
  // scenes — a rolling/translating body (D2) carries orbital L this channel
  // does not capture and would report false drift, which is why it is
  // OPT-IN, not automatic. The tracker's accessor reads (momentOfInertia,
  // omega); a non-rotational body contributes 0 (opts out). Self-baseline
  // at load with one .current() call, exactly as the momentum tracker does.
  if (json.diagnostics?.angular_momentum === true) {
    const LTracker = angularMomentumTracker(bodies);
    LTracker.current();
    conservedTrackers.push(LTracker);
  }

  // sim_orbital_angular_momentum P3: opt-in TOTAL angular-momentum channel
  // (serialized conserved.L_total). Unlike the spin-only channel above, this
  // captures the ORBITAL term Σ m(r × v) about a scene-DECLARED reference point,
  // so it is the conserved quantity for a central-force scene (Kepler-II) where
  // the spin-only channel reports a blind constant 0. The opt-in is an OBJECT
  // ({ reference_point: {x, y} }), NOT a bare `true`, because L is axis-dependent
  // and the axis is mandatory — runDiagnosticsChecks (above) already rejected a
  // malformed opt-in, so reference_point is guaranteed valid here. Pass the SAME
  // full, unfiltered `bodies` list the spin channel uses (NOT a subset dropping
  // the free-recoiling star): L_total conservation holds ONLY because the tracker
  // sums over ALL bodies of the isolated system (zero net torque about the fixed
  // point); filtering the star out would introduce a small REAL drift the
  // tolerance could misread. Self-baseline at load with one .current() call,
  // exactly as the momentum + spin trackers do.
  if (json.diagnostics?.orbital_angular_momentum) {
    const refPoint = json.diagnostics.orbital_angular_momentum.reference_point;
    const LtotTracker = totalAngularMomentumTracker(bodies, refPoint);
    LtotTracker.current();
    conservedTrackers.push(LtotTracker);
  }

  // Phase S item S1: producer registry for the diagnostics channel.
  // Subsystem modules expose `contributeDiagnostics(map, sceneCtx)` but
  // are not forces. Register the circuit producer when the scene carries
  // a circuit_topology block; flux/induction producers join here in
  // Phase A0. The tracker walks this list alongside `forces`.
  const producers = [];
  if (json.circuit_topology) {
    producers.push(circuitProducer);
  }
  // Phase A0: the flux producer activates when the scene declares Gauss
  // surfaces; the induction producer when it declares induction loops.
  // Each module exposes `contributeDiagnostics(map, sceneCtx)` (induction
  // also exposes `sampleLoopFluxes`, driven from the runner's step-3 slot).
  if (json.gauss_surfaces?.length) {
    producers.push(fluxProducer);
  }
  if (json.induction_loops?.length) {
    producers.push(inductionProducer);
  }
  // P2 (kinetic-theory box): the wall-pressure + mean-K producer activates when a
  // box_wall_reflection collision is present. It reads the per-tick
  // sceneCtx.wallImpulse (written by BoxWallReflection) and the live bodies, and
  // emits the emergent P (raw signal) and T (⟨K⟩) diagnostics.
  if (hasBoxWall) {
    producers.push(kineticTheoryProducer);
  }

  const tracker = new ConservationTracker({ bodies, forces, sceneCtx, producers });

  // Phase A0 / S3 invariant: per-tick discrete updates run in
  // SimRunner._advanceOne's step-3 slot (after syncBodies, BEFORE the
  // tracker snapshot). Each is a fn(dt, t) that mutates body objects
  // and/or engine-side stashes in place. A0 registers the induction flux
  // sampler; A3 (circuit MNA step) and B1 (collision resolution) push
  // their own here, inheriting the pinned order rather than each deciding
  // where to hook in. Empty for scenes with no discrete subsystem, so the
  // canonical tick stays a no-op there (byte-identical to baseline).
  const discreteUpdates = [];
  if (json.induction_loops?.length) {
    discreteUpdates.push((dt, t) => inductionProducer.sampleLoopFluxes(sceneCtx, t, dt));
  }
  // Phase A3: step the lumped-element circuit MNA live each tick (circuits do
  // NOT run during playback otherwise). The t=0 DC operating point is seeded by
  // the runner ctor/reset via `seedCircuitDC`; this advances one trap-companion
  // tick, refreshing `circuitSnapshot`/`circuitState` for the circuit producer.
  if (json.circuit_topology) {
    discreteUpdates.push(
      (dt, t) => stepCircuitLive(json.circuit_topology, sceneCtx.circuitInstances, t, dt)
    );
  }

  // Pack the initial state vector. Layout: per-body slice from
  // body.packState(), concatenated. Translational stride=4 produces
  // [x, y, vx, vy]; rotational stride=6 produces [x, y, vx, vy, θ, ω].
  const state0 = new Array(totalStateLen);
  for (let i = 0; i < bodies.length; i++) {
    const slice = bodies[i].packState();
    const off = offsets[i];
    for (let k = 0; k < slice.length; k++) state0[off + k] = slice[k];
  }
  // T5 Phase 1: seed the aux tail with each rail loop's initial_current. This is
  // the only path that supports a nonzero initial_current (edge case 13); for the
  // currently-supported I(0)=0 it writes 0, matching the un-braked start.
  for (const loop of auxLoops) {
    state0[auxOffset.get(loop.id)] = loop.rl_branch.initial_current ?? 0;
  }

  // Derivative function consumed by the integrator. Unpacks the flat
  // state array per body using `body.unpackState()`, accumulates
  // {F, tau} from each force on each body, returns dstate/dt with
  // matching layout.
  function derivState(state, t) {
    // Sync body objects from state. unpackState routes to per-body
    // implementations — RotatingDipole.unpackState additionally
    // refreshes body.mu from the new θ so subsequent Force.applyTo
    // reads see the rotated dipole.
    for (let i = 0; i < bodies.length; i++) {
      const off = offsets[i];
      const stride = strides[i];
      const slice = new Array(stride);
      for (let k = 0; k < stride; k++) slice[k] = state[off + k];
      bodies[i].unpackState(slice);
    }
    // T5 Phase 1: unpack each aux loop current I from this RK4 sub-stage's state
    // slice into sceneCtx.railLoops[id].I BEFORE the per-body force loop, so
    // EVERY force in that loop — including RailInductionForce.applyTo (Phase 2)
    // on the brake body — reads THIS sub-stage's I (not the previous stage's
    // scratch). The aux WRITE (ds[auxOff]) happens AFTER the body loop; doing the
    // unpack there instead would corrupt the k2/k3/k4 stages — the exact
    // intermediate-stage consistency aux_state.test.js protects.
    for (const loop of auxLoops) {
      sceneCtx.railLoops[loop.id].I = state[auxOffset.get(loop.id)];
    }
    // Prime time-dependent forces with the current integration time
    // before sampling F. No-op for time-independent forces (only
    // TimeVaryingForce exposes setTime); RK4 sub-steps pass the
    // intermediate t (t, t+dt/2, t+dt), so a(t) stays accurate. Mirrors
    // the field.setTime(t) priming used by the induction flux sampler.
    for (const f of forces) {
      if (typeof f.setTime === 'function') f.setTime(t);
    }
    const ds = new Array(state.length);
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      const off = offsets[i];
      const stride = strides[i];
      let Fx = 0, Fy = 0;
      let totalTau = vec3.zero();
      // Force objects (gravity, spring, drag, friction, tension,
      // lorentz, coulomb, dipole_in_field). Phase 3.4 (Q5=B): every
      // applyTo returns {F, tau}. Sum F across forces; sum tau across
      // forces (only DipoleInField returns nonzero tau in v0).
      //
      // Phase 5.R1 (Q2=γ): per-force `assertScalarTau(tau)` runs
      // BEFORE accumulation so a force returning a malformed τ
      // (in-plane component nonzero, missing z, etc.) surfaces with
      // its source identity preserved. NaN-poisoning at the
      // dispatch-site guard alone would lose the offending force.
      for (const f of forces) {
        if (!f.appliesTo(b.id)) continue;
        const { F, tau } = f.applyTo(b, sceneCtx);
        Fx += F.x;
        Fy += F.y;
        assertScalarTau(tau);
        totalTau = vec3.add(totalTau, tau);
      }
      // Surface contact resolution (penalty method). Each surface tests
      // the body for penetration; non-contact returns zero force.
      // Surface.contactForce returns {Fx, Fy, normal_force_mag} —
      // unchanged signature; surfaces don't produce torque in v0.
      for (const surface of surfaces.values()) {
        const Fc = surface.contactForce(b, sceneCtx.k_contact, sceneCtx.c_damping);
        Fx += Fc.Fx;
        Fy += Fc.Fy;
      }
      // Constraints (rod = single-body penalty spring to an anchor;
      // string = two-body Atwood string over a pulley). Their applyTo
      // returns a bare vec2 (NOT the {F, tau} Force shape — they are NOT
      // Force-class subclasses) and takes sceneCtx as its 2nd arg so a
      // two-body constraint can read its partner body. RodConstraint
      // ignores the 2nd arg (byte-identical to before this plumbing).
      for (const c of constraints) {
        if (!c.appliesTo(b.id)) continue;
        const Fc = c.applyTo(b, sceneCtx);
        Fx += Fc.x;
        Fy += Fc.y;
      }
      // Translational state derivative (slots 0-3): dx/dt = vx,
      // dy/dt = vy, dvx/dt = Fx/m, dvy/dt = Fy/m.
      ds[off]     = b.velocity.x;
      ds[off + 1] = b.velocity.y;
      ds[off + 2] = Fx / b.mass;
      ds[off + 3] = Fy / b.mass;
      if (stride === 6) {
        // Rotational state derivative (slots 4-5): dθ/dt = ω,
        // dω/dt = Στ/I. Duck-typed dispatch on stride === 6 keeps
        // the integrator forward-compatible for future rotational
        // body types (rolling cylinder, torsion pendulum) without
        // integrator edits — it's a body-class polymorphism check
        // at the integrator's *consumer* boundary.
        // I=0 runtime guard fires before division — distinguishes
        // schema-bypass / hot-reload bugs from generic NaN propagation.
        if (!(b.momentOfInertia > 0)) {
          throw new InvalidMomentOfInertiaError(b.id, b.momentOfInertia, b.constructor.name);
        }
        ds[off + 4] = b.omega;
        // Phase D4: selective translational-DOF suppression for a PIVOTED
        // rigid body (physical pendulum). Its CoM is slaved to θ
        // (RigidBody.unpackState derives position from θ, velocity 0), so we
        // (1) SUPPRESS the linear derivative rows written above and (2)
        // re-express the net force as its moment about the fixed pivot —
        // τ_z += (r × F).z with r = pos − pivot — folding it into the torque
        // channel. The body then rotates about the pivot with I = I_pivot and
        // its CoM never free-falls under linear gravity WHILE θ swings (the
        // two-uncoupled-oscillators double-count the anti-target forbids —
        // see docs/plans/drafts/sim_phase_d_rotation_plan.md §1/§D4). Reusable:
        // any body carrying a `pivot` gets this, no per-scene hack. Bodies
        // without a pivot keep the unconditional translational rows, so every
        // existing stride-6 scene (RotatingDipole, free RigidBody) is
        // byte-identical.
        if (b.pivot) {
          ds[off]     = 0;
          ds[off + 1] = 0;
          ds[off + 2] = 0;
          ds[off + 3] = 0;
          const rx = b.position.x - b.pivot.x;
          const ry = b.position.y - b.pivot.y;
          totalTau = vec3.add(totalTau, { x: 0, y: 0, z: rx * Fy - ry * Fx });
        }
        // Phase 5.R1 (Q2=γ): dispatch-site assert. The per-force
        // gate above catches a single offending force; this gate
        // catches accumulator drift (in-plane components leaking in
        // through a vec3.add bug). Both gates are load-bearing.
        assertScalarTau(totalTau);
        ds[off + 5] = totalTau.z / b.momentOfInertia;
      }
    }
    // T5 Phase 1: aux-state derivatives, written AFTER the per-body force loop so
    // each rail loop's dI/dt reads the bar velocity this sub-stage just unpacked.
    // railLoopDeriv is the SINGLE definition of the dI/dt law (no inline copy
    // here). I is the current sub-stage value (= railLoops[id].I, unpacked above).
    for (const loop of auxLoops) {
      ds[auxOffset.get(loop.id)] = railLoopDeriv(loop, bodies, fields, sceneCtx.railLoops[loop.id].I);
    }
    // T9 play-vs-drag: while the UI is dragging a body, its motion is
    // pointer-controlled (poked every frame), so pin ITS kinematic
    // derivatives (dx/dt, dy/dt, dv/dt, and any dθ/dt, dω/dt) to 0 — the
    // RK4 leaves the poked position/velocity untouched instead of fighting
    // the pointer. The aux dI/dt slot above is DELIBERATELY left alone, so
    // the coupled loop current keeps integrating from the poked velocity
    // (the "circuit solve still runs" T9 requirement). draggingBodyId is
    // null in every non-drag tick ⇒ this loop is skipped ⇒ byte-identical
    // to baseline (the T5 rail-brake drift gate is unaffected).
    if (sceneCtx.draggingBodyId != null) {
      for (let i = 0; i < bodies.length; i++) {
        if (bodies[i].id !== sceneCtx.draggingBodyId) continue;
        const off = offsets[i];
        const stride = strides[i];
        for (let k = 0; k < stride; k++) ds[off + k] = 0;
        break;
      }
    }
    return ds;
  }

  // Apply state into bodies (used after a step so callers see fresh
  // positions/velocities on the body objects). Same pack/unpack
  // contract as derivState's body sync.
  function syncBodies(state) {
    for (let i = 0; i < bodies.length; i++) {
      const off = offsets[i];
      const stride = strides[i];
      const slice = new Array(stride);
      for (let k = 0; k < stride; k++) slice[k] = state[off + k];
      bodies[i].unpackState(slice);
    }
    // T5 Phase 1: post-step re-sync of the canonical loop current. After a full
    // RK4 step `state` holds the integrated I_{n+1} in the aux tail, but the
    // derivState scratch in railLoops[id].I holds the k4 sub-stage value. Re-read
    // the integrated tail here — a strictly UNIDIRECTIONAL state→ctx READ, placed
    // with the other state→objects reads (NOT in writebackState) — so the Phase-2
    // diagnostic producer reads the TRUE post-step I. This lives on syncBodies
    // because that is the per-tick path cli_headless actually runs (Phase 3).
    for (const loop of auxLoops) {
      sceneCtx.railLoops[loop.id].I = state[auxOffset.get(loop.id)];
    }
  }

  // Phase S item S3: inverse of syncBodies — pack each body's CURRENT
  // field state BACK into the flat `state` array (mutated in place). The
  // canonical tick (SimRunner._advanceOne) calls this AFTER the discrete
  // per-tick updates (collision impulses in B1, etc.) so a velocity jump
  // applied to a body object survives the next tick's unpack instead of
  // being silently overwritten by the stale integrated state. With no
  // discrete update active it is an EXACT identity (packState ∘
  // unpackState — verified inverse for every body type), so it never
  // perturbs an ordinary tick.
  function writebackState(state) {
    // Body region only — this loop is bounded by bodies.length, so the aux tail
    // [bodyStateLen, totalStateLen) is structurally untouched. That is correct
    // and DELIBERATE (T5 Phase 1): nothing engine-side mutates railLoops[id].I
    // between steps (sampleLoopFluxes only READS it; pokeBody never touches it),
    // so there is no ctx→state aux pack to mirror here. A post-RK4 aux pack would
    // clobber the proper RK4-combined I_{n+1} with the k4-stage scratch and
    // corrupt the current every tick. writebackState keeps its exact
    // packState↔unpackState identity contract; the aux re-sync is the
    // unidirectional state→ctx READ in syncBodies.
    for (let i = 0; i < bodies.length; i++) {
      const slice = bodies[i].packState();
      const off = offsets[i];
      for (let k = 0; k < slice.length; k++) state[off + k] = slice[k];
    }
  }

  return {
    scene: json,
    bodies, forces, surfaces, fields, constraints, sceneCtx, tracker, producers,
    // Phase S item S4 / B1: conserved-quantity trackers (linear/angular
    // momentum), built above. Populated for contact (collision) scenes;
    // empty otherwise, so serializeState emits the `conserved` block only
    // when present and existing scenes stay byte-identical.
    conservedTrackers,
    // Phase B item B3: gates the serialized `com` read-out (true iff a
    // linear-momentum tracker was registered — collision/contact/opt-in).
    trackSystemMomentum,
    // Phase A0: geometry stash for the canvas render legs — A2 (Gauss
    // surfaces) and A4 (induction loops) read these post-hoc each frame.
    // The per-loop live flux is on sceneCtx.inductionFluxState; circuit
    // topology stays on sceneCtx.circuit_topology + scene for A3. Empty
    // arrays for non-EM scenes.
    gauss_surfaces: json.gauss_surfaces ?? [],
    induction_loops: json.induction_loops ?? [],
    // Phase 3 item T6: render-only diagnostic-channel declarations for the
    // motion-graph overlay (current/voltage/EMF/flux vs sim-time). Stashed
    // here (sibling of gauss_surfaces/induction_loops) so the render leg can
    // read it post-hoc; never enters serializeState (determinism — render-only).
    graph_channels: json.graph_channels ?? [],
    // Phase A5: extended-object render descriptors (charged line/sheet/ring).
    // kind/member_ids/label authored in scene JSON; `extent` + `charge_sign`
    // computed HERE at load from member positions (never a draw leg — read-only
    // render invariant). Sibling of gauss_surfaces/graph_channels; never enters
    // serializeState (render-only). member_ids validated against real bodies
    // inside buildRenderGroups (throws naming the first bad id). Empty [] for
    // the vast majority of scenes (no extended objects) → loaded shape unchanged.
    render_groups: buildRenderGroups(json.render_groups, bodies),
    // k015_worksheet_parity_live_sim_v1 W4: printed-worksheet annotation layer
    // (A/B labels, h/R measure lines, v₀ = 0). Stashed here (sibling of
    // render_groups/graph_channels) so the canvas render leg reads it post-hoc;
    // NEVER enters serializeState (determinism — render-only). Empty [] for
    // scenes without the block → loaded shape unchanged.
    annotations: json.annotations ?? [],
    // Is y = 0 really the GROUND in this scene? ONE decision point
    // (engine/ground_plane.js), evaluated ONCE here at load and stashed, never
    // re-derived downstream. Read by render/canvas2d.js::drawImplicitGround for
    // the cosmetic ground line; main.js::probeScene calls the same predicate on
    // the raw JSON to arm landing detection.
    //
    // Computed at LOAD, not per frame, ON PURPOSE: the predicate's last clause
    // reads the bodies' INITIAL authored positions. Re-asking it each frame
    // against CURRENT positions would make the ground line flicker on and off as
    // a body crosses y = 0. Render-only, like render_groups / graph_channels —
    // never enters serializeState (determinism).
    hasImplicitGround: hasImplicitGroundPlane(json),
    discreteUpdates,
    // Phase B item B4: state-mutating discrete collision resolvers (perfectly-
    // inelastic merge), run in the runner AND cli_headless. Separate from the
    // observation-only discreteUpdates above. Empty for non-collision scenes.
    collisionResolvers,
    // dawn_last_burn_live_sim_v1 D2: state-mutating scheduled-burn resolvers, run
    // in the runner (inline step-3 loop) AND cli_headless (applyManeuverResolvers).
    // Sibling of collisionResolvers; empty for non-burn scenes.
    maneuverResolvers,
    state0, derivState, syncBodies, writebackState, strides, offsets,
    simulation: json.simulation, outputs: json.outputs
  };
}

// State snapshot serializer. Single source of truth — both the headless
// CLI (sim/validation/cli_headless.js) and the browser UI snapshot
// button call this to produce the same state.json shape (per
// sim/STATE_SCHEMA.md). The architecture rule (plan §Phase E): rendering
// layers READ engine state; never own state-shape decisions.
//
// Returns the plan's STATE_SCHEMA v0.1 shape:
//   {
//     schema_version: "0.1",
//     scene_id: string,
//     t_final_s: number,
//     bodies: [{id, position, velocity, K, [theta, omega]}],
//     energy: {K, contributions, total, drift_pct},
//     energy_history: {times, totals, drifts_pct},
//     outputs: {<output_key>: value | null}
//   }
//
// Output resolution:
//   - body-quantities (position.x, velocity.y, etc.) keyed by
//     "<body_id>:<quantity>"
//   - energy keys (energy.K, energy.total, etc.) keyed by "<quantity>"
//   - unknown quantities or missing body_id → value = null + console.warn
//     (non-silent; the caller is responsible for surfacing the warning
//     to the user — the CLI prints it; the UI shows a non-modal banner).
export function serializeState(loaded, t_final_s) {
  const scene = loaded.scene;
  const energy = loaded.tracker.current();
  const energy_history = loaded.tracker.history();
  const outputs = {};
  for (const out of scene.outputs ?? []) {
    const key = out.body_id ? `${out.body_id}:${out.quantity}` : out.quantity;
    outputs[key] = resolveOutput(loaded, out, energy);
  }
  // Phase S item S4: serialize any registered conserved-quantity trackers
  // (momentum, angular momentum) keyed by name. Omitted entirely when
  // none are registered, so the serialized shape of every existing scene
  // is byte-identical — the `conserved` block appears only once B1/B3/D3
  // register a tracker on loaded.conservedTrackers.
  const conserved = {};
  for (const t of loaded.conservedTrackers ?? []) {
    conserved[t.name] = t.current();
  }
  // Phase B item B3: read-only centre-of-mass diagnostic. Emitted iff a
  // linear-momentum tracker was registered (loaded.trackSystemMomentum —
  // collision/contact scenes get it for free, a non-collision scene opts in via
  // diagnostics.system_momentum). Computed directly from the bodies, so it never
  // implies the momentum-closure ASSERTION the tracker carries. Gated like the
  // `conserved` block so plain scenes stay byte-identical. round_trip auto-bands
  // com/position → position and com/velocity → velocity (its path mapper keys on
  // the second-to-last segment), and CoM is deterministic CLI↔browser, so it
  // diffs to ~0 — it correctly stays IN the round-trip diff (not observation-only).
  const com = loaded.trackSystemMomentum ? centerOfMass(loaded.bodies) : null;
  return {
    schema_version: scene.schema_version,
    scene_id: scene.id,
    t_final_s,
    bodies: loaded.bodies.map((b) => {
      const out = {
        id: b.id,
        position: { x: b.position.x, y: b.position.y },
        velocity: { x: b.velocity.x, y: b.velocity.y },
        K: b.kineticEnergy()
      };
      // RotatingDipole AND RigidBody (Phase D1) both expose theta + omega —
      // the canonical stride-6 rotational fields (see the contract block in
      // bodies.js). The retired `angle`/`angular_velocity` probes were removed:
      // no body type carries those names, so they only misled the next author
      // (a RigidBody spelled that way writes NaN through the integrator).
      if (typeof b.theta === 'number') out.theta = b.theta;
      if (typeof b.omega === 'number') out.omega = b.omega;
      return out;
    }),
    energy,
    energy_history,
    ...(Object.keys(conserved).length ? { conserved } : {}),
    ...(com ? { com } : {}),
    outputs
  };
}

function resolveOutput(loaded, out, energy) {
  const q = out.quantity;
  // sim_oracle_fidelity Phase P1: an `at` selector redirects to the
  // sub-step trajectory resolver — NEVER falls through to the final-state
  // reads below. Absent `at` ⇒ the exact pre-P1 path (byte-identical).
  if (out.at !== undefined) {
    return resolveOutputAt(loaded, out, energy);
  }
  // Body-specific quantities (position.*, velocity.*).
  if (q.startsWith('position.') || q.startsWith('velocity.')) {
    if (!out.body_id) {
      console.warn(`serializeState: output "${q}" requires body_id; emitting null.`);
      return null;
    }
    const body = loaded.bodies.find((b) => b.id === out.body_id);
    if (!body) {
      console.warn(`serializeState: output references unknown body_id "${out.body_id}"; emitting null.`);
      return null;
    }
    const [field, axis] = q.split('.');
    const vec = body[field];
    if (!vec || typeof vec[axis] !== 'number') {
      console.warn(`serializeState: output "${q}" not resolvable on body "${out.body_id}"; emitting null.`);
      return null;
    }
    return vec[axis];
  }
  // Body-specific scalar rotational quantities (theta, omega).
  if (q === 'theta' || q === 'omega') {
    if (!out.body_id) {
      console.warn(`serializeState: output "${q}" requires body_id; emitting null.`);
      return null;
    }
    const body = loaded.bodies.find((b) => b.id === out.body_id);
    if (!body) {
      console.warn(`serializeState: output references unknown body_id "${out.body_id}"; emitting null.`);
      return null;
    }
    if (typeof body[q] !== 'number') {
      console.warn(`serializeState: output "${q}" not resolvable on body "${out.body_id}"; emitting null.`);
      return null;
    }
    return body[q];
  }
  // Energy quantities — global, body_id ignored.
  if (q === 'energy.K') return energy.K;
  if (q === 'energy.total') return energy.total;
  if (q.startsWith('energy.')) {
    const key = q.slice('energy.'.length);
    // The map "U_g" / "U_e" / "U_thermal" / "U_t" alias.
    const aliases = { U_t: 'U_thermal' };
    const lookup = aliases[key] ?? key;
    if (lookup in energy.contributions) return energy.contributions[lookup];
    console.warn(`serializeState: energy contribution "${key}" not in tracker; emitting null.`);
    return null;
  }
  // period and analytical.<name> are CLI / Phase F concerns; not
  // resolvable from runtime state alone. Emit null + warn.
  console.warn(`serializeState: unknown output quantity "${q}"; emitting null.`);
  return null;
}

// sim_oracle_fidelity Phase P1/P2: resolve an output that carries an `at`
// selector against the dense trajectory recorded during the run.
//
// Two runtimes, two behaviors:
//   - Headless CLI / bounded probe: loaded.recorder is present (built by
//     sceneHasAtOutputs). A numeric `at` interpolates; a PREDICATE selector
//     (string enum / parameterized object) is resolved to a concrete instant
//     t* by its PREDICATES[*].solve (Phase P2) and then interpolated through
//     the SAME numeric path. A genuine no-crossing (solver → null), an
//     out-of-range numeric `at`, an unknown predicate, or energy.* + at all
//     THROW an OutputResolutionError — the CLI catch turns it into die(5)
//     (no state.json). Throwing (never a final-state read) is the load-bearing
//     safety: it closes the hazard where an `at:"apex"` would otherwise be
//     silently answered with the last frame.
//   - Live interactive runner (SimRunner): NO recorder is built, because
//     the event may lie in the user's future/past and is unresolvable at
//     the live instant. Emit the null / "pending" sentinel + a console
//     warning per the unresolvable-output convention above; die(5) is
//     CLI-only.
function resolveOutputAt(loaded, out, energy) {
  const q = out.quantity;
  let at = out.at;

  if (!loaded.recorder) {
    console.warn(
      `serializeState: output "${q}" has an "at" selector but no trajectory ` +
      `recorder is active (live interactive runner); emitting null (pending). ` +
      `Resolve it via the headless CLI or the bounded probe.`
    );
    return null;
  }

  // Phase P2: a predicate selector resolves to a concrete instant t* via the
  // PREDICATES registry FIRST; a genuine no-crossing throws
  // EventNeverOccurredError (die 5). The solved t* then flows through the SAME
  // numeric-`at` interpolation path below — one code path, no per-predicate
  // output logic. (P1 threw PredicateNotYetSupportedError here; P2 supplies
  // the solvers, so that guard now lives only in resolvePredicateInstant as a
  // defensive backstop for an unknown identifier / missing solver.)
  if (typeof at === 'string' || (typeof at === 'object' && at !== null)) {
    at = resolvePredicateInstant(loaded, out);
  }

  if (typeof at !== 'number' || !Number.isFinite(at)) {
    throw new AtOutOfRangeError(out.at, q, 'must be a finite number, a predicate identifier string, or a predicate object');
  }
  const duration = loaded.scene?.simulation?.duration_s;
  if (typeof duration === 'number' && (at < 0 || at > duration)) {
    throw new AtOutOfRangeError(at, q, `outside the simulated window [0, ${duration}]s`);
  }

  // GLOBAL energy.* with `at` is whole-system interpolation — deferred.
  if (q.startsWith('energy.')) {
    throw new EnergyAtNotSupportedError(q);
  }

  if (!out.body_id) {
    console.warn(`serializeState: at-output "${q}" requires body_id; emitting null.`);
    return null;
  }
  return interpolateAt(loaded.recorder, at, out.body_id, q);
}

// Resolve a predicate `at` selector (string enum or parameterized object) to a
// concrete instant t* via the PREDICATES registry (the single source of truth
// in output_events.js). Returns a number; throws EventNeverOccurredError when
// the solver reports no qualifying crossing over [0, duration_s]. The required
// parameterized field (contact→target, charge_fraction→fraction) is validated
// here BEFORE the solver runs, so a malformed predicate fails with a precise
// message rather than a downstream NaN.
function resolvePredicateInstant(loaded, out) {
  const at = out.at;
  const id = typeof at === 'string' ? at : at.event;
  const pred = PREDICATES[id];
  if (!pred || typeof pred.solve !== 'function') {
    // Unknown identifier / missing solver: refuse rather than fall through to
    // a final-state read. The schema + browser validators already gate the
    // identifier set, so this is a defensive backstop.
    throw new PredicateNotYetSupportedError(at, out.quantity);
  }
  if (pred.needsTarget && !(at && typeof at === 'object' && typeof at.target === 'string')) {
    throw new AtOutOfRangeError(at, out.quantity,
      `event predicate "${id}" requires a string "target" (a surface_id or body_id)`);
  }
  if (pred.needsFraction && !(at && typeof at === 'object' && typeof at.fraction === 'number' && Number.isFinite(at.fraction))) {
    throw new AtOutOfRangeError(at, out.quantity,
      `event predicate "${id}" requires a finite numeric "fraction"`);
  }
  const ctx = buildPredicateContext(loaded);
  const tStar = pred.solve(ctx, out);
  if (tStar === null || tStar === undefined) {
    throw new EventNeverOccurredError(out.quantity, id);
  }
  return tStar;
}

// Assemble the pure `ctx` bundle a predicate solver reads — the recorder, the
// surfaces map + per-body radii (for `contact` geometry), and the per-step
// charge series (for `charge_fraction`). Kept free of any solver logic so
// output_events.js stays the single source of truth for the predicates.
function buildPredicateContext(loaded) {
  return {
    recorder: loaded.recorder,
    surfaces: loaded.surfaces,
    bodyRadii: new Map((loaded.bodies ?? []).map((b) => [b.id, b.radius])),
    chargeSeries: loaded.recorder ? (loaded.recorder.chargeSeries ?? null) : null
  };
}

// Run the scene's state-mutating collision resolvers for one tick of a
// fixedDtRunner-based loop (cli_headless, round_trip, capture-drift): sync the
// body objects FROM `state`, resolve each collision (mutating velocities +
// depositing ΔK via the tracker), and write the result BACK into `state` so the
// merged velocity survives the next integration step. Returns true iff it ran.
//
// ONE definition of the discrete-collision step for the headless loops, so the
// three (formerly divergent) onSnapshot bodies cannot drift apart — a merge
// that lands in cli_headless but not round_trip is exactly the silent
// CLI≠browser class this consolidates away. SimRunner._advanceOne keeps its own
// inline resolver call (it interleaves the observation-only discreteUpdates and
// brackets the tick with its own syncBodies/writeback) and is the canonical
// reference. No-op (returns false, no syncBodies) when the scene has no
// resolvers, so a caller that already manages syncBodies for non-collision
// scenes is byte-identical.
export function applyCollisionResolvers(loaded, state, tracker) {
  const resolvers = loaded.collisionResolvers;
  if (!resolvers || resolvers.length === 0) return false;
  loaded.syncBodies(state);
  for (const r of resolvers) r.resolve(loaded.sceneCtx, tracker);
  loaded.writebackState(state);
  return true;
}

// dawn_last_burn_live_sim_v1 D2 — the maneuver-family sibling of
// applyCollisionResolvers, for the headless / round-trip loops (cli_headless.js).
// The step-3 resolver contract is time-BLIND (resolve(sceneCtx, tracker) with no
// t), and a scheduled burn needs the tick-time window — so this STAMPS
// sceneCtx.{tPrev, t} before dispatching, keeping the resolver signature
// unchanged (D1's chosen time-threading: sceneCtx is already the per-tick
// blackboard). Same sync → resolve → writeback shape as applyCollisionResolvers,
// so the burn's velocity jump lands in `state` and survives the next unpack.
// SimRunner._advanceOne keeps its OWN inline maneuver loop (it stamps the window
// from this.t and brackets the tick with its own syncBodies/writeback) and is the
// canonical reference. No-op (returns false, no syncBodies) when the scene has no
// maneuver resolvers, so a non-burn scene is byte-identical.
export function applyManeuverResolvers(loaded, state, tracker, tPrev, tNow) {
  const resolvers = loaded.maneuverResolvers;
  if (!resolvers || resolvers.length === 0) return false;
  loaded.syncBodies(state);
  loaded.sceneCtx.tPrev = tPrev;
  loaded.sceneCtx.t = tNow;
  for (const r of resolvers) r.resolve(loaded.sceneCtx, tracker);
  loaded.writebackState(state);
  return true;
}

export const NAME = 'scene';
