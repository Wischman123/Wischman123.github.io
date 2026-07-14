#!/usr/bin/env python3
r"""stat_format.py — the ONE function that turns a harvested stat into page text.

    format_stat("loc.first_party_lines", 1617947)  ->  "1,617,947"

WHY THIS MODULE EXISTS (showcase_site_architecture_v1, A0.2 step 5)
===================================================================
`check_stats.py` asserts, for every `data-stat` node in a rendered page, that the
node's TEXT equals the formatted value of the committed `showcase_data.json` at
that key. That check is only executable if the page and the checker agree on
FORMATTING — the JSON carries `1617947` and the page renders `1,617,947`, so a
bare "text equals JSON" assertion is false for every formatted stat.

So `format_stat` is ONE shared function with TWO consumers:

  * the RENDER side — :func:`install` registers it as a Jinja filter, and B1's
    `data-stat` bindings render every stat through it;
  * the CHECK side — `check_stats.py` imports it to compute the expected text.

One home, two importers. A second formatting authority is the two-authors bug
this plan exists to prevent, so the pre-existing inline `_commas` / `_pct` in
`render_story.py` now DELEGATE here rather than keeping a private copy.

It lives beside `check_stats.py` and relocates with it at D1 (topology table).

THE INT DEFAULT IS NON-REGRESSING — A DERIVED FACT, NOT A GUESS
===============================================================
`render_story.py` applies `_commas` SELECTIVELY today: `commit_count` (1,722)
gets it, `frq_total` (51) does not. That looks like two behaviours, but it is
one: **every stat that today bypasses the comma filter is < 1000**, where
`f"{v:,}"` is a no-op. So comma-grouping EVERY int reproduces today's rendered
text byte-for-byte, for all 69 int leaves in the frozen JSON. This matters more
than it looks: the Tier-1 comparator normalizes the `data-stat` ATTRIBUTE, not
the node's TEXT — so if `format_stat` rendered one stat differently from the way
the page renders it today, B1's binding commit would go RED against the baseline
on a change nobody made. `tests/test_stat_format.py` asserts this property over
the real JSON rather than trusting this paragraph.

THE FORMAT IS CHOSEN PER KEY, AND AN UNKNOWN TYPE FAILS LOUD
============================================================
  1. an explicit :data:`STAT_FORMATS` entry wins;
  2. else `int`  -> comma-grouped   (the default; see above);
  3. else `str`  -> passthrough     (harvest already formatted it: '4.6%');
  4. else        -> :class:`UnknownStatFormat`.

Rule 4 is the load-bearing one. A `float` has no defensible default — `0.7647…`
must render `76%`, and `str(0.7647058823529411)` on a portfolio page is the kind
of defect that ships. So a float (or bool, or anything else) MUST be declared in
`STAT_FORMATS`, and binding an undeclared one raises at RENDER time rather than
emitting nonsense that `check_stats.py` would then happily confirm.
"""
from __future__ import annotations

from typing import Any, Callable

__all__ = [
    "format_stat", "stat_value", "resolve", "install",
    "STAT_FORMATS", "FORMATTERS", "UnknownStatFormat", "UnknownStatKey",
]


class UnknownStatFormat(TypeError):
    """A stat's value type has no default format and no STAT_FORMATS entry."""


class UnknownStatKey(KeyError):
    """A dotted key that does not resolve to a {value, source} leaf in the JSON."""


# ---------------------------------------------------------------- primitives
def commas(v: Any) -> str:
    """1617947 -> '1,617,947'. The int default (and a no-op below 1000)."""
    return f"{int(v):,}"


def pct(v: Any) -> str:
    """0.7647… -> '76%'. Ratio in [0,1] -> whole-number percent.

    Semantics lifted verbatim from `render_story.py::_pct` — the site already
    renders `sim.coverage_overall` this way, and Tier-1 compares the TEXT.
    """
    return f"{round(float(v) * 100)}%"


def iso_date(v: Any) -> str:
    """'2026-03-19T14:59:41-05:00' -> '2026-03-19' (what the story renders)."""
    return str(v)[:10]


def text(v: Any) -> str:
    """Passthrough — harvest already formatted it ('4.6%', '91%', '-5.28')."""
    return str(v)


