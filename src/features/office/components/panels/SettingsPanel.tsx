"use client";

import { useState, type ReactNode } from "react";
import { BUILTIN_SPEECH_VOICES, DEFAULT_LEAD_VOICE } from "@/lib/voice/voiceCatalog";
import type { VoiceSetup } from "@/lib/voice/agentVoices";
import type { StudioGatewayAdapterType } from "@/lib/studio/settings";
import { t } from "@/lib/i18n";
import { adapterLabel } from "@/lib/i18n/labels";
import { useHermesControl } from "@/features/hermes/HermesControlContext";
import { HermesModelsPanel } from "@/features/hermes/components/HermesModelsPanel";
import { SystemHealthSection } from "@/features/hermes/components/SystemHealthSection";
import {
  HQ_BUTTON_DANGER,
  HQ_BUTTON_PRIMARY,
  HQ_BUTTON_SECONDARY,
  HQ_CARD,
  HQ_DOT_OFF,
  HQ_DOT_ON,
  HQ_FIELD,
  HQ_INSET,
  HQ_LABEL,
  HQ_TEXT_ON,
  hqOptionClass,
} from "@/features/agents/components/hqFormClasses";

// Spelled out rather than looked up by building a key: a key assembled at
// runtime is invisible to the check that finds unused and missing phrases.
const GATEWAY_STATUS_LABELS: Record<string, string> = {
  connected: t("settings.gatewayStatusConnected"),
  connecting: t("settings.gatewayStatusConnecting"),
  disconnected: t("settings.gatewayStatusDisconnected"),
};

const CARD = `${HQ_CARD} px-4 py-3`;
const LABEL = `${HQ_LABEL} mb-1.5 block text-[10px]`;
const FIELD = `${HQ_FIELD} w-full px-3 py-2 text-[12px]`;
const HINT = "mt-1.5 text-[10px] leading-snug text-white/45";
const BUTTON_SIZE = "px-3 py-1.5 text-[10px]";

const VOICE_SPEED_MIN = 0.7;
const VOICE_SPEED_MAX = 1.2;

function SectionHeader({ title, lead, status }: { title: string; lead?: string; status?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="text-[12px] font-semibold text-white">{title}</div>
        {lead ? <div className="mt-1 text-[11px] leading-snug text-white/65">{lead}</div> : null}
      </div>
      {status}
    </div>
  );
}

