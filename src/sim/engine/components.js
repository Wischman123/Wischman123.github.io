// engine/components.js
//
// Phase 5.C Step 0b.1 deliverable. Five lumped-element classes for the
// new MNA-based circuit solver subsystem:
//
//   Resistor       — passive linear resistor                         (stateless)
//   Capacitor      — trapezoidal companion-model integration          (stateful)
//   Inductor       — trapezoidal companion-model integration          (stateful)
//   VoltageSource  — independent DC voltage source (MNA-augmented)    (stateless)
//   CurrentSource  — independent DC current source                    (stateless)
//
// Locked decisions (frontmatter `q*_lock` of physics_simulator_phase_5_c_circuits):
//   - Q2=a — companion-model MNA + trapezoidal rule. Capacitors and
//     inductors are stamped as a Norton-equivalent conductance + a
//     known current source whose value comes from `prev_state`.
//   - Q5=a — separate JS class per element type (mirrors field-class
//     precedent: UniformField / RadialField / DipoleField as separate
//     classes). Each class is a bare data carrier + `stamp(...)`; no
//     element-type discriminator.
//   - Q8=a — scene-declared `initial_voltage` / `initial_current`.
//     Engine constructs `prev_state` at t=0 from these scene fields
//     (or 0 default); see `defaultPrevStateFor()` below for the
//     reference factory.
//   - Q14=c — Kahan summation declared YAGNI. Trapezoidal local
//     truncation dominates floating-point accumulation drift by 4+
//     orders of magnitude under in-scope dt regimes (per 0c JSON
//     `kahan_yagni_adr`). Plain `+` everywhere.
//   - Lock #15 (`prev_state` shape) — opaque per element type:
//       Resistor / VoltageSource / CurrentSource → null;
//       Capacitor → { v_prev: number, i_prev: number };
//       Inductor  → { i_prev: number, v_prev: number }.
//     `v_prev` is the across-terminal voltage `v_from − v_to` at the
//     prior tick; `i_prev` is the through-element current from `from`
//     to `to` at the prior tick. Capacitor and inductor share the
//     same field NAMES — the listing-order swap in Lock #15 is
//     literally a reading-order convention, not a structural type
//     distinction. Both fields must be finite numbers.
//   - Lock #16 (storage) — engine-owned `circuitState` Map at
//     `circuits/state.js`. Element classes never touch it directly;
//     they receive `prev_state` as a stamp() argument.
//   - Lock #17 (freshness rule) — every `stamp(...)` returns a FRESH
//     prev_state object each call AND MUST NOT mutate the input. The
//     engine + post-solve update mutate the FRESH object that gets
//     stored back; the input prev_state stays referentially
//     immutable from stamp()'s perspective.
//
// Stamping conventions (KCL "currents leaving node = sources into node"):
//
//   Capacitor (between `from`, `to`, value `C`, prev_state {v_prev, i_prev}):
//     companion-model Norton: G_eq = 2C/dt; I_history = G_eq·v_prev + i_prev.
//     The companion equivalent is a conductance G_eq between `from` and
//     `to` PLUS a current source of value I_history flowing FROM `to`
//     TOWARD `from` (so the source pushes positive current INTO `from`).
//
//       i_C_through_element_from→to(t_n)
//         = G_eq·(v_from − v_to)_n − I_history    ← derived from
//                                                    (i_n + i_{n−1})/2
//                                                    = C·(v_n − v_{n−1})/dt
//
//     KCL at `from` collects +i_C as a leaving current → constant
//     -I_history moves to RHS as +I_history. Symmetric at `to`.
//
//       G[from][from] += G_eq;  G[from][to]   -= G_eq;
//       G[to][from]   -= G_eq;  G[to][to]     += G_eq;
//       rhs[from]     += I_history;
//       rhs[to]       -= I_history;
//
//     Reference DAE-form C-matrix entries (NOT used by the Q9=b
//     trapezoidal-companion solver but populated for future use /
//     diagnostic inspection):
//       C[from][from] += C; C[from][to] -= C;
//       C[to][from]   -= C; C[to][to]   += C;
//
//   Inductor (between `from`, `to`, value `L`, prev_state {i_prev, v_prev}):
//     companion-model Norton: G_eq = dt/(2L); I_history = G_eq·v_prev + i_prev.
//     Same conductance stamps as capacitor with G_eq = dt/(2L), but the
//     I_history term has the OPPOSITE sign on the rhs side because the
//     inductor's constitutive equation `i = (dt/2L)·(v_n + v_{n−1}) +
//     i_{n−1}` puts I_history on the *same* side as the unknown current,
//     not the opposite side. Capacitor stamps `+I_history` at `from`;
//     inductor stamps `−I_history`.
//
//       G[from][from] += G_eq;  G[from][to]   -= G_eq;
//       G[to][from]   -= G_eq;  G[to][to]     += G_eq;
//       rhs[from]     -= I_history;
//       rhs[to]       += I_history;
//
//     Reference DAE-form C-matrix entries (likewise populated for
//     future use):
//       C[branchKey(id)][branchKey(id)] -= L;
//
//   Resistor (R between `from`, `to`):
//     G[from][from] += 1/R; G[from][to]   -= 1/R;
//     G[to][from]   -= 1/R; G[to][to]     += 1/R;
//
//   VoltageSource (V between `from` (+) and `to` (−), value `V`):
//     MNA-augmented: a new branch-current variable `branch:<id>` is
//     introduced. Its stamps:
//       constraint row v_from − v_to = V:
//         G[branchKey(id)][from] += 1;
//         G[branchKey(id)][to]   -= 1;
//         rhs[branchKey(id)]     += V;
//       KCL contributions at `from`/`to` (i_VS leaves `from`, enters `to`):
//         G[from][branchKey(id)] += 1;
//         G[to][branchKey(id)]   -= 1;
//
//   CurrentSource (I from `from` toward `to`, value `I`):
//     "from → to" means current leaves `from` and enters `to`. KCL:
//       rhs[from] -= I;   ← current leaving `from`, equivalently
//                            an injected current of −I into `from`
//       rhs[to]   += I;   ← current entering `to`
//
// Public surface intentionally stays narrow: each class exposes
// `id`, `value`, `from_node`, `to_node`, and `stamp(...)`. No
// constructor-time validation of node-existence (that's the scene
// loader / circuit_validation.js job, lands at Step 0b.2). No
// run-time mutation of class fields after construction.

