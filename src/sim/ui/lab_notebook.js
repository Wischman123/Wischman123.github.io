// ui/lab_notebook.js
//
// Lab-notebook panel (sim_lab_notebook P2). Each COMPLETED run appends ONE
// row: the student's chosen independent value (the scene INPUT they varied
// between runs) plus the final-state scalar OUTPUT quantities. There is NO
// expected/target column and NO verdict — the notebook is a discovery
// instrument, not an evaluation surface (see sim/PEDAGOGY.md). The student
// chooses what to record and reads the trend; the software never judges.
//
// Anti-Kohn (non-negotiable): descriptive column/button copy only ("mass (kg)",
// "final speed (m/s)", "recorded", "measured"); never evaluative wording.
//
// Factory shape mirrors makePredictPanel (sim/ui/predict.js) and EXTENDS it
// with a run-start hook and a row-wiping method:
//   { root, setScene, initWith, onRunStart, onSimComplete,
//     onBetweenRunReset, onSceneParamChange, reset, clearNotebook, ... }
//
// DEDUPE — once-per-run + fresh gate (from the pre-build LOCATE step).
//   The Play handler (main.js onPlay → currentRunner.play()) is NOT a
//   new-run-only event: a mid-run resume AND a scrub-back-then-Play replay
//   BOTH re-enter it. So a latch armed on every onRunStart would append a
//   duplicate row on such a replay. Per the plan's REPLAY-vs-NEW-RUN
//   contingency, onRunStart is therefore gated by a "fresh since last
//   completion" signal the panel owns. Both the once-per-run latch and that
//   fresh signal are unified here into a single run-lifecycle state:
//     IDLE_FRESH  — a fresh run is set up (scene load / between-run Reset /
//                   param change) and awaits its FIRST launch.
//     RUNNING     — launched: body_id frozen + independent value captured,
//                   awaiting exactly one row.
//     RECORDED    — the row was appended; further atEnd ticks (replay,
//                   scrub-to-end, resume-at-end) are swallowed, and a
//                   replay-via-Play onRunStart is a no-op (not IDLE_FRESH).
//   Only the IDLE_FRESH -> RUNNING transition captures + arms; a mid-run
//   resume (already RUNNING) and a post-completion replay (RECORDED) are
//   both no-ops. This is what prevents a stale mid-run re-read of a
//   view-sourced independent value (e.g. initial velocity) and a duplicate
//   row from a replay.

import { QUANTITIES, readAllQuantities, resolveQuantityFor } from './quantities.js';
import { renderScatter } from '../render/scatter_plot.js';

