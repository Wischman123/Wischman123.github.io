// sim/validation/diagnostics_validation.js
//
// sim_orbital_angular_momentum Phase P3 — the FIRST diagnostics.* validator.
//
// Verified 2026-07-06: NO diagnostics.* validator existed before this module.
// The `diagnostics.angular_momentum` / `system_momentum` opt-ins are consumed
// directly by the scene.js registration block (they are bare `=== true` flags
// that cannot be malformed), and drift_budget.js validates only
// `conserved.p_linear` — neither enumerates or shape-checks the diagnostics
// keys. This module is therefore the validator-first gate (physics/CLAUDE.md
// "Validator-First Rule for New Domains") for the new opt-in that DOES carry a
// mandatory sub-field.
//
// Unlike `angular_momentum: true`, `orbital_angular_momentum` is an OBJECT
// carrying a mandatory `reference_point` — L = Σ m(r × v) is AXIS-DEPENDENT, so
// the reference point about which L is measured is not optional. A scene that
// opts in without a valid numeric reference_point would report a meaningless /
// false-drifting L, so the opt-in is rejected at load with a scene-naming
// message (the canonical caveat itself lives in SCHEMA.md
// `### diagnostics.orbital_angular_momentum`).
//
// Each check returns an array of issues:
//   { level: 'error' | 'warn', check: <name>, message: <string> }
// runDiagnosticsChecks aggregates them into { ok, issues }. scene.js calls it
// in loadScene BEFORE the conserved-tracker registration block, so the friendly
// build message beats the factory's raw throw (defense-in-depth: the factory
// and this guard branch on the SAME isValidReferencePoint predicate, so the two
// can never disagree about what a valid reference point is).

import { isValidReferencePoint } from '../engine/conserved.js';

// diagnostics.orbital_angular_momentum, when present, MUST carry a
// reference_point with numeric x AND y. Absent opt-in ⇒ no-op (returns []).
export function orbital_angular_momentum_requires_reference_point(scene) {
  const issues = [];
  const opt = scene?.diagnostics?.orbital_angular_momentum;
  if (opt === undefined || opt === null) return issues;   // not opted in
  const rp = opt.reference_point;
  if (!isValidReferencePoint(rp)) {
    issues.push({
      level: 'error',
      message:
        `diagnostics.orbital_angular_momentum requires a reference_point ` +
        `{ x: <number>, y: <number> } (got ${JSON.stringify(rp)}). Total ` +
        `angular momentum L = Σ m(r × v) is AXIS-DEPENDENT — the reference ` +
        `point about which L is measured is mandatory; a wrong/absent axis ` +
        `reports false drift. Add e.g. ` +
        `"orbital_angular_momentum": { "reference_point": { "x": 0, "y": 0 } }.`
    });
  }
  return issues;
}

export function runDiagnosticsChecks(scene) {
  const checks = [
    ['orbital_angular_momentum_requires_reference_point',
      orbital_angular_momentum_requires_reference_point],
  ];
  const issues = [];
  for (const [name, fn] of checks) {
    let result;
    try {
      result = fn(scene);
    } catch (err) {
      issues.push({ level: 'error', check: name, message: `check threw: ${err.message}` });
      continue;
    }
    if (!Array.isArray(result)) continue;
    for (const issue of result) issues.push({ ...issue, check: issue.check ?? name });
  }
  const errored = issues.some((i) => i.level === 'error');
  return { ok: !errored, issues };
}

export const NAME = 'diagnostics_validation';