import { branchKey } from './circuits/mna.js';

/**
 * Build a default `prev_state` for an element at t=0 from a scene
 * `circuit_topology.elements[]` entry. Engines and tests call this
 * once per element on scene-load; thereafter, the engine round-trips
 * whatever each `stamp(...)` returns.
 *
 * Per Lock #15: stateless types return `null`; capacitor/inductor
 * return { v_prev, i_prev } seeded from the scene's optional
 * `initial_voltage` / `initial_current` fields (defaulting to 0
 * when absent — the Q8=a "scene-declared initial state" lock).
 *
 * @param {string} type - 'Resistor' | 'Capacitor' | 'Inductor' |
 *                        'VoltageSource' | 'CurrentSource'
 * @param {{ initial_voltage?: number, initial_current?: number }} [opts]
 */
export function defaultPrevStateFor(type, opts = {}) {
  const v0 = Number.isFinite(opts.initial_voltage) ? opts.initial_voltage : 0;
  const i0 = Number.isFinite(opts.initial_current) ? opts.initial_current : 0;
  switch (type) {
    case 'Resistor':
    case 'VoltageSource':
    case 'CurrentSource':
      return null;
    case 'Capacitor':
      return { v_prev: v0, i_prev: i0 };
    case 'Inductor':
      return { i_prev: i0, v_prev: v0 };
    default:
      throw new Error(`defaultPrevStateFor: unknown element type '${type}'`);
  }
}

// ---------------------------------------------------------------------
// Element classes
// ---------------------------------------------------------------------

/**
 * Linear resistor. Stateless.
 *
 * @example
 *   new Resistor({ id: 'R1', value: 100, from_node: 'a', to_node: 'b' })
 */
export class Resistor {
  constructor({ id, value, from_node, to_node }) {
    this.id = id;
    this.value = value;
    this.from_node = from_node;
    this.to_node = to_node;
  }

  // eslint-disable-next-line no-unused-vars
  stamp(G_matrix, C_matrix, rhs_vector, t, dt, prev_state) {
    const g = 1 / this.value;
    const a = this.from_node;
    const b = this.to_node;
    G_matrix.add(a, a, +g);
    G_matrix.add(a, b, -g);
    G_matrix.add(b, a, -g);
    G_matrix.add(b, b, +g);
    return null;
  }
}

