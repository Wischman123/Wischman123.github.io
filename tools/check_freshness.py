#!/usr/bin/env python3
r"""check_freshness.py — the dead-man's switch on the committed stats JSON.

    python tools/check_freshness.py                      # build repo (CI) default
    python tools/check_freshness.py --data PATH --max-age-days 7

WHAT IT IS (showcase_site_architecture_v1, E1.1)
================================================
Under the site's publish topology, the stats JSON is refreshed by a LOCAL CRON
on Brendan's box. The dominant failure of a local cron is that it NEVER RUNS —
box asleep, cron disabled, machine rebuilt — which produces no failure event,
so no failure notification can ever fire on it. This program fires WHEN NOTHING
HAPPENS: it reads the committed ``src/data/showcase_data.json`` and FAILS if
``now - generated_at`` exceeds the window.

IT ALERTS; IT DOES NOT GATE (the two roles are deliberately apart)
==================================================================
Invoked ONLY by ``.github/workflows/daily_check.yml``, which pages a human on
failure. It is NOT a flag on ``verify_live.py`` and it is NOT in the deploy
gate — hang staleness on the deploy path and a laptop asleep for eight days
blocks every deploy, INCLUDING the one that would fix it ("the site cannot be
updated because the site has not been updated"). Keeping the assertion in a
program the deploy gate never runs makes that deadlock unreachable by
construction.

THE WINDOW DERIVES FROM THE CADENCE
===================================
The cron cadence is DAILY; the default window is 7 days ≈ 3× the cadence plus
slack for a sleeping laptop. If the cadence ever changes, re-derive the window
(≥ 3× cadence) or a single missed run trips the alarm by design.

Stdlib ONLY — this runs in CI with no pip install.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

#: In the BUILD repo this file lives at tools/check_freshness.py and the data
#: at src/data/showcase_data.json. (In the physics AUTHORING home this default
#: does not exist — pass --data there; the pin lives under out/.)
DEFAULT_DATA = Path(__file__).resolve().parent.parent / "src" / "data" / "showcase_data.json"  # move-readiness-ok: vendored VERBATIM into the public build repo (tools/../src), where physics lib does not exist

DEFAULT_MAX_AGE_DAYS = 7.0


def age_days(generated_at: str, now: datetime) -> float:
    """Age of the stamp in days. PURE — the decision point, unit-tested.

    Raises ``ValueError`` on a malformed stamp; a naive stamp is treated as
    UTC (the harvester always writes an offset, so this is belt-and-braces).
    """
    stamp = datetime.fromisoformat(generated_at.replace("Z", "+00:00"))
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=timezone.utc)
    return (now - stamp).total_seconds() / 86400.0


def is_stale(generated_at: str, now: datetime, max_age_days: float) -> bool:
    """True iff the stamp is OLDER than the window. Pure predicate."""
    return age_days(generated_at, now) > max_age_days


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="check_freshness.py",
                                 description=__doc__.splitlines()[0])
    ap.add_argument("--data", type=Path, default=DEFAULT_DATA,
                    help="the committed stats JSON (default: src/data/"
                         "showcase_data.json relative to the repo root)")
    ap.add_argument("--max-age-days", type=float, default=DEFAULT_MAX_AGE_DAYS,
                    help=f"the freshness window (default {DEFAULT_MAX_AGE_DAYS}"
                         f" — derived from the DAILY cron cadence, ≥3x + slack)")
    args = ap.parse_args(argv)

    # Boundary checks — fail CLOSED and name the input. A missing or
    # malformed stamp is indistinguishable from a dead updater.
    if not args.data.is_file():
        print(f"STALE (fail-closed): no stats JSON at {args.data}",
              file=sys.stderr)
        return 2
    try:
        payload = json.loads(args.data.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        print(f"STALE (fail-closed): {args.data} is not valid JSON: {exc}",
              file=sys.stderr)
        return 2
    generated_at = payload.get("generated_at")
    if not isinstance(generated_at, str) or not generated_at.strip():
        print(f"STALE (fail-closed): {args.data} carries no generated_at",
              file=sys.stderr)
        return 2

    now = datetime.now(timezone.utc)
    try:
        age = age_days(generated_at, now)
    except ValueError as exc:
        print(f"STALE (fail-closed): generated_at {generated_at!r} does not "
              f"parse: {exc}", file=sys.stderr)
        return 2

    verdict = "STALE" if age > args.max_age_days else "FRESH"
    print(f"[freshness] generated_at {generated_at} · age {age:.2f} d · "
          f"window {args.max_age_days:g} d -> {verdict}")
    if verdict == "STALE":
        print(
            f"THE SITE'S STATS HAVE STOPPED UPDATING: the committed JSON is "
            f"{age:.1f} days old (> {args.max_age_days:g}). The local cron on "
            f"Brendan's box has not published in over a week — box asleep, "
            f"cron disabled, or machine rebuilt. Remediation: on the box, run "
            f"`python tools/showcase/cron_harvest_publish.py` (physics repo) "
            f"and check `crontab -l`.",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
