// A small per-client limit for the voice routes: each call spends provider
// credits, so a runaway loop in a tab (or anyone past the access gate) must
// not be able to run up the bill. In memory, per server process.

type Window = { at: number[] };

const windows = new Map<string, Window>();
let lastSweep = 0;

const clientKey = (request: Request) =>
  request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "local";

/** True when this client made `max` or more calls of `kind` in the last `windowMs`. */
export const voiceRateLimited = (request: Request, kind: string, max: number, windowMs = 60_000) => {
  const now = Date.now();
  if (now - lastSweep > windowMs) {
    for (const [key, entry] of windows) {
      if (entry.at.every((at) => now - at >= windowMs)) windows.delete(key);
    }
    lastSweep = now;
  }
  const key = `${kind}:${clientKey(request)}`;
  const entry = windows.get(key) ?? { at: [] };
  entry.at = entry.at.filter((at) => now - at < windowMs);
  const limited = entry.at.length >= max;
  if (!limited) entry.at.push(now);
  windows.set(key, entry);
  return limited;
};
