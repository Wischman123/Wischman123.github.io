// ui/pointer_drag.js
//
// T8 pointer→edit adapter — the UI-layer HALF of the live position-poke
// seam. The engine half (engine/position_poke.js applyPositionPoke +
// SimRunner.pokeBody) mutates a RUNNING engine state in place; THIS module
// turns a canvas pointer-drag gesture into the stream of
// {body_id, position_m, velocity_m_per_s} poke commands that drive it.
//
// Library-layer and body-type-agnostic: it drags ANY non-pinned physics
// body — the rail-brake conducting rod (T9) and a plain falling ball
// alike — so a future sim inherits drag for free the moment it ships a
// draggable body (the §2 "second consumer = a non-rod physics body"
// pledge). It never imports the renderer, the runner, or the DOM: all I/O
// is injected (pickBody / pxToWorld / pokeBody), so the whole gesture
// state machine is unit-tested headless (ui/__tests__/pointer_drag.test.js,
// written first per project principle 2). main.js supplies the real
// renderer/runner functions + the thin pointerdown/move/up DOM binding.
//
// Design decisions (plan sim_interactivity_viz T8, sub-parts a/b/c):
//   (a) CONTINUOUS re-solve — one poke per pointer-move. The seam exists
//       precisely because ui/inspector_edits.mergeEditsIntoScene rebuilds
//       the scene at t=0 on every call, which re-zeroes t and wipes the
//       circuit/induction/motion-graph buffers — fatal at ~60 Hz (plan
//       §0). This is NOT commit-on-release.
//   (b) ACCEPT any finite drop — a physics body has no valid-region
//       constraint: the engine has no overlap or off-canvas rule, and
//       circuit connectivity is netlist-defined and position-independent
//       (plan T8 scope), so a position poke can never break a scene. The
//       seam's finite-check is therefore the ONLY validity gate; a
//       non-finite poke (impossible from a real pointer, but pinned here)
//       is passed through and the seam rejects it with no mutation.
//   (c) INTERRUPTED drag COMMITS IN PLACE — every move is already
//       committed to live state, so pointer-up / pointer-cancel / lost
//       capture just ends the gesture with the body where it last landed.
//       Esc CANCELS (rolls the body back to its grab-time position). A
//       normal release zeroes velocity so a paused body rests at the
//       release point; T9's play-vs-drag state machine overrides the
//       release semantics under Play (resume from the released velocity).
//
// Circuit scenes stay OUT of scope with zero special-casing: their only
// body is a `pinned` placeholder, and defaultIsDraggable rejects pinned
// bodies — so a drag on a circuit schematic arms nothing and moves
// nothing, exactly as plan T8 requires ("circuit elements are NOT
// poke-able").

// A press that never travels this far (CSS px) stays a click — it selects
// a body via main.js's existing click handler but pokes nothing.
const DRAG_THRESHOLD_PX = 3;

// Pointer world-velocity over one move, in m/s. dt<=0 (a held-still
// pointer or the first sample) yields zero — a held pointer must read v=0
// so T9's EMF=BLv decays to 0, never a stale velocity (plan T9).
export function pointerVelocity(prevWorld, currWorld, dtSeconds) {
  if (!prevWorld || !currWorld || !(dtSeconds > 0)) return { x: 0, y: 0 };
  return {
    x: (currWorld.x - prevWorld.x) / dtSeconds,
    y: (currWorld.y - prevWorld.y) / dtSeconds,
  };
}

// A body is draggable iff it is a real, movable physics body: not pinned
// (pinned = a static placeholder / snapshot source — plan T8 scope) and
// carrying a finite position the poke can translate.
export function defaultIsDraggable(body) {
  return !!body
    && body.pinned !== true
    && !!body.position
    && Number.isFinite(body.position.x)
    && Number.isFinite(body.position.y);
}

export class PointerDragController {
  constructor({ pickBody, pxToWorld, pokeBody, isDraggable = defaultIsDraggable } = {}) {
    if (typeof pickBody !== 'function'
      || typeof pxToWorld !== 'function'
      || typeof pokeBody !== 'function') {
      throw new Error('PointerDragController requires pickBody, pxToWorld, pokeBody functions');
    }
    this.pickBody = pickBody;
    this.pxToWorld = pxToWorld;
    this.pokeBody = pokeBody;
    this.isDraggable = isDraggable;
    // Active gesture record, or null. Fields:
    //   bodyId       — the grabbed body
    //   startBodyPos — its world position at grab time (for delta + rollback)
    //   startWorld   — world location under the pointer at grab time
    //   startPx      — pixel location at grab time (for the click threshold)
    //   prevWorld/prevT — previous move sample (for the velocity estimate)
    //   moved        — has the pointer crossed the drag threshold yet?
    //   lastTarget   — the most recent poked world position (for commit)
    this._drag = null;
  }

