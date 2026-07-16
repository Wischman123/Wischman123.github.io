#!/usr/bin/env python3
r"""mirror_manifest.py — the MIRROR.json format, and the half of it that runs in CI.

PURE. Stdlib only. **No physics, no `_bootstrap`, no `claude_root()`.**

WHY THE SPLIT (showcase_site_architecture_v1, D1.1)
===================================================
The manifest has two consumers, and exactly one of them can see the physics repo:

    site_mirror.py     [PRIVATE, Brendan's box]  PLANS the mirror + WRITES the
                       manifest; needs pages.yaml, the staged tree, physics/sim,
                       the schema — i.e. the whole repo.

    build.py stage 4   [PUBLIC, in CI]           ASSERTS every artifact carrying a
                       MIRROR.json row still hashes to it. Sees a checkout of the
                       public build repo and nothing else.

If the CI half lived in `site_mirror.py` it could not be imported in CI at all
(the `tools.showcase._bootstrap` import dies first). If it were RE-TYPED inside the
build repo's `build.py`, the hash rule would exist twice — two implementations of
one contract, which is precisely the drift disease this manifest exists to prevent.

So the pure half lives HERE, `site_mirror.py` imports it, and the SAME FILE is
mirrored into the build repo (it carries its own hash row, like everything else).
One implementation, two homes, defended by the mechanism it implements.

THE RULE STAGE 4 ENFORCES
=========================
**ITERATE the manifest; never enumerate the members inline.** Iterating is what
makes the check survive the NEXT vendored artifact; an inline enumeration is how
the vendored schema ended up defended by nobody.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

#: Manifest filename at the build-repo root.
MANIFEST_NAME = "MIRROR.json"

#: Manifest schema version — bumped when the ROW shape changes, so a stale manifest
#: is a loud failure rather than a silently-passing hash check.
MANIFEST_SCHEMA = 1

#: The ONE key excluded from every determinism comparison, named ONCE (D1 chose
#: "Option (b) — exclude it"). `generated_at` is a REQUIRED field of `ShowcaseData`
#: carrying a validator that rejects an empty value, so it cannot be dropped; it is
#: also the field E1's freshness heartbeat (the dead-man's switch) reads. Every
#: comparison that must be stable across runs strips it — and only it.
DETERMINISM_EXCLUDED_KEYS = ("generated_at",)


class ManifestError(RuntimeError):
    """The manifest is absent, stale, or empty. NEVER downgraded to a pass."""


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with Path(path).open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def canonical_json_from_bytes(raw: bytes) -> bytes:
    """A JSON document's bytes with :data:`DETERMINISM_EXCLUDED_KEYS` stripped,
    serialized with sorted keys — THE comparison form, for callers holding BYTES.

    THE rule lives here, in ONE function; :func:`canonical_json_bytes` is the
    path-taking front door onto it. E2.2's three-build matrix compares in-memory
    artifact SNAPSHOTS (the tree is ~10 MB — holding it beats copying it three
    times), so it has bytes, not paths. Re-typing the strip rule over there is
    exactly the two-authors drift this module's docstring forbids: the exclusion is
    named ONCE (D1's choice) and every determinism consumer asks this module.
    """
    data = json.loads(raw.decode("utf-8"))
    if isinstance(data, dict):
        data = {k: v for k, v in data.items() if k not in DETERMINISM_EXCLUDED_KEYS}
    return json.dumps(data, sort_keys=True, separators=(",", ":")).encode("utf-8")


def canonical_json_bytes(path: Path) -> bytes:
    """``path``'s JSON with :data:`DETERMINISM_EXCLUDED_KEYS` stripped, serialized
    with sorted keys — THE comparison form for every determinism check.

    Named once, honored everywhere. A double-build check that compared raw bytes
    would go red on every run, and D2 says a check that goes red on every run gets
    disabled within a week.
    """
    return canonical_json_from_bytes(Path(path).read_bytes())


def load_manifest(repo: Path) -> dict:
    """Load + validate MIRROR.json. Fail-closed on absent / stale / empty."""
    path = Path(repo) / MANIFEST_NAME
    if not path.is_file():
        raise ManifestError(
            f"{path} is absent — a mirror with no manifest is an UNDEFENDED second "
            f"copy, which is this plan's own disease in a brand-new tree."
        )
    try:
        m = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ManifestError(f"{path} is not valid JSON: {exc}") from exc
    if m.get("schema") != MANIFEST_SCHEMA:
        raise ManifestError(
            f"{path}: manifest schema {m.get('schema')!r} != {MANIFEST_SCHEMA} — "
            f"regenerate it (build_and_publish.py --sync-only)."
        )
    if not m.get("files"):
        raise ManifestError(
            f"{path}: manifest lists ZERO files. An empty manifest passes every "
            f"hash check vacuously — that is not a pass."
        )
    return m


def verify_mirror_on_disk(repo: Path) -> list[str]:
    """**build.py stage 4.** Every artifact carrying a MIRROR.json row still hashes
    to it, IN THIS CHECKOUT. Catches a hand-edit that slipped past D2's hook.

    Pure: no physics, no network. This is the half that runs in CI.
    """
    repo = Path(repo)
    m = load_manifest(repo)
    violations: list[str] = []
    for rel, row in sorted(m["files"].items()):
        p = repo / rel
        if not p.is_file():
            violations.append(
                f"{rel}: has a MIRROR.json row but is ABSENT from the checkout"
            )
            continue
        got = sha256_file(p)
        if got != row["sha256"]:
            violations.append(
                f"{rel}: sha256 {got[:12]}... != MIRROR.json {row['sha256'][:12]}... "
                f"— this file was HAND-EDITED. It is a generated MIRROR; its "
                f"authoring home is the physics repo (rule '{row.get('rule')}'). "
                f"Re-run build_and_publish.py; do not edit it here."
            )
    return violations
