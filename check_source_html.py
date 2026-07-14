#!/usr/bin/env python3
r"""check_source_html.py — no generated HTML enters this repo's SOURCE (D2 item 3).

    python check_source_html.py --staged            # the pre-commit half
    python check_source_html.py --range A..B        # the CI half (pushed range)

ONE implementation, two callers: `.githooks/pre-commit` runs `--staged` on the
files STAGED for the commit being made; the Pages workflow runs `--range` on the
files CHANGED IN THE PUSHED COMMIT RANGE. Neither ever scans the tracked tree —
that scoping is LOAD-BEARING, not an optimization: until D1.2's deferred removal
lands, this repo still tracks the old published pages (they are the D1.1
ROLLBACK TARGET), so a state scan would be red on every push for weeks, and a
check that is red for weeks is a check that gets disabled within a week.

THE TWO RULES (both over ADDED-or-MODIFIED files only — `--diff-filter=AM`,
`--no-renames` so a rename shows as its A half and cannot slip through)
==============================================================================
(a) REJECT any changed ``*.html`` that carries NO ``MIRROR.json`` row. In this
    repo, source HTML legitimately exists nowhere: templates are ``.j2`` in the
    physics repo, and built pages live in the gitignored ``_site/``. A staged
    DELETION is always allowed — D1.2 step 5 ``git rm``s the entire tracked
    generated tree (index.html, videos.html, architecture.html, deep/, the
    published plain-vs-engine.html), and a rule that rejected that commit would
    teach ``--no-verify``, the exact habit this hook exists to prevent.

(b) ALLOW a changed VENDORED file — one carrying a ``MIRROR.json`` row — only
    when its content hashes to that row, where BOTH the file content and the
    manifest are read from the SAME snapshot (the index for ``--staged``; the
    range's tip commit for ``--range``). That is what lets the sync tool's own
    commit pass (it stages the refreshed file AND the refreshed manifest
    together) while a hand-edit — which by definition does not update the
    manifest — is rejected. Membership is decided by ITERATING the manifest,
    never by a hardcoded ``sim/**`` list: the manifest covers every mirrored
    artifact (the vendored schema, the gate tools, mirror_manifest.py itself),
    so a hardcoded list would reject the sync tool's own refresh of any of
    them. Note rule (b) deliberately covers ALL manifest-rowed files, not just
    ``*.html`` — a hand-edited ``tools/check_stats.py`` is the same disease.

WHY NOT a pages.yaml-derived allowlist: membership by ORIGIN (a hash row in the
manifest) survives the next vendored artifact automatically; a page-set join
breaks the moment a vendored file is not a page (the schema, the gate tools).

Never bypass with ``--no-verify`` — CI re-runs the same rules on the pushed
range, so the bypass only moves the red from your terminal to the workflow.

Stdlib + git only (imports `tools/mirror_manifest.py` for the manifest
constants — the ONE home of that contract).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent
sys.path.insert(0, str(REPO / "tools"))

from mirror_manifest import MANIFEST_NAME, MANIFEST_SCHEMA  # noqa: E402

_ZEROS = "0" * 40


class CheckError(RuntimeError):
    """Environment / usage failure (NOT a rule violation). Exit 2."""


def _git(*args: str) -> bytes:
    res = subprocess.run(["git", "-C", str(REPO), *args],
                         capture_output=True, check=False)
    if res.returncode != 0:
        raise CheckError(
            f"git {' '.join(args)} failed:\n{res.stderr.decode(errors='replace')}"
        )
    return res.stdout


def changed_paths(diff_args: list[str]) -> list[str]:
    """ADDED-or-MODIFIED paths, NUL-delimited (paths with spaces survive)."""
    out = _git("diff", "--name-only", "-z", "--diff-filter=AM",
               "--no-renames", *diff_args)
    return [p for p in out.decode("utf-8").split("\0") if p]


def snapshot_bytes(ref: str, path: str) -> bytes:
    """``path``'s content in ``ref`` (``:<path>`` = the index / staged content)."""
    return _git("show", f"{ref}{path}" if ref.endswith(":") else f"{ref}:{path}")


