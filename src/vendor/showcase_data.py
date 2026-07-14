"""Schema + loader for ``tools/showcase/out/showcase_data.json``.

The showcase deep-dive harvester (``tools/showcase/harvest.py``, plan
``systems_showcase_deepdive_v2`` Phase P1) writes ONE machine-readable
data file whose EVERY leaf statistic is a :class:`Stat` triple
``{value, source, verified}`` pulled from live repo truth. This module
is that file's contract: the runner's render precondition (P2+) and the
P1 exit-gate test both validate ``showcase_data.json`` against
:class:`ShowcaseData` before any page renders a number, so a fresh
checkout fails loudly on a partial / stale harvest instead of shipping
opaque figures.

Pydantic v2 (per ``tools/check_schema_framework.py``)
=====================================================
Every top-level class here is a Pydantic v2 ``BaseModel`` (or an
exception subclass), satisfying the ``data/_schemas/*.py`` schema-
framework lint. Unlike the sibling schema modules this one imports ONLY
``pydantic`` + stdlib (NO ``lib`` dependency) — the harvester's
"what to import" contract keeps the showcase package free of the physics
``lib`` package so it can run in a bare context. The showcase data
carries zero student PII (it is repo-aggregate counts + provenance
strings), so the ``PiiTier`` annotations the catalog schema uses are not
needed here.

The provenance contract
=======================
* :class:`Stat` — the atomic ``{value, source, verified}`` triple.
  ``source`` names the live command / file the value came from;
  ``verified`` is ``True`` for a machine-computed value and ``False``
  for a hand-pinned one (whose ``source`` MUST say so).
* :class:`FvAggregate` — the hand-pinned FV census (functions /
  property-checked / laws). No machine-readable repo source was located
  (probe 2026-07-09), so each field's ``source`` carries the verbatim
  ``hand-pinned``/``no machine source`` marker and ``verified=False``.
* :class:`ConsistencyTodo` — THE registry of every hand-pinned value in
  the showcase. Any phase that pins a value a harvest cannot compute
  lands a row here naming its ``stat``, its re-derivation ``reason``, and
  the ``opened`` date, so "what is hand-pinned and when does it go stale"
  is answerable from this ONE list.

Public API
==========
* :func:`load_showcase_data` — read + validate the JSON file.
* :func:`validate_showcase_data` — validate a parsed dict.
* :class:`ShowcaseData` and its nested ``BaseModel``\\ s.
* :class:`ShowcaseSchemaError` — raised (wrapping ``pydantic``) on any
  validation failure.

Stdlib + ``pydantic`` only.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Callable, Union

from pydantic import BaseModel, ConfigDict, ValidationError, field_validator


# ---------------------------------------------------------------------------
# Exceptions
# ---------------------------------------------------------------------------


class ShowcaseSchemaError(ValueError):
    """Raised when a ``showcase_data.json`` payload violates the schema."""


# ---------------------------------------------------------------------------
# The atomic provenance triple
# ---------------------------------------------------------------------------

#: A stat's value is a count (int), a ratio (float), or a label / date /
#: source-string (str). ``bool`` is deliberately excluded — a stat is a
#: measured quantity, never a flag.
StatValue = Union[int, float, str]


class Stat(BaseModel):
    """One provenanced statistic: ``{value, source, verified}``.

    ``source`` names the live repo command or file the value was pulled
    from (e.g. ``git rev-list --count HEAD (physics repo)``). ``verified``
    is ``True`` for a machine-computed value; a hand-pinned value sets
    ``verified=False`` AND says ``hand-pinned`` in its ``source``.
    """

    model_config = ConfigDict(extra="forbid")

    value: StatValue
    source: str
    verified: bool

    @field_validator("source")
    @classmethod
    def _source_nonempty(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Stat.source must be a non-empty string")
        return value


# ---------------------------------------------------------------------------
# Hand-pinned FV census + the hand-pin registry
# ---------------------------------------------------------------------------


class FvAggregate(BaseModel):
    """Hand-pinned Function-Verification census (functions / property-
    checked / laws). No machine-readable repo source located (probe
    2026-07-09), so each :class:`Stat` here is ``verified=False`` with a
    ``hand-pinned``/``no machine source`` marker in its ``source``."""

    model_config = ConfigDict(extra="forbid")

    functions: Stat
    property_checked: Stat
    laws: Stat


class ConsistencyTodo(BaseModel):
    """One hand-pinned value's re-derivation TODO (the hand-pin registry)."""

    model_config = ConfigDict(extra="forbid")

    stat: str            # the stat this TODO governs, e.g. "fv_aggregate"
    reason: str          # why it is hand-pinned + its re-derivation trigger
    opened: str          # ISO date the pin was opened (YYYY-MM-DD)

    @field_validator("stat", "reason", "opened")
    @classmethod
    def _nonempty(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("ConsistencyTodo fields must be non-empty")
        return value


# ---------------------------------------------------------------------------
# Harvested stat groups (each an ``extra="forbid"`` BaseModel; variable
# keys — kinds, units, tiers, events, directions — use ``dict[str, Stat]``)
# ---------------------------------------------------------------------------


class RepoStats(BaseModel):
    model_config = ConfigDict(extra="forbid")
    commit_count: Stat
    first_commit_date: Stat


class CatalogStats(BaseModel):
    model_config = ConfigDict(extra="forbid")
    nodes_total: Stat
    edges_total: Stat
    nodes_by_kind: dict[str, Stat]
    manifest_generated: Stat


class ImportGraphStats(BaseModel):
    model_config = ConfigDict(extra="forbid")
    nodes_total: Stat
    edges_total: Stat


class InventoryStats(BaseModel):
    model_config = ConfigDict(extra="forbid")
    rows_total: Stat


class ProblemStats(BaseModel):
    model_config = ConfigDict(extra="forbid")
    frq_total: Stat
    mc_total: Stat
    frq_by_unit: dict[str, Stat]
    mc_by_unit: dict[str, Stat]


class SimStats(BaseModel):
    model_config = ConfigDict(extra="forbid")
    scenes_total: Stat
    published_total: Stat
    coverage_total_problems: Stat
    coverage_welded: Stat
    coverage_modelable_unwelded: Stat
    coverage_out_of_scope: Stat
    coverage_overall: Stat
    coverage_modelable: Stat


class LocStats(BaseModel):
    model_config = ConfigDict(extra="forbid")
    raw_files: Stat
    raw_lines: Stat
    first_party_files: Stat
    first_party_lines: Stat
    series_points: Stat
    latest_timestamp: Stat


class GateConsistency(BaseModel):
    """Result of the gate-registry consistency check (paths + drift)."""

    model_config = ConfigDict(extra="forbid")
    errors: list[str]      # gate paths in the registry that do NOT exist
    warnings: list[str]    # drift between the registry and the live globs


class GateStats(BaseModel):
    model_config = ConfigDict(extra="forbid")
    total: Stat
    by_tier: dict[str, Stat]
    consistency: GateConsistency


class InvariantStats(BaseModel):
    model_config = ConfigDict(extra="forbid")
    total: Stat
    by_tier: dict[str, Stat]


class HookStats(BaseModel):
    model_config = ConfigDict(extra="forbid")
    total: Stat
    by_event: dict[str, Stat]


class RecallUseStats(BaseModel):
    """Recall's measured-usefulness receipts (the meta §4 memory card).

    Every field is read from the miner's emitted
    ``tools/recall/analysis/out/use_rate_summary.json`` artifact (the
    ``retro_effectiveness`` pattern — the harvest never re-runs the
    transcript join). ``consult_rate_pct`` is the CONSERVATIVE-FLOOR
    consultation rate (the pinned ``is_used`` predicate: a later file touch
    or citation); ``hit_rate_pct`` is the labeled-set criterion-1 rate. The
    prune / down-rank / keep counts are the relevance miner's above-floor
    verdicts — the loop that prunes what measurement says is noise."""

    model_config = ConfigDict(extra="forbid")

    injections: Stat
    sessions: Stat
    surfacings: Stat
    consulted: Stat
    consult_rate_pct: Stat
    hit_rate_pct: Stat
    hook_latency_s: Stat
    prune: Stat
    down_rank: Stat
    keep: Stat


class RecallStats(BaseModel):
    """Recall's prompt-time memory scale (NET-NEW P6 field): the count of
    inventory assets the recall layer can surface at prompt time, pulled from
    the recall inventory's machine-written ``asset_count`` scalar (no asset
    bodies, no PII — a single count). ``use`` adds the measured-usefulness
    receipts (meta §4 memory card)."""

    model_config = ConfigDict(extra="forbid")
    inventory_size: Stat
    use: RecallUseStats


class LabExploreStats(BaseModel):
    """The /explore mode-experiments exhibit: completed headless runs +
    designed experiments (machine counts), and the two E5 hedging-lever
    effect sizes (hand-pinned — spec-header comment is the only on-disk
    source; governed by the ``lab_explore_effects`` consistency TODO)."""

    model_config = ConfigDict(extra="forbid")

    completed_runs: Stat
    designs: Stat
    effect_l5: Stat
    effect_l3: Stat


class LabConfigExperimentStats(BaseModel):
    """The config-experiment exhibit: isolated ``CLAUDE_CONFIG_DIR`` profiles
    on disk. The A/B/C verdict is deliberately PENDING — the page's honesty
    gate requires that status to render, so this model carries only the
    machine-countable profile census."""

    model_config = ConfigDict(extra="forbid")

    profiles: Stat


class LabGateCheckStats(BaseModel):
    """The real_gate_check exhibit: the proxy-gate detector's latest census
    row (gates audited / flagged / ok / untested)."""

    model_config = ConfigDict(extra="forbid")

    gates_audited: Stat
    flagged: Stat
    ok: Stat
    untested: Stat


class LabInlineChatStats(BaseModel):
    """The inline-chat exhibit: registered doc-mediated threads (content-plane
    registry) + the flagship thread's versioned-round census (repo-side
    snapshots)."""

    model_config = ConfigDict(extra="forbid")

    threads: Stat
    flagship_rounds: Stat


class LabStats(BaseModel):
    """The lab wing's four exhibits (deep/lab.html): experiments and
    instruments the collaboration points at ITSELF. Count-only reads — no
    transcript text, no prompt bodies, no student or teacher names."""

    model_config = ConfigDict(extra="forbid")

    explore: LabExploreStats
    config_experiment: LabConfigExperimentStats
    gate_check: LabGateCheckStats
    inline_chat: LabInlineChatStats


class RetroIntervention(BaseModel):
    """One tracked retro intervention's occurrence-RATE outcome (Phase P6).

    THE net-new P6 field on :class:`RetroStats`: the per-intervention
    ``direction`` the meta wing's "regressions render too" gate depends on
    (``improved`` / ``regressed`` / ``flat`` / ``baseline``). The token-cost
    fields in the source report are NON-comparable across the retro P2
    cost-basis change (the report marks them ``tokens_comparable=false``) and
    are NEVER carried here — only the occurrence-RATE story. ``rate_change`` is
    the signed occurrence-rate ``%`` vs the pre-ship baseline (a provenanced
    :class:`Stat`), present only when both baseline and current rates exist;
    ``rate_note`` is the numeral-free framing for the rows where a rate is
    absent (a finding that dropped below the tracking floor, or a brand-new
    baseline)."""

    model_config = ConfigDict(extra="forbid")

    intervention_id: str
    name: str
    direction: str
    rate_change: Union[Stat, None] = None
    rate_note: str

    @field_validator("intervention_id", "name", "direction", "rate_note")
    @classmethod
    def _nonempty(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("RetroIntervention text fields must be non-empty")
        return value

    @field_validator("direction")
    @classmethod
    def _known_direction(cls, value: str) -> str:
        allowed = {"improved", "regressed", "flat", "baseline", "None"}
        if value not in allowed:
            raise ValueError(
                f"RetroIntervention.direction {value!r} not in {sorted(allowed)}"
            )
        return value


class RetroStats(BaseModel):
    model_config = ConfigDict(extra="forbid")
    trends_total: Stat
    by_direction: dict[str, Stat]
    source_report: Stat
    #: NET-NEW P6 field: the per-intervention occurrence-rate breakdown whose
    #: ``direction`` drives the meta wing's ≥1-visibly-regressed-row gate. The
    #: aggregate counts above stay P1's; this list is P6's, so the two phases
    #: never claim the same field.
    interventions: list["RetroIntervention"]


# ---------------------------------------------------------------------------
# Top-level document
# ---------------------------------------------------------------------------


class ShowcaseData(BaseModel):
    """Top-level shape of ``tools/showcase/out/showcase_data.json``."""

    model_config = ConfigDict(extra="forbid")

    schema_version: int
    generated_at: str

    repo: RepoStats
    catalog: CatalogStats
    import_graph: ImportGraphStats
    inventory: InventoryStats
    problems: ProblemStats
    sim: SimStats
    loc: LocStats
    gates: GateStats
    invariants: InvariantStats
    hooks: HookStats
    retro: RetroStats
    recall: RecallStats
    lab: LabStats
    fv_aggregate: FvAggregate
    consistency_todos: list[ConsistencyTodo]

    @field_validator("schema_version", mode="before")
    @classmethod
    def _reject_bool(cls, value: Any) -> Any:
        if isinstance(value, bool):
            raise ValueError("schema_version must be int, got bool")
        return value

    @field_validator("generated_at")
    @classmethod
    def _generated_nonempty(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("generated_at must be a non-empty string")
        return value


# ---------------------------------------------------------------------------
# Validation + loader
# ---------------------------------------------------------------------------


def _wrap(call: Callable[[], ShowcaseData], *, label: str) -> ShowcaseData:
    """Run ``call``; re-raise any ``pydantic.ValidationError`` wrapped as
    :class:`ShowcaseSchemaError` with the first error's location."""
    try:
        return call()
    except ValidationError as exc:
        first = exc.errors()[0]
        loc = ".".join(str(p) for p in first.get("loc", ()))
        msg = first.get("msg", "validation error")
        raise ShowcaseSchemaError(f"{label} {loc}: {msg}") from exc


def validate_showcase_data(payload: Any) -> ShowcaseData:
    """Validate a parsed ``showcase_data.json`` payload.

    Returns the validated :class:`ShowcaseData`. Raises
    :class:`ShowcaseSchemaError` on any violation.
    """
    return _wrap(
        lambda: ShowcaseData.model_validate(payload),
        label="showcase_data.json",
    )


def load_showcase_data(path: Path | str) -> ShowcaseData:
    """Read + validate ``showcase_data.json`` at ``path``.

    Raises:
        FileNotFoundError: if ``path`` does not exist.
        json.JSONDecodeError: if the file is not valid JSON.
        ShowcaseSchemaError: if the payload violates the schema.
    """
    target = Path(path)
    payload = json.loads(target.read_text(encoding="utf-8"))
    return validate_showcase_data(payload)