/**
 * Capacitor stamped as a trapezoidal Norton companion model. Stateful:
 * `prev_state = { v_prev, i_prev }`.
 *
 * `v_prev` is the across-terminal voltage `v_from − v_to` at the prior
 * tick; `i_prev` is the through-element current from `from` to `to` at
 * the prior tick. The post-solve update step (lands at Step 4(b)2 in
 * `circuits/solver.js`) MUTATES the *fresh* object returned here in
 * place to its post-tick values; freshness rule guarantees this never
 * clobbers the prev_state passed in.
 */
export class Capacitor {
  constructor({ id, value, from_node, to_node }) {
    this.id = id;
    this.value = value;
    this.from_node = from_node;
    this.to_node = to_node;
  }

  stamp(G_matrix, C_matrix, rhs_vector, t, dt, prev_state) {
    if (!(dt > 0)) {
      throw new RangeError(
        `Capacitor.stamp: dt must be positive; got ${dt}`
      );
    }
    if (prev_state == null) {
      throw new TypeError(
        `Capacitor.stamp(${this.id}): prev_state must be { v_prev, i_prev } at t=0+; got null`
      );
    }
    const C = this.value;
    const G_eq = (2 * C) / dt;
    const I_history = G_eq * prev_state.v_prev + prev_state.i_prev;
    const a = this.from_node;
    const b = this.to_node;

    // Companion-model conductance (Q9=b solver consumes G only)
    G_matrix.add(a, a, +G_eq);
    G_matrix.add(a, b, -G_eq);
    G_matrix.add(b, a, -G_eq);
    G_matrix.add(b, b, +G_eq);

    // History current source: pushes +I_history INTO `from`
    rhs_vector.add(a, +I_history);
    rhs_vector.add(b, -I_history);

    // Reference DAE-form capacitance (populated for future use /
    // diagnostic inspection; the Q9=b LU-solve does not consume it)
    C_matrix.add(a, a, +C);
    C_matrix.add(a, b, -C);
    C_matrix.add(b, a, -C);
    C_matrix.add(b, b, +C);

    // Lock #17 freshness: fresh object every call; do not mutate input.
    return { v_prev: prev_state.v_prev, i_prev: prev_state.i_prev };
  }
}

/**
 * Inductor stamped as a trapezoidal Norton companion model. Stateful:
 * `prev_state = { i_prev, v_prev }`. (Listing-order swap relative to
 * Capacitor is per Lock #15 — semantically the same two fields.)
 */
export class Inductor {
  constructor({ id, value, from_node, to_node }) {
    this.id = id;
    this.value = value;
    this.from_node = from_node;
    this.to_node = to_node;
  }

  stamp(G_matrix, C_matrix, rhs_vector, t, dt, prev_state) {
    if (!(dt > 0)) {
      throw new RangeError(
        `Inductor.stamp: dt must be positive; got ${dt}`
      );
    }
    if (prev_state == null) {
      throw new TypeError(
        `Inductor.stamp(${this.id}): prev_state must be { i_prev, v_prev } at t=0+; got null`
      );
    }
    const L = this.value;
    const G_eq = dt / (2 * L);
    const I_history = G_eq * prev_state.v_prev + prev_state.i_prev;
    const a = this.from_node;
    const b = this.to_node;

    // Companion-model conductance
    G_matrix.add(a, a, +G_eq);
    G_matrix.add(a, b, -G_eq);
    G_matrix.add(b, a, -G_eq);
    G_matrix.add(b, b, +G_eq);

    // History current source: opposite sign vs capacitor
    rhs_vector.add(a, -I_history);
    rhs_vector.add(b, +I_history);

    // Reference DAE-form inductance on the would-be branch-current row
    const bk = branchKey(this.id);
    C_matrix.add(bk, bk, -L);

    return { i_prev: prev_state.i_prev, v_prev: prev_state.v_prev };
  }
}

