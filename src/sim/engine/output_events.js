// engine/output_events.js
//
// Shared sub-step machinery for the `outputs[].at` selector
// (sim_oracle_fidelity Phase P1). This is the LIBRARY layer that both the
// headless CLI (via serializeState/resolveOutput in scene.js) and the
// browser's bounded probe consume — no per-scene logic lives in scene.js.
//
// Three pieces ship here:
//
//   1. TrajectoryRecorder — records a DENSE (every-dt) trajectory while a
//      scene runs, keyed by body id. Built ONLY when a scene declares at
//      least one `outputs[].at` (sceneHasAtOutputs); otherwise nothing is
//      recorded and the serialized output is byte-identical to today.
//
//   2. interpolateAt(recorder, t, body_id, quantity) — resolves the value
//      of a body quantity at an arbitrary instant t within the recorded
//      window. Quantity-aware (position uses cubic-Hermite on the
//      SYNCHRONIZED velocity; theta unwraps first; velocity/omega use a
//      documented lower-order linear read). Produces exactly what
//      resolveOutput() returns for a final-state read, one instant earlier.
//
//   3. PREDICATES — the registry of event-predicate identifiers whose
//      SOLVERS Phase P2 fills in. P1 ships the KEYS only (so the schema ↔
//      solver lockstep test has a source of truth); a string/object `at`
//      selector THROWS PredicateNotYetSupportedError in P1 rather than
//      silently reading the final state.
//
// Verdict/diagnostic vocabulary here is deliberately neutral (no
// score/points/level/correct/... per the anti-Kohn render contract).

// ----- Error taxonomy -----------------------------------------------------
//
// All three route through the CLI's serializeState try/catch to a hard
// die(5) (no state.json). They are distinct classes so the catch site — and
// P2's predicate solvers — can tell WHICH resolution path refused.

/** Base class for every `outputs[].at` resolution failure. */
export class OutputResolutionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OutputResolutionError';
  }
}

/**
 * Thrown when `out.at` is a predicate (a string enum identifier or a
 * parameterized object). P1 lands the schema surface + the recorder; the
 * predicate SOLVERS are P2's job. This NEVER falls through to a final-state
 * read — that would silently answer an `at:"apex"` request with the last
 * frame (the intermediate-merge hazard the plan closes).
 */
export class PredicateNotYetSupportedError extends OutputResolutionError {
  constructor(at, quantity) {
    const shown = typeof at === 'string' ? `"${at}"` : JSON.stringify(at);
    super(
      `output "${quantity}" uses an event-predicate selector at=${shown}, ` +
      `whose solver is not yet implemented in this build (Phase P2). ` +
      `The recorder refuses to fall through to a final-state read.`
    );
    this.name = 'PredicateNotYetSupportedError';
    this.at = at;
    this.quantity = quantity;
  }
}

/**
 * Thrown when a numeric `at` is not a finite number inside the simulated
 * window [0, duration_s]. JSON Schema cannot express the cross-field
 * `at <= duration_s` bound, so it is a runtime check here.
 */
export class AtOutOfRangeError extends OutputResolutionError {
  constructor(at, quantity, detail) {
    super(`output "${quantity}" has an out-of-range numeric selector: ${detail} (at=${JSON.stringify(at)}).`);
    this.name = 'AtOutOfRangeError';
    this.at = at;
    this.quantity = quantity;
  }
}

/**
 * Thrown when a GLOBAL `energy.*` output carries an `at`. Whole-system
 * interpolation (re-derive the system quantity from every body's state at
 * t*) is a distinct code path DEFERRED out of P1 — the live output
 * vocabulary has no per-body K, so there is no per-body interpolation that
 * maps to an energy output. Refusing (rather than reading final energy) is
 * the same intermediate-merge safety as the predicate case.
 */
export class EnergyAtNotSupportedError extends OutputResolutionError {
  constructor(quantity) {
    super(
      `output "${quantity}" is a whole-system energy quantity with an "at" selector; ` +
      `energy.* + at (whole-system interpolation) is deferred and not resolved in this build.`
    );
    this.name = 'EnergyAtNotSupportedError';
    this.quantity = quantity;
  }
}

