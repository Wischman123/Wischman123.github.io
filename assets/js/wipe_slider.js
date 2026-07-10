/* wipe_slider.js — the ONE shared before/after wipe-slider (D-0 single-module
 * rule). Hand-rolled (no vendored img-comparison-slider): zero third-party code,
 * zero license file, zero new self-containment surface (invariant 3). It serves
 * BOTH the wing's T1-c "library learns" before/after AND T2-b's feedback wipe,
 * and lives at the cross-plan shared path public/assets/js/wipe_slider.js so the
 * deep-dive plan's P4 consumes THIS module rather than building a second one.
 *
 * DATA-ATTRIBUTE CONTRACT (the mount markup an authoring page writes; the module
 * upgrades it — degrades to a readable side-by-side with JS off via <noscript>):
 *
 *   <div class="wipe" data-wipe
 *        data-before="assets/d1_before_regeneration.png"
 *        data-after="assets/d1_after_regeneration.png"
 *        data-before-alt="…"  data-after-alt="…"
 *        data-before-label="Before"  data-after-label="After">
 *     <noscript><img src="assets/d1_before_regeneration.png" alt="…">
 *               <img src="assets/d1_after_regeneration.png"  alt="…"></noscript>
 *   </div>
 *
 * A native <input type="range"> drives a clip-path inset, so the control is
 * keyboard-operable for free (arrow keys). The range value positions the wipe
 * divider: the "before" image fills the LEFT of it, the "after" image the RIGHT
 * — so the badges (before left / after right) and the aria-label ("left shows
 * before, right shows after") stay accurate, and dragging RIGHT reveals more of
 * the "after" image. (v = 0 → all after, v = 100 → all before; the wipe works in
 * BOTH directions.) No autonomous motion: it rests at 50 % (an even split) until
 * the reader moves it (the wrapper's reduced-motion contract holds trivially —
 * nothing animates on load).
 */
(function () {
  "use strict";

  function upgrade(root) {
    if (root.__wipeUpgraded) return;
    root.__wipeUpgraded = true;

    var beforeSrc = root.getAttribute("data-before") || "";
    var afterSrc = root.getAttribute("data-after") || "";
    var beforeAlt = root.getAttribute("data-before-alt") || "Before";
    var afterAlt = root.getAttribute("data-after-alt") || "After";
    var beforeLbl = root.getAttribute("data-before-label") || "Before";
    var afterLbl = root.getAttribute("data-after-label") || "After";
    if (!beforeSrc || !afterSrc) return;

    // Remove the noscript fallback's rendered content (JS present now).
    root.textContent = "";

    var frame = document.createElement("div");
    frame.className = "wipe__frame";

    var imgBefore = document.createElement("img");
    imgBefore.className = "wipe__img wipe__img--before";
    imgBefore.src = beforeSrc;
    imgBefore.alt = beforeAlt;
    imgBefore.decoding = "async";

    var imgAfter = document.createElement("img");
    imgAfter.className = "wipe__img wipe__img--after";
    imgAfter.src = afterSrc;
    imgAfter.alt = afterAlt;
    imgAfter.decoding = "async";

    var badgeB = document.createElement("span");
    badgeB.className = "wipe__badge wipe__badge--before";
    badgeB.textContent = beforeLbl;
    var badgeA = document.createElement("span");
    badgeA.className = "wipe__badge wipe__badge--after";
    badgeA.textContent = afterLbl;

    var handle = document.createElement("div");
    handle.className = "wipe__handle";

    frame.appendChild(imgBefore);
    frame.appendChild(imgAfter);
    frame.appendChild(badgeB);
    frame.appendChild(badgeA);
    frame.appendChild(handle);

    var range = document.createElement("input");
    range.type = "range";
    range.className = "wipe__range";
    range.min = "0";
    range.max = "100";
    range.value = "50";
    range.setAttribute("aria-label",
      "Wipe between " + beforeLbl + " and " + afterLbl +
      " — left shows " + beforeLbl + ", right shows " + afterLbl);

    function apply(v) {
      // "before" (base) fills the left [0, v]; reveal "after" on the RIGHT
      // [v, 100] by clipping its LEFT edge — divider sits at v% (handle.left).
      imgAfter.style.clipPath = "inset(0 0 0 " + v + "%)";
      handle.style.left = v + "%";
      badgeB.style.opacity = v > 12 ? "1" : "0.25";
      badgeA.style.opacity = v < 88 ? "1" : "0.25";
      root.setAttribute("data-wipe-value", String(v));
    }
    range.addEventListener("input", function () { apply(parseInt(range.value, 10)); });

    root.appendChild(frame);
    root.appendChild(range);
    apply(50);
  }

  function init() {
    var nodes = document.querySelectorAll("[data-wipe]");
    for (var i = 0; i < nodes.length; i++) upgrade(nodes[i]);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  window.WipeSlider = { init: init, upgrade: upgrade };
})();
