#!/usr/bin/env python3
r"""check_stats.py — every `data-stat` node's text equals the committed JSON.

    python tools/showcase/check_stats.py --root out/staging
    python tools/showcase/check_stats.py --page fixtures/check_stats/pass.html

A JSON-FORWARD ASSERTION, NEVER A BASELINE COMPARE (A0.2 step 5)
================================================================
E1's whole purpose is *"the numbers move without a human."* Once E1 unfreezes
`showcase_data.json`, every such move is a DOM difference against the frozen
baseline — so a stat check written as a baseline compare would fail on exactly
the change E1 exists to make, on the day the deploy gate goes live. It would
then be disabled, and the site would ship unverified numbers forever.

So the direction is FORWARD, and only forward:

    for every `data-stat="<key>"` node in the rendered page:
        node.text  ==  format_stat(<key>, showcase_data.json[<key>])

That is the whole check. It says nothing about which stats a page *should*
carry (that is a template concern), only that every stat a page DOES carry is
the live number, correctly formatted. It stays true across E1's unfreeze because
it reads the same JSON the renderer read.

THE FORMATTING CONTRACT IS WHAT MAKES IT EXECUTABLE
===================================================
The JSON carries `1617947`; the page renders `1,617,947`. A bare "text equals
JSON" assertion is FALSE for every formatted stat, so this module imports
`stat_format.format_stat` — the same function the Jinja filter renders through.
One function, two consumers. If they were two functions, this gate would fail
correct pages the day they drifted.

WHY IT IS BUILT NOW, FOUR PHASES BEFORE ITS FIRST REAL INPUT
============================================================
B1 is the phase that first emits `data-stat` nodes: at A0.2 no page on disk or
live carries a single one. Run flat against the site today, this check would
iterate the EMPTY SET and pass on nothing — the classic absence-passes-as-green
green. It is built here anyway, because D1 wires it into the deploy-failing CI
gate and E1 depends on it; and it is PROVEN on a synthetic fixture instead, whose
negative case is the entire point. See `fixtures/check_stats/` and
`tests/test_check_stats.py`.

`--require-bindings N` exists for that reason: it asserts the scan actually SAW
at least N bindings, so "zero bindings found" can never be reported as a pass by
a caller that meant to check a real page.
"""
from __future__ import annotations

import argparse
import html as _html
import json
import re
import sys
from pathlib import Path

SHOWCASE_DIR = Path(__file__).resolve().parent
if str(SHOWCASE_DIR) not in sys.path:
    sys.path.insert(0, str(SHOWCASE_DIR))

from stat_format import (  # noqa: E402
    UnknownStatFormat, UnknownStatKey, format_stat, stat_value,
)

def _default_data() -> Path:
    """The harvested numbers the page is asserted against — CO-LOCATION FIRST.

    FROZEN for the migration (A0.2 step 5): ``--no-harvest`` is the only mode from
    D1.1 until E1 unfreezes it.

    ONE FILE, TWO HOMES (D1.1). ``site_mirror.py`` mirrors this module VERBATIM
    into the PUBLIC build repo, where ``build.py`` stage 6 runs it and the
    committed JSON sits at ``src/data/showcase_data.json`` — not at
    ``<module>/out/``. Resolving the co-located copy first lets ONE file serve both
    homes; ``build.py`` also passes ``--data`` explicitly, so this is the safety
    net, not the contract.
    """
    for cand in (
        SHOWCASE_DIR / "showcase_data.json",           # mirrored, beside the module
        SHOWCASE_DIR.parent / "src" / "data" / "showcase_data.json",  # build repo
        SHOWCASE_DIR / "out" / "showcase_data.json",   # physics (the authoring home)
    ):
        if cand.is_file():
            return cand
    return SHOWCASE_DIR / "out" / "showcase_data.json"


#: Back-compat alias — several tests and callers import the constant by name.
DEFAULT_DATA = _default_data()

#: `<span class="stat" data-stat="loc.raw_lines">2,166,537</span>` — tag-agnostic
#: (atlas.html.j2 puts stat attributes on `<text>` SVG nodes, not only spans), and
#: attribute-order-agnostic, because the emitter is a template, not a fixed string.
_BINDING_RE = re.compile(
    r"<(?P<tag>[a-zA-Z][\w:-]*)\b(?P<attrs>[^>]*?\bdata-stat\s*=\s*"
    r"(?P<q>[\"'])(?P<key>[^\"']+)(?P=q)[^>]*?)>(?P<text>.*?)</(?P=tag)\s*>",
    re.S,
)

