// ui/preset_selector.js
//
// Curriculum-preset selector (1st-year / AP-C / Honors). Extracted from
// toolbar.js per plan sim_interactivity_viz T1 (#1) so the preset switch
// sits at the top-left of the scenario row, BEFORE the scenario dropdown
// — the first choice a teacher makes, not buried mid-toolbar.
//
// Layering: the preset vocabulary (enum values + user-facing labels) is
// owned by preset_gating.js (the shared curriculum-scoping module); this
// file owns only the DOM. scenario_loader.js exposes the preset-switch
// COMMAND (setPreset) — neither module builds the other's DOM.
//
// Anti-Kohn: curriculum names only (PRESET_LABELS), no difficulty-band or
// ranking framing. Session-only; no persistence.

import { KNOWN_PRESETS, PRESET_LABELS, DEFAULT_PRESET } from './preset_gating.js';

const STYLE = `
#scenario-row { display: flex; align-items: stretch; flex-wrap: wrap; }
.sim-preset {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.5rem 0.75rem;
  background: #f3f4f8;
  border-bottom: 1px solid #d8dbe1;
  font-size: 0.85rem;
  color: #4a4f59;
}
.sim-preset select {
  min-height: 44px;
  padding: 0.5rem;
  border: 1px solid #c5c9d2;
  border-radius: 6px;
  background: #fff;
  font: inherit;
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

export function makePresetSelector({ onPresetChange }) {
  injectStyles();

  const root = document.createElement('label');
  root.className = 'sim-preset';
  root.textContent = 'preset';

  const sel = document.createElement('select');
  sel.setAttribute('aria-label', 'Curriculum preset');
  for (const value of KNOWN_PRESETS) {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = PRESET_LABELS[value] ?? value;
    sel.appendChild(o);
  }
  sel.value = DEFAULT_PRESET;
  sel.addEventListener('change', () => onPresetChange?.(sel.value));
  root.appendChild(sel);

  return {
    root,
    // Coerce the selector back to a known value (e.g. if a future saved
    // preference holds an out-of-vocabulary string). Mirrors the setter
    // toolbar.js previously exposed.
    setPresetValue(preset) { sel.value = preset; }
  };
}

export const NAME = 'preset_selector';
