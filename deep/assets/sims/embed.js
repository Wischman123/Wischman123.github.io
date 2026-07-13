/* embed.js — showcase-owned lazy-boot controller for the sim exhibit page
 * (showcase_live_sim_v1 L4). It does NOT render any physics: the REAL simulator
 * renders inside a same-origin <iframe>. This script only (1) progressively
 * enhances each exhibit with a "Run the simulation" control (so with JS OFF the
 * poster still + caption remain, with no dead control), (2) on activation
 * injects `<iframe src="../sim/index.html?scene=<id>&embed=1">` — never present
 * in the initial DOM (lazy boot; gate (o)), (3) pauses the embedded app on
 * scroll-out and RESTARTS it from t=0 on a true scroll-back (resuming only after
 * threshold flicker) using the app's OWN postMessage contract
 * `{ source:"sim_embed", type:"pause"|"resume"|"restart" }` (verified against
 * sim/ui/embed_boot.js::parseEmbedMessage — the wing doc's `{type:"sim:pause"}`
 * shape is drift), and (4) on a boot failure RETAINS the poster and shows an
 * explicit "couldn't load" state rather than a silent blank.
 */
(function () {
  'use strict';

  var MSG_SOURCE = 'sim_embed';   // sim/ui/embed_boot.js EMBED_MESSAGE_SOURCE
  var MSG_PAUSE = 'pause';        // EMBED_PAUSE
  var MSG_RESUME = 'resume';      // EMBED_RESUME
  var MSG_RESTART = 'restart';    // EMBED_RESTART -> main.js embedRestart() (reset to t=0, then play)
  var BOOT_TIMEOUT_MS = 9000;

  // Visibility band the embed is allowed to ANIMATE in. Below it the app is
  // paused (never animate a barely-visible embed); at ratio 0 the exhibit is
  // fully off-screen, which is what ARMS the restart (see setupExhibit).
  var PLAY_RATIO = 0.25;

  /* (5) NARROW-STAGE FIT — DO NOT CSS-SCALE THE IFRAME. (L7, second pass.)
   *
   * The real constraint is the sim's LOL panel: it is a FIXED-SIZE block
   * (lol_overlay.js PANEL_H_PX = 200, PANEL_MARGIN_PX = 16) anchored to the
   * canvas's top-right, so it needs ~216 CSS px of CANVAS HEIGHT — height, not
   * width — or its lower half (the per-store values and the `total =` / `drift =`
   * readouts) simply falls off the bottom of the canvas. On a 390px phone the
   * 16:10 stage is ~324x203, the app's toolbar eats ~65px, and the canvas is left
   * ~138px tall: the panel clips. THAT is the narrow-stage bug, and it is fixed
   * entirely in CSS — `.ex__frame` carries a min-height so a narrow stage gets a
   * TALLER box (see sims.html.j2). No JS sizing is needed: the iframe stays a
   * plain 100%x100% child, the app sees a real viewport, and its own resize
   * handler fits the camera.
   *
   * The FIRST pass tried to hand the app a 960x600 "design viewport" and CSS-scale
   * it down (transform: scale). NEVER DO THAT. A CSS-transformed (or zoomed)
   * iframe containing a live <canvas> composites a STALE raster in Chromium: the
   * parent page paints a frame that does not match the canvas's backing store, so
   * the phone showed a zoomed-out grid with NO energy overlay at all — strictly
   * worse than the clipping it meant to fix. It slipped through because the gate
   * read the iframe's canvas via JS (which was correct: ~10.8k LOL pixels) instead
   * of the rendered page. Measured, not guessed: with the transform the composited
   * 390px shot carried 620 green px (the page's own legend swatch — i.e. none of
   * the sim's); untransformed with the taller frame it carries ~6.4k. The gate now
   * asserts on the RENDERED artifact at 390px (smoke_sims.mjs) so this cannot
   * regress.
   */

  function post(iframe, type) {
    try {
      if (iframe && iframe.contentWindow) {
        iframe.contentWindow.postMessage({ source: MSG_SOURCE, type: type }, '*');
      }
    } catch (e) { /* cross-frame race during teardown — safe to ignore */ }
  }

  function bootFailed(iframe) {
    // Same-origin: a booted app exposes window.__sim and a painted canvas#scene.
    try {
      var doc = iframe.contentDocument;
      var win = iframe.contentWindow;
      if (!doc || !win) return true;
      if (!win.__sim) return true;
      return !doc.querySelector('canvas#scene');
    } catch (e) { return true; }
  }

  function setupExhibit(stage) {
    var src = stage.getAttribute('data-embed-src');
    var label = stage.getAttribute('data-label') || 'the simulation';
    var frame = stage.querySelector('.ex__frame');
    if (!src || !frame) return;

    // (1) progressive enhancement: inject the run control + fallback slot.
    var run = document.createElement('button');
    run.type = 'button';
    run.className = 'ex__run js-embed-run';
    run.setAttribute('aria-label', 'Run the ' + label + ' simulation live');
    run.innerHTML = '<span class="ex__run-icon" aria-hidden="true">▶</span> Run the simulation';

    var fallback = document.createElement('p');
    fallback.className = 'ex__fallback js-embed-fallback';
    fallback.setAttribute('role', 'status');
    fallback.hidden = true;
    fallback.textContent = 'Couldn’t load the live sim — the still above is a real ' +
      'screenshot of this scene running.';

    frame.appendChild(run);
    frame.appendChild(fallback);

    var iframe = null;
    var activated = false;

    function activate() {
      if (activated) return;
      activated = true;
      run.disabled = true;
      run.setAttribute('aria-hidden', 'true');
      stage.classList.add('is-activating');

      iframe = document.createElement('iframe');
      iframe.className = 'ex__iframe js-embed-iframe';
      iframe.setAttribute('title', 'Live simulation of ' + label);
      iframe.setAttribute('loading', 'lazy');
      iframe.setAttribute('allow', 'fullscreen');
      iframe.src = src;

      var settled = false;
      function fail() {
        if (settled) return; settled = true;
        stage.classList.remove('is-activating');
        stage.classList.add('is-failed');
        fallback.hidden = false;
        // retain the poster; drop the dead frame.
        if (iframe && iframe.parentNode) iframe.parentNode.removeChild(iframe);
        iframe = null;
      }
      function ok() {
        if (settled) return; settled = true;
        stage.classList.remove('is-activating');
        stage.classList.add('is-booted'); // CSS reveals the iframe over the poster
      }

      var timer = setTimeout(function () {
        if (bootFailed(iframe)) fail();
      }, BOOT_TIMEOUT_MS);

      iframe.addEventListener('load', function () {
        // Give the ES module graph a beat to define window.__sim + paint.
        setTimeout(function () {
          clearTimeout(timer);
          if (bootFailed(iframe)) fail(); else ok();
        }, 600);
      });
      iframe.addEventListener('error', function () { clearTimeout(timer); fail(); });

      // No JS sizing: the iframe is a plain 100%x100% child of .ex__frame, whose
      // min-height guarantees the app enough canvas height for its LOL panel.
      frame.appendChild(iframe);
    }

    run.addEventListener('click', activate);
    // Enter/Space on a native <button> already activate; no extra keydown needed.

    // (3) pause on scroll-out; RESTART (not resume) on a true scroll-back.
    //
    // A reader who scrolls an exhibit away and comes back expects to SEE the
    // motion, not to land in the middle of a run that played on without them (or,
    // for a short scene, on a frozen end-state that never moves again). So the
    // re-entry message is `restart` — the app's OWN full reset-to-t0-then-play
    // (embed_boot.js EMBED_RESTART -> main.js embedRestart(): doReset() rebuilds
    // the runner from a fresh loadScene, doPlay() launches it). No sim-side change.
    //
    // The GUARD (`wasFullyOut`) is what keeps that from firing mid-view: the
    // observer also fires on ordinary threshold flicker — a small scroll that dips
    // the exhibit below PLAY_RATIO while most of it is still on screen — and
    // restarting a run the reader is WATCHING because they nudged the wheel would
    // be worse than the bug this fixes. So the two edges are decoupled:
    //
    //   ratio == 0            -> fully off-screen. PAUSE + arm the restart.
    //   0 < ratio < PLAY      -> flicker / partially out. PAUSE, do NOT arm.
    //   ratio >= PLAY, armed  -> a true scroll-back.  RESTART (and disarm).
    //   ratio >= PLAY, unarmed-> came back from flicker. RESUME mid-run.
    //
    // Thresholds [0, PLAY_RATIO] so the callback fires on BOTH edges (a single
    // 0.25 threshold never reports the ratio==0 crossing that arms the restart).
    if ('IntersectionObserver' in window) {
      var wasFullyOut = false;
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          var ratio = entry.intersectionRatio;
          var canPlay = entry.isIntersecting && ratio >= PLAY_RATIO;
          if (ratio <= 0) wasFullyOut = true;
          // Track visibility even before boot, so an exhibit activated while in
          // view is never mistaken for a scroll-back and restarted on first sight.
          if (!iframe) {
            if (canPlay) wasFullyOut = false;
            return;
          }
          if (!canPlay) { post(iframe, MSG_PAUSE); return; }
          if (wasFullyOut) {
            wasFullyOut = false;
            post(iframe, MSG_RESTART);
          } else {
            post(iframe, MSG_RESUME);
          }
        });
      }, { threshold: [0, PLAY_RATIO] });
      io.observe(stage);
    }
    // Also pause when the tab is hidden (never animate an unseen embed).
    document.addEventListener('visibilitychange', function () {
      if (iframe && document.hidden) post(iframe, MSG_PAUSE);
    });

    // (5) A rotate / window resize needs no showcase-side refit: the iframe is
    // 100%x100% of .ex__frame, so the app's own window 'resize' handler
    // (sim/main.js) re-fits its camera to the new viewport.
  }

  function init() {
    var stages = document.querySelectorAll('.js-embed');
    for (var i = 0; i < stages.length; i++) setupExhibit(stages[i]);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
