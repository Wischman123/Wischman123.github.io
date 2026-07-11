// engine/integrator.js
//
// Numerical integrators. RK4 default. Semi-implicit Euler available as a
// toggle for stiff systems. Position-Verlet (Phase C2) for symplectic
// long-run conservation.
//
// The integrator never knows what kind of force or body acts. It calls a
// single derivative function `derivState(state, t)` that returns
// dstate/dt. The caller (scene loader) constructs that derivative from
// the body/force graph. This is the extension-safety contract — new body
// types and new force types (fluids, waves, circuits in future phases)
// plug in without touching this file.
//
// State packing: each body contributes its `body.stateSize` numbers to
// the flat state array. v0 ships two stateSizes — 4 (translational
// only: [x, y, vx, vy]) and 6 (translational + rotational:
// [x, y, vx, vy, θ, ω]). Phase 3.4 (Q2=A) made stateSize per-body;
// before then, every body had stride 4. Slot ordering inside a body
// is pinned: translational FIRST, rotational APPENDED.
//
// ----- Integrator call contract -----
//
//   step(state, t, dt, derivState[, statePrev[, strides]]) -> newState
//
// The 5th parameter `statePrev` is the state vector from the previous
// step (i.e., state at t - dt). It is required only by `verletStep` and
// is ignored by `rk4Step` and `siEulerStep`. The runner (fixedDtRunner)
// always passes it; first-step bootstrap is the integrator's job (see
// verletStep below).
//
// The 6th parameter `strides` is an array of per-body slot counts
// (each entry equals the matching body's stateSize). It is required
// for `siEulerStep` and `verletStep` (which iterate per body) and
// IGNORED by `rk4Step` (which is stride-agnostic — it operates on
// the flat array uniformly). When omitted, the per-body integrators
// fall back to the v0 universal stride of 4 for backwards
// compatibility with non-rotational scenes that still pass
// strides=undefined.
//
// `fixedDtRunner` always tracks `statePrev`. The cost of holding one
// extra state-array reference is negligible; the gain is a uniform
// integrator interface.

import {
  DEFAULT_ADAPTIVE_DRIFT_BUDGET_PCT,
  DEFAULT_ADAPTIVE_DT_FLOOR_S
} from './constants.js';

const STATE_PER_BODY = 4;

// Build a default strides array for a state vector that contains only
// translational (stride=4) bodies. Used by `siEulerStep` and
// `verletStep` when the caller omits the strides argument — preserves
// the pre-Phase-3.4 behavior for legacy callers.
function _defaultStrides(stateLen) {
  const out = [];
  for (let i = 0; i < stateLen; i += STATE_PER_BODY) out.push(STATE_PER_BODY);
  return out;
}

function addArr(a, b, scale = 1) {
  const out = new Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] + scale * b[i];
  return out;
}

function rk4Step(state, t, dt, derivState /* statePrev, strides ignored */) {
  // RK4 is stride-agnostic — it operates on the flat array uniformly.
  // The deriv function (built by scene.js) is responsible for unpacking
  // per-body state slices using each body's `stateSize`. Phase 3.4
  // (Q2=A) leaves rk4Step structurally unchanged because the per-body
  // logic lives in derivState, not here.
  const k1 = derivState(state, t);
  const k2 = derivState(addArr(state, k1, dt / 2), t + dt / 2);
  const k3 = derivState(addArr(state, k2, dt / 2), t + dt / 2);
  const k4 = derivState(addArr(state, k3, dt), t + dt);
  const out = new Array(state.length);
  for (let i = 0; i < state.length; i++) {
    out[i] = state[i] + (dt / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]);
  }
  return out;
}

