// engine/circuits/index.js
//
// Phase 5.C Step 0b.4 — internal barrel for the circuits engine
// subsystem. Public entry is `sim/engine/circuits_check.js` (sibling-
// file pattern locked at /recommend per Q16-loc=loc-2; mirrors 5.D's
// induction.js / induction_check.js shape per appendix lock #22).
//
// Consumers OUTSIDE the engine should import from `circuits_check.js`.
// Consumers WITHIN the engine subsystem may import from this barrel.

export {
  circuitState,
  circuitSnapshot,
  clearCircuitSnapshot
} from './state.js';
export {
  MnaMatrix,
  MnaVector,
  BRANCH_ID_PREFIX,
  branchKey
} from './mna.js';
export { assembleAndSolve, buildVariableOrdering } from './solver.js';
export { emitDiagnostics, appendTick } from './tracker_emit.js';
