/* terminal_replay.js — the T1-d "gate says no" terminal replay (termynal-style).
 *
 * Replays a REAL rejection → library fix → regenerate → PASS sequence as a
 * typed-out terminal. The lines are AUTHORED IN THE HTML as ordinary, readable
 * elements (data-attribute markup), so with JavaScript OFF the whole transcript
 * is already there to read — the module only adds the typing animation on top of
 * static, accessible text (progressive enhancement, no-JS fallback GUARANTEED).
 *
 * DATA-ATTRIBUTE CONTRACT (the mount markup an authoring page writes):
 *   <div class="term" data-term>
 *     <span data-ty="input">python -m validate_problem_physics energy_k017</span>
 *     <span data-ty>REJECTED  check_solution_structure: missing free-body diagram</span>
 *     <span data-ty="comment"># fix lands in the shared library, not this one file</span>
 *     <span data-ty="input">python build_problem.py energy_k017 --regenerate</span>
 *     <span data-ty="ok">PASS  all gates green — artifact admitted to the queue</span>
 *   </div>
 *
 * data-ty values: "input" (prompt-prefixed command), "comment" (dimmed), "ok"
 * (accent PASS line), or absent (plain output). No autonomous motion until the
 * card is engaged/visible; honors prefers-reduced-motion (renders instantly,
 * no typing). No external dependencies.
 */
(function () {
  "use strict";

  var PRM = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)");
  function reduced() { return !!(PRM && PRM.matches); }

  function play(root) {
    if (root.__termPlayed) return;
    root.__termPlayed = true;
    var lines = Array.prototype.slice.call(root.querySelectorAll("[data-ty]"));
    if (!lines.length) return;

    // Reduced motion / no fancy timing: reveal all lines at once (already
    // readable — this just clears the "pending" hidden state).
    if (reduced()) {
      lines.forEach(function (l) { l.setAttribute("data-ty-shown", "1"); });
      root.setAttribute("data-term-state", "done");
      return;
    }

    root.setAttribute("data-term-state", "playing");
    var i = 0;
    function step() {
      if (i >= lines.length) {
        root.setAttribute("data-term-state", "done");
        return;
      }
      var line = lines[i];
      line.setAttribute("data-ty-shown", "1");
      i += 1;
      var delay = line.getAttribute("data-ty") === "input" ? 520 : 340;
      setTimeout(step, delay);
    }
    step();
  }

  function arm(root) {
    if (root.__termArmed) return;
    root.__termArmed = true;
    // Mark JS-active so CSS may hide not-yet-typed lines. With JS OFF this
    // attribute is absent, so the CSS hide rule never applies and every line
    // stays readable (the no-JS fallback).
    root.setAttribute("data-term-js", "1");
    if (reduced()) {
      // Reduced motion: reveal the whole transcript IMMEDIATELY — there is no
      // motion to gate on scroll, and a reduced-motion reader should see the
      // full text at once, not an empty box until it scrolls into view.
      play(root);
    } else if ("IntersectionObserver" in window) {
      // Play the typing animation when the card scrolls into view (never
      // autoplay offscreen).
      var obs = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (en.isIntersecting) { play(root); obs.disconnect(); }
        });
      }, { threshold: 0.35 });
      obs.observe(root);
    } else {
      play(root);
    }
    // A replay button lets the reader watch it again (keyboard operable).
    var btn = root.querySelector("[data-term-replay]");
    if (btn) {
      btn.addEventListener("click", function () {
        root.querySelectorAll("[data-ty]").forEach(function (l) {
          l.removeAttribute("data-ty-shown");
        });
        root.__termPlayed = false;
        play(root);
      });
    }
  }

  function init() {
    var nodes = document.querySelectorAll("[data-term]");
    for (var i = 0; i < nodes.length; i++) arm(nodes[i]);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  window.TerminalReplay = { init: init, play: play };
})();