// Semi-implicit Euler: v_{n+1} = v_n + a(x_n) dt; x_{n+1} = x_n + v_{n+1} dt.
// Symplectic — conserves energy on average over long runs better than
// explicit Euler. Used for stiff systems where RK4's per-step accuracy
// is overkill.
//
// Phase 3.4 (Q2=A): per-body stride. For translational stride=4 the
// pattern is unchanged. For rotational stride=6 the (θ, ω) pair gets
// the same semi-implicit update — ω_{n+1} = ω_n + α·dt (where α is the
// state-derivative slot 5 = τ/I), then θ_{n+1} = θ_n + ω_{n+1}·dt.
function siEulerStep(state, t, dt, derivState, _statePrev, strides) {
  const k = derivState(state, t);
  const out = new Array(state.length);
  const _strides = strides ?? _defaultStrides(state.length);
  let b = 0;
  for (let i = 0; i < _strides.length; i++) {
    const stride = _strides[i];
    // Translational position-velocity pair (slots 0-3).
    const vxNew = state[b + 2] + k[b + 2] * dt;
    const vyNew = state[b + 3] + k[b + 3] * dt;
    out[b]     = state[b]     + vxNew * dt;
    out[b + 1] = state[b + 1] + vyNew * dt;
    out[b + 2] = vxNew;
    out[b + 3] = vyNew;
    if (stride === 6) {
      // Rotational (θ, ω) pair (slots 4-5). Same semi-implicit update
      // structure as the translational pair: update ω first from
      // angular acceleration, then θ from the updated ω.
      const omegaNew = state[b + 5] + k[b + 5] * dt;
      out[b + 4] = state[b + 4] + omegaNew * dt;
      out[b + 5] = omegaNew;
    }
    b += stride;
  }
  return out;
}

// Position-Verlet (Störmer-Verlet):
//   x_{n+1} = 2 x_n - x_{n-1} + a_n dt²
//   v_n     = (x_{n+1} - x_{n-1}) / (2 dt)        [centered velocity]
//
// Symplectic, time-reversible, O(dt²) global error. Energy drift is
// bounded over arbitrarily long runs (no secular growth) — that's the
// motivating property for the spring-oscillator canary scenario.
//
// Phase 3.4 (Q2=A): per-body stride. For stride=6 the (θ, ω) pair
// follows the same Verlet recurrence as (x, vx) — θ_{n+1} = 2θ_n -
// θ_{n-1} + α·dt², centered ω = (θ_{n+1} - θ_{n-1}) / (2 dt).
//
// Bootstrap (statePrev === null on the first step). Synthesize x_{-1}
// from the initial condition (x_0, v_0) via Taylor back-step:
//   x_{-1} = x_0 - v_0 dt + ½ a_0 dt²
// This makes the first step self-starting and matches velocity-Verlet
// exactly on step 1; the staggered-velocity convention takes over from
// step 2 onward.
//
// Velocity reporting: the output state stores v_n (centered at time t,
// i.e., one step BEHIND the output position x_{n+1} which is at
// t + dt). This is the standard Verlet convention; it gives the most
// accurate velocity estimate available and matches how energy bookkeeping
// is conventionally done in symplectic schemes. The half-step time
// staggering is bounded and does not accumulate.
function verletStep(state, t, dt, derivState, statePrev = null, strides) {
  const k = derivState(state, t);
  const out = new Array(state.length);
  const dt2 = dt * dt;
  const _strides = strides ?? _defaultStrides(state.length);
  let b = 0;
  for (let i = 0; i < _strides.length; i++) {
    const stride = _strides[i];
    const x = state[b];
    const y = state[b + 1];
    const vx = state[b + 2];
    const vy = state[b + 3];
    const ax = k[b + 2];
    const ay = k[b + 3];

    let xPrev, yPrev;
    if (statePrev) {
      xPrev = statePrev[b];
      yPrev = statePrev[b + 1];
    } else {
      // Bootstrap convention (see comment block above).
      xPrev = x - vx * dt + 0.5 * ax * dt2;
      yPrev = y - vy * dt + 0.5 * ay * dt2;
    }

    const xNew = 2 * x - xPrev + ax * dt2;
    const yNew = 2 * y - yPrev + ay * dt2;

    // Centered velocity at time t (one step behind the new position).
    const vxOut = (xNew - xPrev) / (2 * dt);
    const vyOut = (yNew - yPrev) / (2 * dt);

    out[b]     = xNew;
    out[b + 1] = yNew;
    out[b + 2] = vxOut;
    out[b + 3] = vyOut;

    if (stride === 6) {
      // Rotational (θ, ω) pair. Same Verlet recurrence as (x, vx).
      const theta = state[b + 4];
      const omega = state[b + 5];
      const alpha = k[b + 5];
      let thetaPrev;
      if (statePrev) {
        thetaPrev = statePrev[b + 4];
      } else {
        thetaPrev = theta - omega * dt + 0.5 * alpha * dt2;
      }
      const thetaNew = 2 * theta - thetaPrev + alpha * dt2;
      const omegaOut = (thetaNew - thetaPrev) / (2 * dt);
      out[b + 4] = thetaNew;
      out[b + 5] = omegaOut;
    }
    b += stride;
  }
  return out;
}

