// engine/kinetic_theory.js
//
// P2 (kinetic-theory box) — diagnostics PRODUCER for the emergent macroscopic
// readouts P (pressure) and T (temperature) of a gas of elastic disks.
//
// WHY A PRODUCER (not a force, not the resolver). The two raw signals a gas
// exposes are (1) the wall-impulse rate — accumulated by BoxWallReflection onto
// sceneCtx.wallImpulse each tick — and (2) the mean particle kinetic energy. A
// collision resolver is neither a force nor a producer, so the tracker's
// contributeDiagnostics dispatch (energy.js) never visits it; and the producer
// is called `contributeDiagnostics(map, sceneCtx)` — it receives sceneCtx but
// NOT the tracker. That is exactly why the wall-impulse accumulator lives on
// sceneCtx (reachable by both the resolver that writes it and this producer that
// reads it), the corrected seam the /refine deep pass converged on. This module
// is the READ half; collisions.js::BoxWallReflection is the WRITE half.
//
// Registered by the scene loader (scene.js) ONLY when a box_wall_reflection
// collision is present, so it can assume a gas scene; the defensive early-return
// keeps it zero-cost / harmless if somehow dispatched on a non-gas scene.
//
// Diagnostics-only by contract (energy.js header): everything here is a pure
// read that writes into the diagnostics map, never into `total` / `drift_pct`.
//
// Emits two keys:
//   wall_impulse — Σ|J| delivered to ALL four walls THIS tick (instantaneous,
//                  box units of impulse). The render layer time-averages this
//                  over a window into pressure P via windowedWallPressure()
//                  (sim/render/kinetic_theory_overlays.js). Instantaneous — not
//                  a run-length cumulative — because timeline_scrub suppresses
//                  per-step onTick, so the render layer could not finite-
//                  difference a cumulative counter after a scrub.
//   mean_K       — ⟨K⟩ = (1/N)·ΣK over the live bodies = the temperature readout
//                  T (2-D equipartition: ⟨K⟩ = kT). Reads sceneCtx.bodies
//                  directly; needs no tracker and no stash.

export const NAME = 'kinetic_theory';

// @param {Object} map      — diagnostic-keyed map (mutated in place)
// @param {Object} sceneCtx — runner scene context; reads `wallImpulse` (the
//                            per-tick Map written by BoxWallReflection) and the
//                            live `bodies` list.
export function contributeDiagnostics(map, sceneCtx) {
  const wallImpulse = sceneCtx?.wallImpulse;
  if (!wallImpulse) return; // not a gas scene — produce nothing

  // Σ|J| over all four walls this tick. An empty/cleared Map (t=0 snapshot,
  // just after reset) sums to 0 — the honest "no wall hits yet" reading.
  let jSum = 0;
  for (const j of wallImpulse.values()) jSum += j;
  map.wall_impulse = jSum;

  // ⟨K⟩ = mean per-particle kinetic energy = the temperature readout.
  const bodies = sceneCtx.bodies ?? [];
  if (bodies.length > 0) {
    let kTotal = 0;
    for (const b of bodies) kTotal += b.kineticEnergy();
    map.mean_K = kTotal / bodies.length;
  }
}