/**
 * Thrown (Phase P2) when an event-predicate selector — apex / first_return /
 * vx_zero / contact / charge_fraction — has NO qualifying crossing anywhere
 * in the simulated window [0, duration_s]: the solver returned its `null`
 * sentinel. This is a GENUINE never-occurs (a body thrown downward has no
 * apex; a body whose v_x never reverses has no vx_zero; a projectile whose
 * return lands past duration_s never re-crosses), NOT a resolution gap —
 * routing it to the SAME die(5) catch as the other OutputResolutionErrors
 * keeps the "never silently answer an event request with the final frame"
 * guarantee. Distinct class from AtOutOfRangeError so the CLI message can name
 * the predicate and the quantity. Notation on the message stays neutral
 * (no score/level/correct vocabulary — anti-Kohn render contract).
 */
export class EventNeverOccurredError extends OutputResolutionError {
  constructor(quantity, predicate) {
    super(
      `output "${quantity}" selects the event predicate "${predicate}", but that ` +
      `event never occurs within the simulated window [0, duration_s] ` +
      `(no qualifying crossing was recorded). state.json is not written.`
    );
    this.name = 'EventNeverOccurredError';
    this.quantity = quantity;
    this.predicate = predicate;
  }
}

// ----- Predicate registry (F14 — single source of truth) ------------------
//
// The set of allowed selector identifiers is the UNION of:
//   - parameter_free keys  -> the schema's string-enum `at`
//   - parameterized keys   -> the schema's object `at.event` enum
// and MUST equal Object.keys(PREDICATES). The schema ↔ browser ↔ registry
// lockstep is pinned by output_events.test.js. Phase P2 attaches the `solve`
// bracket-and-refine to each entry (P1 shipped `solve: null`); a 6th predicate
// is a one-object addition here + one schema/browser enum entry, and the
// lockstep test build-catches any drift. `needsTarget` / `needsFraction` mark
// the parameterized entries whose object selector carries a required field —
// the caller (scene.js resolveOutputAt) validates it before calling `solve`.
//
// Solver contract: solve(ctx, out) -> t* (a number, the sub-step instant) or
// null (the genuine no-crossing sentinel; the caller converts null into a
// thrown EventNeverOccurredError). The solvers + their crossing helpers live
// in the "Event-predicate solvers" section below (function declarations are
// hoisted, so the registry may reference them here).

export const PREDICATES = {
  // Parameter-free identifiers (schema string enum).
  apex:            { kind: 'parameter_free', params: [], solve: solveApex },
  first_return:    { kind: 'parameter_free', params: [], solve: solveFirstReturn },
  vx_zero:         { kind: 'parameter_free', params: [], solve: solveVxZero },
  // Parameterized identifiers (schema object `event` enum).
  contact:         { kind: 'parameterized', params: ['target'],   needsTarget: true,   solve: solveContact },
  charge_fraction: { kind: 'parameterized', params: ['fraction'], needsFraction: true, solve: solveChargeFraction }
};

/** Identifiers carried as a bare `at` string (parameter-free predicates). */
export function parameterFreePredicateIds() {
  return Object.keys(PREDICATES).filter((k) => PREDICATES[k].kind === 'parameter_free');
}

/** Identifiers carried as `at.event` on a parameterized predicate object. */
export function parameterizedPredicateIds() {
  return Object.keys(PREDICATES).filter((k) => PREDICATES[k].kind === 'parameterized');
}

// ----- Scene gate ---------------------------------------------------------

/**
 * True iff any output declares an `at` selector. The recorder is built (and
 * fed) ONLY for such scenes; every scene that omits `at` records nothing and
 * serializes byte-identically to today.
 */
export function sceneHasAtOutputs(scene) {
  return (scene?.outputs ?? []).some((o) => o && o.at !== undefined);
}