/**
 * Independent voltage source. MNA-augments with a branch-current
 * variable keyed by `branch:<id>`. Stateless apart from a per-stamp
 * diagnostic cache (`_last_evaluated`) populated when `value` is a
 * callable.
 *
 * Convention: `from_node` is the **positive** terminal, `to_node` is
 * the **negative** terminal; `v_from − v_to = value`.
 *
 * Phase 5.C Step 4(b)6 prep — Q4-cad=cad-1 widening (5.D-prep widening
 * sub-commit, 0c JSON
 * `expected_sub_commit_count_breakdown.five_d_prep_widening_q4_cad_cad_1`):
 * `value` MAY be either (i) a finite number — static DC source
 * preserving the prior behavior — or (ii) a function with signature
 * `(t, dt) → [v_t, v_t_plus_dt]` returning a 2-tuple of finite numbers.
 * The cad-1 lock is "single 2-tuple cadence call per tick" — both
 * endpoints fetched in ONE invocation, never two separate calls. The
 * stamp's RHS uses `v_t` (the current-tick voltage); `v_t_plus_dt` is
 * cached on `this._last_evaluated` for diagnostic readback (the
 * round-trip byte-equal regression test in `induced_current_1.scene.
 * test.js` reads this cache to verify cad-1 cadence + value
 * consistency against `runInductionCheck` independently). Tick-shape
 * compatibility with `dcOperatingPoint`: at the DC pre-solve, the
 * runner passes `dt=1` as a sentinel; callable `value` MUST tolerate
 * this (constant-EMF closures naturally do; time-varying-EMF closures
 * should compute EMF from their own time model and ignore the sentinel
 * dt's exact magnitude — the v_t answer at t=0 is what the DC solve
 * consumes; the v_t_plus_dt slot is unused by the DC stamp's RHS).
 */
export class VoltageSource {
  constructor({ id, value, from_node, to_node }) {
    this.id = id;
    this.value = value;
    this.from_node = from_node;
    this.to_node = to_node;
    // Populated by stamp() when `value` is callable; remains null for
    // static numeric sources. Read by round-trip regression tests.
    this._last_evaluated = null;
  }

  stamp(G_matrix, C_matrix, rhs_vector, t, dt, prev_state) {
    const a = this.from_node;
    const b = this.to_node;
    const bk = branchKey(this.id);

    // Q4-cad=cad-1: callable .value evaluates BOTH endpoints in a
    // single 2-tuple call. The stamp's RHS uses v_t at the current
    // tick; v_t_plus_dt is cached for diagnostic readback.
    let v_t;
    if (typeof this.value === 'function') {
      if (!Number.isFinite(t)) {
        throw new RangeError(
          `VoltageSource.stamp(${this.id}): callable .value requires finite t; got ${t}`
        );
      }
      if (!Number.isFinite(dt) || dt <= 0) {
        throw new RangeError(
          `VoltageSource.stamp(${this.id}): callable .value requires positive finite dt; got ${dt}`
        );
      }
      const tuple = this.value(t, dt);
      if (!Array.isArray(tuple) || tuple.length !== 2) {
        throw new TypeError(
          `VoltageSource.stamp(${this.id}): callable .value must return a 2-tuple [v_t, v_t_plus_dt]; got ${JSON.stringify(tuple)}`
        );
      }
      const v_at_t = tuple[0];
      const v_at_t_plus_dt = tuple[1];
      if (!Number.isFinite(v_at_t) || !Number.isFinite(v_at_t_plus_dt)) {
        throw new RangeError(
          `VoltageSource.stamp(${this.id}): callable .value tuple must contain finite numbers; got [${v_at_t}, ${v_at_t_plus_dt}]`
        );
      }
      v_t = v_at_t;
      this._last_evaluated = { t, dt, v_t: v_at_t, v_t_plus_dt: v_at_t_plus_dt };
    } else {
      v_t = this.value;
    }

    // Constraint row: v_a − v_b = V
    G_matrix.add(bk, a, +1);
    G_matrix.add(bk, b, -1);
    rhs_vector.add(bk, +v_t);

    // KCL contributions: i_VS leaves `from`, enters `to`
    G_matrix.add(a, bk, +1);
    G_matrix.add(b, bk, -1);

    return null;
  }
}

/**
 * Independent DC current source. Stateless.
 *
 * Convention: positive `value` means current of magnitude `value`
 * flows from `from_node` toward `to_node` (leaves `from`, enters `to`).
 */
export class CurrentSource {
  constructor({ id, value, from_node, to_node }) {
    this.id = id;
    this.value = value;
    this.from_node = from_node;
    this.to_node = to_node;
  }

  // eslint-disable-next-line no-unused-vars
  stamp(G_matrix, C_matrix, rhs_vector, t, dt, prev_state) {
    rhs_vector.add(this.from_node, -this.value);
    rhs_vector.add(this.to_node, +this.value);
    return null;
  }
}
