#!/usr/bin/env python3
r"""build.py — the site build. HERMETIC: it runs in CI, with NO access to physics.

    python build.py --check                 # stages 0-6: assemble _site/ + THE GATE
    python build.py --smoke --base-url URL  # stage 7: post-deploy alarm
    python build.py --determinism           # stage 8: the three-build matrix

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
  4b INJECT    the analytics tag into the ARTIFACT COPIES of every pages.yaml row
               (E2.1). **FLAG-GATED**: it runs only when the ONE seam
               (`site_analytics.SITE_CODE_ENV`) carries a site code. Unset — every
               local build — injects nothing, and stage 6 asserts that INVERSE, so
               "a local build omits the tag" is a standing check rather than a
               one-off grep. The authored sources are never touched: `sim/*` and
               `plain-vs-engine.html` are protected by the Charter's anti-target,
               and the mirror is hash-defended, so the tag can only live in the
               artifact copy. `noindex` is NOT injected — it is already in the
               authored sources of all 13 pages, which is what lets stage 6 ASSERT
               it instead of asserting the build's own handiwork.
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
import contextlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent
SRC = REPO / "src"
TOOLS = REPO / "tools"
SITE = REPO / "_site"

sys.path.insert(0, str(TOOLS))
sys.path.insert(0, str(SRC / "vendor"))

import mirror_manifest  # noqa: E402  (mirrored from physics; hash-defended)
import site_analytics  # noqa: E402  (ditto — the ONE analytics seam, shared with the gate)


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


def _hdr(n: int | str, title: str) -> None:
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


# ---------------------------------------------------------------------------
# Stage 4b — INJECT the analytics tag into the ARTIFACT COPIES (E2.1)
# ---------------------------------------------------------------------------


def stage_inject_analytics(pages: list[str]) -> int:
    """Put the analytics tag on every published page — in `_site/` only.

    WHY THIS IS A BUILD STAGE AND NOT A TEMPLATE LINE
    =================================================
    E2.1's plan text says "one vendor <script> in base.html.j2, it covers every
    page that extends it". That is FALSE HERE, and for the same reason the plan's
    "ONE repo" prose is stale (D1.1): **this repo does not render**. It carries
    the already-rendered HTML as a committed mirror, and CI is hermetic. A
    render-time flag would therefore bake the tag into the COMMITTED mirror —
    after which a local build could not omit it (Done-when 2 dies) and CI could
    not add it (CI never renders). So the tag goes into the artifact copy, here.

    Once it is a build stage, the two pages that do not extend `base.html.j2`
    (`sim/index.html`, `plain-vs-engine.html`) stop being a special case: they are
    two more rows of `pages.yaml`, and their authored sources — which the
    Charter's anti-target protects — are never touched.

    ITERATES `pages.yaml`, never a glob of `_site/**.html`: the page SET has one
    referent in this plan, and a glob would tag whatever happened to be on disk.
    """
    _hdr("4b", "INJECT — the analytics tag into the ARTIFACT COPIES (flag-gated)")
    try:
        code = site_analytics.site_code()
    except site_analytics.AnalyticsConfigError as exc:
        raise BuildError(str(exc)) from exc

    if code is None:
        print(f"  analytics OFF — {site_analytics.SITE_CODE_ENV} is unset, so NO "
              f"tag is injected.")
        print(f"  This is the normal LOCAL build: no self-inflicted traffic, and "
              f"THE GATE asserts the inverse (no page carries a tag).")
        return 0

    n = 0
    for rel in pages:
        p = SITE / rel
        if not p.is_file():
            raise BuildError(
                f"pages.yaml names {rel}, but it is not in _site/ at injection "
                f"time — stages 1-4 should have placed it. Refusing to publish a "
                f"page set the gate will then claim is fully covered."
            )
        html = p.read_text(encoding="utf-8")
        try:
            p.write_text(site_analytics.inject(html, code, rel), encoding="utf-8")
        except site_analytics.InjectionError as exc:
            raise BuildError(str(exc)) from exc
        n += 1

    print(f"  analytics ON  -> {site_analytics.endpoint(code)}")
    print(f"  {site_analytics.VENDOR} tag injected into {n} artifact copy/copies "
          f"(every pages.yaml row; sources untouched)")
    if n != len(pages):
        raise BuildError(
            f"injected {n} page(s) but pages.yaml lists {len(pages)} — partial "
            f"coverage must not deploy."
        )
    return n


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
    """Stages 0-5 — everything that WRITES _site/, none of the gate.

    THE ONE ASSEMBLY PATH. `main()` and `stage_determinism()` both call it, so a
    stage cannot exist in one path and be forgotten in the other — which is
    precisely what E2.1's injection would have been vulnerable to: a tag applied
    on the `--check` path but not the `--determinism` path would make the
    determinism run compare a tagged tree against an untagged one and report the
    BUILD as non-deterministic, sending the reader hunting for a nonexistent
    timestamp.
    """
    stage_validate()
    pages = stage_assemble()
    stage_vendor_and_assert()
    stage_inject_analytics(pages)
    stage_nojekyll()


#: The site code the matrix's flag-ON build uses. FIXED and obviously synthetic,
#: never the real one, and never whatever the ambient env happens to hold:
#:
#:   * the check must run the SAME way on Brendan's box (flag unset) and in CI
#:     (flag set), or the thing CI proves is not the thing he can reproduce. Before
#:     E2.2 the flag-ON path had NO local coverage at all — `--determinism` locally
#:     only ever built the OFF mode;
#:   * the property under test ("the flag's only effect is the tag") does not depend
#:     on WHICH code is configured. The real code's validity is already asserted at
#:     the boundary (`site_code`) and its endpoint by THE GATE, on every page.
DETERMINISM_PROBE_CODE = "determinism-probe"


@contextlib.contextmanager
def _analytics_flag(code: str | None):
    """Run a build with the analytics flag forced ON (`code`) or OFF (`None`).

    The matrix must be HERMETIC with respect to the ambient flag: in CI the env var
    is set at job level, so a check that merely inherited it would test one mode
    twice and silently stop proving anything about the other. Saved and restored in
    a `finally` — the whole point is that this stage leaves no trace in the
    environment of the build that follows it.
    """
    env = site_analytics.SITE_CODE_ENV
    prev = os.environ.get(env)
    if code is None:
        os.environ.pop(env, None)
    else:
        os.environ[env] = code
    try:
        yield
    finally:
        if prev is None:
            os.environ.pop(env, None)
        else:
            os.environ[env] = prev


def _snapshot() -> dict[str, bytes]:
    """The assembled tree as {published path: bytes}. ~10 MB — cheaper to hold than
    to copy, and it gives the pure predicate a filesystem-free input."""
    return {p.relative_to(SITE).as_posix(): p.read_bytes()
            for p in sorted(SITE.rglob("*")) if p.is_file()}


def _same(rel: str, a: bytes, b: bytes) -> bool:
    """Byte equality, honoring D1's ONE named exclusion.

    The SAME rule for both comparisons in the matrix (build-vs-build, and the
    flag's non-page files) — `generated_at`, stripped by the module that owns the
    rule. Never re-typed here: two implementations of one contract is the drift
    disease MIRROR.json exists to prevent.
    """
    if a == b:
        return True
    if rel.endswith(".json"):
        return (mirror_manifest.canonical_json_from_bytes(a)
                == mirror_manifest.canonical_json_from_bytes(b))
    return False


def _assert_left_tree_matches_ambient_flag(pages: list[str]) -> None:
    """The tree this stage LEAVES BEHIND is the one CI uploads. Prove its mode.

    pages.yml scopes SHOWCASE_ANALYTICS_SITE at JOB level *because* this stage
    re-assembles _site/ after the gate and `upload-pages-artifact` ships whatever
    is on disk when the job ends. That invariant lived only in a workflow COMMENT —
    survivable while both builds used the ambient flag, load-bearing now that E2.2
    gives the matrix a SECOND mode it could leave behind. A probe-tagged tree
    reaching the artifact would deploy `determinism-probe.goatcounter.com` to a
    live, public, job-application site.

    So the comment becomes an executable check: per page, the leftover artifact
    carries exactly the tag the AMBIENT config calls for — the tag when on, none
    when off. Verify presence, not just absence.
    """
    try:
        code = site_analytics.site_code()
    except site_analytics.AnalyticsConfigError as exc:
        raise BuildError(str(exc)) from exc
    want = [site_analytics.endpoint(code)] if code else []
    bad: list[str] = []
    for rel in pages:
        found = site_analytics.analytics_endpoints(
            (SITE / rel).read_text(encoding="utf-8"))
        if found != want:
            bad.append(f"    {rel}: carries {found or 'no tag'}, expected "
                       f"{want or 'no tag'}")
    if bad:
        raise BuildError(
            "THE LEFTOVER ARTIFACT IS IN THE WRONG MODE — this is the tree CI "
            "uploads and deploys:\n" + "\n".join(bad) + "\n"
            f"The determinism matrix forces the flag both ways and must restore "
            f"the ambient mode ({site_analytics.SITE_CODE_ENV}="
            f"{code or '<unset>'}) before returning."
        )
    print(f"  leftover artifact: all {len(pages)} page(s) in the AMBIENT mode "
          f"({'tagged -> ' + want[0] if want else 'no tag'}) — safe to upload")


def stage_determinism() -> None:
    """D2 item 1's era-2 check — THREE builds, because E2 landed the analytics flag.

    D2 item 1 defines the rule and E2.2 owns extending it. Exactly as written there:

      * **twice in the DEFAULT mode** — the two _site/ trees must be BYTE-identical,
        honoring the ONE named exclusion (`generated_at`, via mirror_manifest —
        the same rule D1 named once and every determinism consumer honors);
      * **once with the flag FLIPPED** — and the only deltas may be the analytics
        `<script>` nodes, exactly one per HTML file that RECEIVES the tag, and
        nothing else.

    Determinism is a property of the BUILD, not of the flag, so the ON mode is built
    ONCE: proving repeatability a second time under the other flag value buys
    nothing. D2's "add a FOURTH build only if the snippet embeds a per-build value"
    caveat stays un-triggered — `tag_html` is a function of (code, path) alone, and
    `test_the_tag_varies_by_PAGE_but_never_by_BUILD` pins it.

    WHICH FILES RECEIVE THE TAG — the shipped answer, not the plan's forecast. D2's
    prose expected `pages.yaml` pages PLUS injected copies under `_site/sim/**`,
    because it assumed a `base.html.j2` + sim-vendoring injection. E2.1 measured
    that impossible (the render is private, CI hermetic) and stage 4b injects
    `pages.yaml` rows ONLY — `sim/index.html` and `plain-vs-engine.html` among them,
    as rows rather than special cases. E2.2 then measured that every sim embed has a
    parent-side play control (`.js-embed-run`), so no `postMessage` shim lands in a
    sim artifact copy either. So the delta is exactly the 13 rows, and the rule is
    iterated from `pages.yaml` — never a pinned count, never a glob.

    The comparison is CONSTRUCTIVE: `site_analytics.flag_delta_violations`
    re-derives the expected ON bytes with the real injector and demands equality,
    rather than diffing and pattern-matching the delta (the substring bug E1.2 hit
    twice). Its negative cases live in tests/test_site_analytics.py — a check only
    ever seen green is a check nobody has proven can go red.

    THE FOURTH ASSEMBLY IS NOT A FOURTH MATRIX BUILD. It restores the ambient mode,
    because the tree this stage leaves behind is what CI uploads. See
    `_assert_left_tree_matches_ambient_flag`.
    """
    _hdr(8, "DETERMINISM — three builds: same source -> same bytes; the flag adds "
            "ONLY the tag")
    pages = pages_from_yaml()

    # -- builds 1 + 2: twice in the DEFAULT mode ----------------------------
    with _analytics_flag(None):
        _assemble_all()
        first = _snapshot()
        _assemble_all()
        second = _snapshot()

    diffs: list[str] = []
    excluded = 0
    for rel in sorted(set(first) | set(second)):
        a, b = first.get(rel), second.get(rel)
        if a is None or b is None:
            diffs.append(f"{rel}: present in only one of the two builds")
            continue
        if a == b:
            continue
        if _same(rel, a, b):
            excluded += 1  # differs ONLY in the named excluded key(s)
            continue
        diffs.append(f"{rel}: bytes differ between two builds of the SAME source")
    if diffs:
        for d in diffs:
            print(f"  {d}", file=sys.stderr)
        raise BuildError(
            f"THE BUILD IS NOT DETERMINISTIC — {len(diffs)} file(s) differ across "
            f"two runs. The zero-diff guardrail is only viable on a "
            f"byte-deterministic build: no timestamps (dates come from the "
            f"committed JSON), sorted iteration, locale-independent formatting. "
            f"Find the nondeterminism; do not widen the exclusion list."
        )
    print(f"\n  [builds 1+2] DETERMINISTIC — {len(first)} files byte-identical "
          f"across two builds in the DEFAULT mode"
          + (f" ({excluded} JSON file(s) forgiven ONLY on "
             f"{mirror_manifest.DETERMINISM_EXCLUDED_KEYS})" if excluded else ""))

    # -- build 3: once with the flag FLIPPED --------------------------------
    with _analytics_flag(DETERMINISM_PROBE_CODE):
        _assemble_all()
        flagged = _snapshot()

    violations = site_analytics.flag_delta_violations(
        first, flagged, pages, DETERMINISM_PROBE_CODE, _same)
    if violations:
        for v in violations:
            print(f"  {v}", file=sys.stderr)
        raise BuildError(
            f"THE ANALYTICS FLAG CHANGES MORE THAN THE TAG — {len(violations)} "
            f"finding(s). D2 item 1: with the flag flipped, the only deltas may be "
            f"the analytics <script> nodes, exactly one per pages.yaml page, and "
            f"nothing else. Either a page missed the tag, or turning analytics on "
            f"moved something it has no business moving."
        )
    print(f"  [build 3] THE FLAG ADDS ONLY THE TAG — {len(pages)} pages each gained "
          f"exactly one analytics <script>; the other {len(first) - len(pages)} "
          f"file(s) are untouched")

    # -- restore the ambient mode (NOT a matrix build) ----------------------
    _assemble_all()
    _assert_left_tree_matches_ambient_flag(pages)


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
                    help="era-2 check (D2 item 1): assemble _site/ TWICE in the "
                         "default mode and assert the trees are byte-identical "
                         "(generated_at excluded), then ONCE with the analytics "
                         "flag flipped and assert it added only the tag")
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
        _assemble_all()   # stages 0-5, the ONE assembly path (injection included)
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