// ----- Trajectory recorder ------------------------------------------------

/**
 * Records a dense per-dt trajectory, keyed by body id.
 *
 * The recorder UNPACKS the raw packed-state array itself (via offsets +
 * strides) at every step — it must NOT read loaded.bodies, which is stale
 * between snapshot steps for plain scenes (the F9 stale-state hazard).
 *
 * Velocity SYNCHRONIZATION (F6 / Q1). rk4 stores position and velocity
 * co-located, so its raw stored velocity IS synchronized. verlet stores a
 * CENTERED velocity that lags position by a full dt, and semi_implicit_euler
 * is likewise not the clean co-located pair — for both, the recorder
 * recomputes a co-located velocity by central-differencing the recorded
 * positions (O(dt^2)); node 0 uses the exact initial velocity (every
 * integrator reports the true IC there) and the last node a 2nd-order
 * backward difference. This synchronized velocity is what interpolateAt
 * reads AND what the F6 exit-gate assertion checks.
 */
export class TrajectoryRecorder {
  constructor({ bodyIds, offsets, strides, integrator, dt }) {
    if (!Array.isArray(bodyIds) || bodyIds.length === 0) {
      throw new Error('TrajectoryRecorder: bodyIds must be a non-empty array');
    }
    this.bodyIds = bodyIds.slice();
    this.offsets = offsets.slice();
    this.strides = strides.slice();
    this.integrator = integrator;
    this.dt = dt;
    this.times = [];
    // Raw per-body arrays (velocity as-stored; may lag for symplectic
    // integrators). theta/omega present only for stride-6 bodies.
    this._raw = new Map();
    for (const id of this.bodyIds) {
      this._raw.set(id, { x: [], y: [], vx: [], vy: [], theta: [], omega: [], rotational: false });
    }
    this._synced = null; // memoized synchronized view (invalidated on record)
  }

  get length() {
    return this.times.length;
  }

  /** Record one dense step from the RAW packed state array. */
  record(state, t) {
    this.times.push(t);
    for (let i = 0; i < this.bodyIds.length; i++) {
      const off = this.offsets[i];
      const stride = this.strides[i];
      const r = this._raw.get(this.bodyIds[i]);
      r.x.push(state[off]);
      r.y.push(state[off + 1]);
      r.vx.push(state[off + 2]);
      r.vy.push(state[off + 3]);
      if (stride === 6) {
        r.rotational = true;
        r.theta.push(state[off + 4]);
        r.omega.push(state[off + 5]);
      }
    }
    this._synced = null;
  }

  _ensureSynced() {
    if (this._synced) return this._synced;
    const dt = this.dt;
    const synced = new Map();
    for (const id of this.bodyIds) {
      const r = this._raw.get(id);
      const view = {
        t: this.times,
        x: r.x,
        y: r.y,
        vx: syncVelocity(r.x, r.vx, this.integrator, dt),
        vy: syncVelocity(r.y, r.vy, this.integrator, dt),
        rotational: r.rotational
      };
      if (r.rotational) {
        // theta must be UNWRAPPED before interpolating; naive interpolation
        // across a 2*pi discontinuity produces garbage (named edge case).
        const theta = unwrapAngles(r.theta);
        view.theta = theta;
        view.omega = syncVelocity(theta, r.omega, this.integrator, dt);
      }
      synced.set(id, view);
    }
    this._synced = synced;
    return synced;
  }

  /** True iff a trajectory was recorded for `bodyId` (used by the contact
   *  solver to decide whether a predicate `target` names a body or a surface). */
  hasBody(bodyId) {
    return this._raw.has(bodyId);
  }

  /** Synchronized, unwrapped per-body trajectory view (what interpolateAt reads). */
  trajectoryFor(bodyId) {
    const view = this._ensureSynced().get(bodyId);
    if (!view) throw new Error(`TrajectoryRecorder: no recorded trajectory for body_id "${bodyId}"`);
    return view;
  }

