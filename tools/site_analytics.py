#!/usr/bin/env python3
r"""site_analytics.py — the analytics tag: ONE config seam, ONE producer, ONE predicate.

WHY THIS MODULE EXISTS (showcase_site_architecture_v1, E2.1)
===========================================================
The site is a job-application artifact, and the question worth answering is not
"how many hits" but *"did the reader get past the homepage?"*. That needs a tag on
the served page. This module owns everything about that tag EXCEPT where it is
injected (``showcase_site/build.py`` stage 4b) and where it is asserted
(``site_checks.py``) — so the site code is read from ONE place, the markup has ONE
producer, and "does this page carry the tag" has ONE semantic answer.

THE SEAM IS AN ENV VAR, AND THE FLAG IS DERIVED FROM IT
=======================================================
:data:`SITE_CODE_ENV` is the whole configuration surface. There is deliberately
**no separate on/off flag**: the flag IS ``site_code() is not None``. That
collapses the failure mode E2.1 was warned about — *a tag pointing at a
nonexistent GoatCounter site silently collects nothing while asserting coverage*
— into something unrepresentable. You cannot turn analytics ON without supplying
a code, because supplying the code is what turns it on.

  * **unset / empty**  -> OFF. Every local ``build.py`` / ``build_and_publish.py``
    run (Brendan's box), so a local build never emits a tag and never inflicts
    traffic on his own dashboard (E2.1 Done-when 2).
  * **set**            -> ON. CI supplies it from a repo variable, so flipping
    analytics on is a settings change, not a code change, and no re-publish of
    the mirror is needed.

A malformed value is a HARD ABORT, never a silently-wrong tag: see
:func:`site_code`.

WHY THE TAG IS A BUILD-STAGE CONCERN AND NOT A TEMPLATE ONE
===========================================================
E2.1's plan text says *"one vendor ``<script>`` in ``base.html.j2``"*. **Measured,
that cannot work here**, for the same reason the plan's "ONE repo" prose is stale
(D1.1): the render is PRIVATE and CI is HERMETIC, so the build repo carries the
**already-rendered HTML** as a committed mirror. A render-time flag would bake the
tag into that committed mirror — and then a local build could not omit it
(Done-when 2 dies) and CI could not add it (CI never renders). So the tag is
injected into the ARTIFACT COPY under ``_site/`` at build time, for every
``pages.yaml`` page. The two pages that do not extend ``base.html.j2``
(``sim/index.html``, ``plain-vs-engine.html``) are then not a special case at all
— they are simply two more rows of the same referent, which is why the authored
sources stay untouched and the Charter's anti-target holds.

THE VENDOR'S BEHAVIOR IS VERIFIED, NOT REMEMBERED (2026-07-16)
==============================================================
Read from the REAL ``https://gc.zgo.at/count.js`` (9,213 B), not from memory:

  * **No cookies.** ``document.cookie`` does not appear in count.js at all. That
    is why no consent banner is needed, and it is the mechanism behind E2.1's
    ``document.cookie``-is-empty check. (It touches ``localStorage`` for exactly
    one thing: the ``skipgc`` self-exclusion flag behind ``#toggle-goatcounter``.)
  * **The endpoint** is resolved as
    ``document.querySelector('script[data-goatcounter]').dataset.goatcounter``,
    falling back to ``goatcounter.endpoint``. So the attribute on the loader
    element below IS the configuration count.js reads — no globals needed.
  * **It does NOT honor Do Not Track.** ``doNotTrack``, ``msDoNotTrack`` and
    ``globalPrivacyControl`` are ALL absent from count.js. The plan requires DNT
    be respected and sets the bar at *Brendan's own privacy standard, not the
    vendor's minimum* — so the guard in :func:`tag_html` is the only thing
    honoring the signal, and it runs BEFORE the vendor script is fetched. An
    opted-out reader therefore makes **no request to the vendor at all**, rather
    than making one that merely is not counted.
  * **Defaults already refuse local + framed counts** (``allow_local`` /
    ``allow_frame`` default falsy: localhost/127./10./172.16-31./192.168./file:
    and any cross-origin iframe are skipped). That is defense in depth BEHIND the
    build flag, not a substitute for it.

THE PREDICATE IS SEMANTIC, NOT A SUBSTRING (E1.2's carried-forward correction)
=============================================================================
:func:`analytics_endpoints` PARSES the document and reports the endpoint of every
``<script>`` element carrying ``data-goatcounter``. It does not grep for the word
"goatcounter": a prose mention, an HTML comment, or this module's own name in a
build log must NOT read as coverage. The same conceptual bug — substring-matching
source text instead of testing a semantic property — bit E1.2 twice, so the
decision point here is a pure predicate with negative cases on both sides
(``tests/test_site_analytics.py``).

WHAT E2.2 ADDED, AND THE TWO RULES IT DID NOT GET TO CHOOSE
==========================================================
E2.2 hangs the engagement funnel (four signals) on this same tag, and two
constraints fixed the design before it started:

  * **The guard is ours and it is load-bearing.** count.js does not honor DNT/GPC,
    so an event that fired for an opted-out reader would defeat the one mechanism
    honoring the signal. The funnel therefore lives INSIDE the guarded closure,
    below its `return` — unreachable rather than re-checked (see THE FUNNEL).
  * **D2 item 1's delta rule.** The analytics flag may change the artifact ONLY by
    adding the tag. E2.2 owns proving it, and the proof is constructive rather
    than descriptive: :func:`flag_delta_violations` asserts the flag-ON tree is
    EXACTLY the flag-OFF tree with :func:`inject` applied to the `pages.yaml` rows
    — no regex over the delta, no "looks like a script node".
"""
from __future__ import annotations

