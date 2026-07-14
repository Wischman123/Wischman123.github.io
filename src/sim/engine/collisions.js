// engine/collisions.js
//
// Phase B item B4 — discrete perfectly-inelastic collision resolver.
//
// B1 ships CONTINUOUS contact (a penalty `ContactForce` in derivState): the
// spring always pushes the pair back apart, so it models PARTIAL inelasticity
// but can never reach e = 0 (true sticking). A perfectly-inelastic collision is
// a DISCRETE event — at contact the pair instantly adopts the common
// centre-of-mass velocity v_cm = Σp/Σm and the lost kinetic energy
// ΔK = K_before − K_after becomes thermal in that single tick. There is no
// continuous force to integrate, so a merge is NOT a Force and does not belong
// in `forces`/derivState. It is a STATE-MUTATING discrete resolver:
//
//   - It runs in the runner's step-3 slot (S3 invariant), AFTER syncBodies
//     (bodies hold the freshly integrated state) and BEFORE the tracker
//     snapshot, so K_after and the thermal deposit are consistent on the
//     collision tick (no one-tick drift blip).
//   - It mutates body velocities in place; `writebackState` (step 4) lands the
//     jump in the flat `state` array so it survives the next tick's unpack.
//   - It deposits ΔK via `tracker.addDissipated` (S2).
//
// Because it changes the BAND-CHECKED dynamics (velocities, K), a resolver runs
// in EVERY execution path — the live SimRunner AND the headless cli_headless
// validator (via the shared `applyCollisionResolvers` helper in scene.js) —
// kept in `loaded.collisionResolvers`, DISTINCT from the observation-only
// `loaded.discreteUpdates` (induction flux sampling, A0) which only feeds the
// live inspector/canvas. B4 is the first consumer of the S2 (addDissipated) +
// S3 (discrete slot + writebackState) infrastructure.
//
// STATELESS by design. The resolver holds NO per-run state: the merge condition
// is purely the current geometry (in contact AND approaching), and once the
// pair shares one velocity vRel = 0 exactly, so the guard self-suppresses any
// re-merge on the SAME tick's aftermath. Statelessness is load-bearing for the
// live timeline-scrub / replay path: seekTo() calls SimRunner.reset() (which
// restores state0 but does NOT rebuild loaded.collisionResolvers) and replays
// from t=0, so a persistent "already merged" latch would leak across the reset
// and silently skip the merge on the second scrub. With no latch, every replay
// re-detects contact and re-fires correctly.

import { contactGeom, weldPairKey } from './forces.js';

// Single source of truth for the collision-resolution modes the loader can
// dispatch. Lockstepped against scene.schema.json $defs.collision.mode.enum by
// body_merge.test.js so a schema-permitted mode can never reach a loader that
// would reject it (the anti-drift discipline B2's restitution mode needs).
//   - perfectly_inelastic (B4): the pair adopts ONE v_cm and sticks (both
//     velocity components merge); ALL relative KE → U_thermal.
//   - restitution (B2): a frictionless impulse along the contact normal with
//     coefficient e ∈ [0, 1]; only the NORMAL relative velocity changes (e=1
//     elastic, e=0 normal-stop with tangential slip surviving), ΔK =
//     ½μv_rel,n²(1−e²) → U_thermal. Distinct from the merge at e=0 off-axis.
//   - box_wall_reflection (P2 kinetic-theory): each body in applies_to bounces
//     elastically (e=1 ⇒ ΔK=0) off an axis-aligned box's four walls. Unlike the
//     two-body modes above, its applies_to is a GROUP (≥1 body, no upper bound) —
//     a wall reflection is per-body independent, not pairwise — so the loader
//     relaxes the "exactly 2" arity guard for THIS mode only. The delivered
//     normal impulse |J| = 2m|v_n| per hit is the raw wall-pressure signal,
//     accumulated on sceneCtx.wallImpulse (the diagnostic seam) for the producer.
//   - elastic_gas (P3 kinetic-theory): a whole GROUP of particles (≥2) collide
//     elastically (e=1) with EACH OTHER, thermalizing the gas toward the 2-D
//     Maxwell–Boltzmann speed distribution (wall bouncing alone freezes it). Its
//     applies_to is a GROUP of ≥2 bodies; the resolver scans all unordered pairs
//     each tick and resolves each contacting, approaching pair with the SAME
//     shared normal-impulse math the two-body restitution mode uses (ONE impulse
//     definition). Dilute regime (P1 verdict) ⇒ plain O(N²), no de-penetration.
export const COLLISION_MODES = ['perfectly_inelastic', 'restitution', 'box_wall_reflection', 'elastic_gas'];