export function makeIntegrator(name) {
  switch (name) {
    case 'rk4': return rk4Step;
    case 'semi_implicit_euler': return siEulerStep;
    case 'verlet': return verletStep;
    default: throw new Error(`Unknown integrator "${name}"`);
  }
}

// Fixed-dt runner. Every committed scene uses this (all `adaptive_dt:false`),
// so its output is the byte-identity baseline the round-trip / band suites
// pin. sim_oracle_fidelity Phase P3 added `adaptiveDtRunner` below as the
// SEPARATE opt-in path; this one is deliberately left untouched.
//
// Always tracks `statePrev` and passes it as the 5th argument to the
// integrator. RK4 / sIEuler ignore it; Verlet uses it (with bootstrap
// on the first step when statePrev === null).
//
// Phase 3.4 (Q2=A): `strides` is passed as the 6th argument so per-
// body integrators (siEuler, verlet) can iterate variable-length state
// blocks. Defaults to undefined when omitted — the integrator falls
// back to a uniform stride of 4 for backward compatibility.
export function fixedDtRunner({ integrator, derivState, dt, duration, state0, onSnapshot, strides }) {
  let state = state0;
  let statePrev = null;
  let t = 0;
  if (onSnapshot) onSnapshot(state, t);
  // Use a deterministic step count to avoid floating-point accumulation
  // in the loop guard (t < duration could miss the final step or take
  // an extra one).
  const steps = Math.round(duration / dt);
  for (let i = 0; i < steps; i++) {
    const newState = integrator(state, t, dt, derivState, statePrev, strides);
    statePrev = state;
    state = newState;
    t += dt;
    if (onSnapshot) onSnapshot(state, t);
  }
  return { state, t };
}