import json
import os
import re
from collections.abc import Callable, Mapping, Sequence
from html.parser import HTMLParser

#: THE SEAM. The GoatCounter site code (the ``<code>`` in
#: ``<code>.goatcounter.com``). Read HERE and nowhere else; every other module
#: asks this one. Unset/empty => analytics is OFF.
SITE_CODE_ENV = "SHOWCASE_ANALYTICS_SITE"

#: The vendor. Named once so the decision is greppable.
VENDOR = "GoatCounter"

#: The vendor's counter script. Loaded by the guard in `tag_html`, never by a
#: static `src=` — the DNT check has to happen first.
COUNT_JS = "https://gc.zgo.at/count.js"

#: The per-site endpoint count.js posts to, derived from the site code.
ENDPOINT_TMPL = "https://{code}.goatcounter.com/count"

#: The attribute count.js reads its endpoint from (verified against count.js).
ENDPOINT_ATTR = "data-goatcounter"

# ---------------------------------------------------------------------------
# THE FUNNEL (E2.2) — four signals, named ONCE, fired INSIDE the DNT guard
# ---------------------------------------------------------------------------
#
# WHY THE FUNNEL LIVES INSIDE THE TAG AND NOT IN A SECOND <script>
# ================================================================
# Two independent reasons, and either alone would decide it:
#
#   1. THE GUARD. E2.2's binding constraint is that the four events respect the
#      DNT/GPC guard. A second script would have to RE-CHECK the signal, and a
#      re-checked guard is one someone can forget to re-check. Here the funnel
#      wiring is physically BELOW the early `return` in the same closure: an
#      opted-out reader never registers a listener, never touches sessionStorage
#      and never queues an event, because that code is unreachable. The guard is
#      SHARED, not repeated — which is why the negative control (DNT on -> zero
#      requests) covers the events too, not just the pageview.
#   2. D2's DELTA RULE. D2 item 1 says the flag's only effect may be the analytics
#      `<script>` nodes, "exactly one per HTML file that RECEIVES the tag". One
#      script node per page keeps that literally true; a second node would make the
#      delta two-per-page and force the rule to be re-negotiated.
#
# WHY EACH EVENT IS FIRED ONCE PER SESSION
# ========================================
# A funnel step is a SESSION fact ("did this reader get past the homepage?"), not
# a pageview fact. Fired per-pageview, `deep-wing` would be exactly the sum of the
# `deep/*` pageviews the vendor already counts — a duplicate that adds ZERO
# information and doubles the beacons, i.e. the vanity metric the plan's own
# framing rejects. Fired once per session it is a number the pageview table does
# NOT contain. Dedup is CLIENT-side (sessionStorage) on purpose: GoatCounter's
# server-side session/visit logic is not readable from count.js, and a check whose
# correctness rests on unverifiable vendor behavior is not a check.
#
# sessionStorage, not a cookie: per-tab, dropped when the tab closes, never sent
# to any server, and it holds a list of step NAMES — no identifier, nothing that
# could become one. E2.1's `document.cookie`-is-empty check stays green by
# construction. It is only ever touched PAST the guard.