// The four axis-aligned walls, in the fixed order the resolver and producer both
// iterate. Kept as a named export so the per-tick wall-impulse Map keys are a
// single source of truth (no stringly-typed drift between resolver and producer).
export const BOX_WALLS = ['left', 'right', 'bottom', 'top'];

export class PerfectlyInelasticMerge {
  // applies_to: exactly the two body ids that stick on contact.
  constructor({ applies_to }) {
    this.applies_to = applies_to;
  }

  // Discrete resolution — called once per tick from the runner's step-3 slot.
  // Reads sceneCtx.bodies (the same body objects syncBodies just refreshed),
  // and if the pair is in contact AND approaching, sets both to v_cm and
  // deposits the lost kinetic energy. tracker is passed in (not captured) so
  // the same resolver object works in both the live runner and cli_headless.
  resolve(sceneCtx, tracker) {
    const bodies = sceneCtx?.bodies;
    if (!bodies) return;
    const a = bodies.find((x) => x.id === this.applies_to[0]);
    const b = bodies.find((x) => x.id === this.applies_to[1]);
    if (!a || !b) return;

    // STAND DOWN once this pair has been WELDED (orbit_weld_on_contact). A
    // contact-activated body_rod has taken ownership of the pair's relative motion, and
    // the merge's job — the one-time inelastic capture — is already done. Three reasons
    // this is a guard and not an optimisation:
    //
    //   1. PHYSICS. Re-firing would be re-colliding an already-welded rigid object with
    //      itself. There is no second collision to resolve.
    //   2. NUMERICS. This is the one that actually bites. A welded pair is co-moving, so
    //      vRel ≈ 0 and kBefore ≈ kAfter — and ΔK = kBefore − kAfter becomes a difference
    //      of two nearly-identical floats. Catastrophic cancellation makes it come out at
    //      ±1e-16, i.e. NOISE AROUND ZERO, and the (correct, strict) negative-ΔK guard
    //      below then throws and kills the run. Observed: the Dawn full-orbit coast died
    //      at step 10514 with ΔK = −1.11e-16.
    //   3. ENERGY. The rod's micro-oscillation would otherwise make the pair register as
    //      "approaching" on half of every cycle, bleeding a slow spurious trickle into
    //      U_thermal for the rest of the run.
    //
    // The ordering that makes this correct is guaranteed at load: scene.js appends the
    // weld rods to collisionResolvers AFTER the collision resolvers, so on the contact
    // tick the merge fires FIRST (doing the real capture) and the rod latches SECOND.
    // The suppression therefore begins on the tick AFTER the capture, never on it.
    if (sceneCtx.weldedPairs?.has(weldPairKey(a.id, b.id))) return;

    const g = contactGeom(a, b);
    // Merge only on real contact (depth > 0) AND while approaching (vRel < 0).
    // After a merge the pair shares one velocity ⇒ vRel = 0 exactly, so this
    // guard alone blocks an immediate re-merge — the resolver needs no latch.
    if (!g || g.vRel >= 0) return;

    const ma = a.mass;
    const mb = b.mass;
    const M = ma + mb;
    // K before (full 2-D velocity).
    const kBefore = 0.5 * ma * (a.velocity.x ** 2 + a.velocity.y ** 2)
                  + 0.5 * mb * (b.velocity.x ** 2 + b.velocity.y ** 2);
    // Common centre-of-mass velocity — conserves total momentum exactly.
    const vcmX = (ma * a.velocity.x + mb * b.velocity.x) / M;
    const vcmY = (ma * a.velocity.y + mb * b.velocity.y) / M;
    a.velocity.x = vcmX;
    a.velocity.y = vcmY;
    b.velocity.x = vcmX;
    b.velocity.y = vcmY;
    const kAfter = 0.5 * M * (vcmX ** 2 + vcmY ** 2);

    // A merge can only REMOVE the centre-of-mass-frame kinetic energy, so
    // ΔK ≥ 0. A negative value would mean energy was created — a logic bug,
    // not a tolerance issue — so fail loudly rather than poison U_thermal.
    const dK = kBefore - kAfter;
    if (dK < 0) {
      throw new Error(
        `PerfectlyInelasticMerge: negative ΔK=${dK} for pair ` +
        `(${this.applies_to[0]}, ${this.applies_to[1]}). A merge cannot create ` +
        `kinetic energy — check the masses/velocities.`
      );
    }
    tracker.addDissipated(dK); // addDissipated itself rejects a non-finite ΔK

    // POINT-PARTICLE merge: both bodies adopt v_cm and ALL relative kinetic
    // energy (including any tangential component) becomes thermal. This is
    // exactly right for `particle` bodies. A future B2 extended-/rigid-body
    // OBLIQUE merge that sticks at an offset contact point would conserve
    // angular momentum about the CM and retain some KE as rotation — that is
    // NOT modelled here and would need separate treatment.
  }
}

