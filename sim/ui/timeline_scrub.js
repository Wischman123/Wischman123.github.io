// ui/timeline_scrub.js
//
// Phase 2.6 — timeline scrubbing. Pure helper module (no DOM) that
// re-runs the simulation from t=0 to a target t by calling
// `runner.reset()` followed by `_advanceOne()` in a loop. The slider
// in `toolbar.js` calls `seekTo` on `change` (release) — never on
// `input` (drag) — so we don't burn ~12 K integrator steps per drag
// pixel on the cycloid scene. Universality contract: zero
// `sim/engine/` files modified; the seek mechanic lives entirely on
// the ui side, using only the runner's existing public state.
//
// `_advanceOne()` is technically a private member of `SimRunner`, but
// it's the same step the public `tick()` and `step()` methods call
// internally. We use it directly to avoid the playing/paused toggle
// `tick()` would force and the per-step `onTick` `step()` would emit.
// The seek wrapper fires `onTick` once at the end so the inspector,
// clock, and renderer observe the final state — same contract as
// pressing Step on the toolbar.
//
// Anti-Kohn note: this is `t` / `s` notation only. PEDAGOGY.md
// explicitly forbids "rewind" / "undo" / "try again" framing — the
// slider lets a paused student inspect the system at an earlier sim
// time, not relive a "missed" trajectory. The helper exposes neutral
// names (`seekTo`, `clampTargetTime`).

/**
 * Clamp `targetT` to the valid range for `runner`. Negative values
 * map to 0; values past `runner.duration` map to `runner.duration`.
 * NaN / non-finite inputs collapse to 0 — the safe boundary.
 */
export function clampTargetTime(runner, targetT) {
  if (!runner) return 0;
  const duration = runner.duration ?? 0;
  if (!Number.isFinite(targetT)) return 0;
  if (targetT <= 0) return 0;
  if (targetT >= duration) return duration;
  return targetT;
}

/**
 * Compute the number of integrator steps required to advance from
 * t=0 to (clamped) `targetT` at the runner's fixed `dt`. Uses
 * `Math.round` so a slider value snapped to a multiple of `dt`
 * lands exactly — and a target between two `dt` ticks lands on the
 * nearer one.
 */
export function stepsToTarget(runner, targetT) {
  if (!runner || !runner.dt || runner.dt <= 0) return 0;
  const clamped = clampTargetTime(runner, targetT);
  return Math.max(0, Math.round(clamped / runner.dt));
}

/**
 * Re-run the simulation from t=0 to `targetT`. The runner returns
 * paused at the new t; the caller can press Play to continue from
 * there. Deterministic and zero-memory — every seek replays the
 * same integrator steps. v2 may add snapshot history if classroom
 * feedback demands it.
 *
 * Returns the actual t the runner landed at (= clamped target
 * snapped to the nearest dt boundary). Callers can use this to
 * update the slider's visual position when the request fell
 * between dt ticks.
 */
export function seekTo(runner, targetT) {
  if (!runner) return 0;
  if (typeof runner.reset !== 'function') return runner.t ?? 0;
  if (typeof runner._advanceOne !== 'function') return runner.t ?? 0;

  const steps = stepsToTarget(runner, targetT);

  // Reset clears t and restores state0. Tracker is intentionally NOT
  // reset (its drift history would be misleading); same contract as
  // the existing `runner.reset()` call from `loadAndStart`.
  runner.reset();

  // `runner.reset()` already fires `onTick` once with t=0. Suppress
  // the per-step onTick during the rebuild so we don't repaint /
  // re-record motion-graph samples 12 K times for a cycloid seek;
  // a single onTick at the end is enough to update the inspector,
  // clock, and toolbar end-of-run flag with the final state.
  for (let i = 0; i < steps; i++) {
    runner._advanceOne();
  }
  runner.playing = false;

  if (runner.onTick) runner.onTick(runner);
  return runner.t;
}

/**
 * Determine whether the slider should be enabled in the current
 * (sceneLoaded, isPlaying) UI state. Disable when no scene is loaded
 * (nothing to scrub) OR the runner is playing (the rAF loop would
 * race the re-run — pause first, then scrub).
 */
export function shouldEnableSlider({ sceneLoaded, isPlaying }) {
  return Boolean(sceneLoaded) && !isPlaying;
}

export const NAME = 'timeline_scrub';