#: The funnel's namespace. Every event path starts here, so ONE dashboard filter
#: (`funnel/`) returns the whole funnel — which is what makes the query (Done-when
#: 2) a lookup instead of an API integration.
FUNNEL_PREFIX = "funnel/"

#: The four signals. Paths, not titles: GoatCounter aggregates by path, so these
#: are what the dashboard counts.
STEP_DEEP_WING = FUNNEL_PREFIX + "deep-wing"    # (1) got past the homepage
STEP_SIM_PLAY = FUNNEL_PREFIX + "sim-play"      # (2) pressed play on a sim
STEP_DEPTH_CODE = FUNNEL_PREFIX + "depth-code"  # (3) reached the hardest page
CHANNEL_PREFIX = FUNNEL_PREFIX + "channel/"     # (4) which channel delivered them

#: The deep wing, and the hardest page in it. Published, root-relative — the same
#: shape as a `pages.yaml` row, because that is what they are compared against.
#: The trailing slash is load-bearing: without it, a future `deepdive.html` would
#: silently count as the deep wing.
DEEP_PREFIX = "deep/"
CODE_PAGE = "deep/code.html"

#: The sim play control. MEASURED, not assumed: `src/assets/sims/embed.js` builds
#: `<button class="ex__run js-embed-run">` for every `.ex__stage` exhibit and only
#: then injects the sim `<iframe>` — so on THIS site every embed has a parent-side
#: control, and E2.2's `postMessage` shim (for embeds without one) is not needed.
#: That matters beyond convenience: count.js's own `filter()` REFUSES to count from
#: inside an iframe (`!allow_frame && location !== parent.location -> 'frame'`), so
#: an event fired from within the sim frame would be silently dropped. The parent's
#: click is the only place this signal CAN be collected.
#:
#: Bound by DELEGATION from the tag (not by editing embed.js): the control is
#: created after load, the tag is the analytics seam's only author, and embed.js is
#: a hash-defended mirror whose home is physics. `js-` marks it a JS hook.
PLAY_CONTROL_SELECTOR = ".js-embed-run"

#: The campaign parameter. A link from the APPLICATION (a PDF/e-mail) usually
#: arrives with NO referrer — indistinguishable from a direct visit — so the
#: channel cannot be recovered from `document.referrer` alone. `?from=application`
#: on the link Brendan actually sends is what separates them.
CAMPAIGN_PARAM = "from"

#: Values honored from `?from=` — an ALLOWLIST, deliberately. The value lands in an
#: event path on a public URL: unbounded, `?from=<junk>` would let any passer-by
#: mint arbitrary rows in the dashboard. Anything unrecognized degrades to "other".
CAMPAIGN_CHANNELS = ("application", "linkedin")

#: Every channel label that can be emitted — the bounded set the funnel query reads.
#: `direct`/`internal`/`other` are referrer-derived and cannot be spoofed via the
#: campaign param.
CHANNELS = ("application", "linkedin", "direct", "internal", "other")

