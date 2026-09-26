"use client";

import { useCallback, useEffect, useState } from "react";
import { Download, ExternalLink, Loader2, Star } from "lucide-react";

import { fetchJson } from "@/lib/http";
import { plural, t } from "@/lib/i18n";
import type { SkillRuntimeId } from "@/lib/skills/install/types";
import type {
  RegistrySkillSummary,
  SkillRegistryId,
} from "@/lib/skills/registry/types";

/**
 * Browses the remote skill sources and installs from them.
 *
 * Separate from the marketplace's local collections because it answers a
 * different question: those list what this gateway already has, this lists
 * what could be added.
 */

type RegistrySearchResult = {
  registry: SkillRegistryId;
  results: RegistrySkillSummary[];
  error: string | null;
};

const REGISTRY_LABELS: Record<SkillRegistryId, string> = {
  clawhub: "ClawHub",
  github: "GitHub",
};

const RUNTIME_LABELS: Record<SkillRuntimeId, string> = {
  openclaw: "OpenClaw",
  hermes: "Hermes",
};

const RUNTIMES: SkillRuntimeId[] = ["openclaw", "hermes"];

type InstallState =
  | { kind: "idle" }
  | { kind: "installing" }
  | { kind: "installed"; skillName: string }
  | { kind: "failed"; message: string };

// HQ palette pieces shared by the search row, runtime switch and result cards.
const BTN =
  "inline-flex items-center justify-center gap-1 rounded-md border font-mono text-[10px] uppercase tracking-[0.14em] transition-colors disabled:cursor-not-allowed disabled:opacity-50";
const BTN_PRIMARY = `${BTN} border-red-500/60 bg-[#e3141c] text-white shadow-[0_0_14px_rgba(255,26,26,0.25)] hover:border-red-400/70 hover:bg-[#ff2a2a] disabled:shadow-none`;
const MESSAGE_ERROR = "border-red-500/50 bg-red-950/40 text-red-400";

const formatCount = (value: number): string =>
  value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);

