// engine/circuits_check.js
//
// Phase 5.C Step 0b.4 deliverable. Sole owner of `runCircuitCheck` —
// the trapezoidal-companion-model MNA integrator skeleton for lumped-
// element circuits. Closes against the closed-form predictors in
// `sim/scenarios/ap_c/_derivations/circuit_analytic.js` (mirrors 5.B
// Q3=γ / 5.D Q10=a analytic-primary, discrete cross-check).
//
// Locked decisions (frontmatter `q*_lock` of physics_simulator_phase_5_c_circuits):
//   - Q2=a (companion-model MNA + trapezoidal rule). Element classes own
//     the stamping; this module owns scheduling + post-solve update.
//   - Q9=b (pure trapezoidal-companion solver — no DAE/MNA hybrid).
//     Solver consumes G + rhs only; the C_matrix accumulator is
//     populated by stamps for diagnostic / future use but unused here.
//   - Q14=c (Kahan summation YAGNI). Plain `+=` for trajectory append.
//   - Lock #22 (`runCircuitCheck` location) — public entry HERE; full
//     solver / state / tracker_emit live at
//     `sim/engine/circuits/{solver,state,tracker_emit}.js`;
//     `circuits/index.js` is the internal barrel.
//   - Lock #25 (LU-cache ownership) — invocation-local. The LU lives
//     inside `assembleAndSolve` and is freshly decomposed every tick;
//     no module-level cache.
//   - Lock #26 (ledger reset) — circuitState.clear() at runCircuitCheck
//     entry. Each invocation starts from scene-declared initial state;
//     no accidental cross-run leakage.
//
// Time stepping & initial conditions:
//   trajectory[0] is the state at t=0, computed by a DC operating-
//   point pre-solve (caps modeled as VoltageSource(initial_voltage),
//   inductors as CurrentSource(initial_current)). This auto-derives
//   the consistent (v_C(0+), i_C(0+)) and (v_L(0+), i_L(0+)) pairs
//   that trapezoidal-companion needs at the first integration step —
//   so scene authors only need to declare initial_voltage on caps and
//   initial_current on inductors; the engine fills in the partner
//   value by solving KCL/KVL at t=0.
//
//   trajectory[1..N] are produced by trapezoidal-companion stamp +
//   solve at t=k·dt, with prev_state initialized from the DC solve.
//   N = round(t_horizon / dt); total length = N+1.
//
// Tracker emit at 0b.4 is NARROW: only `v_node_<id>` and
// `i_branch_<id>`. The conservation channels (`U_capacitor_<id>`,
// `U_inductor_<id>`, `power_dissipated_resistor_<id>`) land at 0b.5.
//
// Engine touch: this module ships under sim/engine/. Sub-commit MUST
// carry the `engine-universality:` trailer.

import {
  Resistor,
  Capacitor,
  Inductor,
  VoltageSource,
  CurrentSource
} from './components.js';
import {
  MnaMatrix,
  MnaVector,
  circuitState,
  circuitSnapshot,
  clearCircuitSnapshot,
  assembleAndSolve,
  branchKey,
  emitDiagnostics,
  appendTick
} from './circuits/index.js';

const ELEMENT_CLASSES = {
  Resistor,
  Capacitor,
  Inductor,
  VoltageSource,
  CurrentSource
};

export function buildElementInstances(elementsSpec) {
  const instances = [];
  for (const spec of elementsSpec) {
    const Cls = ELEMENT_CLASSES[spec.type];
    if (!Cls) {
      throw new Error(
        `runCircuitCheck: unknown element type "${spec.type}" for "${spec.id}"; ` +
        `validator at sim/validation/circuit_validation.js should have caught this.`
      );
    }
    instances.push(new Cls({
      id: spec.id,
      value: spec.value,
      from_node: spec.from_node,
      to_node: spec.to_node
    }));
  }
  return instances;
}

/**
 * Build the DC-equivalent element list at t=0:
 *   - Capacitor → VoltageSource(initial_voltage ?? 0), keeping id
 *   - Inductor  → CurrentSource(initial_current ?? 0), keeping id
 *   - everything else passes through unchanged
 *
 * Keeping the id means the cap's substituted VS contributes a
 * `branch:<cap_id>` row, from which i_C(0+) is read directly. The
 * substituted CS for inductors is stateless (stamps to rhs only); the
 * inductor's v_L(0+) is read as v_from − v_to from solved nodes.
 */
function dcEquivalentSpec(elementsSpec) {
  return elementsSpec.map((spec) => {
    if (spec.type === 'Capacitor') {
      return {
        id: spec.id,
        type: 'VoltageSource',
        value: Number.isFinite(spec.initial_voltage) ? spec.initial_voltage : 0,
        from_node: spec.from_node,
        to_node: spec.to_node
      };
    }
    if (spec.type === 'Inductor') {
      return {
        id: spec.id,
        type: 'CurrentSource',
        value: Number.isFinite(spec.initial_current) ? spec.initial_current : 0,
        from_node: spec.from_node,
        to_node: spec.to_node
      };
    }
    return spec;
  });
}