#: name -> formatter. Named so STAT_FORMATS reads as data, not as lambdas.
FORMATTERS: dict[str, Callable[[Any], str]] = {
    "commas": commas, "pct": pct, "iso_date": iso_date, "text": text,
}

#: dotted key -> formatter name. ONLY the keys whose format is NOT the type
#: default. Every entry here is a key whose live rendering was READ off the
#: existing renderer, never invented:
#:   sim.coverage_*      render_story.py:599-600  (_pct)
#:   repo.first_commit_date  render_story.py:583  (str(value)[:10])
#: A float with no entry here raises — see the module docstring, rule 4.
STAT_FORMATS: dict[str, str] = {
    "sim.coverage_overall": "pct",
    "sim.coverage_modelable": "pct",
    "repo.first_commit_date": "iso_date",
}


# ---------------------------------------------------------------- resolution
def resolve(data: dict, key: str) -> dict:
    """The `{value, source, verified}` LEAF at dotted `key` in showcase_data.json.

    Raises :class:`UnknownStatKey` naming the key — a `data-stat` binding that
    points at nothing must fail the check, never silently pass on an empty set.
    """
    node: Any = data
    walked: list[str] = []
    for part in key.split("."):
        if not isinstance(node, dict) or part not in node:
            raise UnknownStatKey(
                f"data-stat={key!r}: no such key in showcase_data.json "
                f"(resolved {'.'.join(walked) or '<root>'}, then {part!r} is absent)"
            )
        node = node[part]
        walked.append(part)
    if not (isinstance(node, dict) and "value" in node):
        raise UnknownStatKey(
            f"data-stat={key!r}: resolves to a {type(node).__name__}, not a "
            f"{{value, source, verified}} stat leaf — bind a leaf, not a branch"
        )
    return node


def stat_value(data: dict, key: str) -> Any:
    """The raw `value` at dotted `key` (pre-formatting)."""
    return resolve(data, key)["value"]


# ---------------------------------------------------------------- the function
def format_stat(key: str, value: Any) -> str:
    """The page text for stat `key` carrying `value`. THE shared contract.

    `key` selects the format; `value` is the raw JSON value. Both consumers —
    the Jinja filter and `check_stats.py` — call exactly this.
    """
    name = STAT_FORMATS.get(key)
    if name is not None:
        try:
            return FORMATTERS[name](value)
        except KeyError:  # a typo'd name in STAT_FORMATS, not a bad value
            raise UnknownStatFormat(
                f"STAT_FORMATS[{key!r}] = {name!r}, which is not a known "
                f"formatter ({', '.join(sorted(FORMATTERS))})"
            ) from None
    if isinstance(value, bool):  # bool is an int subclass — catch it FIRST
        raise UnknownStatFormat(
            f"data-stat={key!r} has a bool value ({value!r}) and no STAT_FORMATS "
            f"entry. A bool has no defensible page text — declare one."
        )
    if isinstance(value, int):
        return commas(value)
    if isinstance(value, str):
        return text(value)
    raise UnknownStatFormat(
        f"data-stat={key!r} has a {type(value).__name__} value ({value!r}) and no "
        f"STAT_FORMATS entry. There is no safe default for this type — a float "
        f"would render as '{value}' on the page. Add an entry to STAT_FORMATS "
        f"in {__name__} naming one of: {', '.join(sorted(FORMATTERS))}."
    )


def format_key(data: dict, key: str) -> str:
    """`format_stat` over the committed JSON — the expected page text for `key`."""
    return format_stat(key, stat_value(data, key))


def install(env) -> None:
    """Register `format_stat` as a Jinja filter + global on `env`.

    Duck-typed on the jinja2 Environment (only touches `env.filters` /
    `env.globals`), exactly like `deep_nav.install`, so importing this module
    costs nothing and has no jinja2 dependency.

    B1's bindings render as:  <span data-stat="loc.first_party_lines">{{
    "loc.first_party_lines"|stat }}</span>  — one filter, one home.
    """
    env.filters["stat"] = lambda key, data: format_key(data, key)
    env.globals["format_stat"] = format_stat
    env.globals["stat_value"] = stat_value
