// engine/circuits/mna.js
//
// Phase 5.C Step 0b.1 deliverable. Tiny accumulator classes for the
// G_matrix / C_matrix / rhs_vector arguments of every element class's
// `stamp(...)` method.
//
// Why these classes exist: per the locked Step 0b.1 contract, every
// element class implements
//
//   stamp(G_matrix, C_matrix, rhs_vector, t, dt, prev_state) → updated_state
//
// and contributes its node-keyed entries via `.add(i, j, val)` /
// `.add(i, val)`. The actual MNA solver (lands at Step 4(b)2 in
// `circuits/solver.js`) is responsible for picking a node ordering and
// translating these key-indexed accumulators into a dense LU-decomposed
// matrix. Decoupling the stamp-time API from the solve-time array
// layout keeps each element class blissfully unaware of the global
// node-index table — element ids and node ids stay strings end-to-end
// at stamp time.
//
// "Branch" rows (the augmented MNA variables for VoltageSource — and
// for inductors if Q9=c hybrid form is ever taken; Q9=b in scope for
// 5.C uses pure trapezoidal-companion, so inductors stay nodal-only)
// share the same key namespace as node ids. The `BRANCH_ID_PREFIX`
// constant below is the only contract: "branch:" + element_id
// disambiguates the augment row from any plausible scene-author node
// id (validator at 0b.2 rejects node ids whose name starts with
// `branch:`). Solver consumes the prefix to size and order rows.
//
// Sparsity: 5.C's canonical scenes have 2-4 nodes, so even the
// `network_resistor_1` mesh tops out at ~10 entries. A Map keyed by
// "i|j" beats both a 2D dense array (we don't know N at stamp time)
// and a per-row Map (extra layer of indirection). Re-evaluate at 5.E
// if scene-size pushes >100 nodes; until then this is good enough.

const KEY_SEP = '';

/**
 * Sparse-style accumulator for MNA matrices. Used for both `G_matrix`
 * and `C_matrix` arguments to `stamp(...)`.
 *
 * Element classes call `.add(rowKey, colKey, value)` to contribute
 * additively to entry (rowKey, colKey). Successive calls to the same
 * (rowKey, colKey) accumulate (matrix-stamping convention). The solver
 * reads back via `.get(rowKey, colKey)` or `.entries()` for assembly.
 */
export class MnaMatrix {
  constructor() {
    /** @type {Map<string, number>} */
    this._cells = new Map();
    /** @type {Set<string>} */
    this._rowKeys = new Set();
    /** @type {Set<string>} */
    this._colKeys = new Set();
  }

  add(rowKey, colKey, value) {
    if (typeof rowKey !== 'string' || typeof colKey !== 'string') {
      throw new TypeError(
        `MnaMatrix.add: row and col keys must be strings; got ${typeof rowKey} / ${typeof colKey}`
      );
    }
    if (!Number.isFinite(value)) {
      throw new TypeError(
        `MnaMatrix.add(${rowKey}, ${colKey}): value must be finite number; got ${value}`
      );
    }
    if (value === 0) return;
    const k = rowKey + KEY_SEP + colKey;
    this._cells.set(k, (this._cells.get(k) ?? 0) + value);
    this._rowKeys.add(rowKey);
    this._colKeys.add(colKey);
  }

  get(rowKey, colKey) {
    return this._cells.get(rowKey + KEY_SEP + colKey) ?? 0;
  }

  rowKeys() {
    return [...this._rowKeys];
  }

  colKeys() {
    return [...this._colKeys];
  }

  entries() {
    const out = [];
    for (const [k, v] of this._cells) {
      const sep = k.indexOf(KEY_SEP);
      out.push([k.slice(0, sep), k.slice(sep + 1), v]);
    }
    return out;
  }
}

/**
 * Sparse-style accumulator for the MNA right-hand-side vector. Used for
 * the `rhs_vector` argument to `stamp(...)`.
 */
export class MnaVector {
  constructor() {
    /** @type {Map<string, number>} */
    this._cells = new Map();
  }

  add(rowKey, value) {
    if (typeof rowKey !== 'string') {
      throw new TypeError(
        `MnaVector.add: rowKey must be string; got ${typeof rowKey}`
      );
    }
    if (!Number.isFinite(value)) {
      throw new TypeError(
        `MnaVector.add(${rowKey}): value must be finite number; got ${value}`
      );
    }
    if (value === 0) return;
    this._cells.set(rowKey, (this._cells.get(rowKey) ?? 0) + value);
  }

  get(rowKey) {
    return this._cells.get(rowKey) ?? 0;
  }

  rowKeys() {
    return [...this._cells.keys()];
  }

  entries() {
    return [...this._cells.entries()];
  }
}

/**
 * Augmented-row key prefix for MNA variables that are NOT node voltages
 * (currently: VoltageSource branch currents).
 */
export const BRANCH_ID_PREFIX = 'branch:';

/**
 * Build the augmented-row key for an element id.
 */
export function branchKey(elementId) {
  return BRANCH_ID_PREFIX + elementId;
}
