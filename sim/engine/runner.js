// engine/runner.js
//
// Interactive simulation runner. Wraps the same fixed-dt integration as
// `fixedDtRunner` in integrator.js, but tick-by-tick instead of one-shot
// — designed to be driven by requestAnimationFrame in the browser.
//
// State machine:
//   IDLE → running=false; advance() does nothing.
//   PLAYING → on each tick(realDt), integrate enough sim-dt steps to
//             cover realDt * playbackRate.
//   STEPPING → advance exactly one simulator dt and return to IDLE.
//
// The runner does NOT own a clock. The caller passes `realDtSeconds`
// to `tick()`, computed from `performance.now()` deltas (or hands the
// runner a fixed nominal dt for headless tests).

import { circuitState, clearCircuitSnapshot } from './circuits/state.js';
import { seedCircuitDC } from './circuits_check.js';
import { applyPositionPoke } from './position_poke.js';
import { MIN_PLAYBACK_RATE } from './constants.js';

export class SimRunner {
  constructor({ loaded, integrator, dt, playbackRate = 1.0, onTick = null }) {
    this.loaded = loaded;
    this.integrator = integrator;
    this.dt = dt;
    this.playbackRate = playbackRate;
    this.onTick = onTick;

    this.state = loaded.state0.slice();
    this.statePrev = null;
    this.t = 0;
    this.steps = 0;
    this.duration = loaded.simulation.duration_s;

    this.playing = false;
    this._tracker = loaded.tracker;

    // Phase 5.C Step 0b.1 (Lock #16): drop any per-element prev_state
    // left over from a previous scene's run. Element classes are
    // STATELESS — the engine round-trips opaque per-element state
    // through this Map across ticks; a fresh scene starts cold.
    circuitState.clear();
    // Phase A3: drop any stale solve from a prior in-process run (symmetric
    // with circuitState.clear()), then seed the t=0 DC operating point when the
    // scene carries a circuit — so the inspector/producer surface the operating
    // point immediately AND the first live trap step (stepCircuitLive) has the
    // valid prev_state that Capacitor/Inductor.stamp require. Must run BEFORE
    // the t=0 snapshot below so that history entry records the DC diagnostics.
    clearCircuitSnapshot();
    const circuitTopology = this.loaded.sceneCtx?.circuit_topology;
    if (circuitTopology) seedCircuitDC(circuitTopology);
    // Phase A0: drop any one-step induction flux history left from a prior
    // run (mirrors the circuitState reset — a fresh run starts cold, so the
    // first sampled tick reports no dΦ/dt until a second sample lands).
    this.loaded.sceneCtx?.inductionFluxState?.clear();
    // P2 (kinetic-theory box): drop any wall-impulse left from a prior run so
    // the t=0 snapshot below reads a clean 0 (no hits have happened yet).
    this.loaded.sceneCtx?.wallImpulse?.clear();
    // orbit_weld_on_contact: a fresh run starts UN-WELDED. Clears the
    // activate_on_contact latch on any body_rod that carries one (a plain rod resets to
    // its only valid state, ACTIVE, so this is a no-op for every existing consumer).
    this.loaded.sceneCtx?.weldedPairs?.clear();
    this._resetConstraints();

    // Take an initial energy snapshot so .history() is non-empty
    // immediately (used by the inspector for live readouts).
    loaded.syncBodies(this.state);
    this._tracker.snapshot(0);
  }

  // orbit_weld_on_contact — clear every constraint's per-run latch. Today the only
  // latching constraint is a BodyRodConstraint with activate_on_contact (its `_active`
  // weld flag); `reset?.()` is duck-typed so a constraint without per-run state costs
  // nothing and needs no change. Symmetric with the circuitState / wallImpulse /
  // inductionFluxState clears above and in reset(): all are per-RUN state that a replay
  // must start cold.
  //
  // This is what keeps the weld replay-safe, and it is the reason a weld may hold a
  // latch at all where collisions.js forbids one. That prohibition targets a latch that
  // would SKIP a merge on replay ("already merged, don't re-fire"); the weld latch is
  // its mirror image — cleared here, a timeline scrub replays from t=0 with the rod
  // asleep, re-contacts, and re-welds. A latch nobody clears is the bug; a latch cleared
  // on reset is just state.
  _resetConstraints() {
    const constraints = this.loaded?.constraints;
    if (!constraints) return;
    for (const c of constraints) c.reset?.();
  }

