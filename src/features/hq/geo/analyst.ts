import * as Cesium from "cesium";

/**
 * «Аналитик» — a tiny deterministic query engine over everything the globe
 * currently plots. The owner (or an agent) asks a natural-language-ish question
 * in Russian — "сколько рейсов", "ближайший спутник от Москвы", "землетрясения
 * сильнее 5" — and the engine answers from live Cesium entity data on the view.
 *
 * No LLM, no network: a small set of pattern matchers (counting, filtering,
 * nearest-N, ranking) over the live data sources we already own. If a question
 * doesn't match any pattern, the engine returns a helpful hint instead of
 * guessing. Every answer carries both the plain text and the structured hits so
 * the UI can draw the hits on the globe later.
 */

export type AnalystHit = {
  id: string;
  title: string;
  kind: string;
  lat?: number;
  lon?: number;
  value?: number;
  valueUnit?: string;
};

export type AnalystAnswer = {
  text: string;
  hits: AnalystHit[];
};

type Source = {
  dsName: string;
  kind: string;
  nouns: readonly RegExp[];
  valueKey?: string;
  valueUnit?: string;
};

const SOURCES: Source[] = [
  { dsName: "hq-geo-flights", kind: "flight", nouns: [/рейс(ы|ов)?/i, /самолёт/i, /воздушн/i] },
  { dsName: "hq-geo-satellites", kind: "satellite", nouns: [/спутник/i, /sat/i] },
  { dsName: "hq-geo-iss", kind: "iss", nouns: [/мкс/i, /iss/i] },
  { dsName: "hq-geo-earthquakes", kind: "earthquake", nouns: [/землетрясен/i, /еартщ|тр(я|ё)сл/i], valueKey: "magnitude", valueUnit: "M" },
  { dsName: "hq-geo-cyclones", kind: "cyclone", nouns: [/циклон/i, /шторм/i, /ураган/i] },
  { dsName: "hq-geo-launches", kind: "launch", nouns: [/пуск(и|ов)?/i, /запуск/i, /ракет/i], valueKey: "hoursFromNow", valueUnit: "ч" },
  { dsName: "hq-geo-datacenters", kind: "datacenter", nouns: [/дата.?центр/i, /datacenter/i, /дц/i] },
  { dsName: "hq-geo-dams", kind: "dam", nouns: [/плотин/i, /гэс/i, /dam/i], valueKey: "capacityMW", valueUnit: "МВт" },
  { dsName: "hq-geo-volcanoes", kind: "volcano", nouns: [/вулкан/i, /volcano/i] },
];

function sourceFor(query: string): Source | null {
  for (const src of SOURCES) if (src.nouns.some((re) => re.test(query))) return src;
  return null;
}

function entitiesOf(viewer: Cesium.Viewer, dsName: string): Cesium.Entity[] {
  const ds = viewer.dataSources.getByName(dsName)[0];
  return ds ? ds.entities.values : [];
}

/** Great-circle distance in km between two (lat, lon) points (haversine). */
function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371.0;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLon = ((bLon - aLon) * Math.PI) / 180;
  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const h = sinDLat * sinDLat + Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * sinDLon * sinDLon;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function readPos(entity: Cesium.Entity): { lat: number; lon: number } | null {
  const t = Cesium.JulianDate.now();
  const pos = entity.position?.getValue(t);
  if (!pos) return null;
  const carto = Cesium.Cartographic.fromCartesian(pos);
  return { lat: Cesium.Math.toDegrees(carto.latitude), lon: Cesium.Math.toDegrees(carto.longitude) };
}

function entityValue(entity: Cesium.Entity, key: string): number | null {
  const t = Cesium.JulianDate.now();
  const props = (entity.properties?.getValue(t) ?? {}) as Record<string, unknown>;
  const raw = props[key];
  const num = typeof raw === "number" ? raw : typeof raw === "string" ? Number.parseFloat(raw) : null;
  return typeof num === "number" && Number.isFinite(num) ? num : null;
}

function entityTitle(entity: Cesium.Entity): string {
  const t = Cesium.JulianDate.now();
  const props = (entity.properties?.getValue(t) ?? {}) as Record<string, unknown>;
  return (props.name as string) || (props.title as string) || String(entity.id ?? "цель");
}

function entityToHit(entity: Cesium.Entity, kind: string, valueKey?: string, valueUnit?: string): AnalystHit {
  const pos = readPos(entity);
  const value = valueKey ? entityValue(entity, valueKey) ?? undefined : undefined;
  return {
    id: String(entity.id ?? ""),
    title: entityTitle(entity),
    kind,
    lat: pos?.lat,
    lon: pos?.lon,
    value,
    valueUnit: valueUnit,
  };
}

/** Parse a comparison phrase like "сильнее 5" / "больше 100 МВт" / "выше 40°". */
function parseComparison(query: string): { op: ">" | "<" | ">="; value: number } | null {
  const re = /(больше|сильнее|выше|мощнее|старше|свыше|над|more|above|greater|>)\s+(\d+(?:[.,]\d+)?)/i;
  const m = query.match(re);
  if (m) return { op: ">", value: Number.parseFloat(m[2].replace(",", ".")) };
  const re2 = /(меньше|слабее|ниже|мельче|below|less|<)\s+(\d+(?:[.,]\d+)?)/i;
  const m2 = query.match(re2);
  if (m2) return { op: "<", value: Number.parseFloat(m2[2].replace(",", ".")) };
  return null;
}

