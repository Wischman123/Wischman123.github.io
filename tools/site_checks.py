#!/usr/bin/env python3
r"""site_checks.py — the site's structural assertions, in ONE home.

OWNED BY `verify_live.py` (showcase_site_architecture_v1, A0.2 step 6). It
relocates with it at D1. `stage_local_preview.py` IMPORTS it until D1 retires the
stager. **One home, two importers — never two copies.** A validator with two
authors is the bug this plan's own validator must not have.

WHY THIS MODULE EXISTS
======================
Every gate the showcase already ships targets a LOCAL TREE via `--root`. Nothing
crawls the LIVE deployed URL — so the assertions that prove the site is whole have
never once been run against the thing the reader actually loads. Rather than
re-implement them against HTTP (two copies, guaranteed to drift), the assertions
are LIFTED here and made source-agnostic:

    LocalTree(root)     read/exists against a directory
    LiveSite(base_url)  read/exists against https://…  (HTTP 200 == exists)

The assertions never learn which one they got. That is the whole seam.

DERIVE, NEVER HARDCODE
======================
The expected rail is derived from `deep_nav.SITE_NAV` — this module asserts
SET-EQUALITY on hrefs, never a count. A magic link count inside the plan's central
validator is guess-and-check: it encodes a constant nobody derived, and it
false-fails the day the nav legitimately changes. (`check_mirror_complete` DID
compare a count; lifting it here upgraded it, because a count is satisfied by a
rail carrying eleven links to the WRONG pages.)

THE PAGE SET IS `pages.yaml`; THE ASSERTION SET IS NOT
======================================================
Two classes, partitioned by a PATH PREDICATE in code (never a `pages.yaml`
column — step 4's one-column rule stands):

  * RAIL-BEARING — everything rendered from `base.html.j2`. The rail, the
    SITE_NAV href set-equality and the single-`aria-current` assertion run HERE.
  * VENDORED — `sim/**` and `plain-vs-engine.html`, which carry NO rail by
    construction (E2.1: *"at least two of the twelve published pages do not extend
    base.html.j2"*).

Run the rail assertions flat over every `pages.yaml` row and the plan's central
validator is RED FROM BIRTH on a correct site — and a validator that is red from
birth is a validator that gets disabled.

WHAT THIS MODULE DOES **NOT** ASSERT
====================================
The ABSENCE of `SITERAIL`/`STORY` marker pairs. A1 RETAINS them by design (as
empty regions, so the existing injectors still have anchors); B1 removes them,
gated by B1's Done-when 1 under the comparator's marker-comment rule. An absence
assertion here would be RED against the live site the day it was written — the
markers are in the served HTML right now.

Liveness and structure only. The Tier-1 baseline compare is NOT this module's job;
it lives in `compare_dom.py --against-baseline`.
"""
from __future__ import annotations

import posixpath
import re
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

SHOWCASE_DIR = Path(__file__).resolve().parent
if str(SHOWCASE_DIR) not in sys.path:
    sys.path.insert(0, str(SHOWCASE_DIR))

import deep_nav  # noqa: E402

# --------------------------------------------------------------------------
# The two sources. Same three methods; the assertions never learn which is which.
# --------------------------------------------------------------------------


@dataclass
class LocalTree:
    """A local rendered tree (`out/staging`, a baseline dir, the publish clone)."""

    root: Path
    kind: str = "root"

    def read(self, rel: str) -> str | None:
        p = self.root / rel
        if not p.is_file():
            return None
        return p.read_text(encoding="utf-8", errors="replace")

    def exists(self, rel: str) -> bool:
        return (self.root / rel).exists()

    def describe(self) -> str:
        return f"local tree {self.root}"


