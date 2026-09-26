"use client";

import { useMemo, useState } from "react";

import {
  Download,
  ExternalLink,
  RefreshCcw,
  Settings2,
  Shield,
  Sparkles,
  Star,
  Trash2,
  X,
} from "lucide-react";

import type { OfficeSkillsMarketplaceController } from "@/features/office/hooks/useOfficeSkillsMarketplace";
import type { SkillMarketplaceCollectionId, SkillMarketplaceEntry } from "@/lib/skills/marketplace";
import {
  buildSkillMarketplaceCollections,
  hasSkillMarketplaceStats,
} from "@/lib/skills/marketplace";
import { buildAgentSkillsAllowlistSet, deriveAgentSkillsAccessMode } from "@/lib/skills/presentation";
import { SkillRegistryBrowser } from "./SkillRegistryBrowser";
import { LOCALE, t } from "@/lib/i18n";

/** "registry" is not a local collection — it browses the remote sources. */
type MarketplaceFilter = "all" | SkillMarketplaceCollectionId | "registry";

const FILTER_LABELS: Record<MarketplaceFilter, string> = {
  office3d: "Office3D",
  registry: t("skills.filterBrowse"),
  all: t("skills.filterAll"),
  featured: t("skills.filterFeatured"),
  installed: t("skills.filterInstalled"),
  "setup-required": t("skills.filterNeedsSetup"),
  "built-in": t("skills.filterBuiltIn"),
  workspace: t("skills.filterWorkspace"),
  extra: t("skills.filterCommunity"),
  other: t("skills.filterOther"),
};

const READINESS_LABELS = {
  ready: t("skills.readinessReady"),
  "needs-setup": t("skills.readinessNeedsSetup"),
  unavailable: t("skills.readinessUnavailable"),
  "disabled-globally": t("skills.readinessDisabledGlobally"),
} as const;

// HQ palette: ready reads as "live" (white on red), setup is the one sparing
// orange warning, unavailable is the error red and a global switch-off is muted.
const READINESS_CLASSES = {
  ready: "border-red-500/55 bg-red-600/20 text-white",
  "needs-setup": "border-orange-400/35 bg-orange-500/10 text-orange-300",
  unavailable: "border-red-500/50 bg-red-950/40 text-red-400",
  "disabled-globally": "border-white/15 bg-white/[0.04] text-white/55",
} as const;

// Shared building blocks so every button, chip and card in the marketplace
// reads as one black / red / white HQ surface.
const BTN =
  "inline-flex items-center justify-center gap-1 rounded-md border px-2 py-1 font-mono text-[10px] uppercase tracking-[0.14em] transition-colors disabled:cursor-not-allowed disabled:opacity-45";
const BTN_PRIMARY = `${BTN} border-red-500/60 bg-[#e3141c] text-white shadow-[0_0_14px_rgba(255,26,26,0.25)] hover:border-red-400/70 hover:bg-[#ff2a2a] disabled:shadow-none`;
const BTN_SECONDARY = `${BTN} border-red-900/40 bg-black/40 text-white/80 hover:border-red-500/50 hover:bg-red-950/40 hover:text-white`;
const BTN_ACTIVE = `${BTN} border-red-500/60 bg-red-600/20 text-white hover:bg-red-600/30`;
const BTN_DANGER = `${BTN} border-red-500/50 bg-red-950/40 text-red-300 hover:border-red-400/70 hover:bg-red-900/40 hover:text-white`;
const CARD = "rounded-md border border-red-900/40 bg-[#0b0707]";
const TILE = "rounded-md border border-red-900/40 bg-black/40 px-2 py-2";
const CHIP = "rounded border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.12em]";
const NOTE =
  "rounded-md border border-red-900/40 border-l-2 border-l-red-600/70 bg-red-950/20 px-3 py-2 font-mono text-[10px] leading-relaxed text-white/65";
const SECTION_LABEL = "font-mono text-[10px] uppercase tracking-[0.18em] text-white/45";
const LINK = "text-red-300 underline decoration-red-500/40 underline-offset-2 transition-colors hover:text-white";
const FIELD =
  "rounded-md border border-red-900/50 bg-black/60 font-mono text-[11px] text-white outline-none transition [color-scheme:dark] placeholder:text-white/35 focus:border-red-500/70 focus:ring-1 focus:ring-red-500/30";