  /**
   * Raw (un-synchronized) stored velocity arrays. Exposed for the F6 exit
   * gate, which asserts the SYNCHRONIZED velocity — not this raw one, which
   * lags a full dt for verlet/semi_implicit_euler.
   */
  rawVelocityFor(bodyId) {
    const r = this._raw.get(bodyId);
    if (!r) throw new Error(`TrajectoryRecorder: no recorded trajectory for body_id "${bodyId}"`);
    return { vx: r.vx.slice(), vy: r.vy.slice(), omega: r.omega.slice() };
  }
}

// Co-located velocity array for the position samples `pos`. See the
// TrajectoryRecorder class doc for the per-integrator rationale.
function syncVelocity(pos, rawVel, integrator, dt) {
  if (integrator === 'rk4') return rawVel.slice();
  const n = pos.length;
  if (n === 0) return [];
  if (n === 1) return rawVel.slice();
  const out = new Array(n);
  out[0] = rawVel[0]; // node 0: exact initial condition (all integrators)
  for (let i = 1; i < n - 1; i++) {
    out[i] = (pos[i + 1] - pos[i - 1]) / (2 * dt);
  }
  out[n - 1] = n >= 3
    ? (3 * pos[n - 1] - 4 * pos[n - 2] + pos[n - 3]) / (2 * dt) // O(dt^2) backward
    : (pos[n - 1] - pos[n - 2]) / dt;                          // n===2 fallback
  return out;
}

// Add multiples of 2*pi so consecutive samples never jump by more than pi —
// makes an accumulating angle continuous for interpolation.
function unwrapAngles(theta) {
  const out = new Array(theta.length);
  if (theta.length === 0) return out;
  out[0] = theta[0];
  let offset = 0;
  for (let i = 1; i < theta.length; i++) {
    let d = theta[i] - theta[i - 1];
    while (d > Math.PI) { offset -= 2 * Math.PI; d -= 2 * Math.PI; }
    while (d < -Math.PI) { offset += 2 * Math.PI; d += 2 * Math.PI; }
    out[i] = theta[i] + offset;
  }
  return out;
}

// ----- Interpolation ------------------------------------------------------

/**
 * Value of `quantity` for `bodyId` at instant `t`, from the recorded dense
 * trajectory. `recorder` is a TrajectoryRecorder (the "trajectory").
 *
 * Method by quantity:
 *   position.x / position.y : cubic-Hermite (position + SYNCHRONIZED
 *                             velocity slopes) -> O(dt^4) local, beats a
 *                             linear read; exact for a co-located rk4 feed.
 *   theta                   : cubic-Hermite on the UNWRAPPED angle (omega
 *                             slopes). Returns the continuous (un-rewrapped)
 *                             value, matching a final-state theta read.
 *   velocity.x / velocity.y : LINEAR (documented lower order than position;
 *                             O(dt^2) on the dense grid — well inside band —
 *                             and keeps the recorder free of any derivState
 *                             side effect on loaded.bodies).
 *   omega                   : LINEAR (same rationale).
 *
 * The caller (resolveOutput) is responsible for the [0, duration_s] range
 * check; t values slightly past the ends (float) clamp to the end node.
 */