export function SkillRegistryBrowser() {
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sources, setSources] = useState<RegistrySearchResult[]>([]);
  const [runtime, setRuntime] = useState<SkillRuntimeId>("openclaw");
  const [installs, setInstalls] = useState<Record<string, InstallState>>({});

  const search = useCallback(async (term: string) => {
    setLoading(true);
    setError(null);
    try {
      const payload = await fetchJson<{ results: RegistrySearchResult[] }>(
        `/api/skills/registry?q=${encodeURIComponent(term)}&limit=20`,
      );
      setSources(payload.results);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("registry.searchFailed"));
      setSources([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void search(submitted);
  }, [search, submitted]);

  const install = async (entry: RegistrySkillSummary) => {
    const key = `${entry.registry}:${entry.slug}`;
    setInstalls((current) => ({ ...current, [key]: { kind: "installing" } }));
    try {
      const payload = await fetchJson<{ installed: { skillName: string } }>(
        "/api/skills/registry/install",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            registry: entry.registry,
            slug: entry.slug,
            version: entry.version,
            runtime,
          }),
        },
      );
      setInstalls((current) => ({
        ...current,
        [key]: { kind: "installed", skillName: payload.installed.skillName },
      }));
    } catch (err) {
      setInstalls((current) => ({
        ...current,
        [key]: {
          kind: "failed",
          message: err instanceof Error ? err.message : t("registry.installFailed"),
        },
      }));
    }
  };

  const anyResults = sources.some((source) => source.results.length > 0);

  return (
    <div className="space-y-3">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setSubmitted(query);
        }}
        className="flex gap-2"
      >
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("registry.searchPlaceholder")}
          aria-label={t("registry.searchLabel")}
          className="flex-1 rounded-md border border-red-900/50 bg-black/60 px-3 py-2 font-mono text-[11px] text-white outline-none transition placeholder:text-white/35 focus:border-red-500/70 focus:ring-1 focus:ring-red-500/30"
        />
        <button
          type="submit"
          disabled={loading}
          className={`${BTN_PRIMARY} px-3 py-2`}
        >
          {loading ? t("registry.searching") : t("registry.search")}
        </button>
      </form>

      <div className="flex flex-wrap items-center gap-2 font-mono text-[10px] uppercase tracking-[0.14em] text-white/45">
        <span>{t("registry.installInto")}</span>
        {RUNTIMES.map((candidate) => (
          <button
            key={candidate}
            type="button"
            onClick={() => setRuntime(candidate)}
            aria-pressed={runtime === candidate}
            className={`rounded-md border px-2 py-1 transition-colors ${
              runtime === candidate
                ? "border-red-500/60 bg-red-600/20 text-white"
                : "border-red-900/40 bg-black/40 text-white/55 hover:border-red-500/50 hover:bg-red-950/40 hover:text-white"
            }`}
          >
            {RUNTIME_LABELS[candidate]}
          </button>
        ))}
      </div>

      {error ? (
        <div className={`rounded-md border px-3 py-2 font-mono text-[11px] ${MESSAGE_ERROR}`}>
          {error}
        </div>
      ) : null}

      {sources
        .filter((source) => source.error)
        .map((source) => (
          <div
            key={`error-${source.registry}`}
            className="rounded-md border border-orange-400/30 bg-orange-500/[0.07] px-3 py-2 font-mono text-[11px] text-orange-300"
          >
            {t("registry.unavailable", {
              registry: REGISTRY_LABELS[source.registry],
              reason: source.error ?? "",
            })}
          </div>
        ))}

      {loading ? (
        <div className="flex items-center gap-2 font-mono text-[11px] text-white/45">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-red-400" aria-hidden="true" />
          {t("registry.searchingRegistries")}
        </div>
      ) : null}

      {!loading && !anyResults ? (
        <div className="rounded-md border border-red-900/40 bg-[#0b0707] px-3 py-4 text-center font-mono text-[11px] text-white/45">
          {submitted
            ? t("registry.nothingFound", { query: submitted })
            : t("registry.noSkills")}
        </div>
      ) : null}

      {sources.map((source) =>
        source.results.length === 0 ? null : (
          <section key={source.registry} className="space-y-2">
            <h4 className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.18em] text-white/45">
              <span className="h-px w-3 bg-red-600/70" aria-hidden="true" />
              {REGISTRY_LABELS[source.registry]}
              <span className="tabular-nums text-white/40">{source.results.length}</span>
            </h4>
            {source.results.map((entry) => {
              const key = `${entry.registry}:${entry.slug}`;
              const state = installs[key] ?? { kind: "idle" };
              return (
                <article
                  key={key}
                  className="rounded-md border border-red-900/40 bg-[#0b0707] p-3 transition-colors hover:border-red-600/35"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-white">
                        {entry.name}
                      </div>
                      <div className="truncate font-mono text-[10px] text-white/40">
                        {entry.slug}
                        {entry.version ? ` · ${entry.version}` : ""}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => void install(entry)}
                      disabled={state.kind === "installing"}
                      className={`${BTN_PRIMARY} shrink-0 px-2 py-1`}
                    >
                      {state.kind === "installing" ? (
                        <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                      ) : (
                        <Download className="h-3 w-3" aria-hidden="true" />
                      )}
                      {t("registry.install")}
                    </button>
                  </div>

                  {entry.description ? (
                    <p className="mt-2 text-xs leading-relaxed text-white/65">
                      {entry.description}
                    </p>
                  ) : null}

                  <div className="mt-2 flex flex-wrap items-center gap-3 font-mono text-[10px] tabular-nums text-white/45">
                    {/* Only shown when the registry actually published them. */}
                    {entry.downloads !== null ? (
                      <span>
                        {formatCount(entry.downloads)}{" "}
                        {plural(entry.downloads, ["загрузка", "загрузки", "загрузок"])}
                      </span>
                    ) : null}
                    {entry.stars !== null ? (
                      <span className="inline-flex items-center gap-1">
                        <Star className="h-3 w-3 fill-red-500/70 text-red-400" aria-hidden="true" />
                        {formatCount(entry.stars)}
                      </span>
                    ) : null}
                    {entry.homepageUrl ? (
                      <a
                        href={entry.homepageUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-red-300 transition-colors hover:text-white"
                      >
                        <ExternalLink className="h-3 w-3" aria-hidden="true" />
                        {t("registry.source")}
                      </a>
                    ) : null}
                  </div>

                  {state.kind === "installed" ? (
                    <div
                      role="status"
                      className="mt-2 flex items-center gap-1.5 rounded-md border border-red-500/40 bg-red-600/10 px-2 py-1 font-mono text-[10px] text-white"
                    >
                      <span
                        className="h-1.5 w-1.5 shrink-0 rounded-full bg-red-500 shadow-[0_0_6px_rgba(255,26,26,0.8)]"
                        aria-hidden="true"
                      />
                      {t("registry.installedAs", {
                        name: state.skillName,
                        runtime: RUNTIME_LABELS[runtime],
                      })}
                    </div>
                  ) : null}
                  {state.kind === "failed" ? (
                    <div className={`mt-2 rounded-md border px-2 py-1 font-mono text-[10px] ${MESSAGE_ERROR}`}>
                      {state.message}
                    </div>
                  ) : null}
                </article>
              );
            })}
          </section>
        ),
      )}
    </div>
  );
}
