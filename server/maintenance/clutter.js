// The clutter level: how full the archive is, 0..1, from what the next run
// would really free. It reaches 1 at FULL_BYTES or at FULL_ITEMS, whichever
// comes first.

const MiB = 1024 * 1024;

const FULL_BYTES = { dev: 64 * MiB, production: 16 * MiB };
const FULL_ITEMS = 1500;

const fullBytesFor = (dev) => (dev ? FULL_BYTES.dev : FULL_BYTES.production);

const finite = (value) => (Number.isFinite(value) && value > 0 ? value : 0);

/** level = min(1, max(bytes / fullBytes, items / 1500)), rounded to 1e-4. */
const clutterLevel = ({ bytes, items }, fullBytes) => {
  const full = finite(fullBytes) || FULL_BYTES.dev;
  const raw = Math.max(finite(bytes) / full, finite(items) / FULL_ITEMS);
  return Math.round(Math.min(1, raw) * 10_000) / 10_000;
};

/**
 * The clutter block of the status, from per-target scan results.
 * @param {Array<{id: string, bytes: number, items: number}>} byTarget
 */
const summarizeClutter = (byTarget, dev) => {
  let bytes = 0;
  let items = 0;
  for (const entry of byTarget) {
    bytes += finite(entry.bytes);
    items += finite(entry.items);
  }
  const fullAtBytes = fullBytesFor(dev);
  return {
    level: clutterLevel({ bytes, items }, fullAtBytes),
    reclaimableBytes: bytes,
    reclaimableItems: items,
    fullAtBytes,
    byTarget: byTarget.map((entry) => ({ id: entry.id, bytes: finite(entry.bytes), items: finite(entry.items) })),
  };
};

module.exports = { FULL_BYTES, FULL_ITEMS, clutterLevel, fullBytesFor, summarizeClutter };
