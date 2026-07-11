// engine/circuits/state.js
//
// Phase 5.C Step 0b.1 deliverable. Engine-owned per-element state Map
// for the lumped-element circuit solver.
//
// Locked decisions (frontmatter `q*_lock` of physics_simulator_phase_5_c_circuits):
//   - Lock #15 (`prev_state` shape) — opaque per element type:
//       Resistor / VoltageSource / CurrentSource → null (stateless);
//       Capacitor → { v_prev: number, i_prev: number };
//       Inductor  → { i_prev: number, v_prev: number }.
//     Element classes never inspect a *foreign* element's prev_state;
//     this Map keys by element id and the engine round-trips opaque
//     objects between ticks.
//   - Lock #16 (storage location) — engine-owned `Map<element_id,
//     prev_state>` lives HERE and HERE ONLY, exported as
//     `circuitState`. `runner.js` calls `circuitState.clear()` on
//     scene load; element classes are STATELESS — all state flows
//     through `stamp(...)` arguments + the returned object.
//   - Lock #17 (freshness rule) — every `stamp(...)` MUST return a
//     FRESH `prev_state` object each call AND MUST NOT mutate the
//     input. The engine relies on referential immutability: it stores
//     the returned object in this Map and re-passes it next tick. The
//     post-solve update (lands at Step 4(b)2 in `circuits/solver.js`)
//     mutates the *fresh* object stored here, NOT the prior tick's
//     prev_state.
//
// Step 0b.5 (this commit) extends the surface with `circuitSnapshot` —
// engine-owned LATEST solved Map + tick dt, populated by
// `runCircuitCheck` after every solve. The 0b.5 contributors
// (`sim/engine/circuits.js`) read this snapshot to compute resistor
// instantaneous power. Symmetric to `circuitState` lifecycle: cleared
// at runCircuitCheck entry per Lock #26.

/**
 * Engine-owned state for the circuit solver.
 *
 *   key  = element id (string from `circuit_topology.elements[].id`)
 *   value = opaque `prev_state` object returned by the element's
 *           prior `stamp(...)` call (or `null` for stateless types)
 *
 * Mutation convention:
 *   - `stamp(...)` reads the current entry; the engine writes the
 *     returned fresh object back here.
 *   - The post-solve update step (4(b)2) mutates the stored object
 *     in place to its post-tick values. This is safe because
 *     `stamp(...)` returned a FRESH copy at storage time.
 *
 * Lifecycle: cleared on scene load by `runner.js` so a re-loaded
 * scene starts with no stale state from the prior run.
 */
export const circuitState = new Map();

/**
 * Engine-owned snapshot of the LATEST solve. Step 0b.5 deliverable —
 * the producer surface in `sim/engine/circuits.js` reads `solved` to
 * derive resistor branch currents (from KCL: i_R = (v_from − v_to) / R)
 * for the `power_dissipated_resistor_<id>` diagnostic channel.
 *
 *   solved   — Map<string, number>  (node voltages + branch currents)
 *              from the most recent `assembleAndSolve(...)`
 *   dt       — number (s) — tick step used at the latest solve
 *   ready    — boolean — false until runCircuitCheck has run AT LEAST
 *              one tick; contributors use this to bail out cleanly.
 *
 * Reset semantics (Lock #26): `runCircuitCheck` clears this at entry
 * so a scene re-load never reads stale prior-run snapshots. Both the
 * DC operating-point pre-solve (t=0) and each trap step write here.
 */
export const circuitSnapshot = {
  solved: null,
  dt: null,
  ready: false
};

/**
 * Idempotent reset for the snapshot. Called by `runCircuitCheck` at
 * entry alongside `circuitState.clear()`.
 */
export function clearCircuitSnapshot() {
  circuitSnapshot.solved = null;
  circuitSnapshot.dt = null;
  circuitSnapshot.ready = false;
}
