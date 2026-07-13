// field_tracer.js — the showcase wing's Coulomb field-line tracer (T1-a).
//
// Extracted from the live index hero (Fig. 1's inline tracer) so the new
// systems.html "Field lab, live" exhibit can trace field lines from
// reader-dragged charges IN THE BROWSER. The tracing core is a faithful port of
// the platform's reference implementation, physics/lib/charges.py's
// `compute_field_line` + `_efield_direction`, so the exhibit's live math is
// PINNED to the library, not a look-alike:
//
//   * site/tools/test_field_tracer.py drives THIS module (via a node harness)
//     from the parameters recorded in the charges.py-generated fixture
//     (site/tools/fixtures/field_tracer_fixtures.json) and asserts the polylines
//     match within tolerance. The port therefore mirrors charges.py operation
//     for operation (multiplication-based r2, r2*sqrt(r2), sqrt(ex²+ey²) — NOT
//     Math.hypot, which would differ in the last bits) so two correct Euler
//     integrations of the same field cannot diverge.
//
// SELF-CONTAINMENT: no imports, no network. The pure functions run under
// `node` (the test harness) and in the browser; the DOM field-lab (initFieldLab)
// only touches `document` when CALLED, so importing this module in node is safe.
//
// The frozen-index exception (wing plan §5): the live index KEEPS its own inline
// tracer; this file serves ONLY systems.html. The QA gate's field-tracer drift
// check compares the two so a divergence is flagged rather than silently shipped.

// ---------------------------------------------------------------------------
// Pure tracing core (mirrors lib/charges.py). `charges` is [[cx,cy,q], ...].
// ---------------------------------------------------------------------------

// Unit E-field direction at (x, y). Screen coords (y down). Returns
// [ex_hat, ey_hat] or null when too close to any charge / field ~0.
// Mirrors charges.py::_efield_direction (near-charge bail r2 < near_bail²).
export function efieldDir(x, y, charges, nearBail) {
  const bail2 = nearBail * nearBail;
  let ex = 0.0;
  let ey = 0.0;
  for (let i = 0; i < charges.length; i++) {
    const cx = charges[i][0];
    const cy = charges[i][1];
    const q = charges[i][2];
    const dx = x - cx;
    const dy = y - cy;
    const r2 = dx * dx + dy * dy;
    if (r2 < bail2) return null;
    const r3 = r2 * Math.sqrt(r2);
    ex += q * dx / r3;
    ey += q * dy / r3;
  }
  const mag = Math.sqrt(ex * ex + ey * ey);
  if (mag < 1e-12) return null;
  return [ex / mag, ey / mag];
}

// Integrate one field line from (startX, startY) with fixed-step Euler along the
// unit E direction. Mirrors charges.py::compute_field_line exactly:
// stop at a negative charge (within stopRadius) or on exiting bounds.
// `opts`: { step, maxSteps, stopRadius, nearBail, bounds:[xmin,ymin,xmax,ymax] }.
export function traceFieldLine(charges, startX, startY, opts) {
  const step = opts.step;
  const maxSteps = opts.maxSteps;
  const stopRadius = opts.stopRadius;
  const nearBail = opts.nearBail;
  const bounds = opts.bounds || null;

  const points = [[startX, startY]];
  let x = startX;
  let y = startY;

  for (let s = 0; s < maxSteps; s++) {
    const dir = efieldDir(x, y, charges, nearBail);
    if (dir === null) break;
    x += step * dir[0];
    y += step * dir[1];
    points.push([x, y]);

    // Stop at negative charges (sqrt of squared-difference — NOT hypot — to
    // bit-match charges.py's termination decision).
    for (let i = 0; i < charges.length; i++) {
      if (charges[i][2] < 0) {
        const r = Math.sqrt((x - charges[i][0]) ** 2 + (y - charges[i][1]) ** 2);
        if (r <= stopRadius) return points;
      }
    }
    // Stop at the diagram boundary.
    if (bounds) {
      const [xmin, ymin, xmax, ymax] = bounds;
      if (x < xmin || x > xmax || y < ymin || y > ymax) return points;
    }
  }
  return points;
}