#: The sessionStorage key holding the list of steps already fired this session.
FUNNEL_STORAGE_KEY = "showcase-funnel"

#: The dedup sentinel for the channel event. It is NOT the emitted path: the path
#: carries the channel (`funnel/channel/linkedin`), but "first touch wins" has to
#: dedup on the CATEGORY. Keyed on the path, a reader who arrives from LinkedIn and
#: then opens a second tab would emit `channel/linkedin` AND `channel/internal` for
#: one session, and the channel counts would exceed the sessions they describe.
CHANNEL_SENTINEL = "channel"

#: A GoatCounter site code is a DNS label: it becomes `<code>.goatcounter.com`.
#: Lowercase alnum + inner hyphens, 1-63 chars. Strict on purpose — this value
#: ends up in a URL on every published page, so a malformed one is a hard abort
#: at the boundary, not a silently-wrong tag nobody notices for a month.
_SITE_CODE_RE = re.compile(r"\A[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\Z")


class AnalyticsConfigError(RuntimeError):
    """The configured site code is unusable. Named input + remediation, always."""


# ---------------------------------------------------------------------------
# The config seam
# ---------------------------------------------------------------------------


def site_code(env: dict[str, str] | None = None) -> str | None:
    """The configured GoatCounter site code, or ``None`` when analytics is OFF.

    ``env`` is injectable so the decision point is unit-testable without mutating
    the process environment (and so a test cannot leak a code into a sibling test).

    Shape-validated at the boundary: an empty/whitespace value is OFF (the normal
    local case), but a NON-empty value that is not a valid site code raises rather
    than shipping ``https://oops%20typo.goatcounter.com/count`` to every page.
    """
    raw = (os.environ if env is None else env).get(SITE_CODE_ENV, "")
    code = raw.strip()
    if not code:
        return None
    if not _SITE_CODE_RE.match(code):
        raise AnalyticsConfigError(
            f"{SITE_CODE_ENV}={raw!r} is not a valid {VENDOR} site code.\n"
            f"Expected the bare code from <code>.goatcounter.com — lowercase "
            f"letters/digits/hyphens, 1-63 chars (e.g. 'wischman123'), NOT a full "
            f"URL and NOT the dashboard address.\n"
            f"Remediation: unset {SITE_CODE_ENV} to build without analytics, or "
            f"set it to the site code shown when the {VENDOR} site was created."
        )
    return code


def enabled(env: dict[str, str] | None = None) -> bool:
    """THE FLAG — ``build.py`` and ``verify_live.py`` both ask exactly this.

    Deliberately derived, never independent: analytics is on iff a real code is
    configured, so "flag ON with no code" (the tag that collects nothing while
    asserting coverage) cannot be expressed.
    """
    return site_code(env) is not None


def endpoint(code: str) -> str:
    """The count endpoint for ``code``. The ONE place the URL shape is written."""
    return ENDPOINT_TMPL.format(code=code)


# ---------------------------------------------------------------------------
# The funnel's BUILD-TIME decision point — pure, and tested from both sides
# ---------------------------------------------------------------------------


def pageview_steps(path: str) -> list[str]:
    """The funnel steps THIS page's pageview fires, for a `pages.yaml` row.

    Decided in PYTHON at build time, from the published path the injector already
    knows — not in JS from ``location.pathname``. The build KNOWS the row is
    ``deep/code.html``; the browser would have to infer it, and every inference
    (trailing slash, implicit ``index.html``, a project-page base path) is a way to
    be quietly wrong about a number Brendan is going to read as fact. Per
    "Calculate, Never Guess": compute it where it is known.

    This is a per-PAGE constant, never a per-BUILD one — the distinction D2's
    determinism rule actually rests on. Two builds of the same page agree; that the
    tag differs BETWEEN pages is not nondeterminism.

    Returned in funnel order (entering the wing, then reaching its hardest page) so
    the emitted markup reads like the funnel it describes.
    """
    steps: list[str] = []
    if path.startswith(DEEP_PREFIX):
        steps.append(STEP_DEEP_WING)
    if path == CODE_PAGE:
        steps.append(STEP_DEPTH_CODE)
    return steps