  setPlaybackRate(rate) {
    // T2 (#6): MIN_PLAYBACK_RATE is the single source of the slow-motion
    // floor — the toolbar speed list (PLAYBACK_RATES) is asserted to stay
    // at or above it so no listed speed clamps silently.
    this.playbackRate = Math.max(MIN_PLAYBACK_RATE, rate);
  }

  play()  { this.playing = true; }
  pause() { this.playing = false; }

  // Advance exactly one simulator dt regardless of playback state.
  // After the step the runner is paused.
  step() {
    this._advanceOne();
    this.playing = false;
    if (this.onTick) this.onTick(this);
  }

  // Reset to t=0 with the original state vector. Re-loads the engine
  // bodies' positions/velocities. Tracker is NOT reset (its drift
  // history would be misleading) — the caller should rebuild the runner
  // from a fresh `loadScene(json)` to get a clean tracker.
  reset() {
    this.state = this.loaded.state0.slice();
    this.statePrev = null;
    this.t = 0;
    this.steps = 0;
    this.playing = false;
    // Phase 5.C Step 0b.1 (Lock #16): a re-run is functionally a
    // scene-load, so per-element prev_state must be re-bootstrapped
    // from t=0 initial conditions on the next stamp() pass.
    circuitState.clear();
    // Phase A3: a re-run is a fresh t=0 start — clear the stale solve and
    // re-seed the DC operating point (symmetric with the ctor).
    clearCircuitSnapshot();
    const circuitTopology = this.loaded.sceneCtx?.circuit_topology;
    if (circuitTopology) seedCircuitDC(circuitTopology);
    // Phase A0: a re-run is a fresh t=0 start; clear the induction flux
    // history so dΦ/dt isn't computed across the reset boundary.
    this.loaded.sceneCtx?.inductionFluxState?.clear();
    // P2 (kinetic-theory box): re-zero the wall-impulse seam on reset so a
    // timeline scrub / replay starts from a clean pressure signal (the
    // regression guard for a cross-run |J| leak — box_wall_reflection.test.js).
    this.loaded.sceneCtx?.wallImpulse?.clear();
    // orbit_weld_on_contact: un-weld. A timeline scrub replays from t=0, so a rod that
    // stayed welded across the reset would be TETHERED during the approach — which for
    // an orbital intercept perturbs the back-propagated trajectory and the two bodies
    // would never meet on the second play-through. Cleared here, the replay re-detects
    // contact and re-welds at the same instant.
    this.loaded.sceneCtx?.weldedPairs?.clear();
    this._resetConstraints();
    this.loaded.syncBodies(this.state);
    if (this.onTick) this.onTick(this);
  }

  // T8 live position-poke command (plan sim_interactivity_viz, D1). The
  // UI calls this from a pointer-drag handler; it applies a
  // {body_id, position_m, velocity_m_per_s?} delta to the LIVE state
  // without rebuild/revalidate — t, play state, and all circuit /
  // induction / motion-graph buffers are untouched (contrast
  // main.doReset, which re-zeros the run). On success it ALSO invalidates
  // the Verlet history (statePrev): a teleport breaks the finite-
  // difference velocity estimate, so the next tick re-bootstraps from the
  // poked position (same as reset()). Returns the seam's {ok, ...} verdict
  // so the caller can reject an invalid drop.
  pokeBody(poke) {
    const res = applyPositionPoke(this.loaded, this.state, poke);
    if (res.ok) this.statePrev = null;
    return res;
  }

