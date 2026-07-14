#!/usr/bin/env python3
r"""deep_nav.py — the ONE canonical nav spine for the WHOLE showcase site.

TWO LISTS, ONE OWNERSHIP RULE
=============================
There are exactly two ordered ``(slug, label)`` lists in this module, and they
answer two DIFFERENT questions. Read this before touching either.

``SITE_NAV`` — **the RAIL.** Every page of the site, in the order the reader
sees them in the left rail: the front page, then the technical wing, then
videos. It is rendered on EVERY page, from BOTH directory contexts (a root page
and a ``deep/`` page derive different hrefs from the same list — see
:func:`href_for`). Adding a page to the site is a ONE-line edit here.

``DEEP_NAV`` — **the next-page BANNER chain.** A DERIVED VIEW of ``SITE_NAV``
(the technical-wing slice: everything that is not the front page or videos). It
is the wing's *reading order*, and it is what :func:`successor` walks to answer
"which page does the bottom banner send me to next?".

Why they are not the same list: ``successor()`` must NOT walk ``SITE_NAV``.
``SITE_NAV`` carries the front page and videos, which are not steps in the wing's
reading order — so a ``SITE_NAV``-walking successor would hand the front page a
derived banner (it has a hand-authored one) and hand the LAST wing page a "Next:
Videos" banner instead of the "back to the front page" one it is supposed to end
on. ``successor()`` therefore returns ``None`` for ``index``, for ``videos``, and
for the last wing page (fail-soft: no banner rather than a wrong one).

**This hazard got SUBTLER in N5, so do not relax the guard.** Until N5 the wing
began with ``sims``, and a ``SITE_NAV``-walking successor announced itself loudly:
``successor("index")`` came back ``("sims", …)`` and the front page's band visibly
re-aimed from Architecture to ``deep/sims.html``. N5 moved ``sims`` down the wing,
so ``architecture`` is now the first slug after ``index`` — and a ``SITE_NAV``-
walking successor would return ``("architecture", …)``, which is exactly where the
hand-authored band already points. The bug would LOOK right on the front page and
still be wrong at the tail. The tests hold the line from both ends
(``test_d_successor_of_index_is_not_a_wing_page`` pins ``None`` at the head,
``test_d_successor_walks_deep_nav_in_order`` pins ``None`` at the tail); a reader
who notices only the front page must not conclude the distinction stopped
mattering. The front page's band (``.arch-fade`` in ``public/index.html``) leads
to **Architecture** by design (review item 9) and is hand-authored, not derived.

Because ``DEEP_NAV`` is *computed from* ``SITE_NAV`` rather than typed out a
second time, the two cannot drift: reorder or relabel the wing in ``SITE_NAV``
and the banner chain follows automatically.

WHO CONSUMES THIS
=================
  * ``templates/_siterail.html.j2`` — THE site rail component (one left rail, on
    every page). It renders ``SITE_NAV`` and is the only thing that renders it.
  * ``base.html.j2`` — calls that macro with ``context="deep"`` for every
    generated ``deep/*.html`` page, and renders the bottom ``.nextbar`` banner
    from :func:`successor`.
  * ``inject_site_rail.py`` — calls the SAME macro with ``context="root"`` and
    stamps it into the four hand-authored root pages (``index``, ``systems``,
    ``architecture``, ``videos``), which link wing pages one directory DOWN as
    ``deep/sims.html``.

  (``inject_arch_nav.py`` — which injected the old ``.deepnav`` strip into
  architecture.html alone — is RETIRED BY DISUSE as of N2. It is still on disk
  and still imports ``DEEP_NAV``; nothing calls it.)

Why a Python module and not a Jinja ``{% set %}`` literal: a Jinja literal is
not importable, and the injector is Python that must consume the SAME order +
labels. This closes the single-source design's two real gaps — the import path,
and the fact that ONE baked ``href`` cannot be correct from two directory
depths. The lists carry slug + label ONLY; each renderer DERIVES its own hrefs
for its directory depth via :func:`href_for`. This is also the single place the
``atlas`` -> ``systems.html`` filename mapping lives, so the surfaces cannot
drift.

Label strings may embed the ``&nbsp;`` HTML entity (e.g. ``Engine&nbsp;Room``)
so a two-word tab never wraps; templates render them through ``|safe`` — they
are first-party constants, never user input.

Stdlib only (no jinja2 import) so the injector can import the data with no side
effects; :func:`install` is duck-typed on a jinja2 ``Environment``.
"""
from __future__ import annotations