# ---------------------------------------------------------------------------
# The markup — ONE producer
# ---------------------------------------------------------------------------


def tag_html(code: str, path: str) -> str:
    """The analytics tag for ``code`` on the page published at ``path``.

    A DNT-guarded loader for count.js, PLUS E2.2's funnel — one script node, one
    guard, four signals.

    Shape, and why it is not the vendor's copy-paste snippet:

      * the endpoint rides on ``data-goatcounter`` of the INLINE element — which
        is exactly where count.js looks for it
        (``querySelector('script[data-goatcounter]')``), so no second element and
        no globals are needed, and the value is greppable/parseable in the served
        HTML by :func:`analytics_endpoints`;
      * the vendor script is appended ONLY after the DNT/GPC check, because
        count.js does not check it itself (verified — see the module docstring).
        The vendor's own snippet uses a static ``async src=``, which fetches
        count.js before any of our code can decline;
      * **everything funnel-related sits BELOW the guard's `return`**, so an
        opted-out reader registers no listener and stores nothing. See the funnel
        block above for why that is structural rather than re-checked.

    ``path`` is REQUIRED, not optional-with-a-default. A default would mean a
    caller that forgot to pass it silently publishes a page whose funnel steps are
    empty — the deep wing would read as never visited, and the gate (which asserts
    the ENDPOINT, not the steps) would stay green while the number Brendan reads
    quietly went to zero. Absence must be a TypeError, not a wrong number.

    DETERMINISM: every value here is a function of (``code``, ``path``) — no nonce,
    no timestamp, no per-build value. So two builds of the same page produce the
    same bytes (D2's rule), and D2's "add a fourth build only if the snippet embeds
    a per-build value" caveat stays un-triggered. E2.2 owns proving that: the
    three-build matrix is `build.py --determinism`.

    The queue is not ceremony: count.js is appended `async`, so `goatcounter.count`
    does not exist yet when this runs. Events queue and flush on the script's load
    event — otherwise the pageview steps would race the vendor and be lost on a
    cold cache, which is precisely when a first-time reader arrives.
    """
    steps = json.dumps(pageview_steps(path), separators=(",", ":"))
    campaigns = json.dumps(list(CAMPAIGN_CHANNELS), separators=(",", ":"))
    return (
        f'<!-- analytics: {VENDOR} — no cookies, no PII. Not loaded at all when '
        f'Do Not Track / Global Privacy Control is set. Injected at build time by '
        f'build.py stage 4b; the authored source carries no tag. -->\n'
        f'<script {ENDPOINT_ATTR}="{endpoint(code)}">\n'
        f'(function () {{\n'
        f'  var n = window.navigator || {{}};\n'
        f'  if (n.doNotTrack === "1" || n.msDoNotTrack === "1" ||\n'
        f'      window.doNotTrack === "1" || n.globalPrivacyControl === true) {{ return; }}\n'
        f'  // ---- everything below here is unreachable for an opted-out reader ----\n'
        f'  var STEPS = {steps};\n'
        f'  var CAMPAIGNS = {campaigns};\n'
        f'  var q = [], mem = {{}};\n'
        f'  var first = function (k) {{\n'
        f'    // once per SESSION: a funnel step is a session fact, not a pageview.\n'
        f'    try {{\n'
        f'      var v = JSON.parse(sessionStorage.getItem("{FUNNEL_STORAGE_KEY}") || "[]");\n'
        f'      if (v.indexOf(k) > -1) {{ return false; }}\n'
        f'      v.push(k);\n'
        f'      sessionStorage.setItem("{FUNNEL_STORAGE_KEY}", JSON.stringify(v));\n'
        f'      return true;\n'
        f'    }} catch (e) {{ if (mem[k]) {{ return false; }} mem[k] = 1; return true; }}\n'
        f'  }};\n'
        f'  var flush = function () {{\n'
        f'    if (!window.goatcounter || !window.goatcounter.count) {{ return; }}\n'
        f'    while (q.length) {{ window.goatcounter.count(q.shift()); }}\n'
        f'  }};\n'
        f'  var send = function (p, k) {{\n'
        f'    if (!first(k || p)) {{ return; }}\n'
        f'    q.push({{path: p, event: true}});\n'
        f'    flush();\n'
        f'  }};\n'
        f'  var channel = function () {{\n'
        f'    var m = /[?&]{CAMPAIGN_PARAM}=([^&]*)/.exec(location.search || "");\n'
        f'    if (m) {{\n'
        f'      var v;\n'
        f'      try {{ v = decodeURIComponent(m[1]).toLowerCase(); }} catch (e) {{ return "other"; }}\n'
        f'      return CAMPAIGNS.indexOf(v) > -1 ? v : "other";\n'
        f'    }}\n'
        f'    var r = document.referrer || "";\n'
        f'    if (!r) {{ return "direct"; }}\n'
        f'    var h;\n'
        f'    try {{ h = new URL(r).hostname.toLowerCase(); }} catch (e) {{ return "other"; }}\n'
        f'    if (h === location.hostname.toLowerCase()) {{ return "internal"; }}\n'
        f'    if (h === "linkedin.com" || /\\.linkedin\\.com$/.test(h) || h === "lnkd.in") '
        f'{{ return "linkedin"; }}\n'
        f'    return "other";\n'
        f'  }};\n'
        f'  var s = document.createElement("script");\n'
        f'  s.async = true;\n'
        f'  s.src = "{COUNT_JS}";\n'
        f'  s.addEventListener("load", flush, false);\n'
        f'  document.head.appendChild(s);\n'
        f'  // capture-phase + closest(): the click lands on the icon INSIDE the\n'
        f'  // button, and delegation catches a control built after load.\n'
        f'  document.addEventListener("click", function (ev) {{\n'
        f'    var t = ev.target;\n'
        f'    if (t && t.closest && t.closest("{PLAY_CONTROL_SELECTOR}")) '
        f'{{ send("{STEP_SIM_PLAY}"); }}\n'
        f'  }}, true);\n'
        f'  for (var i = 0; i < STEPS.length; i++) {{ send(STEPS[i]); }}\n'
        f'  send("{CHANNEL_PREFIX}" + channel(), "{CHANNEL_SENTINEL}");\n'
        f'}})();\n'
        f'</script>\n'
    )


