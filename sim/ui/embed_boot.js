// embed_boot.js
//
// The showcase-embed boot seam for the browser sim (physics_showcase_wing_v2
// SW2). main.js is a self-booting browser entry that loads DEFAULT_SCENARIO and
// autoruns; the publicity wing embeds it in an <iframe> and needs TWO things
// main.js did not previously expose:
//
//   1. `?scene=<id>` boot selection — the wrapper aims each iframe at
//      `sim/index.html?scene=coulomb_two_body`, so the embedded app must boot
//      that scene, NOT DEFAULT_SCENARIO. A stale self-booting main.js would
//      render DEFAULT_SCENARIO in every iframe (the exact failure the wing's
//      vendor step greps for and refuses to ship).
//   2. a postMessage pause/resume hook — the a11y wrapper (site/assets/sim_embed.js)
//      posts `{ source: "sim_embed", type: "pause" | "resume" }` into the iframe
//      when the reader engages, when the card scrolls out of view
//      (IntersectionObserver), or when the tab is hidden (visibilitychange). The
//      embedded app must honor them so nothing animates unengaged/offscreen.
//
// The DECISION points (which scene id to boot; whether a message is a pause /
// resume / neither) are pulled OUT of main.js into the pure functions below so
// they are unit-testable with `node --test` WITHOUT a DOM (main.js throws at
// import without `document`). This mirrors the repo rule "test the
// decision point, not the heuristic": the boundary — including the
// negative case (unknown id -> default, foreign message -> ignored) —
// is covered in sim/ui/__tests__/embed_boot.test.js.

// The exact postMessage contract the SW1 wrapper (site/assets/sim_embed.js)
// sends. Kept as named constants so the wrapper and this consumer cannot drift
// silently on a string literal.
export const EMBED_MESSAGE_SOURCE = 'sim_embed';
export const EMBED_PAUSE = 'pause';
export const EMBED_RESUME = 'resume';
// SW2 T1-b restart: the wrapper posts this when the reader presses the ↺
// Restart button so a scene that ran out its duration can replay from t=0. The
// embedded app routes it to a FULL reset-to-t0-then-play (main.embedRestart),
// not a bare runner.reset() (which leaves the tracker's drift history intact).
export const EMBED_RESTART = 'restart';

/**
 * Resolve the scene id to boot from a URL query string.
 *
 * @param {string|URLSearchParams|null|undefined} search
 *        window.location.search (e.g. "?scene=coulomb_two_body") or a
 *        URLSearchParams. Empty / missing / malformed -> defaultId.
 * @param {Iterable<string>} knownIds  every registered scene id.
 * @param {string} defaultId           fallback (the DEFAULT_SCENARIO id).
 * @returns {string} a scene id GUARANTEED to be in knownIds (falls back to
 *          defaultId, so the caller never loads an unregistered/typo scene).
 */
export function resolveBootSceneId(search, knownIds, defaultId) {
  const known = knownIds instanceof Set ? knownIds : new Set(knownIds);
  let params;
  try {
    params = search instanceof URLSearchParams
      ? search
      : new URLSearchParams(search || '');
  } catch {
    return defaultId;
  }
  const requested = params.get('scene');
  if (requested && known.has(requested)) return requested;
  return defaultId;
}

/**
 * Resolve whether the embedded sim should render MINIMAL chrome (canvas only).
 *
 * The showcase wing (systems_wing_review_edits W3) loads each iframe with
 * `&embed=1` — appended by the SW1 wrapper (site/assets/sim_embed.js) when it
 * creates the live frame. That flag asks main.js to hide its authoring chrome
 * (the header, scenario picker, banner, toolbar, and inspector aside) via the
 * `.sim-embed-minimal` class in index.html, so the embedded card shows just the
 * live canvas. Standalone use (no flag) keeps the full UI unchanged.
 *
 * Pure — no DOM — so the decision is unit-testable without a browser (main.js
 * throws at import without `document`). Same pure-predicate shape as
 * resolveBootSceneId, and deliberately STRICT on the value (`=== '1'`) so an
 * unrelated `embed=` query param can never silently strip a standalone user's
 * chrome. Missing / malformed / any other value -> false (full chrome).
 *
 * @param {string|URLSearchParams|null|undefined} search
 *        window.location.search (e.g. "?scene=coulomb_two_body&embed=1") or a
 *        URLSearchParams.
 * @returns {boolean} true iff `embed=1` is present.
 */
export function resolveEmbedChrome(search) {
  let params;
  try {
    params = search instanceof URLSearchParams
      ? search
      : new URLSearchParams(search || '');
  } catch {
    return false;
  }
  return params.get('embed') === '1';
}

/**
 * Classify an incoming postMessage `event.data` from the embed wrapper.
 * Pure — no side effects — so the pause/resume routing is unit-testable.
 *
 * @param {*} data  the message payload (event.data). Anything that is not the
 *                  wrapper's {source, type} shape returns null (ignored), so a
 *                  page's unrelated postMessage traffic can never pause the sim.
 * @returns {'pause'|'resume'|'restart'|null}
 */
export function parseEmbedMessage(data) {
  if (!data || typeof data !== 'object') return null;
  if (data.source !== EMBED_MESSAGE_SOURCE) return null;
  if (data.type === EMBED_PAUSE) return EMBED_PAUSE;
  if (data.type === EMBED_RESUME) return EMBED_RESUME;
  if (data.type === EMBED_RESTART) return EMBED_RESTART;
  return null;
}

/**
 * Install the embed pause/resume message listener on a message target.
 *
 * @param {object} opts
 * @param {EventTarget} opts.target       usually window.
 * @param {() => void} opts.onPause       called on a wrapper "pause" message.
 * @param {() => void} opts.onResume      called on a wrapper "resume" message.
 * @param {() => void} [opts.onRestart]   called on a wrapper "restart" message.
 * @returns {() => void} teardown that removes the listener.
 */
export function installEmbedControls({ target, onPause, onResume, onRestart }) {
  const handler = (event) => {
    const action = parseEmbedMessage(event && event.data);
    if (action === EMBED_PAUSE) onPause && onPause();
    else if (action === EMBED_RESUME) onResume && onResume();
    else if (action === EMBED_RESTART) onRestart && onRestart();
  };
  target.addEventListener('message', handler);
  return () => target.removeEventListener('message', handler);
}

export const NAME = 'embed_boot';
