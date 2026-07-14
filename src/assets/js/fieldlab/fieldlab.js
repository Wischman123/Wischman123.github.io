// fieldlab.js — the interactive controller for Fig. 1 (portfolio P3).
//
// Turns the hero field figure into a hands-on demo: drag either charge, switch
// the charge ratio, and watch the field lines + equipotentials recompute live —
// "my diagrams aren't pictures; they're computed." It drives the page's OWN
// tracer (tracer.js, a faithful lift of the shipped hero math), NOT any private
// physics-engine source: engine-source publication is frozen (plan d4), so this
// lab is built entirely on the page tracer, which already uses the site's
// var(--...) design tokens and therefore flips with light/dark theme for free.
//
// The model layer lives in tracer.js and is called by BOTH this controller and
// the headless test (site/tools/test_fieldlab.py) — one code path, so a green
// test cannot diverge from what the reader sees.
//
// Robustness the build handles (plan's named edge cases):
//   (b) drag-overlap singularity — a minimum-separation clamp keeps the two
//       charges apart (the near-bail in fieldRaw is a second line of defense).
//   (c) small touch targets — each charge has an enlarged invisible hit area
//       (>= 44 px) so a fingertip can grab it.
//   (d) responsive embedding — a ResizeObserver sizes the canvas to its card,
//       the backing store is scaled by devicePixelRatio (sharp on retina), and
//       pointer CSS-pixel coordinates are mapped through the canvas box into
//       scene coordinates so drag hit-testing is correct at any width.
// Reduced motion: full static render, drag still works, NO draw-in animation.

import { computeScene, sourceIndex, DEFAULTS } from './tracer.js';
// Scene geometry (default charges + ratio presets) comes from the ONE canonical
// scene module, so the page renders EXACTLY the geometry the gate validates
// (plan P1). RATIO_PRESETS is re-exported to preserve this module's API surface.
import { DEFAULT_CHARGES, RATIO_PRESETS } from './scenes.js';
export { RATIO_PRESETS };