// Shared pairwise restitution impulse — the SINGLE normal-impulse definition
// used by BOTH the two-body RestitutionImpulse resolver AND the many-body
// ElasticGasCollisions group resolver (P3). Extracting it (library-first) means
// a gas collision is byte-for-byte the same physics as a two-body elastic hit —
// there is ONE impulse formula to verify, not two that can silently drift.
//
// Resolves the pair (a, b) at coefficient of restitution e IF they are in real
// contact (contactGeom depth > 0) AND approaching (vRel < 0); otherwise a no-op.
// The impulse is equal-and-opposite along the contact normal (Σp conserved for
// any e); ΔK = ½μv_rel,n²(1−e²) is deposited to the tracker (0 for e=1 elastic).
// Returns true iff an impulse was applied (lets a caller count live contacts).
export function resolveRestitutionPair(a, b, e, tracker) {
  const g = contactGeom(a, b);
  // Resolve only on real contact (depth > 0) AND while approaching (vRel < 0).
  // After an ELASTIC bounce vRel,n flips POSITIVE (the pair separates within ~1
  // tick), so this guard alone blocks a re-fire on the aftermath ticks — the
  // resolver needs no latch and is timeline-scrub / replay safe.
  if (!g || g.vRel >= 0) return false;

  const ma = a.mass;
  const mb = b.mass;
  const vRelN = g.vRel; // (v_a − v_b)·n, < 0 here (approaching)
  // Scalar impulse along n imposing v'_rel,n = −e·v_rel,n while conserving
  // momentum: J = −(1+e) v_rel,n / (1/m_a + 1/m_b). J > 0 since vRelN < 0.
  const J = -(1 + e) * vRelN / (1 / ma + 1 / mb);
  a.applyImpulse({ x: J * g.n.x, y: J * g.n.y });
  b.applyImpulse({ x: -J * g.n.x, y: -J * g.n.y });

  // Energy removed = reduced-mass KE of the NORMAL approach component, scaled by
  // (1 − e²). Frictionless: the tangential relative velocity is untouched and
  // carries no loss. ΔK ≥ 0 for e ∈ [0, 1]; a negative value means energy was
  // created (an e>1 or sign bug on a schema-bypass path) — fail loudly rather
  // than poison U_thermal. e = 1 ⇒ ΔK = 0 (no deposit; U_thermal stays 0).
  const mu = (ma * mb) / (ma + mb);
  const dK = 0.5 * mu * vRelN * vRelN * (1 - e * e);
  if (dK < 0) {
    throw new Error(
      `resolveRestitutionPair: negative ΔK=${dK} for pair (${a.id}, ${b.id}) ` +
      `at e=${e}. A frictionless impulse cannot create kinetic energy.`
    );
  }
  if (dK > 0) tracker.addDissipated(dK); // addDissipated rejects non-finite ΔK
  return true;
}