#: The canonical SITE spine: ``(slug, label)`` for every page of the site, in
#: RAIL order — the front page, then the technical wing in its narrative reading
#: order (a deliberate spine, NOT alphabetical), then videos. ``slug`` matches
#: each deep page's ``page_class`` block; ``label`` is the visible link text.
#:
#: History (the edits that are one-liners HERE and must be made nowhere else):
#:   * 2026-07-12 — ``story`` left the spine: the story was transplanted onto the
#:     site front page (``inject_story_section.py``); ``deep/story.html`` no
#:     longer exists.
#:   * 2026-07-12 (review items 10 + 11) — ``code`` moved BEFORE ``engine``, and
#:     ``Meta&nbsp;Layer`` was relabelled ``Meta&nbsp;Tools``.
#:   * 2026-07-12 (review item 10, N1) — ``verification`` JOINED the spine,
#:     immediately after ``code``: the "Formal Verification" tab, which now hosts
#:     the weld gates + the FV triangulation exhibit that used to live on the
#:     engine page (``render_verification.py``). A WING page, so it is in neither
#:     ``_ROOT_SLUGS`` nor ``_NON_WING_SLUGS`` — it joins ``DEEP_NAV`` and the
#:     successor chain (``... code -> verification -> engine ...``) by derivation,
#:     with no second edit.
#:   * 2026-07-12 (review item 14) — ``index`` + ``videos`` JOINED the spine: the
#:     rail must reach the whole site, not only the wing. They are ROOT pages
#:     (see ``_ROOT_SLUGS``), so ``href_for`` gives them the right depth from
#:     both contexts; no second href scheme was added.
#:   * 2026-07-12 (review item 14, N2) — ``systems`` JOINED the spine. It was the
#:     ROOT ``systems.html`` (the live-exhibit page), a DIFFERENT PAGE from the
#:     wing's ``atlas`` -> ``deep/systems.html``.
#:   * 2026-07-13 (review item 8c + decision D3, N4) — ``systems`` LEFT the spine
#:     again, and the ROOT ``systems.html`` was DELETED. Every section of that
#:     hand-authored old-theme page was relocated into the wing: the field lab +
#:     Coulomb/RLC exhibits to Sims, the library-learns + comparison cards to the
#:     Gallery, and the "Numbers with receipts" readout to Formal Verification
#:     (its published-scene figure is now RECOUNTED from the scenario registry
#:     rather than hand-typed). Only "the gate says no" was intentionally dropped.
#:     The ``atlas`` slug — which SHIPS AS ``deep/systems.html`` and is a wholly
#:     different page — is untouched: the two only ever shared a filename, and
#:     nothing maps filename -> slug, so removing one left the other inert.
#:   * 2026-07-13 (review item 9, N5) — ``sims`` MOVED from the head of the wing to
#:     sit immediately after ``meta``. It was the first thing a reader met after
#:     the front page; it now lands where the wing has EARNED it — after the
#:     architecture, the code, the proofs, the engine, the atlas and the tools that
#:     build it. Every consuming surface followed with no second edit: ``DEEP_NAV``
#:     is derived, so the rail, both bands and the whole successor chain re-linked
#:     themselves to ``architecture -> code -> verification -> engine -> atlas ->
#:     meta -> sims -> gallery -> (home)``. This is the one-line edit the module's
#:     ownership rule promises.
#:   * 2026-07-13 (lab wing, Phase L1) — ``lab`` JOINED the spine, immediately
#:     after ``meta``: the page where the collaboration itself is the
#:     experimental subject (mode experiments, the config trial, the proxy-gate
#:     detector, the doc-mediated loop). A WING page — it joins ``DEEP_NAV`` and
#:     the successor chain by derivation, with no second edit.
#:   * 2026-07-13 (Brendan's review, same day) — ``lab`` MOVED up to sit
#:     immediately after ``verification``, and ``meta`` moved to follow it:
#:     ``... code -> verification -> lab -> meta -> engine -> atlas -> sims ...``.
#:     His stated order (items 3+4 of the lab-page review): the
#:     self-improvement pages lead the wing's back half, the engine room and
#:     atlas follow. One edit HERE; the rail, both bands and the successor
#:     chain re-derived themselves, as this module's ownership rule promises.
SITE_NAV: list[tuple[str, str]] = [
    ("index", "Home"),
    ("architecture", "Architecture"),
    ("code", "Code"),
    ("verification", "Formal&nbsp;Verification"),
    ("lab", "The&nbsp;Lab"),
    ("meta", "Meta&nbsp;Tools"),
    ("engine", "Engine&nbsp;Room"),
    ("atlas", "Systems&nbsp;Atlas"),
    ("sims", "Sims"),
    ("gallery", "Gallery"),
    ("videos", "Videos"),
]