  get dragging() { return this._drag !== null; }
  get draggingBodyId() { return this._drag ? this._drag.bodyId : null; }

  // Pointer-down. Hit-test px; if a DRAGGABLE body is under it, arm a drag
  // (no poke yet — a pure click must move nothing). Returns the armed body
  // id, or null (nothing draggable there → the caller treats it as a plain
  // select/click).
  begin(px, tSeconds) {
    const body = this.pickBody(px);
    if (!body || !this.isDraggable(body)) {
      this._drag = null;
      return null;
    }
    const startWorld = this.pxToWorld(px);
    this._drag = {
      bodyId: body.id,
      startBodyPos: { x: body.position.x, y: body.position.y },
      startWorld,
      startPx: { x: px.x, y: px.y },
      prevWorld: startWorld,
      prevT: tSeconds,
      moved: false,
      lastTarget: { x: body.position.x, y: body.position.y },
      lastVelocity: { x: 0, y: 0 },
    };
    return body.id;
  }

  // Pointer-move. Below the click threshold this is a no-op (a plain click
  // must not nudge the body). Past it, translate the body by the SAME world
  // delta the pointer travelled — grab-relative, so a body grabbed
  // off-center keeps its offset and does not snap its center to the cursor
  // — attach the pointer's world velocity, and poke. Returns the seam
  // verdict, or null when not dragging / still below threshold.
  move(px, tSeconds) {
    const d = this._drag;
    if (!d) return null;
    if (!d.moved) {
      const dpx = Math.hypot(px.x - d.startPx.x, px.y - d.startPx.y);
      if (dpx < DRAG_THRESHOLD_PX) return null;
      d.moved = true;
    }
    const world = this.pxToWorld(px);
    const target = {
      x: d.startBodyPos.x + (world.x - d.startWorld.x),
      y: d.startBodyPos.y + (world.y - d.startWorld.y),
    };
    const velocity = pointerVelocity(d.prevWorld, world, tSeconds - d.prevT);
    const verdict = this.pokeBody({
      body_id: d.bodyId,
      position_m: target,
      velocity_m_per_s: velocity,
    });
    d.prevWorld = world;
    d.prevT = tSeconds;
    d.lastTarget = target;
    // Remember this frame's pointer velocity so a release UNDER PLAY can
    // resume from it (T9). Under pause, end() zeroes it instead (T8).
    d.lastVelocity = velocity;
    return verdict;
  }

  // Pointer-up / pointer-cancel / lost capture — COMMIT IN PLACE. A pure
  // click (never crossed the threshold) commits nothing. A real drag
  // re-pokes the last position; the velocity depends on the play state:
  //   - PAUSED (default): velocity 0, so a paused body rests at the
  //     release point where the drag ended (T8 behavior).
  //   - PLAYING (`{ keepVelocity: true }`): the last drag velocity, so the
  //     rod resumes from the released velocity and the force integrator
  //     (e.g. the rail brake) takes over from there — the "Play resumes
  //     from the released velocity" half of the T9 state machine. A
  //     held-still release carries lastVelocity=0 ⇒ the rod rests, exactly
  //     as the paused case.
  // Returns the final seam verdict, or null for a pure click / no active drag.
  end({ keepVelocity = false } = {}) {
    const d = this._drag;
    this._drag = null;
    if (!d || !d.moved) return null;
    const velocity = keepVelocity && d.lastVelocity
      ? { x: d.lastVelocity.x, y: d.lastVelocity.y }
      : { x: 0, y: 0 };
    return this.pokeBody({
      body_id: d.bodyId,
      position_m: { x: d.lastTarget.x, y: d.lastTarget.y },
      velocity_m_per_s: velocity,
    });
  }

  // Esc — CANCEL. Roll the body back to its grab-time position, at rest.
  // A pure click / no active drag is a no-op.
  cancel() {
    const d = this._drag;
    this._drag = null;
    if (!d || !d.moved) return null;
    return this.pokeBody({
      body_id: d.bodyId,
      position_m: { x: d.startBodyPos.x, y: d.startBodyPos.y },
      velocity_m_per_s: { x: 0, y: 0 },
    });
  }
}