# ---------------------------------------------------------------------------
# The predicate — SEMANTIC, not a substring
# ---------------------------------------------------------------------------


class _ScriptEndpointFinder(HTMLParser):
    """Collects the ``data-goatcounter`` of every ``<script>`` START TAG.

    Why a parser and not a regex over the raw text: only a real start tag counts.
    ``HTMLParser`` routes comments to ``handle_comment`` and body text to
    ``handle_data``, so a page that merely TALKS about ``data-goatcounter`` — a
    commented-out tag, a prose mention, a code sample on the deep/code page —
    is correctly NOT coverage. It also treats ``<script>``/``<style>`` bodies as
    opaque CDATA, so a tag mentioned inside JS is not a second hit.
    """

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.endpoints: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() != "script":
            return
        for name, value in attrs:
            if name.lower() == ENDPOINT_ATTR and value:
                self.endpoints.append(value)


def analytics_endpoints(html: str) -> list[str]:
    """Every analytics endpoint the DOCUMENT actually configures, in order.

    ``[]`` == the page carries no tag. This is the one answer to "does this page
    carry the tag", and both the flag-ON and the flag-OFF assertions read it.
    """
    p = _ScriptEndpointFinder()
    p.feed(html)
    p.close()
    return p.endpoints


def has_tag(html: str, expect_endpoint: str | None = None) -> bool:
    """Does this page carry the analytics tag?

    ``expect_endpoint`` given => it must be THAT endpoint. A tag pointing at some
    other site is not coverage; it is a bug that would silently feed a stranger's
    dashboard, so the caller that knows the expected endpoint should always pass it.
    """
    found = analytics_endpoints(html)
    if expect_endpoint is None:
        return bool(found)
    return expect_endpoint in found


