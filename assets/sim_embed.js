/* sim_embed.js -- the SW1 accessibility wrapper for embedded sim scenes.
 *
 * WHAT IT GUARANTEES (the §5 embed contract SW2's T1-b scenes rely on):
 *   poster      A static poster is shown FIRST; nothing animates on load. The
 *               live iframe/canvas is created ONLY after an explicit user
 *               engage (poster-before-engage; canvas-painted-only-after-click).
 *   lazy        The iframe is not created until engage AND the card is near/in
 *               the viewport -- no offscreen scene ever loads or paints.
 *   PRM         prefers-reduced-motion: NO autoplay ever; the engage button
 *               reads "Step through" and the scene is asked to pause
 *               immediately after load, so motion happens only on user action.
 *   pause       A real <button> toggles pause (keyboard operable; the whole
 *               control set is <button>s, not click-only divs).
 *   visibility  An IntersectionObserver pauses the scene when it scrolls out
 *               of view; document `visibilitychange` pauses it when the tab is
 *               hidden. Both send a postMessage the vendored app honors.
 *
 * MARKUP CONTRACT (SW2 authors this; the wrapper upgrades it):
 *   <div class="sim-embed" data-sim-embed
 *        data-src="sim/index.html?scene=coulomb_two_body"
 *        data-poster="assets/poster_coulomb.png"
 *        data-label="Coulomb two-body, live">
 *   </div>
 * The wrapper sets data-sim-state = "poster" | "live" | "paused" on the root so
 * the screenshot harness (screenshot_wing.mjs) can assert the state machine.
 *
 * No external dependencies; no network beyond the same-origin scene iframe.
 */