// Phase B item B2 — discrete restitution-impulse resolver (2-D collisions).
//
// The general 0 ≤ e ≤ 1 sibling of the perfectly-inelastic merge. Where the
// merge fixes e = 0 AND sticks both bodies fully (both velocity components → one
// v_cm), this applies a FRICTIONLESS impulse along the contact normal: only the
// NORMAL relative velocity is changed (set to −e times the approach speed,
// Newton's restitution law); the TANGENTIAL relative velocity is untouched, so
// the bodies slide past rather than stick. For a head-on 1-D hit e=0 coincides
// with the merge; off-axis the two differ (the merge zeroes the tangential slip,
// this preserves it). e=1 reproduces the analytical elastic result a penalty
// `ContactForce` only approximates.
//
// Same discrete-resolver contract as PerfectlyInelasticMerge: state-mutating,
// runs in the step-3 slot via the shared `applyCollisionResolvers` helper +
// SimRunner._advanceOne, STATELESS (no latch), deposits ΔK via S2 addDissipated.
// The impulse is equal-and-opposite along the normal, so total momentum is
// conserved by construction for ANY e (the S4 linearMomentumTracker reports
// rounding-scale drift).
export class RestitutionImpulse {
  // applies_to: exactly the two colliding body ids.
  // coefficient_restitution e ∈ [0, 1]. Validated HERE (not only at the schema
  // boundary) because resolvers run on schema-bypass paths — programmatically
  // built scenes (the body_merge.test mergeScene helper) and hot-reload — exactly
  // the rationale scene.js's InvalidMomentOfInertiaError runtime guard documents.
  // A missing e arrives as undefined (Ajv runs without useDefaults), so the
  // LOADER applies `?? 1`; this guard then catches only genuinely out-of-range e.
  constructor({ applies_to, coefficient_restitution = 1 }) {
    const e = coefficient_restitution;
    if (!(e >= 0 && e <= 1)) {
      throw new Error(
        `RestitutionImpulse: coefficient_restitution must be in [0, 1], got ${e}. ` +
        `(e=1 elastic; e=0 stops the normal approach, tangential slip survives.)`
      );
    }
    this.applies_to = applies_to;
    this.e = e;
  }

  // Discrete resolution — runner step-3 slot, identical contract to
  // PerfectlyInelasticMerge.resolve. tracker is passed in (not captured) so the
  // same object works in the live runner and cli_headless.
  resolve(sceneCtx, tracker) {
    const bodies = sceneCtx?.bodies;
    if (!bodies) return;
    const a = bodies.find((x) => x.id === this.applies_to[0]);
    const b = bodies.find((x) => x.id === this.applies_to[1]);
    if (!a || !b) return;
    // Delegate to the ONE shared normal-impulse definition (library-first) — the
    // same helper the many-body ElasticGasCollisions group resolver calls, so a
    // gas collision is byte-for-byte the same physics as this two-body hit.
    resolveRestitutionPair(a, b, this.e, tracker);
  }
}