// --- Scene-parameter DESCRIPTORS (the independent-column seam) --------------
//
// Mirror of the QUANTITIES OUTPUT seam: every varied-able scene INPUT declares
// its columnKey / label / scope and a readRunStartValue(view, scene, body_id)
// closure that OWNS its own read path. The picker enumerates the descriptors
// PRESENT in the current scene, and onRunStart's capture calls the chosen
// descriptor's closure — so "offer only what this scene contains" falls
// straight out of the list, and adding a NEW varied-able input means declaring
// ONE descriptor here, never editing the panel (the same "declare once, both
// surfaces inherit" property the output QUANTITIES list already has).
//
// Read-path sourcing (per the plan's k caveat, all in the UI layer — no
// sim/engine/ edit):
//   - mass / initial velocity / initial position: LIVE, from the run-start
//     `view` (reflects the student's applied inspector edits at run-start).
//   - k (spring constant): NOT exposed on runner.view(); read from the current
//     scene-config JSON. The inspector does NOT edit k in this codebase, so the
//     scene-config value is always run-start-accurate (nothing mutates it out
//     from under the JSON), and the panel refreshes its scene ref via setScene
//     on every scene (re)load.
//   - friction mu / incline angle: scene-config JSON. mu is inspector-editable,
//     but those edits are applied on Reset (merged back INTO the scene), and
//     setScene delivers the merged scene, so the run-start read stays accurate.
//     angle is static geometry (not inspector-editable).
//
// Independent keys are namespaced DISTINCTLY from QUANTITIES output keys
// (v0.x vs velocity.x) so a union of both never collides on a shared key.
export const SCENE_PARAMETERS = [
  {
    columnKey: 'mass', label: 'mass (kg)', scope: 'body',
    presentIn: (scene) => (scene?.bodies?.length ?? 0) > 0,
    readRunStartValue: (view, _scene, bodyId) =>
      view?.bodies?.find((b) => b.id === bodyId)?.mass ?? null
  },
  {
    columnKey: 'v0.x', label: 'initial velocity x (m/s)', scope: 'body',
    presentIn: () => true,
    readRunStartValue: (view, _scene, bodyId) => resolveQuantityFor(view, bodyId, 'velocity.x')
  },
  {
    columnKey: 'v0.y', label: 'initial velocity y (m/s)', scope: 'body',
    presentIn: () => true,
    readRunStartValue: (view, _scene, bodyId) => resolveQuantityFor(view, bodyId, 'velocity.y')
  },
  {
    columnKey: 'x0.x', label: 'initial position x (m)', scope: 'body',
    presentIn: () => true,
    readRunStartValue: (view, _scene, bodyId) => resolveQuantityFor(view, bodyId, 'position.x')
  },
  {
    columnKey: 'x0.y', label: 'initial position y (m)', scope: 'body',
    presentIn: () => true,
    readRunStartValue: (view, _scene, bodyId) => resolveQuantityFor(view, bodyId, 'position.y')
  },
  {
    columnKey: 'k', label: 'spring constant k (N/m)', scope: 'scene',
    presentIn: (scene) => (scene?.forces ?? []).some((f) => f.type === 'spring'),
    readRunStartValue: (_view, scene) => springConstant(scene)
  },
  {
    columnKey: 'mu', label: 'friction coefficient μ', scope: 'scene',
    presentIn: (scene) => (scene?.forces ?? []).some((f) => f.type === 'friction'),
    readRunStartValue: (_view, scene) => frictionMu(scene)
  },
  {
    columnKey: 'angle', label: 'ramp angle (deg)', scope: 'scene',
    presentIn: (scene) => (scene?.surfaces ?? []).some((s) => s.shape === 'inclined'),
    readRunStartValue: (_view, scene) => inclineAngleDeg(scene)
  }
];

function springConstant(scene) {
  const spring = (scene?.forces ?? []).find((f) => f.type === 'spring');
  return spring?.k_N_per_m ?? null;
}

function frictionMu(scene) {
  const friction = (scene?.forces ?? []).find((f) => f.type === 'friction');
  return friction?.mu_k ?? null;
}

function inclineAngleDeg(scene) {
  const surf = (scene?.surfaces ?? []).find((s) => s.shape === 'inclined');
  if (!surf) return null;
  const dx = (surf.p2?.x ?? 0) - (surf.p1?.x ?? 0);
  const dy = (surf.p2?.y ?? 0) - (surf.p1?.y ?? 0);
  if (dx === 0 && dy === 0) return null;
  // Angle from horizontal, in degrees (sign-free — a ramp's steepness).
  return Math.abs(Math.atan2(dy, dx) * 180 / Math.PI);
}

export function descriptorFor(columnKey) {
  return SCENE_PARAMETERS.find((d) => d.columnKey === columnKey) ?? null;
}

export function availableParameters(scene, view) {
  return SCENE_PARAMETERS.filter((d) => d.presentIn(scene, view));
}

// --- PURE row / column helpers (DOM-free, headless-testable) ----------------

// Append one sample row. Pure: returns a NEW array, never mutates.
export function appendRow(rows, sample) {
  return [...rows, sample];
}

