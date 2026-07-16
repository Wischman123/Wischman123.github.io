#!/usr/bin/env python3
r"""verify_live.py — the site's structural gate, against a LOCAL TREE or the LIVE URL.

    python tools/showcase/verify_live.py --base-url https://wischman123.github.io
    python tools/showcase/verify_live.py --root out/staging

WHAT IT CLOSES (showcase_site_architecture_v1, A0.2 step 6)
===========================================================
Every gate the showcase already ships targets a local tree via `--root`. NOTHING
crawls the live deployed URL — so "the site is whole" has never been asserted
against the thing a reader actually loads. This is the crawler, and it is the
final, deploy-failing step of the D1 workflow.

TWO MODES, ONE AUTHORITY
========================
It takes EITHER `--root <tree>` OR `--base-url <url>`, never both. Every caller's
mode is fixed by the plan's step-1 referent table. The name describes its ORIGIN
(the live-URL gap it was built to close), not its only mode.

THE ASSERTIONS ARE LIFTED, NOT RE-IMPLEMENTED
=============================================
They live in `site_checks.py` — one home, two importers (`stage_local_preview.py`
is the other, until D1 retires it). This module is the CRAWLER: it decides WHICH
pages to visit and WHICH class each one is in. It asserts nothing itself.

DERIVE, NEVER HARDCODE
======================
  * the PAGE set comes from `pages.yaml` (A0.2 step 4) — never a literal;
  * the expected RAIL comes from `deep_nav.SITE_NAV` — SET-equality on hrefs,
    never a count;
  * the rail-bearing/vendored partition is a PATH PREDICATE in `site_checks.py`
    — never a `pages.yaml` column.

WHAT IT ASSERTS, PER PAGE
=========================
  every page      HTTP 200 (or present on disk); every referenced asset resolves;
                  no marker comment is malformed or nested; the page is `noindex`
                  (E2.1's DECIDED site-wide state) and its analytics coverage
                  matches the build flag (below).
  rail-bearing    the rail is present and its href set EQUALS the SITE_NAV-derived
                  set; exactly one aria-current="page" and it is THIS page; every
                  rail anchor points at an id that exists.

THE ANALYTICS ASSERTION IS FLAG-SCOPED; THE `noindex` ONE IS NOT (E2.1)
=======================================================================
This module reads the SAME seam `build.py` injects from —
`site_analytics.SITE_CODE_ENV` — so the gate cannot disagree with the build about
which mode a tree was built in:

  flag ON   (CI, and every --base-url run against the deployed site)
            -> EVERY path in pages.yaml carries the tag, pointing at the
               configured endpoint.
  flag OFF  (local build.py / build_and_publish.py)
            -> NO page carries it. The inverse is asserted, not skipped, which
               turns E2.1's Done-when 2 ("a local build omits the tag") from a
               one-off grep into a standing check.

Unscoped, this assertion would red `build.py` stage 6 — the BLOCKING pre-deploy
gate — on every local run, because local builds deliberately omit the tag. That
is the plan's own "goes red on every run and gets disabled within a week" failure
pointed at its flagship gate.

`noindex` is NOT flag-gated: it ships in every build, so it is asserted in both
modes, per page (never all-or-none — that form passes a build which dropped it
everywhere).

It does NOT assert the ABSENCE of SITERAIL/STORY marker pairs (A1 retains them by
design; B1 removes them under the comparator's rule). It does NOT do the Tier-1
baseline compare — that is `compare_dom.py --against-baseline`, invoked separately
by A1, B1 and D1.1 step 1. **Liveness and structure only.**

The sim-iframe-boots-with-zero-console-errors class is owned by the seven existing
Playwright smokes (`stage_local_preview.py`), which need a real browser; `--smoke`
threads this run's page set into them rather than growing a second browser harness
here. See `--help`.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

SHOWCASE_DIR = Path(__file__).resolve().parent
if str(SHOWCASE_DIR) not in sys.path:
    sys.path.insert(0, str(SHOWCASE_DIR))

import site_analytics  # noqa: E402  (the analytics seam — the SAME one build.py reads)
import site_checks  # noqa: E402
from site_checks import LiveSite, LocalTree  # noqa: E402


def _default_pages() -> Path:
    """The canonical published-page SET (A0.2 step 4) — CO-LOCATION FIRST.

    ONE FILE, TWO HOMES (showcase_site_architecture_v1, D1.1). This module runs
    in `physics` (where `pages.yaml` lives under `docs/plans/state/…`) AND, mirrored
    VERBATIM by `site_mirror.py`, inside the PUBLIC build repo's `tools/` — where
    it is `build.py`'s stage-6 gate and there is no `claude_root()` to walk to
    (the sentinel dirs `tools/`+`physics/`+`docs/` do not exist there).

    A hardcoded `claude_root()` join at import time made this module simply
    UNIMPORTABLE in CI — so it resolves a co-located `pages.yaml` first and only
    then falls back to the plan-state home. The `_bootstrap` import is deferred
    into the fallback for the same reason: the mirror does not carry it.

    Forking the file instead would give the site two page-set referents that must
    agree and will drift — the exact disease this plan exists to cure.
    """
    here = SHOWCASE_DIR / "pages.yaml"
    if here.is_file():
        return here
    from _bootstrap import claude_root  # noqa: PLC0415
    return (claude_root() / "docs" / "plans" / "state" /
            "showcase_site_architecture_v1" / "pages.yaml")

#: The deployed origin. Used by --base-url's default and named once.
PAGES_ORIGIN = "https://wischman123.github.io"


def pages_from_yaml(path: Path) -> list[str]:
    if not path.is_file():
        raise SystemExit(
            f"ABORT: no pages.yaml at {path}\n"
            f"Remediation: python docs/plans/state/showcase_site_architecture_v1/"
            f"derive_pages_yaml.py"
        )
    out = []
    for line in path.read_text(encoding="utf-8").splitlines():
        s = line.strip()
        if s.startswith("- path:"):
            out.append(s.split(":", 1)[1].strip())
    if not out:
        raise SystemExit(
            f"ABORT: {path} lists no pages. A crawl of the empty set is not a pass."
        )
    return out


def verify(
    source, pages: list[str], *, analytics_endpoint: str | None = None
) -> tuple[list[str], dict[str, int]]:
    """Crawl every page; return (violations, per-class counts).

    `assets` is COUNTED and REPORTED on purpose. An asset check that resolved an
    empty reference list would pass every page while asserting nothing — the
    absence-passes-as-green bug this codebase has already been bitten by. The
    count is the evidence that the crawl did work; a green with `assets 0` is not
    a green, and the caller can see that without reading this file.

    `noindex` and `tagged` are counted for the same reason: they are the EVIDENCE
    that E2.1's two site-wide claims were actually measured on this run, printed
    where a reader of the log can check them against `len(pages)` without reading
    this file.
    """
    violations: list[str] = []
    seen = {"rail_bearing": 0, "vendored": 0, "unreachable": 0, "assets": 0,
            "noindex": 0, "tagged": 0}

    for rel in pages:
        html = source.read(rel)
        if html is None:
            seen["unreachable"] += 1
            violations.append(
                f"{rel}: NOT SERVED / NOT PRESENT on {source.describe()} — the page "
                f"is in pages.yaml but a reader gets nothing"
            )
            continue
        if site_checks.is_rail_bearing(rel):
            seen["rail_bearing"] += 1
        else:
            seen["vendored"] += 1
        seen["assets"] += len(site_checks.referenced_assets(html))
        seen["noindex"] += int(site_checks.is_noindex(html))
        seen["tagged"] += int(bool(site_analytics.analytics_endpoints(html)))
        violations.extend(
            site_checks.check_page(
                html, rel, source, analytics_endpoint=analytics_endpoint
            )
        )
    return violations, seen


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__.splitlines()[0],
        epilog="Sim-iframe console errors are owned by the seven Playwright smokes "
               "in stage_local_preview.py (they need a real browser); this gate is "
               "liveness + structure.",
    )
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--root", type=Path, help="verify a LOCAL tree")
    mode.add_argument("--base-url", nargs="?", const=PAGES_ORIGIN, metavar="URL",
                      help=f"verify the LIVE deployed site (default {PAGES_ORIGIN})")
    ap.add_argument("--pages", type=Path, default=None,
                    help="pages.yaml (the page SET); default: co-located, else the "
                         "plan-state home — see _default_pages()")
    ap.add_argument("--tries", type=int, default=5,
                    help="live mode: fetch attempts before a 404 is believed "
                         "(CDN propagation retry)")
    args = ap.parse_args(argv)

    if args.pages is None:
        args.pages = _default_pages()
    pages = pages_from_yaml(args.pages)
    if args.root:
        if not args.root.is_dir():
            print(f"ABORT: --root {args.root} is not a directory", file=sys.stderr)
            return 2
        source = LocalTree(args.root)
    else:
        source = LiveSite(args.base_url, tries=args.tries)

    # The analytics MODE, from the ONE seam build.py injects from. A malformed
    # site code aborts here rather than quietly downgrading to "assert no tag" —
    # which would pass a tagged tree while claiming to have checked coverage.
    try:
        code = site_analytics.site_code()
    except site_analytics.AnalyticsConfigError as exc:
        print(f"ABORT: {exc}", file=sys.stderr)
        return 2
    endpoint = site_analytics.endpoint(code) if code else None

    print("verify_live — liveness + structure")
    print(f"  source : {source.describe()}")
    print(f"  pages  : {len(pages)} (from {args.pages.name})")
    print(f"  rail   : {len(site_checks.deep_nav.SITE_NAV)} SITE_NAV slugs (derived)")
    print(f"  robots : noindex asserted on every page (UNCONDITIONAL — the "
          f"DECIDED site-wide state)")
    if endpoint:
        print(f"  analytics: ON  ({site_analytics.SITE_CODE_ENV} set) -> every "
              f"page must carry {endpoint}")
    else:
        print(f"  analytics: OFF ({site_analytics.SITE_CODE_ENV} unset) -> NO page "
              f"may carry a tag")
    print("=" * 74)

    violations, seen = verify(source, pages, analytics_endpoint=endpoint)

    for rel in pages:
        bad = [v for v in violations if v.startswith(f"{rel}:")]
        cls = "vendored" if site_checks.is_vendored(rel) else "rail"
        if bad:
            print(f"  [FAIL] {rel}  ({cls})")
            for v in bad:
                print(f"         {v}")
        else:
            print(f"  [ok]   {rel}  ({cls})")

    print("=" * 74)
    print(f"  rail-bearing {seen['rail_bearing']} / vendored {seen['vendored']} / "
          f"unreachable {seen['unreachable']}")
    print(f"  referenced assets resolved: {seen['assets']}")
    print(f"  noindex: {seen['noindex']}/{len(pages)} · "
          f"analytics-tagged: {seen['tagged']}/{len(pages)} "
          f"(expected {len(pages) if endpoint else 0})")

    if violations:
        print(f"\nFAIL: {len(violations)} violation(s).")
        return 1
    if seen["assets"] == 0:
        print("\nFAIL: zero referenced assets were checked. Every page resolved, but "
              "the asset crawl asserted NOTHING — that is not a pass.")
        return 1
    # The same anti-vacuous floor the asset count gets, for E2.1's site-wide claim.
    # `check_noindex` runs per page, so this can only trip if the page set itself
    # went empty — but `pages_from_yaml` already refuses that, and a claim this
    # cheap to state is worth stating: a PASS line that says "every page is
    # noindex" over zero measured pages is the absence-passes-as-green bug.
    if seen["noindex"] != len(pages) - seen["unreachable"]:
        print(f"\nFAIL: counted {seen['noindex']} noindex page(s) but reached "
              f"{len(pages) - seen['unreachable']} — the per-page assertion and "
              f"the census disagree, so one of them is lying.", file=sys.stderr)
        return 1
    print(f"\nPASS: {len(pages)} pages, {seen['assets']} referenced assets resolve, "
          f"every rail is whole, {seen['noindex']} noindex, "
          f"{seen['tagged']} analytics-tagged "
          f"({'ON — ' + endpoint if endpoint else 'OFF — no tag, as required'}).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