// ---------------------------------------------------------------------------
// Adaptive-dt runner (sim_oracle_fidelity Phase P3)
// ---------------------------------------------------------------------------
//
// Same call contract as `fixedDtRunner` plus `{ driftBudgetPct, dtFloor }`.
// Turns the wired-but-inactive adaptive path ON. Selected by the CLI only
// when `simulation.adaptive_dt === true`; every committed scene stays on the
// fixed runner (F3: `SimRunner` in the browser still fixed-steps, so an
// adaptive REGISTERED scene would diverge CLI-vs-browser and break the round-
// trip set — no registered scene is adaptive; the Phase-P3 unit test drives a
// NON-registry scene straight into this function, avoiding that entirely).
//
// INTEGRATOR RESTRICTION. This runner is valid ONLY for `rk4` and
// `semi_implicit_euler` — both self-starting and tolerant of a step size that
// changes between steps. `verlet` is REJECTED at LOAD (scene.schema.json
// if/then + validate_scene_browser.js), never here: its recurrence
// `x_{n+1} = 2x_n − x_{n−1} + a·dt²` is only correct for UNIFORM spacing, and
// the step-doubling estimator below restarts each trial with statePrev=null —
// which rk4/sIEuler ignore but verlet would silently mis-handle. The
// load-time rejection is the guard; this comment is why.
//
// CONTROL LAW — LOCAL error, not cumulative energy drift.
//   * Estimate the LOCAL (this-step) error by STEP-DOUBLING (Richardson):
//     take one step of size h, and two steps of size h/2, from the SAME
//     start; the max-abs state difference, divided by the state's own
//     magnitude scale, is a per-step error that tracks the ANSWER (position/
//     velocity), not merely energy. We COMMIT the more-accurate two-half-step
//     result. This is deliberately NOT energy.js `conservationDriftPct`,
//     which is cumulative-from-first-snapshot and cannot bound a single step.
//   * If that per-step error exceeds `driftBudgetPct`, HALVE h and re-estimate.
//     Stop halving at `dtFloor` (the stiffness floor): if still over budget
//     there, accept the floor step and record a `floorHits`.
//   * dt GROWTH with hysteresis (a deadband so dt does not thrash halve→grow→
//     halve): the dt to TRY next step, `hNext`, grows toward the base ceiling
//     ONLY when this step's error sat comfortably below budget
//     (≤ budget × GROW_DEADBAND_FRAC = budget/4); otherwise `hNext` HOLDS at
//     the accepted h. The growth factor is calculated (not guessed) so a
//     grow can never overshoot into a reject: growing from ≤budget/4 by
//     GROWTH_FACTOR raises the local error by at most GROWTH_FACTOR^p (p ≤ 5,
//     RK4's local-error order); GROWTH_FACTOR = 1.25 gives 1.25^5 ≈ 3.05 < 4,
//     so the grown error stays ≤ (budget/4)·3.05 ≈ 0.76·budget < budget — the
//     grown step is accepted first try, so a smooth segment never halves →
//     never thrashes.
//
// ENDPOINT + SNAPSHOTS under variable steps. The FINAL step is clamped to land
// exactly on `duration` (needed for final-state byte-identity and for a
// numeric `at ≤ duration_s` read to interpolate). That clamped step is STILL
// budget-checked. Because the clamp is a one-off bookkeeping shrink (there is
// no next step after it), it does NOT drive the growth machine and is EXCLUDED
// from `minDtReached` (which must reflect stiffness, not the endpoint). Step
// COUNT is data-dependent, so `onSnapshot` is called once per COMMITTED step
// (state, t, hUsed) — the 3rd arg hands the caller the actual dt used, letting
// a per-step energy/dissipation integral use the true step size instead of a
// fixed dt. Callers that emit a fixed number of evenly spaced frames must
// stride by TIME, not step index (step index is no longer uniform).
//
// READOUT. Returns `{ state, t, stiffness: { minDtReached, floorHits,
// maxStepDriftPct } }`. `maxStepDriftPct` is the worst per-step LOCAL error
// observed (the same step-doubling proxy) — above `driftBudgetPct` it means
// the scene was stiffer than the floor allowed. The CLI attaches this
// `stiffness` block to its CLI-ONLY diagnostics via the `out = {...canonical}`
// spread — NOT through `serializeState` (that would change the canonical
// shape and break byte-identity).
//
// Field names here (minDtReached / floorHits / maxStepDriftPct / driftBudgetPct
// / dtFloor) are deliberately outside the anti-Kohn FORBIDDEN vocabulary.

// showcase:excerpt=adaptive_dt_controller start
// Calculated controller constants (see the CONTROL LAW note above).
const GROWTH_FACTOR = 1.25;      // 1.25^5 ≈ 3.05 < 4 ⇒ grow-from-(budget/4) never rejects
const GROW_DEADBAND_FRAC = 0.25; // grow only when errPct ≤ budget × this
const STATE_SCALE_FLOOR = 1e-12; // guard the relative-error denominator near a zero state