@dataclass
class LiveSite:
    """The deployed site, over HTTP. `exists` == HTTP 200.

    THE CDN PROPAGATION RETRY + CACHE-BUST IS LIFTED, NOT RE-DERIVED — from
    `docs/plans/state/fieldlab_equipotential_levels_v1/p4_deploy_hash_verify.py`,
    the repo's only live-URL verifier. GitHub Pages' CDN lags a push, so a fresh
    deploy answers 404 for a while; a verifier without this is a verifier that
    fails on a green deploy and teaches everyone to re-run it until it passes.
    """

    base_url: str
    tries: int = 5
    sleep_s: float = 6.0
    timeout_s: float = 20.0
    #: rel -> (status, body). One fetch per URL per run.
    _cache: dict[str, tuple[int, str]] = field(default_factory=dict, repr=False)

    def _url(self, rel: str, bust: int) -> str:
        return f"{self.base_url.rstrip('/')}/{rel.lstrip('/')}?v={bust}"

    def fetch(self, rel: str) -> tuple[int, str]:
        if rel in self._cache:
            return self._cache[rel]
        status, body = 0, ""
        for attempt in range(1, self.tries + 1):
            req = urllib.request.Request(
                self._url(rel, attempt),
                headers={"Cache-Control": "no-cache", "Pragma": "no-cache"},
            )
            try:
                with urllib.request.urlopen(req, timeout=self.timeout_s) as r:
                    status = r.status
                    body = r.read().decode("utf-8", errors="replace")
                break
            except urllib.error.HTTPError as e:
                status, body = e.code, ""
                if e.code == 404 and attempt < self.tries:
                    time.sleep(self.sleep_s)  # propagation, not absence — yet
                    continue
                break
            except Exception as e:  # noqa: BLE001 — transient network
                status, body = -1, str(e)
                if attempt < self.tries:
                    time.sleep(self.sleep_s)
                    continue
                break
        self._cache[rel] = (status, body)
        return status, body

    def read(self, rel: str) -> str | None:
        status, body = self.fetch(rel)
        return body if status == 200 else None

    def exists(self, rel: str) -> bool:
        return self.fetch(rel)[0] == 200

    def describe(self) -> str:
        return f"live site {self.base_url}"


# --------------------------------------------------------------------------
# The page-class partition — a PATH PREDICATE, never a pages.yaml column.
# --------------------------------------------------------------------------

#: Published pages that do NOT extend base.html.j2 and carry NO rail. `sim/**` is
#: the vendored simulator shell; `plain-vs-engine.html` is a generated standalone
#: comparison artifact (export_site.ROOT_ASSETS).
def is_vendored(path: str) -> bool:
    """True for a published page that carries no rail BY CONSTRUCTION."""
    return path.startswith("sim/") or path == "plain-vs-engine.html"


def is_rail_bearing(path: str) -> bool:
    """True for a page rendered from base.html.j2 — the rail assertions' domain."""
    return not is_vendored(path)


#: published path -> SITE_NAV slug. DERIVED by inverting href_for(slug, "root"),
#: which IS the published root-relative path. Never a second hand-written map.
def path_to_slug() -> dict[str, str]:
    return {deep_nav.href_for(slug, "root"): slug for slug, _ in deep_nav.SITE_NAV}


def link_context(path: str) -> str:
    """The DIRECTORY DEPTH a page's links are written from — "deep" for
    `deep/*.html`, "root" otherwise. This is the whole reason `href_for` takes a
    context: a root page writes `deep/sims.html`, a deep page writes
    `../index.html`. Resolving both against the tree root would pass a
    wrong-depth href and miss the exact 404 the gate exists to catch.
    """
    return "deep" if path.startswith("deep/") else "root"


def resolve_from(path: str, href: str) -> str:
    """`href`, written on page `path`, as a NORMALIZED root-relative path.

    `resolve_from("deep/code.html", "../index.html")` -> `"index.html"`.

    The normpath is load-bearing, and its absence hid behind two coincidences:
    `urllib` collapses `..` in a URL before the request leaves, and `pathlib`
    collapses it against the filesystem — so an un-normalized `deep/../index.html`
    resolved to 200 live AND existed on disk, and the gate went green while
    handing every downstream consumer a path that is not the page's canonical
    name. Anything that then JOINS this against `pages.yaml` (E2's per-page
    coverage, F1's count) would silently miss.
    """
    base = posixpath.dirname(path)
    return posixpath.normpath(posixpath.join(base, href) if base else href)


# --------------------------------------------------------------------------
# The lifted assertions. Pure predicates over (html, path) + a source.
# --------------------------------------------------------------------------