# ---------------------------------------------------------------------------
# The injection — used by showcase_site/build.py stage 4b
# ---------------------------------------------------------------------------

#: Where the tag goes. Two page SHAPES exist in this site and both are real:
#:   * headed   — `deep/*`, `sim/index.html`, `plain-vs-engine.html` carry a
#:                full `<head>`; the tag goes immediately before `</head>`.
#:   * headless — the three root pages (`index`, `architecture`, `videos`) are
#:                rendered from `root_base.html.j2`, which emits NO doctype, NO
#:                `<html>` and NO `<head>` (A1's measured finding: they open on
#:                `<meta charset>`; line 1 is the provenance banner `check_banners`
#:                pins). The browser hoists their leading meta/title/link into an
#:                implicit head, so the tag goes right after `</title>` — still in
#:                the head, and never above the line-1 banner.
_HEAD_CLOSE = "</head>"
_TITLE_CLOSE = "</title>"


class InjectionError(RuntimeError):
    """The tag could not be placed. NEVER downgraded to "skip this page"."""


def inject(html: str, code: str, path: str) -> str:
    """Return ``html`` with the analytics tag added to its head, exactly once.

    ``path`` is the published, root-relative `pages.yaml` row. It is REQUIRED and
    no longer defaults to a placeholder: since E2.2 it selects the page's funnel
    steps (:func:`pageview_steps`), so a placeholder would not merely spoil an
    error message — it would publish a deep page whose funnel never fires, and
    read out as "nobody visited the wing".

    Aborts rather than guessing — a page that silently does not receive the tag
    would be caught by the coverage assertion later, but it would be caught as a
    mystery. Named input + reason, here, at the boundary:

      * already tagged  -> the SOURCE carries an analytics tag. The mirror must
        not: the whole point of injecting is that a local build can omit it.
      * no anchor       -> the page has neither `</head>` nor `</title>`; it is not
        a shape this injector understands and it must not be published untagged
        while the gate claims full coverage.
      * ambiguous       -> more than one anchor; refuse to pick.
    """
    if analytics_endpoints(html):
        raise InjectionError(
            f"{path}: the SOURCE already carries an analytics tag "
            f"({analytics_endpoints(html)}). The committed mirror must carry NO "
            f"tag — the tag is injected into the _site/ artifact copy so that a "
            f"local build can omit it (E2.1 Done-when 2).\n"
            f"Remediation: remove the tag from the authored source in physics and "
            f"re-publish; do not hand-add it to the mirror."
        )

    anchor = _HEAD_CLOSE if _HEAD_CLOSE in html else _TITLE_CLOSE
    n = html.count(anchor)
    if n == 0:
        raise InjectionError(
            f"{path}: no place to put the analytics tag — the page carries "
            f"neither {_HEAD_CLOSE!r} nor {_TITLE_CLOSE!r}. Every published page "
            f"has one or the other (headed pages, and the three headless root "
            f"pages rendered from root_base.html.j2). This page is a shape the "
            f"injector does not know, and publishing it untagged while the "
            f"coverage gate claims every page is covered is the failure this "
            f"abort exists to prevent."
        )
    if n > 1:
        raise InjectionError(
            f"{path}: {n} occurrences of {anchor!r} — the injector refuses to "
            f"guess which head is the document's."
        )

    tag = tag_html(code, path)
    if anchor == _HEAD_CLOSE:
        return html.replace(anchor, tag + anchor, 1)
    # Headless fragment: after the title, not before it — the title must stay the
    # first thing a reader/crawler sees, and line 1 is the provenance banner.
    return html.replace(anchor, anchor + "\n" + tag.rstrip("\n"), 1)


