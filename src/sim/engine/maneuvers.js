// engine/maneuvers.js
//
// dawn_last_burn_live_sim_v1 D2 — scheduled impulsive-Δv burn resolver.
//
// This is B5's IMPULSIVE-Δv dispatch slice (sim_expansion_roadmap.md): a
// discrete, scheduled velocity change — a rocket burn modelled as an
// instantaneous Δv kick, NOT a continuous variable-mass thrust force (that
// remains B5's open scope). A burn is a DISCRETE state-mutating event, the same
// category as a perfectly-inelastic merge, so it lives in the runner's step-3
// discrete slot (S3 invariant: after syncBodies, before the tracker snapshot;
// writebackState lands the velocity jump) — NOT a `forces` entry / derivState
// term. It is loaded into `loaded.maneuverResolvers`, a sibling of
// `loaded.collisionResolvers`, and shares the exact `.resolve(sceneCtx, tracker)`
// contract of the collision resolvers so it drops straight into the same slot
// (collisions.js is the structural template — do not reinvent).
//
// Two shipped seams do the physics (both verified against source in D1):
//   - body.applyImpulse(J)  (bodies.js ~66) — J = m·Δv·û adds J/m = Δv·û to the
//     velocity. The direction unit vector û is v̂ for prograde, −v̂ for retrograde,
//     or a normalized explicit { x, y }.
//   - tracker.addExternalWork(ΔK_burn)  (energy.js ~215) — the discrete sibling
//     of the W_external integral. The burn injects kinetic energy from unmodeled
//     fuel; booking ΔK_burn = ½m(|v_after|² − |v_before|²) to W_external in the
//     SAME tick keeps the closed budget `total = K + Σcontributions − W_external`
//     flat across the burn (no jump), so the drift-budget closure passes and the
//     fuel energy is honestly attributed to an external driver.
//
// STATELESS by design (the collisions.js discipline). The only fire condition is
// the live tick-time window stamped on sceneCtx.{tPrev,t}; the resolver holds NO
// "already fired" latch. A timeline scrub calls SimRunner.reset() and replays
// from t=0, so a persistent latch would leak across the reset and skip the burn
// on the second scrub. With no latch, every replay re-detects the window and
// re-fires correctly (D1 §1.1, proven on the real SimRunner + seekTo).

// Single source of truth for the burn HEADINGS the loader can dispatch, mirroring
// COLLISION_MODES (collisions.js). Lockstepped against
// scene.schema.json $defs.maneuver.properties.direction.oneOf[0].enum AND the
// browser validator's VALID_MANEUVER_DIRECTIONS by maneuver_schema.test.js, so a
// schema-permitted heading can never reach a loader/resolver that would reject
// it. An explicit { x, y } vector is a SEPARATE oneOf branch, not a named
// heading, so it is intentionally NOT a member of this list.
export const MANEUVER_DIRECTIONS = ['prograde', 'retrograde'];

// The PURE fire predicate — extracted so a unit test can hit its boundary
// directly (recurring-shape discipline: test the decision point, not just the
// through-runner behaviour). Half-open window (tPrev, tNow]:
//   fire  ⇔  tPrev < tBurn ≤ tNow
// Fires on exactly ONE tick for a monotonically advancing clock (right edge
// inclusive ⇒ the tick that ARRIVES at tBurn fires; left edge exclusive ⇒ the
// aftermath tick does not re-fire). Re-fires on a scrub-replay because it reads
// only the live tick window — no latch to leak across a reset. The t=0 edge: a
// real run's clock starts at t=0, so every real window has tPrev ≥ 0; the
// strict-left tPrev < tBurn therefore can never catch tBurn = 0 (which is also
// rejected at load), so a burn scheduled at t=0 is impossible by construction.
export function shouldFire(tPrev, tBurn, tNow) {
  return tPrev < tBurn && tBurn <= tNow;
}