// Ordered { key, label } column DESCRIPTORS for a set of rows.
//   - The entered (independent) column(s) come FIRST. The independent key is
//     UNIONED across ALL rows (never off row[0] alone), so a table that mixes
//     a `mass` run and a `k` run surfaces BOTH labeled columns. Each column's
//     label is recovered from the `label` stored on that row's independent
//     cell — which is what lets the student's chosen label survive to the
//     header and the P3 axis pickers.
//   - The measured (output) columns follow, one per QUANTITIES entry in order.
export function columnsOf(rows) {
  const columns = [];
  const seen = new Set();
  for (const row of rows) {
    const entered = row?.independent;
    if (entered && entered.key != null && !seen.has(entered.key)) {
      seen.add(entered.key);
      columns.push({ key: entered.key, label: entered.label ?? entered.key });
    }
  }
  for (const q of QUANTITIES) {
    columns.push({ key: q.value, label: q.label });
  }
  return columns;
}

// Resolve one cell of a row for a given column key. NULL-SAFE for BOTH column
// kinds:
//   - Entered column: the value lives under `row.independent`, keyed by the
//     chosen parameter. A row whose independent key DIFFERS from `key` (the
//     student switched the independent parameter between runs) yields null —
//     a blank cell, never a TypeError.
//   - Measured column: one cell per QUANTITIES entry (readAllQuantities). A
//     row missing the key yields null (blank).
export function cellValue(row, key) {
  const entered = row?.independent;
  if (entered && entered.key === key) return entered.value ?? null;
  const value = row ? row[key] : undefined;
  return value === undefined ? null : value;
}

// Serialize the table to CSV. A null cell renders blank (NOT 0). `columns`
// defaults to columnsOf(rows) — i.e. EXACTLY the visible table columns, with NO
// hidden expected column (there is none to hide; P2 never records one). A caller
// may pass its own column list to pin the export to precisely what it shows.
// The P3 "Copy CSV" button calls this. `csvField` quotes/escapes any header or
// value that carries a comma, quote, or newline (the quantity labels are safe
// today — e.g. "final speed (m/s)" — but we escape defensively).
export function toCSV(rows, columns = columnsOf(rows)) {
  const header = columns.map((c) => csvField(c.label)).join(',');
  const lines = rows.map((row) =>
    columns.map((c) => {
      const v = cellValue(row, c.key);
      return v === null ? '' : csvField(formatCell(v));
    }).join(',')
  );
  return [header, ...lines].join('\n');
}

// Pure X/Y extraction for the scatter (sim_lab_notebook P3). Reads the chosen X
// and Y column from each row via the null-safe cellValue and returns { x, y }
// pairs of FINITE numbers only. A row whose X or Y cell is null (or non-finite)
// is SKIPPED — never coerced to 0 — so a switched-independent-key blank or a
// missing measured scalar drops out of the plot instead of landing on the axis.
export function scatterSamples(rows, xKey, yKey) {
  const out = [];
  for (const row of rows) {
    const x = cellValue(row, xKey);
    const y = cellValue(row, yKey);
    if (typeof x !== 'number' || !Number.isFinite(x)) continue;
    if (typeof y !== 'number' || !Number.isFinite(y)) continue;
    out.push({ x, y });
  }
  return out;
}

// The measured (output) column keys — the QUANTITIES value keys. Used to tell an
// ENTERED (independent) column from a measured one when picking axis defaults.
const MEASURED_KEYS = new Set(QUANTITIES.map((q) => q.value));

// Default X axis: prefer the first ENTERED (independent) column so the plot
// opens on "the input you varied"; fall back to the first column when no row has
// recorded an independent value yet (a 0-row notebook shows only measured
// columns). Never asserts a "right" pairing — just a starting suggestion.
export function defaultXKey(columns) {
  const entered = columns.find((c) => !MEASURED_KEYS.has(c.key));
  return entered?.key ?? columns[0]?.key ?? null;
}

// Default Y axis: the first measured scalar that is not already the X axis.
export function defaultYKey(columns, xKey) {
  const firstMeasured = columns.find((c) => MEASURED_KEYS.has(c.key) && c.key !== xKey);
  return firstMeasured?.key ?? columns.find((c) => c.key !== xKey)?.key ?? columns[0]?.key ?? null;
}