export function initFieldLab(canvas, config) {
  if (!canvas || !canvas.getContext) return null;
  const ctx = canvas.getContext('2d');
  const cfg = Object.assign({
    r0: DEFAULTS.r0,
    fieldStep: DEFAULTS.fieldStep,   // Euler step (measured 1.0 ms/retrace << 50 ms)
    hitPad: 12,                      // + r0 => >= 22 px hit radius (>= 44 px target)
    minSep: 2.5 * DEFAULTS.r0,       // min charge separation (edge case b)
    drawInMs: 1400,
    hintEl: null,
    controlsEl: null,
  }, config || {});

  const reduced = typeof matchMedia === 'function'
    && matchMedia('(prefers-reduced-motion: reduce)').matches;

  // State: charges as FRACTIONS of (w,h) so they survive resize. Copy defaults.
  let charges = DEFAULT_CHARGES.map((c) => c.slice());
  let selected = sourceIndex(charges);
  let dragging = -1;
  let hinted = false;
  let frame = null;      // last computed scene {lines, equips} in px
  let dims = { w: 0, h: 0, dpr: 1 };
  let rafPending = false;

  function tokens() {
    if (typeof getComputedStyle !== 'function') {
      return { accent: '#A15A26', ink: '#1E2B33', equip: '#5B7B92', bg: '#FAF9F5' };
    }
    const s = getComputedStyle(document.documentElement);
    return {
      accent: (s.getPropertyValue('--accent') || '').trim() || '#A15A26',
      ink: (s.getPropertyValue('--ink') || '').trim() || '#1E2B33',
      equip: (s.getPropertyValue('--equip') || '').trim() || '#5B7B92',
      bg: (s.getPropertyValue('--bg') || '').trim() || '#FAF9F5',
    };
  }

  function measure() {
    const w = canvas.clientWidth || canvas.width;
    const h = canvas.clientHeight || canvas.height;
    const dpr = Math.min((typeof window !== 'undefined' && window.devicePixelRatio) || 1, 2);
    dims = { w, h, dpr };
    return dims;
  }

  function chargesPx() {
    return charges.map((c) => [c[0] * dims.w, c[1] * dims.h, c[2]]);
  }

  // Enforce the minimum-separation clamp on a moved charge (edge case b): if it
  // came within minSep of another, push it back out along the separation axis.
  function clampSeparation(px, movedIdx) {
    for (let j = 0; j < px.length; j++) {
      if (j === movedIdx) continue;
      let dx = px[movedIdx][0] - px[j][0];
      let dy = px[movedIdx][1] - px[j][1];
      let d = Math.hypot(dx, dy);
      if (d < cfg.minSep) {
        if (d < 1e-6) { dx = cfg.minSep; dy = 0; d = cfg.minSep; }
        const k = cfg.minSep / d;
        px[movedIdx][0] = px[j][0] + dx * k;
        px[movedIdx][1] = px[j][1] + dy * k;
      }
    }
    return px;
  }

  function computeFrame() {
    const { w, h } = measure();
    if (!w || !h) { frame = null; return; }
    const cpx = chargesPx();
    frame = { cpx, scene: computeScene(cpx, { w, h, fieldStep: cfg.fieldStep, r0: cfg.r0 }) };
  }

  function drawArrowHead(x, y, ux, uy, size, dpr) {
    ctx.beginPath();
    ctx.moveTo((x - size * ux + size * 0.58 * uy) * dpr, (y - size * uy - size * 0.58 * ux) * dpr);
    ctx.lineTo(x * dpr, y * dpr);
    ctx.lineTo((x - size * ux - size * 0.58 * uy) * dpr, (y - size * uy + size * 0.58 * ux) * dpr);
    ctx.stroke();
  }

  // Paint the stored frame at draw fraction `p` (1 = full). Equipotentials first
  // (dashed, no arrows), then field lines + midline arrows, then charge discs.
  function paint(p) {
    if (!frame) return;
    const { w, h, dpr } = dims;
    const t = tokens();
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    ctx.strokeStyle = t.equip;
    ctx.globalAlpha = 0.55 * p;
    ctx.lineWidth = 1 * dpr;
    ctx.setLineDash([5 * dpr, 5 * dpr]);
    for (const eq of frame.scene.equips) {   // eq = { level, pts } (tagged shape)
      const pts = eq.pts;
      if (pts.length < 2) continue;
      ctx.beginPath();
      ctx.moveTo(pts[0][0] * dpr, pts[0][1] * dpr);
      for (let k = 1; k < pts.length; k++) ctx.lineTo(pts[k][0] * dpr, pts[k][1] * dpr);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    ctx.strokeStyle = t.accent;
    ctx.globalAlpha = 0.7;
    for (const l of frame.scene.lines) {
      const pts = l.pts;
      const n = Math.max(2, Math.floor(pts.length * p));
      ctx.lineWidth = 1 * dpr;
      ctx.beginPath();
      ctx.moveTo(pts[0][0] * dpr, pts[0][1] * dpr);
      for (let k = 1; k < n; k++) ctx.lineTo(pts[k][0] * dpr, pts[k][1] * dpr);
      ctx.stroke();
      if (n > l.arrow.idx) {
        ctx.lineWidth = 1.4 * dpr;
        drawArrowHead(l.arrow.x, l.arrow.y, l.arrow.ux, l.arrow.uy, 6, dpr);
      }
    }
    ctx.globalAlpha = 1;

    for (let i = 0; i < frame.cpx.length; i++) {
      const [cx, cy, q] = frame.cpx[i];
      ctx.beginPath();
      ctx.arc(cx * dpr, cy * dpr, cfg.r0 * dpr, 0, 2 * Math.PI);
      ctx.fillStyle = t.bg;
      ctx.fill();
      ctx.lineWidth = (i === selected ? 2.4 : 1.5) * dpr;
      ctx.strokeStyle = t.ink;
      ctx.stroke();
      ctx.fillStyle = t.ink;
      ctx.font = '600 ' + (10.5 * dpr) + 'px ' + (
        getComputedStyle(document.documentElement).getPropertyValue('--mono').trim()
        || 'ui-monospace, Menlo, monospace');
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText((q > 0 ? '+' : '−') + Math.abs(q), cx * dpr, cy * dpr + 0.5 * dpr);
    }
  }

  // Full static render (recompute + paint(1)). Used for drag, ratio, reset,
  // resize, theme change, and the reduced-motion initial render.
  function renderStatic() {
    computeFrame();
    paint(1);
  }

  // Animated draw-in (initial load only, non-reduced). Recompute once, then
  // sweep the draw fraction 0 -> 1 with a smoothstep over drawInMs.
  function renderAnimated() {
    computeFrame();
    if (!frame) return;
    let t0 = null;
    function tick(ts) {
      if (t0 === null) t0 = ts;
      const p = Math.min(1, (ts - t0) / cfg.drawInMs);
      paint(p * p * (3 - 2 * p));
      if (p < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  // Retrace throttled to one animation frame — many pointermove events collapse
  // into a single recompute+paint per frame (keeps drag smooth, targets the
  // measured ~1 ms retrace budget).
  function scheduleRetrace() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; renderStatic(); });
  }

  // ---- pointer / drag (edge cases c, d) -----------------------------------
  // Map a pointer event's CSS-pixel position through the canvas box into scene
  // coordinates (scene == CSS pixels; drawing scales by dpr internally).
  function pointerScene(ev) {
    const rect = canvas.getBoundingClientRect();
    const sx = (ev.clientX - rect.left) * (dims.w / (rect.width || dims.w || 1));
    const sy = (ev.clientY - rect.top) * (dims.h / (rect.height || dims.h || 1));
    return [sx, sy];
  }
  function hitCharge(sx, sy) {
    const cpx = chargesPx();
    const hitR = Math.max(cfg.r0 + cfg.hitPad, 22); // >= 44 px diameter target
    for (let i = 0; i < cpx.length; i++) {
      const dx = sx - cpx[i][0], dy = sy - cpx[i][1];
      if (dx * dx + dy * dy <= hitR * hitR) return i;
    }
    return -1;
  }
  function dismissHint() {
    if (hinted || !cfg.hintEl) { hinted = true; return; }
    hinted = true;
    cfg.hintEl.setAttribute('data-dismissed', 'true');
  }

  canvas.addEventListener('pointerdown', (ev) => {
    measure();
    const [sx, sy] = pointerScene(ev);
    const i = hitCharge(sx, sy);
    if (i < 0) return;               // not on a charge -> let the page scroll
    ev.preventDefault();
    dragging = i;
    selected = i;
    dismissHint();
    try { canvas.setPointerCapture(ev.pointerId); } catch (e) { /* noop */ }
    renderStatic();
  });
  canvas.addEventListener('pointermove', (ev) => {
    if (dragging < 0) return;
    ev.preventDefault();
    const [sx, sy] = pointerScene(ev);
    const cpx = chargesPx();
    cpx[dragging][0] = sx;
    cpx[dragging][1] = sy;
    clampSeparation(cpx, dragging);
    // clamp inside the canvas so a charge can't be dragged fully off-screen
    cpx[dragging][0] = Math.max(cfg.r0, Math.min(dims.w - cfg.r0, cpx[dragging][0]));
    cpx[dragging][1] = Math.max(cfg.r0, Math.min(dims.h - cfg.r0, cpx[dragging][1]));
    charges[dragging][0] = cpx[dragging][0] / dims.w;
    charges[dragging][1] = cpx[dragging][1] / dims.h;
    scheduleRetrace();
  });
  const endDrag = (ev) => {
    if (dragging < 0) return;
    dragging = -1;
    try { canvas.releasePointerCapture(ev.pointerId); } catch (e) { /* noop */ }
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  // ---- keyboard (accessibility) -------------------------------------------
  canvas.setAttribute('tabindex', '0');
  canvas.addEventListener('keydown', (ev) => {
    const NUDGE = (ev.shiftKey ? 12 : 4);
    let handled = true;
    const cpx = chargesPx();
    if (ev.key === 'ArrowLeft') cpx[selected][0] -= NUDGE;
    else if (ev.key === 'ArrowRight') cpx[selected][0] += NUDGE;
    else if (ev.key === 'ArrowUp') cpx[selected][1] -= NUDGE;
    else if (ev.key === 'ArrowDown') cpx[selected][1] += NUDGE;
    else if (ev.key === ' ' || ev.key === 'Enter') { selected = (selected + 1) % cpx.length; handled = true; }
    else handled = false;
    if (!handled) return;
    ev.preventDefault();
    dismissHint();
    clampSeparation(cpx, selected);
    cpx[selected][0] = Math.max(cfg.r0, Math.min(dims.w - cfg.r0, cpx[selected][0]));
    cpx[selected][1] = Math.max(cfg.r0, Math.min(dims.h - cfg.r0, cpx[selected][1]));
    charges[selected][0] = cpx[selected][0] / dims.w;
    charges[selected][1] = cpx[selected][1] / dims.h;
    renderStatic();
  });

  // ---- ratio + reset controls ---------------------------------------------
  function applyRatio(q0, q1) {
    charges[0][2] = q0;
    charges[1][2] = q1;
    selected = sourceIndex(charges);
    updateAria();
    renderStatic();
  }
  function reset() {
    charges = DEFAULT_CHARGES.map((c) => c.slice());
    selected = sourceIndex(charges);
    updateAria();
    renderStatic();
  }
  function updateAria() {
    const q0 = charges[0][2], q1 = charges[1][2];
    canvas.setAttribute('aria-label',
      `Electric field lines and dashed equipotential curves at equal potential `
      + `steps from a two-charge system, charges plus ${Math.abs(q0)} and minus `
      + `${Math.abs(q1)}, traced numerically by this page, with midline direction `
      + `arrows. Because the potential step between adjacent dashed curves is `
      + `constant, their spacing shows the field strength. Drag either charge, or `
      + `use the charge-ratio buttons, to recompute.`);
    if (cfg.controlsEl) {
      const key = `${q0},${q1}`;
      cfg.controlsEl.querySelectorAll('[data-ratio]').forEach((b) => {
        b.setAttribute('aria-pressed', b.getAttribute('data-ratio') === key ? 'true' : 'false');
      });
    }
  }
  if (cfg.controlsEl) {
    cfg.controlsEl.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-ratio], [data-reset]');
      if (!btn) return;
      if (btn.hasAttribute('data-reset')) { reset(); return; }
      const [q0, q1] = btn.getAttribute('data-ratio').split(',').map(Number);
      applyRatio(q0, q1);
    });
  }

  // ---- resize (edge case d) + theme ---------------------------------------
  if (typeof ResizeObserver === 'function') {
    let roPending = false;
    const ro = new ResizeObserver(() => {
      if (roPending) return;
      roPending = true;
      requestAnimationFrame(() => { roPending = false; renderStatic(); });
    });
    ro.observe(canvas);
  } else if (typeof window !== 'undefined') {
    window.addEventListener('resize', renderStatic);
  }
  if (typeof matchMedia === 'function') {
    const mq = matchMedia('(prefers-color-scheme: dark)');
    (mq.addEventListener ? mq.addEventListener.bind(mq, 'change')
      : mq.addListener.bind(mq))(renderStatic);
  }
  if (typeof MutationObserver === 'function') {
    new MutationObserver(renderStatic).observe(document.documentElement,
      { attributes: true, attributeFilter: ['data-theme'] });
  }

  updateAria();
  if (reduced) renderStatic(); else renderAnimated();

  // Test / debug hook — the Playwright interaction test reads charge positions
  // and drives ratio/reset through this, so the browser path is asserted too.
  const api = {
    renderStatic,
    getState: () => ({
      w: dims.w, h: dims.h, dpr: dims.dpr,
      charges: charges.map((c) => c.slice()),
      chargesPx: chargesPx(),
      sourceIdx: selected,
      lineCount: frame ? frame.scene.lines.length : 0,
      terminated: frame ? frame.scene.terminated : 0,
      escaped: frame ? frame.scene.escaped : 0,
      equipCount: frame ? frame.scene.equips.length : 0,
    }),
    applyRatio,
    reset,
  };
  canvas.__fieldlab = api;
  if (typeof window !== 'undefined') window.__fieldlab = api;
  return api;
}
