import type { OsintEntityKind, OsintRelationKind, OsintSeverity } from "./types";

/**
 * Colours and RU labels for the «РАЗВЕДКА / OSINT» view — the entity graph, the
 * findings feed and the legend. Plain CSS hex, used straight in SVG and on HUD
 * chips. The HQ palette holds (red accents on near-black); entity kinds are told
 * apart by warmth, not by leaving the family. Kept beside the data like geoStyle,
 * so a kind looks and reads the same wherever it is drawn.
 */

export type OsintKindStyle = {
  /** Node fill / glow colour. */
  color: string;
  /** Short RU label for the legend. */
  label: string;
};

export const OSINT_ENTITY_STYLE: Record<OsintEntityKind, OsintKindStyle> = {
  org: { color: "#ffffff", label: "Организация" },
  domain: { color: "#ff2a2a", label: "Домен" },
  subdomain: { color: "#ff6a3a", label: "Поддомен" },
  host: { color: "#ff8a3a", label: "Хост" },
  service: { color: "#ffd24a", label: "Сервис" },
  email: { color: "#9a7cff", label: "Email" },
  username: { color: "#4ab8ff", label: "Аккаунт" },
  "person-handle": { color: "#8affc8", label: "Персона" },
  geo: { color: "#4affd2", label: "Геоточка" },
};

export const OSINT_RELATION_STYLE: Record<OsintRelationKind, { color: string; label: string }> = {
  resolves: { color: "#ff6a3a", label: "резолвит" },
  subdomain: { color: "#ff8a3a", label: "поддомен" },
  runs: { color: "#ffd24a", label: "сервис" },
  owns: { color: "#ff2a2a", label: "владеет" },
  account: { color: "#4ab8ff", label: "аккаунт" },
  located: { color: "#4affd2", label: "геолокация" },
  linked: { color: "#8a8f99", label: "связь" },
};

export const OSINT_SEVERITY_STYLE: Record<OsintSeverity, { color: string; label: string }> = {
  info: { color: "#4ab8ff", label: "инфо" },
  low: { color: "#ffd24a", label: "низкая" },
  medium: { color: "#ff8a3a", label: "средняя" },
  high: { color: "#ff2a2a", label: "высокая" },
};
