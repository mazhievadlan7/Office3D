"use client";

import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";

import { HQ_HUD_GLASS } from "@/features/hq/hud/hudStyle";
import { findNextPasses, parseTleBundle, type SatPass, type Tle } from "./satellitePasses";

export type HqGeoPassesPanelProps = {
  /** The observer point the panel asks about. */
  observer: { lat: number; lon: number } | null;
  /** Dismiss the panel. */
  onClose: () => void;
};

/**
 * «Пролёты» — the panel that answers "when does any loaded satellite rise over
 * this point". Loads the same CelesTrak TLE bundle the live Satellites layer
 * uses (through our geo proxy, so it is cached once at the server) and
 * computes next passes with satellitePasses.ts. Pure math, no persistent
 * state — the panel just displays what buildReport-style questions already
 * return.
 */
export function HqGeoPassesPanel({ observer, onClose }: HqGeoPassesPanelProps) {
  const [tles, setTles] = useState<Tle[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Load the TLE bundle once; it's cached for an hour on the server side.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const response = await fetch("/api/geo/live?source=satellites-visual", { cache: "force-cache" });
        if (!response.ok) throw new Error(`TLE ${response.status}`);
        const text = await response.text();
        if (!alive) return;
        setTles(parseTleBundle(text));
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const passes = useMemo<SatPass[]>(() => {
    if (!observer || !tles) return [];
    return findNextPasses(tles, observer, { horizonHours: 24, limit: 10, stepSeconds: 30 });
  }, [observer, tles]);

  if (!observer) return null;

  return (
    <div className={`absolute bottom-20 right-3 z-10 w-[320px] overflow-hidden ${HQ_HUD_GLASS}`}>
      <header className="flex items-center justify-between gap-2 border-b border-white/10 bg-black/60 px-3 py-2">
        <div className="min-w-0">
          <div className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-amber-200">
            Пролёты спутников
          </div>
          <div className="truncate font-mono text-[10px] text-white/60">
            φ {observer.lat.toFixed(3)}°, λ {observer.lon.toFixed(3)}° · горизонт 24 ч
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Закрыть"
          className="flex h-5 w-5 shrink-0 items-center justify-center text-white/60 hover:text-white"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </header>
      {!tles && !error ? (
        <div className="px-3 py-4 font-mono text-[10px] text-white/55">Считаем пролёты…</div>
      ) : null}
      {error ? (
        <div className="px-3 py-4 font-mono text-[10px] text-red-300/80">Не загрузились TLE: {error}</div>
      ) : null}
      {tles && passes.length === 0 ? (
        <div className="px-3 py-4 font-mono text-[10px] text-white/55">
          В ближайшие 24 часа видимых пролётов выше 10° нет.
        </div>
      ) : null}
      {passes.length ? (
        <ul className="max-h-[320px] divide-y divide-white/5 overflow-y-auto">
          {passes.map((pass, i) => (
            <li key={`${pass.satId}-${i}`} className="px-3 py-2 font-mono text-[11px]">
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate text-white/90">{pass.satName}</span>
                {pass.visibleToEye ? (
                  <span className="shrink-0 rounded border border-amber-500/50 bg-amber-500/15 px-1 py-[1px] text-[9px] uppercase tracking-[0.1em] text-amber-200">
                    видно
                  </span>
                ) : null}
              </div>
              <div className="mt-0.5 flex items-center justify-between gap-2 text-[10px] text-white/55">
                <span>восход {new Date(pass.riseAt).toLocaleTimeString("ru-RU")}</span>
                <span>макс. {pass.peakElevationDeg}°</span>
                <span>закат {new Date(pass.setAt).toLocaleTimeString("ru-RU")}</span>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
