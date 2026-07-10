// scenes.js — the ONE canonical scene definition for the portfolio field lab.
//
// WHY THIS EXISTS (plan fieldlab_equipotential_levels_v1, P1): before this
// module, TWO divergent "default geometries" lived in the codebase —
//   * the browser controller (fieldlab.js) held fractional DEFAULT_CHARGES and
//     its own RATIO_PRESETS list, sized to whatever the responsive canvas is;
//   * the headless gate (tools/fieldlab_validate.mjs) hardcoded its OWN canvas
//     (600x540, charges x=180/420, sep 240) and its own preset list.
// The §2 evidence and the P3 fixture, meanwhile, use 700x500 with charges at
// x=210/490 (sep 280). Tolerances measured at sep 280 but CHECKED at sep 240
// are calibrated on |E| values ~(280/240)^2 ~ 36% off, so "import the shared
// definitions" was unsatisfiable and the gate could validate a preset list the
// page never renders.
//
// This module is the single source of truth for the scene geometry: the browser
// page AND every node consumer (the gate, the state-dir evidence dump, the P3
// fixture generator) import it, so the geometry the checks run against is
// EXACTLY the geometry the page renders. It ships under public/ so it also joins
// P4's deployed-artifact hash-verification list. No DOM, no imports, no network.

// Canonical headless canvas — the geometry the gate, the §2 evidence, and the
// P3 fixture all use. The live browser canvas is responsive (sized by a
// ResizeObserver); charges are stored as FRACTIONS so they survive resize, and
// this canonical size is what the fractions resolve to in every node consumer.
export const CANVAS = Object.freeze({ w: 700, h: 500 });

// Default charge POSITIONS as fractions of (w, h): x = 0.30 / 0.70 (separation
// 0.40*w = 280 px at the canonical width), y = 0.52. Sign-agnostic — a ratio
// preset supplies the q values.
export const DEFAULT_POS = Object.freeze([
  Object.freeze([0.30, 0.52]),
  Object.freeze([0.70, 0.52]),
]);

// Default charges (fractional x, y, q) — the +2 / -1 figure that already shipped
// in the hero. fieldlab.js copies these with `.map(c => c.slice())`, so the
// frozen inner arrays are never mutated in place.
export const DEFAULT_CHARGES = Object.freeze([
  Object.freeze([DEFAULT_POS[0][0], DEFAULT_POS[0][1], 2]),
  Object.freeze([DEFAULT_POS[1][0], DEFAULT_POS[1][1], -1]),
]);

// The ratio presets the control exposes, verbatim per the plan (§4a): all five
// are opposite-sign pairs with |source| >= |sink|, so the source-seeding model
// is physically complete (no lines-from-infinity) and no preset takes the
// same-sign / single-signed branch. The '-' shown is U+2212 (true minus).
export const RATIO_PRESETS = Object.freeze([
  Object.freeze({ key: '1,-1', q0: 1, q1: -1, label: '+1 / −1' }),
  Object.freeze({ key: '2,-1', q0: 2, q1: -1, label: '+2 / −1' }),
  Object.freeze({ key: '3,-1', q0: 3, q1: -1, label: '+3 / −1' }),
  Object.freeze({ key: '2,-2', q0: 2, q1: -2, label: '+2 / −2' }),
  Object.freeze({ key: '3,-2', q0: 3, q1: -2, label: '+3 / −2' }),
]);

// presetChargesPx(q0, q1, canvas): resolve the default fractional positions to
// pixel charges [[x, y, q0], [x, y, q1]] on the given canvas (canonical by
// default). This is the ONE place fractions -> pixels for node consumers.
export function presetChargesPx(q0, q1, canvas = CANVAS) {
  return [
    [DEFAULT_POS[0][0] * canvas.w, DEFAULT_POS[0][1] * canvas.h, q0],
    [DEFAULT_POS[1][0] * canvas.w, DEFAULT_POS[1][1] * canvas.h, q1],
  ];
}

// presetScenesPx(canvas): every ratio preset as { key, label, chs } at the
// canonical (or given) geometry — the list the gate and the evidence dump
// iterate. Replaces the validator's retired hardcoded PRESETS copy.
export function presetScenesPx(canvas = CANVAS) {
  return RATIO_PRESETS.map((p) => ({
    key: p.key,
    label: p.label,
    chs: presetChargesPx(p.q0, p.q1, canvas),
  }));
}

export const NAME = 'fieldlab_scenes';
