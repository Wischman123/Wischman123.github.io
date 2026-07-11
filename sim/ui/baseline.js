// ui/baseline.js
//
// sim_trace_ghost P3 — the idealized-baseline action ("compare against the
// idealized baseline"), extracted as a dependency-injected async state machine
// so its four stages + re-entrancy guard are unit-testable WITHOUT booting the
// browser entry module. (main.js is un-importable headless: it grabs #app and
// starts an rAF loop at import time.) main.js wires the real seams — the
// loadAndStart/onComplete completion seam, captureGhost, ghostLol, computeBars,
// the LoL force-enable, the toolbar button — into makeBaselineController(deps);
// the exit-gate tests inject fakes to drive every branch deterministically.
//
// The chain (all async, each stage keyed on its run's view.atEnd, delivered
// through the injected startRun seam):
//   stage 1  set-up (sync): fold pending inspector edits into the scene via the
//            SAME mergeEditsIntoScene path doReset uses, idealize it, re-validate
//            through the SAME validateScene boundary. Invalid ⇒ banner, abort.
//   stage 2  run the IDEALIZED scene to completion; on atEnd, capture it as a
//            ghost (INCLUDING its zero-U_thermal LoL snapshot) and read that
//            snapshot as a VALUE via ghostLol(getGhosts().length − 1).
//   stage 3  RESTORE + run the REAL scene to completion (same scene id, so the
//            fresh idealized ghost is kept); on atEnd, read the real run's
//            U_thermal from its LIVE computeBars LoL snapshot as a VALUE.
//   stage 4  force the LoL overlay on + render the descriptive two-run compare.
//
// A module-instance `baselineInFlight` lock serializes the chain. While set:
// the baseline button no-ops (second press ignored), and a mid-chain Reset
// clears the lock so the stale one-shot handler no-ops (each handler re-checks
// the lock at its top) instead of interleaving a competing chain. BOTH async
// runs carry a termination ceiling with a DEFINED abort exit, so neither leg can
// strand the sim half-complete. Every exit path clears the lock.
//
// The two per-run VALUE snapshots ({ U_thermal, source }) are freshly-built
// plain objects — NOT live getResult() references. getResult() returns predict
// .js's single mutable lastResult, set only in showComparison (which
// early-returns without a student prediction), so it is null here AND aliasing
// it would collapse realResult === idealResult once the real run repopulates the
// panel. Sourcing each run's U_thermal from its OWN LoL/computeBars snapshot,
// held as a distinct value, keeps the difference visible.

// Belt-and-suspenders fixed ceiling — the ONLY fallback when a scene's
// duration_s / dt_s is absurd or missing. Normal scenes use the duration-derived
// ceiling below; this caps it. Counted in per-frame onTick relays.
export const MAX_BASELINE_TICKS = 100000;

// Small margin added to the duration-derived tick count so a run that lands on
// its final frame is not aborted one tick early.
export const CEILING_MARGIN_TICKS = 64;

// U_thermal value out of a computeBars composition (0 when the bar is absent —
// e.g. the idealized run, whose tracker emits U_thermal = 0).
export function uThermalOf(composition) {
  if (!composition || !Array.isArray(composition.bars)) return 0;
  const bar = composition.bars.find((b) => b.key === 'U_thermal');
  return bar ? bar.value : 0;
}

// Per-run termination ceiling (in onTick relays). Primary: duration_s / dt_s +
// margin from the GROUNDED, schema-required simulation block. Capped by
// MAX_BASELINE_TICKS; falls back to it if the scene lacks a usable duration/dt.
export function ceilingTicks(scene) {
  const sim = (scene && scene.simulation) || {};
  const dt = sim.dt_s > 0 ? sim.dt_s : 0;
  const dur = sim.duration_s > 0 ? sim.duration_s : 0;
  if (dt <= 0 || dur <= 0) return MAX_BASELINE_TICKS;
  return Math.min(MAX_BASELINE_TICKS, Math.ceil(dur / dt) + CEILING_MARGIN_TICKS);
}

// Neutral, verdict-free banner copy (anti-Kohn — descriptive, no PASS/FAIL).
const BANNER_IDEALIZE_FAILED = (msg) =>
  `Idealized baseline unavailable: ${msg}`;
const BANNER_VALIDATE_FAILED =
  'Idealized baseline could not be built from the current edits — the sim was left as it is.';
const BANNER_IDEAL_TIMEOUT =
  'Idealized run did not finish within its time budget — restored the original run; no comparison shown.';
const BANNER_REAL_TIMEOUT =
  'Real run did not complete within its time budget — no comparison shown.';