/**
 * DC operating-point solve at t=0. Returns the solved Map AND a Map of
 * consistent (v_prev, i_prev) per storage element id, ready to seed
 * `circuitState` for the first trap step.
 */
function dcOperatingPoint(elementsSpec, nodes, groundNode) {
  const dcSpec = dcEquivalentSpec(elementsSpec);
  const dcInstances = buildElementInstances(dcSpec);

  const G = new MnaMatrix();
  const C = new MnaMatrix();
  const rhs = new MnaVector();

  // dt is irrelevant at the DC operating point (no caps/inductors are
  // present — only their DC equivalents). Pass dt=1 as a sentinel that
  // satisfies any defensive `dt > 0` checks; the value never enters
  // the resulting matrix.
  for (const inst of dcInstances) {
    inst.stamp(G, C, rhs, 0, 1, null);
  }

  const dcSolved = assembleAndSolve(G, rhs, nodes, groundNode, dcSpec);

  // Derive consistent prev_state for each storage element.
  const consistentState = new Map();
  for (const spec of elementsSpec) {
    if (spec.type === 'Capacitor') {
      consistentState.set(spec.id, {
        v_prev: Number.isFinite(spec.initial_voltage) ? spec.initial_voltage : 0,
        i_prev: dcSolved.get(branchKey(spec.id)) ?? 0
      });
    } else if (spec.type === 'Inductor') {
      const v_from = dcSolved.get(spec.from_node) ?? 0;
      const v_to = dcSolved.get(spec.to_node) ?? 0;
      consistentState.set(spec.id, {
        i_prev: Number.isFinite(spec.initial_current) ? spec.initial_current : 0,
        v_prev: v_from - v_to
      });
    } else {
      consistentState.set(spec.id, null);
    }
  }

  return { dcSolved, consistentState };
}

/**
 * Build the t=0 diagnostic snapshot directly from the DC solve. Avoids
 * the trap-companion's prev_state-dependent branch-current formula
 * (which would require prev_state objects we don't have at t=0).
 */
function emitInitialFromDC(dcSolved, elementsSpec, nodes, consistentState) {
  const v_nodes = new Map();
  for (const n of nodes) v_nodes.set(n, dcSolved.get(n) ?? 0);

  const i_branches = new Map();
  for (const spec of elementsSpec) {
    let i;
    switch (spec.type) {
      case 'Resistor': {
        const v_from = dcSolved.get(spec.from_node) ?? 0;
        const v_to = dcSolved.get(spec.to_node) ?? 0;
        i = (v_from - v_to) / spec.value;
        break;
      }
      case 'VoltageSource':
        i = dcSolved.get(branchKey(spec.id)) ?? 0;
        break;
      case 'CurrentSource':
        i = spec.value;
        break;
      case 'Capacitor':
        // Substituted as VS in the DC system → branch:<id> is the
        // initial cap current.
        i = dcSolved.get(branchKey(spec.id)) ?? 0;
        break;
      case 'Inductor':
        // Substituted as CS in the DC system → initial inductor
        // current = the user-declared initial_current.
        i = consistentState.get(spec.id)?.i_prev ?? 0;
        break;
      default:
        throw new Error(`emitInitialFromDC: unknown type "${spec.type}"`);
    }
    i_branches.set(spec.id, i);
  }
  return { v_nodes, i_branches };
}

/**
 * runCircuitCheck(scene, t_horizon, dt) — integrator skeleton.
 *
 * Steps `circuit_topology` from t=0 to t_horizon at fixed dt using a
 * DC operating-point at t=0 followed by Q2=a trapezoidal-companion MNA
 * solves at t = k·dt for k = 1..N (N = round(t_horizon/dt)). Returns a
 * Map of per-tick trajectories keyed by `v_node_<id>` (every node) and
 * `i_branch_<id>` (every element).
 *
 * @param {Object} scene                — scene with `circuit_topology` block
 * @param {number} t_horizon            — final time (s, ≥ 0)
 * @param {number} dt                   — fixed time step (s, > 0)
 * @returns {{
 *   t: number[],
 *   trajectory: Map<string, number[]>,
 *   meta: { ticks: number, dt: number, t_horizon: number }
 * }}
 */