/** A section's state at a glance: a lit red dot when on, a grey one when off. */
function StatusTag({ state, children }: { state: "on" | "busy" | "off"; children: ReactNode }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap font-mono text-[10px] uppercase tracking-[0.16em] ${
        state === "off" ? "text-white/50" : HQ_TEXT_ON
      }`}
    >
      <span
        aria-hidden
        className={`h-1.5 w-1.5 rounded-full ${state === "off" ? HQ_DOT_OFF : HQ_DOT_ON} ${state === "busy" ? "animate-pulse" : ""}`}
      />
      {children}
    </span>
  );
}

function SettingsSwitch({
  label,
  checked,
  disabled = false,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-[22px] w-10 shrink-0 items-center rounded-[6px] border transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        checked ? "border-ring/60 bg-primary shadow-[0_0_14px_rgba(255,26,26,0.35)]" : "border-primary/30 bg-black/60"
      }`}
    >
      <span
        aria-hidden
        className={`h-4 w-4 rounded-[4px] bg-white shadow-[0_1px_3px_rgba(0,0,0,0.6)] transition-transform duration-150 ${
          checked ? "translate-x-[20px]" : "translate-x-[2px]"
        }`}
      />
    </button>
  );
}

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
  // Voices come from the server's speech provider (the local speech gateway's
  // list); while it loads, the gateway's built-in catalogue. The HQ system's
  // own voice is not an agent's voice, so it is not offered here.
  const voiceChoices = (voiceSetup?.tts.options ?? BUILTIN_SPEECH_VOICES).filter((voice) => voice.role !== "system");
  const officeVoices = voiceChoices.map((option) => ({ id: option.id as string | null, label: option.label, description: "" }));
  // No office voice picked: AM7 speaks with the lead voice.
  const effectiveOfficeVoiceId = voiceRepliesVoiceId ?? voiceSetup?.tts.leadVoiceId ?? DEFAULT_LEAD_VOICE;
  const providerLabel = (id: string) =>
    id === "local-speech"
      ? "Silero + VoiceStudio"
      : id === "openai-compatible"
        ? t("settings.voiceProviderLocal")
        : id === "openclaw"
          ? "OpenClaw"
          : id;
  const normalizedGatewayUrl = gatewayUrl?.trim() ?? "";
  const normalizedGatewayToken = gatewayToken ?? "";
  const gatewayStateLabel = gatewayStatus
    ? (GATEWAY_STATUS_LABELS[gatewayStatus] ?? gatewayStatus)
    : t("settings.unknown");
  const gatewayState = gatewayStatus === "connected" ? "on" : gatewayStatus === "connecting" ? "busy" : "off";
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
  // The slider's filled part, drawn as a gradient: native range inputs have
  // no themable fill of their own.
  const speedFill = Math.min(
    100,
    Math.max(0, ((voiceRepliesSpeed - VOICE_SPEED_MIN) / (VOICE_SPEED_MAX - VOICE_SPEED_MIN)) * 100)
  );

  const remoteTokenField = (label: string, hint?: string) => (
    <div>
      <div className={LABEL}>{label}</div>
      <div className="flex items-center gap-2">
        <input
          type="password"
          value={remoteOfficeTokenDraft}
          onChange={(event) => setRemoteOfficeTokenDraft(event.target.value)}
          placeholder={remoteOfficeTokenConfigured ? t("settings.tokenReplace") : t("settings.enterToken")}
          className={`${FIELD} min-w-0 flex-1`}
        />
        <button
          type="button"
          onClick={() => {
            onRemoteOfficeTokenChange(remoteOfficeTokenDraft);
            setRemoteOfficeTokenDraft("");
          }}
          className={`${HQ_BUTTON_SECONDARY} shrink-0 px-3 py-2 text-[10px]`}
        >
          {t("settings.save")}
        </button>
        {remoteOfficeTokenConfigured ? (
          <button
            type="button"
            onClick={() => {
              onRemoteOfficeTokenChange("");
              setRemoteOfficeTokenDraft("");
            }}
            className={`${HQ_BUTTON_DANGER} shrink-0 px-3 py-2 text-[10px]`}
          >
            {t("settings.clear")}
          </button>
        ) : null}
      </div>
      {hint ? <div className={HINT}>{hint}</div> : null}
    </div>
  );

  return (
    <div className="px-4 py-4">
      <section className={CARD}>
        <SectionHeader
          title={t("settings.studioTitle")}
          lead={t("settings.studioTitleLead")}
          status={
            <StatusTag state={officeTitleLoaded ? "on" : "busy"}>
              {officeTitleLoaded ? t("settings.ready") : t("settings.loading")}
            </StatusTag>
          }
        />
        <input
          type="text"
          value={officeTitle}
          maxLength={48}
          disabled={!officeTitleLoaded}
          onChange={(event) => onOfficeTitleChange(event.target.value)}
          placeholder={t("settings.titlePh")}
          className={`${FIELD} mt-3 font-mono uppercase tracking-[0.18em]`}
        />
        <div className={HINT}>{t("settings.titleHint")}</div>
      </section>

      <section className={`${CARD} mt-3`}>
        <SectionHeader
          title={t("settings.gateway")}
          lead={t("settings.gatewayLead")}
          status={<StatusTag state={gatewayState}>{gatewayStateLabel}</StatusTag>}
        />
        <div className="mt-3 grid grid-cols-3 gap-1.5">
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
                aria-pressed={selected}
                onClick={() => onGatewayAdapterTypeChange?.(adapterType)}
                className={`truncate rounded-md border px-2 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] transition-colors ${hqOptionClass(selected)}`}
              >
                {label}
              </button>
            );
          })}
        </div>
        <div className="mt-3 grid gap-3">
          <div>
            <div className={LABEL}>{t("gateway.upstreamUrl")}</div>
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
              spellCheck={false}
              className={`${FIELD} font-mono`}
            />
          </div>
          <div>
            <div className={LABEL}>
              {tokenOptional ? t("gateway.upstreamTokenOptional") : t("gateway.upstreamToken")}
            </div>
            <input
              type="password"
              value={normalizedGatewayToken}
              onChange={(event) => onGatewayTokenChange?.(event.target.value)}
              placeholder={tokenOptional ? t("settings.tokenOptional") : t("settings.gatewayToken")}
              className={`${FIELD} font-mono`}
            />
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-white/45">
          <span className="font-mono">
            {t("settings.selectedBackend", { name: adapterLabel(selectedAdapterType) })}
          </span>
          <span className="font-mono">
            {t("settings.activeBackend", { name: adapterLabel(activeAdapterType) })}
          </span>
          <span>{t("gateway.backendsKeepOwnSettings")}</span>
        </div>
        <div className="mt-3 flex items-center justify-between gap-3 border-t border-border pt-3">
          <div className="text-[10px] leading-snug text-white/45">{t("settings.connectHint")}</div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => onGatewayConnect?.()}
              disabled={gatewayConnectDisabled}
              className={`${HQ_BUTTON_PRIMARY} ${BUTTON_SIZE}`}
            >
              {gatewayStatus === "connecting" ? t("gateway.connecting") : t("gateway.connect")}
            </button>
            <button
              type="button"
              onClick={() => onGatewayDisconnect?.()}
              disabled={gatewayDisconnectDisabled}
              className={`${HQ_BUTTON_DANGER} ${BUTTON_SIZE}`}
            >
              {t("settings.disconnect")}
            </button>
          </div>
        </div>
      </section>

      <section className={`${CARD} mt-3`}>
        <SectionHeader
          title={t("settings.remoteOffice")}
          lead={t("settings.remoteOfficeLead")}
          status={
            <StatusTag state={remoteOfficeEnabled ? "on" : "off"}>
              {remoteOfficeEnabled ? t("settings.enabled") : t("settings.disabled")}
            </StatusTag>
          }
        />
        <div className={`${HQ_INSET} mt-3 flex items-center justify-between gap-4 px-3 py-3`}>
          <div className="flex items-center gap-3">
            <SettingsSwitch
              label={t("settings.remoteOffice")}
              checked={remoteOfficeEnabled}
              onChange={onRemoteOfficeEnabledChange}
            />
            <div className="flex flex-col">
              <span className="text-[11px] font-medium text-white">{t("settings.showSecondOffice")}</span>
              <span className="text-[10px] leading-snug text-white/55">{t("settings.remoteReadOnly")}</span>
            </div>
          </div>
          <StatusTag state={remoteOfficeTokenConfigured ? "on" : "off"}>
            {remoteOfficeTokenConfigured ? t("settings.tokenSet") : t("settings.noToken")}
          </StatusTag>
        </div>
        <div className="mt-3 grid gap-3">
          <div>
            <div className={LABEL}>{t("settings.sourceType")}</div>
            <select
              value={remoteOfficeSourceKind}
              onChange={(event) =>
                onRemoteOfficeSourceKindChange(
                  event.target.value as "presence_endpoint" | "openclaw_gateway"
                )
              }
              className={FIELD}
            >
              <option value="presence_endpoint">{t("settings.sourcePresence")}</option>
              <option value="openclaw_gateway">{t("settings.sourceGateway")}</option>
            </select>
            <div className={HINT}>{t("settings.remoteModeHint")}</div>
          </div>
          <div>
            <div className={LABEL}>{t("settings.label")}</div>
            <input
              type="text"
              value={remoteOfficeLabel}
              maxLength={48}
              onChange={(event) => onRemoteOfficeLabelChange(event.target.value)}
              placeholder={t("settings.remotePh")}
              className={`${FIELD} font-mono uppercase tracking-[0.14em]`}
            />
          </div>
          {remoteOfficeSourceKind === "presence_endpoint" ? (
            <>
              <div>
                <div className={LABEL}>{t("settings.presenceUrl")}</div>
                <input
                  type="url"
                  value={remoteOfficePresenceUrl}
                  onChange={(event) => onRemoteOfficePresenceUrlChange(event.target.value)}
                  placeholder="https://other-office.example.com/api/office/presence"
                  spellCheck={false}
                  className={`${FIELD} font-mono`}
                />
                <div className={HINT}>{t("settings.presencePollHint")}</div>
              </div>
              {remoteTokenField(t("settings.optionalToken"))}
            </>
          ) : (
            <>
              <div>
                <div className={LABEL}>{t("settings.gatewayUrl")}</div>
                <input
                  type="text"
                  value={remoteOfficeGatewayUrl}
                  onChange={(event) => onRemoteOfficeGatewayUrlChange(event.target.value)}
                  placeholder="wss://remote-gateway.example.com"
                  spellCheck={false}
                  className={`${FIELD} font-mono`}
                />
                <div className={HINT}>{t("settings.remoteGatewayHint")}</div>
              </div>
              {remoteTokenField(t("settings.sharedToken"), t("settings.sharedTokenHint"))}
            </>
          )}
        </div>
      </section>

      {hermesControl ? <HermesModelsPanel control={hermesControl} /> : null}
      {hermesControl ? <SystemHealthSection control={hermesControl} /> : null}

      <section className={`${CARD} mt-3`}>
        <SectionHeader
          title={t("settings.onboarding")}
          lead={t("settings.onboardingLead")}
          status={
            <button
              type="button"
              onClick={() => onOpenOnboarding?.()}
              className={`${HQ_BUTTON_SECONDARY} ${BUTTON_SIZE} shrink-0`}
            >
              {t("settings.launchWizard")}
            </button>
          }
        />
      </section>

      <section className={`${CARD} mt-3 flex items-center justify-between gap-4`}>
        <div className="flex items-center gap-3">
          <SettingsSwitch
            label={t("settings.voiceReplies")}
            checked={voiceRepliesEnabled}
            disabled={!voiceRepliesLoaded}
            onChange={onVoiceRepliesToggle}
          />
          <div className="flex flex-col">
            <span className="text-[12px] font-semibold text-white">{t("settings.voiceReplies")}</span>
            <span className="mt-0.5 text-[11px] leading-snug text-white/65">{t("settings.voiceRepliesLead")}</span>
          </div>
        </div>
        <StatusTag state={!voiceRepliesLoaded ? "busy" : voiceRepliesEnabled ? "on" : "off"}>
          {voiceRepliesLoaded ? (voiceRepliesEnabled ? t("settings.on") : t("settings.off")) : t("settings.loading")}
        </StatusTag>
      </section>

      <section className={`${CARD} mt-3`}>
        <SectionHeader title={t("settings.voice")} lead={t("settings.voiceLead")} />
        <div className="mt-3 grid grid-cols-2 gap-2">
          {officeVoices.map((voice) => {
            const selected = voice.id === effectiveOfficeVoiceId;
            return (
              <button
                key={voice.id ?? "default"}
                type="button"
                aria-pressed={selected}
                onClick={() => {
                  onVoiceRepliesVoiceChange(voice.id);
                  onVoiceRepliesPreview(voice.id, voice.label);
                }}
                disabled={!voiceRepliesLoaded}
                className={`rounded-md border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${hqOptionClass(selected)}`}
              >
                <div className="text-[11px] font-semibold">{voice.label}</div>
                {voice.description ? (
                  <div className="mt-1 text-[10px] leading-snug text-white/55">{voice.description}</div>
                ) : null}
              </button>
            );
          })}
        </div>
      </section>

      {voiceSetup ? (
        <section className={`${CARD} mt-3 space-y-1.5 text-[11px] text-white/65`} data-testid="voice-providers">
          <div className="flex items-center gap-2">
            <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${voiceSetup.tts.ready ? HQ_DOT_ON : HQ_DOT_OFF}`} />
            {t("settings.voiceTts", {
              provider: providerLabel(voiceSetup.tts.provider),
              state: voiceSetup.tts.ready ? t("settings.voiceReady") : t("settings.voiceNotConfigured"),
            })}
          </div>
          <div className="flex items-center gap-2">
            <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${voiceSetup.stt.ready ? HQ_DOT_ON : HQ_DOT_OFF}`} />
            {t("settings.voiceStt", {
              provider: providerLabel(voiceSetup.stt.provider),
              state: voiceSetup.stt.ready ? t("settings.voiceReady") : t("settings.voiceNotConfigured"),
            })}
          </div>
          <div className="pt-0.5 text-[10px] leading-snug text-white/45">{t("settings.voicePttHint")}</div>
        </section>
      ) : null}

      {voiceAgents.length > 0 && onAgentVoiceChange ? (
        <section className={`${CARD} mt-3`} data-testid="team-voices">
          <SectionHeader title={t("settings.teamVoices")} lead={t("settings.teamVoicesLead")} />
          <div className="mt-3 divide-y divide-border">
            {voiceAgents.map((agent) => (
              <div key={agent.agentId} className="flex items-center justify-between gap-3 py-1.5">
                <span className="truncate text-[11px] text-white/85">{agent.name}</span>
                <div className="flex shrink-0 items-center gap-2">
                  <select
                    aria-label={t("settings.agentVoice", { name: agent.name })}
                    className={`${HQ_FIELD} max-w-[180px] px-2 py-1 text-[11px]`}
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
                    className={`${HQ_BUTTON_SECONDARY} px-2 py-1 text-[9px]`}
                    disabled={!voiceRepliesLoaded}
                    onClick={() => onVoiceRepliesPreview(agent.voiceId, agent.name)}
                  >
                    {t("settings.voiceListen")}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section className={`${CARD} mt-3`}>
        <SectionHeader
          title={t("settings.speed")}
          lead={t("settings.speedLead")}
          status={
            <span className="font-mono text-[12px] font-semibold tabular-nums text-white">
              {voiceRepliesSpeed.toFixed(2)}x
            </span>
          }
        />
        <input
          type="range"
          min={VOICE_SPEED_MIN}
          max={VOICE_SPEED_MAX}
          step="0.05"
          value={voiceRepliesSpeed}
          disabled={!voiceRepliesLoaded}
          onChange={(event) =>
            onVoiceRepliesSpeedChange(Number.parseFloat(event.target.value))
          }
          style={{
            background: `linear-gradient(to right, var(--primary) ${speedFill}%, rgb(255 255 255 / 0.12) ${speedFill}%)`,
          }}
          className="mt-3 h-1.5 w-full cursor-pointer appearance-none rounded-full accent-primary disabled:cursor-not-allowed disabled:opacity-50 [&::-moz-range-track]:bg-transparent [&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-white [&::-moz-range-thumb]:shadow-[0_0_8px_rgba(255,26,26,0.8)] [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow-[0_0_8px_rgba(255,26,26,0.8)]"
        />
        <div className="mt-1.5 flex items-center justify-between font-mono text-[9px] uppercase tracking-[0.16em] text-white/45">
          <span>{t("settings.slower")}</span>
          <span>{t("settings.faster")}</span>
        </div>
      </section>
    </div>
  );
}