export function adaptiveDtRunner({
  integrator, derivState, dt, duration, state0, onSnapshot, strides,
  driftBudgetPct, dtFloor
}) {
  const budgetPct = driftBudgetPct ?? DEFAULT_ADAPTIVE_DRIFT_BUDGET_PCT;
  const baseDt = dt;                       // the ceiling: adaptive never steps larger
  let floor = dtFloor ?? DEFAULT_ADAPTIVE_DT_FLOOR_S;
  if (floor > baseDt) floor = baseDt;      // a floor above the ceiling is degenerate
  const END_EPS = Math.max(Math.abs(duration), 1) * 1e-12;

  // Step-doubling LOCAL error estimate for a trial step of size h from
  // (state, t). Returns the committed (two-half-step) state and the per-step
  // error as a percent of the state's own magnitude. statePrev is passed as
  // null: rk4/sIEuler ignore it, and verlet never reaches this runner.
  const estimate = (state, t, h) => {
    const full = integrator(state, t, h, derivState, null, strides);
    const mid = integrator(state, t, h / 2, derivState, null, strides);
    const half2 = integrator(mid, t + h / 2, h / 2, derivState, null, strides);
    let maxDiff = 0;
    let scale = 0;
    for (let i = 0; i < state.length; i++) {
      const d = Math.abs(full[i] - half2[i]);
      if (d > maxDiff) maxDiff = d;
      const s = Math.max(Math.abs(state[i]), Math.abs(half2[i]));
      if (s > scale) scale = s;
    }
    const denom = scale > STATE_SCALE_FLOOR ? scale : STATE_SCALE_FLOOR;
    return { state: half2, errPct: (100 * maxDiff) / denom };
  };

  let state = state0;
  let t = 0;
  let hNext = baseDt;             // dt to TRY next step; grows toward baseDt, never above
  let minDtReached = baseDt;
  let maxStepDriftPct = 0;
  let floorHits = 0;

  if (onSnapshot) onSnapshot(state, t);

  while (duration - t > END_EPS) {
    const remaining = duration - t;
    let h = Math.min(hNext, remaining);
    const clampedToEnd = h < hNext - END_EPS; // final-step clamp shrank the try

    // Accept loop: halve until within budget or pinned at the floor.
    let res = estimate(state, t, h);
    while (res.errPct > budgetPct && h > floor * (1 + 1e-9)) {
      h = Math.max(h / 2, floor);
      res = estimate(state, t, h);
    }
    let pinnedAtFloor = false;
    if (res.errPct > budgetPct) {
      // Could not meet budget even at the floor — accept the floor step and
      // flag the scene as floor-pinned (stiffer than the floor allows).
      pinnedAtFloor = true;
      floorHits++;
    }

    state = res.state;
    t += h;
    // minDtReached reflects STIFFNESS, so exclude the one-off endpoint clamp.
    if (!clampedToEnd && h < minDtReached) minDtReached = h;
    if (res.errPct > maxStepDriftPct) maxStepDriftPct = res.errPct;

    if (onSnapshot) onSnapshot(state, t, h);

    // Growth / hysteresis for the NEXT step. The end-clamp has no successor,
    // so it never drives growth.
    if (!clampedToEnd) {
      if (!pinnedAtFloor && res.errPct <= budgetPct * GROW_DEADBAND_FRAC) {
        hNext = Math.min(h * GROWTH_FACTOR, baseDt); // room to spare: grow toward base
      } else {
        hNext = h;                                   // deadband or floor-pinned: hold
      }
    }
  }

  return { state, t, stiffness: { minDtReached, floorHits, maxStepDriftPct } };
}
// showcase:excerpt=adaptive_dt_controller end

export const STATE_STRIDE = STATE_PER_BODY;
export const NAME = 'integrator';