#: Inner markup is allowed (the pinned-stat dagger: `<span class="stat__pin">†</span>`),
#: so a binding's TEXT is its tags stripped, entities RESOLVED, decoration dropped.
_TAG_RE = re.compile(r"<[^>]+>")
#: Decoration that rides INSIDE a stat node but is not part of the number — the
#: hand-pinned dagger, `<span class="stat__pin" aria-hidden="true">&dagger;</span>`.
#: Dropped AFTER `html.unescape`: the page writes the ENTITY `&dagger;`, so
#: stripping the literal char alone leaves the entity text behind and fails a page
#: that is perfectly correct. The pass fixture caught exactly that on this module's
#: first run — which is what a fixture with a real pinned stat in it is FOR.
_DECORATION = "†‡* "


def node_text(inner: str) -> str:
    """The comparable text of a binding node: tags stripped, entities RESOLVED,
    decoration dropped, whitespace collapsed."""
    txt = _TAG_RE.sub("", inner)
    txt = _html.unescape(txt)            # &dagger; -> the char;  &nbsp; -> \xa0
    txt = txt.replace("\xa0", " ")
    txt = "".join(c for c in txt if c not in _DECORATION)
    return " ".join(txt.split())


def check_html(html: str, data: dict, rel: str = "<page>") -> tuple[list[str], int]:
    """(violations, bindings_seen) for one page. The whole check."""
    violations: list[str] = []
    seen = 0
    for m in _BINDING_RE.finditer(html):
        seen += 1
        key = m.group("key").strip()
        got = node_text(m.group("text"))
        try:
            want = format_stat(key, stat_value(data, key))
        except UnknownStatKey as e:
            violations.append(f"{rel}: {e}")
            continue
        except UnknownStatFormat as e:
            violations.append(f"{rel}: {e}")
            continue
        if got != want:
            violations.append(
                f"{rel}: data-stat={key!r} renders {got!r} but the committed "
                f"showcase_data.json says {want!r} "
                f"(raw value {stat_value(data, key)!r}) — the page is stale, or "
                f"the binding points at the wrong key"
            )
    return violations, seen


def check_tree(root: Path, data: dict) -> tuple[list[str], int]:
    violations: list[str] = []
    total = 0
    for page in sorted(root.rglob("*.html")):
        v, seen = check_html(page.read_text(encoding="utf-8"), data,
                             page.relative_to(root).as_posix())
        violations.extend(v)
        total += seen
    return violations, total


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--root", type=Path, help="a tree of .html to scan")
    src.add_argument("--page", type=Path, help="a single .html to scan")
    ap.add_argument("--data", type=Path, default=DEFAULT_DATA,
                    help=f"showcase_data.json (default: {DEFAULT_DATA})")
    ap.add_argument("--require-bindings", type=int, default=0, metavar="N",
                    help="fail if fewer than N data-stat bindings were found "
                         "(guards against a green that scanned the empty set)")
    args = ap.parse_args(argv)

    if not args.data.is_file():
        print(f"ABORT: no showcase_data.json at {args.data}\n"
              f"Remediation: pass --data, or run the harvest "
              f"(tools/showcase/harvest.py) to produce it.", file=sys.stderr)
        return 2
    data = json.loads(args.data.read_text(encoding="utf-8"))

    if args.root:
        if not args.root.is_dir():
            print(f"ABORT: --root {args.root} is not a directory", file=sys.stderr)
            return 2
        violations, seen = check_tree(args.root, data)
        target = args.root
    else:
        if not args.page.is_file():
            print(f"ABORT: --page {args.page} is not a file", file=sys.stderr)
            return 2
        violations, seen = check_html(args.page.read_text(encoding="utf-8"), data,
                                      args.page.name)
        target = args.page

    print(f"check_stats: {seen} data-stat binding(s) in {target}")
    print(f"             against {args.data}")
    for v in violations:
        print(f"  VIOLATION {v}")

    if seen < args.require_bindings:
        print(f"\nFAIL: found {seen} bindings, --require-bindings said at least "
              f"{args.require_bindings}. A check that scanned nothing is not a pass.")
        return 1
    if violations:
        print(f"\nFAIL: {len(violations)} stat(s) do not match the committed JSON.")
        return 1
    print("\nOK: every data-stat node matches format_stat() over the committed JSON.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