// P2 (kinetic-theory box) — elastic reflection off an axis-aligned box's walls.
//
// The gas needs physical WALLS the two-body resolvers above cannot express:
// contactGeom (forces.js) detects only body↔body circular overlap, and the
// engine has no wall/box geometry. BoxWallReflection is the third discrete
// resolver, sharing the exact `.resolve(sceneCtx, tracker)` contract as its two
// siblings (state-mutating, runs in the step-3a slot, STATELESS — no per-run
// latch), but differing in two ways:
//   1. applies_to is a GROUP (every body that lives inside the box), not a pair.
//      A wall bounce is per-body independent, so the resolver loops its bodies.
//   2. The reflecting surface is the schema-declared box (min/max corners), not
//      another body. A body reflects when its CENTRE leaves the inner band
//      [min+r, max-r] on an axis AND is still moving further out on that axis.
//
// Elastic (e = 1): the reflection flips only the outward normal velocity
// component (v_n → −v_n), so |v| and K are unchanged — nothing is deposited to
// the tracker (U_thermal stays a clean 0, exactly like RestitutionImpulse's e=1
// branch). The delivered normal impulse per hit is |J| = 2·m·|v_n| (the change
// in the body's momentum along the wall normal). That |J| is summed onto
// sceneCtx.wallImpulse — the per-tick, instantaneous diagnostic seam a companion
// producer reads (see engine/kinetic_theory.js). The seam is REBUILT from zero
// at the top of every resolve() (so it holds THIS tick's impulse only, never a
// run-length cumulative that a timeline scrub could not finite-difference).
//
// The "still moving outward" guard is what makes the resolver latch-free: once a
// wall flips v_n inward, the next tick sees v_n pointing IN, so no re-flip fires
// even while the centre is still marginally outside the band — the same
// self-suppression the vRel<0 guard gives the two-body resolvers. A body that
// straddles a corner (outside the band on BOTH axes) reflects on each axis
// independently in the same tick; the two axes are decoupled, so |v| is still
// conserved.
export class BoxWallReflection {
  // applies_to: the ids of every body that reflects off this box (≥ 1).
  // box: { min: {x, y}, max: {x, y} } — the axis-aligned wall corners. Validated
  // HERE (not only at the schema boundary) because resolvers run on schema-bypass
  // paths (programmatically built scenes, hot-reload), mirroring the guards in
  // RestitutionImpulse / scene.js's InvalidMomentOfInertiaError.
  constructor({ applies_to, box }) {
    if (!Array.isArray(applies_to) || applies_to.length < 1) {
      throw new Error('BoxWallReflection: applies_to must list at least one body id.');
    }
    const ok = box && box.min && box.max
      && box.max.x > box.min.x && box.max.y > box.min.y;
    if (!ok) {
      throw new Error(
        `BoxWallReflection: box must be { min:{x,y}, max:{x,y} } with max > min on ` +
        `both axes (got ${JSON.stringify(box)}).`
      );
    }
    this.applies_to = applies_to;
    this.box = box;
  }

  // Discrete resolution — runner step-3a slot, identical contract to the two-body
  // resolvers. tracker is passed in (not captured) so the same object works in the
  // live runner and cli_headless. Reflects every out-of-band, still-exiting body
  // and records the delivered |J| onto sceneCtx.wallImpulse for THIS tick.
  resolve(sceneCtx, tracker) {
    const bodies = sceneCtx?.bodies;
    if (!bodies) return;

    // Rebuild the per-tick wall-impulse seam from zero. Instantaneous by design:
    // the render layer time-averages these per-tick samples into pressure, which
    // survives timeline_scrub's suppressed onTick stream (a cumulative counter
    // would read as undefined after a scrub — deep-review's corrected seam).
    let wallImpulse = sceneCtx.wallImpulse;
    if (!wallImpulse) {
      wallImpulse = new Map();
      sceneCtx.wallImpulse = wallImpulse;
    }
    for (const w of BOX_WALLS) wallImpulse.set(w, 0);

    const { min, max } = this.box;
    for (const id of this.applies_to) {
      const b = bodies.find((x) => x.id === id);
      if (!b) continue;
      const r = b.radius;
      const m = b.mass;
      // X axis — left / right walls. Reflect only when the centre is outside the
      // inner band AND still moving further out (v points toward that wall's
      // outside). |J| = 2m|v_x| is the momentum change of the elastic flip.
      if (b.position.x < min.x + r && b.velocity.x < 0) {
        wallImpulse.set('left', wallImpulse.get('left') + 2 * m * Math.abs(b.velocity.x));
        b.velocity.x = -b.velocity.x;
      } else if (b.position.x > max.x - r && b.velocity.x > 0) {
        wallImpulse.set('right', wallImpulse.get('right') + 2 * m * Math.abs(b.velocity.x));
        b.velocity.x = -b.velocity.x;
      }
      // Y axis — bottom / top walls (decoupled from X, so a corner hit flips both).
      if (b.position.y < min.y + r && b.velocity.y < 0) {
        wallImpulse.set('bottom', wallImpulse.get('bottom') + 2 * m * Math.abs(b.velocity.y));
        b.velocity.y = -b.velocity.y;
      } else if (b.position.y > max.y - r && b.velocity.y > 0) {
        wallImpulse.set('top', wallImpulse.get('top') + 2 * m * Math.abs(b.velocity.y));
        b.velocity.y = -b.velocity.y;
      }
    }
    // e = 1 elastic ⇒ ΔK = 0 for every reflection, so the tracker is untouched
    // (U_thermal stays 0). `tracker` is in the signature for contract parity with
    // the two-body resolvers, which DO deposit ΔK.
  }
}