(function () {
  "use strict";

  var PRM = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)");
  function reducedMotion() { return !!(PRM && PRM.matches); }

  // Ask the vendored sim for MINIMAL CHROME + AUTOPLAY (systems_wing_review
  // W3). The sim reads this &embed=1 flag (resolveEmbedChrome in the vendored
  // ui/embed_boot.js): it hides its authoring UI so the frame shows only the
  // live canvas, and autoplays on load (unless prefers-reduced-motion). Kept
  // OFF data-src so the visible "full simulator" link can reuse the clean
  // scene URL for the full-chrome view.
  function withEmbedFlag(url) {
    if (!url) return url;
    return url + (url.indexOf("?") >= 0 ? "&" : "?") + "embed=1";
  }

  function postToScene(iframe, type) {
    if (!iframe || !iframe.contentWindow) return;
    try {
      iframe.contentWindow.postMessage({ source: "sim_embed", type: type }, "*");
    } catch (e) { /* cross-origin / not ready -- best effort */ }
  }

  function makeButton(label, cls) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = cls;
    b.textContent = label;
    return b;
  }

  function upgrade(root) {
    if (root.__simEmbedUpgraded) return;
    root.__simEmbedUpgraded = true;

    var src = root.getAttribute("data-src") || "";
    var poster = root.getAttribute("data-poster") || "";
    var label = root.getAttribute("data-label") || "Interactive scene";
    var stepMode = reducedMotion();

    root.setAttribute("data-sim-state", "poster");
    root.setAttribute("role", "group");
    root.setAttribute("aria-label", label);

    // -- poster layer (shown before engage) --------------------------------
    var posterWrap = document.createElement("div");
    posterWrap.className = "sim-embed__poster";
    if (poster) {
      var img = document.createElement("img");
      img.src = poster;
      img.alt = label + " -- static preview; activate to run the live scene";
      img.loading = "lazy";
      img.decoding = "async";
      posterWrap.appendChild(img);
    } else {
      posterWrap.textContent = label;
    }

    var engage = makeButton(stepMode ? "Step through" : "Run scene",
                            "sim-embed__engage");
    engage.setAttribute("aria-label",
      (stepMode ? "Step through " : "Run ") + label +
      " (reduced motion respected)");
    posterWrap.appendChild(engage);
    root.appendChild(posterWrap);

    // -- live layer (created lazily on engage) -----------------------------
    var live = null;       // iframe
    var controls = null;   // control bar
    var observer = null;
    var pauseBtn = null;   // the single Pause/Resume toggle (set by ensureControls)

    // SINGLE STATE SETTER (source of truth). Every user play/pause transition --
    // the Pause button, a scene click, and Restart -- routes through here so
    // data-sim-state and the Pause/Resume button LABEL can never diverge. A
    // scene-click pause that only set data-sim-state would leave the button
    // reading "Pause", so the next button press would post a contradictory
    // "pause" instead of "resume". `message` is what we post to the scene (may
    // be null to set UI state without posting); `state` is the resulting
    // wrapper state, "live" | "paused".
    function applyState(state, message) {
      if (message) postToScene(live, message);
      root.setAttribute("data-sim-state", state);
      if (pauseBtn) pauseBtn.textContent = (state === "paused") ? "Resume" : "Pause";
    }

    // Toggle play<->pause through the single setter -- shared by the Pause
    // button AND the scene click, so the two controls always agree.
    function toggle() {
      var paused = root.getAttribute("data-sim-state") === "paused";
      applyState(paused ? "live" : "paused", paused ? "resume" : "pause");
    }

    // Click-to-toggle: a click ON the scene toggles pause/resume (matches "by
    // clicking on it"), on TOP of the keyboard-operable buttons (click-on-canvas
    // is not keyboard reachable, so the buttons stay the accessible path). The
    // scene is same-origin (relative data-src, no sandbox attr), so
    // contentDocument is reachable -- but GUARD the access (try/null-check) so a
    // scene ever made cross-origin degrades to buttons-only instead of throwing.
    // The sim's canvas is drag-interactive (grab + drag a body); a short
    // drag-release can synthesize a `click`, so gate the toggle on the pure
    // click-vs-drag predicate (SimEmbedGesture.isClickNotDrag): toggle only when
    // the pointer stayed within the move threshold in BOTH axes.
    function attachClickToToggle() {
      var doc;
      try { doc = live.contentDocument; } catch (e) { doc = null; }
      if (!doc) return;                        // cross-origin -> buttons-only
      var gesture = window.SimEmbedGesture;
      var downPt = null;
      doc.addEventListener("pointerdown", function (e) {
        downPt = { x: e.clientX, y: e.clientY };
      });
      doc.addEventListener("click", function (e) {
        var dx = downPt ? (e.clientX - downPt.x) : 0;
        var dy = downPt ? (e.clientY - downPt.y) : 0;
        downPt = null;
        // A measured drag (moved past threshold) is NOT a toggle. If the
        // predicate is somehow unavailable, fall through to toggle (the raw
        // `click` already implies press+release on one target).
        if (gesture && !gesture.isClickNotDrag(dx, dy)) return;
        toggle();
      });
    }

    function ensureControls() {
      if (controls) return;
      controls = document.createElement("div");
      controls.className = "sim-embed__controls";

      pauseBtn = makeButton("Pause", "sim-embed__pause");
      pauseBtn.addEventListener("click", toggle);
      controls.appendChild(pauseBtn);

      // Restart (the ↺ glyph): replay the scene from t=0. The sim runs each
      // scene out its fixed duration, so without this a finished scene cannot be
      // re-watched. Posts {source:"sim_embed", type:"restart"}; the vendored app
      // routes it to a full reset-to-t0-then-play (embed_boot EMBED_RESTART ->
      // main.embedRestart). A restart always lands LIVE, so the setter also puts
      // the Pause label back to "Pause".
      var restart = makeButton("↺", "sim-embed__restart");
      restart.setAttribute("aria-label", "Restart scene from the beginning");
      restart.setAttribute("title", "Restart");
      restart.addEventListener("click", function () {
        applyState("live", "restart");
      });
      controls.appendChild(restart);

      root.appendChild(controls);
    }

    function engageScene() {
      if (live) return;
      live = document.createElement("iframe");
      live.className = "sim-embed__frame";
      live.title = label;
      live.setAttribute("loading", "lazy");
      live.src = withEmbedFlag(src);
      live.addEventListener("load", function () {
        // reduced-motion: pause immediately so no autonomous motion runs
        // (belt-and-suspenders: the sim also refuses to autoplay under PRM).
        if (stepMode) applyState("paused", "pause");
        // Wire click-on-scene -> pause/resume once the same-origin document exists.
        attachClickToToggle();
      });
      root.replaceChild(live, posterWrap);
      ensureControls();
      // Initial UI state through the single setter (no message: the sim decides
      // autoplay from &embed=1 / PRM), so data-sim-state AND the button label
      // start coherent.
      applyState(stepMode ? "paused" : "live", null);

      // visibility: pause offscreen (IntersectionObserver) ...
      if ("IntersectionObserver" in window) {
        observer = new IntersectionObserver(function (entries) {
          entries.forEach(function (en) {
            if (en.isIntersecting) {
              if (!stepMode) { postToScene(live, "resume"); }
            } else {
              postToScene(live, "pause");
            }
          });
        }, { threshold: 0.1 });
        observer.observe(root);
      }
    }

    engage.addEventListener("click", engageScene);

    // ... and pause when the tab is hidden.
    document.addEventListener("visibilitychange", function () {
      if (document.hidden && live) postToScene(live, "pause");
    });
  }

  function init() {
    var nodes = document.querySelectorAll("[data-sim-embed]");
    for (var i = 0; i < nodes.length; i++) upgrade(nodes[i]);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // Expose for tests / manual re-scan after dynamic insertion.
  window.SimEmbed = { init: init, upgrade: upgrade, reducedMotion: reducedMotion };
})();
