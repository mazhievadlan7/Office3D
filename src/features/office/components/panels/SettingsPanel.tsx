"use client";

import { useState } from "react";
import { CURATED_ELEVENLABS_VOICES } from "@/lib/voiceReply/catalog";
import type { VoiceSetup } from "@/lib/voice/agentVoices";
import type { StudioGatewayAdapterType } from "@/lib/studio/settings";
import { t } from "@/lib/i18n";
import { adapterLabel } from "@/lib/i18n/labels";
import { useHermesControl } from "@/features/hermes/HermesControlContext";
import { HermesModelsPanel } from "@/features/hermes/components/HermesModelsPanel";

// Spelled out rather than looked up by building a key: a key assembled at
// runtime is invisible to the check that finds unused and missing phrases.
const GATEWAY_STATUS_LABELS: Record<string, string> = {
  connected: t("settings.gatewayStatusConnected"),
  connecting: t("settings.gatewayStatusConnecting"),
  disconnected: t("settings.gatewayStatusDisconnected"),
};

export type SettingsPanelProps = {
  gatewayStatus?: string;
  gatewayUrl?: string;
  gatewayToken?: string;
  selectedAdapterType?: StudioGatewayAdapterType;
  activeAdapterType?: StudioGatewayAdapterType;
  onGatewayDisconnect?: () => void;
  onGatewayConnect?: () => void;
  onGatewayUrlChange?: (value: string) => void;
  onGatewayTokenChange?: (value: string) => void;
  onGatewayAdapterTypeChange?: (value: StudioGatewayAdapterType) => void;
  onOpenOnboarding?: () => void;
  officeTitle: string;
  officeTitleLoaded: boolean;
  onOfficeTitleChange: (title: string) => void;
  remoteOfficeEnabled: boolean;
  remoteOfficeSourceKind: "presence_endpoint" | "openclaw_gateway";
  remoteOfficeLabel: string;
  remoteOfficePresenceUrl: string;
  remoteOfficeGatewayUrl: string;
  remoteOfficeTokenConfigured: boolean;
  onRemoteOfficeEnabledChange: (enabled: boolean) => void;
  onRemoteOfficeSourceKindChange: (kind: "presence_endpoint" | "openclaw_gateway") => void;
  onRemoteOfficeLabelChange: (label: string) => void;
  onRemoteOfficePresenceUrlChange: (url: string) => void;
  onRemoteOfficeGatewayUrlChange: (url: string) => void;
  onRemoteOfficeTokenChange: (token: string) => void;
  voiceRepliesEnabled: boolean;
  voiceRepliesVoiceId: string | null;
  voiceRepliesSpeed: number;
  voiceRepliesLoaded: boolean;
  onVoiceRepliesToggle: (enabled: boolean) => void;
  onVoiceRepliesVoiceChange: (voiceId: string | null) => void;
  onVoiceRepliesSpeedChange: (speed: number) => void;
  onVoiceRepliesPreview: (voiceId: string | null, voiceName: string) => void;
  /** The server's voice providers and voices; absent while loading. */
  voiceSetup?: VoiceSetup | null;
  /** Everyone in the office with the voice they speak with. */
  voiceAgents?: Array<{ agentId: string; name: string; voiceId: string | null; chosen: boolean }>;
  onAgentVoiceChange?: (agentId: string, voiceId: string | null) => void;
};