function csvField(text) {
  const s = String(text);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function formatCell(v) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '';
  // Compact fixed decimals, trailing zeros trimmed.
  return String(Number.parseFloat(v.toFixed(3)));
}

// --- Panel factory ----------------------------------------------------------

const RUN_STATE = Object.freeze({
  IDLE_FRESH: 'idle_fresh',
  RUNNING: 'running',
  RECORDED: 'recorded'
});

export function makeLabNotebook({ getSelectedBodyId } = {}) {
  injectStyles();
  const root = document.createElement('div');
  root.className = 'sim-notebook';

  let rows = [];
  let scene = null;              // current scene-config JSON (via setScene)
  let chosenKey = null;          // the student's chosen independent column key
  let available = [];            // descriptors PRESENT in the current scene
  let runState = RUN_STATE.RECORDED;  // nothing pending until a scene loads
  let pendingBodyId = null;      // FROZEN at run-start
  let pendingIndependent = null; // { key, value, label } captured at run-start

  // --- Scatter axis state (P3) ---------------------------------------------
  // The student scatters ANY recorded column against ANY other. Until they pick
  // an axis by hand, the axes TRACK the defaults (X follows the independent
  // column once it appears; Y is the first measured scalar). Once picked, a
  // choice STICKS as long as its column still exists.
  let xAxisKey = null;
  let yAxisKey = null;
  let xUserPicked = false;
  let yUserPicked = false;
  let scatterRedrawArmed = false; // one pending deferred redraw at a time

  function ensureAxisKeys(columns) {
    const keys = new Set(columns.map((c) => c.key));
    if (!xUserPicked || !keys.has(xAxisKey)) xAxisKey = defaultXKey(columns);
    if (!yUserPicked || !keys.has(yAxisKey)) yAxisKey = defaultYKey(columns, xAxisKey);
  }

  function setScatterAxis(which, key) {
    const columns = columnsOf(rows);
    if (!columns.some((c) => c.key === key)) return;
    if (which === 'x') { xAxisKey = key; xUserPicked = true; }
    else { yAxisKey = key; yUserPicked = true; }
    render();
  }

  // Draw the scatter into the panel's own <canvas>. Headless callers (the DOM
  // stub in the unit tests) get a plain element with no getContext, so this is
  // a no-op there. When the canvas exists but is not yet laid out, renderScatter
  // BAILS (returns false); we then arm exactly ONE deferred redraw so the plot
  // appears on the next frame — without an unbounded rAF loop for a panel that
  // stays hidden.
  function drawScatter(fromDeferred = false) {
    const canvas = root.querySelector?.('[data-id="scatter"]');
    if (!canvas || typeof canvas.getContext !== 'function') return;
    const columns = columnsOf(rows);
    ensureAxisKeys(columns);
    const samples = scatterSamples(rows, xAxisKey, yAxisKey);
    const xCol = columns.find((c) => c.key === xAxisKey);
    const yCol = columns.find((c) => c.key === yAxisKey);
    const drawn = renderScatter(canvas, samples, {
      xLabel: xCol?.label ?? '',
      yLabel: yCol?.label ?? ''
    });
    if (!drawn && !fromDeferred && !scatterRedrawArmed
        && typeof requestAnimationFrame === 'function') {
      scatterRedrawArmed = true;
      requestAnimationFrame(() => { scatterRedrawArmed = false; drawScatter(true); });
    }
  }

  function copyCSV() {
    writeToClipboard(toCSV(rows, columnsOf(rows)));
  }

  function resolveBodyId(view) {
    const selected = typeof getSelectedBodyId === 'function' ? getSelectedBodyId() : null;
    // Defined FALLBACK to the primary/first body when nothing is selected.
    return selected ?? view?.bodies?.[0]?.id ?? null;
  }

  function refreshAvailable(view) {
    available = availableParameters(scene, view);
    // Keep the student's choice if still present; else default to the first
    // offered descriptor. The initial-state descriptors are always present, so
    // the picker is never empty.
    if (!available.some((d) => d.columnKey === chosenKey)) {
      chosenKey = available[0]?.columnKey ?? null;
    }
  }

  function setIndependentColumn(key) {
    if (SCENE_PARAMETERS.some((d) => d.columnKey === key)) {
      chosenKey = key;
      render();
    }
  }

  function clearNotebook() {
    // SOLE row-wiping method — fires ONLY on a scene change or an explicit
    // "Clear notebook" action, NEVER on a between-run Reset (that would make
    // accumulation impossible). Arms the next fresh run.
    rows = [];
    runState = RUN_STATE.IDLE_FRESH;
    render();
  }

  function armFreshRun() {
    // Between-run Reset / param-change gate signal: mark a genuine new run
    // pending and PRESERVE rows. Deliberately the OPPOSITE of clearNotebook so
    // a host can never silently wire the between-run Reset to the row wipe.
    runState = RUN_STATE.IDLE_FRESH;
  }

  function render() {
    const columns = columnsOf(rows);
    const html = [];
    html.push('<h3>Lab notebook</h3>');
    html.push('<p class="intro">Each completed run adds one row: the input you varied and the measured results.</p>');
    html.push('<div class="pick"><label for="nb-pick">Input you\'re varying</label>');
    html.push('<select data-id="picker" id="nb-pick">');
    for (const d of available) {
      const sel = d.columnKey === chosenKey ? ' selected' : '';
      html.push(`<option value="${escapeHtml(d.columnKey)}"${sel}>${escapeHtml(d.label)}</option>`);
    }
    html.push('</select></div>');
    if (rows.length === 0) {
      html.push('<p class="empty">No runs recorded yet. Run the simulation to add a row.</p>');
    } else {
      html.push('<table class="nb-table"><thead><tr>');
      for (const c of columns) html.push(`<th>${escapeHtml(c.label)}</th>`);
      html.push('</tr></thead><tbody>');
      for (const row of rows) {
        html.push('<tr>');
        for (const c of columns) {
          const v = cellValue(row, c.key);
          html.push(`<td>${v === null ? '' : escapeHtml(formatCell(v))}</td>`);
        }
        html.push('</tr>');
      }
      html.push('</tbody></table>');
    }
    // --- Derive-the-model scatter (P3) --------------------------------------
    // Scatter ANY recorded column against ANY other. The axis pickers assert NO
    // "right" pairing — finding the relationship in the dots is the student's
    // work. The <canvas> is a standalone plot element (sim/render/scatter_plot),
    // NOT the main sim canvas.
    ensureAxisKeys(columns);
    html.push('<div class="scatter">');
    html.push('<p class="scatter-intro">Scatter one recorded column against another to look for a relationship.</p>');
    html.push('<div class="axes">');
    html.push(axisSelectHtml('scatter-x', 'X axis', columns, xAxisKey));
    html.push(axisSelectHtml('scatter-y', 'Y axis', columns, yAxisKey));
    html.push('</div>');
    html.push('<canvas data-id="scatter" class="scatter-canvas"></canvas>');
    html.push('</div>');

    html.push('<div class="nb-actions">');
    html.push('<button data-id="copy-csv" class="nb-btn">Copy CSV</button>');
    html.push('<button data-id="clear" class="nb-btn nb-clear">Clear notebook</button>');
    html.push('</div>');
    root.innerHTML = html.join('');

    const picker = root.querySelector?.('[data-id="picker"]');
    if (picker) picker.addEventListener?.('change', (ev) => setIndependentColumn(ev.target.value));
    const xSel = root.querySelector?.('[data-id="scatter-x"]');
    if (xSel) xSel.addEventListener?.('change', (ev) => setScatterAxis('x', ev.target.value));
    const ySel = root.querySelector?.('[data-id="scatter-y"]');
    if (ySel) ySel.addEventListener?.('change', (ev) => setScatterAxis('y', ev.target.value));
    const copyBtn = root.querySelector?.('[data-id="copy-csv"]');
    if (copyBtn) copyBtn.addEventListener?.('click', () => copyCSV());
    const clearBtn = root.querySelector?.('[data-id="clear"]');
    if (clearBtn) clearBtn.addEventListener?.('click', () => clearNotebook());

    drawScatter();
  }

  // Build one labeled axis <select> populated from the visible columns.
  function axisSelectHtml(dataId, label, columns, chosen) {
    const parts = [`<div class="axis"><label>${escapeHtml(label)}</label>`];
    parts.push(`<select data-id="${dataId}">`);
    for (const c of columns) {
      const sel = c.key === chosen ? ' selected' : '';
      parts.push(`<option value="${escapeHtml(c.key)}"${sel}>${escapeHtml(c.label)}</option>`);
    }
    parts.push('</select></div>');
    return parts.join('');
  }

  return {
    root,

    // Scene-config ref for the scene-sourced descriptors (k / mu / angle).
    // Mirrors inspector.setScene — called at every scene (re)load.
    setScene(nextScene) { scene = nextScene; },

    // Scene-load hook: register the picker columns PRESENT in this scene and
    // mark a fresh run pending. The row's independent VALUE is NOT read here —
    // it is captured later, by onRunStart at the launch moment, so an inspector
    // edit made between scene-load and launch is reflected (capturing here would
    // record the pre-edit baseline).
    initWith(view) {
      refreshAvailable(view);
      runState = RUN_STATE.IDLE_FRESH;
      render();
    },

    // Launch hook (wired to the Play handler). Does its THREE jobs ONLY on the
    // IDLE_FRESH -> RUNNING transition (a genuine fresh launch): (a) FREEZE the
    // measured body_id (per-body reads depend on it, so freeze first), (b) read
    // + store the chosen independent value USING that frozen body, (c) arm the
    // once-per-run row. A mid-run resume (RUNNING) or a replay-via-Play
    // (RECORDED) re-enters the SAME Play handler but finds the run not fresh and
    // is a no-op — the CONTINGENCY gate that keeps a replay from duplicating a
    // row or a resume from stale-re-reading a view-sourced value.
    onRunStart(view) {
      if (runState !== RUN_STATE.IDLE_FRESH) return;
      pendingBodyId = resolveBodyId(view);                       // (a)
      const descriptor = descriptorFor(chosenKey);
      pendingIndependent = descriptor
        ? {
            key: descriptor.columnKey,
            value: descriptor.readRunStartValue(view, scene, pendingBodyId),
            label: descriptor.label
          }
        : null;                                                  // (b)
      runState = RUN_STATE.RUNNING;                              // (c)
    },

    // Completion hook. Appends the single row for this run, then latches. A
    // recurring atEnd (scrub-to-end, replay-to-end, resume-at-end) finds the
    // run already RECORDED and is swallowed. The row's measured scalars use the
    // SAME frozen body_id as the run-start independent read, so a mid-run
    // selection change can never pair body A's mass with body B's final speed.
    onSimComplete(view) {
      if (runState !== RUN_STATE.RUNNING) return;
      const scalars = readAllQuantities(view, pendingBodyId);
      rows = appendRow(rows, { independent: pendingIndependent, ...scalars, body_id: pendingBodyId });
      runState = RUN_STATE.RECORDED;
      render();
    },

    // Between-run Reset gate signal — ARMS the next fresh run and PRESERVES
    // rows (the model is "each Reset + run is a new row").
    onBetweenRunReset() { armFreshRun(); },

    // Parity gate-signal hook. In THIS codebase scene parameters change only via
    // inspector edits APPLIED on Reset (there is no separate live param-change
    // launch), so onBetweenRunReset already covers every param change; this hook
    // exists for interface parity and simply re-arms the fresh run.
    onSceneParamChange() { armFreshRun(); },

    // Parity with makePredictPanel.reset(): delegates to the arm-fresh-run
    // behavior, NOT the row wipe. clearNotebook is the SOLE row-wiping method.
    reset() { armFreshRun(); },

    clearNotebook,
    setIndependentColumn,

    // Scatter-axis control (P3). setScatterAxis('x'|'y', key) mirrors the picker
    // change events; copyCSV / exportCSV expose the export for headless checks.
    setScatterAxis,
    copyCSV,
    exportCSV() { return toCSV(rows, columnsOf(rows)); },

    // Read accessors (headless assertions + P3 consumers).
    getIndependentColumn() { return chosenKey; },
    getAvailableParameters() { return available.slice(); },
    getScatterAxes() { ensureAxisKeys(columnsOf(rows)); return { x: xAxisKey, y: yAxisKey }; },
    getScatterSamples() { ensureAxisKeys(columnsOf(rows)); return scatterSamples(rows, xAxisKey, yAxisKey); },
    getRows() { return rows.slice(); },
    getColumns() { return columnsOf(rows); }
  };
}