#: One scanner walking the document IN ORDER: a <script>/<style> element, or an
#: HTML comment. Whichever STARTS first wins the text it spans.
_HTML_TOKEN_RE = re.compile(
    r"<script\b.*?</script\s*>|<style\b.*?</style\s*>|<!--(?P<body>.*?)-->",
    re.S | re.I,
)


def nested_comment_snippets(text: str) -> list[str]:
    """HTML comments do not nest: inside a comment, a second ``<!--`` before the
    first ``-->`` means the comment ends EARLY and its tail renders as visible
    body text. Returns a short snippet per offending comment (empty == clean).

    LIFTED VERBATIM from `stage_local_preview.py` (which now imports it from
    here). This is exactly the injector-marker-leak class the plan's table names,
    and it is the predicate that caught the front page rendering a comment as
    visible text while every markup, link and weight gate stayed green.

    A PURE PREDICATE, because the inline version had a real FALSE-POSITIVE bug and
    a gate that cries wolf gets switched off: it pre-stripped script/style with a
    regex over the WHOLE document, so a comment that merely MENTIONED
    `<script src=…>` in prose swallowed its own `-->`. The fix is ORDER, not
    cleverness — scan once, left to right; each construct is only interpreted
    where it actually has meaning.
    """
    out: list[str] = []
    for m in _HTML_TOKEN_RE.finditer(text):
        body = m.group("body")
        if body is not None and "<!--" in body:
            out.append(" ".join(body.split())[:70])
    return out


def check_comments(html: str, path: str) -> list[str]:
    """The marker-leak class, on EVERY page (rail-bearing and vendored alike)."""
    return [
        f"{path}: NESTED HTML comment — an inner '-->' ends it early and the rest "
        f"renders as visible page text: '{s}…'"
        for s in nested_comment_snippets(html)[:1]
    ]


_RAIL_RE = re.compile(r'<aside class="siterail".*?</aside>', re.S)
_RAIL_PAGE_RE = re.compile(r'<a class="rail-page" href="([^"]+)"([^>]*)>')
_RAIL_ANCHOR_RE = re.compile(r'<a class="rail-anchor" href="([^"]+)"')


def check_rail(html: str, path: str, source) -> list[str]:
    """The rail assertions — RAIL-BEARING PAGES ONLY (see the module docstring).

    Asserts, all derived from `deep_nav.SITE_NAV`:
      * the rail is PRESENT;
      * its href set EQUALS the SITE_NAV-derived set for this page's depth
        (set-equality, not a count);
      * every rail href RESOLVES against the source;
      * exactly ONE entry is aria-current="page", AND IT IS THIS PAGE.
    """
    violations: list[str] = []
    m = _RAIL_RE.search(html)
    if not m:
        violations.append(
            f"{path}: carries NO site rail — the page has no navigation at all "
            f"(deep pages inherit it from base.html.j2; root pages are stamped by "
            f"inject_site_rail.py)"
        )
        return violations
    body = m.group(0)
    ctx = link_context(path)

    # --- href SET-equality against the derived spine (never a count) ---
    want = {deep_nav.href_for(slug, ctx) for slug, _ in deep_nav.SITE_NAV}
    found = _RAIL_PAGE_RE.findall(body)
    got = {href for href, _ in found}
    for missing in sorted(want - got):
        violations.append(
            f"{path}: rail is MISSING the SITE_NAV href {missing!r} — the rail is "
            f"not rendering the whole spine"
        )
    for extra in sorted(got - want):
        violations.append(
            f"{path}: rail carries {extra!r}, which is NOT in the SITE_NAV-derived "
            f"href set for a {ctx!r} page"
        )

    # --- every rail href RESOLVES (a 404 on click) ---
    for href in sorted(got):
        if href.startswith(("http://", "https://", "//", "#", "mailto:")):
            continue
        target = resolve_from(path, href)
        if not source.exists(target):
            violations.append(
                f"{path}: rail href {href!r} does NOT resolve (-> {target!r}) on "
                f"{source.describe()} — 404 on click"
            )

    # --- exactly one aria-current, AND IT IS THIS PAGE ---
    current = [href for href, attrs in found if 'aria-current="page"' in attrs]
    slug = path_to_slug().get(path)
    if len(current) != 1:
        violations.append(
            f"{path}: rail marks {len(current)} entries aria-current=\"page\" "
            f"(expected exactly 1 — the page you are on)"
        )
    elif slug is not None:
        want_href = deep_nav.href_for(slug, ctx)
        if current[0] != want_href:
            violations.append(
                f"{path}: rail marks {current[0]!r} as the current page, but this "
                f"page is {slug!r} ({want_href!r}) — the rail highlights the wrong entry"
            )

    # --- the "On this page" zone points at ids that EXIST ---
    for href in _RAIL_ANCHOR_RE.findall(body):
        if href.startswith("#") and f'id="{href[1:]}"' not in html:
            violations.append(
                f"{path}: rail anchor {href!r} points at no id on the page "
                f"(a link that scrolls nowhere)"
            )
    return violations


