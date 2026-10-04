"use client";

import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Music2,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  Volume1,
  type LucideIcon,
} from "lucide-react";
import { HqAndroidLoader } from "@/features/agents/components/HqAndroidLoader";
import { useJukeboxStore } from "../store";
import {
  startSpotifyAuth,
  buildRedirectUri,
  loadToken,
  exchangeCodeForToken,
  loadCallbackBaseUrl,
  saveCallbackBaseUrl,
  loadAuthState,
} from "../auth";
import type { SpotifyTrack } from "../spotifyApi";
import { t } from "@/lib/i18n";

type JukeboxPanelProps = {
  onClose: () => void;
  selectedAgentName?: string | null;
  client?: unknown;
};

// ---------------------------------------------------------------------------
// Root panel
// ---------------------------------------------------------------------------

export function JukeboxPanel({ onClose }: JukeboxPanelProps) {
  const { view, init } = useJukeboxStore();

  useEffect(() => {
    init();
    const handleMessage = (event: MessageEvent) => {
      const callbackBaseUrl = loadCallbackBaseUrl();
      if (!callbackBaseUrl) return;
      const callbackOrigin = new URL(callbackBaseUrl).origin;
      if (event.origin !== callbackOrigin) return;
      const payload = event.data as
        | {
            type?: string;
            code?: string;
            error?: string;
            state?: string;
          }
        | undefined;
      if (!payload || payload.type !== "soundclaw-spotify-auth") return;
      if (payload.error) return;
      if (!payload.code) return;
      if (payload.state !== loadAuthState()) return;

      const { clientId, setToken } = useJukeboxStore.getState();
      void exchangeCodeForToken(payload.code, clientId, buildRedirectUri(callbackBaseUrl)).then(
        (ok) => {
          if (!ok) return;
          const token = loadToken();
          if (token) setToken(token);
        },
      );
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [init]);

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm">
      <div
        className="w-full max-w-2xl overflow-hidden rounded-xl border border-red-600/35 bg-[#070404]/[0.98] text-white shadow-[0_0_48px_rgba(255,26,26,0.12)]"
        style={{ maxHeight: "90vh" }}
      >
        {/* Header. */}
        <div className="flex items-center justify-between border-b border-red-900/40 bg-gradient-to-r from-red-950/30 via-transparent to-transparent px-6 py-4">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-md border border-red-600/35 bg-red-600/15 text-red-400">
              <Music2 className="h-4 w-4" aria-hidden="true" />
            </span>
            <div>
              <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-red-400">
                Soundclaw
              </div>
              <h2 className="text-base font-semibold text-white">{t("jukebox.title")}</h2>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-red-900/40 bg-black/40 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-white/80 transition hover:border-red-500/50 hover:bg-red-950/40 hover:text-white"
          >
            {t("common.close")}
          </button>
        </div>

        {/* Body. */}
        <div className="overflow-y-auto" style={{ maxHeight: "calc(90vh - 68px)" }}>
          {view === "setup" ? <SetupView /> : <PlayerView />}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Setup view — shown before the user authenticates
// ---------------------------------------------------------------------------

function SetupView() {
  const { clientId, setClientId } = useJukeboxStore();
  const [inputId, setInputId] = useState(clientId);
  const [callbackBaseUrl, setCallbackBaseUrl] = useState(() => loadCallbackBaseUrl());
  const [isRedirecting, setIsRedirecting] = useState(false);
  const redirectUri = buildRedirectUri(callbackBaseUrl);
  const localhostOrigin =
    typeof window !== "undefined" ? `${window.location.protocol}//${window.location.host}` : "";
  const callbackLooksValid = /^https:\/\/.+/i.test(callbackBaseUrl.trim());

  const handleConnect = async () => {
    if (!inputId.trim() || !redirectUri) return;
    saveCallbackBaseUrl(callbackBaseUrl);
    setClientId(inputId.trim());
    setIsRedirecting(true);
    const popup = window.open(
      "",
      "soundclaw-spotify-auth",
      "popup=yes,width=520,height=760,resizable=yes,scrollbars=yes",
    );
    if (!popup) {
      setIsRedirecting(false);
      return;
    }
    popup.document.write(
      // Dark like the HQ, so the popup does not flash white before Spotify loads.
      `<body style="margin: 0; background: #050404; color: #fff;"><p style="font-family: sans-serif; padding: 24px;">${t("jukebox.redirecting")}</p></body>`,
    );
    await startSpotifyAuth(inputId.trim(), redirectUri, popup);
    setIsRedirecting(false);
  };

  return (
    <div className="space-y-6 p-6">
      <div className="rounded-md border border-red-900/40 border-l-2 border-l-red-600/70 bg-red-950/20 px-4 py-3 text-sm text-white/75">
        {t("jukebox.keepOpen1")}{" "}
        <code className="rounded bg-black/60 px-1 text-red-300">{localhostOrigin}</code>.{" "}
        {t("jukebox.keepOpen2")}
      </div>

      {!callbackLooksValid && callbackBaseUrl.trim().length > 0 && (
        <div className="rounded-md border border-red-500/50 bg-red-950/40 px-4 py-3 text-sm text-red-400">
          {t("jukebox.invalidUrl")} <code className="rounded bg-black/60 px-1 text-red-300">https://your-id.ngrok-free.app</code>.
        </div>
      )}

      {/* What you need card. */}
      <div className="rounded-lg border border-red-900/40 bg-[#0b0707] p-5">
        <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-white">
          <AlertTriangle className="h-4 w-4 text-orange-300" aria-hidden="true" /> {t("jukebox.needBefore")}
        </h3>
        <ol className="space-y-3 text-sm text-white/75">
          <li className="flex gap-2">
            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-red-500/50 bg-red-600/20 font-mono text-[11px] font-bold tabular-nums text-white">1</span>
            <span>
              {t("jukebox.step1Go")}{" "}
              <a
                href="https://developer.spotify.com/dashboard"
                target="_blank"
                rel="noreferrer"
                className="text-red-300 underline decoration-red-500/40 underline-offset-2 transition-colors hover:text-white"
              >
                developer.spotify.com/dashboard
              </a>{" "}
              {t("jukebox.step1Create")}
            </span>
          </li>
          <li className="flex gap-2">
            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-red-500/50 bg-red-600/20 font-mono text-[11px] font-bold tabular-nums text-white">2</span>
            <span>
              {t("jukebox.step2")} <strong className="text-white">Redirect URI</strong>:
            </span>
          </li>
          {redirectUri && (
            <li className="ml-7">
              <code className="block w-full break-all rounded-md border border-red-600/35 bg-black/60 px-3 py-2 font-mono text-xs text-red-300">
                {redirectUri}
              </code>
              <button
                type="button"
                onClick={() => navigator.clipboard.writeText(redirectUri)}
                className="mt-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-white/45 transition-colors hover:text-red-300"
              >
                {t("jukebox.copy")}
              </button>
            </li>
          )}
          <li className="flex gap-2">
            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-red-500/50 bg-red-600/20 font-mono text-[11px] font-bold tabular-nums text-white">3</span>
            <span>{t("jukebox.step3")}</span>
          </li>
          <li className="flex gap-2">
            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-red-500/50 bg-red-600/20 font-mono text-[11px] font-bold tabular-nums text-white">4</span>
            <span>{t("jukebox.step4")}</span>
          </li>
          <li className="flex gap-2">
            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-red-500/50 bg-red-600/20 font-mono text-[11px] font-bold tabular-nums text-white">5</span>
            <span>{t("jukebox.step5")}</span>
          </li>
        </ol>
      </div>

      <div className="space-y-2">
        <label className="block font-mono text-[10px] uppercase tracking-[0.16em] text-white/55">
          {t("jukebox.ngrokUrl")}
        </label>
        <input
          type="url"
          value={callbackBaseUrl}
          onChange={(e) => setCallbackBaseUrl(e.target.value)}
          placeholder="https://your-id.ngrok-free.app"
          className="w-full rounded-md border border-red-900/50 bg-black/60 px-4 py-2.5 font-mono text-sm text-white placeholder:text-white/35 focus:border-red-500/70 focus:outline-none focus:ring-1 focus:ring-red-500/30"
        />
        <p className="text-xs text-white/45">
          {t("jukebox.ngrokHint", { origin: localhostOrigin })}
        </p>
      </div>

      {/* Client ID input. */}
      <div className="space-y-2">
        <label className="block font-mono text-[10px] uppercase tracking-[0.16em] text-white/55">
          {t("jukebox.clientId")}
        </label>
        <input
          type="text"
          value={inputId}
          onChange={(e) => setInputId(e.target.value)}
          placeholder="e.g. 1a2b3c4d5e6f…"
          className="w-full rounded-md border border-red-900/50 bg-black/60 px-4 py-2.5 font-mono text-sm text-white placeholder:text-white/35 focus:border-red-500/70 focus:outline-none focus:ring-1 focus:ring-red-500/30"
        />
        <p className="text-xs text-white/45">
          {t("jukebox.clientIdHint")}
        </p>
      </div>

      <button
        type="button"
        disabled={!inputId.trim() || !redirectUri || !callbackLooksValid || isRedirecting}
        onClick={handleConnect}
        className="w-full rounded-md border border-red-500/60 bg-[#e3141c] py-3 text-sm font-semibold text-white shadow-[0_0_14px_rgba(255,26,26,0.25)] transition hover:border-red-400/70 hover:bg-[#ff2a2a] active:scale-[.98] disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
      >
        {isRedirecting ? t("jukebox.opening") : t("jukebox.connect")}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Player view — shown after authentication
// ---------------------------------------------------------------------------

function PlayerView() {
  const {
    playerState,
    searchResults,
    searchQuery,
    isSearching,
    isLoadingPlayer,
    error,
    refreshPlayer,
    search,
    setSearchQuery,
    play,
    pause,
    resume,
    next,
    previous,
    volume,
    disconnect,
  } = useJukeboxStore();

  const searchDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Poll player state every 5 seconds.
  useEffect(() => {
    refreshPlayer();
    const id = window.setInterval(() => { void refreshPlayer(); }, 5000);
    return () => window.clearInterval(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSearchChange = (value: string) => {
    setSearchQuery(value);
    if (searchDebounce.current) clearTimeout(searchDebounce.current);
    searchDebounce.current = setTimeout(() => {
      if (value.trim()) void search(value);
    }, 400);
  };

  const track = playerState?.track;
  const albumArt = track?.album.images[0]?.url ?? null;

  return (
    <div className="flex flex-col gap-4 p-6">
      {error && (
        <div className="rounded-md border border-red-500/50 bg-red-950/40 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* Now playing. */}
      <div className="rounded-lg border border-red-900/40 bg-[#0b0707] p-4">
        <div className="mb-3 font-mono text-[10px] uppercase tracking-[0.2em] text-white/45">
          {t("jukebox.nowPlayingTitle")}
        </div>
        {isLoadingPlayer && !track ? (
          <div className="flex items-center gap-3 text-white/45">
            <HqAndroidLoader size={16} inline />
            <span className="text-sm">{t("jukebox.loadingPlayer")}</span>
          </div>
        ) : track ? (
          <div className="flex items-center gap-4">
            {albumArt && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={albumArt}
                alt={track.album.name}
                className="h-14 w-14 shrink-0 rounded-md border border-red-900/40 object-cover shadow-[0_0_14px_rgba(255,26,26,0.2)]"
              />
            )}
            <div className="min-w-0 flex-1">
              <div className="truncate font-semibold text-white">{track.name}</div>
              <div className="truncate text-sm text-white/65">
                {track.artists.map((a) => a.name).join(", ")}
              </div>
              <div className="truncate text-xs text-white/40">{track.album.name}</div>
            </div>
          </div>
        ) : (
          <p className="text-sm text-white/45">
            {t("jukebox.noPlayback")}
          </p>
        )}

        {/* Transport controls. */}
        <div className="mt-4 flex items-center justify-center gap-4">
          <ControlButton icon={SkipBack} onClick={() => void previous()} title={t("jukebox.previous")} />
          {playerState?.isPlaying ? (
            <ControlButton icon={Pause} onClick={() => void pause()} title={t("jukebox.pause")} large />
          ) : (
            <ControlButton icon={Play} onClick={() => void resume()} title={t("jukebox.play")} large />
          )}
          <ControlButton icon={SkipForward} onClick={() => void next()} title={t("jukebox.next")} />
        </div>

        {/* Volume. */}
        {playerState && (
          <div className="mt-4 flex items-center gap-3">
            <Volume1 className="h-4 w-4 shrink-0 text-white/45" aria-hidden="true" />
            <input
              type="range"
              min={0}
              max={100}
              value={playerState.volumePercent}
              onChange={(e) => void volume(Number(e.target.value))}
              className="h-1.5 w-full cursor-pointer accent-red-600"
            />
            <span className="w-8 text-right font-mono text-xs tabular-nums text-white/45">
              {playerState.volumePercent}%
            </span>
          </div>
        )}
      </div>

      {/* Search. */}
      <div>
        <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.2em] text-white/45">
          {t("jukebox.searchTracks")}
        </div>
        <div className="relative">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => handleSearchChange(e.target.value)}
            placeholder={t("jukebox.searchPlaceholder")}
            className="w-full rounded-md border border-red-900/50 bg-black/60 py-2.5 pl-4 pr-10 text-sm text-white placeholder:text-white/35 focus:border-red-500/70 focus:outline-none focus:ring-1 focus:ring-red-500/30"
          />
          {isSearching && (
            <div className="absolute right-3 top-1/2 -translate-y-1/2">
            <HqAndroidLoader size={14} />
            </div>
          )}
        </div>

        {searchResults.length > 0 && (
          <ul className="mt-2 divide-y divide-red-900/30 overflow-hidden rounded-md border border-red-900/40 bg-[#0b0707]">
            {searchResults.map((track) => (
              <SearchResult key={track.id} track={track} onPlay={() => void play(track.uri)} />
            ))}
          </ul>
        )}
      </div>

      {/* Disconnect. */}
      <div className="pt-2 text-center">
        <button
          type="button"
          onClick={disconnect}
          className="text-xs text-white/40 underline decoration-red-500/40 underline-offset-2 transition-colors hover:text-red-300"
        >
          {t("jukebox.disconnect")}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ControlButton({
  icon: Icon,
  onClick,
  title,
  large,
}: {
  icon: LucideIcon;
  onClick: () => void;
  title: string;
  large?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      aria-label={title}
      className={`flex items-center justify-center rounded-full border text-white transition active:scale-95 ${
        large
          ? "h-11 w-11 border-red-500/60 bg-[#e3141c] shadow-[0_0_14px_rgba(255,26,26,0.3)] hover:bg-[#ff2a2a]"
          : "h-9 w-9 border-red-900/40 bg-black/40 hover:border-red-500/50 hover:bg-red-950/40"
      }`}
    >
      <Icon className={large ? "h-5 w-5" : "h-4 w-4"} aria-hidden="true" />
    </button>
  );
}

function SearchResult({
  track,
  onPlay,
}: {
  track: SpotifyTrack;
  onPlay: () => void;
}) {
  const art = track.album.images[track.album.images.length - 1]?.url ?? null;
  return (
    <li className="flex items-center gap-3 px-4 py-3 transition hover:bg-red-950/30">
      {art && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={art} alt={track.album.name} className="h-9 w-9 shrink-0 rounded object-cover" />
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-white">{track.name}</div>
        <div className="truncate text-xs text-white/55">
          {track.artists.map((a) => a.name).join(", ")} · {track.album.name}
        </div>
      </div>
      <button
        type="button"
        onClick={onPlay}
        className="shrink-0 rounded-md border border-red-500/50 bg-red-600/15 px-3 py-1 font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-white transition hover:border-red-400/70 hover:bg-red-600/30"
      >
        {t("jukebox.play")}
      </button>
    </li>
  );
}
