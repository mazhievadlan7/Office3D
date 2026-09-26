"use client";

import { useEffect } from "react";
import { t } from "@/lib/i18n";

export default function SpotifyCallbackPage() {
  useEffect(() => {
    const url = new URL(window.location.href);
    const code = url.searchParams.get("code") ?? "";
    const state = url.searchParams.get("state") ?? "";
    const error = url.searchParams.get("error") ?? "";

    if (window.opener && !window.opener.closed) {
      window.opener.postMessage(
        {
          type: "soundclaw-spotify-auth",
          code,
          state,
          error,
        },
        "*",
      );
      window.close();
    }
  }, []);

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#050404] p-6 text-white">
      <div className="w-full max-w-md rounded-xl border border-red-600/35 bg-[#0b0707]/95 p-8 text-center shadow-[0_0_48px_rgba(255,26,26,0.12)]">
        <div className="mb-2 flex items-center justify-center gap-2 font-mono text-[10px] uppercase tracking-[0.24em] text-red-400">
          <span
            className="h-1.5 w-1.5 animate-pulse rounded-full bg-red-500 shadow-[0_0_8px_rgba(255,26,26,0.9)]"
            aria-hidden="true"
          />
          Soundclaw
        </div>
        <h1 className="text-xl font-semibold text-white">{t("jukebox.finishingSignIn")}</h1>
        <p className="mt-3 text-sm text-white/65">
          {t("jukebox.closeWindow")}
        </p>
      </div>
    </main>
  );
}
