#!/usr/bin/env python3
r"""build.py — the site build. HERMETIC: it runs in CI, with NO access to physics.

    python build.py --check                 # stages 0-6: assemble _site/ + THE GATE
    python build.py --smoke --base-url URL  # stage 7: post-deploy alarm
    python build.py --determinism           # stage 8: build twice, byte-identical

WHAT THIS PROGRAM IS — AND WHAT IT DELIBERATELY IS NOT
======================================================
It is **not** a renderer, and the site plan's assumption that it would be was
FALSE. Measured at D1.1 (`probe_render_closure.py`): the render core is 26 modules
/ 12,148 lines, three of its renderers read the **live private physics repo at
render time** at **config-driven** paths (`render_story` pulls a brief markdown +
source excerpts named in a YAML; `render_gallery` pulls artifact sources named in a
YAML; `render_sims` reads live scene JSON), it opens `physics/data/**`, and it needs
node + Playwright. Rendering here would mean vendoring an **open-ended slice of a
PRIVATE repo into this PUBLIC one** — a slice a single YAML edit silently widens.
That is not a cost trade; it is a PII hazard, unbounded by construction.

So the pipeline splits where the code already splits:

    RENDER   [private, Brendan's box]  build.py --all + stage_local_preview.py
             build_and_publish.py syncs the result here, hash-defended
    PUBLISH  [public, THIS repo, CI]   assemble _site/  ->  THE GATE  ->  deploy

Everything under `src/` and `tools/` is a **GENERATED MIRROR**: authored in
`physics`, copied here by `build_and_publish.py`, and defended file-by-file by
`MIRROR.json`. **Do not hand-edit it — stage 4 will fail the build.** Fix the
source in physics and re-publish.

THE STAGES
==========
  0  VALIDATE  src/data/showcase_data.json against the VENDORED schema
               (src/vendor/showcase_data.py). A malformed payload fails the build
               BEFORE anything is assembled. `check_stats.py` proves DOM == JSON;
               only this stage proves JSON == the schema.
  1  ASSEMBLE  the mirrored pages -> _site/
  2  COPY      the vendored plain-vs-engine.html -> _site/, VERBATIM. The build
               does NOT generate it (1.12 MB of inline base64; image encoders are
               not byte-stable across versions, so byte-for-byte regeneration is a
               determinism contract this build cannot honestly promise).
  3  COPY      the canonical asset root + the deep wing's fan-out
  4  VENDOR    the sim sources -> _site/sim/, and **ASSERT every artifact carrying
               a MIRROR.json row still hashes to it** — ITERATING the manifest,
               never enumerating members inline. A mismatch is a hand-edit and it
               fails the build. Nothing has deployed: the gate is stage 6.
  5  NOJEKYLL  write .nojekyll at the artifact root (else underscore-prefixed paths
               are silently dropped).
  6  THE GATE  **PRE-DEPLOY, BLOCKING, BASELINE-FREE.** verify_live.py --root against
               the assembled _site/ (HTTP-200/present for every page in pages.yaml
               and every referenced asset; on the RAIL-BEARING pages: rail href-set
               equality vs SITE_NAV, exactly one aria-current, no malformed or
               nested marker comment) PLUS check_stats.py (every data-stat node
               equals format_stat(key, value) over the committed JSON).
               **The deploy job runs only if this is green.**
  7  SMOKE     POST-deploy: verify_live.py --base-url. An ALARM, not a gate — with
               `actions/deploy-pages`, once the deploy job runs the artifact IS
               live, and a later step can only turn the workflow red, never
               un-deploy. Red here -> revert the source commit and re-run the
               workflow, which re-deploys the previous good artifact.

WHY 6 AND 7 ARE NOT ONE STAGE
=============================
Collapsing them loses the gate entirely: a "deploy-failing" check that runs AFTER
the deploy gates nothing it catches, and leaves a window in which the live
job-application site is broken with no step owning recovery.

THERE IS NO BASELINE COMPARE HERE, ON PURPOSE
=============================================
Freezing a DOM snapshot into stage 6 would require every future deploy, forever, to
stay DOM-equivalent to it — the first sentence Brendan edits would hard-stop the
deploy, on a portfolio site whose whole purpose is to keep growing. Stats are
covered by check_stats.py against the committed JSON; nothing bounds a baseline
compare for content. The baseline compare is a MIGRATION gate and it lives in
physics.
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent
SRC = REPO / "src"
TOOLS = REPO / "tools"
SITE = REPO / "_site"

sys.path.insert(0, str(TOOLS))
sys.path.insert(0, str(SRC / "vendor"))

import mirror_manifest  # noqa: E402  (mirrored from physics; hash-defended)


#: Stage 6's anti-vacuous-green floor. The published site carried 27 `data-stat`
#: bindings at D1.1 (30 on disk, 3 of them in a stale stray page that pages.yaml
#: does not list and the mirror therefore does not carry). Set BELOW the real count
#: so ordinary content edits do not red the deploy, but far above zero — a
#: check_stats run that scanned nothing would otherwise report OK while asserting
#: NOTHING, which is the absence-passes-as-green bug this codebase has been bitten
#: by before.
MIN_STAT_BINDINGS = 20


class BuildError(RuntimeError):
    """A stage failed. Named input + remediation, always."""


def _hdr(n: int, title: str) -> None:
    print(f"\n=== {n}. {title} ===")


# ---------------------------------------------------------------------------
# Stage 0 — VALIDATE the data input at the boundary
# ---------------------------------------------------------------------------


def stage_validate() -> dict:
    _hdr(0, "VALIDATE — the committed JSON against the VENDORED schema")
    data_path = SRC / "data" / "showcase_data.json"
    schema_path = SRC / "vendor" / "showcase_data.py"
    if not data_path.is_file():
        raise BuildError(
            f"the build's ONLY data input is missing: {data_path}\n"
            f"Remediation (on Brendan's box): python "
            f"tools/showcase/build_and_publish.py --sync-only"
        )
    if not schema_path.is_file():
        raise BuildError(
            f"the vendored schema is missing: {schema_path}\n"
            f"Stage 0 cannot execute without it — and a build whose FIRST stage "
            f"silently skips is not a validated build."
        )
    try:
        from showcase_data import ShowcaseData  # noqa: PLC0415  (the vendored model)
    except ImportError as exc:
        raise BuildError(
            f"cannot import the vendored schema ({exc}). CI needs pydantic: "
            f"`pip install pydantic`."
        ) from exc

    raw = json.loads(data_path.read_text(encoding="utf-8"))
    try:
        ShowcaseData.model_validate(raw)
    except Exception as exc:  # pydantic.ValidationError
        raise BuildError(
            f"{data_path.name} FAILED schema validation — the build stops before "
            f"anything is assembled:\n{exc}"
        ) from exc

    n_stats = sum(1 for _ in _walk_triples(raw))
    print(f"  {data_path.name}: VALID against ShowcaseData (extra='forbid')")
    print(f"  schema_version {raw.get('schema_version')!r} · "
          f"generated_at {raw.get('generated_at')!r} · {n_stats} stat triples")
    return raw


def _walk_triples(node):
    """Every {value, source, verified}-shaped dict. Evidence the payload is not
    an empty husk that validates vacuously."""
    if isinstance(node, dict):
        if "value" in node and "source" in node:
            yield node
        for v in node.values():
            yield from _walk_triples(v)
    elif isinstance(node, list):
        for v in node:
            yield from _walk_triples(v)


# ---------------------------------------------------------------------------
# Stages 1-3 — assemble
# ---------------------------------------------------------------------------


def _copy_tree(src: Path, dst: Path) -> int:
    if not src.is_dir():
        return 0
    n = 0
    for p in sorted(src.rglob("*")):
        if not p.is_file():
            continue
        target = dst / p.relative_to(src)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(p, target)
        n += 1
    return n


def pages_from_yaml() -> list[str]:
    """THE page set — pages.yaml, the single referent. Never a literal."""
    path = TOOLS / "pages.yaml"
    if not path.is_file():
        raise BuildError(f"the page referent is missing: {path}")
    rows = [
        ln.strip().split(":", 1)[1].strip()
        for ln in path.read_text(encoding="utf-8").splitlines()
        if ln.strip().startswith("- path:")
    ]
    if not rows:
        raise BuildError(f"{path} lists no pages. A build of the empty set is not a build.")
    return rows


def stage_assemble() -> list[str]:
    _hdr(1, "ASSEMBLE — the mirrored pages -> _site/")
    if SITE.exists():
        shutil.rmtree(SITE)
    SITE.mkdir(parents=True)

    pages = pages_from_yaml()
    missing: list[str] = []
    n = 0
    for rel in pages:
        if rel.startswith("sim/"):
            continue          # stage 4 vendors the whole sim tree
        if rel == "plain-vs-engine.html":
            continue          # stage 2 copies it verbatim
        src = SRC / rel
        if not src.is_file():
            missing.append(rel)
            continue
        dst = SITE / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
        n += 1
    if missing:
        raise BuildError(
            "pages.yaml names page(s) the mirror does not carry:\n  "
            + "\n  ".join(missing)
            + "\nThe referent and the mirror disagree — that is a partial site, "
              "and it must not deploy."
        )
    print(f"  {n} page(s) assembled (pages.yaml lists {len(pages)}; "
          f"sim/ + plain-vs-engine are stages 4 and 2)")

    _hdr(2, "COPY — the vendored plain-vs-engine.html, VERBATIM")
    slider_src = SRC / "plain-vs-engine.html"
    if not slider_src.is_file():
        raise BuildError(
            f"the vendored comparison page is missing: {slider_src}\n"
            f"It is generated OFFLINE by build_plain_vs_system_slider.py and "
            f"committed; the build never regenerates it."
        )
    shutil.copy2(slider_src, SITE / "plain-vs-engine.html")
    print(f"  plain-vs-engine.html: {slider_src.stat().st_size:,} B copied verbatim")

    _hdr(3, "COPY — the canonical asset root + the deep fan-out")
    a = _copy_tree(SRC / "assets", SITE / "assets")
    d = _copy_tree(SRC / "deep" / "assets", SITE / "deep" / "assets")
    if a == 0:
        raise BuildError("zero root assets copied — the site would load naked HTML")
    print(f"  assets/ {a} file(s) · deep/assets/ {d} file(s)")
    return pages


# ---------------------------------------------------------------------------
# Stage 4 — vendor the sims + THE HASH ASSERT
# ---------------------------------------------------------------------------


def stage_vendor_and_assert() -> None:
    _hdr(4, "VENDOR the sims + ASSERT every MIRROR.json row")

    # The hash assert runs on the SOURCE mirror (src/, tools/), BEFORE any
    # artifact-copy injection (E2.1 injects noindex + analytics into the _site/
    # copy). Injected copies in _site/ are EXPECTED to differ; the mirror is not.
    violations = mirror_manifest.verify_mirror_on_disk(REPO)
    m = mirror_manifest.load_manifest(REPO)
    if violations:
        print(f"\n  MIRROR DRIFT — {len(violations)} file(s):", file=sys.stderr)
        for v in violations:
            print(f"    {v}", file=sys.stderr)
        raise BuildError(
            "the mirror does not match MIRROR.json. Everything under src/ and "
            "tools/ is GENERATED — its authoring home is the physics repo. "
            "Re-run build_and_publish.py there; do not hand-edit it here."
        )
    print(f"  MIRROR.json: all {len(m['files'])} row(s) hash-match "
          f"(source_commit {str(m.get('source_commit'))[:12]})")

    n = _copy_tree(SRC / "sim", SITE / "sim")
    if n == 0:
        raise BuildError(
            "zero sim files vendored — every sim iframe would boot a blank canvas. "
            "The sim SOURCES must be mirrored into src/sim/ (CI cannot reach "
            "physics/sim/)."
        )
    print(f"  sim/: {n} file(s) -> _site/sim/")


def stage_nojekyll() -> None:
    _hdr(5, "NOJEKYLL")
    (SITE / ".nojekyll").write_text("", encoding="utf-8")
    print("  wrote _site/.nojekyll (underscore-prefixed paths survive)")


# ---------------------------------------------------------------------------
# Stage 6 — THE GATE
# ---------------------------------------------------------------------------


def _py(args: list[str], what: str) -> int:
    print(f"\n  $ python {' '.join(args)}")
    res = subprocess.run([sys.executable, *args], cwd=str(REPO), check=False)
    if res.returncode != 0:
        print(f"  [FAIL] {what} (exit {res.returncode})", file=sys.stderr)
    return res.returncode


def stage_gate() -> None:
    _hdr(6, "THE GATE — pre-deploy, BLOCKING, baseline-free")
    rc = 0
    rc |= _py(["tools/verify_live.py", "--root", "_site",
               "--pages", "tools/pages.yaml"], "verify_live --root")
    # --require-bindings is the anti-vacuous-green floor: a check_stats run that
    # scanned ZERO data-stat nodes would otherwise report OK while asserting
    # nothing. The site carries 20+ bindings; a build that finds fewer has lost
    # pages, and that must fail the GATE, not sail through it.
    rc |= _py(["tools/check_stats.py", "--root", "_site",
               "--data", "src/data/showcase_data.json",
               "--require-bindings", str(MIN_STAT_BINDINGS)], "check_stats")
    if rc != 0:
        raise BuildError(
            "THE GATE IS RED — the deploy job MUST NOT run. See the failures above."
        )
    print("\n  GATE GREEN — the artifact is deployable.")


def _assemble_all() -> None:
    """Stages 0-5 — everything that WRITES _site/, none of the gate."""
    stage_validate()
    stage_assemble()
    stage_vendor_and_assert()
    stage_nojekyll()


def stage_determinism() -> None:
    """D2 era-2 check: build twice; the two _site/ trees must be BYTE-identical,
    honoring the ONE named exclusion (`mirror_manifest.DETERMINISM_EXCLUDED_KEYS`
    — `generated_at`, compared via `canonical_json_bytes`, the same rule D1
    named once and every determinism consumer honors).

    TODAY THIS IS TWO BUILDS, BECAUSE THERE IS ONE MODE. When E2 lands the
    analytics flag this check becomes THREE builds — twice in the default mode
    (this comparison, unchanged), then once with the flag flipped, asserting the
    only deltas are the analytics <script> nodes (one per HTML file that
    receives the tag: every pages.yaml page PLUS the injected copies under
    _site/sim/** and the vendored plain-vs-engine.html — and nothing else).
    Extending and re-running it is a named item in E2.2's Done-when — owned
    there, not merely anticipated here. (A FOURTH build is warranted only if
    the analytics snippet ever embeds a per-build value such as a nonce; today
    it must not.) Determinism is a property of the BUILD, not of the flag —
    proving it twice per flag value buys nothing.
    """
    _hdr(8, "DETERMINISM — the same source must build the same bytes, twice")
    _assemble_all()
    with tempfile.TemporaryDirectory(prefix="showcase_det_") as td:
        first = Path(td) / "first"
        shutil.copytree(SITE, first)
        _assemble_all()

        a = {p.relative_to(first).as_posix(): p
             for p in sorted(first.rglob("*")) if p.is_file()}
        b = {p.relative_to(SITE).as_posix(): p
             for p in sorted(SITE.rglob("*")) if p.is_file()}
        diffs: list[str] = []
        excluded = 0
        for rel in sorted(set(a) | set(b)):
            pa, pb = a.get(rel), b.get(rel)
            if pa is None or pb is None:
                diffs.append(f"{rel}: present in only one of the two builds")
                continue
            if pa.read_bytes() == pb.read_bytes():
                continue
            if rel.endswith(".json") and (
                mirror_manifest.canonical_json_bytes(pa)
                == mirror_manifest.canonical_json_bytes(pb)
            ):
                excluded += 1  # differs ONLY in the named excluded key(s)
                continue
            diffs.append(f"{rel}: bytes differ between two builds of the "
                         f"SAME source")
        if diffs:
            for d in diffs:
                print(f"  {d}", file=sys.stderr)
            raise BuildError(
                f"THE BUILD IS NOT DETERMINISTIC — {len(diffs)} file(s) "
                f"differ across two runs. The zero-diff guardrail is only "
                f"viable on a byte-deterministic build: no timestamps (dates "
                f"come from the committed JSON), sorted iteration, "
                f"locale-independent formatting. Find the nondeterminism; do "
                f"not widen the exclusion list."
            )
        print(f"\n  DETERMINISTIC — {len(a)} files byte-identical across two "
              f"builds"
              + (f" ({excluded} JSON file(s) forgiven ONLY on "
                 f"{mirror_manifest.DETERMINISM_EXCLUDED_KEYS})" if excluded
                 else ""))


def stage_smoke(base_url: str) -> int:
    _hdr(7, "POST-DEPLOY SMOKE — an alarm, not a gate")
    rc = _py(["tools/verify_live.py", "--base-url", base_url,
              "--pages", "tools/pages.yaml"], "verify_live --base-url")
    if rc != 0:
        print(
            "\n  LIVE SITE IS RED.\n"
            "  Recovery: revert the source commit and re-run the workflow — that "
            "re-deploys the previous good artifact.\n"
            "  Before D1.2, the fallback is the D1.1 rollback: flip the Pages "
            "source back to the branch.",
            file=sys.stderr,
        )
    else:
        print("\n  LIVE SITE GREEN.")
    return rc


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="build.py", description=__doc__.splitlines()[0])
    ap.add_argument("--check", action="store_true",
                    help="stages 0-6: assemble _site/ and run THE GATE (default)")
    ap.add_argument("--smoke", action="store_true",
                    help="stage 7 only: crawl the LIVE site (post-deploy alarm)")
    ap.add_argument("--determinism", action="store_true",
                    help="era-2 check: assemble _site/ TWICE and assert the "
                         "trees are byte-identical (generated_at excluded)")
    ap.add_argument("--base-url", default="https://wischman123.github.io",
                    help="stage 7's target")
    args = ap.parse_args(argv)

    try:
        if args.smoke:
            return stage_smoke(args.base_url)
        if args.determinism:
            stage_determinism()
            total = sum(1 for p in SITE.rglob("*") if p.is_file())
            print(f"\nDETERMINISM OK — _site/: {total} files, reproducible.")
            return 0
        stage_validate()
        stage_assemble()
        stage_vendor_and_assert()
        stage_nojekyll()
        stage_gate()
    except mirror_manifest.ManifestError as exc:
        print(f"\nABORT: {exc}", file=sys.stderr)
        return 1
    except BuildError as exc:
        print(f"\nABORT: {exc}", file=sys.stderr)
        return 1

    total = sum(1 for p in SITE.rglob("*") if p.is_file())
    size = sum(p.stat().st_size for p in SITE.rglob("*") if p.is_file())
    print(f"\nBUILD OK — _site/: {total} files, {size:,} B. Ready to upload.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