_ASSET_RE = re.compile(r'\s(?:src|href)="([^"?#][^"?#]*)"')
_EMBED_RE = re.compile(r'data-embed-src="([^"?#]+)"')
_SKIP_ASSET = ("http://", "https://", "//", "data:", "mailto:", "#", "javascript:")

#: The story spine on index.html, located STRUCTURALLY — by the section it renders.
#:
#: WHY THIS EXISTS (showcase_site_architecture_v1, B1)
#: ===================================================
#: Three separate live gates used to find the story by its INJECTION MARKERS
#: (`<!-- STORY BEGIN -->` … `<!-- STORY END -->`):
#:
#:   * stage_local_preview.check_mirror_complete  — "the story block is present"
#:   * stage_local_preview.check_story_block      — the story's CONTENT gates
#:     (stat provenance + the un-provenanced-numeral scan)
#:   * next_band.private_copy_violations          — stripped the rail's marked block
#:
#: B1 deletes those markers: the story is a template `{% include %}` now, and the
#: rail is a macro call, so nothing stamps anything and there is no marked region
#: left to find. Every one of those gates was therefore about to start matching
#: NOTHING — and two of them treated "no match" as "nothing to check", so they
#: would have gone SILENTLY GREEN on a homepage with no story at all. (The
#: presence check was the loud one; it is what caught this.)
#:
#: So the region is located by what it IS rather than by a comment that used to
#: sit around it: the `<section id="story">` the template actually renders. That is
#: the same element the rail's `#story` anchor points at, so if this stops matching,
#: the page is genuinely broken rather than merely re-plumbed.
_STORY_SECTION_RE = re.compile(
    r'<section\b[^>]*\bid="story"[^>]*>.*?</section\s*>', re.S | re.I
)


def story_section(html: str) -> str | None:
    """The story spine's markup, or None if the page carries no story.

    A PURE PREDICATE-shaped extractor with ONE home, because three gates depend on
    it and a "region not found" answer means opposite things to them: to the
    presence check it is a VIOLATION, to the content gates it is "nothing to scan".
    Getting that backwards is how a gate goes quietly green on an empty page —
    which is exactly what the marker-based version was about to do. Callers must
    decide explicitly; this only reports.
    """
    m = _STORY_SECTION_RE.search(html)
    return m.group(0) if m else None


def referenced_assets(html: str) -> list[str]:
    """Every LOCAL asset a page references (src/href, plus the sim embed's
    data-embed-src, which no src scan can see)."""
    refs = set(_ASSET_RE.findall(html)) | set(_EMBED_RE.findall(html))
    return sorted(r for r in refs if not r.startswith(_SKIP_ASSET))


def check_assets(html: str, path: str, source) -> list[str]:
    """The referenced-ASSET half of C1's completeness claim: every asset the page
    points at answers 200 / exists. (`pages.yaml` owns the PAGE half; this owns
    the asset half — two mechanisms, no gap, neither pretending to be the other.)
    """
    violations = []
    for ref in referenced_assets(html):
        target = resolve_from(path, ref)
        if not source.exists(target):
            violations.append(
                f"{path}: referenced asset {ref!r} does NOT resolve (-> {target!r}) "
                f"on {source.describe()}"
            )
    return violations


def check_page(html: str, path: str, source) -> list[str]:
    """Every assertion that applies to `path`, class-partitioned."""
    violations = check_comments(html, path)          # every page
    violations += check_assets(html, path, source)   # every page
    if is_rail_bearing(path):
        violations += check_rail(html, path, source)  # rail-bearing only
    return violations
