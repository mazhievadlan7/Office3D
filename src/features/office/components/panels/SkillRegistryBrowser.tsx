"use client";

import { useCallback, useEffect, useState } from "react";
import { Download, ExternalLink, Loader2, Star } from "lucide-react";

import { fetchJson } from "@/lib/http";
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
      setError(err instanceof Error ? err.message : "Search failed.");
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
          message: err instanceof Error ? err.message : "Install failed.",
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
          placeholder="Search ClawHub and GitHub, or leave empty to browse"
          aria-label="Search skill registries"
          className="flex-1 rounded border border-white/10 bg-black/40 px-3 py-2 font-mono text-[11px] text-white/85 outline-none transition focus:border-cyan-400/35"
        />
        <button
          type="submit"
          disabled={loading}
          className="rounded border border-cyan-400/30 bg-cyan-500/10 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.14em] text-cyan-100 transition-colors hover:bg-cyan-500/20 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? "Searching" : "Search"}
        </button>
      </form>

      <div className="flex flex-wrap items-center gap-2 font-mono text-[10px] uppercase tracking-[0.14em] text-white/45">
        <span>Install into</span>
        {RUNTIMES.map((candidate) => (
          <button
            key={candidate}
            type="button"
            onClick={() => setRuntime(candidate)}
            className={`rounded border px-2 py-1 transition-colors ${
              runtime === candidate
                ? "border-cyan-400/35 bg-cyan-500/10 text-cyan-100"
                : "border-white/10 bg-white/[0.03] text-white/45 hover:text-white/80"
            }`}
          >
            {RUNTIME_LABELS[candidate]}
          </button>
        ))}
      </div>

      {error ? (
        <div className="rounded border border-rose-500/30 bg-rose-500/10 px-3 py-2 font-mono text-[11px] text-rose-100">
          {error}
        </div>
      ) : null}

      {sources
        .filter((source) => source.error)
        .map((source) => (
          <div
            key={`error-${source.registry}`}
            className="rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 font-mono text-[11px] text-amber-100"
          >
            {REGISTRY_LABELS[source.registry]} is unavailable: {source.error}
          </div>
        ))}

      {loading ? (
        <div className="flex items-center gap-2 font-mono text-[11px] text-white/45">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          Searching registries…
        </div>
      ) : null}

      {!loading && !anyResults ? (
        <div className="rounded border border-white/8 bg-black/30 px-3 py-4 text-center font-mono text-[11px] text-white/45">
          {submitted ? `Nothing found for "${submitted}".` : "No skills returned."}
        </div>
      ) : null}

      {sources.map((source) =>
        source.results.length === 0 ? null : (
          <section key={source.registry} className="space-y-2">
            <h4 className="font-mono text-[10px] uppercase tracking-[0.18em] text-white/45">
              {REGISTRY_LABELS[source.registry]} ({source.results.length})
            </h4>
            {source.results.map((entry) => {
              const key = `${entry.registry}:${entry.slug}`;
              const state = installs[key] ?? { kind: "idle" };
              return (
                <article
                  key={key}
                  className="rounded-lg border border-white/8 bg-black/35 p-3"
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
                      className="inline-flex shrink-0 items-center gap-1 rounded border border-cyan-400/30 bg-cyan-500/10 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-cyan-100 transition-colors hover:bg-cyan-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {state.kind === "installing" ? (
                        <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                      ) : (
                        <Download className="h-3 w-3" aria-hidden="true" />
                      )}
                      Install
                    </button>
                  </div>

                  {entry.description ? (
                    <p className="mt-2 text-xs leading-relaxed text-white/60">
                      {entry.description}
                    </p>
                  ) : null}

                  <div className="mt-2 flex flex-wrap items-center gap-3 font-mono text-[10px] text-white/45">
                    {/* Only shown when the registry actually published them. */}
                    {entry.downloads !== null ? (
                      <span>{formatCount(entry.downloads)} downloads</span>
                    ) : null}
                    {entry.stars !== null ? (
                      <span className="inline-flex items-center gap-1">
                        <Star className="h-3 w-3 text-amber-300" aria-hidden="true" />
                        {formatCount(entry.stars)}
                      </span>
                    ) : null}
                    {entry.homepageUrl ? (
                      <a
                        href={entry.homepageUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-cyan-200/80 hover:text-cyan-100"
                      >
                        <ExternalLink className="h-3 w-3" aria-hidden="true" />
                        Source
                      </a>
                    ) : null}
                  </div>

                  {state.kind === "installed" ? (
                    <div className="mt-2 rounded border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 font-mono text-[10px] text-emerald-100">
                      Installed as {state.skillName} for {RUNTIME_LABELS[runtime]}.
                    </div>
                  ) : null}
                  {state.kind === "failed" ? (
                    <div className="mt-2 rounded border border-rose-500/30 bg-rose-500/10 px-2 py-1 font-mono text-[10px] text-rose-100">
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
