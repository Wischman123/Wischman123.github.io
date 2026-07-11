// engine/circuits/tracker_emit.js
//
// Phase 5.C Step 0b.4 deliverable. Emits per-tick diagnostic channels
// from a freshly-solved MNA snapshot. NARROW SCOPE at 0b.4: only
// `v_node_<id>` and `i_branch_<id>` per the handoff watch-out — full
// conservation channels (`U_capacitor_<id>`, `U_inductor_<id>`,
// `power_dissipated_resistor_<id>`) land at 0b.5 via
// `circuits.contributeEnergy()` / `contributeDiagnostics()` per the
// 5.D Step 0b.7 contract.
//
// Branch-current sign convention (matches components.js header):
//   - Resistor:      i = (v_from − v_to) / R
//   - VoltageSource: i = solved branch:<id> value
//   - CurrentSource: i = +value (current FROM `from` TOWARD `to`)
//   - Capacitor:     i = G_eq · (v_from − v_to) − I_history    (Q2=a)
//   - Inductor:      i = G_eq · (v_from − v_to) + I_history    (Q2=a)
//
// `prev_state` for storage elements MUST be the state used by the
// stamp() that produced the solution (i.e., the freshness object the
// caller installed BEFORE the post-solve update step). The caller
// `runCircuitCheck` arranges this — tracker_emit reads, never writes.

import { branchKey } from './mna.js';

/**
 * @param {Map<string, number>} solved      — node voltages + branch currents from `assembleAndSolve`
 * @param {Array<{id:string,type:string,value:number,from_node:string,to_node:string}>} elements
 * @param {string[]} nodes                  — `circuit_topology.nodes[]`
 * @param {Map<string, any>} prev_state_map — element_id → prev_state object (pre-update)
 * @param {number} dt                       — tick step (s)
 * @returns {{ v_nodes: Map<string, number>, i_branches: Map<string, number> }}
 */
export function emitDiagnostics(solved, elements, nodes, prev_state_map, dt) {
  const v_nodes = new Map();
  for (const n of nodes) {
    v_nodes.set(n, solved.get(n) ?? 0);
  }

  const i_branches = new Map();
  for (const e of elements) {
    const v_from = solved.get(e.from_node) ?? 0;
    const v_to = solved.get(e.to_node) ?? 0;
    const dv = v_from - v_to;
    let i;
    switch (e.type) {
      case 'Resistor':
        i = dv / e.value;
        break;
      case 'VoltageSource':
        i = solved.get(branchKey(e.id)) ?? 0;
        break;
      case 'CurrentSource':
        i = e.value;
        break;
      case 'Capacitor': {
        const ps = prev_state_map.get(e.id);
        const G_eq = (2 * e.value) / dt;
        const I_history = G_eq * ps.v_prev + ps.i_prev;
        i = G_eq * dv - I_history;
        break;
      }
      case 'Inductor': {
        const ps = prev_state_map.get(e.id);
        const G_eq = dt / (2 * e.value);
        const I_history = G_eq * ps.v_prev + ps.i_prev;
        i = G_eq * dv + I_history;
        break;
      }
      default:
        throw new Error(`tracker_emit: unknown element type "${e.type}" for "${e.id}"`);
    }
    i_branches.set(e.id, i);
  }

  return { v_nodes, i_branches };
}

/**
 * Convenience: append one tick's diagnostics to a trajectory map keyed
 * by full channel name (`v_node_<id>` / `i_branch_<id>`). Initialises
 * channels on first call.
 *
 * @param {Map<string, number[]>} trajectory  — channel → values[]
 * @param {Map<string, number>} v_nodes
 * @param {Map<string, number>} i_branches
 */
export function appendTick(trajectory, v_nodes, i_branches) {
  for (const [nodeId, v] of v_nodes) {
    const key = `v_node_${nodeId}`;
    let arr = trajectory.get(key);
    if (!arr) { arr = []; trajectory.set(key, arr); }
    arr.push(v);
  }
  for (const [elemId, i] of i_branches) {
    const key = `i_branch_${elemId}`;
    let arr = trajectory.get(key);
    if (!arr) { arr = []; trajectory.set(key, arr); }
    arr.push(i);
  }
}
