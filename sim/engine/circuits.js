// engine/circuits.js
//
// Phase 5.C Step 0b.5 deliverable. Sole owner of the conservation-
// channel producer surface for the lumped-element circuit subsystem.
// Sibling-file pattern matches 5.B's `flux.js` / `flux_check.js` and
// 5.D's `induction.js` / `induction_check.js` — `circuits.js` here is
// the producer; `circuits_check.js` is the integrator entry point.
//
// Locked decisions (frontmatter `q*_lock` of physics_simulator_phase_5_c_circuits):
//   - 5.D Step 0b.7 contract: `contributeEnergy(map, sceneCtx)` and
//     `contributeDiagnostics(map, sceneCtx)`. Both write directly into
//     `map`; receiver is the local conservation-channel map maintained
//     by the ConservationTracker (4(b) wires the tracker.current()
//     call into the runner). `sceneCtx` is the runner-level scene
//     context — at minimum it carries `circuit_topology` so the
//     producer knows which elements to iterate.
//   - Lock #26 (`K = 0` invariant): K is computed by the tracker over
//     bodies. Body-less circuit-only scenes return K = 0 with no
//     special-case branch; this module does NOT touch K.
//   - Lock #15 (prev_state shape): Capacitor stores `{ v_prev,
//     i_prev }`, Inductor stores `{ i_prev, v_prev }`. After the
//     post-solve update, `v_prev` is the latest across-terminal
//     voltage and `i_prev` is the latest through-element current
//     (passive sign convention). So `U_capacitor = ½·C·v_prev²` and
//     `U_inductor = ½·L·i_prev²` are correct at end-of-tick.
//   - Lock #16 (storage location): producer reads from the engine-
//     owned `circuitState` (per-element prev_state) and
//     `circuitSnapshot` (latest solved Map + dt) via barrel re-exports.
//     No new module-level state introduced here.
//
// Channel space (per 0c JSON predicted_baseline_deltas):
//   contributions:
//     U_capacitor_<id>            (one per Capacitor)
//     U_inductor_<id>             (one per Inductor)
//     power_dissipated_resistor_<id> (one per Resistor)
//   diagnostics:
//     v_node_<id>                 (one per node)
//     i_branch_<id>               (one per element)
//
// The 0c JSON predicts 5+5+6+5+8 = 29 ADDITIVE keys across the five
// 5.C scenes (rc/rl/rlc/induced/network). 0b.4 already emits v_node +
// i_branch into the `runCircuitCheck` trajectory map (per-tick, dense);
// 0b.5 adds the producer surface so a ConservationTracker invocation
// can also fold these into the conservation/diagnostics channel space.
// The two paths coexist because they serve different consumers:
// trajectory dump (offline analysis, per-tick) vs. tracker channel
// (live drift gate, per-snapshot).
//
// Sign / magnitude conventions:
//   - U_capacitor = ½·C·v_C²  with v_C = v_from − v_to (Lock #15
//     v_prev). Always non-negative; closure invariant requires this
//     to monotonically reflect cap-stored energy.
//   - U_inductor  = ½·L·i_L²  with i_L = through-element current
//     (Lock #15 i_prev). Always non-negative.
//   - power_dissipated_resistor = i² · R, computed from the latest
//     solved snapshot: i_R = (v_from − v_to) / R. Always non-
//     negative (i² ≥ 0). NOTE: this is INSTANTANEOUS power (W), not
//     accumulated thermal energy. The ConservationTracker integration
//     into U_thermal is the consumer's job (4(b) ConservationTracker
//     hook); this module emits the rate.
//
// Producer-call freshness contract:
//   - `contributeEnergy` and `contributeDiagnostics` are pure reads
//     from `circuitState` + `circuitSnapshot`. They never mutate
//     engine state. Calling either one twice in a row with no
//     intervening tick yields the same map values.
//   - If `circuitSnapshot.ready === false` (no tick has run yet, or a
//     fresh `runCircuitCheck` invocation hasn't reached the snapshot
//     write), the resistor power channel falls back to 0 (the only
//     safe value when no solved Map is available). U_capacitor /
//     U_inductor still emit if `circuitState` has entries — those
//     come from the DC-operating-point seeding at runCircuitCheck
//     entry, which lands BEFORE any trap step.
//
// Engine touch: this module ships under sim/engine/. The Step 0b.5
// sub-commit MUST carry the `engine-universality:` trailer per the
// 0c JSON `engine_universality_trailer_policy`. Bypass tokens
// (`schema-promotion-only`, `atom-rollup-only`) DO NOT apply.

import { circuitState, circuitSnapshot, branchKey } from './circuits/index.js';