export function runCircuitCheck(scene, t_horizon, dt) {
  if (!scene || typeof scene !== 'object') {
    throw new Error('runCircuitCheck: scene must be an object');
  }
  const ct = scene.circuit_topology;
  if (!ct || typeof ct !== 'object') {
    throw new Error('runCircuitCheck: scene.circuit_topology block is required');
  }
  if (!Array.isArray(ct.nodes) || ct.nodes.length < 2) {
    throw new Error(
      'runCircuitCheck: scene.circuit_topology.nodes must be an array with ≥2 entries'
    );
  }
  if (typeof ct.ground_node !== 'string' || !ct.nodes.includes(ct.ground_node)) {
    throw new Error(
      `runCircuitCheck: scene.circuit_topology.ground_node "${ct.ground_node}" not in nodes`
    );
  }
  if (!Array.isArray(ct.elements) || ct.elements.length === 0) {
    throw new Error('runCircuitCheck: scene.circuit_topology.elements must be a non-empty array');
  }
  if (!Number.isFinite(t_horizon) || t_horizon < 0) {
    throw new Error(`runCircuitCheck: t_horizon must be a finite non-negative number (got ${t_horizon})`);
  }
  if (!Number.isFinite(dt) || dt <= 0) {
    throw new Error(`runCircuitCheck: dt must be a finite positive number (got ${dt})`);
  }

  const elementsSpec = ct.elements;
  const instances = buildElementInstances(elementsSpec);

  // Lock #26 — fresh state per invocation. The snapshot reset is
  // symmetric to circuitState.clear() per Step 0b.5: contributors that
  // imported `circuitSnapshot` from a prior run must NOT see stale
  // post-run residue.
  circuitState.clear();
  clearCircuitSnapshot();

  // ----- t = 0: DC operating-point ---------------------------------
  const { dcSolved, consistentState } = dcOperatingPoint(elementsSpec, ct.nodes, ct.ground_node);
  for (const [id, ps] of consistentState) {
    circuitState.set(id, ps);
  }
  // Seed snapshot from the DC solve so a contributor invoked between
  // ticks 0 and 1 (or right after runCircuitCheck returns at
  // t_horizon=0) sees the t=0 operating point, not null.
  circuitSnapshot.solved = dcSolved;
  circuitSnapshot.dt = dt;
  circuitSnapshot.ready = true;

  const N = Math.round(t_horizon / dt);
  const ticks = N + 1;
  const tArr = new Array(ticks);
  tArr[0] = 0;
  const trajectory = new Map();

  // Emit t=0 snapshot from the DC solve.
  const initial = emitInitialFromDC(dcSolved, elementsSpec, ct.nodes, consistentState);
  appendTick(trajectory, initial.v_nodes, initial.i_branches);

  // ----- t = k·dt for k = 1..N: trap-companion steps ---------------
  // Each step (stamp → solve → refresh snapshot → post-solve update) is the
  // shared `_trapCompanionStep` core — the SAME single-tick advance the live
  // runner drives one tick at a time via `stepCircuitLive` (Phase A3). Here
  // runCircuitCheck additionally appends the per-tick trajectory via
  // emitDiagnostics on the returned solve + stamp-time state.
  for (let k = 1; k <= N; k++) {
    const t = k * dt;
    tArr[k] = t;

    const { solved, stampTimeState } = _trapCompanionStep(
      instances, elementsSpec, ct.nodes, ct.ground_node, t, dt
    );

    const { v_nodes, i_branches } = emitDiagnostics(
      solved, elementsSpec, ct.nodes, stampTimeState, dt
    );
    appendTick(trajectory, v_nodes, i_branches);
  }

  return {
    t: tArr,
    trajectory,
    meta: { ticks, dt, t_horizon }
  };
}

/**
 * One trapezoidal-companion MNA step — the shared core of `runCircuitCheck`'s
 * per-tick loop and the live runner's `stepCircuitLive` (Phase A3). Stamps
 * every instance with its current `circuitState` prev_state, solves the MNA
 * system, refreshes the engine-owned `circuitSnapshot`, and runs the
 * post-solve prev_state update — so afterwards `circuitState.get(id).i_prev`
 * for a Capacitor/Inductor is that tick's through-element current (the byte-
 * identical formula `emitDiagnostics` uses; see the A3 brief §4).
 *
 * Returns `{ solved, stampTimeState }` so the batch path can still append its
 * per-tick trajectory via emitDiagnostics — which reads ONLY these two values,
 * never `circuitState`, so running the post-solve update BEFORE the emit (as
 * happens here) is value-preserving relative to the prior inline ordering.
 *
 * Mutates the engine-owned `circuitState` + `circuitSnapshot` singletons; pure
 * otherwise. Caller is responsible for the t=0 seed (`seedCircuitDC`).
 */
