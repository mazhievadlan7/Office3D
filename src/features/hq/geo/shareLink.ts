/**
 * Share-link serialisation for the «ГЕО» view (owner 2026-10-07).
 *
 * Encodes the view's visible state — camera position, basemap, sensor style,
 * HUD on/off, pass observer, tracked-target coordinates — into a compact URL
 * hash (`#g=…`) that can be pasted and opened later / shared with the owner.
 *
 * The format is a sequence of `k=v` pairs joined by `.`, each value base-36 for
 * numbers and `~` to replace reserved separators. It is intentionally short so a
 * link stays readable; a share-link never carries a live-tracked entity (the
 * entity id is unstable), only its last known coordinates.
 */

export type GeoShareState = {
  cam?: { lat: number; lon: number; height: number; heading?: number; pitch?: number };
  basemap?: string;
  style?: string;
  hud?: boolean;
  passes?: { lat: number; lon: number };
  track?: { lat: number; lon: number; title?: string };
};

const F = 10_000; // 4-decimal-degree precision ≈ 11 metres at the equator.

function nz(value: number): string {
  // Signed integer in base-36, with "-" for negatives.
  return Math.round(value).toString(36);
}
function un(value: string): number {
  return Number.parseInt(value, 36);
}
// encodeURIComponent plus hand-encoding the three separators we actually use —
// `.` (pair), `,` (field), `=` (key/val) — so a title that contains any of them
// round-trips cleanly. decodeURIComponent reverses the extra three too.
const EXTRA_ENC: Record<string, string> = { ".": "%2E", ",": "%2C", "=": "%3D" };
function encS(value: string): string {
  return encodeURIComponent(value).replace(/[.,=]/g, (c) => EXTRA_ENC[c] ?? c);
}
function decS(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function serializeGeoState(state: GeoShareState): string {
  const parts: string[] = [];
  if (state.cam) {
    const { lat, lon, height, heading, pitch } = state.cam;
    parts.push(`c=${nz(lat * F)},${nz(lon * F)},${nz(height)}${heading != null ? `,${nz(heading * 100)}` : ""}${pitch != null ? `,${nz(pitch * 100)}` : ""}`);
  }
  if (state.basemap) parts.push(`b=${encS(state.basemap)}`);
  if (state.style) parts.push(`s=${encS(state.style)}`);
  if (state.hud != null) parts.push(`h=${state.hud ? 1 : 0}`);
  if (state.passes) parts.push(`p=${nz(state.passes.lat * F)},${nz(state.passes.lon * F)}`);
  if (state.track) {
    parts.push(`t=${nz(state.track.lat * F)},${nz(state.track.lon * F)}${state.track.title ? `,${encS(state.track.title.slice(0, 60))}` : ""}`);
  }
  return parts.join(".");
}

export function parseGeoState(raw: string): GeoShareState {
  const out: GeoShareState = {};
  if (!raw) return out;
  for (const chunk of raw.split(".")) {
    const eq = chunk.indexOf("=");
    if (eq < 0) continue;
    const key = chunk.slice(0, eq);
    const val = chunk.slice(eq + 1);
    try {
      switch (key) {
        case "c": {
          const [a, b, c, d, e] = val.split(",");
          out.cam = {
            lat: un(a) / F,
            lon: un(b) / F,
            height: un(c),
            heading: d != null ? un(d) / 100 : undefined,
            pitch: e != null ? un(e) / 100 : undefined,
          };
          break;
        }
        case "b":
          out.basemap = decS(val);
          break;
        case "s":
          out.style = decS(val);
          break;
        case "h":
          out.hud = val === "1";
          break;
        case "p": {
          const [a, b] = val.split(",");
          out.passes = { lat: un(a) / F, lon: un(b) / F };
          break;
        }
        case "t": {
          const [a, b, c] = val.split(",");
          out.track = { lat: un(a) / F, lon: un(b) / F, title: c != null ? decS(c) : undefined };
          break;
        }
      }
    } catch {
      // Ignore a malformed chunk — a share-link should degrade, not refuse.
    }
  }
  return out;
}

/** Build a shareable href rooted at the current page. */
export function buildShareHref(origin: string, pathname: string, state: GeoShareState): string {
  const serialized = serializeGeoState(state);
  return `${origin}${pathname}#g=${serialized}`;
}

/** Pull a `#g=…` fragment out of a URL hash, or an empty state. */
export function readShareFromHash(hash: string): GeoShareState {
  const m = hash.match(/#g=(.*)$/);
  if (!m) return {};
  return parseGeoState(m[1] ?? "");
}
