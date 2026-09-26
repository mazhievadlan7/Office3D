"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { t } from "@/lib/i18n";
import { useHermesControl } from "@/features/hermes/HermesControlContext";

type Announcement = { agentId: string; name: string; text: string; at: string };

const SHOW_MS = 15_000;

/** What the main agent announces to the office, shown for a while at the top. */
export function AnnouncementToast() {
  const control = useHermesControl();
  const [current, setCurrent] = useState<Announcement | null>(null);

  useEffect(() => {
    if (!control) return;
    return control.onEvent((frame) => {
      if (frame.event !== "org.announcement") return;
      const payload = frame.payload as Partial<Announcement> | undefined;
      if (typeof payload?.text !== "string" || !payload.text.trim()) return;
      setCurrent({
        agentId: String(payload.agentId ?? "main"),
        name: String(payload.name ?? "Hermes"),
        text: payload.text,
        at: String(payload.at ?? new Date().toISOString()),
      });
    });
  }, [control]);

  useEffect(() => {
    if (!current) return;
    const timer = window.setTimeout(() => setCurrent(null), SHOW_MS);
    return () => window.clearTimeout(timer);
  }, [current]);

  if (!control || !current) return null;
  return (
    <div className="pointer-events-none fixed left-1/2 top-28 z-40 w-full max-w-xl -translate-x-1/2 px-4" role="status">
      <div className="pointer-events-auto rounded-lg border border-red-500/50 border-l-2 border-l-red-500 bg-black/85 px-4 py-3 shadow-[0_0_24px_rgba(255,26,26,0.2)] backdrop-blur">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.16em] text-red-400">
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full bg-red-500 shadow-[0_0_8px_rgba(255,26,26,0.9)]"
                aria-hidden="true"
              />
              {t("announcement.title", { name: current.name })}
            </div>
            <div className="mt-1 whitespace-pre-wrap text-sm text-white">{current.text}</div>
          </div>
          <button
            type="button"
            className="rounded p-0.5 text-white/50 transition-colors hover:bg-red-950/40 hover:text-white"
            aria-label={t("announcement.dismiss")}
            onClick={() => setCurrent(null)}
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
}