/** Parse an "near X" / "от Москвы" phrase into a known-city lat/lon. */
// Known-city lookup. The key is the STEM (common-prefix across Russian cases),
// so "Москва"/"Москвы"/"Москве" all match "москв".
const KNOWN_PLACES: Array<{ stem: RegExp; lat: number; lon: number }> = [
  { stem: /москв/i, lat: 55.7558, lon: 37.6176 },
  { stem: /moscow/i, lat: 55.7558, lon: 37.6176 },
  { stem: /питер|санкт.?петербург|спб|petersburg/i, lat: 59.9311, lon: 30.3609 },
  { stem: /нью.?йорк|new\s*york/i, lat: 40.7128, lon: -74.006 },
  { stem: /лондон|london/i, lat: 51.5074, lon: -0.1278 },
  { stem: /токио|tokyo/i, lat: 35.6762, lon: 139.6503 },
  { stem: /париж|paris/i, lat: 48.8566, lon: 2.3522 },
  { stem: /берлин|berlin/i, lat: 52.52, lon: 13.405 },
  { stem: /дубай|dubai/i, lat: 25.2048, lon: 55.2708 },
  { stem: /сан.?франциск|san\s*francisco/i, lat: 37.7749, lon: -122.4194 },
  { stem: /сингапур|singapore/i, lat: 1.3521, lon: 103.8198 },
  { stem: /стамбул|istanbul/i, lat: 41.0082, lon: 28.9784 },
];

function parseFromPlace(query: string): { lat: number; lon: number } | null {
  // Prefer a prepositional phrase ("от Москвы", "near Moscow") but accept a bare
  // city name too — the owner may type "ближайший спутник Москвы" without "от".
  for (const place of KNOWN_PLACES) {
    const prep = new RegExp(`(от|рядом с|у|близ|near|from)\\s+\\S*${place.stem.source}`, "i");
    if (prep.test(query)) return place;
  }
  for (const place of KNOWN_PLACES) {
    if (place.stem.test(query)) return place;
  }
  return null;
}

/** Main entry: answer a question about what's on the globe right now. */
export function askAnalyst(
  viewer: Cesium.Viewer | null,
  query: string,
  focus?: { lat: number; lon: number } | null,
): AnalystAnswer {
  if (!viewer || viewer.isDestroyed()) {
    return { text: "Глобус ещё не загружен.", hits: [] };
  }
  const q = String(query ?? "").trim();
  if (!q) return { text: "Спроси, например: «сколько рейсов», «ближайший спутник от Москвы», «землетрясения сильнее 5».", hits: [] };

  const src = sourceFor(q);
  if (!src) {
    return {
      text: `Не узнал цель запроса. Я умею отвечать про рейсы, спутники, МКС, землетрясения, циклоны, пуски, дата-центры, плотины, вулканы. Пример: «сколько пусков в ближайшие сутки».`,
      hits: [],
    };
  }

  const entities = entitiesOf(viewer, src.dsName);
  const count = entities.length;

  // "Сколько ..." → count only.
  if (/\bсколько|how many|count/i.test(q)) {
    return { text: `${count} ${src.kind}.`, hits: entities.slice(0, 50).map((e) => entityToHit(e, src.kind, src.valueKey, src.valueUnit)) };
  }

  // Comparison: "магнитудой больше 5" / "мощнее 1000 МВт" / "выше 40°".
  const cmp = parseComparison(q);
  if (cmp && src.valueKey) {
    const filtered = entities.filter((e) => {
      const v = entityValue(e, src.valueKey!);
      if (v == null) return false;
      return cmp.op === ">" ? v > cmp.value : v < cmp.value;
    });
    return {
      text: `${filtered.length} ${src.kind} ${cmp.op === ">" ? "выше" : "ниже"} ${cmp.value}${src.valueUnit ? ` ${src.valueUnit}` : ""}.`,
      hits: filtered.slice(0, 50).map((e) => entityToHit(e, src.kind, src.valueKey, src.valueUnit)),
    };
  }

  // "Ближайший ... от Москвы". `\b` does not match a word boundary before a
  // Cyrillic letter in the default JS regex engine, so match on the stem.
  const from = parseFromPlace(q) ?? focus ?? null;
  if (/ближайш|nearest|closest|рядом/i.test(q) && from) {
    const scored = entities
      .map((e) => {
        const p = readPos(e);
        if (!p) return null;
        const d = haversineKm(from.lat, from.lon, p.lat, p.lon);
        return { entity: e, dist: d };
      })
      .filter((x): x is { entity: Cesium.Entity; dist: number } => x !== null)
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 10);
    const nearest = scored[0];
    if (!nearest) {
      return { text: "Пусто — таких объектов на глобусе сейчас нет.", hits: [] };
    }
    const hits = scored.map(({ entity, dist }) => ({ ...entityToHit(entity, src.kind, src.valueKey, src.valueUnit), value: Math.round(dist), valueUnit: "км" }));
    return {
      text: `Ближайший «${entityTitle(nearest.entity)}» — ${Math.round(nearest.dist)} км.`,
      hits,
    };
  }

  // Default: list the first few by name.
  const sample = entities.slice(0, 10).map((e) => entityToHit(e, src.kind, src.valueKey, src.valueUnit));
  return {
    text: `На глобусе ${count} ${src.kind}. Первые ${sample.length}: ${sample.map((h) => h.title).join(", ")}.`,
    hits: sample,
  };
}
