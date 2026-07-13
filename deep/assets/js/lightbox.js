/* lightbox.js — the ONE shared click-to-enlarge lightbox (the D-0 single-module
 * rule wipe_slider.js already establishes for this site). Hand-rolled: zero
 * third-party code, zero license file, zero new self-containment surface.
 *
 * WHY IT EXISTS. The front page grew TWO hand-rolled copies of this behaviour —
 * one for the (since-deleted) gallery stills, one scoped to #story — and the
 * deep-dive gallery was about to be handed a third. This module is the shared
 * component instead: a consumer SHIPS THESE BYTES (physics/tools/showcase/
 * lightbox.py::read_lightbox_js) and can never drift from the contract below.
 *
 * DATA-ATTRIBUTE CONTRACT (the mount markup an authoring page writes; the module
 * upgrades it — with JS off the images simply stay inline images, which is the
 * whole progressive-enhancement story: there is nothing to open, and nothing to
 * miss):
 *
 *   <img src="assets/gallery/dawn_p1.png" alt="…" data-zoomable>
 *
 * Clicking (or Enter/Space on) a [data-zoomable] image opens it at PAGE WIDTH in
 * a full-viewport dialog; a tall page then SCROLLS vertically rather than being
 * shrunk to fit the viewport — which is the point, since these artifacts are
 * printed pages a reader is meant to actually read. Click anywhere, or press
 * Escape, to close; focus returns to the image that opened it.
 *
 * The GEOMETRY is not here. The `.lightbox` skin lives with each design system
 * (the front page's site.css; the deep-dive family's templates/_lightbox.css)
 * because the two use different token vocabularies — the same split wipe_slider
 * .js documents. The shared contract is this module + the class names it emits.
 *
 * DELIBERATELY NOT ZOOMABLE: anything whose click already means something else —
 * a [data-wipe] before/after slider (its click-drag IS the interaction) or a
 * live-sim poster (its click boots the sim). A page opts an image IN, one at a
 * time, by writing data-zoomable on it. There is no blanket "all images" rule.
 */
(function () {
  "use strict";

  var box = null;
  var big = null;
  var opener = null;

  function ensureBox() {
    if (box) return box;
    box = document.createElement("div");
    box.className = "lightbox";
    box.hidden = true;
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-label",
      "Enlarged figure — click anywhere or press Escape to close");
    big = document.createElement("img");
    box.appendChild(big);
    document.body.appendChild(box);

    box.addEventListener("click", close);
    document.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape" && !box.hidden) close();
    });
    return box;
  }

  function open(img) {
    ensureBox();
    opener = img;
    // currentSrc, so a responsive/srcset image enlarges the variant the reader
    // is actually looking at rather than re-resolving a different one.
    big.src = img.currentSrc || img.src;
    big.alt = img.alt || "";
    box.hidden = false;
  }

  function close() {
    if (!box || box.hidden) return;
    box.hidden = true;
    big.removeAttribute("src");
    if (opener) {
      opener.focus();
      opener = null;
    }
  }

  function upgrade(img) {
    if (img.__lightboxUpgraded) return;
    img.__lightboxUpgraded = true;

    // Only NOW does the image become a control — with JS off it stays a plain
    // image rather than advertising a dialog that cannot open.
    img.setAttribute("role", "button");
    img.setAttribute("tabindex", "0");
    img.setAttribute("aria-haspopup", "dialog");
    if (!img.getAttribute("aria-label")) {
      img.setAttribute("aria-label",
        "Enlarge image" + (img.alt ? ": " + img.alt : ""));
    }
    img.addEventListener("click", function () { open(img); });
    img.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        open(img);
      }
    });
  }

  function init() {
    var nodes = document.querySelectorAll("img[data-zoomable]");
    for (var i = 0; i < nodes.length; i++) upgrade(nodes[i]);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  window.Lightbox = { init: init, upgrade: upgrade, close: close };
})();