export function interpolateAt(recorder, t, bodyId, quantity) {
  const traj = recorder.trajectoryFor(bodyId);
  const times = traj.t;
  const n = times.length;
  if (n === 0) throw new Error(`interpolateAt: empty trajectory for body_id "${bodyId}"`);
  if (t <= times[0]) return sampleAtNode(traj, 0, quantity, bodyId);
  if (t >= times[n - 1]) return sampleAtNode(traj, n - 1, quantity, bodyId);

  const i = bracketIndex(times, t);
  const t0 = times[i];
  const t1 = times[i + 1];

  switch (quantity) {
    case 'position.x':
      return cubicHermite(t, t0, t1, traj.x[i], traj.x[i + 1], traj.vx[i], traj.vx[i + 1]);
    case 'position.y':
      return cubicHermite(t, t0, t1, traj.y[i], traj.y[i + 1], traj.vy[i], traj.vy[i + 1]);
    case 'velocity.x':
      return lerp(t, t0, t1, traj.vx[i], traj.vx[i + 1]);
    case 'velocity.y':
      return lerp(t, t0, t1, traj.vy[i], traj.vy[i + 1]);
    case 'theta':
      requireRotational(traj, bodyId, quantity);
      return cubicHermite(t, t0, t1, traj.theta[i], traj.theta[i + 1], traj.omega[i], traj.omega[i + 1]);
    case 'omega':
      requireRotational(traj, bodyId, quantity);
      return lerp(t, t0, t1, traj.omega[i], traj.omega[i + 1]);
    default:
      throw new Error(
        `interpolateAt: unsupported quantity "${quantity}" ` +
        `(expected position.x|position.y|velocity.x|velocity.y|theta|omega)`
      );
  }
}

function sampleAtNode(traj, i, quantity, bodyId) {
  switch (quantity) {
    case 'position.x': return traj.x[i];
    case 'position.y': return traj.y[i];
    case 'velocity.x': return traj.vx[i];
    case 'velocity.y': return traj.vy[i];
    case 'theta': requireRotational(traj, bodyId, quantity); return traj.theta[i];
    case 'omega': requireRotational(traj, bodyId, quantity); return traj.omega[i];
    default:
      throw new Error(
        `interpolateAt: unsupported quantity "${quantity}" ` +
        `(expected position.x|position.y|velocity.x|velocity.y|theta|omega)`
      );
  }
}

function requireRotational(traj, bodyId, quantity) {
  if (!traj.rotational) {
    throw new Error(`interpolateAt: body "${bodyId}" has no rotational state for quantity "${quantity}"`);
  }
}

function bracketIndex(times, t) {
  // Largest index i in [0, n-2] with times[i] <= t. Binary search — the
  // recorded times are ascending but not perfectly uniform (fp accumulation).
  let lo = 0;
  let hi = times.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid; else hi = mid;
  }
  return lo;
}

function cubicHermite(t, t0, t1, p0, p1, m0, m1) {
  const h = t1 - t0;
  if (h <= 0) return p0;
  const s = (t - t0) / h;
  const s2 = s * s;
  const s3 = s2 * s;
  const h00 = 2 * s3 - 3 * s2 + 1;
  const h10 = s3 - 2 * s2 + s;
  const h01 = -2 * s3 + 3 * s2;
  const h11 = s3 - s2;
  // Tangents are scaled by the interval width h (Hermite on a non-unit interval).
  return h00 * p0 + h10 * h * m0 + h01 * p1 + h11 * h * m1;
}

function lerp(t, t0, t1, v0, v1) {
  const h = t1 - t0;
  if (h <= 0) return v0;
  const s = (t - t0) / h;
  return v0 + s * (v1 - v0);
}

// ----- Event-predicate solvers (Phase P2) ---------------------------------
//
// Each PREDICATES[*].solve is a PURE bracket-and-refine:
//   solve(ctx, out) -> t*  (a number, the sub-step instant), or null.
// `null` is the "no qualifying crossing over [0, duration_s]" sentinel; the
// caller (scene.js resolveOutputAt) converts null into a thrown
// EventNeverOccurredError routed to the CLI die(5) catch. A returned t* is a
// REAL instant inside the recorded window; the caller then interpolates the
// output quantity there through the SAME path a numeric `at` uses — no
// per-predicate output logic downstream.
//
// `ctx` (the "trajectory" bundle scene.js assembles from `loaded`):
//   { recorder, surfaces, bodyRadii, chargeSeries }
// The solvers touch ONLY these — no scene.js / `loaded` dependency — so each
// is unit-tested against a synthetic recorder or an analytic series.
//
// BOUNDARY (F10): the recorder captures a node at every dt INCLUDING t=0 and
// t=duration_s (fixedDtRunner snapshots both ends), so a crossing in the last
// interval [duration_s − dt, duration_s] is an ordinary bracket found by the
// scans below and is VALID — the null sentinel is reserved for a genuine
// no-sign-change across the whole recorded window.

