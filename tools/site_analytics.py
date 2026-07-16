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
"""
from __future__ import annotations

import os
import re
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
# The markup — ONE producer
# ---------------------------------------------------------------------------


def tag_html(code: str) -> str:
    """The analytics tag for ``code``: a DNT-guarded loader for count.js.

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
      * it is STATIC — no nonce, no timestamp, no per-build value — so the build
        stays byte-deterministic with the flag on (D2's rule; E2.2 owns extending
        the matrix to three builds).
    """
    return (
        f'<!-- analytics: {VENDOR} — no cookies, no PII. Not loaded at all when '
        f'Do Not Track / Global Privacy Control is set. Injected at build time by '
        f'build.py stage 4b; the authored source carries no tag. -->\n'
        f'<script {ENDPOINT_ATTR}="{endpoint(code)}">\n'
        f'(function () {{\n'
        f'  var n = window.navigator || {{}};\n'
        f'  if (n.doNotTrack === "1" || n.msDoNotTrack === "1" ||\n'
        f'      window.doNotTrack === "1" || n.globalPrivacyControl === true) {{ return; }}\n'
        f'  var s = document.createElement("script");\n'
        f'  s.async = true;\n'
        f'  s.src = "{COUNT_JS}";\n'
        f'  document.head.appendChild(s);\n'
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


def inject(html: str, code: str, path: str = "<page>") -> str:
    """Return ``html`` with the analytics tag added to its head, exactly once.

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

    tag = tag_html(code)
    if anchor == _HEAD_CLOSE:
        return html.replace(anchor, tag + anchor, 1)
    # Headless fragment: after the title, not before it — the title must stay the
    # first thing a reader/crawler sees, and line 1 is the provenance banner.
    return html.replace(anchor, anchor + "\n" + tag.rstrip("\n"), 1)
