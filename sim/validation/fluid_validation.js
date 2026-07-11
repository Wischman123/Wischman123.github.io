// sim/validation/fluid_validation.js
//
// sim_buoyancy_fluids P3 — the semantic buoyancy-feasibility gate (validator-
// first, physics/CLAUDE.md "Validator-First Rule for New Domains"). Ajv and the
// browser validator check each force/field in ISOLATION; neither can
// cross-reference a buoyancy force → its fluid field → the participating body's
// dims + mass, which is exactly what feasibility needs. This module is that
// cross-referential scene-level check.
//
// Three feasible regimes for a body a buoyancy force acts on (see the brief §6):
//   • float          — 0 < d_eq < height_m               (ρ_body < ρ_fluid)
//   • floored sinker — d_eq ≥ height_m WITH a floor       (ρ_body ≥ ρ_fluid, rests on the floor)
//                      below the waterline
//   • pinned         — intentional (a held/placeholder body)
// where d_eq = mass_kg / (ρ_fluid · width_m · 1 m) is the equilibrium submerged
// depth. d_eq is g-INDEPENDENT (Archimedes: a float displaces its own mass of
// fluid — the g's cancel), so feasibility needs no g.
//
// The DECISION lives in the pure engine predicate fluids.js::classifyBuoyancyBody
// (unit-tested at its boundary); this module only walks the raw scene JSON and
// feeds it primitives, then turns an infeasible verdict into a scene-naming
// message (physics/CLAUDE.md recurring-shape-bug: test the decision point, not
// the heuristic). Mirrors diagnostics_validation.js's shape:
//   each check → array of { level, check?, message }; runFluidChecks → { ok, issues }.
// scene.js calls runFluidChecks in loadScene BEFORE the FORCE_CTORS loop.

import { classifyBuoyancyBody } from '../engine/fluids.js';

// True iff `surfaces` contains a floor entirely below the fluid's free surface:
// a surface whose HIGHER endpoint still sits below the waterline
// (max(p1.y, p2.y) < waterline_y_m). Such a floor is what makes a sinker's
// "settles on the floor" a real claim (a floorless dense unpinned block has no
// in-fluid equilibrium). Guards missing p1/p2 (this runs before Ajv on the
// headless path).
function hasFloorBelowWaterline(surfaces, waterlineY) {
  return (surfaces ?? []).some((s) => {
    if (!s || !s.p1 || !s.p2) return false;
    if (typeof s.p1.y !== 'number' || typeof s.p2.y !== 'number') return false;
    return Math.max(s.p1.y, s.p2.y) < waterlineY;
  });
}

// Every body a `buoyancy` force acts on must (a) reference a real `fluid` field
// and (b) be a feasible float / floored sinker / pinned body. Absent any
// buoyancy force ⇒ no-op (returns []).
export function buoyancy_bodies_feasible(scene) {
  const issues = [];
  const forces = scene?.forces ?? [];
  if (!forces.some((f) => f && f.type === 'buoyancy')) return issues; // not used

  const fieldsById = new Map();
  for (const fld of scene?.fields ?? []) {
    if (fld && typeof fld.id === 'string') fieldsById.set(fld.id, fld);
  }
  const bodiesById = new Map();
  for (const b of scene?.bodies ?? []) {
    if (b && typeof b.id === 'string') bodiesById.set(b.id, b);
  }
  const surfaces = scene?.surfaces ?? [];

  for (const f of forces) {
    if (!f || f.type !== 'buoyancy') continue;

    const field = typeof f.field_id === 'string' ? fieldsById.get(f.field_id) : undefined;
    if (!field) {
      issues.push({
        level: 'error',
        message:
          `buoyancy force references field_id="${f.field_id}", which is not a ` +
          `declared field. A buoyancy force must reference a "fluid" field by id.`,
      });
      continue; // can't classify bodies without the fluid
    }
    if (field.type !== 'fluid') {
      issues.push({
        level: 'error',
        message:
          `buoyancy force references field_id="${f.field_id}", which is a ` +
          `"${field.type}" field, not a "fluid" field. Buoyancy needs a fluid ` +
          `region (waterline_y_m + density_kg_per_m3).`,
      });
      continue;
    }

    const density = field.density_kg_per_m3;
    const waterlineY = field.waterline_y_m;
    const floored = hasFloorBelowWaterline(surfaces, waterlineY);
    const appliesTo = Array.isArray(f.applies_to) ? f.applies_to : [];

    for (const id of appliesTo) {
      const body = bodiesById.get(id);
      if (!body) {
        issues.push({
          level: 'error',
          message:
            `buoyancy force participant "${id}" matches no body id. Check ` +
            `applies_to against the scene's bodies.`,
        });
        continue;
      }
      const verdict = classifyBuoyancyBody({
        mass_kg: body.mass_kg,
        width_m: body.width_m,
        height_m: body.height_m,
        pinned: body.pinned,
        fluidDensity: density,
        hasFloorBelowWaterline: floored,
      });
      if (verdict.feasible) continue;

      if (verdict.regime === 'degenerate') {
        issues.push({
          level: 'error',
          message:
            `buoyancy body "${id}" needs positive width_m + height_m ` +
            `(got width_m=${body.width_m}, height_m=${body.height_m}). The prism ` +
            `waterplane area A_wp = width_m × 1 m; width_m = 0 ⇒ d_eq = ∞/NaN. ` +
            `The disk / other-shape buoyancy cross-section is not derived in this slice.`,
        });
      } else if (verdict.regime === 'sinker_unfloored') {
        issues.push({
          level: 'error',
          message:
            `buoyancy body "${id}" is a SINKER (d_eq = ${verdict.d_eq.toFixed(4)} m ≥ ` +
            `height_m = ${body.height_m} m; ρ_body = ${verdict.bodyDensity.toFixed(1)} ` +
            `≥ ρ_fluid = ${density} kg/m³) but the scene has no floor below the ` +
            `waterline (y = ${waterlineY} m) for it to rest on. Add a floor surface ` +
            `(max(p1.y, p2.y) < ${waterlineY}), pin the body, or make it lighter/wider ` +
            `so 0 < d_eq < height_m.`,
        });
      }
    }
  }
  return issues;
}

export function runFluidChecks(scene) {
  const checks = [
    ['buoyancy_bodies_feasible', buoyancy_bodies_feasible],
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

export const NAME = 'fluid_validation';