# ---------------------------------------------------------------------------
# D2 item 1's THIRD build — the flag's delta, as a pure decision point (E2.2)
# ---------------------------------------------------------------------------


def flag_delta_violations(
    off: Mapping[str, bytes],
    on: Mapping[str, bytes],
    pages: Sequence[str],
    code: str,
    unchanged: Callable[[str, bytes, bytes], bool],
) -> list[str]:
    """Is the flag-ON tree EXACTLY the flag-OFF tree plus the analytics tag?

    D2 item 1's rule, executable: *"the only deltas are analytics ``<script>``
    nodes — exactly one per HTML file that RECEIVES the tag — and nothing else."*
    ``[]`` means the rule holds.

    PROVEN CONSTRUCTIVELY, NOT DESCRIPTIVELY. The tempting shape is to diff the two
    trees and check each delta "looks like" a script node — which is the
    substring-matching bug E1.2 hit twice, one layer up. Instead this RE-DERIVES the
    expected ON bytes with the real :func:`inject` and demands equality. So it
    proves, in one comparison and with no parsing of the delta:

      * every page RECEIVED the tag (a missed page fails: bytes differ);
      * it received exactly ONE, in the right place, pointing at the right endpoint
        (inject's own contract);
      * NOTHING ELSE on that page moved (any other edit fails the equality);
      * no other file in the artifact moved at all.

    WHICH FILES MAY CHANGE IS `pages.yaml`, NOT A GLOB — the same single referent
    stage 4b injects over, so the check cannot drift from the injector. D2's prose
    anticipated the delta also covering `_site/sim/**` sub-pages, because it assumed
    a `base.html.j2` + sim-vendoring injection; E2.1 measured that impossible (the
    render is private, CI hermetic) and injects `pages.yaml` rows only — and E2.2
    measured that every sim embed has a parent-side play control, so no shim lands
    in a sim artifact copy either. Under the SHIPPED design "one per `pages.yaml`
    page" is exactly true, and this iterates the rows rather than pinning 13.

    ``unchanged`` is INJECTED rather than imported: the non-page comparison has to
    honor D1's ONE named exclusion (``generated_at``, via
    ``mirror_manifest.canonical_json_bytes``), and this module is deliberately
    stdlib-only and dependency-free. The caller owns that rule and passes it in.
    """
    violations: list[str] = []
    page_set = set(pages)
    both = set(off) & set(on)

    for rel in sorted(set(off) - set(on)):
        violations.append(
            f"{rel}: present with the flag OFF but MISSING with it ON — the "
            f"analytics flag must ADD a tag, never remove a file."
        )
    for rel in sorted(set(on) - set(off)):
        violations.append(
            f"{rel}: the analytics flag CREATED this file. The flag gates the tag "
            f"and nothing else."
        )
    for rel in sorted(page_set - both):
        violations.append(
            f"{rel}: pages.yaml names it, but it is not in both builds — a page "
            f"the injector cannot have covered."
        )

    for rel in sorted(both):
        if rel in page_set:
            try:
                want = inject(off[rel].decode("utf-8"), code, rel).encode("utf-8")
            except (InjectionError, UnicodeDecodeError) as exc:
                violations.append(f"{rel}: cannot re-derive the expected bytes: {exc}")
                continue
            if on[rel] != want:
                violations.append(
                    f"{rel}: the flag-ON bytes are NOT exactly the flag-OFF bytes "
                    f"+ the analytics tag. Either the page did not receive the tag, "
                    f"or the flag changed something ELSE on it — both are the "
                    f"failure D2 item 1's third build exists to catch."
                )
        elif not unchanged(rel, off[rel], on[rel]):
            violations.append(
                f"{rel}: changed under the analytics flag, but it is NOT a "
                f"pages.yaml row — so nothing should have injected into it. The "
                f"flag's blast radius is the page set, or the rule is wrong."
            )
    return violations
