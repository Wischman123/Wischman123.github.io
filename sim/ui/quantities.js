// ui/quantities.js
//
// The single library home for "what scalar quantities can be read off a
// completed run, and how." Both the predict panel (sim/ui/predict.js) and
// the future lab notebook resolve quantities through THIS module, so a
// quantity added once shows up on both surfaces.
//
// CONTRACT — FINAL-STATE SCALARS ONLY.
//   resolveQuantityFor(view, body_id, quantity) resolves a quantity from a
//   SINGLE final `view` snapshot (read at onSimComplete via
//   readAllQuantities). It can therefore only express quantities that are a
//   scalar function of ONE end-of-run state: view in, number|null out.
//
// SCOPE-2 EXTENSION SEAM (deferred — do NOT bolt onto this seam).
//   Period and amplitude are NOT scalar functions of one final snapshot —
//   they need peak-detection over the WHOLE run's time-series, which a lone
//   final snapshot cannot supply. A maintainer adding period/amplitude MUST
//   NOT assume the existing (view) -> number|null seam absorbs them. Scope-2
//   will require either a time-series-aware variant
//   (e.g. resolveSeriesQuantityFor(samples, body_id, quantity)) fed a
//   buffered sample stream, or samples-buffering capture DURING the run.
//
// NULL CONTRACT (load-bearing).
//   Every read is coalesced to `null` at the PRODUCER boundary (`?? null`).
//   `view.energy?.total` evaluates to `undefined` (not `null`) when the run
//   has no energy tracker (`energy: null`, runner.js), and a body may lack a
//   field on a bare snapshot. A strict `=== null` consumer downstream
//   (render-blank, scatter-skip, toCSV) must never see `undefined`, so this
//   module guarantees no `undefined` ever escapes the resolver.

// `scope`:
//   'body'   — per-body quantity; needs body_id (position, velocity, speed, K).
//   'system' — whole-system quantity; body_id is IGNORED and the value is
//              read once (energy.total). Prevents the multi-body category slip
//              where a system total is falsely repeated under every body.
export const QUANTITIES = [
  { value: 'position.x',   label: 'final position x (m)',   unit: 'm',   scope: 'body' },
  { value: 'position.y',   label: 'final position y (m)',   unit: 'm',   scope: 'body' },
  { value: 'velocity.x',   label: 'final velocity x (m/s)', unit: 'm/s', scope: 'body' },
  { value: 'velocity.y',   label: 'final velocity y (m/s)', unit: 'm/s', scope: 'body' },
  { value: 'speed',        label: 'final speed (m/s)',      unit: 'm/s', scope: 'body' },
  { value: 'energy.K',     label: 'final K (J)',            unit: 'J',   scope: 'body' },
  { value: 'energy.total', label: 'final total energy (J)', unit: 'J',   scope: 'system' }
];

// Pure resolver: view in, number|null out. No DOM, no side effects — headless
// testable. Every branch coalesces a missing read to `null` at the boundary.
export function resolveQuantityFor(view, body_id, quantity) {
  // System-scope quantity: ignore body_id, read the whole-system value once.
  if (quantity === 'energy.total') return view?.energy?.total ?? null;

  // Per-body quantities from here down.
  const body = view?.bodies?.find((b) => b.id === body_id);
  if (!body) return null;

  if (quantity === 'position.x') return body.position?.x ?? null;
  if (quantity === 'position.y') return body.position?.y ?? null;
  if (quantity === 'velocity.x') return body.velocity?.x ?? null;
  if (quantity === 'velocity.y') return body.velocity?.y ?? null;
  if (quantity === 'speed') {
    if (!body.velocity) return null;
    return Math.hypot(body.velocity.x, body.velocity.y) ?? null;
  }
  if (quantity === 'energy.K') return body.kineticEnergy?.() ?? null;
  return null;
}

// Predict-facing wrapper: unpacks the prediction object's `.body_id` /
// `.quantity` and delegates to the pure core. Kept separate so the core is
// not entangled with predict's data shape. `predict.js` re-imports this and
// deletes its local copy, so predict's behavior is byte-identical.
export function resolveQuantity(view, prediction) {
  return resolveQuantityFor(view, prediction.body_id, prediction.quantity);
}

// Read every QUANTITIES entry for one body from a single final view.
// Returns { [q.value]: number|null } — exactly one key per QUANTITIES entry.
// System-scope entries ignore body_id (see resolveQuantityFor).
export function readAllQuantities(view, body_id) {
  const out = {};
  for (const q of QUANTITIES) {
    out[q.value] = resolveQuantityFor(view, body_id, q.value);
  }
  return out;
}

export const NAME = 'quantities';