// --- Clipboard (P3) ---------------------------------------------------------
// Copy text via the async Clipboard API, falling back to a hidden <textarea> +
// execCommand('copy') where the API is unavailable (older browsers, insecure
// contexts). Best-effort and side-effect-safe: any failure is swallowed so a
// copy attempt never throws into the render path or a headless test.
function writeToClipboard(text) {
  try {
    if (typeof navigator !== 'undefined'
        && navigator.clipboard
        && typeof navigator.clipboard.writeText === 'function') {
      const p = navigator.clipboard.writeText(text);
      if (p && typeof p.catch === 'function') p.catch(() => fallbackClipboard(text));
      return;
    }
  } catch { /* fall through to the textarea path */ }
  fallbackClipboard(text);
}

function fallbackClipboard(text) {
  try {
    if (typeof document === 'undefined' || !document.body) return;
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select?.();
    document.execCommand?.('copy');
    document.body.removeChild(ta);
  } catch { /* best-effort; never throw */ }
}

// --- DOM plumbing -----------------------------------------------------------

const STYLE = `
.sim-notebook {
  font-family: system-ui, sans-serif;
  font-size: 0.9rem;
  border: 1px solid #dde0e7;
  border-radius: 6px;
  padding: 0.75rem;
  margin-bottom: 0.75rem;
  background: #f8f9fc;
}
.sim-notebook h3 { margin: 0 0 0.5rem; font-size: 1rem; font-weight: 600; }
.sim-notebook .intro { margin: 0 0 0.5rem; color: #555; }
.sim-notebook .pick {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 0.5rem;
  align-items: center;
  margin-bottom: 0.6rem;
}
.sim-notebook select {
  min-height: 36px;
  padding: 0.25rem 0.4rem;
  border: 1px solid #c5c9d2;
  border-radius: 4px;
  font: inherit;
}
.sim-notebook .empty { color: #888; font-style: italic; margin: 0.5rem 0; }
.sim-notebook table.nb-table {
  border-collapse: collapse;
  width: 100%;
  font-variant-numeric: tabular-nums;
  margin: 0.4rem 0 0.6rem;
}
.sim-notebook .nb-table th, .sim-notebook .nb-table td {
  border: 1px solid #dde0e7;
  padding: 0.25rem 0.45rem;
  text-align: right;
}
.sim-notebook .nb-table th { background: #eef1f7; font-weight: 600; }
.sim-notebook .scatter { margin: 0.2rem 0 0.6rem; }
.sim-notebook .scatter-intro { margin: 0 0 0.4rem; color: #555; }
.sim-notebook .axes {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
}
.sim-notebook .axis {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 0.4rem;
  align-items: center;
}
.sim-notebook .axis label { color: #555; }
.sim-notebook canvas.scatter-canvas {
  display: block;
  width: 100%;
  height: 200px;
  border: 1px solid #dde0e7;
  border-radius: 4px;
  background: #fff;
}
.sim-notebook .nb-actions {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.sim-notebook button.nb-btn {
  min-height: 44px;
  padding: 0.5rem 1rem;
  border: 1px solid #c5c9d2;
  border-radius: 6px;
  background: #fff;
  font: inherit;
  cursor: pointer;
}
`;

let stylesInjected = false;
function injectStyles() {
  if (stylesInjected) return;
  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.appendChild(style);
  stylesInjected = true;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export const NAME = 'lab_notebook';
