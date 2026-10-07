/**
 * Voice whiteboard — a tiny parser that turns short Russian voice commands into
 * declarative annotations on the globe. Commands are intentionally simple so
 * the owner (or an agent) can speak them without rehearsing a grammar:
 *
 *   «отметь Москву»                      → one labelled point at Moscow
 *   «отметь Берлин как ЦЕЛЬ»             → labelled point with the given tag
 *   «нарисуй дугу от Москвы до Берлина»  → one arc with a label at both ends
 *   «подпиши точку АГЕНТ-01»             → re-label the last-pinned point
 *   «очисти доску»                        → remove every whiteboard annotation
 *
 * Pure data output; the caller applies the annotations through geoController
 * (or any renderer that understands lat/lon). No LLM, no network — a known-
 * place lookup drives Russian cases, same stems as analyst.ts.
 */

export type WhiteboardAction =
  | { type: "pin"; lat: number; lon: number; label: string }
  | { type: "arc"; from: { lat: number; lon: number; label: string }; to: { lat: number; lon: number; label: string } }
  | { type: "relabel-last"; label: string }
  | { type: "clear" };

export type KnownPlace = { stem: RegExp; label: string; lat: number; lon: number };

// Reused by analyst and whiteboard; keep the two lists in step by hand for now.
export const WHITEBOARD_PLACES: readonly KnownPlace[] = [
  { stem: /москв/i, label: "Москва", lat: 55.7558, lon: 37.6176 },
  { stem: /moscow/i, label: "Moscow", lat: 55.7558, lon: 37.6176 },
  { stem: /питер|санкт.?петербург|спб|petersburg/i, label: "Санкт-Петербург", lat: 59.9311, lon: 30.3609 },
  { stem: /нью.?йорк|new\s*york/i, label: "Нью-Йорк", lat: 40.7128, lon: -74.006 },
  { stem: /лондон|london/i, label: "Лондон", lat: 51.5074, lon: -0.1278 },
  { stem: /токио|tokyo/i, label: "Токио", lat: 35.6762, lon: 139.6503 },
  { stem: /париж|paris/i, label: "Париж", lat: 48.8566, lon: 2.3522 },
  { stem: /берлин|berlin/i, label: "Берлин", lat: 52.52, lon: 13.405 },
  { stem: /дубай|dubai/i, label: "Дубай", lat: 25.2048, lon: 55.2708 },
  { stem: /сингапур|singapore/i, label: "Сингапур", lat: 1.3521, lon: 103.8198 },
  { stem: /стамбул|istanbul/i, label: "Стамбул", lat: 41.0082, lon: 28.9784 },
  { stem: /рим\b|rome/i, label: "Рим", lat: 41.9028, lon: 12.4964 },
  { stem: /мадрид|madrid/i, label: "Мадрид", lat: 40.4168, lon: -3.7038 },
  { stem: /вашингтон|washington/i, label: "Вашингтон", lat: 38.9072, lon: -77.0369 },
  { stem: /сан.?франциск|san\s*francisco/i, label: "Сан-Франциско", lat: 37.7749, lon: -122.4194 },
  { stem: /сидней|sydney/i, label: "Сидней", lat: -33.8688, lon: 151.2093 },
];

function placeAt(text: string, startAt = 0): { place: KnownPlace; index: number } | null {
  let best: { place: KnownPlace; index: number } | null = null;
  for (const place of WHITEBOARD_PLACES) {
    const re = new RegExp(place.stem.source, "i");
    const slice = text.slice(startAt);
    const m = slice.match(re);
    if (!m || m.index == null) continue;
    const absolute = startAt + m.index;
    if (best === null || absolute < best.index) best = { place, index: absolute };
  }
  return best;
}

/** Parse a tag at the tail: "как X" / "подпиши точку X" / everything after "как". */
function tailTag(text: string): string | null {
  const m = text.match(/\s(?:как|подпиши.*?точку)\s+(.+?)[.!?]?$/i);
  if (!m) return null;
  return m[1].trim().slice(0, 40);
}

/**
 * Parse a single short Russian voice command into a WhiteboardAction, or null
 * when nothing was recognised. Designed to be forgiving — the known-place
 * lookup is substring, so inflected forms match.
 */
export function parseWhiteboardCommand(input: string): WhiteboardAction | null {
  const text = String(input ?? "").trim();
  if (!text) return null;

  // Clear. Cyrillic doesn't play with \b in the default regex engine, so we
  // match on word stems directly.
  if (/(^|\s)(очисти|сотри|убери)\s+(доск|все|всё)/i.test(text) || /^(очисти|clear)$/i.test(text)) {
    return { type: "clear" };
  }

  // Relabel last.
  const relabel = text.match(/^(подпиши|пометь)\s+точку\s+(.+)$/i);
  if (relabel) return { type: "relabel-last", label: relabel[2].trim().slice(0, 40) };

  // Arc: «нарисуй дугу от X до Y» / «проведи линию от X до Y». No \b around
  // Cyrillic prepositions — match whitespace boundaries directly.
  if (/дугу|линию|стрелку/i.test(text) && /(^|\s)от\s/i.test(text) && /\sдо\s/i.test(text)) {
    const fromMatch = text.match(/(^|\s)от\s/i);
    const toMatch = text.match(/\sдо\s/i);
    const fromIdx = fromMatch?.index ?? -1;
    const toIdx = toMatch?.index ?? -1;
    if (fromIdx >= 0 && toIdx > fromIdx) {
      const fromOffset = fromMatch![0].length;
      const toOffset = toMatch![0].length;
      const fromPart = text.slice(fromIdx + fromOffset, toIdx).trim();
      const toPart = text.slice(toIdx + toOffset).trim();
      const fromHit = placeAt(fromPart);
      const toHit = placeAt(toPart);
      if (fromHit && toHit) {
        return {
          type: "arc",
          from: { lat: fromHit.place.lat, lon: fromHit.place.lon, label: fromHit.place.label },
          to: { lat: toHit.place.lat, lon: toHit.place.lon, label: toHit.place.label },
        };
      }
    }
  }

  // Pin: «отметь X» / «пометь X» / «point X». Optional «как ТЕГ» tail overrides the label.
  const pinMatch = text.match(/^(отметь|пометь|point|поставь\s+(?:точку|метку))\s+(.+)$/i);
  if (pinMatch) {
    const rest = pinMatch[2];
    const hit = placeAt(rest);
    if (hit) {
      const tag = tailTag(text);
      return { type: "pin", lat: hit.place.lat, lon: hit.place.lon, label: tag ?? hit.place.label };
    }
  }

  // Bare place name alone: «Берлин» → pin.
  const bare = placeAt(text);
  if (bare && bare.index === 0 && text.length <= bare.place.label.length + 20) {
    return { type: "pin", lat: bare.place.lat, lon: bare.place.lon, label: bare.place.label };
  }

  return null;
}