/**
 * Walk the scene's circuit_topology element list and write per-element
 * conservation contributions into `map`:
 *
 *   U_capacitor_<id>  = ½ · C · v_C²    (Capacitor, requires prev_state)
 *   U_inductor_<id>   = ½ · L · i_L²    (Inductor,  requires prev_state)
 *
 * Resistor / VoltageSource / CurrentSource have no stored energy —
 * skipped here. (Resistor power dissipation is a DIAGNOSTIC rate, not
 * a contribution; see contributeDiagnostics below.)
 *
 * Pure read; never mutates engine state. If `circuitState` has no
 * entry for a storage element (e.g., contributor invoked before the
 * first runCircuitCheck), that element is silently skipped — no
 * channel emitted, no throw. This mirrors the contributeDiagnostics
 * pattern in energy.js where producers control their own keys.
 *
 * @param {Object} map         — channel-keyed map (mutated in place)
 * @param {Object} sceneCtx    — runner scene context, must carry
 *                                `circuit_topology.elements[]`
 */
export function contributeEnergy(map, sceneCtx) {
  const elements = sceneCtx?.circuit_topology?.elements;
  if (!Array.isArray(elements)) return;
  for (const el of elements) {
    if (el.type === 'Capacitor') {
      const ps = circuitState.get(el.id);
      if (!ps || !Number.isFinite(ps.v_prev)) continue;
      map[`U_capacitor_${el.id}`] = 0.5 * el.value * ps.v_prev * ps.v_prev;
    } else if (el.type === 'Inductor') {
      const ps = circuitState.get(el.id);
      if (!ps || !Number.isFinite(ps.i_prev)) continue;
      map[`U_inductor_${el.id}`] = 0.5 * el.value * ps.i_prev * ps.i_prev;
    }
  }
}

/**
 * Walk the scene's circuit_topology element list and write per-element
 * diagnostic channels into `map`:
 *
 *   power_dissipated_resistor_<id> = i_R² · R    (one per Resistor)
 *   v_node_<node_id>                              (one per node)   [A3]
 *   i_branch_<id>                                 (one per element) [A3]
 *
 * Reads the latest solved Map from `circuitSnapshot`. The resistor power
 * channel falls back to 0 W when the snapshot is not ready (no solve yet) —
 * the only safe value when no voltage solution exists.
 *
 * Phase A3: v_node_<id> + i_branch_<id> are emitted ONCE a solve exists
 * (`circuitSnapshot.ready`). The runner seeds a DC operating point at t=0 and
 * steps the MNA live each tick (`stepCircuitLive`), so during playback this is
 * always ready. v_node comes from the solved Map; i_branch by element type —
 * Resistor/VoltageSource/CurrentSource from `solved`, and Capacitor/Inductor
 * from the post-update `circuitState.get(id).i_prev` (the byte-identical
 * formula `tracker_emit.emitDiagnostics` uses for the through-element current;
 * see the A3 brief §4). The original 5.C deferral of these channels to the
 * `runCircuitCheck` trajectory dump is moot at runtime — that batch trajectory
 * never runs during playback.
 *
 * Pure, throw-free read; never mutates engine state. Storage-element reads are
 * guarded (skip a missing/non-finite circuitState entry) exactly like
 * `contributeEnergy`, so a cross-scene-contaminated global can't make the
 * producer throw.
 *
 * @param {Object} map         — diagnostic-keyed map (mutated in place)
 * @param {Object} sceneCtx    — runner scene context, must carry
 *                                `circuit_topology` (nodes + elements)
 */
export function contributeDiagnostics(map, sceneCtx) {
  const ct = sceneCtx?.circuit_topology;
  const elements = ct?.elements;
  if (!Array.isArray(elements)) return;
  const solved = circuitSnapshot.ready ? circuitSnapshot.solved : null;

  // Resistor instantaneous power — falls back to 0 W when no solve is available.
  for (const el of elements) {
    if (el.type !== 'Resistor') continue;
    const key = `power_dissipated_resistor_${el.id}`;
    if (!solved) {
      map[key] = 0;
      continue;
    }
    const v_from = solved.get(el.from_node) ?? 0;
    const v_to = solved.get(el.to_node) ?? 0;
    const i = (v_from - v_to) / el.value;
    map[key] = i * i * el.value;
  }

  // A3 node voltages + branch currents — emitted only once a (live or DC-seed)
  // solve exists.
  if (!solved) return;
  if (Array.isArray(ct.nodes)) {
    for (const n of ct.nodes) map[`v_node_${n}`] = solved.get(n) ?? 0;
  }
  for (const el of elements) {
    const ikey = `i_branch_${el.id}`;
    switch (el.type) {
      case 'Resistor': {
        const v_from = solved.get(el.from_node) ?? 0;
        const v_to = solved.get(el.to_node) ?? 0;
        map[ikey] = (v_from - v_to) / el.value;
        break;
      }
      case 'VoltageSource':
        map[ikey] = solved.get(branchKey(el.id)) ?? 0;
        break;
      case 'CurrentSource':
        map[ikey] = el.value;
        break;
      case 'Capacitor':
      case 'Inductor': {
        const ps = circuitState.get(el.id);
        if (ps && Number.isFinite(ps.i_prev)) map[ikey] = ps.i_prev;
        break;
      }
      // Unknown types are rejected by the scene loader / circuit_validation;
      // skip silently here to keep the producer a non-throwing read.
    }
  }
}

export const NAME = 'circuits';