export function SettingsPanel({
  gatewayStatus,
  gatewayUrl,
  gatewayToken,
  selectedAdapterType = "openclaw",
  activeAdapterType = "openclaw",
  onGatewayDisconnect,
  onGatewayConnect,
  onGatewayUrlChange,
  onGatewayTokenChange,
  onGatewayAdapterTypeChange,
  onOpenOnboarding,
  officeTitle,
  officeTitleLoaded,
  onOfficeTitleChange,
  remoteOfficeEnabled,
  remoteOfficeSourceKind,
  remoteOfficeLabel,
  remoteOfficePresenceUrl,
  remoteOfficeGatewayUrl,
  remoteOfficeTokenConfigured,
  onRemoteOfficeEnabledChange,
  onRemoteOfficeSourceKindChange,
  onRemoteOfficeLabelChange,
  onRemoteOfficePresenceUrlChange,
  onRemoteOfficeGatewayUrlChange,
  onRemoteOfficeTokenChange,
  voiceRepliesEnabled,
  voiceRepliesVoiceId,
  voiceRepliesSpeed,
  voiceRepliesLoaded,
  onVoiceRepliesToggle,
  onVoiceRepliesVoiceChange,
  onVoiceRepliesSpeedChange,
  onVoiceRepliesPreview,
  voiceSetup = null,
  voiceAgents = [],
  onAgentVoiceChange,
}: SettingsPanelProps) {
  // Voices come from the server's provider; ElevenLabs keeps its curated
  // list with descriptions.
  const officeVoices =
    voiceSetup && voiceSetup.tts.provider !== "elevenlabs"
      ? voiceSetup.tts.options.map((option) => ({ id: option.id as string | null, label: option.label, description: "" }))
      : CURATED_ELEVENLABS_VOICES;
  const voiceChoices = voiceSetup?.tts.options ?? CURATED_ELEVENLABS_VOICES.map((voice) => ({ id: voice.id ?? "", label: voice.label })).filter((voice) => voice.id);
  const providerLabel = (id: string) =>
    id === "elevenlabs" ? "ElevenLabs" : id === "openai-compatible" ? t("settings.voiceProviderLocal") : id === "openclaw" ? "OpenClaw" : id;
  const normalizedGatewayUrl = gatewayUrl?.trim() ?? "";
  const normalizedGatewayToken = gatewayToken ?? "";
  const gatewayStateLabel = gatewayStatus
    ? (GATEWAY_STATUS_LABELS[gatewayStatus] ?? gatewayStatus)
    : t("settings.unknown");
  const isGatewayConnected = gatewayStatus === "connected";
  const gatewayDisconnectDisabled = !isGatewayConnected;
  const gatewayConnectDisabled = normalizedGatewayUrl.length === 0;
  const tokenOptional =
    selectedAdapterType === "hermes" ||
    selectedAdapterType === "demo" ||
    selectedAdapterType === "local" ||
    selectedAdapterType === "office3d" ||
    selectedAdapterType === "custom";
  const [remoteOfficeTokenDraft, setRemoteOfficeTokenDraft] = useState("");
  const hermesControl = useHermesControl();

  return (
    <div className="px-4 py-4">
      <div className="rounded-lg border border-cyan-500/10 bg-black/20 px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[11px] font-medium text-white">{t("settings.studioTitle")}</div>
            <div className="mt-1 text-[10px] text-white/75">{t("settings.studioTitleLead")}</div>
          </div>
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-cyan-200/70">
            {officeTitleLoaded ? t("settings.ready") : t("settings.loading")}
          </span>
        </div>
        <input
          type="text"
          value={officeTitle}
          maxLength={48}
          disabled={!officeTitleLoaded}
          onChange={(event) => onOfficeTitleChange(event.target.value)}
          placeholder={t("settings.titlePh")}
          className="mt-3 w-full rounded-md border border-cyan-500/10 bg-black/25 px-3 py-2 text-[11px] uppercase tracking-[0.18em] text-cyan-100 outline-none transition-colors placeholder:text-cyan-100/30 focus:border-cyan-400/30 disabled:cursor-not-allowed disabled:opacity-50"
        />
        <div className="mt-2 text-[10px] text-white/50">{t("settings.titleHint")}</div>
      </div>
      <div className="mt-3 rounded-lg border border-cyan-500/10 bg-black/20 px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[11px] font-medium text-white">{t("settings.gateway")}</div>
            <div className="mt-1 text-[10px] text-white/75">{t("settings.gatewayLead")}</div>
          </div>
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-cyan-200/70">
            {gatewayStateLabel}
          </span>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {(
            [
              ["demo", t("settings.backendDemo")],
              ["hermes", "Hermes"],
              ["local", t("settings.backendLocal")],
              ["office3d", "Office3D"],
              ["custom", t("settings.backendCustom")],
              ["openclaw", "OpenClaw"],
            ] as const
          ).map(([adapterType, label]) => {
            const selected = selectedAdapterType === adapterType;
            return (
              <button
                key={adapterType}
                type="button"
                onClick={() => onGatewayAdapterTypeChange?.(adapterType)}
                className={`rounded-md border px-3 py-1.5 text-[10px] font-medium uppercase tracking-[0.14em] transition-colors ${
                  selected
                    ? "border-cyan-400/35 bg-cyan-500/12 text-cyan-50"
                    : "border-cyan-500/10 bg-black/20 text-white/75 hover:border-cyan-400/25 hover:text-cyan-50"
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>
        <div className="mt-3 grid gap-3">
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-[0.14em] text-cyan-100/65">{t("gateway.upstreamUrl")}</div>
            <input
              type="text"
              value={gatewayUrl ?? ""}
              onChange={(event) => onGatewayUrlChange?.(event.target.value)}
              placeholder={
                selectedAdapterType === "custom" ||
                selectedAdapterType === "local"
                  ? "http://localhost:7770"
                  : selectedAdapterType === "office3d"
                    ? "http://localhost:3000/api/runtime/custom"
                  : "ws://localhost:18789"
              }
              className="w-full rounded-md border border-cyan-500/10 bg-black/25 px-3 py-2 font-mono text-[11px] text-cyan-100 outline-none transition-colors placeholder:text-cyan-100/30 focus:border-cyan-400/30"
            />
          </div>
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-[0.14em] text-cyan-100/65">
              {tokenOptional ? t("gateway.upstreamTokenOptional") : t("gateway.upstreamToken")}
            </div>
            <input
              type="password"
              value={normalizedGatewayToken}
              onChange={(event) => onGatewayTokenChange?.(event.target.value)}
              placeholder={tokenOptional ? t("settings.tokenOptional") : t("settings.gatewayToken")}
              className="w-full rounded-md border border-cyan-500/10 bg-black/25 px-3 py-2 text-[11px] text-cyan-100 outline-none transition-colors placeholder:text-cyan-100/30 focus:border-cyan-400/30"
            />
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-[10px] text-white/60">
          <span className="font-mono">
            {t("settings.selectedBackend", { name: adapterLabel(selectedAdapterType) })}
          </span>
          <span className="font-mono">
            {t("settings.activeBackend", { name: adapterLabel(activeAdapterType) })}
          </span>
          <span>{t("gateway.backendsKeepOwnSettings")}</span>
        </div>
        <div className="mt-3 flex items-center justify-between gap-3">
          <div className="text-[10px] text-white/60">{t("settings.connectHint")}</div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onGatewayConnect?.()}
              disabled={gatewayConnectDisabled}
              className="rounded-md border border-cyan-500/20 bg-cyan-500/10 px-3 py-1.5 text-[10px] font-medium uppercase tracking-[0.14em] text-cyan-50 transition-colors hover:border-cyan-400/40 hover:bg-cyan-500/15 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {gatewayStatus === "connecting" ? t("gateway.connecting") : t("gateway.connect")}
            </button>
            <button
              type="button"
              onClick={() => onGatewayDisconnect?.()}
              disabled={gatewayDisconnectDisabled}
              className="rounded-md border border-rose-500/20 bg-rose-500/10 px-3 py-1.5 text-[10px] font-medium uppercase tracking-[0.14em] text-rose-100 transition-colors hover:border-rose-400/40 hover:bg-rose-500/15 disabled:cursor-not-allowed disabled:opacity-40"
            >{t("settings.disconnect")}</button>
          </div>
        </div>
      </div>
      <div className="mt-3 rounded-lg border border-cyan-500/10 bg-black/20 px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[11px] font-medium text-white">{t("settings.remoteOffice")}</div>
            <div className="mt-1 text-[10px] text-white/75">{t("settings.remoteOfficeLead")}</div>
          </div>
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-cyan-200/70">
            {remoteOfficeEnabled ? t("settings.enabled") : t("settings.disabled")}
          </span>
        </div>
        <div className="ui-settings-row mt-3 flex min-h-[72px] items-center justify-between gap-6 rounded-lg border border-cyan-500/10 bg-black/15 px-4 py-3">
          <div className="flex items-center gap-3">
            <button
              type="button"
              role="switch"
              aria-label={t("settings.remoteOffice")}
              aria-checked={remoteOfficeEnabled}
              className={`ui-switch self-center ${remoteOfficeEnabled ? "ui-switch--on" : ""}`}
              onClick={() => onRemoteOfficeEnabledChange(!remoteOfficeEnabled)}
            >
              <span className="ui-switch-thumb" />
            </button>
            <div className="flex flex-col">
              <span className="text-[11px] font-medium text-white">{t("settings.showSecondOffice")}</span>
              <span className="text-[10px] text-white/80">{t("settings.remoteReadOnly")}</span>
            </div>
          </div>
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-cyan-200/70">
            {remoteOfficeTokenConfigured ? t("settings.tokenSet") : t("settings.noToken")}
          </span>
        </div>
        <div className="mt-3 grid gap-3">
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-[0.14em] text-cyan-100/65">{t("settings.sourceType")}</div>
            <select
              value={remoteOfficeSourceKind}
              onChange={(event) =>
                onRemoteOfficeSourceKindChange(
                  event.target.value as "presence_endpoint" | "openclaw_gateway"
                )
              }
              className="w-full rounded-md border border-cyan-500/10 bg-black/25 px-3 py-2 text-[11px] text-cyan-100 outline-none transition-colors focus:border-cyan-400/30"
            >
              <option value="presence_endpoint">{t("settings.sourcePresence")}</option>
              <option value="openclaw_gateway">{t("settings.sourceGateway")}</option>
            </select>
            <div className="mt-1 text-[10px] text-white/50">
              {t("settings.remoteModeHint")}
            </div>
          </div>
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-[0.14em] text-cyan-100/65">{t("settings.label")}</div>
            <input
              type="text"
              value={remoteOfficeLabel}
              maxLength={48}
              onChange={(event) => onRemoteOfficeLabelChange(event.target.value)}
              placeholder={t("settings.remotePh")}
              className="w-full rounded-md border border-cyan-500/10 bg-black/25 px-3 py-2 text-[11px] uppercase tracking-[0.14em] text-cyan-100 outline-none transition-colors placeholder:text-cyan-100/30 focus:border-cyan-400/30"
            />
          </div>
          {remoteOfficeSourceKind === "presence_endpoint" ? (
            <>
              <div>
                <div className="mb-1 text-[10px] uppercase tracking-[0.14em] text-cyan-100/65">{t("settings.presenceUrl")}</div>
                <input
                  type="url"
                  value={remoteOfficePresenceUrl}
                  onChange={(event) => onRemoteOfficePresenceUrlChange(event.target.value)}
                  placeholder="https://other-office.example.com/api/office/presence"
                  className="w-full rounded-md border border-cyan-500/10 bg-black/25 px-3 py-2 text-[11px] text-cyan-100 outline-none transition-colors placeholder:text-cyan-100/30 focus:border-cyan-400/30"
                />
                <div className="mt-1 text-[10px] text-white/50">
                  {t("settings.presencePollHint")}
                </div>
              </div>
              <div>
                <div className="mb-1 text-[10px] uppercase tracking-[0.14em] text-cyan-100/65">{t("settings.optionalToken")}</div>
                <div className="flex items-center gap-2">
                  <input
                    type="password"
                    value={remoteOfficeTokenDraft}
                    onChange={(event) => setRemoteOfficeTokenDraft(event.target.value)}
                    placeholder={remoteOfficeTokenConfigured ? t("settings.tokenReplace") : t("settings.enterToken")}
                    className="min-w-0 flex-1 rounded-md border border-cyan-500/10 bg-black/25 px-3 py-2 text-[11px] text-cyan-100 outline-none transition-colors placeholder:text-cyan-100/30 focus:border-cyan-400/30"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      onRemoteOfficeTokenChange(remoteOfficeTokenDraft);
                      setRemoteOfficeTokenDraft("");
                    }}
                    className="rounded-md border border-cyan-500/20 bg-cyan-500/10 px-3 py-2 text-[10px] font-medium uppercase tracking-[0.14em] text-cyan-100 transition-colors hover:border-cyan-400/40 hover:bg-cyan-500/15"
                  >{t("settings.save")}</button>
                  {remoteOfficeTokenConfigured ? (
                    <button
                      type="button"
                      onClick={() => {
                        onRemoteOfficeTokenChange("");
                        setRemoteOfficeTokenDraft("");
                      }}
                      className="rounded-md border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-[10px] font-medium uppercase tracking-[0.14em] text-rose-100 transition-colors hover:border-rose-400/40 hover:bg-rose-500/15"
                    >{t("settings.clear")}</button>
                  ) : null}
                </div>
              </div>
            </>
          ) : (
            <>
              <div>
                <div className="mb-1 text-[10px] uppercase tracking-[0.14em] text-cyan-100/65">{t("settings.gatewayUrl")}</div>
                <input
                  type="text"
                  value={remoteOfficeGatewayUrl}
                  onChange={(event) => onRemoteOfficeGatewayUrlChange(event.target.value)}
                  placeholder="wss://remote-gateway.example.com"
                  className="w-full rounded-md border border-cyan-500/10 bg-black/25 px-3 py-2 text-[11px] text-cyan-100 outline-none transition-colors placeholder:text-cyan-100/30 focus:border-cyan-400/30"
                />
                <div className="mt-1 text-[10px] text-white/50">
                  {t("settings.remoteGatewayHint")}
                </div>
              </div>
              <div>
                <div className="mb-1 text-[10px] uppercase tracking-[0.14em] text-cyan-100/65">{t("settings.sharedToken")}</div>
                <div className="flex items-center gap-2">
                  <input
                    type="password"
                    value={remoteOfficeTokenDraft}
                    onChange={(event) => setRemoteOfficeTokenDraft(event.target.value)}
                    placeholder={remoteOfficeTokenConfigured ? t("settings.tokenReplace") : t("settings.enterToken")}
                    className="min-w-0 flex-1 rounded-md border border-cyan-500/10 bg-black/25 px-3 py-2 text-[11px] text-cyan-100 outline-none transition-colors placeholder:text-cyan-100/30 focus:border-cyan-400/30"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      onRemoteOfficeTokenChange(remoteOfficeTokenDraft);
                      setRemoteOfficeTokenDraft("");
                    }}
                    className="rounded-md border border-cyan-500/20 bg-cyan-500/10 px-3 py-2 text-[10px] font-medium uppercase tracking-[0.14em] text-cyan-100 transition-colors hover:border-cyan-400/40 hover:bg-cyan-500/15"
                  >{t("settings.save")}</button>
                  {remoteOfficeTokenConfigured ? (
                    <button
                      type="button"
                      onClick={() => {
                        onRemoteOfficeTokenChange("");
                        setRemoteOfficeTokenDraft("");
                      }}
                      className="rounded-md border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-[10px] font-medium uppercase tracking-[0.14em] text-rose-100 transition-colors hover:border-rose-400/40 hover:bg-rose-500/15"
                    >{t("settings.clear")}</button>
                  ) : null}
                </div>
                <div className="mt-1 text-[10px] text-white/50">{t("settings.sharedTokenHint")}</div>
              </div>
            </>
          )}
        </div>
      </div>
      {hermesControl ? <HermesModelsPanel control={hermesControl} /> : null}
      <div className="mt-3 rounded-lg border border-cyan-500/10 bg-black/20 px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[11px] font-medium text-white">{t("settings.onboarding")}</div>
            <div className="mt-1 text-[10px] text-white/75">{t("settings.onboardingLead")}</div>
          </div>
          <button
            type="button"
            onClick={() => onOpenOnboarding?.()}
            className="rounded-md border border-emerald-500/20 bg-emerald-500/10 px-3 py-1.5 text-[10px] font-medium uppercase tracking-[0.14em] text-emerald-100 transition-colors hover:border-emerald-400/40 hover:bg-emerald-500/15"
          >{t("settings.launchWizard")}</button>
        </div>
      </div>
      <div className="ui-settings-row mt-3 flex min-h-[72px] items-center justify-between gap-6 rounded-lg border border-cyan-500/10 bg-black/20 px-4 py-3">
        <div className="flex items-center gap-3">
          <button
            type="button"
            role="switch"
            aria-label={t("settings.voiceReplies")}
            aria-checked={voiceRepliesEnabled}
            className={`ui-switch self-center ${voiceRepliesEnabled ? "ui-switch--on" : ""}`}
            onClick={() => onVoiceRepliesToggle(!voiceRepliesEnabled)}
            disabled={!voiceRepliesLoaded}
          >
            <span className="ui-switch-thumb" />
          </button>
          <div className="flex flex-col">
            <span className="text-[11px] font-medium text-white">{t("settings.voiceReplies")}</span>
            <span className="text-[10px] text-white/80">{t("settings.voiceRepliesLead")}</span>
          </div>
        </div>
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-cyan-200/70">
          {voiceRepliesLoaded ? (voiceRepliesEnabled ? t("settings.on") : t("settings.off")) : t("settings.loading")}
        </span>
      </div>
      <div className="mt-3 rounded-lg border border-cyan-500/10 bg-black/20 px-4 py-3">
        <div className="text-[11px] font-medium text-white">{t("settings.voice")}</div>
        <div className="mt-1 text-[10px] text-white/75">{t("settings.voiceLead")}</div>
        <div className="mt-3 grid grid-cols-2 gap-2">
          {officeVoices.map((voice) => {
            const selected = voice.id === voiceRepliesVoiceId;
            return (
              <button
                key={voice.id ?? "default"}
                type="button"
                onClick={() => {
                  onVoiceRepliesVoiceChange(voice.id);
                  onVoiceRepliesPreview(voice.id, voice.label);
                }}
                disabled={!voiceRepliesLoaded}
                className={`rounded-lg border px-3 py-2 text-left transition-colors ${
                  selected
                    ? "border-cyan-400/40 bg-cyan-500/12 text-white"
                    : "border-cyan-500/10 bg-black/15 text-white/80 hover:border-cyan-400/20 hover:bg-cyan-500/6"
                }`}
              >
                <div className="text-[11px] font-medium">{voice.label}</div>
                {voice.description ? <div className="mt-1 text-[10px] text-white/65">{voice.description}</div> : null}
              </button>
            );
          })}
        </div>
      </div>
      {voiceSetup ? (
        <div className="mt-3 rounded-lg border border-cyan-500/10 bg-black/20 px-4 py-3 text-[10px] text-white/75" data-testid="voice-providers">
          <div>
            {t("settings.voiceTts", {
              provider: providerLabel(voiceSetup.tts.provider),
              state: voiceSetup.tts.ready ? t("settings.voiceReady") : t("settings.voiceNotConfigured"),
            })}
          </div>
          <div className="mt-1">
            {t("settings.voiceStt", {
              provider: providerLabel(voiceSetup.stt.provider),
              state: voiceSetup.stt.ready ? t("settings.voiceReady") : t("settings.voiceNotConfigured"),
            })}
          </div>
          <div className="mt-1 text-white/50">{t("settings.voicePttHint")}</div>
        </div>
      ) : null}
      {voiceAgents.length > 0 && onAgentVoiceChange ? (
        <div className="mt-3 rounded-lg border border-cyan-500/10 bg-black/20 px-4 py-3" data-testid="team-voices">
          <div className="text-[11px] font-medium text-white">{t("settings.teamVoices")}</div>
          <div className="mt-1 text-[10px] text-white/75">{t("settings.teamVoicesLead")}</div>
          <div className="mt-3 space-y-2">
            {voiceAgents.map((agent) => (
              <div key={agent.agentId} className="flex items-center justify-between gap-3">
                <span className="truncate text-[11px] text-white/85">{agent.name}</span>
                <div className="flex items-center gap-2">
                  <select
                    aria-label={t("settings.agentVoice", { name: agent.name })}
                    className="rounded border border-cyan-500/20 bg-black/40 px-2 py-1 text-[11px] text-white"
                    value={agent.chosen ? (agent.voiceId ?? "") : ""}
                    disabled={!voiceRepliesLoaded}
                    onChange={(event) => onAgentVoiceChange(agent.agentId, event.target.value || null)}
                  >
                    <option value="">
                      {t("settings.agentVoiceAuto", {
                        voice: voiceChoices.find((voice) => voice.id === agent.voiceId)?.label ?? agent.voiceId ?? "—",
                      })}
                    </option>
                    {voiceChoices.map((voice) => (
                      <option key={voice.id} value={voice.id}>
                        {voice.label}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="rounded border border-cyan-500/20 px-2 py-1 text-[10px] text-cyan-100 hover:border-cyan-400/40"
                    disabled={!voiceRepliesLoaded}
                    onClick={() => onVoiceRepliesPreview(agent.voiceId, agent.name)}
                  >
                    {t("settings.voiceListen")}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      <div className="mt-3 rounded-lg border border-cyan-500/10 bg-black/20 px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-[11px] font-medium text-white">{t("settings.speed")}</div>
            <div className="mt-1 text-[10px] text-white/75">{t("settings.speedLead")}</div>
          </div>
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-cyan-200/70">
            {voiceRepliesSpeed.toFixed(2)}x
          </span>
        </div>
        <input
          type="range"
          min="0.7"
          max="1.2"
          step="0.05"
          value={voiceRepliesSpeed}
          disabled={!voiceRepliesLoaded}
          onChange={(event) =>
            onVoiceRepliesSpeedChange(Number.parseFloat(event.target.value))
          }
          className="mt-3 h-2 w-full cursor-pointer appearance-none rounded-full bg-cyan-500/15 accent-cyan-400"
        />
        <div className="mt-1 flex items-center justify-between text-[10px] text-white/45">
          <span>{t("settings.slower")}</span>
          <span>{t("settings.faster")}</span>
        </div>
      </div>
    </div>
  );
}
