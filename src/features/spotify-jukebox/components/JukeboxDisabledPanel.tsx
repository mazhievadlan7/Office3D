"use client";

import { Music2 } from "lucide-react";

import { t } from "@/lib/i18n";

type JukeboxDisabledPanelProps = {
  onClose: () => void;
  onInstall: () => void;
};

export function JukeboxDisabledPanel({ onClose, onInstall }: JukeboxDisabledPanelProps) {
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-xl border border-red-600/35 bg-[#070404]/95 p-8 text-center shadow-[0_0_48px_rgba(255,26,26,0.12)]">
        {/* Jukebox icon. */}
        <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-lg border border-red-600/35 bg-red-600/15 text-red-400 shadow-[0_0_14px_rgba(255,26,26,0.2)]">
          <Music2 className="h-8 w-8" aria-hidden="true" />
        </div>

        <div className="font-mono text-[10px] uppercase tracking-[0.24em] text-red-400">
          Soundclaw
        </div>
        <h2 className="mt-1 text-xl font-semibold text-white">{t("jukebox.notInstalled")}</h2>
        <p className="mt-3 text-sm leading-relaxed text-white/65">
          {t("jukebox.installLead1")} <span className="font-mono text-red-300">SOUNDCLAW</span>{" "}
          {t("jukebox.installLead2")}
        </p>

        <div className="mt-6 flex flex-col gap-3">
          <button
            type="button"
            className="rounded-md border border-red-500/60 bg-[#e3141c] px-5 py-2.5 text-sm font-semibold text-white shadow-[0_0_14px_rgba(255,26,26,0.25)] transition hover:border-red-400/70 hover:bg-[#ff2a2a] active:scale-95"
            onClick={onInstall}
          >
            {t("jukebox.installSkill")}
          </button>
          <button
            type="button"
            className="rounded-md border border-red-900/40 bg-black/40 px-5 py-2.5 text-sm text-white/75 transition hover:border-red-500/50 hover:bg-red-950/40 hover:text-white"
            onClick={onClose}
          >
            {t("jukebox.dismiss")}
          </button>
        </div>
      </div>
    </div>
  );
}