  // Drive the runner forward by realDt seconds of wall-clock time.
  // Returns the number of simulator dt steps taken.
  tick(realDt) {
    if (!this.playing) return 0;
    if (this.t >= this.duration) {
      this.playing = false;
      return 0;
    }
    const targetSimDt = realDt * this.playbackRate;
    const stepsToTake = Math.max(1, Math.round(targetSimDt / this.dt));
    let taken = 0;
    for (let i = 0; i < stepsToTake; i++) {
      if (this.t >= this.duration) {
        this.playing = false;
        break;
      }
      this._advanceOne();
      taken++;
    }
    if (this.onTick) this.onTick(this);
    return taken;
  }

  // Canonical per-tick ordering — Phase S item S3 INVARIANT.
  //
  // Every per-tick update has ONE pinned slot, and every derived/discrete
  // update MUST land BEFORE the tracker snapshot (step 5). Run AFTER the
  // snapshot, a collision impulse or a circuit/flux reading is one tick
  // stale and blips drift_pct on its own tick. Phases A0/A3/B1/B4 inherit
  // this order rather than each re-deciding where to hook in:
  //
  //   1. integrate        — advance the continuous ODE by one dt
  //   2. syncBodies       — refresh body objects FROM the new state
  //   3a. collisionResolvers — resolve perfectly-inelastic merges +
  //                         addDissipated (B4, implemented). State-mutating; also
  //                         run in cli_headless (it changes band-checked dynamics).
  //   3b. discreteUpdates  — sample flux/induction (A0, implemented); solve
  //                         circuit MNA (A3, shipped — a live discreteUpdate
  //                         registered at scene.js:534). Observation-only; live
  //                         runner path only. Both mutate body objects and/or the
  //                         tracker IN PLACE, here, BEFORE the writeback.
  //   4. writebackState   — pack post-update body state BACK into
  //                         this.state so a step-3 velocity jump survives
  //                         the next tick's unpack (identity until a
  //                         step-3 update mutates a body).
  //   5. tracker.step     — snapshot energy/diagnostics over the fully
  //                         resolved tick (LAST, always).
  _advanceOne() {
    // T9 play-vs-drag: while a body is dragged, its kinematic state is
    // pointer-owned (poked every frame). Snapshot that body's state slice
    // BEFORE integrating and restore it AFTER, so the hold is EXACT under
    // EVERY integrator. (derivState also pins the dragged body's
    // derivatives — that alone holds it only under RK4; verlet /
    // semi_implicit_euler rebuild position from the velocity STATE slot, not
    // the zeroed derivative, so they need this explicit restore.) Only the
    // body's own slots are restored — the coupled aux loop-current slot
    // lives elsewhere in the vector and keeps its freshly integrated value,
    // so the induction solve still tracks the poked velocity. Null
    // draggingBodyId ⇒ no snapshot ⇒ byte-identical to baseline.
    const dragId = this.loaded.sceneCtx?.draggingBodyId;
    let dragHold = null;
    if (dragId != null) {
      const i = this.loaded.bodies.findIndex((b) => b.id === dragId);
      if (i >= 0) {
        const off = this.loaded.offsets[i];
        const stride = this.loaded.strides[i];
        dragHold = { off, stride, slice: this.state.slice(off, off + stride) };
      }
    }
    // dawn_last_burn_live_sim_v1 D2: capture the PRE-step time now (this.t is the
    // previous tick's tNow) so the step-3 maneuver slot has the half-open window
    // (tPrev, tNow] after the `this.t += this.dt` increment below. Captured before
    // the integrate so a scheduled burn fires on the exact tick that crosses
    // t_burn (matching the headless applyManeuverResolvers window byte-for-byte).
    const tPrev = this.t;
    // 1. Integrate. Phase 3.4 (Q2=A): pass per-body strides so siEuler /
    //    verlet can walk variable-length state slices. RK4 ignores it.
    const newState = this.integrator(
      this.state, this.t, this.dt,
      this.loaded.derivState, this.statePrev, this.loaded.strides
    );
    this.statePrev = this.state;
    this.state = newState;
    this.t += this.dt;
    this.steps++;
    // T9: restore the dragged body's pre-integration kinematics into the new
    // state BEFORE syncBodies, so the body objects (and every downstream
    // sampler) see the held pose regardless of which integrator ran.
    if (dragHold) {
      for (let k = 0; k < dragHold.stride; k++) {
        this.state[dragHold.off + k] = dragHold.slice[k];
      }
    }
    // 2. Sync body objects from the integrated state.
    this.loaded.syncBodies(this.state);
    // 3a. Phase B item B4: state-mutating collision resolvers (perfectly-
    //     inelastic merge). Resolve DYNAMICS first — set both bodies to v_cm
    //     and deposit ΔK into the tracker — so the observation samplers (3b)
    //     and the snapshot (5) both see the post-collision state. resolve()
    //     mutates body velocities in place; the writeback (4) lands the jump
    //     in this.state. Empty ⇒ no-op for non-collision scenes. These run in
    //     cli_headless too (band-checked dynamics), unlike 3b.
    const resolvers = this.loaded.collisionResolvers;
    if (resolvers) {
      for (const r of resolvers) r.resolve(this.loaded.sceneCtx, this._tracker);
    }
    // 3a'. dawn_last_burn_live_sim_v1 D2: scheduled impulsive-Δv burn resolvers,
    //      right beside the collision loop (same step-3 slot, same syncBodies/
    //      writeback bracket). The resolver contract is time-blind, so STAMP the
    //      tick-time window (tPrev captured pre-step, this.t now post-step) onto
    //      sceneCtx before dispatch — the stateless half-open window (tPrev, t]
    //      is the burn's only fire condition, so a timeline-scrub replay re-fires
    //      with no latch. resolve() mutates velocity in place; the writeback (4)
    //      lands the Δv jump; ΔK_burn is booked to W_external in the same tick.
    //      Empty ⇒ no-op for non-burn scenes (byte-identical tick to baseline).
    const maneuvers = this.loaded.maneuverResolvers;
    if (maneuvers && maneuvers.length > 0) {
      this.loaded.sceneCtx.tPrev = tPrev;
      this.loaded.sceneCtx.t = this.t;
      for (const m of maneuvers) m.resolve(this.loaded.sceneCtx, this._tracker);
    }
    // 3b. Discrete / derived per-tick updates — BEFORE the writeback and
    //    the snapshot (see the invariant above). loaded.discreteUpdates is
    //    the registration point (scene.js): Phase A0 pushes the induction
    //    flux sampler; A3 (circuit MNA) pushes its live MNA step here. B4
    //    collisions do NOT register here — they resolve in the step-3a
    //    collisionResolvers list (above), not as a 3b discreteUpdate.
    //    Each is fn(dt, t); this.t is post-step so a time-dependent
    //    sampler reads the correct instant. Empty for non-EM scenes ⇒
    //    no-op ⇒ byte-identical tick to baseline.
    const updates = this.loaded.discreteUpdates;
    if (updates) {
      for (const update of updates) update(this.dt, this.t);
    }
    // 4. Write modified body state back into this.state (an identity
    //    until a step-3 update mutates a body; captures impulses then).
    this.loaded.writebackState(this.state);
    // 5. Snapshot LAST. Phase S item S2: pass the post-step time so the
    //    tracker can prime a time-dependent external driver before
    //    integrating its F·v into W_external (this.t is now post-step).
    if (this._tracker) this._tracker.step(this.dt, this.t);
  }

  // Cheap accessor that callers (renderer, inspector) use each frame.
  // Returns a live view — never copy this object; it mirrors current
  // engine state, which is mutated in place by syncBodies.
  view() {
    return {
      t: this.t,
      steps: this.steps,
      duration: this.duration,
      playing: this.playing,
      atEnd: this.t >= this.duration - 1e-12,
      bodies: this.loaded.bodies,
      surfaces: this.loaded.surfaces,
      fields: this.loaded.fields,
      energy: this._tracker ? this._tracker.current() : null
    };
  }
}

export const NAME = 'runner';