// apex: the FIRST instant velocity.y goes + -> - (rising to falling — the
// first maximum height). A bouncing trajectory has several downgoing v_y
// crossings; we return the FIRST. v_y == 0 exactly at a recorded node is the
// crossing instant (a v_y[i]*v_y[i+1] < 0 product test yields 0, not < 0, and
// would silently miss it — the named edge case); includeStartZero also lets a
// horizontally-launched apex resolve at t=0.
function solveApex(ctx, out) {
  const tr = ctx.recorder.trajectoryFor(out.body_id);
  return firstDowngoingZero(tr.t, tr.vy, { includeStartZero: true });
}

// first_return: the first t > 0 where position.y re-crosses its t=0 value
// going DOWN (the body rose above the start height and fell back through it).
// The t=0 sample is g = 0 by construction and is NOT a return (includeStartZero
// stays false, so it is skipped); a body that only ever descends never rose,
// g is never strictly positive, and no downgoing crossing exists -> null.
function solveFirstReturn(ctx, out) {
  const tr = ctx.recorder.trajectoryFor(out.body_id);
  const y0 = tr.y[0];
  const g = tr.y.map((yi) => yi - y0);
  return firstDowngoingZero(tr.t, g);
}

// vx_zero: the first sign change of velocity.x (either direction). v_x == 0
// exactly at a node between opposite-signed neighbours is the crossing instant.
// A body whose v_x never reverses (constant horizontal velocity) -> null.
function solveVxZero(ctx, out) {
  const tr = ctx.recorder.trajectoryFor(out.body_id);
  return firstSignChange(tr.t, tr.vx);
}

// contact: the first instant the body's signed gap to the REQUIRED `target`
// crosses zero from OUTSIDE (gap > 0, approaching). `target` is a surface_id
// (reuse Surface.signedDistance geometry — positive OUTSIDE/above) or a body_id
// (centre-to-centre distance minus the summed contact radii). Never within
// contact over the window -> null.
function solveContact(ctx, out) {
  const tr = ctx.recorder.trajectoryFor(out.body_id);
  const g = contactGapSeries(ctx, out, tr);
  return firstDowngoingZero(tr.t, g);
}

// charge_fraction: the first instant the tracked charge reaches `fraction` of
// its observed swing (q0 -> q_final) over the run, reading the per-step charge
// series the recorder captured (the same diagnostics channel serializeState
// serializes). `fraction` is of the OBSERVED swing (the engine has no closed-
// form asymptote), so any fraction in (0, 1] on a monotone series fires and a
// fraction the series never attains (e.g. > 1 of the swing) -> null. Absent a
// recorded charge channel (no current scene records one), the resolution is
// unavailable -> null, which the caller routes to the same die(5) path rather
// than ever reading the final frame.
function solveChargeFraction(ctx, out) {
  const series = ctx.chargeSeries;
  if (!series || !Array.isArray(series.t) || series.t.length === 0) return null;
  const fraction = out.at.fraction;
  const q0 = series.q[0];
  const qFinal = series.q[series.q.length - 1];
  const level = q0 + fraction * (qFinal - q0);
  const g = series.q.map((qi) => qi - level);
  return firstSignChange(series.t, g);
}