function _trapCompanionStep(instances, elementsSpec, nodes, groundNode, t, dt) {
  const G = new MnaMatrix();
  const C = new MnaMatrix();
  const rhs = new MnaVector();

  // Snapshot prev_state used by stamp(). Element classes return FRESH objects
  // (Lock #17); install them into circuitState immediately for the next-tick
  // stamp. The post-solve update + emitDiagnostics need the stamp-time pair.
  const stampTimeState = new Map();
  for (const inst of instances) {
    const ps_in = circuitState.get(inst.id);
    stampTimeState.set(inst.id, ps_in);
    const ps_out = inst.stamp(G, C, rhs, t, dt, ps_in);
    circuitState.set(inst.id, ps_out);
  }

  const solved = assembleAndSolve(G, rhs, nodes, groundNode, elementsSpec);

  // Refresh engine-owned snapshot to the latest tick (read by the circuit
  // diagnostics producer in `circuits.js`).
  circuitSnapshot.solved = solved;
  circuitSnapshot.dt = dt;
  circuitSnapshot.ready = true;

  // Post-solve update: mutate the fresh prev_state (already in circuitState) to
  // its post-tick values. Lock #17 freshness guarantees this never clobbers the
  // stamp-time object held in stampTimeState.
  for (const inst of instances) {
    const ps_fresh = circuitState.get(inst.id);
    if (ps_fresh == null) continue;
    const v_from = solved.get(inst.from_node) ?? 0;
    const v_to = solved.get(inst.to_node) ?? 0;
    const dv = v_from - v_to;
    const stampTime = stampTimeState.get(inst.id);
    if (inst instanceof Capacitor) {
      const G_eq = (2 * inst.value) / dt;
      const I_history = G_eq * stampTime.v_prev + stampTime.i_prev;
      ps_fresh.v_prev = dv;
      ps_fresh.i_prev = G_eq * dv - I_history;
    } else if (inst instanceof Inductor) {
      const G_eq = dt / (2 * inst.value);
      const I_history = G_eq * stampTime.v_prev + stampTime.i_prev;
      ps_fresh.v_prev = dv;
      ps_fresh.i_prev = G_eq * dv + I_history;
    }
  }

  return { solved, stampTimeState };
}

/**
 * Phase A3 — seed the t=0 DC operating point for the LIVE runner. Clears the
 * engine-owned circuit singletons, solves the DC operating point (caps →
 * VoltageSource(initial_voltage), inductors → CurrentSource(initial_current)),
 * seeds `circuitState` with the consistent (v_prev, i_prev) pairs, and sets
 * `circuitSnapshot` to the DC solve so the inspector/producer show the t=0
 * operating point immediately AND the first `stepCircuitLive` trap step has the
 * valid prev_state that `Capacitor.stamp`/`Inductor.stamp` require.
 *
 * Idempotent (clears first). Runs the same shape guards as `runCircuitCheck`
 * so a degenerate `circuit_topology` fails at runner construction with a clear
 * message, not an opaque LU NaN. The live `dt` is unknown at seed time;
 * `circuitSnapshot.dt` stays null until the first trap step sets it.
 *
 * @param {Object} ct — scene `circuit_topology` block.
 */
export function seedCircuitDC(ct) {
  if (!ct || typeof ct !== 'object') {
    throw new Error('seedCircuitDC: circuit_topology block is required');
  }
  if (!Array.isArray(ct.nodes) || ct.nodes.length < 2) {
    throw new Error('seedCircuitDC: circuit_topology.nodes must be an array with ≥2 entries');
  }
  if (typeof ct.ground_node !== 'string' || !ct.nodes.includes(ct.ground_node)) {
    throw new Error(`seedCircuitDC: ground_node "${ct.ground_node}" not in nodes`);
  }
  if (!Array.isArray(ct.elements) || ct.elements.length === 0) {
    throw new Error('seedCircuitDC: circuit_topology.elements must be a non-empty array');
  }
  circuitState.clear();
  clearCircuitSnapshot();
  const { dcSolved, consistentState } = dcOperatingPoint(ct.elements, ct.nodes, ct.ground_node);
  for (const [id, ps] of consistentState) {
    circuitState.set(id, ps);
  }
  circuitSnapshot.solved = dcSolved;
  circuitSnapshot.ready = true;
}

/**
 * Phase A3 — advance the live circuit by exactly one trapezoidal-companion
 * tick. Registered as a discrete update in `SimRunner._advanceOne`'s step-3
 * slot (scene.js). `instances` are built once at scene-load and reused (element
 * classes are stateless; all per-tick state lives in `circuitState`). The
 * producer (`circuits.js`) reads the refreshed `circuitSnapshot`/`circuitState`
 * post-hoc to emit v_node/i_branch/power, so this returns nothing.
 *
 * @param {Object} ct        — scene `circuit_topology` block.
 * @param {Array}  instances — element instances from `buildElementInstances`.
 * @param {number} t         — post-step time (s).
 * @param {number} dt        — tick step (s).
 */
export function stepCircuitLive(ct, instances, t, dt) {
  _trapCompanionStep(instances, ct.elements, ct.nodes, ct.ground_node, t, dt);
}

export const NAME = 'circuits';
