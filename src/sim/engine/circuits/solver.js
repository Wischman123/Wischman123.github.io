// engine/circuits/solver.js
//
// Phase 5.C Step 0b.4 deliverable. Engine-side dense LU solver for the
// MNA system assembled by element classes' `stamp(...)` methods. Lock
// #25: invocation-local. Decompose at entry, discard at return. NO
// module-level / scene-load-level caching — module-global cache would
// break parallel Jest workers and is a 5.E candidate (run-spanning
// cache).
//
// Why a separate LU from `_derivations/network_resistor_analytic.js`:
// the analytic LU is a pure-math TEST FIXTURE; this LU is the live
// integrator's solver. Conflating them would couple the engine to a
// scenario-specific test asset (handoff "Do NOT" list, item 3).
//
// Variable ordering (deterministic):
//   1. Non-ground nodes in `circuit_topology.nodes[]` order
//   2. branch:<id> rows in `circuit_topology.elements[]` order
//      (only VoltageSource elements introduce a branch row)
//
// Ground row + column are eliminated before LU (KCL at ground is the
// dependent equation; ground voltage is pinned to 0).

import { branchKey } from './mna.js';

/**
 * Build the deterministic variable ordering for `assembleAndSolve`.
 *
 * Exposed for testability and so consumers (tracker_emit) can iterate
 * the same key set without re-parsing the scene.
 *
 * @param {string[]} nodes              — `circuit_topology.nodes[]` (canonical order)
 * @param {string} groundNode           — `circuit_topology.ground_node`
 * @param {Array<{id:string,type:string}>} elements — `circuit_topology.elements[]`
 * @returns {string[]} variable keys, in the order the LU sees them
 */
export function buildVariableOrdering(nodes, groundNode, elements) {
  const order = [];
  for (const n of nodes) {
    if (n !== groundNode) order.push(n);
  }
  for (const e of elements) {
    if (e.type === 'VoltageSource') order.push(branchKey(e.id));
  }
  return order;
}

/**
 * Assemble the dense MNA matrix from the sparse `MnaMatrix` accumulator,
 * eliminate the ground row/col, LU-decompose, and solve for the unknown
 * vector. Returns a Map keyed by variable name (node ids + branch:<id>),
 * with `groundNode` mapped to 0.
 *
 * @param {import('./mna.js').MnaMatrix} G_matrix
 * @param {import('./mna.js').MnaVector} rhs_vector
 * @param {string[]} nodes
 * @param {string} groundNode
 * @param {Array<{id:string,type:string}>} elements
 * @returns {Map<string, number>}
 */
export function assembleAndSolve(G_matrix, rhs_vector, nodes, groundNode, elements) {
  const order = buildVariableOrdering(nodes, groundNode, elements);
  const N = order.length;
  if (N === 0) {
    throw new Error('assembleAndSolve: empty variable ordering (need ≥1 unknown)');
  }
  const idx = new Map();
  for (let i = 0; i < N; i++) idx.set(order[i], i);

  // Allocate dense N×N + N-vector. Sparse → dense costs O(N²) but N is
  // tiny (5.C scenes top out at ~5 unknowns); dense is the right call.
  const A = Array.from({ length: N }, () => new Array(N).fill(0));
  const b = new Array(N).fill(0);

  // Stamp matrix entries, skipping any row or col that maps to ground.
  for (const [rowKey, colKey, val] of G_matrix.entries()) {
    const i = idx.get(rowKey);
    const j = idx.get(colKey);
    if (i === undefined || j === undefined) continue; // ground or unknown key
    A[i][j] += val;
  }
  for (const [rowKey, val] of rhs_vector.entries()) {
    const i = idx.get(rowKey);
    if (i === undefined) continue; // ground row dropped
    b[i] += val;
  }

  const x = luSolveDense(A, b);

  const result = new Map();
  result.set(groundNode, 0);
  for (let i = 0; i < N; i++) result.set(order[i], x[i]);
  return result;
}

// ---------------------------------------------------------------------
// Dense LU with partial pivoting (Doolittle) — invocation-local.
//
// Mirrors the algorithm in network_resistor_analytic.js but is a
// SEPARATE implementation per Lock #25 + handoff "Do NOT" item 3 (no
// engine-side reuse of the test-fixture LU).
// ---------------------------------------------------------------------

function luSolveDense(A, b) {
  const N = A.length;
  // Copy A so we don't mutate the caller's matrix (already a fresh
  // alloc inside assembleAndSolve, but defense in depth).
  const LU = A.map((row) => row.slice());
  const pivot = new Array(N);
  for (let i = 0; i < N; i++) pivot[i] = i;

  for (let k = 0; k < N; k++) {
    let maxRow = k;
    let maxVal = Math.abs(LU[k][k]);
    for (let r = k + 1; r < N; r++) {
      const v = Math.abs(LU[r][k]);
      if (v > maxVal) {
        maxVal = v;
        maxRow = r;
      }
    }
    if (maxVal < 1e-15) {
      throw new Error(
        `circuits/solver: singular MNA matrix at column ${k} ` +
        `(max pivot magnitude ${maxVal.toExponential(3)} < 1e-15). ` +
        `Common causes: zero-resistance loop with VoltageSource, ` +
        `floating sub-network disconnected from ground.`
      );
    }
    if (maxRow !== k) {
      const tmpRow = LU[k]; LU[k] = LU[maxRow]; LU[maxRow] = tmpRow;
      const tmpP = pivot[k]; pivot[k] = pivot[maxRow]; pivot[maxRow] = tmpP;
    }
    const pivotVal = LU[k][k];
    for (let r = k + 1; r < N; r++) {
      LU[r][k] /= pivotVal;
      const factor = LU[r][k];
      for (let c = k + 1; c < N; c++) {
        LU[r][c] -= factor * LU[k][c];
      }
    }
  }

  const y = new Array(N);
  for (let i = 0; i < N; i++) y[i] = b[pivot[i]];
  for (let i = 1; i < N; i++) {
    let s = y[i];
    for (let j = 0; j < i; j++) s -= LU[i][j] * y[j];
    y[i] = s;
  }
  const x = new Array(N);
  for (let i = N - 1; i >= 0; i--) {
    let s = y[i];
    for (let j = i + 1; j < N; j++) s -= LU[i][j] * x[j];
    x[i] = s / LU[i][i];
  }
  return x;
}
