// ui/scenario_loader.js
//
// Scenario picker + non-modal validation banner. Five built-in scenarios
// ship with the v1 simulator; the loader fetches them by relative path
// (the simulator runs from disk OR from a static server). On
// schema-validation failure (or any fetch / parse failure), surfaces a
// non-modal banner with the validator message AND a "Load default
// scenario" button. The CLI exits 1 in the same case; both paths surface
// the failure — neither silently substitutes a fallback (per plan
// §Phase E).
//
// Phase 2.7 — adds curriculum-preset filtering. Each scenario carries
// a canonical schema-enum preset string (mirrors scene JSON's
// preset_required field); `setPreset(value)` rebuilds the dropdown to
// show only scenes matching the current preset (plus preset-agnostic
// scenes whose `preset` is null). The currently-loaded scene is NOT
// auto-unloaded when its preset goes out of view — the user explicitly
// chose to switch presets, so we surface a banner instead and leave
// the simulation running.

import { filterScenariosByPreset, DEFAULT_PRESET, PRESET_LABELS } from './preset_gating.js';
import { SCENES as REGISTRY_SCENES } from '../scenarios/_registry.js';

// Phase 3.7 Path α three-site lockstep — site #2 of 3. SCENARIOS is
// derived from `sim/scenarios/_registry.js` (single source of truth
// across capture-drift-baseline.js + scenario_loader.js + package.json
// sim:check-bands). Adding a scene requires only one edit in the
// registry; this dropdown picks it up automatically.
//
// Phase 5.C Step 4(b)2 — filter `published === false` scenes from the
// curriculum-facing dropdown. The `_test_only/` engine-smoke-fixture
// convention introduces this flag (e.g. rc_smoke_2node.json); these
// fixtures live in the registry so capture-drift-baseline picks them up
// (per plan §919-922 explicit decision) but they MUST stay invisible to
// teachers and students. Default = visible (when `published` is omitted).
//
// showcase_live_sim_v1 Phase L2 — export-flag gate on that published
// filter. The publicity wing embeds this sim by explicit id
// (`sim/index.html?scene=proof_energy_k015_hilltop&embed=1`) to run the
// three `published:false` numeric-fidelity exhibit scenes live. main.js
// feeds `SCENARIOS_LIST.map(s => s.id)` into resolveBootSceneId as its
// knownIds, so an id absent from SCENARIOS is unbootable (it falls back to
// DEFAULT_SCENARIO — hello_world) AND load() has no `path` to fetch it.
// The wing's vendor step injects `window.__SHOWCASE_EXPORT__ = true` BEFORE
// the module boot script; ONLY under that flag do we KEEP the
// `published:false` scenes in SCENARIOS, so those exhibit URLs boot their
// requested fixture. Flag ABSENT — every curriculum build, physics/sim run
// directly, and any Node/test import — leaves the filter intact:
// `published:false` scenes stay out of the dropdown AND out of knownIds, so
// there is ZERO behavior change for students and teachers. The `published`
// FIELD is never mutated; this reads the registry as-is and only widens the
// in-memory list for the export shell. `typeof window` guards the non-
// browser (Node) context so a headless import never throws.
const SHOWCASE_EXPORT =
  typeof window !== 'undefined' && window.__SHOWCASE_EXPORT__ === true;
const SCENARIOS = REGISTRY_SCENES
  .filter((s) => SHOWCASE_EXPORT || s.published !== false)
  .map((s) => ({
    id: s.id,
    path: s.path,
    preset: s.preset
  }));
const DEFAULT_SCENARIO = SCENARIOS[0];

const STYLE = `
.sim-scenario-loader {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem;
  background: #f3f4f8;
  border-bottom: 1px solid #d8dbe1;
}
.sim-scenario-loader select {
  min-height: 44px;
  padding: 0.5rem;
  border: 1px solid #c5c9d2;
  border-radius: 6px;
  background: #fff;
  font: inherit;
  flex: 1;
  max-width: 28rem;
}
.sim-scenario-loader button {
  min-height: 44px;
  min-width: 44px;
  padding: 0.5rem 1rem;
  border: 1px solid #c5c9d2;
  border-radius: 6px;
  background: #fff;
  font: inherit;
  cursor: pointer;
}
.sim-banner {
  background: #fff5d6;
  border-bottom: 1px solid #d8b95b;
  padding: 0.75rem 1rem;
  display: flex;
  align-items: flex-start;
  gap: 0.75rem;
  color: #5a4500;
}
.sim-banner.error {
  background: #fde2e2;
  border-bottom-color: #d27272;
  color: #6b1e1e;
}
.sim-banner code {
  background: rgba(0,0,0,0.06);
  padding: 0 0.25rem;
  border-radius: 3px;
  font-size: 0.9em;
}
.sim-banner button {
  min-height: 36px;
  margin-left: auto;
  padding: 0.4rem 0.8rem;
  border: 1px solid #b09030;
  border-radius: 6px;
  background: #fff;
  font: inherit;
  cursor: pointer;
}
.sim-banner.hidden { display: none; }
`;

let stylesInjected = false;
function injectStyles() {
  if (stylesInjected) return;
  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.appendChild(style);
  stylesInjected = true;
}