// Signed gap of the output body to the contact target, sampled per recorded
// node. Surface target uses Surface.signedDistance; body target uses the
// centre gap minus the summed radii.
function contactGapSeries(ctx, out, tr) {
  const target = out.at.target;
  const surface = ctx.surfaces && typeof ctx.surfaces.get === 'function'
    ? ctx.surfaces.get(target)
    : null;
  if (surface && typeof surface.signedDistance === 'function') {
    return tr.x.map((x, i) => surface.signedDistance({ x, y: tr.y[i] }));
  }
  if (ctx.recorder.hasBody(target)) {
    const other = ctx.recorder.trajectoryFor(target);
    const rSelf = (ctx.bodyRadii && ctx.bodyRadii.get(out.body_id)) || 0;
    const rOther = (ctx.bodyRadii && ctx.bodyRadii.get(target)) || 0;
    return tr.x.map((x, i) => {
      const dx = other.x[i] - x;
      const dy = other.y[i] - tr.y[i];
      return Math.hypot(dx, dy) - (rSelf + rOther);
    });
  }
  throw new OutputResolutionError(
    `contact predicate target "${target}" resolves to neither a surface id nor a ` +
    `recorded body id in this scene — check the "target" against the scene's surfaces and bodies.`
  );
}

// ----- Crossing primitives (shared by the solvers) ------------------------

// Linear interpolation of a signal to its zero within [t0, t1], given the two
// bracketing values g0, g1 (opposite signs, or one exactly 0). Clamped to the
// interval so floating-point overshoot can never place t* outside the bracket.
function linRefineZero(t0, t1, g0, g1) {
  const dg = g1 - g0;
  if (dg === 0) return t0;
  let s = -g0 / dg;
  if (s < 0) s = 0; else if (s > 1) s = 1;
  return t0 + s * (t1 - t0);
}

// Sign (+1/-1) of the next strictly-nonzero sample at index > i, or 0 if none.
function nextNonZeroSign(v, i) {
  for (let j = i + 1; j < v.length; j++) {
    if (v[j] > 0) return 1;
    if (v[j] < 0) return -1;
  }
  return 0;
}

// First instant `v` transitions from POSITIVE to NEGATIVE (a downgoing zero),
// linearly refined; null if none. An exact 0 at a node counts as the crossing
// when it was reached from a strictly-positive sample and does NOT immediately
// rise back (a tangent touch to zero is not a crossing). With includeStartZero,
// a signal exactly 0 at t=0 whose next sample is negative also counts (the
// horizontally-launched apex at t=0). The bare v[i]*v[i+1] < 0 product test
// would silently miss the exact-zero-at-a-node case — this does not.
function firstDowngoingZero(t, v, { includeStartZero = false } = {}) {
  let lastPos = -1; // index of the most recent strictly-positive sample
  for (let i = 0; i < v.length; i++) {
    if (v[i] > 0) { lastPos = i; continue; }
    if (v[i] === 0) {
      const cameFromPos = lastPos >= 0 && lastPos === i - 1;
      const risesBack = i + 1 < v.length && v[i + 1] > 0;
      if (cameFromPos && !risesBack) return t[i];
      if (includeStartZero && i === 0 && i + 1 < v.length && v[i + 1] < 0) return t[i];
      continue;
    }
    // v[i] < 0 — a strict + -> - crossing iff the previous sample was > 0.
    if (lastPos >= 0 && lastPos === i - 1) return linRefineZero(t[i - 1], t[i], v[i - 1], v[i]);
  }
  return null;
}

// First instant `v` changes sign (either direction), linearly refined; null if
// none. An exact 0 at a node between opposite-signed neighbours is the crossing
// instant (the exact-zero-at-a-node case the strict-product test misses). A
// signal that STARTS at 0 and then becomes nonzero is NOT a sign change (it
// began at rest) — only a genuine + <-> - reversal counts.
function firstSignChange(t, v) {
  let lastNZ = -1; // index of the most recent strictly-nonzero sample
  for (let i = 0; i < v.length; i++) {
    if (v[i] === 0) {
      if (lastNZ >= 0 && lastNZ === i - 1) {
        const s = nextNonZeroSign(v, i);
        if (s !== 0 && s !== Math.sign(v[lastNZ])) return t[i];
      }
      continue;
    }
    if (lastNZ >= 0 && lastNZ === i - 1 && Math.sign(v[i]) !== Math.sign(v[i - 1])) {
      return linRefineZero(t[i - 1], t[i], v[i - 1], v[i]);
    }
    lastNZ = i;
  }
  return null;
}

export const NAME = 'output_events';