// Resolve the burn heading to a UNIT vector at the burn tick. 'prograde' is v̂,
// 'retrograde' is −v̂, an explicit { x, y } is normalized (a raw vector must not
// rescale the Δv magnitude). Throws on a degenerate case (a prograde/retrograde
// burn on a stationary body, or a zero { x, y }) — the magnitude is physically
// undefined there, so fail loudly rather than emit NaN into the state vector.
export function burnUnit(body, direction) {
  if (direction === 'prograde' || direction === 'retrograde') {
    const s = Math.hypot(body.velocity.x, body.velocity.y);
    if (!(s > 0)) {
      throw new Error(
        `ScheduledImpulseBurn: a "${direction}" burn needs a moving body — body ` +
        `"${body.id}" has zero speed at the burn tick, so v̂ is undefined. Use an ` +
        `explicit { x, y } direction for a burn from rest.`
      );
    }
    const sign = direction === 'prograde' ? 1 : -1;
    return { x: (sign * body.velocity.x) / s, y: (sign * body.velocity.y) / s };
  }
  // Explicit { x, y } — normalize.
  const s = Math.hypot(direction.x, direction.y);
  if (!(s > 0)) {
    throw new Error(
      `ScheduledImpulseBurn: an explicit { x, y } direction must be a non-zero ` +
      `vector (got { x: ${direction.x}, y: ${direction.y} }); a zero vector has no ` +
      `heading to normalize.`
    );
  }
  return { x: direction.x / s, y: direction.y / s };
}

export class ScheduledImpulseBurn {
  // { body_id, t_burn_s, delta_v_m_per_s, direction }. Validated HERE (not only
  // at the schema boundary) because resolvers run on schema-bypass paths —
  // programmatically built scenes and hot-reload — exactly the rationale the
  // collision resolvers' runtime guards document. The schema pins the same
  // constraints, so a schema-validated scene never trips these; they catch a
  // hand-built scene that skips Ajv.
  constructor({ body_id, t_burn_s, delta_v_m_per_s, direction }) {
    if (typeof body_id !== 'string' || body_id.length === 0) {
      throw new Error('ScheduledImpulseBurn: body_id must be a non-empty string.');
    }
    if (!(t_burn_s > 0)) {
      throw new Error(
        `ScheduledImpulseBurn: t_burn_s must be > 0 (got ${t_burn_s}). The ` +
        `strict-left window tPrev < t_burn cannot fire an event scheduled at t=0.`
      );
    }
    if (!(delta_v_m_per_s > 0) || !Number.isFinite(delta_v_m_per_s)) {
      throw new Error(
        `ScheduledImpulseBurn: delta_v_m_per_s must be a finite magnitude > 0 ` +
        `(got ${delta_v_m_per_s}); the sign/heading is carried by direction.`
      );
    }
    const isNamed = MANEUVER_DIRECTIONS.includes(direction);
    const isVec = direction && typeof direction === 'object'
      && Number.isFinite(direction.x) && Number.isFinite(direction.y);
    if (!isNamed && !isVec) {
      throw new Error(
        `ScheduledImpulseBurn: direction must be one of ${MANEUVER_DIRECTIONS.join(', ')} ` +
        `or an explicit { x, y } vector (got ${JSON.stringify(direction)}).`
      );
    }
    this.body_id = body_id;
    this.t_burn = t_burn_s;
    this.dv = delta_v_m_per_s;
    this.direction = direction;
  }

  // Discrete resolution — called once per tick from the runner's step-3 slot
  // (inline in SimRunner._advanceOne) and from the shared applyManeuverResolvers
  // helper (cli_headless / round-trip). Reads the tick-time window stamped on
  // sceneCtx.{tPrev,t}; if it crosses t_burn, applies Δv·û via applyImpulse and
  // books ΔK_burn to W_external in the SAME tick. tracker is passed in (not
  // captured) so the same resolver object works in both execution paths.
  resolve(sceneCtx, tracker) {
    const tPrev = sceneCtx?.tPrev;
    const tNow = sceneCtx?.t;
    // Time-blind call (no window stamped) ⇒ never fire — a defensive no-op if a
    // future dispatch site forgets to stamp the window, rather than a silent
    // wrong-tick burn.
    if (!Number.isFinite(tPrev) || !Number.isFinite(tNow)) return;
    if (!shouldFire(tPrev, this.t_burn, tNow)) return;

    const bodies = sceneCtx?.bodies;
    if (!bodies) return;
    const body = bodies.find((b) => b.id === this.body_id);
    if (!body) return;

    const u = burnUnit(body, this.direction);
    const kBefore = body.kineticEnergy();
    // J = m·Δv·û ⇒ applyImpulse adds J/m = Δv·û to velocity (the shipped seam,
    // NOT a raw velocity poke).
    body.applyImpulse({ x: body.mass * this.dv * u.x, y: body.mass * this.dv * u.y });
    const kAfter = body.kineticEnergy();
    // Book the injected fuel energy to W_external so energy.total stays flat
    // (single global closure). addExternalWork rejects a non-finite ΔK.
    tracker.addExternalWork(kAfter - kBefore);
  }
}

export const NAME = 'maneuvers';