export function makeScenarioLoader({ onLoad }) {
  injectStyles();

  let currentPreset = DEFAULT_PRESET;
  let lastLoadedId = null; // tracked so setPreset can surface a banner
                           // when the preset hides the active scene.

  const loaderRoot = document.createElement('div');
  loaderRoot.className = 'sim-scenario-loader';
  const sel = document.createElement('select');
  sel.setAttribute('aria-label', 'Choose scenario');
  function rebuildOptions() {
    // Preserve the user's selected value across rebuilds when it
    // remains visible under the new preset. Otherwise drop to the
    // first visible scene; if zero are visible, leave sel.value empty.
    const previous = sel.value;
    while (sel.firstChild) sel.removeChild(sel.firstChild);
    const visible = filterScenariosByPreset(SCENARIOS, currentPreset);
    for (const s of visible) {
      const o = document.createElement('option');
      o.value = s.id;
      o.textContent = s.id;
      sel.appendChild(o);
    }
    if (visible.some((s) => s.id === previous)) {
      sel.value = previous;
    } else if (visible.length > 0) {
      sel.value = visible[0].id;
    } else {
      sel.value = '';
    }
  }
  rebuildOptions();
  const reloadBtn = document.createElement('button');
  reloadBtn.textContent = 'Reload';
  reloadBtn.setAttribute('aria-label', 'Reload selected scenario');

  loaderRoot.append(document.createTextNode('Scenario:'), sel, reloadBtn);

  const bannerRoot = document.createElement('div');
  bannerRoot.className = 'sim-banner hidden';
  const bannerMsg = document.createElement('div');
  const bannerBtn = document.createElement('button');
  bannerBtn.textContent = 'Load default scenario';
  bannerBtn.setAttribute('aria-label', 'Load the default hello_world scenario');
  bannerRoot.append(bannerMsg, bannerBtn);

  function showBanner(message, kind = 'warn') {
    bannerRoot.classList.remove('hidden');
    bannerRoot.classList.toggle('error', kind === 'error');
    bannerMsg.innerHTML = message; // caller is trusted; no user input here
  }
  function hideBanner() {
    bannerRoot.classList.add('hidden');
  }

  async function load(id) {
    const scenario = SCENARIOS.find((s) => s.id === id) ?? DEFAULT_SCENARIO;
    sel.value = scenario.id;
    lastLoadedId = scenario.id;
    try {
      const resp = await fetch(scenario.path, { cache: 'no-cache' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const json = await resp.json();
      hideBanner();
      onLoad?.(json, scenario);
      return json;
    } catch (err) {
      showBanner(
        `Could not load scenario <code>${escapeHtml(id)}</code>: ${escapeHtml(err.message)}. ` +
        `If you opened <code>sim/index.html</code> directly, your browser may block <code>file://</code> fetches; serve via a local HTTP server instead.`,
        'error'
      );
      return null;
    }
  }

  // Phase 2.7 — switch the active curriculum preset. Rebuilds the
  // dropdown to show only matching scenes; if the active scene is
  // hidden by the new preset, surfaces an informational banner so the
  // user understands why their picker no longer lists it. The active
  // simulation keeps running — the user explicitly chose to switch
  // presets, so we don't kick them off mid-investigation.
  function setPreset(preset) {
    currentPreset = preset;
    rebuildOptions();
    if (lastLoadedId) {
      const active = SCENARIOS.find((s) => s.id === lastLoadedId);
      const visible = filterScenariosByPreset(SCENARIOS, currentPreset);
      const stillVisible = visible.some((s) => s.id === lastLoadedId);
      if (active && !stillVisible) {
        const required = active.preset
          ? (PRESET_LABELS[active.preset] ?? active.preset)
          : 'any';
        const currentLabel = PRESET_LABELS[currentPreset] ?? currentPreset;
        showBanner(
          `Active scene <code>${escapeHtml(lastLoadedId)}</code> is hidden under the ${escapeHtml(currentLabel)} preset (it requires <code>${escapeHtml(required)}</code>). It is still running — switch back to ${escapeHtml(required)} to see it in the picker.`,
          'warn'
        );
        return;
      }
    }
    if (filterScenariosByPreset(SCENARIOS, currentPreset).length === 0) {
      const currentLabel = PRESET_LABELS[currentPreset] ?? currentPreset;
      showBanner(
        `No scenes available under the ${escapeHtml(currentLabel)} preset. Switch back to a preset with available scenes.`,
        'warn'
      );
    } else {
      hideBanner();
    }
  }

  sel.addEventListener('change', () => load(sel.value));
  reloadBtn.addEventListener('click', () => load(sel.value));
  bannerBtn.addEventListener('click', () => {
    sel.value = DEFAULT_SCENARIO.id;
    load(DEFAULT_SCENARIO.id);
  });

  return {
    loaderRoot,
    bannerRoot,
    showBanner,
    hideBanner,
    load,
    setPreset,
    selected() { return sel.value; },
    visibleScenarios() { return filterScenariosByPreset(SCENARIOS, currentPreset); },
    DEFAULT_SCENARIO
  };
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export const SCENARIOS_LIST = SCENARIOS;
export const NAME = 'scenario_loader';
