"use client";

import { useState } from "react";
import { X, MessageSquare } from "lucide-react";
import * as CesiumNS from "cesium";

import { HQ_HUD_GLASS, hqHudButtonClass } from "@/features/hq/hud/hudStyle";
import { askAnalyst, type AnalystAnswer } from "./analyst";

export type HqGeoAnalystProps = {
  viewer: CesiumNS.Viewer | null;
  /** Optional focus point (shift-click passes observer); passed to "ближайший …" queries. */
  focus: { lat: number; lon: number } | null;
  /** When a hit is clicked the view flies there. */
  onFly?: (lat: number, lon: number) => void;
};

const SUGGESTIONS = [
  "сколько рейсов",
  "сколько спутников",
  "землетрясения сильнее 5",
  "плотины мощнее 5000 МВт",
  "ближайший спутник от Москвы",
  "сколько пусков",
];

/**
 * «Аналитик» — a tiny chat-style input beside the globe. The owner (or an
 * agent) types a question in Russian ("сколько рейсов", "ближайший спутник
 * от Москвы", "землетрясения сильнее 5"), the analyst answers from live data
 * on the view (no LLM, no network — see analyst.ts). Hits in the answer are
 * clickable; clicking one flies the camera.
 */
export function HqGeoAnalyst({ viewer, focus, onFly }: HqGeoAnalystProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [answer, setAnswer] = useState<AnalystAnswer | null>(null);

  const ask = (text: string) => {
    const next = askAnalyst(viewer, text, focus);
    setAnswer(next);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`h-8 px-2.5 font-mono text-[11px] ${hqHudButtonClass(open)}`}
        title="Аналитик: спроси про рейсы, спутники, землетрясения — ответит с живых данных"
      >
        <MessageSquare className="mr-1 inline h-3.5 w-3.5" />
        Аналитик
      </button>
      {open ? (
        <div className={`absolute right-3 top-40 z-10 w-[320px] overflow-hidden ${HQ_HUD_GLASS}`}>
          <header className="flex items-center justify-between gap-2 border-b border-white/10 bg-black/60 px-3 py-2">
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-amber-200">
              Аналитик
            </span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Закрыть"
              className="text-white/60 hover:text-white"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </header>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              ask(query);
            }}
            className="flex items-center gap-1.5 border-b border-white/10 bg-black/40 px-2 py-1.5"
          >
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="сколько рейсов…"
              className="h-7 flex-1 bg-transparent px-1.5 font-mono text-[11px] text-white placeholder:text-white/35 focus:outline-none"
            />
            <button
              type="submit"
              className="h-7 rounded border border-amber-500/50 bg-amber-500/15 px-2 font-mono text-[10px] uppercase tracking-[0.1em] text-amber-200"
            >
              Спросить
            </button>
          </form>
          <div className="flex flex-wrap gap-1 px-2 py-1.5">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => {
                  setQuery(s);
                  ask(s);
                }}
                className="rounded border border-white/10 bg-white/5 px-1.5 py-0.5 font-mono text-[9px] text-white/70 hover:border-white/30 hover:text-white"
              >
                {s}
              </button>
            ))}
          </div>
          {answer ? (
            <div className="border-t border-white/5 px-3 py-2">
              <div className="font-mono text-[11px] text-white/90">{answer.text}</div>
              {answer.hits.length ? (
                <ul className="mt-1.5 max-h-[220px] space-y-0.5 overflow-y-auto">
                  {answer.hits.map((h) => (
                    <li key={h.id}>
                      <button
                        type="button"
                        onClick={() => {
                          if (h.lat != null && h.lon != null) onFly?.(h.lat, h.lon);
                        }}
                        className="w-full truncate text-left font-mono text-[10px] text-white/70 hover:text-white"
                      >
                        · {h.title}
                        {h.value != null ? (
                          <span className="ml-1 text-white/50">
                            {h.value}
                            {h.valueUnit ? ` ${h.valueUnit}` : ""}
                          </span>
                        ) : null}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
