// render/download.js
//
// The single blob-download helper for the simulator. Extracted from
// main.js's doSnapshot() (Phase P2) so the JSON state snapshot and the
// whiteboard PNG card share ONE download path — no copy-paste of the
// createElement('a') -> a.click() -> URL.revokeObjectURL dance.
//
// Single responsibility: generic browser download plumbing. It knows
// nothing about scenes, cards, or serialization — a caller hands it a
// Blob and the filename to save it under, and this module drives the
// browser's download. Keeping it uncoupled from the card compositor
// (sim/render/whiteboard_card.js) lets any future exporter reuse it.
//
// Browser-only: depends on document.createElement, URL.createObjectURL,
// and URL.revokeObjectURL. Exercised via the P2/P3 browser-manual step
// (both download call sites), not node --test — there is no real DOM /
// object-URL implementation under node --test.

// Build a temporary <a download> targeting an object URL for the
// blob, click it to trigger the browser save, then revoke the URL and
// detach the element on the next tick (after the click has been
// dispatched) so we do not leak the object URL.
export function triggerDownload(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 0);
}
