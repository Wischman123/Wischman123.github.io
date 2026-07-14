/* sim_embed_gesture.js -- the click-vs-drag DECISION POINT for the SW1 wrapper's
 * click-to-toggle pause/resume (systems_wing_ux_fixes_v1 P3).
 *
 * WHY THIS IS ITS OWN FILE: the wrapper (sim_embed.js) attaches a `click`
 * listener to the embedded scene's document so a reader can click the scene to
 * pause/resume. But the sim's canvas is also drag-interactive (grab a body,
 * drag it). A short drag-release can synthesize a `click`, which would wrongly
 * toggle pause. The guard is a pointer MOVE threshold: a gesture that travels
 * <= threshold px in BOTH axes is a click (toggle); more than that in either
 * axis is a drag (do NOT toggle).
 *
 * That is a DECISION the recurring-shape-bug rule says to pull OUT of the inline
 * heuristic and unit-test at the boundary (below-threshold -> toggle; above ->
 * no toggle), mirroring how the physics repo pulled the pause/resume classify
 * decision out into embed_boot.js. So the predicate lives here, pure and
 * DOM-free, consumed by BOTH the browser wrapper (window.SimEmbedGesture) and a
 * node --test (tools/tests/sim_embed_gesture.test.mjs) -- one source of truth.
 *
 * UMD-ish: attaches to the browser global when loaded as a classic <script>,
 * and exports via CommonJS when required/imported by the node test. No DOM,
 * no globals touched beyond the single namespace.
 */
(function (root, factory) {
  "use strict";
  var api = factory();
  // Node (node --test): CommonJS export so the test can import the predicate.
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  // Browser: expose on the global so the classic-script wrapper can read it.
  if (root) root.SimEmbedGesture = api;
})(typeof window !== "undefined"
     ? window
     : (typeof globalThis !== "undefined" ? globalThis : null),
   function () {
  "use strict";

  // The move threshold, in CSS pixels, separating a CLICK from a DRAG. A
  // pointer that travels this far or less in BOTH axes between pointerdown and
  // the click is treated as a click (toggle pause/resume); anything larger in
  // either axis is a drag (a body was being dragged, or the reader was
  // selecting) and must NOT toggle. 6px matches the ballpark browsers use to
  // separate a click from the start of a drag/selection.
  var CLICK_MOVE_THRESHOLD_PX = 6;

  /**
   * Pure predicate: is this pointer gesture a click (not a drag)?
   *
   * @param {number} dx  clientX(up) - clientX(down), in CSS px.
   * @param {number} dy  clientY(up) - clientY(down), in CSS px.
   * @param {number} [threshold]  override the default move threshold.
   * @returns {boolean} true iff the pointer stayed within `threshold` px in
   *          BOTH axes (a click -> toggle); false if it moved more in either
   *          axis (a drag -> do not toggle). Non-finite deltas -> false (be
   *          conservative: never toggle on a gesture we cannot measure).
   */
  function isClickNotDrag(dx, dy, threshold) {
    var t = (typeof threshold === "number") ? threshold : CLICK_MOVE_THRESHOLD_PX;
    if (!isFinite(dx) || !isFinite(dy)) return false;
    return Math.abs(dx) <= t && Math.abs(dy) <= t;
  }

  return {
    CLICK_MOVE_THRESHOLD_PX: CLICK_MOVE_THRESHOLD_PX,
    isClickNotDrag: isClickNotDrag,
  };
});