#: Slugs that are NOT part of the technical wing — the front page and the video
#: index. They carry the rail like every other page, but they are not steps in the
#: wing's reading order, so they are excluded from the banner chain
#: (``successor()`` returns ``None`` for each: no bottom banner is injected on
#: them, and the front page keeps its hand-authored band).
#: (``systems`` — the ROOT live-exhibit page — was here until N4 deleted it.)
_NON_WING_SLUGS: frozenset[str] = frozenset({"index", "videos"})

#: The wing's reading order — a DERIVED VIEW of ``SITE_NAV``, never a second
#: hand-typed list (see the module docstring's ownership rule). :func:`successor`
#: walks THIS, so the bottom next-page banner chains through the technical wing
#: only: architecture -> code -> verification -> engine -> atlas -> meta -> sims
#: -> gallery -> (home).
DEEP_NAV: list[tuple[str, str]] = [
    (slug, label) for slug, label in SITE_NAV if slug not in _NON_WING_SLUGS
]

#: Every slug the site knows. A slug outside this set is a typo or a page that
#: was never added to the spine — either way :func:`filename_for` and
#: :func:`href_for` raise on it rather than emitting an href that 404s.
KNOWN_SLUGS: frozenset[str] = frozenset(slug for slug, _ in SITE_NAV)

#: slug -> filename overrides. The systems-atlas page ships as ``systems.html``
#: (its slug is ``atlas``); every other slug maps to ``<slug>.html``.
_FILENAME_OVERRIDES: dict[str, str] = {"atlas": "systems.html"}

#: Slugs whose page lives at the site ROOT, one directory ABOVE ``deep/`` — NOT
#: under ``deep/`` like the wing's pages: ``architecture.html``, ``index.html``
#: and ``videos.html`` all sit next to each other at the root.
#:
#: This set is the whole reason :func:`href_for` exists. ``filename_for`` can
#: only ever yield a BARE filename, so a deep page linking ``architecture``
#: through it emits ``architecture.html`` — which resolves to
#: ``deep/architecture.html`` and 404s, because the file is one directory up.
#: One baked href cannot be correct from two directory depths; the fix is to
#: derive per CONTEXT. Note ``atlas`` -> ``systems.html`` is a WING page
#: (``deep/systems.html``) and is deliberately NOT here. Until N4 there was also a
#: ROOT ``systems.html`` under its own ``systems`` slug, and the two shared a
#: filename at two depths — inert, because nothing maps filename -> slug. N4
#: deleted the root page; ``atlas`` keeps the filename, and this set no longer
#: needs to disambiguate it from anything.
_ROOT_SLUGS: frozenset[str] = frozenset(
    {"architecture", "index", "videos"}
)

#: The site front page's label in the LAST page's banner ("Back to the front
#: page"). The href is DERIVED (see :data:`HOME_HREF` below), never baked.
HOME_LABEL = "the front page"

#: The id of the story section on the front page (``inject_story_section.py``
#: emits ``<section id="story">``). The story is no longer a page, so it has no
#: spine slug and :func:`href_for` cannot reach it — but four deep pages still
#: link to it in prose ("-> one problem's life"). Those links must be DERIVED
#: from one place for the same reason the nav hrefs are: from ``deep/`` the front
#: page is ``../index.html``, from the root it is ``index.html``, and a baked
#: href is right from at most one of them.
STORY_ANCHOR_ID = "story"

#: The two directory depths a link can be written FROM. ``"deep"`` = a
#: ``deep/*.html`` page; ``"root"`` = a page at the site root.
_CONTEXTS: tuple[str, str] = ("deep", "root")


def filename_for(slug: str) -> str:
    """Bare filename of ``slug``'s page (``atlas`` -> ``systems.html``; every
    other slug -> ``<slug>.html``).

    Raises ``ValueError`` on a slug that is not in the spine — a page nobody
    declared cannot have a correct href, and a silent ``<typo>.html`` is a 404
    that ships.
    """
    if slug not in KNOWN_SLUGS:
        raise ValueError(
            f"filename_for: unknown slug {slug!r} — not in SITE_NAV "
            f"({', '.join(sorted(KNOWN_SLUGS))}). Add the page to SITE_NAV; "
            f"do not hand-write its href."
        )
    return _FILENAME_OVERRIDES.get(slug, f"{slug}.html")


def is_root_page(slug: str) -> bool:
    """True when ``slug``'s page lives at the site root, not under ``deep/``."""
    return slug in _ROOT_SLUGS


