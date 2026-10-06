/**
 * Scene presets (owner 2026-10-07, parity with the source project's "scenes"
 * concept — e.g. a Nepal flood scene). One scene is a lightweight preset: a
 * named camera destination, a short caption, an optional sensor style and an
 * optional set of observer points to highlight on arrival.
 *
 * No live data is embedded — a scene just drives the live layers already
 * running. Opening a scene feels like a cinematic cut: fly the camera, apply
 * the look, surface the context card. Pure declarative data + a tiny applyScene
 * driver. Everything the owner and every agent can trigger from the picker.
 */

export type SceneBasemap = "esri" | "osm" | "natural-earth";
export type SceneStyle = "clean" | "night" | "thermal" | "nvg" | "crt" | "noir";

export type GeoScene = {
  id: string;
  name: string;
  /** One-sentence card the view surfaces while the camera flies in. */
  caption: string;
  /** Longer context, shown inside the panel. */
  detail?: string;
  /** The camera's destination: fly to this point from above. */
  camera: { lat: number; lon: number; height: number; heading?: number; pitch?: number };
  /** Optional observer point for the «Пролёты спутников» panel. */
  observer?: { lat: number; lon: number };
  /** Optional basemap + sensor style to apply. */
  basemap?: SceneBasemap;
  style?: SceneStyle;
};

/**
 * The initial preset pack. Pure open-data demonstrations — famous geographic
 * sites, well-known orbital launch zones, dense traffic corridors. Non-exhaustive;
 * adding one is a single entry here.
 */
export const DEMO_SCENES: readonly GeoScene[] = [
  {
    id: "orbital-overview",
    name: "Орбитальный обзор",
    caption: "Полная ночная сторона Земли с живыми спутниками и МКС.",
    detail:
      "Камера высоко над экватором, стиль «Ночь» подчёркивает освещённые города. Все живые слои — рейсы, спутники, погода, землетрясения, циклоны — проявляются на одном кадре.",
    camera: { lat: 0, lon: 0, height: 25_000_000, pitch: -90 },
    style: "night",
    basemap: "esri",
  },
  {
    id: "himalaya",
    name: "Гималаи и Непал",
    caption: "Горный коридор, где активная сейсмика и ледниковые паводки.",
    detail:
      "Фокус на Непал и Тибет. Слой землетрясений показывает активные афтершоки на разломе; слой циклонов не задевает регион — он для контекста соседних морей.",
    camera: { lat: 28.0, lon: 85.5, height: 2_200_000, heading: 0, pitch: -55 },
    observer: { lat: 27.7172, lon: 85.3240 }, // Kathmandu
    style: "clean",
    basemap: "esri",
  },
  {
    id: "ring-of-fire",
    name: "Тихоокеанское огненное кольцо",
    caption: "Пояс активной сейсмики и вулканизма вокруг Тихого океана.",
    detail:
      "Камера над центральным Тихим океаном. Слой землетрясений USGS за сутки обычно даёт десятки точек ровно по этому поясу — наглядно показывает, где сейчас тряхнуло.",
    camera: { lat: 0, lon: -160, height: 20_000_000, pitch: -75 },
    style: "clean",
    basemap: "esri",
  },
  {
    id: "atlantic-storms",
    name: "Атлантические шторма",
    caption: "Карибский бассейн и Мексиканский залив, если в сезоне есть циклоны.",
    detail:
      "Фокус на Атлантике. Активные циклоны NHC появляются как подписанные точки; погодный радар RainViewer накладывает актуальные осадки.",
    camera: { lat: 20, lon: -70, height: 7_000_000, pitch: -60 },
    style: "clean",
    basemap: "esri",
  },
  {
    id: "cape-canaveral",
    name: "Мыс Канаверал",
    caption: "Главный пусковой коридор США — следи за ближайшим стартом.",
    detail:
      "Пуски из Launch Library появляются подписанными точками, в кадре видны CCSFS, KSC и соседние площадки.",
    camera: { lat: 28.5, lon: -80.6, height: 150_000, heading: 20, pitch: -45 },
    observer: { lat: 28.5618, lon: -80.5772 },
    style: "clean",
    basemap: "esri",
  },
  {
    id: "noir-london",
    name: "Нуар · Лондон",
    caption: "Киноплан: Лондон в чёрно-белом «нуаре» с виньеткой.",
    detail: "Пример одного из кинематографических сенсорных стилей на знакомом городе.",
    camera: { lat: 51.5074, lon: -0.1278, height: 150_000, heading: 15, pitch: -45 },
    style: "noir",
    basemap: "esri",
  },
];