// Seed n_lines starting points uniformly around a source charge's surface, then
// trace each. Mirrors charges.py::compute_charge_field_lines seeding (screen
// coords: subtract sin). `cfg`: { charges, sourceIdx, nLines, chargeRadius,
// startAngleDeg, step, maxSteps, stopRadius, nearBail, bounds }.
export function traceFieldLines(cfg) {
  const src = cfg.charges[cfg.sourceIdx];
  const cx = src[0];
  const cy = src[1];
  const r = cfg.chargeRadius;
  const a0 = (cfg.startAngleDeg * Math.PI) / 180;
  const opts = {
    step: cfg.step, maxSteps: cfg.maxSteps, stopRadius: cfg.stopRadius,
    nearBail: cfg.nearBail, bounds: cfg.bounds,
  };
  const lines = [];
  for (let i = 0; i < cfg.nLines; i++) {
    const a = a0 + (2 * Math.PI * i) / cfg.nLines;
    const sx = cx + r * Math.cos(a);
    const sy = cy - r * Math.sin(a); // screen: y down
    lines.push(traceFieldLine(cfg.charges, sx, sy, opts));
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Browser field-lab (T1-a). Drag charges + arrow-key nudge → the field
// re-traces. Click empty space (or the "Add a − charge" button) to place a new
// negative charge; select one and press Delete to remove an added charge. No
// autonomous motion (idles on its rendered figure until the reader interacts).
// No NaN at coincident drag: a minimum-separation clamp keeps charges apart, and
// the near-charge bail already guards the integrator. `document`/`window` are
// touched ONLY here, so node import is safe.
// ---------------------------------------------------------------------------
export function initFieldLab(canvas, config) {
  if (!canvas || !canvas.getContext) return null;
  const ctx = canvas.getContext('2d');
  const cfg = Object.assign({
    charges: [[0.30, 0.52, 2], [0.70, 0.52, -1]], // fractional positions
    nLines: 16,
    chargeRadius: 12,
    startAngleDeg: 180 / 16,
    step: 1.5,
    maxSteps: 1200,
    stopRadius: 6,
    nearBail: 2.0,
    minSeparation: 44,            // px clamp so charges never coincide (no NaN)
    arrowSize: 10,                // px arrowhead half-length (render-only; 2x the original 5)
    maxTotalLines: 120,           // safety cap on total seeded field lines (perf)
    lineColor: '#A15A26',
    inkColor: '#1E2B33',
    bgColor: '#FBF7F0',
  }, config || {});

  // The original charges are SEED charges: they can be dragged but not deleted,
  // so the exhibit can never be emptied of its + source or its − sink.
  const seedCount = cfg.charges.length;

  let selected = 0;             // keyboard-focused charge index
  let dragging = -1;
  let pendingAdd = null;        // {x,y} when a pointerdown missed all charges
  let dragStart = null;         // {x,y} pointerdown point (tap-vs-drag discrimination)
  let tapCandidate = -1;        // charge tapped (not yet dragged) → open its editor on release
  let editor = null;            // {wrap, range, label} per-charge q slider overlay
  let editorIdx = -1;           // charge the editor edits (-1 = hidden)
  let lastW = 0;                // last CSS width/height chargesPx is expressed in
  let lastH = 0;

  // Read the page's palette, CANONICAL name first and the COMPAT name as the
  // fallback — the same one-way chain the shared site-rail component uses.
  //
  // WHY BOTH. This one module now has two hosts with two different token sets:
  //   * public/systems.html links site.css, which declares ONLY the compat names
  //     (--accent / --ink / --bg). The canonical lookups below return '' there and
  //     the compat values win — so that page renders EXACTLY as it did before.
  //   * deep/sims.html inlines base.html.j2's palette, which declares ONLY the
  //     canonical names (--core / --text / --paper). Reading only --accent there
  //     would return '' and silently fall through to the hardcoded warm literals —
  //     a rust-and-cream field lab dropped into a cool blue page, and unreadable in
  //     dark mode, with nothing logged.
  // Aliases flow canonical -> compat and never back (theme.css's cycle hazard), so
  // this order is the safe one.
  function themeColors() {
    if (typeof getComputedStyle !== 'function') return cfg;
    const s = getComputedStyle(document.documentElement);
    const pick = (...names) => {
      for (const n of names) {
        const v = (s.getPropertyValue(n) || '').trim();
        if (v) return v;
      }
      return '';
    };
    return {
      lineColor: pick('--core', '--accent') || cfg.lineColor,
      inkColor: pick('--text', '--ink') || cfg.inkColor,
      bgColor: pick('--paper', '--bg') || cfg.bgColor,
    };
  }

  // Live charge positions in px (derived from fractional cfg on first render).
  let chargesPx = null;

  function toPx(w, h) {
    chargesPx = cfg.charges.map((c) => [c[0] * w, c[1] * h, c[2]]);
  }

  // Enforce the minimum-separation clamp: if a move brings two charges within
  // minSeparation, push the moved one back along the separation axis. This is
  // the "no NaN at coincident drag" guarantee — the integrator's near-bail is a
  // second line of defense, but the clamp prevents the degenerate config.
  function clampSeparation(movedIdx) {
    for (let j = 0; j < chargesPx.length; j++) {
      if (j === movedIdx) continue;
      const dx = chargesPx[movedIdx][0] - chargesPx[j][0];
      const dy = chargesPx[movedIdx][1] - chargesPx[j][1];
      let d = Math.sqrt(dx * dx + dy * dy);
      if (d < cfg.minSeparation) {
        if (d < 1e-6) { chargesPx[movedIdx][0] += cfg.minSeparation; d = cfg.minSeparation; }
        const k = cfg.minSeparation / d;
        chargesPx[movedIdx][0] = chargesPx[j][0] + dx * k;
        chargesPx[movedIdx][1] = chargesPx[j][1] + dy * k;
      }
    }
  }

  // A filled triangle whose tip sits at (x,y), pointing along unit dir (ux,uy).
  function drawArrowhead(x, y, ux, uy, size) {
    const a = Math.atan2(uy, ux);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x - size * Math.cos(a - 0.45), y - size * Math.sin(a - 0.45));
    ctx.lineTo(x - size * Math.cos(a + 0.45), y - size * Math.sin(a + 0.45));
    ctx.closePath();
    ctx.fill();
  }

  function render() {
    const w = canvas.clientWidth || canvas.width;
    const h = canvas.clientHeight || canvas.height;
    if (!w || !h) return;
    const dpr = Math.min((typeof window !== 'undefined' && window.devicePixelRatio) || 1, 2);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    if (!chargesPx) {
      toPx(w, h);
    } else if ((w !== lastW || h !== lastH) && lastW > 0 && lastH > 0) {
      // Resize: scale existing charges (drags AND added ones) into the new box,
      // rather than re-deriving from the seed fractions and losing them.
      const sx = w / lastW;
      const sy = h / lastH;
      for (const c of chargesPx) { c[0] *= sx; c[1] *= sy; }
    }
    lastW = w;
    lastH = h;
    const t = themeColors();
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Seed field lines from EVERY positive charge, count proportional to its
    // magnitude — the library's convention (lib/charges.py scales termination
    // counts by |q|/source_q). linesPerUnit is set so the default +2 seed emits
    // cfg.nLines (16) lines, leaving the default scene visually unchanged. A
    // charge at 0 or negative emits none (field lines originate on positives).
    const baseCharges = chargesPx.map((c) => [c[0], c[1], c[2]]);
    const linesPerUnit = cfg.nLines / 2;
    const lines = [];
    let seeded = 0;
    for (let si = 0; si < baseCharges.length; si++) {
      const q = baseCharges[si][2];
      if (q <= 0) continue;
      let nl = Math.max(3, Math.round(linesPerUnit * q));
      if (seeded + nl > cfg.maxTotalLines) nl = cfg.maxTotalLines - seeded;
      if (nl <= 0) break;
      seeded += nl;
      const sub = traceFieldLines({
        charges: baseCharges, sourceIdx: si, nLines: nl,
        chargeRadius: cfg.chargeRadius, startAngleDeg: cfg.startAngleDeg,
        step: cfg.step, maxSteps: cfg.maxSteps, stopRadius: cfg.stopRadius,
        nearBail: cfg.nearBail, bounds: [-40, -40, w + 40, h + 40],
      });
      for (const ln of sub) lines.push(ln);
    }

    ctx.lineWidth = 1.2 * dpr;
    ctx.strokeStyle = t.lineColor;
    ctx.fillStyle = t.lineColor;
    for (const pts of lines) {
      ctx.beginPath();
      for (let i = 0; i < pts.length; i++) {
        const X = pts[i][0] * dpr;
        const Y = pts[i][1] * dpr;
        if (i === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y);
      }
      ctx.stroke();
      // Directional arrowhead at the line's midpoint segment (render-only; the
      // pinned fixture test compares point data, not pixels). Skip stubby lines.
      if (pts.length >= 6) {
        const m = Math.floor(pts.length / 2);
        let dx = pts[m][0] - pts[m - 1][0];
        let dy = pts[m][1] - pts[m - 1][1];
        const L = Math.sqrt(dx * dx + dy * dy) || 1;
        drawArrowhead(pts[m][0] * dpr, pts[m][1] * dpr, dx / L, dy / L, cfg.arrowSize * dpr);
      }
    }

    // Charge discs + labels.
    for (let i = 0; i < chargesPx.length; i++) {
      const [cx, cy, q] = chargesPx[i];
      ctx.beginPath();
      ctx.arc(cx * dpr, cy * dpr, cfg.chargeRadius * dpr, 0, 2 * Math.PI);
      ctx.fillStyle = t.bgColor;
      ctx.fill();
      ctx.lineWidth = (i === selected ? 2.5 : 1.5) * dpr;
      ctx.strokeStyle = t.inkColor;
      ctx.stroke();
      ctx.fillStyle = t.inkColor;
      ctx.font = '600 ' + 10.5 * dpr + 'px ui-monospace, Menlo, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(qLabel(q), cx * dpr, cy * dpr);
    }

    // Keep the per-charge q editor anchored to its charge (resize/scale/drag).
    if (editorIdx >= 0) positionEditor();
  }

  // Add a charge (sign < 0 → negative). px/py optional: omitted (the button
  // path) drops it near top-center, where clampSeparation nudges it clear.
  function addCharge(sign, px, py) {
    if (!chargesPx) render();
    if (!chargesPx) return -1;
    const w = canvas.clientWidth || canvas.width;
    const h = canvas.clientHeight || canvas.height;
    const x = (typeof px === 'number') ? px : w * 0.5;
    const y = (typeof py === 'number') ? py : h * 0.28;
    chargesPx.push([x, y, sign < 0 ? -1 : 1]);
    const idx = chargesPx.length - 1;
    clampSeparation(idx);
    selected = idx;
    render();
    return idx;
  }

  // Remove the selected charge, but never a seed charge (protects the + source
  // and the − sink). Returns true if something was removed.
  function removeSelected() {
    if (!chargesPx || selected < seedCount) return false;
    chargesPx.splice(selected, 1);
    if (selected >= chargesPx.length) selected = chargesPx.length - 1;
    hideEditor();
    render();
    return true;
  }

  // --- per-charge q editor (item 3) -----------------------------------------
  // A small <input type=range> that appears next to a TAPPED charge and sets its
  // charge to an integer in [-3, +3]; keyboard-operable for free. Overlaid on the
  // .fieldlab box (position:relative). Created lazily so a node import never
  // touches the DOM. Function declarations below are hoisted, so render() (which
  // runs later) can call qLabel()/positionEditor().
  const Q_MIN = -3;
  const Q_MAX = 3;
  function qLabel(q) { return q > 0 ? '+' + q : (q < 0 ? '−' + Math.abs(q) : '0'); }

  function ensureEditor() {
    if (editor) return editor;
    const parent = canvas.parentElement;
    if (!parent || typeof document === 'undefined') return null;
    const wrap = document.createElement('div');
    wrap.className = 'fieldlab-charge-editor';
    wrap.style.position = 'absolute';
    wrap.style.display = 'none';
    const label = document.createElement('span');
    label.className = 'fieldlab-charge-editor__val';
    const range = document.createElement('input');
    range.type = 'range';
    range.min = String(Q_MIN);
    range.max = String(Q_MAX);
    range.step = '1';
    range.className = 'fieldlab-charge-editor__range';
    range.setAttribute('aria-label', 'Charge value, minus three to plus three');
    range.addEventListener('input', () => {
      if (editorIdx < 0 || !chargesPx[editorIdx]) return;
      const q = Math.max(Q_MIN, Math.min(Q_MAX, parseInt(range.value, 10) || 0));
      chargesPx[editorIdx][2] = q;
      selected = editorIdx;
      label.textContent = 'q = ' + qLabel(q);
      render();
    });
    wrap.appendChild(label);
    wrap.appendChild(range);
    parent.appendChild(wrap);
    editor = { wrap, range, label };
    return editor;
  }

  function positionEditor() {
    if (!editor || editorIdx < 0 || !chargesPx[editorIdx]) return;
    const cx = chargesPx[editorIdx][0];
    const cy = chargesPx[editorIdx][1];
    const ox = canvas.offsetLeft;
    const oy = canvas.offsetTop;
    const boxW = canvas.clientWidth || canvas.width;
    const boxH = canvas.clientHeight || canvas.height;
    const ew = editor.wrap.offsetWidth || 140;
    const eh = editor.wrap.offsetHeight || 34;
    let left = Math.max(4, Math.min(boxW - ew - 4, cx - ew / 2));
    let top = cy - cfg.chargeRadius - eh - 8;        // prefer above the charge
    if (top < 4) top = cy + cfg.chargeRadius + 8;     // flip below near the top edge
    top = Math.max(4, Math.min(boxH - eh - 4, top));
    editor.wrap.style.left = (ox + left) + 'px';
    editor.wrap.style.top = (oy + top) + 'px';
  }

  function showEditor(idx) {
    const e = ensureEditor();
    if (!e || !chargesPx[idx]) return;
    editorIdx = idx;
    selected = idx;
    e.range.value = String(chargesPx[idx][2]);
    e.label.textContent = 'q = ' + qLabel(chargesPx[idx][2]);
    e.wrap.style.display = 'flex';
    positionEditor();
  }

  function hideEditor() {
    editorIdx = -1;
    if (editor) editor.wrap.style.display = 'none';
  }

  // Keyboard: +/- adjust the selected charge; keep an open editor in sync.
  function nudgeCharge(delta) {
    if (!chargesPx || !chargesPx[selected]) return;
    const q = Math.max(Q_MIN, Math.min(Q_MAX, chargesPx[selected][2] + delta));
    chargesPx[selected][2] = q;
    if (editorIdx === selected && editor) {
      editor.range.value = String(q);
      editor.label.textContent = 'q = ' + qLabel(q);
    }
  }

  function pointerPx(ev) {
    const rect = canvas.getBoundingClientRect();
    return [ev.clientX - rect.left, ev.clientY - rect.top];
  }
  function hit(px, py) {
    for (let i = 0; i < chargesPx.length; i++) {
      const dx = px - chargesPx[i][0];
      const dy = py - chargesPx[i][1];
      if (dx * dx + dy * dy <= (cfg.chargeRadius + 8) ** 2) return i;
    }
    return -1;
  }

  canvas.addEventListener('pointerdown', (ev) => {
    if (!chargesPx) return;
    const [px, py] = pointerPx(ev);
    const i = hit(px, py);
    if (i < 0) { pendingAdd = { x: px, y: py }; return; } // candidate tap-to-add
    pendingAdd = null;
    dragging = i;
    selected = i;
    dragStart = { x: px, y: py };
    tapCandidate = i;               // opens this charge's editor unless it becomes a drag
    canvas.setPointerCapture && canvas.setPointerCapture(ev.pointerId);
    render();
  });
  canvas.addEventListener('pointermove', (ev) => {
    const [px, py] = pointerPx(ev);
    if (dragging >= 0) {
      if (dragStart) {
        const mx = px - dragStart.x;
        const my = py - dragStart.y;
        if (mx * mx + my * my > 36) tapCandidate = -1; // moved >6px → a drag, not a tap
      }
      chargesPx[dragging][0] = px;
      chargesPx[dragging][1] = py;
      clampSeparation(dragging);
      render();                        // render() re-anchors an open editor
      return;
    }
    if (pendingAdd) {
      const dx = px - pendingAdd.x;
      const dy = py - pendingAdd.y;
      if (dx * dx + dy * dy > 36) pendingAdd = null; // moved >6px → a pan, not a tap
    }
  });
  const endDrag = (ev) => {
    if (dragging >= 0) {
      const tapped = tapCandidate === dragging ? dragging : -1;
      dragging = -1;
      dragStart = null;
      tapCandidate = -1;
      try { canvas.releasePointerCapture && canvas.releasePointerCapture(ev.pointerId); } catch (e) { /* noop */ }
      if (tapped >= 0) showEditor(tapped); // a tap (not a drag) → open its q slider
      return;
    }
    if (pendingAdd) {
      const idx = addCharge(-1, pendingAdd.x, pendingAdd.y); // click empty space → new − charge
      pendingAdd = null;
      if (idx >= 0) showEditor(idx);       // open the new charge's slider immediately
    }
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', (ev) => {
    pendingAdd = null;
    dragStart = null;
    tapCandidate = -1;
    if (dragging >= 0) {
      dragging = -1;
      try { canvas.releasePointerCapture && canvas.releasePointerCapture(ev.pointerId); } catch (e) { /* noop */ }
    }
  });

  // Keyboard path: Tab to focus, arrow keys nudge the selected charge, Delete
  // removes a reader-added charge; the field re-traces on every keystroke.
  canvas.setAttribute('tabindex', '0');
  canvas.addEventListener('keydown', (ev) => {
    if (!chargesPx) return;
    const NUDGE = ev.shiftKey ? 12 : 4;
    let handled = true;
    if (ev.key === 'ArrowLeft') chargesPx[selected][0] -= NUDGE;
    else if (ev.key === 'ArrowRight') chargesPx[selected][0] += NUDGE;
    else if (ev.key === 'ArrowUp') chargesPx[selected][1] -= NUDGE;
    else if (ev.key === 'ArrowDown') chargesPx[selected][1] += NUDGE;
    else if (ev.key === 'Tab') { selected = (selected + 1) % chargesPx.length; if (editorIdx >= 0) showEditor(selected); }
    else if (ev.key === '+' || ev.key === '=') { nudgeCharge(1); }
    else if (ev.key === '-' || ev.key === '_') { nudgeCharge(-1); }
    else if (ev.key === 'Escape') { hideEditor(); }
    else if (ev.key === 'Delete' || ev.key === 'Backspace') { handled = removeSelected(); }
    else handled = false;
    if (handled) {
      ev.preventDefault();
      if (ev.key !== 'Delete' && ev.key !== 'Backspace') clampSeparation(selected);
      render();
    }
  });

  if (typeof window !== 'undefined') {
    window.addEventListener('resize', () => { render(); });
  }
  render();
  return {
    render,
    getCharges: () => chargesPx,
    addCharge,
    removeSelected,
    setCharge: (idx, q) => {
      if (!chargesPx || !chargesPx[idx]) return;
      chargesPx[idx][2] = Math.max(Q_MIN, Math.min(Q_MAX, q | 0));
      render();
    },
    editCharge: showEditor,
  };
}

export const NAME = 'field_tracer';