const MESSAGE_SUCCESS = "border-red-500/40 bg-red-600/10 text-white";
const MESSAGE_ERROR = "border-red-500/50 bg-red-950/40 text-red-400";

const formatRating = (value: number | undefined) => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "4.7";
  }
  return value.toFixed(1);
};

const formatInstalls = (value: number | undefined) => {
  const installs = value ?? 0;
  if (installs >= 1000) {
    return `${(installs / 1000).toFixed(1)}k`;
  }
  return new Intl.NumberFormat(LOCALE).format(installs);
};

const buildSearchBlob = (entry: SkillMarketplaceEntry): string => {
  return [
    entry.skill.name,
    entry.skill.description,
    entry.skill.skillKey,
    entry.skill.source,
    entry.metadata.category,
    entry.metadata.tagline,
    entry.metadata.capabilities.join(" "),
  ]
    .join(" ")
    .toLowerCase();
};

const getAgentSkillEnabled = (
  skillName: string,
  accessMode: ReturnType<typeof deriveAgentSkillsAccessMode>,
  allowlistSet: Set<string>
) => {
  if (accessMode === "all") {
    return true;
  }
  if (accessMode === "none") {
    return false;
  }
  return allowlistSet.has(skillName.trim());
};

export function SkillsMarketplacePanel({
  marketplace,
  onSelectAgent,
  onOpenAgentSettings,
}: {
  marketplace: OfficeSkillsMarketplaceController;
  onSelectAgent: (agentId: string) => void;
  onOpenAgentSettings: (agentId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [activeFilter, setActiveFilter] = useState<MarketplaceFilter>("office3d");
  const [detailSkillKey, setDetailSkillKey] = useState<string | null>(null);

  const entries = useMemo(
    () => marketplace.marketplaceSkills ?? marketplace.skillsReport?.skills ?? [],
    [marketplace.marketplaceSkills, marketplace.skillsReport]
  );
  const collections = useMemo(() => buildSkillMarketplaceCollections(entries), [entries]);
  const accessMode = useMemo(
    () => deriveAgentSkillsAccessMode(marketplace.skillsAllowlist),
    [marketplace.skillsAllowlist]
  );
  const allowlistSet = useMemo(
    () => buildAgentSkillsAllowlistSet(marketplace.skillsAllowlist),
    [marketplace.skillsAllowlist]
  );

  const filteredCollections = useMemo(() => {
    // The registry tab browses remote sources, so there are no local
    // collections to filter for it.
    if (activeFilter === "registry") return [];
    const normalizedQuery = query.trim().toLowerCase();
    const visibleCollectionIds: SkillMarketplaceCollectionId[] =
      activeFilter === "all"
        ? ["office3d", "built-in", "installed", "workspace", "extra", "other"]
        : [activeFilter];
    return collections
      .filter((collection) => visibleCollectionIds.includes(collection.id))
      .map((collection) => ({
        ...collection,
        entries: collection.entries.filter((entry) => {
          if (!normalizedQuery) {
            return true;
          }
          return buildSearchBlob(entry).includes(normalizedQuery);
        }),
      }))
      .filter((collection) => collection.entries.length > 0);
  }, [activeFilter, collections, query]);

  const featuredEntries = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const featuredCollection = collections.find((collection) => collection.id === "featured");
    if (!featuredCollection) {
      return [];
    }
    return featuredCollection.entries
      .filter((entry) => {
        if (!normalizedQuery) {
          return true;
        }
        return buildSearchBlob(entry).includes(normalizedQuery);
      })
      .slice(0, 3);
  }, [collections, query]);

  const filterCounts = useMemo(() => {
    const counts: Record<MarketplaceFilter, number> = {
      office3d: 0,
      all: entries.length,
      featured: 0,
      installed: 0,
      "setup-required": 0,
      "built-in": 0,
      workspace: 0,
      extra: 0,
      other: 0,
      registry: 0,
    };
    for (const collection of collections) {
      counts[collection.id] = collection.entries.length;
    }
    return counts;
  }, [collections, entries.length]);

  const detailEntry =
    collections
      .flatMap((collection) => collection.entries)
      .find((entry) => entry.skill.skillKey === detailSkillKey) ?? null;

  return (
    <section className="relative flex h-full min-h-0 flex-col">
      <div className="border-b border-red-900/40 px-4 py-3">
        {/* The modal header already names the marketplace; this row only refreshes it. */}
        <div className="flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={() => void marketplace.refresh()}
            className={BTN_SECONDARY}
          >
            <RefreshCcw className={`h-3.5 w-3.5 ${marketplace.loading ? "animate-spin text-red-400" : ""}`} />
            {t("common.refresh")}
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <div className={NOTE}>
          {t("skills.scopeNote")}
        </div>

        <div className={`mt-3 ${CARD} px-3 py-3`}>
          <div className="flex items-center justify-between gap-2">
            <div>
              <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-white/45">
                {t("skills.agentContext")}
              </div>
              <div className="mt-1 font-mono text-[12px] font-semibold text-white">
                {marketplace.selectedAgent?.name ?? t("skills.noAgentSelected")}
              </div>
            </div>
            <div className="font-mono text-[10px] text-white/45">
              {t("skills.accessMode", {
                mode:
                  accessMode === "selected"
                    ? t("skills.selectedSkills")
                    : accessMode === "all"
                      ? t("skills.accessAll")
                      : t("skills.accessNone"),
              })}
            </div>
          </div>

          <div className="mt-3 flex gap-2">
            <select
              value={marketplace.selectedAgentId ?? ""}
              onChange={(event) => marketplace.setSelectedAgentId(event.target.value || null)}
              className={`min-w-0 flex-1 px-2 py-2 ${FIELD}`}
            >
              {marketplace.agents.length === 0 ? <option value="">{t("phone.noAgents")}</option> : null}
              {marketplace.agents.map((agent) => (
                <option key={agent.agentId} value={agent.agentId}>
                  {agent.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={!marketplace.selectedAgentId}
              onClick={() => {
                if (marketplace.selectedAgentId) {
                  onSelectAgent(marketplace.selectedAgentId);
                }
              }}
              className={BTN_SECONDARY}
            >
              {t("skills.focusChat")}
            </button>
            <button
              type="button"
              disabled={!marketplace.selectedAgentId}
              onClick={() => {
                if (marketplace.selectedAgentId) {
                  onOpenAgentSettings(marketplace.selectedAgentId);
                }
              }}
              className={BTN_SECONDARY}
            >
              {t("common.settings")}
            </button>
          </div>
        </div>

        <div className="mt-3">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("skills.searchPlaceholder")}
            className={`w-full px-3 py-2 ${FIELD}`}
            aria-label={t("skills.searchLabel")}
          />
        </div>

        <div className="mt-2 flex flex-wrap gap-1">
          {(Object.keys(FILTER_LABELS) as MarketplaceFilter[]).map((filterId) => (
            <button
              key={filterId}
              type="button"
              onClick={() => setActiveFilter(filterId)}
              aria-pressed={activeFilter === filterId}
              className={activeFilter === filterId ? BTN_ACTIVE : BTN_SECONDARY}
            >
              {FILTER_LABELS[filterId]}
              {filterId === "registry" ? null : (
                <span
                  className={`tabular-nums ${activeFilter === filterId ? "text-red-300" : "text-white/40"}`}
                >
                  {filterCounts[filterId]}
                </span>
              )}
            </button>
          ))}
        </div>

        {marketplace.message ? (
          <div
            role="status"
            className={`mt-3 rounded-md border px-3 py-2 font-mono text-[11px] ${
              marketplace.message.kind === "success" ? MESSAGE_SUCCESS : MESSAGE_ERROR
            }`}
          >
            <div className="flex items-start gap-2">
              {marketplace.message.kind === "success" ? (
                <span
                  className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-red-500 shadow-[0_0_6px_rgba(255,26,26,0.8)]"
                  aria-hidden="true"
                />
              ) : null}
              <span>{marketplace.message.text}</span>
            </div>
            {marketplace.message.kind === "success" ? (
              <div className="mt-1 font-mono text-[10px] text-white/55">
                {t("skills.findInstalled")}
              </div>
            ) : null}
          </div>
        ) : null}

        {marketplace.error && !marketplace.message ? (
          <div className={`mt-3 rounded-md border px-3 py-2 font-mono text-[11px] ${MESSAGE_ERROR}`}>
            {marketplace.error}
          </div>
        ) : null}

        {activeFilter === "registry" ? (
          <div className="mt-4">
            <SkillRegistryBrowser />
          </div>
        ) : null}

        {activeFilter !== "registry" && marketplace.loading ? (
          <div className="mt-4 flex items-center gap-2 font-mono text-[11px] text-white/45">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-red-500" aria-hidden="true" />
            {t("skills.loading")}
          </div>
        ) : null}

        {!marketplace.loading && activeFilter === "all" && featuredEntries.length > 0 ? (
          <div className="mt-4">
            <div className={`mb-2 flex items-center gap-2 ${SECTION_LABEL}`}>
              <Sparkles className="h-3.5 w-3.5 text-red-500" aria-hidden="true" />
              {t("skills.featuredShelf")}
            </div>
            <div className="grid gap-2">
              {featuredEntries.map((entry) => (
                <button
                  key={`featured:${entry.skill.skillKey}`}
                  type="button"
                  onClick={() => setDetailSkillKey(entry.skill.skillKey)}
                  className="rounded-md border border-red-600/35 bg-gradient-to-br from-red-600/15 via-[#0b0707] to-[#0b0707] px-3 py-3 text-left transition-[border-color,box-shadow] hover:border-red-500/60 hover:shadow-[0_0_14px_rgba(255,26,26,0.18)]"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="font-mono text-[12px] font-semibold text-white">{entry.skill.name}</div>
                      <div className="mt-1 font-mono text-[10px] text-white/65">{entry.metadata.tagline}</div>
                    </div>
                    <div className={`${CHIP} shrink-0 border-red-500/50 bg-red-600/20 text-white`}>
                      {entry.metadata.editorBadge ?? t("skills.featuredBadge")}
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-3 font-mono text-[10px] tabular-nums text-white/55">
                    {hasSkillMarketplaceStats(entry.metadata) ? (
                      <>
                        <span className="inline-flex items-center gap-1">
                          <Star className="h-3 w-3 fill-red-500/70 text-red-400" aria-hidden="true" />
                          {formatRating(entry.metadata.rating)}
                        </span>
                        <span>{t("skills.installsCount", { count: formatInstalls(entry.metadata.installs) })}</span>
                      </>
                    ) : null}
                    <span>{entry.metadata.category}</span>
                  </div>
                  {entry.metadata.poweredByName && entry.metadata.poweredByUrl ? (
                    <div className="mt-2 font-mono text-[10px] text-white/55">
                      {t("skills.poweredBy")}{" "}
                      <a
                        href={entry.metadata.poweredByUrl}
                        target="_blank"
                        rel="noreferrer"
                        className={LINK}
                        onClick={(event) => event.stopPropagation()}
                      >
                        {entry.metadata.poweredByName}
                      </a>
                    </div>
                  ) : null}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {activeFilter !== "registry" && !marketplace.loading && filteredCollections.length === 0 ? (
          <div className={`mt-4 ${CARD} px-3 py-4 text-center font-mono text-[11px] text-white/45`}>
            {t("skills.noMatches")}
          </div>
        ) : null}

        {!marketplace.loading &&
          filteredCollections.map((collection) => (
            <div key={collection.id} className="mt-4">
              <div className={`mb-2 flex items-center gap-2 ${SECTION_LABEL}`}>
                <span className="h-px w-3 bg-red-600/70" aria-hidden="true" />
                {collection.label}
                <span className="tabular-nums text-white/40">{collection.entries.length}</span>
              </div>
              <div className="flex flex-col gap-2">
                {collection.entries.map((entry) => {
                  const packagedSkill = marketplace.packagedSkillsByKey.get(entry.skill.skillKey);
                  const packageOnly = Boolean(packagedSkill && !entry.skill.baseDir.trim());
                  const isEnabledForAgent = getAgentSkillEnabled(entry.skill.name, accessMode, allowlistSet);
                  const primaryAction =
                    packageOnly
                      ? {
                          label: t("skills.installSkill"),
                          run: () => void marketplace.handleInstallPackagedSkill(entry.skill.skillKey),
                          icon: Download,
                        }
                      : entry.readiness === "needs-setup" && entry.installable
                      ? {
                          label: t("skills.installDepsShort"),
                          run: () => void marketplace.handleInstallSkill(entry.skill),
                          icon: Download,
                        }
                      : entry.readiness === "disabled-globally"
                        ? {
                            label: t("skills.enableGateway"),
                            run: () => void marketplace.handleSetSkillGlobalEnabled(entry.skill.skillKey, true),
                            icon: Settings2,
                          }
                        : entry.readiness === "needs-setup"
                          ? {
                              label: t("skills.openSettings"),
                              run: () => {
                                if (marketplace.selectedAgentId) {
                                  onOpenAgentSettings(marketplace.selectedAgentId);
                                }
                              },
                              icon: Settings2,
                            }
                          : null;
                  const PrimaryIcon = primaryAction?.icon ?? Settings2;
                  return (
                    <div
                      key={`${collection.id}:${entry.skill.skillKey}`}
                      className={`${CARD} px-3 py-3 transition-colors hover:border-red-600/35`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              onClick={() => setDetailSkillKey(entry.skill.skillKey)}
                              className="truncate font-mono text-[12px] font-semibold text-white transition-colors hover:text-red-300"
                            >
                              {entry.skill.name}
                            </button>
                            <span className={`${CHIP} border-red-900/40 bg-black/40 text-white/55`}>
                              {entry.metadata.category}
                            </span>
                            <span className={`${CHIP} ${READINESS_CLASSES[entry.readiness]}`}>
                              {READINESS_LABELS[entry.readiness]}
                            </span>
                          </div>
                          <div className="mt-2 font-mono text-[11px] leading-relaxed text-white/65">{entry.metadata.tagline}</div>
                          <div className="mt-2 flex flex-wrap items-center gap-3 font-mono text-[10px] tabular-nums text-white/45">
                            <span className="inline-flex items-center gap-1">
                              <Shield className="h-3 w-3 text-red-400/80" aria-hidden="true" />
                              {entry.metadata.trustLabel}
                            </span>
                            {hasSkillMarketplaceStats(entry.metadata) ? (
                              <>
                                <span className="inline-flex items-center gap-1">
                                  <Star className="h-3 w-3 fill-red-500/70 text-red-400" aria-hidden="true" />
                                  {formatRating(entry.metadata.rating)}
                                </span>
                                <span>{t("skills.installsCount", { count: formatInstalls(entry.metadata.installs) })}</span>
                              </>
                            ) : null}
                            <span>{entry.skill.source}</span>
                          </div>
                          {entry.metadata.poweredByName && entry.metadata.poweredByUrl ? (
                            <div className="mt-2 font-mono text-[10px] text-white/55">
                              {t("skills.poweredBy")}{" "}
                              <a
                                href={entry.metadata.poweredByUrl}
                                target="_blank"
                                rel="noreferrer"
                                className={LINK}
                              >
                                {entry.metadata.poweredByName}
                              </a>
                            </div>
                          ) : null}
                          {entry.missingDetails.length > 0 ? (
                            <div className="mt-2 font-mono text-[10px] text-orange-300/85">
                              {entry.missingDetails[0]}
                            </div>
                          ) : null}
                        </div>

                        <div className="flex flex-col items-end gap-2">
                          <button
                            type="button"
                            onClick={() => void marketplace.handleSetSkillEnabled(entry.skill.name, !isEnabledForAgent)}
                            disabled={
                              packageOnly ||
                              entry.readiness === "unavailable" ||
                              !marketplace.selectedAgentId ||
                              marketplace.busySkillKey === entry.skill.skillKey
                            }
                            className={isEnabledForAgent ? BTN_ACTIVE : BTN_SECONDARY}
                          >
                            {isEnabledForAgent ? t("skills.disableForAgent") : t("skills.enableForAgent")}
                          </button>

                          <div className="flex flex-wrap justify-end gap-2">
                            {primaryAction ? (
                              <button
                                type="button"
                                onClick={primaryAction.run}
                                disabled={
                                  marketplace.busySkillKey === entry.skill.skillKey ||
                                  (packageOnly && !marketplace.selectedAgentId) ||
                                  (primaryAction.label === t("skills.openSettings") &&
                                    !marketplace.selectedAgentId)
                                }
                                className={BTN_PRIMARY}
                              >
                                <PrimaryIcon className="h-3.5 w-3.5" />
                                {primaryAction.label}
                              </button>
                            ) : null}

                            {entry.removable ? (
                              <button
                                type="button"
                                onClick={() => void marketplace.handleRemoveSkill(entry.skill)}
                                disabled={marketplace.busySkillKey === entry.skill.skillKey}
                                className={BTN_DANGER}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                                {t("skills.removeForAll")}
                              </button>
                            ) : null}

                            <button
                              type="button"
                              onClick={() => setDetailSkillKey(entry.skill.skillKey)}
                              className={BTN_SECONDARY}
                            >
                              {t("skills.details")}
                            </button>
                          </div>
                        </div>
                      </div>
                      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-white/[0.06] pt-2 font-mono text-[10px] text-white/45">
                        <div className="inline-flex items-center gap-1.5">
                          <span
                            className={`h-1.5 w-1.5 rounded-full ${isEnabledForAgent ? "bg-red-500 shadow-[0_0_6px_rgba(255,26,26,0.8)]" : "bg-white/20"}`}
                            aria-hidden="true"
                          />
                          {isEnabledForAgent
                            ? t("skills.enabledForAgent")
                            : t("skills.disabledForAgent")}
                        </div>
                        {entry.removable ? (
                          <div>{t("skills.removeForAllNote")}</div>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
      </div>

      {detailEntry ? (
        <div className="absolute inset-0 z-10 flex flex-col bg-[#070404]/[0.97] backdrop-blur-sm">
          <div className="flex items-start justify-between border-b border-red-900/40 px-4 py-3">
            <div>
              <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-red-400">
                {t("skills.detail")}
              </div>
              <div className="mt-1 font-mono text-[15px] font-semibold text-white">
                {detailEntry.skill.name}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setDetailSkillKey(null)}
              className="rounded-md border border-red-900/40 bg-black/40 p-1.5 text-white/70 transition-colors hover:border-red-500/50 hover:bg-red-950/40 hover:text-white"
              aria-label={t("skills.closeDetail")}
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
            <div className={`${CARD} px-3 py-3`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className={`${CHIP} border-red-600/35 bg-red-600/15 text-white`}>
                  {detailEntry.metadata.category}
                </span>
                <span className={`${CHIP} border-red-900/40 bg-black/40 text-white/55`}>
                  {detailEntry.metadata.trustLabel}
                </span>
                <span className={`${CHIP} ${READINESS_CLASSES[detailEntry.readiness]}`}>
                  {READINESS_LABELS[detailEntry.readiness]}
                </span>
              </div>
              <div className="mt-3 font-mono text-[12px] leading-relaxed text-white/80">{detailEntry.metadata.tagline}</div>
              {detailEntry.metadata.poweredByName && detailEntry.metadata.poweredByUrl ? (
                <div className="mt-3 font-mono text-[10px] text-white/60">
                  {t("skills.poweredBy")}{" "}
                  <a
                    href={detailEntry.metadata.poweredByUrl}
                    target="_blank"
                    rel="noreferrer"
                    className={LINK}
                  >
                    {detailEntry.metadata.poweredByName}
                  </a>
                </div>
              ) : null}
              <div
                className={`mt-3 grid gap-2 font-mono text-[10px] tabular-nums text-white/55 ${
                  hasSkillMarketplaceStats(detailEntry.metadata) ? "grid-cols-3" : "grid-cols-1"
                }`}
              >
                {hasSkillMarketplaceStats(detailEntry.metadata) ? (
                  <>
                    <div className={TILE}>
                      <div className="uppercase tracking-[0.14em] text-white/45">{t("skills.rating")}</div>
                      <div className="mt-1 text-[13px] text-white">{formatRating(detailEntry.metadata.rating)}</div>
                    </div>
                    <div className={TILE}>
                      <div className="uppercase tracking-[0.14em] text-white/45">{t("skills.installs")}</div>
                      <div className="mt-1 text-[13px] text-white">{formatInstalls(detailEntry.metadata.installs)}</div>
                    </div>
                  </>
                ) : null}
                <div className={TILE}>
                  <div className="uppercase tracking-[0.14em] text-white/45">{t("skills.source")}</div>
                  <div className="mt-1 break-all text-[13px] text-white">{detailEntry.skill.source}</div>
                </div>
              </div>
            </div>

            <div className="mt-4">
              <div className={SECTION_LABEL}>
                {t("skills.capabilities")}
              </div>
              <div className="mt-2 flex flex-col gap-2">
                {detailEntry.metadata.capabilities.map((capability) => (
                  <div
                    key={capability}
                    className={`${CARD} flex items-center gap-2 px-3 py-2 font-mono text-[11px] text-white/80`}
                  >
                    <span className="h-1 w-1 shrink-0 rounded-full bg-red-500" aria-hidden="true" />
                    {capability}
                  </div>
                ))}
              </div>
            </div>

            {detailEntry.missingDetails.length > 0 ? (
              <div className="mt-4">
                <div className={SECTION_LABEL}>
                  {t("skills.setupNotes")}
                </div>
                <div className="mt-2 flex flex-col gap-2">
                  {detailEntry.missingDetails.map((line) => (
                    <div
                      key={line}
                      className="rounded-md border border-orange-400/25 bg-orange-500/[0.07] px-3 py-2 font-mono text-[10px] text-orange-300"
                    >
                      {line}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            <div className={`mt-4 ${NOTE}`}>
              {t("skills.packagedNote")}
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              {marketplace.packagedSkillsByKey.get(detailEntry.skill.skillKey) &&
              !detailEntry.skill.baseDir.trim() ? (
                <button
                  type="button"
                  onClick={() => void marketplace.handleInstallPackagedSkill(detailEntry.skill.skillKey)}
                  disabled={marketplace.busySkillKey === detailEntry.skill.skillKey}
                  className={`${BTN_PRIMARY} h-8`}
                >
                  <Download className="h-3.5 w-3.5" />
                  {t("skills.installSkill")}
                </button>
              ) : null}
              {detailEntry.readiness === "needs-setup" && detailEntry.installable ? (
                <button
                  type="button"
                  onClick={() => void marketplace.handleInstallSkill(detailEntry.skill)}
                  disabled={marketplace.busySkillKey === detailEntry.skill.skillKey}
                  className={`${BTN_PRIMARY} h-8`}
                >
                  <Download className="h-3.5 w-3.5" />
                  {t("skills.installDeps")}
                </button>
              ) : null}
              {detailEntry.readiness === "disabled-globally" ? (
                <button
                  type="button"
                  onClick={() =>
                    void marketplace.handleSetSkillGlobalEnabled(detailEntry.skill.skillKey, true)
                  }
                  disabled={marketplace.busySkillKey === detailEntry.skill.skillKey}
                  className={`${BTN_PRIMARY} h-8`}
                >
                  <Settings2 className="h-3.5 w-3.5" />
                  {t("skills.enableGateway")}
                </button>
              ) : null}
              <button
                type="button"
                disabled={!marketplace.selectedAgentId}
                onClick={() => {
                  if (marketplace.selectedAgentId) {
                    onOpenAgentSettings(marketplace.selectedAgentId);
                  }
                }}
                className={`${BTN_SECONDARY} h-8`}
              >
                <Settings2 className="h-3.5 w-3.5" />
                {t("skills.manageInSettings")}
              </button>
              {detailEntry.skill.homepage ? (
                <a
                  href={detailEntry.skill.homepage}
                  target="_blank"
                  rel="noreferrer"
                  className={`${BTN_SECONDARY} h-8`}
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  {t("skills.homepage")}
                </a>
              ) : null}
            </div>
            <div className={`mt-4 ${NOTE}`}>
              {t("skills.accessNote")}
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
