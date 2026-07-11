// whiteboard_card.js
//
// Pure, unit-testable card-compositor library for the whiteboard export.
// It (a) decides whether any overlay is active, and (b) draws a whiteboard
// card — header (scene title) + captured canvas image + notation-only
// footer caption — onto a target 2-D context.
//
// The card draws NO student identifier, NO grade, and NO evaluative mark.
// It shows only the scene title, the captured canvas image, and a
// functional clock caption ("t = … s"). Copy is functional notation only,
// per sim/PEDAGOGY.md (anti-Kohn).
//
// All geometry is derived once, in computeCardLayout, and threaded to
// every consumer — never re-derived three inconsistent ways (calculate,
// never guess). The card width is fixed; the height is a closed formula
// of the source aspect ratio and the named band constants below.

// --- Named layout constants (concrete px; calculate, never guess) ---

// Fixed whiteboard-meeting card width in CSS px.
export const CARD_W = 1600;
// Uniform outer margin around the image body.
export const MARGIN = 40;
// Header band height (scene title).
export const HEADER_H = 88;
// Footer band height (clock caption).
export const FOOTER_H = 56;

// --- Cosmetic constants (do not affect layout closure) ---

const CARD_BG = '#ffffff';
const HEADER_BG = '#1f2933';
const HEADER_TEXT = '#ffffff';
const HEADER_FONT = 'bold 40px "Times New Roman", serif';
const FOOTER_BG = '#f0f2f5';
const FOOTER_TEXT = '#3e4c59';
const FOOTER_FONT = '28px "Times New Roman", serif';
const ELLIPSIS = '…';

// --- The decision predicate (test the decision, not the heuristic) ---

// Pure predicate over the three renderer overlay flags. main.js reads
// this.showFbd / this.showLol / this.showGraphs and passes them in.
export function anyOverlayActive({ fbd, lol, graphs } = {}) {
  return Boolean(fbd) || Boolean(lol) || Boolean(graphs);
}

// --- The single, centralized clock/notation string builder ---

// Both the PNG and print paths, and main.js, obtain the caption from
// this one function. Nothing builds the caption inline.
export function formatClockText(t) {
  return 't = ' + Number(t).toFixed(3) + ' s';
}

// --- The single geometry producer (closed formula, one place) ---

// Given a fixed card width CARD_W and a source canvas srcW x srcH,
// returns the full card geometry. The boundary guard is the FIRST line:
// an unsized source (width/height == 0) would divide by zero in
// imageDrawH and propagate a degenerate value into cardHeight, the
// offscreen canvas size, and the drawImage args — a blank card with no
// error. We throw instead.
export function computeCardLayout({ srcW, srcH } = {}) {
  if (!srcW || !srcH) throw new Error('source canvas not sized');
  const cardW = CARD_W;
  const imageDrawW = CARD_W - 2 * MARGIN;
  const imageDrawH = imageDrawW * (srcH / srcW); // preserve source aspect ratio
  const cardHeight = HEADER_H + imageDrawH + FOOTER_H + 2 * MARGIN;
  const dx = MARGIN;
  const dy = HEADER_H + MARGIN;
  return { cardW, cardHeight, imageDrawW, imageDrawH, dx, dy };
}

// --- Header title fit (horizontal closure) ---
//
// fillText does not wrap and currentScene.title has schema minLength 1
// but no maxLength, so a long title would silently clip at CARD_W. Fit
// the title to maxTitleW with a measureText-based routine: truncate with
// an ellipsis until measureText(fitted).width <= maxTitleW. The returned
// text is therefore closed against maxTitleW, not guessed.
function fitTitle(ctx, title, maxTitleW) {
  const full = String(title ?? '');
  ctx.font = HEADER_FONT;
  if (ctx.measureText(full).width <= maxTitleW) return full;
  let text = full;
  while (text.length > 0 && ctx.measureText(text + ELLIPSIS).width > maxTitleW) {
    text = text.slice(0, -1);
  }
  return text + ELLIPSIS;
}

// --- The pure drawing routine ---
//
// Reads header/image/footer geometry by calling computeCardLayout and
// DROPS any caller-supplied cardHeight (derives it), so no caller can
// pass a cardHeight inconsistent with the internally-derived imageDrawH
// that the footer band at cardHeight - FOOTER_H depends on.
export function drawWhiteboardCard(ctx, { title, sourceCanvas, clockText } = {}) {
  const { cardW, cardHeight, imageDrawW, imageDrawH, dx, dy } = computeCardLayout({
    srcW: sourceCanvas.width,
    srcH: sourceCanvas.height
  });

  // Print background.
  ctx.fillStyle = CARD_BG;
  ctx.fillRect(0, 0, cardW, cardHeight);

  // Header band + fitted scene title.
  ctx.fillStyle = HEADER_BG;
  ctx.fillRect(0, 0, cardW, HEADER_H);
  ctx.fillStyle = HEADER_TEXT;
  ctx.font = HEADER_FONT;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  const fittedTitle = fitTitle(ctx, title, cardW - 2 * MARGIN);
  ctx.fillText(fittedTitle, MARGIN, HEADER_H / 2);

  // Image body, positioned per the layout just returned.
  ctx.drawImage(sourceCanvas, dx, dy, imageDrawW, imageDrawH);

  // Footer band + clock caption (functional notation only).
  ctx.fillStyle = FOOTER_BG;
  ctx.fillRect(0, cardHeight - FOOTER_H, cardW, FOOTER_H);
  ctx.fillStyle = FOOTER_TEXT;
  ctx.font = FOOTER_FONT;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText(String(clockText ?? ''), MARGIN, cardHeight - FOOTER_H / 2);

  return { cardW, cardHeight };
}

// --- Offscreen compositor wrapper (browser-only; no node --test coverage) ---
//
// Depends on document.createElement('canvas'); verified in the P2/P3
// browser-manual step, not in node --test (no real canvas there).
export function composeWhiteboardCard({ sourceCanvas, title, clockText } = {}) {
  const { cardW, cardHeight } = computeCardLayout({
    srcW: sourceCanvas.width,
    srcH: sourceCanvas.height
  });
  const canvas = document.createElement('canvas');
  canvas.width = cardW;
  canvas.height = cardHeight;
  const ctx = canvas.getContext('2d');
  drawWhiteboardCard(ctx, { title, sourceCanvas, clockText });
  return canvas;
}

// --- PNG blob export (browser-only; no node --test coverage) ---
//
// Rejects (does not resolve with null) when toBlob yields no blob, so a
// failed export surfaces a clear error instead of a silent null.
export function cardToBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('toBlob produced an empty result'));
        return;
      }
      resolve(blob);
    }, 'image/png');
  });
}