// deps (all injected; main.js supplies the real seams, tests supply fakes):
//   getCurrentScene()                       -> the live scene JSON (or null)
//   getEdits()                              -> inspector.getEdits() (or null)
//   mergeEditsIntoScene(scene, edits)       -> merged scene JSON
//   idealizeScene(scene)                    -> idealized scene JSON (may throw)
//   validateScene(scene)                    -> { valid, errors }
//   startRun(scene, { onTick, onComplete }) -> load + play; relay every frame
//                                              via onTick(view), and onComplete
//                                              (view) ONCE on view.atEnd.
//   stopRun()                               -> pause + detach the frame relay
//   restoreScene(scene)                     -> load the scene live (paused, no
//                                              play, NO compare) — the stage-2
//                                              abort restore
//   captureGhost(traceSnap, graphSnap, conservationSnap, label)
//   snapshotTraces(), snapshotBuffers()     -> the two buffer snapshots
//                                              captureGhost deep-copies
//   getGhosts()                             -> the ghost FIFO (for len − 1)
//   ghostLol(index)                         -> a ghost's computeBars comp | null
//   computeBars(snapshot)                   -> LoL composition for a live snapshot
//   forceLolOn()                            -> renderer.setLolEnabled(true) +
//                                              toolbar.setLolToggle(true)
//   showBanner(message)                     -> surface a neutral banner
//   showRunComparison(realResult, idealResult) -> render the descriptive compare
//   setBaselineEnabled(enabled)             -> enable/disable the baseline button
//   idealLabel                              -> the ghost label (optional; default
//                                              IDEALIZED_GHOST_LABEL)
export function makeBaselineController(deps) {
  let baselineInFlight = false;

  const idealLabel = deps.idealLabel ?? 'idealized (f = 0, drag = 0)';

  function setEnabled(on) {
    deps.setBaselineEnabled?.(on);
  }

  // Clear the lock + re-enable the button. Called on EVERY exit path (every
  // abort AND the stage-4 success) so no path leaks the lock.
  function settle() {
    baselineInFlight = false;
    setEnabled(true);
  }

  function run() {
    // Re-entrancy: a second press while a chain is in flight is a no-op.
    if (baselineInFlight) return;
    baselineInFlight = true;
    setEnabled(false);

    // ── stage 1 — set-up (synchronous) ──────────────────────────────────
    const currentScene = deps.getCurrentScene();
    if (!currentScene) { settle(); return; }         // nothing loaded

    // Fold pending inspector edits FIRST (same path doReset uses), so the
    // baseline honors an un-Reset edit rather than running on stale params.
    const edits = deps.getEdits();
    const base = edits ? deps.mergeEditsIntoScene(currentScene, edits) : currentScene;

    let ideal;
    try {
      ideal = deps.idealizeScene(base);              // may fail-loud on unknown type
    } catch (err) {
      deps.showBanner(BANNER_IDEALIZE_FAILED(err && err.message ? err.message : String(err)));
      settle();
      return;
    }

    const v = deps.validateScene(ideal);
    if (!v || !v.valid) {
      deps.showBanner(BANNER_VALIDATE_FAILED);
      settle();
      return;
    }

    // idealResult is captured in stage 2 and threaded to stage 4 as a VALUE.
    let idealResult = null;

    // ── stage 2 — idealized run (async) ─────────────────────────────────
    const idealCeiling = ceilingTicks(ideal);
    let idealTicks = 0;
    deps.startRun(ideal, {
      onTick: (view) => {
        if (!baselineInFlight) return;               // cancelled (Reset) ⇒ no-op
        if (++idealTicks > idealCeiling) {
          // DEFINED abort: banner + restore the real run live, then STOP.
          deps.stopRun();
          deps.showBanner(BANNER_IDEAL_TIMEOUT);
          deps.restoreScene(base);                   // same restore stage 3 loads
          settle();
        }
      },
      onComplete: (view) => {
        if (!baselineInFlight) return;               // cancelled ⇒ no-op
        deps.stopRun();
        // Capture the idealized run as a ghost INCLUDING its LoL snapshot (which
        // carries no U_thermal). view.energy is the run's final ConservationTracker
        // snapshot — the same object computeBars consumes.
        deps.captureGhost(deps.snapshotTraces(), deps.snapshotBuffers(), view.energy, idealLabel);
        // Read the JUST-captured ghost's LoL as a VALUE, pinned to the newest FIFO
        // slot (len − 1) evaluated IMMEDIATELY after captureGhost — a pre-computed
        // index could reference a stale ghost after a FIFO eviction shifts indices.
        const idealLol = deps.ghostLol(deps.getGhosts().length - 1);
        idealResult = { U_thermal: uThermalOf(idealLol), source: 'idealized_ghost_lol' };
        startRealRun();
      }
    });

    // ── stage 3 — real run (async) ──────────────────────────────────────
    function startRealRun() {
      const realCeiling = ceilingTicks(base);
      let realTicks = 0;
      deps.startRun(base, {
        onTick: (view) => {
          if (!baselineInFlight) return;             // cancelled ⇒ no-op
          if (++realTicks > realCeiling) {
            // DEFINED abort (mirror of stage 2): banner, STOP, no compare.
            deps.stopRun();
            deps.showBanner(BANNER_REAL_TIMEOUT);
            settle();
          }
        },
        onComplete: (view) => {
          if (!baselineInFlight) return;             // cancelled ⇒ no-op
          deps.stopRun();
          // Real run's U_thermal from its LIVE computeBars LoL snapshot, held as a
          // VALUE (NOT a getResult() reference the panel would later mutate).
          const realLol = deps.computeBars(view.energy);
          const realResult = { U_thermal: uThermalOf(realLol), source: 'real_live_lol' };
          // ── stage 4 — compare ─────────────────────────────────────────
          deps.forceLolOn();                         // real run's U_thermal bar on screen
          deps.showRunComparison(realResult, idealResult);
          settle();
        }
      });
    }
  }

  // Cancel an in-flight chain (a mid-chain Reset or edit-driven reload). Clears
  // the lock so any pending one-shot handler no-ops, and detaches the frame
  // relay. Returns true iff a chain was actually in flight (so the caller can
  // decide whether it interrupted anything).
  function cancel() {
    if (!baselineInFlight) return false;
    baselineInFlight = false;
    deps.stopRun();
    setEnabled(true);
    return true;
  }

  return {
    run,
    cancel,
    isInFlight: () => baselineInFlight
  };
}

export const NAME = 'baseline';