def href_for(slug: str, context: str) -> str:
    """The href a page in ``context`` uses to reach ``slug``.

    ``context`` is where the LINK lives, not where the target lives:

      * ``"deep"`` — rendering a ``deep/*.html`` page (``base.html.j2``).
        A root page is one directory UP (``../architecture.html``,
        ``../index.html``); every wing page is a sibling (``sims.html``) — i.e.
        IDENTICAL to :func:`filename_for`, so the deriver is non-regressing for
        the wing (``verify_deep_dive.check_nav_href_regression`` asserts exactly
        that, for every slug in the spine).
      * ``"root"`` — rendering a root page (``index.html``, ``architecture.html``,
        ``videos.html``). A root page is a sibling (``architecture.html``); every
        wing page is one directory DOWN (``deep/sims.html``).

    Raises ``ValueError`` on an unknown context OR an unknown slug — a silent
    wrong-depth href is exactly the 404 this function exists to prevent, so fail
    loud on both halves of the input.
    """
    if context not in _CONTEXTS:
        raise ValueError(
            f"href_for: unknown context {context!r} — expected 'deep' or 'root'"
        )
    filename = filename_for(slug)  # raises on an unknown slug
    if context == "deep":
        return f"../{filename}" if is_root_page(slug) else filename
    return filename if is_root_page(slug) else f"deep/{filename}"


#: The front page, as linked FROM a deep page (``../index.html``) — where the
#: LAST wing page (gallery) sends its banner. Derived from the spine, not typed:
#: ``index`` is a spine slug now, so a hand-written literal here would be the
#: second href scheme this module exists to prevent.
HOME_HREF = href_for("index", "deep")


def story_href(context: str) -> str:
    """The href a page in ``context`` uses to reach the transplanted story.

    ``context`` is where the LINK lives (same convention as :func:`href_for`):

      * ``"deep"`` — a ``deep/*.html`` page: ``../index.html#story``.
      * ``"root"`` — a root page: ``index.html#story``.

    Raises ``ValueError`` on an unknown context — a silent wrong-depth href is
    exactly the 404 this derivation exists to prevent.
    """
    if context not in _CONTEXTS:
        raise ValueError(
            f"story_href: unknown context {context!r} — expected 'deep' or 'root'"
        )
    return f"{href_for('index', context)}#{STORY_ANCHOR_ID}"


def successor(active_slug: str) -> tuple[str, str] | None:
    """The ``(slug, label)`` entry AFTER ``active_slug`` in the WING's reading
    order (:data:`DEEP_NAV`), or ``None`` when ``active_slug`` is the LAST wing
    page (the banner then points HOME).

    ``None`` is also the answer for any slug outside the wing — including the
    site slugs ``index`` and ``videos``. That is DELIBERATE, not an oversight:
    the front page's bottom band leads to Architecture (review item 9) and is
    hand-authored in ``public/index.html``. Re-pointing this function at
    ``SITE_NAV`` would give the front page a derived banner and would replace the
    LAST wing page's "back to the front page" banner with "Next: Videos". Since
    N5 that mistake no longer announces itself at the head of the site — ``sims``
    moved down the wing, so a ``SITE_NAV`` walk would send the front page to
    Architecture, where it already goes. See the module docstring: the guard is
    load-bearing precisely because the failure is now quiet. An unknown slug
    yields ``None`` for the same fail-soft reason: no banner rather than a render
    crash.
    """
    slugs = [s for s, _ in DEEP_NAV]
    if active_slug not in slugs:
        return None
    i = slugs.index(active_slug)
    return DEEP_NAV[i + 1] if i + 1 < len(DEEP_NAV) else None


def install(env) -> None:
    """Register BOTH spines + the href derivers as Jinja globals on ``env`` so
    every nav surface renders from this one source with no per-render context
    threading. Duck-typed on the jinja2 ``Environment`` (only touches
    ``env.globals``).

    ``site_nav`` is the RAIL's list (every page); ``deep_nav`` is the wing slice
    the ``.deepnav`` strip and the banner chain use. See the module docstring.
    """
    env.globals["site_nav"] = SITE_NAV
    env.globals["deep_nav"] = DEEP_NAV
    env.globals["nav_filename"] = filename_for
    env.globals["nav_href"] = href_for
    env.globals["nav_successor"] = successor
    env.globals["nav_is_root_page"] = is_root_page
    env.globals["nav_home_href"] = HOME_HREF
    env.globals["nav_home_label"] = HOME_LABEL
    env.globals["story_href"] = story_href
