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
                  no marker comment is malformed or nested.
  rail-bearing    the rail is present and its href set EQUALS the SITE_NAV-derived
                  set; exactly one aria-current="page" and it is THIS page; every
                  rail anchor points at an id that exists.

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


def verify(source, pages: list[str]) -> tuple[list[str], dict[str, int]]:
    """Crawl every page; return (violations, per-class counts).

    `assets` is COUNTED and REPORTED on purpose. An asset check that resolved an
    empty reference list would pass every page while asserting nothing — the
    absence-passes-as-green bug this codebase has already been bitten by. The
    count is the evidence that the crawl did work; a green with `assets 0` is not
    a green, and the caller can see that without reading this file.
    """
    violations: list[str] = []
    seen = {"rail_bearing": 0, "vendored": 0, "unreachable": 0, "assets": 0}

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
        violations.extend(site_checks.check_page(html, rel, source))
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

    print("verify_live — liveness + structure")
    print(f"  source : {source.describe()}")
    print(f"  pages  : {len(pages)} (from {args.pages.name})")
    print(f"  rail   : {len(site_checks.deep_nav.SITE_NAV)} SITE_NAV slugs (derived)")
    print("=" * 74)

    violations, seen = verify(source, pages)

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

    if violations:
        print(f"\nFAIL: {len(violations)} violation(s).")
        return 1
    if seen["assets"] == 0:
        print("\nFAIL: zero referenced assets were checked. Every page resolved, but "
              "the asset crawl asserted NOTHING — that is not a pass.")
        return 1
    print(f"\nPASS: {len(pages)} pages, {seen['assets']} referenced assets resolve, "
          f"every rail is whole.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