// P3 (kinetic-theory box) — many-body elastic inter-particle collisions.
//
// The gas needs a whole GROUP of particles to collide elastically WITH EACH
// OTHER so the speed distribution can thermalize toward the 2-D Maxwell–Boltzmann
// (Rayleigh) form — pure wall bouncing (P2) preserves every particle's speed
// forever, so the histogram never relaxes. The engine's two-body resolvers cannot
// express this: a box of N particles is O(N²) pairs, and the loader is strictly
// pairwise. ElasticGasCollisions is the fourth discrete resolver, sharing the
// exact `.resolve(sceneCtx, tracker)` contract (state-mutating, runs in the
// step-3a slot, STATELESS — no per-run latch), but differing in two ways:
//   1. applies_to is a GROUP (every gas particle, ≥2), not a pair; it scans all
//      unordered pairs each tick.
//   2. It resolves each contacting, approaching pair with the SHARED
//      resolveRestitutionPair helper at e = 1 — the SAME normal-impulse math the
//      two-body RestitutionImpulse uses, so a gas collision is byte-for-byte a
//      two-body elastic hit (ONE impulse definition, not a reimplementation).
//
// Dilute regime (P1 verdict — kinetic_theory_params.js: KT_REGIME='dilute',
// phi≈0.047): a plain O(N²) all-pairs scan IS the whole resolver — NO positional
// de-penetration, NO spatial hash (those are only needed in a dense gas, which P1
// ruled out). Elastic (e=1) ⇒ every pair conserves K and Σp exactly, so total K
// and total momentum are conserved to rounding over any run, and nothing is
// deposited to the tracker (U_thermal stays a clean 0). The shared helper's
// g.vRel<0 guard resolves each pair at most once per approach (self-suppressing on
// the separating aftermath), so at the dilute packing where multi-contact is rare
// no de-penetration step is needed to prevent a re-fire.
export class ElasticGasCollisions {
  // applies_to: the ids of every gas particle in the group (≥ 2). e is fixed at 1
  // (elastic) — this mode exists precisely to thermalize WITHOUT dissipation; a
  // lossy gas would use per-pair `restitution` entries instead. Validated HERE
  // (not only at the schema boundary) because resolvers run on schema-bypass paths
  // (programmatically built scenes, hot-reload), mirroring the sibling guards.
  constructor({ applies_to }) {
    if (!Array.isArray(applies_to) || applies_to.length < 2) {
      throw new Error('ElasticGasCollisions: applies_to must list at least two body ids.');
    }
    this.applies_to = applies_to;
    this.e = 1;
  }

  // Discrete resolution — runner step-3a slot, identical contract to the other
  // resolvers. Scans all unordered pairs in the group and resolves each contacting,
  // approaching pair via the shared elastic impulse. tracker is passed in (not
  // captured) so the same object works in the live runner and cli_headless; for
  // e=1 it is never written (ΔK=0), present only for contract parity.
  resolve(sceneCtx, tracker) {
    const bodies = sceneCtx?.bodies;
    if (!bodies) return;
    // Gather the group's live body objects once (the same objects syncBodies just
    // refreshed), skipping any id that does not resolve — mirrors the two-body
    // resolvers' `if (!a || !b) return` tolerance on a schema-bypass path.
    const group = [];
    for (const id of this.applies_to) {
      const b = bodies.find((x) => x.id === id);
      if (b) group.push(b);
    }
    // All unordered pairs, dilute O(N²). Each pair resolves at most once per tick;
    // the shared helper's g.vRel<0 guard self-suppresses a re-fire on the aftermath.
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        resolveRestitutionPair(group[i], group[j], this.e, tracker);
      }
    }
  }
}

export const NAME = 'collisions';