def load_snapshot_manifest(ref_prefix: str) -> dict:
    """MIRROR.json from the SAME snapshot the files are read from. Fail-closed:
    a repo state in which the manifest is unreadable cannot prove rule (b), so
    it must not pass silently."""
    try:
        raw = snapshot_bytes(ref_prefix, MANIFEST_NAME)
    except CheckError as exc:
        raise CheckError(
            f"cannot read {MANIFEST_NAME} from the snapshot under check — "
            f"rule (b) has no referent, refusing to pass.\n{exc}"
        ) from exc
    m = json.loads(raw)
    if m.get("schema") != MANIFEST_SCHEMA or not m.get("files"):
        raise CheckError(
            f"{MANIFEST_NAME} in the snapshot is schema {m.get('schema')!r} with "
            f"{len(m.get('files') or {})} rows — expected schema "
            f"{MANIFEST_SCHEMA} and a non-empty row set. Regenerate it with "
            f"build_and_publish.py --sync-only (in the physics repo)."
        )
    return m["files"]


def check_snapshot(paths: list[str], rows: dict, ref_prefix: str) -> list[str]:
    """THE two rules, pure over (changed paths, manifest rows, a snapshot
    reader). Returns violations; empty == pass."""
    violations: list[str] = []
    for path in paths:
        row = rows.get(path)
        if row is not None:
            got = hashlib.sha256(snapshot_bytes(ref_prefix, path)).hexdigest()
            if got != row["sha256"]:
                violations.append(
                    f"{path}: carries a {MANIFEST_NAME} row but the changed "
                    f"content does not hash to it ({got[:12]}… != "
                    f"{row['sha256'][:12]}…). This file is a GENERATED MIRROR — "
                    f"its authoring home is the physics repo. Fix the source "
                    f"there and re-run build_and_publish.py; the sync commits "
                    f"the file and its refreshed manifest row TOGETHER."
                )
        elif path.lower().endswith(".html"):
            violations.append(
                f"{path}: a changed .html with NO {MANIFEST_NAME} row. Source "
                f"HTML does not live in this repo: pages are rendered from "
                f".j2 templates in the physics repo and built into the "
                f"gitignored _site/. If this is a NEW vendored artifact, it "
                f"must arrive via build_and_publish.py so it carries a hash row."
            )
    return violations


def resolve_range(spec: str) -> tuple[str, str]:
    """``BEFORE..AFTER`` with the push edge cases named: a new branch / forced
    push sends BEFORE=0000…, and the first commit has no parent — fall back to
    the tip's own change set rather than skipping (a skipped check is a green
    that proved nothing)."""
    if ".." not in spec:
        raise CheckError(f"--range wants BEFORE..AFTER, got {spec!r}")
    before, _, after = spec.partition("..")
    before, after = before.strip("."), after.strip(".")
    if not after:
        raise CheckError(f"--range {spec!r} has no AFTER commit")
    if before and before != _ZEROS:
        try:
            _git("rev-parse", "--verify", "--quiet", f"{before}^{{commit}}")
            return before, after
        except CheckError:
            pass  # unreachable BEFORE (shallow clone / rewritten): fall through
    try:
        _git("rev-parse", "--verify", "--quiet", f"{after}^{{commit}}")
        return f"{after}^", after
    except CheckError as exc:
        raise CheckError(f"cannot resolve a base for {spec!r}") from exc


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="check_source_html.py",
                                 description=__doc__.splitlines()[0])
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--staged", action="store_true",
                      help="check the files staged for the commit being made")
    mode.add_argument("--range", metavar="BEFORE..AFTER",
                      help="check the files changed in a pushed commit range")
    args = ap.parse_args(argv)

    try:
        if args.staged:
            what = "staged"
            paths = changed_paths(["--cached"])
            ref_prefix = ":"          # the index — the exact content being committed
        else:
            before, after = resolve_range(args.range)
            what = f"range {before}..{after}"
            paths = changed_paths([before, after])
            ref_prefix = after
        if not paths:
            print(f"check_source_html: no added/modified files in the {what} — OK")
            return 0
        rows = load_snapshot_manifest(ref_prefix)
        violations = check_snapshot(paths, rows, ref_prefix)
    except CheckError as exc:
        print(f"ABORT: {exc}", file=sys.stderr)
        return 2

    n_rowed = sum(1 for p in paths if p in rows)
    print(f"check_source_html: {len(paths)} added/modified file(s) in the "
          f"{what}; {n_rowed} carry MIRROR.json rows (hash-checked)")
    if violations:
        print(f"\nREJECTED — {len(violations)} violation(s):", file=sys.stderr)
        for v in violations:
            print(f"  {v}", file=sys.stderr)
        return 1
    print("OK — no generated HTML outside the manifest; every mirrored change "
          "hashes to its row.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
