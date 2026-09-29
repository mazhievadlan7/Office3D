"use client";

import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { MessageSquare, ChevronDown, ChevronLeft, ChevronRight, Mic, X } from "lucide-react";
import type { HqAgentInput } from "@/features/hq/core/types";
import { HQ_LEAD_AGENT_NAME } from "@/features/hq/core/config";
import {
  describeMaintenanceLogEvent,
  type HqMaintenanceLogEvent,
} from "@/features/hq/maintenance/maintenanceStatus";
import { RunningAvatarLoader } from "@/features/agents/components/RunningAvatarLoader";
import { GatewayConnectScreen } from "@/features/agents/components/GatewayConnectScreen";
import { HermesControlProvider, type HermesControl } from "@/features/hermes/HermesControlContext";
import { TeamProposalsTray } from "@/features/hermes/components/TeamProposalsTray";
import { AnnouncementToast } from "@/features/hermes/components/AnnouncementToast";
import { HermesUpdateCard } from "@/features/hermes/components/HermesUpdateCard";
import { useHermesMeetingController } from "@/features/hermes/useHermesMeetingController";
import { useAgentStore, type AgentState } from "@/features/agents/state/store";
import {
  buildAgentMainSessionKey,
  type EventFrame,
  isSameSessionKey,
  parseAgentIdFromSessionKey,
} from "@/lib/gateway/GatewayClient";
import { useRuntimeConnection } from "@/lib/runtime/useRuntimeConnection";
import {
  createStudioSettingsCoordinator,
  type StudioSettingsLoadOptions,
} from "@/lib/studio/coordinator";
import {
  resolveStudioActiveFloorId,
  type StudioGatewayAdapterType,
} from "@/lib/studio/settings";
import {
  createGatewayAgent,
  renameGatewayAgent,
} from "@/lib/gateway/agentConfig";
import {
  runStudioBootstrapLoadOperation,
  executeStudioBootstrapLoadCommands,
} from "@/features/agents/operations/studioBootstrapOperation";
import { isGatewayDisconnectLikeError } from "@/lib/gateway/GatewayClient";
import { createGatewayRuntimeEventHandler } from "@/features/agents/state/gatewayRuntimeEventHandler";
import {
  buildHistoryLines,
  classifyGatewayEventKind,
  isReasoningRuntimeAgentStream,
  type AgentEventPayload,
  type ChatEventPayload,
  type SummaryPreviewSnapshot,
} from "@/features/agents/state/runtimeEventBridge";
import {
  extractText,
  extractThinking,
  extractToolLines,
  isHeartbeatPrompt,
  stripUiMetadata,
} from "@/lib/text/message-extract";
import { resolveOfficeIntentSnapshot } from "@/lib/office/deskDirectives";
import { AgentChatPanel } from "@/features/agents/components/AgentChatPanel";
import {
  RemoteAgentChatPanel,
  type RemoteAgentChatMessage,
} from "@/features/office/components/RemoteAgentChatPanel";
import { useOfficeFloorRuntimePersistence } from "@/features/office/hooks/useOfficeFloorRuntimePersistence";
import {
  type RuntimeAgentMessageMode,
} from "@/lib/runtime/agentMessaging";
import {
  getOfficeFloor,
  listOfficeFloorsForProvider,
  resolveActiveOfficeFloorId,
  type FloorId,
} from "@/lib/office/floors";
import {
  AgentEditorModal,
  type AgentEditorSection,
} from "@/features/agents/components/AgentEditorModal";
import { AgentCreateWizardModal } from "@/features/agents/components/AgentCreateWizardModal";
import type { AgentIdentityValues } from "@/features/agents/components/AgentIdentityFields";
import { useChatInteractionController } from "@/features/agents/operations/useChatInteractionController";
import {
  applyCreateAgentBootstrapPermissions,
  CREATE_AGENT_DEFAULT_PERMISSIONS,
} from "@/features/agents/operations/createAgentBootstrapOperation";
import { deleteAgentRecordViaStudio } from "@/features/agents/operations/deleteAgentOperation";
import { planAgentSettingsMutation } from "@/features/agents/operations/agentSettingsMutationWorkflow";
import {
  executeHistorySyncCommands,
  runHistorySyncOperation,
} from "@/features/agents/operations/historySyncOperation";
import {
  buildQueuedMutationBlock,
  runAgentConfigMutationLifecycle,
  runCreateAgentMutationLifecycle,
  type CreateAgentBlockState,
} from "@/features/agents/operations/mutationLifecycleWorkflow";
import { useConfigMutationQueue } from "@/features/agents/operations/useConfigMutationQueue";
import {
  RUNTIME_SYNC_DEFAULT_HISTORY_LIMIT,
  RUNTIME_SYNC_MAX_HISTORY_LIMIT,
} from "@/features/agents/operations/runtimeSyncControlWorkflow";
import {
  TRANSCRIPT_V2_ENABLED,
  logTranscriptDebugMetric,
} from "@/features/agents/state/transcript";
import {
  buildGatewayModelChoices,
  type GatewayModelChoice,
} from "@/lib/gateway/models";
import type { GatewayModelPolicySnapshot } from "@/lib/gateway/models";
import {
  createDefaultAgentAvatarProfile,
  type AgentAvatarProfile,
} from "@/lib/avatars/profile";
import {
  createEmptyPersonalityDraft,
  serializePersonalityFiles,
  type PersonalityBuilderDraft,
} from "@/lib/agents/personalityBuilder";
import { writeGatewayAgentFiles } from "@/lib/gateway/agentFiles";
import { randomUUID } from "@/lib/uuid";
import {
  HQSidebar,
  type HQSidebarTab,
} from "@/features/office/components/HQSidebar";
import { AnalyticsPanel } from "@/features/office/components/panels/AnalyticsPanel";
import { HistoryPanel } from "@/features/office/components/panels/HistoryPanel";
import { CallFeedModal } from "@/features/office/components/panels/CallFeedModal";
import { InboxPanel } from "@/features/office/components/panels/InboxPanel";
import { PlaybooksPanel } from "@/features/office/components/panels/PlaybooksPanel";
import { SettingsPanel } from "@/features/office/components/panels/SettingsPanel";
import { SkillsMarketplaceModal } from "@/features/office/components/panels/SkillsMarketplaceModal";
import { AegisContourPanel } from "@/features/aegis/AegisContourPanel";
import { CombatConsole } from "@/features/combat/CombatConsole";
import { TaskBoardPanel } from "@/features/office/components/panels/TaskBoardPanel";
import { useOfficeCallFeed } from "@/features/office/hooks/useOfficeCallFeed";
import { useOfficeMessaging } from "@/features/office/hooks/useOfficeMessaging";
import {
  MessagingModal,
  type MessageRequestDraft,
} from "@/features/office/components/panels/MessagingPanel";
import { JukeboxPanel } from "@/features/spotify-jukebox/components/JukeboxPanel";
import { JukeboxDisabledPanel } from "@/features/spotify-jukebox/components/JukeboxDisabledPanel";
import { executeBrowserJukeboxCommand } from "@/features/spotify-jukebox/agentBridge";
import { useJukeboxStore } from "@/features/spotify-jukebox/store";
import { useOfficeSkillTriggers } from "@/features/office/hooks/useOfficeSkillTriggers";
import { useRemoteOfficePresence } from "@/features/office/hooks/useRemoteOfficePresence";
import { useOfficeSkillsMarketplace } from "@/features/office/hooks/useOfficeSkillsMarketplace";
import { useOfficeStandupController } from "@/features/office/hooks/useOfficeStandupController";
import { useRunLog } from "@/features/office/hooks/useRunLog";
import { useTaskBoardController } from "@/features/office/tasks/useTaskBoardController";
import {
  OnboardingWizard,
  useOnboardingState,
} from "@/features/onboarding";
import { useFinalizedAssistantReplyListener } from "@/hooks/useFinalizedAssistantReplyListener";
import { useStudioOfficePreference } from "@/hooks/useStudioOfficePreference";
import {
  isRemoteOfficeAgentId,
  REMOTE_OFFICE_AGENT_ID_PREFIX,
  type OfficeAgent,
} from "@/lib/office/officeAgent";
import { useStudioVoiceRepliesPreference } from "@/hooks/useStudioVoiceRepliesPreference";
import {
  useVoiceRecorder,
  type VoiceSendPayload,
} from "@/hooks/useVoiceRecorder";
import { useVoiceReplyPlayback } from "@/hooks/useVoiceReplyPlayback";
import { useVoiceSetup } from "@/hooks/useVoiceSetup";
import { resolveAgentVoice } from "@/lib/voice/agentVoices";
import {
  buildOfficeAnimationState,
  createOfficeAnimationTriggerState,
  reconcileOfficeAnimationTriggerState,
  reduceOfficeAnimationTriggerEvent,
  type OfficePhoneCallRequest,
  type OfficeTextMessageRequest,
} from "@/lib/office/eventTriggers";
import { deriveSkillReadinessState } from "@/lib/skills/presentation";
import type { StandupAgentSnapshot } from "@/lib/office/standup/types";
import type { SkillStatusEntry } from "@/lib/skills/types";
import { t } from "@/lib/i18n";
import { messageRoleLabel } from "@/lib/i18n/labels";
import type { HqBriefing } from "@/features/hq/HqOffice";
import { hqTimeZone } from "@/features/hq/core/hqTime";
import { hqGreetingOpening, hqGreetingStatus } from "@/lib/office/greeting";
import { hqSoundOn } from "@/features/hq/core/soundPreference";
import { prepareSystemSpeech, speakAgent, speakSystem, type PreparedSpeech } from "@/lib/voice/systemVoice";

/** Without an opening fly-through, the greeting starts this long after the page (ms). */
const GREET_WITHOUT_INTRO_MS = 30_000;

// The 3D HQ is client-only: three.js and its loaders never run on the server.
const HqOffice = dynamic(() => import("@/features/hq/HqOffice").then((mod) => mod.HqOffice), {
  ssr: false,
  loading: () => <div className="h-full w-full bg-black" />,
});

// How long gateway events are collected before the screen applies them.
const EVENT_FLUSH_MS = 200;

const MAIN_AGENT_ID = "main";
const DEMO_MAIN_SESSION_KEY = buildAgentMainSessionKey(MAIN_AGENT_ID, "main");
const createDemoMainAgentSeed = (): {
  agentId: string;
  name: string;
  runtimeName: string;
  identityName: string;
  sessionDisplayName: string;
  role: string;
  sessionKey: string;
  avatarSeed: string;
  avatarProfile: AgentAvatarProfile;
  model: string;
  thinkingLevel: string;
  toolCallingEnabled: boolean;
  showThinkingTraces: boolean;
} => ({
  agentId: MAIN_AGENT_ID,
  name: HQ_LEAD_AGENT_NAME,
  runtimeName: t("office.demoRuntime"),
  identityName: HQ_LEAD_AGENT_NAME,
  sessionDisplayName: HQ_LEAD_AGENT_NAME,
  role: "assistant",
  sessionKey: DEMO_MAIN_SESSION_KEY,
  avatarSeed: MAIN_AGENT_ID,
  avatarProfile: createDefaultAgentAvatarProfile(MAIN_AGENT_ID),
  model: "demo/main",
  thinkingLevel: "medium",
  toolCallingEnabled: false,
  showThinkingTraces: false,
});
const MAX_OPENCLAW_LOG_ENTRIES = 200;
const MAX_OPENCLAW_AGENT_OUTPUT_LINES = 12;
const GATEWAY_LOADING_OVERLAY_DELAY_MS = 1_200;
const GATEWAY_CONNECT_OVERLAY_DELAY_MS = 1_500;

const getLatestUserRequestForAgent = (
  agent: AgentState,
): { text: string; requestKey: string } | null => {
  const transcriptEntries = Array.isArray(agent.transcriptEntries)
    ? agent.transcriptEntries
    : [];
  for (let index = transcriptEntries.length - 1; index >= 0; index -= 1) {
    const entry = transcriptEntries[index];
    if (!entry || entry.role !== "user") continue;
    const text = entry.text.trim();
    if (!text) continue;
    return {
      text,
      requestKey: `${agent.sessionKey}:${entry.sequenceKey}:${text}`,
    };
  }
  const fallback = agent.lastUserMessage?.trim() ?? "";
  if (!fallback) return null;
  return {
    text: fallback,
    requestKey: `${agent.sessionKey}:fallback:${fallback}`,
  };
};

type OpenClawLogEntry = {
  id: string;
  timestamp: string;
  eventName: string;
  eventKind: string;
  summary: string;
  role: string | null;
  messageText: string | null;
  thinkingText: string | null;
  streamText: string | null;
  toolText: string | null;
  payloadText: string;
};

type OfficeDeleteMutationBlockState = {
  kind: "delete-agent";
  agentId: string;
  agentName: string;
  phase: "queued" | "mutating" | "awaiting-restart";
  startedAt: number;
  sawDisconnect: boolean;
};

const createOpenClawLogEntry = (params: {
  eventName: string;
  eventKind: string;
  summary: string;
  payload?: unknown;
  role?: string | null;
  messageText?: string | null;
  thinkingText?: string | null;
  streamText?: string | null;
  toolText?: string | null;
}): OpenClawLogEntry => ({
  id: randomUUID(),
  timestamp: formatOpenClawTimestamp(Date.now()),
  eventName: params.eventName,
  eventKind: params.eventKind,
  summary: params.summary,
  role: params.role ?? null,
  messageText: params.messageText ?? null,
  thinkingText: params.thinkingText ?? null,
  streamText: params.streamText ?? null,
  toolText: params.toolText ?? null,
  payloadText: safeJsonStringify(params.payload ?? null),
});

const formatOpenClawTimestamp = (timestampMs: number) => {
  const date = new Date(timestampMs);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
};

const formatOpenClawValue = (value: string | null | undefined) => {
  const trimmed = value?.trim() ?? "";
  return trimmed || "-";
};

const buildPhoneCallOutputLine = (text: string) => t("office.phoneBoothLine", { text });
const buildTextMessageOutputLine = (text: string) => t("office.smsBoothLine", { text });

const buildIdentityFileDraft = (identity: AgentIdentityValues) => {
  const draft = createEmptyPersonalityDraft();
  draft.identity = {
    ...draft.identity,
    ...identity,
  };
  return serializePersonalityFiles(draft);
};

const resolveOfficeMutationGuardMessage = (guardReason?: string) => {
  if (guardReason === "not-connected") {
    return t("office.fleetNeedsGateway");
  }
  if (guardReason === "create-block-active") {
    return t("office.fleetBusyCreate");
  }
  if (guardReason === "rename-block-active") {
    return t("office.fleetBusyRename");
  }
  if (guardReason === "delete-block-active") {
    return t("office.fleetBusyDelete");
  }
  return t("office.fleetBusy");
};

const PHONE_BOOTH_ASSISTANT_FALLBACK_RE =
  /\b(?:i\s+)?can(?:not|['’]t)\s+(?:place|make)\s+(?:phone\s+)?calls?\b/i;

const shouldSuppressPhoneBoothAssistantReply = (params: {
  agents: AgentState[];
  event: EventFrame;
  phoneCallByAgentId: Record<string, OfficePhoneCallRequest>;
}): boolean => {
  if (classifyGatewayEventKind(params.event.event) !== "runtime-chat") return false;
  const payload = params.event.payload as ChatEventPayload | undefined;
  if (!payload?.sessionKey) return false;
  const message =
    typeof payload.message === "object" && payload.message !== null
      ? (payload.message as Record<string, unknown>)
      : null;
  const role = typeof message?.role === "string" ? message.role : null;
  if (role !== "assistant") return false;
  const text = extractText(payload.message)?.trim() ?? "";
  if (!text || !PHONE_BOOTH_ASSISTANT_FALLBACK_RE.test(text)) return false;
  const agentId =
    params.agents.find((agent) => agent.sessionKey === payload.sessionKey)?.agentId ??
    parseAgentIdFromSessionKey(payload.sessionKey);
  if (!agentId) return false;
  return Boolean(params.phoneCallByAgentId[agentId]);
};

const safeJsonStringify = (value: unknown) => {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch (error) {
    return t("office.unserializable", { error: error instanceof Error ? error.message : t("office.unknownError") });
  }
};

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const renderOpenClawHighlightedText = (
  value: string,
  query: string,
): ReactNode => {
  if (!query) return value;
  const trimmedQuery = query.trim();
  if (!trimmedQuery) return value;
  const pattern = new RegExp(`(${escapeRegExp(trimmedQuery)})`, "gi");
  return value.split(pattern).map((part, index) =>
    part.toLowerCase() === trimmedQuery.toLowerCase() ? (
      <mark
        key={`${part}-${index}`}
        className="rounded bg-red-600/35 px-0.5 text-white"
      >
        {part}
      </mark>
    ) : (
      part
    ),
  );
};

const resolveMessageRole = (message: unknown) =>
  message && typeof message === "object"
    ? ((message as Record<string, unknown>).role ?? null)
    : null;

const formatOpenClawEventLogEntry = (event: EventFrame): OpenClawLogEntry => {
  const eventKind = classifyGatewayEventKind(event.event);
  const baseSummary = `seq=${event.seq ?? "-"} stateVersion=${safeJsonStringify(event.stateVersion ?? null)}`;
  let summary = baseSummary;
  let role: string | null = null;
  let messageText: string | null = null;
  let thinkingText: string | null = null;
  let streamText: string | null = null;
  let toolText: string | null = null;

  if (eventKind === "runtime-chat") {
    const payload = event.payload as ChatEventPayload | undefined;
    if (payload) {
      role =
        typeof resolveMessageRole(payload.message) === "string"
          ? String(resolveMessageRole(payload.message))
          : null;
      const text = extractText(payload.message);
      const thinking = extractThinking(payload.message ?? payload);
      const toolLines = extractToolLines(payload.message ?? payload);
      summary = `chat session=${payload.sessionKey || "-"} run=${payload.runId || "-"} state=${payload.state} role=${String(role ?? "-")} stopReason=${payload.stopReason ?? "-"} | ${baseSummary}`;
      if (text) {
        messageText = stripUiMetadata(text).trim() || text.trim();
      }
      if (thinking) {
        thinkingText = thinking.trim();
      }
      if (toolLines.length > 0) {
        toolText = toolLines.join(" | ");
      }
    }
  } else if (eventKind === "runtime-agent") {
    const payload = event.payload as AgentEventPayload | undefined;
    if (payload) {
      const data =
        payload.data && typeof payload.data === "object"
          ? (payload.data as Record<string, unknown>)
          : null;
      const phase = typeof data?.phase === "string" ? data.phase : "-";
      const text =
        typeof data?.text === "string"
          ? data.text
          : typeof data?.delta === "string"
            ? data.delta
            : "";
      const extractedThinking = extractThinking(data ?? payload);
      summary = `agent session=${payload.sessionKey || "-"} run=${payload.runId || "-"} stream=${payload.stream || "-"} phase=${phase} reasoning=${String(isReasoningRuntimeAgentStream(payload.stream ?? ""))} | ${baseSummary}`;
      if (extractedThinking) {
        thinkingText = extractedThinking.trim();
      } else if (text.trim()) {
        streamText = text.trim();
      }
    }
  }

  return createOpenClawLogEntry({
    eventName: event.event,
    eventKind,
    summary,
    role,
    messageText,
    thinkingText,
    streamText,
    toolText,
    payload: event.payload ?? null,
  });
};

const resolveLatestUserTextFromPreview = (
  previewResult: SummaryPreviewSnapshot | null | undefined,
  sessionKey: string,
): string | null => {
  const previews = Array.isArray(previewResult?.previews)
    ? previewResult.previews
    : [];
  const preview = previews.find((entry) => entry.key === sessionKey);
  if (!preview || !Array.isArray(preview.items)) return null;
  for (let index = preview.items.length - 1; index >= 0; index -= 1) {
    const item = preview.items[index];
    if (!item) continue;
    if (item.role === "assistant") continue;
    if (item.role === "user") {
      const text = item.text.trim();
      if (text) return text;
    }
  }
  return null;
};

const mapAgentToOffice = (agent: AgentState): OfficeAgent => {
  const isWorking = agent.status === "running" || Boolean(agent.runId);
  return {
    id: agent.agentId,
    name: agent.name || t("office.unknownAgent"),
    subtitle: agent.role ?? null,
    status: agent.status === "error" ? "error" : isWorking ? "working" : "idle",
  };
};

const mapRemotePresenceAgentToOffice = (agent: {
  agentId: string;
  name: string;
  state: "idle" | "working" | "meeting" | "error";
}): OfficeAgent => {
  const isWorking = agent.state === "working" || agent.state === "meeting";
  return {
    id: `${REMOTE_OFFICE_AGENT_ID_PREFIX}${agent.agentId}`,
    name: agent.name || t("office.unknownAgent"),
    status: agent.state === "error" ? "error" : isWorking ? "working" : "idle",
  };
};

type ChatHistoryResult = {
  messages?: Array<Record<string, unknown>>;
};

type SessionsListEntry = {
  key?: string;
  updatedAt?: number | null;
  origin?: { label?: string | null } | null;
};

type SessionsListResult = {
  sessions?: SessionsListEntry[];
};

type SessionsPreviewItem = {
  role?: string;
  text?: string;
};

type SessionsPreviewEntry = {
  key?: string;
  status?: string;
  items?: SessionsPreviewItem[];
};

type SessionsPreviewResult = {
  previews?: SessionsPreviewEntry[];
};

type HistoryInferenceResult = {
  inferredRunning: boolean;
  lastRole: string;
  lastText: string;
  messageCount: number;
};

type OfficeDebugRow = {
  agentId: string;
  name: string;
  storeStatus: AgentState["status"];
  runId: string | null;
  inferredRunning: boolean;
  lastRole: string;
  lastText: string;
  messageCount: number;
  detectedSessionKey: string;
  inspectedSessions: string;
  inferenceSource: string;
  at: string;
};

type RemoteChatSessionState = {
  draft: string;
  mode: RuntimeAgentMessageMode;
  sending: boolean;
  handoffing: boolean;
  handoffContext: string;
  handoffDeliverables: string;
  handoffAcceptance: string;
  error: string | null;
  messages: RemoteAgentChatMessage[];
};

type OfficeAgentCacheEntry = {
  agent: AgentState;
  latchedWorking: boolean;
  officeAgent: OfficeAgent;
};

type ChatRosterEntry = {
  id: string;
  name: string;
  kind: "local" | "remote";
  isRunning: boolean;
};

const EMPTY_REMOTE_CHAT_SESSION: RemoteChatSessionState = {
  draft: "",
  mode: "direct",
  sending: false,
  handoffing: false,
  handoffContext: "",
  handoffDeliverables: "",
  handoffAcceptance: "",
  error: null,
  messages: [],
};
const MAX_REMOTE_MESSAGE_CHARS = 2_000;

const resolveHistoryInference = (
  messages: Array<Record<string, unknown>>,
): HistoryInferenceResult => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const entry = messages[index];
    const role = typeof entry.role === "string" ? entry.role : "";
    if (role === "system" || role === "tool" || role === "toolResult") continue;
    const text =
      typeof entry.text === "string"
        ? entry.text.trim()
        : typeof entry.content === "string"
          ? entry.content.trim()
          : "";
    if (role === "assistant") {
      return {
        inferredRunning: false,
        lastRole: "assistant",
        lastText: text.slice(0, 120),
        messageCount: messages.length,
      };
    }
    if (role === "user") {
      const rawText = typeof entry.text === "string" ? entry.text : text;
      if (rawText && isHeartbeatPrompt(rawText)) continue;
      return {
        inferredRunning: true,
        lastRole: "user",
        lastText: rawText.slice(0, 120),
        messageCount: messages.length,
      };
    }
  }
  return {
    inferredRunning: false,
    lastRole: "none",
    lastText: "",
    messageCount: messages.length,
  };
};

const inferRunningFromAgentSessions = async (params: {
  client: {
    call: <T = unknown>(method: string, args: unknown) => Promise<T>;
  };
  agentId: string;
}): Promise<{
  inferredRunning: boolean;
  sessionKey: string;
  lastRole: string;
  lastText: string;
  messageCount: number;
  inspectedSessions: string[];
  inferenceSource: string;
}> => {
  const sessionsResult = await params.client.call<SessionsListResult>(
    "sessions.list",
    {
      agentId: params.agentId,
      includeGlobal: false,
      includeUnknown: true,
      limit: 8,
    },
  );
  const sessions = (
    Array.isArray(sessionsResult.sessions) ? sessionsResult.sessions : []
  )
    .filter(
      (entry) => typeof entry.key === "string" && entry.key.trim().length > 0,
    )
    .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
    .slice(0, 4);
  const inspectedSessions = sessions.map((entry) => {
    const key = entry.key?.trim() ?? "";
    const label = entry.origin?.label?.trim() ?? "";
    const updatedAt =
      typeof entry.updatedAt === "number" && Number.isFinite(entry.updatedAt)
        ? new Date(entry.updatedAt).toISOString()
        : "n/a";
    const base = label ? `${key} [${label}]` : key;
    return `${base} @${updatedAt}`;
  });
  const sessionKeys = sessions
    .map((entry) => entry.key?.trim() ?? "")
    .filter((key) => key.length > 0);

  if (sessionKeys.length > 0) {
    const previewResult = await params.client.call<SessionsPreviewResult>(
      "sessions.preview",
      {
        keys: sessionKeys,
        limit: 8,
        maxChars: 240,
      },
    );
    const previews = Array.isArray(previewResult.previews)
      ? previewResult.previews
      : [];
    for (const preview of previews) {
      const key = typeof preview.key === "string" ? preview.key.trim() : "";
      const items = Array.isArray(preview.items) ? preview.items : [];
      for (let index = items.length - 1; index >= 0; index -= 1) {
        const item = items[index];
        if (!item) continue;
        const role = typeof item.role === "string" ? item.role : "";
        const text = typeof item.text === "string" ? item.text.trim() : "";
        if (role === "system" || role === "tool" || role === "toolResult") {
          continue;
        }
        if (role === "assistant") break;
        if (role === "user") {
          if (text && isHeartbeatPrompt(text)) continue;
          return {
            inferredRunning: true,
            sessionKey: key,
            lastRole: "user",
            lastText: text.slice(0, 120),
            messageCount: items.length,
            inspectedSessions,
            inferenceSource: "sessions.preview.user-tail",
          };
        }
      }
    }
  }

  for (const session of sessions) {
    const key = session.key?.trim() ?? "";
    if (!key) continue;
    const history = await params.client.call<ChatHistoryResult>(
      "chat.history",
      {
        sessionKey: key,
        limit: 24,
      },
    );
    const messages = Array.isArray(history.messages) ? history.messages : [];
    const inference = resolveHistoryInference(messages);
    if (inference.inferredRunning) {
      return {
        inferredRunning: true,
        sessionKey: key,
        lastRole: inference.lastRole,
        lastText: inference.lastText,
        messageCount: inference.messageCount,
        inspectedSessions,
        inferenceSource: "chat.history.user-tail",
      };
    }
  }

  return {
    inferredRunning: false,
    sessionKey: "",
    lastRole: "assistant",
    lastText: "",
    messageCount: 0,
    inspectedSessions,
    inferenceSource: "none",
  };
};

type OfficeScreenProps = {
  showOpenClawConsole?: boolean;
};

export function OfficeScreen({
  showOpenClawConsole = true,
}: OfficeScreenProps) {
  // Patch Hermes Phase 2: avoid useSearchParams() at component root — it
  // suspends during hydration in Next.js dev mode and keeps the parent
  // Suspense fallback stuck on "Loading...". Use a sync useMemo so
  // debugEnabled is stable across renders (state+useEffect caused a
  // re-render cascade through downstream useCallbacks).
  const debugEnabled = useMemo(() => {
    if (typeof window === "undefined") return false;
    return new URLSearchParams(window.location.search).get("officeDebug") === "1";
  }, []);
  const [settingsCoordinator] = useState(() =>
    createStudioSettingsCoordinator(),
  );
  const {
    client,
    provider,
    status,
    connectPromptReady,
    shouldPromptForConnect,
    gatewayUrl,
    token,
    selectedAdapterType,
    detectedAdapterType,
    activeAdapterType,
    localGatewayDefaults,
    error: gatewayError,
    connect,
    disconnect,
    useLocalGatewayDefaults,
    setGatewayUrl,
    setToken,
    setSelectedAdapterType,
    supportsCapability,
  } =
    useRuntimeConnection(settingsCoordinator);
  const runtimeSupportsSkills = supportsCapability("skills");
  const runtimeSupportsApprovals = supportsCapability("approvals");
  const runtimeSupportsCron = supportsCapability("cron");
  const runtimeSupportsModels = supportsCapability("models");
  const runtimeSupportsRunLifecycle = supportsCapability("runtime-agent-events");
  const hermesControl = useMemo<HermesControl>(
    () => ({
      available: status === "connected" && activeAdapterType === "hermes",
      call: <T,>(method: string, params: Record<string, unknown> = {}) => client.call<T>(method, params),
      onEvent: (handler) => client.onEvent((frame) => handler({ event: frame.event, payload: frame.payload })),
    }),
    [activeAdapterType, client, status],
  );
  const { state, dispatch, hydrateAgents, setError, setLoading } =
    useAgentStore();
  const [agentsLoaded, setAgentsLoaded] = useState(false);
  // The team as the gateway reports it has loaded (not the offline demo seed).
  const [rosterFromGateway, setRosterFromGateway] = useState(false);
  const [didAttemptGatewayConnect, setDidAttemptGatewayConnect] = useState(false);
  const [showDelayedGatewayLoadingOverlay, setShowDelayedGatewayLoadingOverlay] =
    useState(false);
  const [showDelayedGatewayConnectOverlay, setShowDelayedGatewayConnectOverlay] =
    useState(false);
  const [clockTick, setClockTick] = useState(0);
  const [debugRows, setDebugRows] = useState<OfficeDebugRow[]>([]);
  const officeAgentCacheRef = useRef<Map<string, OfficeAgentCacheEntry>>(new Map());
  const [openClawLogEntries, setOpenClawLogEntries] = useState<
    OpenClawLogEntry[]
  >([]);
  const [openClawConsoleCollapsed, setOpenClawConsoleCollapsed] =
    useState(true);
  const [openClawConsoleSearch, setOpenClawConsoleSearch] = useState("");
  const [openClawConsoleCopyStatus, setOpenClawConsoleCopyStatus] = useState<
    "idle" | "copied" | "error"
  >("idle");
  const taskBoardEventHandlerRef = useRef<(event: EventFrame) => void>(() => {});
  const taskBoardRefreshRef = useRef<() => Promise<void>>(async () => {});
  const [officeTriggerState, setOfficeTriggerState] = useState(() =>
    createOfficeAnimationTriggerState(),
  );
  const gatewayConfigSnapshot = useRef<GatewayModelPolicySnapshot | null>(null);
  const loadAgentsInFlightRef = useRef<Promise<void> | null>(null);
  // True while the roster is only the offline demo seed (AM7 alone, shown
  // before the gateway connects): it counts as loaded for the offline office,
  // but the real team must still be fetched the moment the gateway connects.
  const rosterIsPlaceholderRef = useRef(false);
  const connectionEpochRef = useRef(0);
  const lastLoadAgentsStartedAtRef = useRef(0);
  const lastGatewayActivityAtRef = useRef(0);
  const stateRef = useRef(state);
  const officeTriggerStateRef = useRef(officeTriggerState);
  const historyInFlightRef = useRef<Set<string>>(new Set());
  const lastTransportHistoryRefreshKeyRef = useRef<Record<string, string>>({});
  const [chatOpen, setChatOpen] = useState(false);
  const [chatRosterCollapsed, setChatRosterCollapsed] = useState(false);
  const [selectedChatAgentId, setSelectedChatAgentId] = useState<string | null>(
    null,
  );
  const [remoteChatByAgentId, setRemoteChatByAgentId] = useState<
    Record<string, RemoteChatSessionState>
  >({});
  const [agentEditorAgentId, setAgentEditorAgentId] = useState<string | null>(null);
  const [agentEditorInitialSection, setAgentEditorInitialSection] =
    useState<AgentEditorSection>("avatar");
  const [createAgentWizardNonce, setCreateAgentWizardNonce] = useState(0);
  const [createAgentWizardOpen, setCreateAgentWizardOpen] = useState(false);
  const [createAgentBusy, setCreateAgentBusy] = useState(false);
  const [createAgentModalError, setCreateAgentModalError] = useState<string | null>(
    null,
  );
  const [createAgentBlock, setCreateAgentBlock] =
    useState<CreateAgentBlockState | null>(null);
  const [deleteAgentBlock, setDeleteAgentBlock] =
    useState<OfficeDeleteMutationBlockState | null>(null);
  const promptedPhoneCallKeysRef = useRef<Set<string>>(new Set());
  const preparedPhoneCallKeysRef = useRef<Set<string>>(new Set());
  const promptedTextMessageKeysRef = useRef<Set<string>>(new Set());
  const preparedTextMessageKeysRef = useRef<Set<string>>(new Set());
  const [activeFloorId, setActiveFloorId] = useState<FloorId>("lobby");
  const didAutoNavigateFromLobbyRef = useRef(false);
  const [gatewayModels, setGatewayModels] = useState<GatewayModelChoice[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [combatOpen, setCombatOpen] = useState(false);
  // The HQ's opening fly-through: the console and sidebar tabs step aside for it.
  const [hqIntroPlaying, setHqIntroPlaying] = useState(false);
  const [marketplaceOpen, setMarketplaceOpen] = useState(false);
  const [callFeedOpen, setCallFeedOpen] = useState(false);
  const [messagingOpen, setMessagingOpen] = useState(false);
  const [messagingDraft, setMessagingDraft] =
    useState<MessageRequestDraft | null>(null);
  const [callFeedDraft, setCallFeedDraft] = useState<{
    agentId: string;
    callee: string;
    message: string | null;
  } | null>(null);
  const initJukeboxStore = useJukeboxStore((state) => state.init);
  const jukeboxToken = useJukeboxStore((state) => state.token);
  // Auto-open jukebox panel for legacy direct-auth callbacks.
  const [jukeboxOpen, setJukeboxOpen] = useState(() => {
    if (typeof window === "undefined") return false;
    const searchParams = new URL(window.location.href).searchParams;
    return searchParams.has("code");
  });
  const [activeSidebarTab, setActiveSidebarTab] =
    useState<HQSidebarTab>("inbox");
  const pendingJukeboxCommandTimeoutsRef = useRef<
    Map<string, { requestKey: string; timeoutId: number }>
  >(new Map());
  const handledJukeboxRequestKeyByAgentIdRef = useRef<Record<string, string>>({});
  const router = useRouter();
  const { showOnboarding, completeOnboarding, resetOnboarding } =
    useOnboardingState();
  const [forceShowOnboarding, setForceShowOnboarding] = useState(false);
  const activeFloor = useMemo(
    () => getOfficeFloor(resolveActiveOfficeFloorId(activeFloorId)),
    [activeFloorId],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const settings = await settingsCoordinator.loadSettings({ maxAgeMs: 30_000 });
        if (!settings || cancelled) return;
        setActiveFloorId(resolveStudioActiveFloorId(settings));
      } catch (error) {
        if (!cancelled) {
          console.error("Failed to load active floor preference.", error);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [settingsCoordinator]);

  // Reset auto-navigate flag when disconnected so the next connection can navigate again.
  useEffect(() => {
    if (status !== "connected" && status !== "connecting") {
      didAutoNavigateFromLobbyRef.current = false;
    }
  }, [status]);

  // Auto-navigate away from lobby when a real adapter connects.
  // Uses a ref flag rather than comparing with the previous status so the
  // effect can re-run when detectedAdapterType arrives in a later render (after status
  // already flipped to "connected").
  useEffect(() => {
    if (status !== "connected") return;
    if (didAutoNavigateFromLobbyRef.current) return;
    if (activeFloor.kind !== "lobby" || activeFloor.provider !== "demo") return;

    const connectedProvider =
      detectedAdapterType && detectedAdapterType !== "demo"
        ? detectedAdapterType
        : selectedAdapterType !== "demo"
          ? selectedAdapterType
          : null;
    if (!connectedProvider) return;

    const targetFloor =
      listOfficeFloorsForProvider(connectedProvider).find(
        (floor) => floor.enabled && floor.kind === "runtime",
      ) ?? null;
    if (!targetFloor || targetFloor.id === activeFloor.id) return;

    didAutoNavigateFromLobbyRef.current = true;
    setActiveFloorId(targetFloor.id);
    setSelectedAdapterType(targetFloor.provider as StudioGatewayAdapterType);
    settingsCoordinator.schedulePatch({ activeFloorId: targetFloor.id }, 0);
  }, [
    activeFloor.id,
    activeFloor.kind,
    activeFloor.provider,
    detectedAdapterType,
    selectedAdapterType,
    setSelectedAdapterType,
    settingsCoordinator,
    status,
  ]);

  useEffect(() => {
    initJukeboxStore();
  }, [initJukeboxStore]);
  useEffect(() => {
    // The ref holds one Map for the component's whole life; take it now so the
    // cleanup clears that Map rather than reading the ref after unmount.
    const pendingTimeouts = pendingJukeboxCommandTimeoutsRef.current;
    return () => {
      for (const pendingEntry of pendingTimeouts.values()) {
        window.clearTimeout(pendingEntry.timeoutId);
      }
      pendingTimeouts.clear();
    };
  }, []);
  const {
    loaded: officeTitleLoaded,
    title: officeTitle,
    remoteOfficeEnabled,
    remoteOfficeSourceKind,
    remoteOfficeLabel,
    remoteOfficePresenceUrl,
    remoteOfficeGatewayUrl,
    remoteOfficeTokenConfigured,
    setTitle: setOfficeTitle,
    setRemoteOfficeEnabled,
    setRemoteOfficeSourceKind,
    setRemoteOfficeLabel,
    setRemoteOfficePresenceUrl,
    setRemoteOfficeGatewayUrl,
    setRemoteOfficeToken,
  } = useStudioOfficePreference({
    gatewayUrl,
    settingsCoordinator,
  });
  useOfficeFloorRuntimePersistence({
    activeFloorId,
    gatewayUrl,
    status,
    gatewayError,
    settingsCoordinator,
  });
  const { snapshot: remoteOfficeSnapshot } = useRemoteOfficePresence({
    enabled: remoteOfficeEnabled,
    sourceKind: remoteOfficeSourceKind,
    presenceUrl: remoteOfficePresenceUrl,
    gatewayUrl: remoteOfficeGatewayUrl,
  });
  const {
    loaded: voiceRepliesLoaded,
    preference: voiceRepliesPreference,
    enabled: voiceRepliesEnabled,
    voiceId: voiceRepliesVoiceId,
    speed: voiceRepliesSpeed,
    setEnabled: setVoiceRepliesEnabled,
    setVoiceId: setVoiceRepliesVoiceId,
    setSpeed: setVoiceRepliesSpeed,
    setAgentVoiceId: setVoiceRepliesAgentVoiceId,
  } = useStudioVoiceRepliesPreference({
    gatewayUrl,
    settingsCoordinator,
  });
  const voiceSetup = useVoiceSetup();
  const voiceForAgent = useCallback(
    (agentId: string) =>
      resolveAgentVoice({
        agentId,
        mainAgentId: MAIN_AGENT_ID,
        officeVoiceId: voiceRepliesPreference.voiceId,
        agentVoices: voiceRepliesPreference.agentVoices,
        setup: voiceSetup,
      }),
    [voiceRepliesPreference.agentVoices, voiceRepliesPreference.voiceId, voiceSetup],
  );
  const {
    enqueue: enqueueVoiceReply,
    preview: previewVoiceReply,
    stop: stopVoiceReplyPlayback,
    playing: voiceReplyPlaying,
  } = useVoiceReplyPlayback({
    enabled: voiceRepliesEnabled,
    provider: voiceRepliesPreference.provider,
    voiceId: voiceRepliesPreference.voiceId,
    speed: voiceRepliesPreference.speed,
  });
  const showOnboardingWizard = showOnboarding || forceShowOnboarding;
  const handleOpenOnboarding = useCallback(() => {
    resetOnboarding();
    setForceShowOnboarding(true);
  }, [resetOnboarding]);
  const handleCompleteOnboarding = useCallback(() => {
    completeOnboarding();
    setForceShowOnboarding(false);
  }, [completeOnboarding]);

  const handleAvatarProfileSave = useCallback(
    (agentId: string, profile: AgentAvatarProfile) => {
      dispatch({
        type: "updateAgent",
        agentId,
        patch: { avatarProfile: profile, avatarSeed: profile.seed },
      });
      const key = gatewayUrl.trim();
      if (!key) return;
      settingsCoordinator.schedulePatch(
        { avatars: { [key]: { [agentId]: profile } } },
        0,
      );
    },
    [dispatch, gatewayUrl, settingsCoordinator],
  );
  const focusLocalAgent = useCallback(
    (agentId: string, options?: { openChat?: boolean }) => {
      setSelectedChatAgentId(agentId);
      if (options?.openChat !== false) {
        setChatOpen(true);
      }
      dispatch({ type: "selectAgent", agentId });
    },
    [dispatch],
  );
  const focusChatTarget = useCallback(
    (agentId: string) => {
      setSelectedChatAgentId(agentId);
      setChatOpen(true);
      if (!isRemoteOfficeAgentId(agentId)) {
        dispatch({ type: "selectAgent", agentId });
      }
    },
    [dispatch],
  );
  const openAgentEditor = useCallback(
    (agentId: string, initialSection: AgentEditorSection = "avatar") => {
      setAgentEditorAgentId(agentId);
      setAgentEditorInitialSection(initialSection);
      focusLocalAgent(agentId, { openChat: false });
    },
    [focusLocalAgent],
  );

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const hasRunningAgents = useMemo(
    () =>
      state.agents.some(
        (agent) => agent.status === "running" || Boolean(agent.runId),
      ),
    [state.agents],
  );
  const hasDeleteMutationBlock = deleteAgentBlock?.kind === "delete-agent";
  const { enqueueConfigMutation } = useConfigMutationQueue({
    status,
    hasRunningAgents,
    hasRestartBlockInProgress: Boolean(
      deleteAgentBlock && deleteAgentBlock.phase !== "queued",
    ),
  });

  useEffect(() => {
    officeTriggerStateRef.current = officeTriggerState;
  }, [officeTriggerState]);

  useEffect(() => {
    const timerId = window.setInterval(() => {
      setClockTick((value) => value + 1);
    }, 2000);
    return () => {
      window.clearInterval(timerId);
    };
  }, []);

  useEffect(() => {
    if (status === "connecting") {
      setDidAttemptGatewayConnect(true);
    }
  }, [status]);

  useEffect(() => {
    if (gatewayError) {
      setDidAttemptGatewayConnect(true);
    }
  }, [gatewayError]);

  const loadStudioSettings = useCallback(
    (options?: StudioSettingsLoadOptions) => settingsCoordinator.loadSettings(options),
    [settingsCoordinator],
  );

  const loadAgents = useCallback(async (options?: {
    forceSettings?: boolean;
    minIntervalMs?: number;
    onlyWhenIdleForMs?: number;
    settingsMaxAgeMs?: number;
    silent?: boolean;
  }) => {
    if (status !== "connected") return;
    if (loadAgentsInFlightRef.current) return loadAgentsInFlightRef.current;
    const now = Date.now();
    const minIntervalMs = options?.minIntervalMs ?? 0;
    if (
      minIntervalMs > 0 &&
      now - lastLoadAgentsStartedAtRef.current < minIntervalMs
    ) {
      return;
    }
    const onlyWhenIdleForMs = options?.onlyWhenIdleForMs ?? 0;
    if (
      onlyWhenIdleForMs > 0 &&
      now - lastGatewayActivityAtRef.current < onlyWhenIdleForMs
    ) {
      return;
    }
    lastLoadAgentsStartedAtRef.current = now;
    const connectionEpochAtStart = connectionEpochRef.current;
    const task = (async () => {
      if (!options?.silent) {
        setLoading(true);
      }
      try {
        const settingsLoadOptions: StudioSettingsLoadOptions | undefined =
          options?.forceSettings
            ? { force: true }
            : { maxAgeMs: options?.settingsMaxAgeMs ?? 60_000 };
        const commands = await runStudioBootstrapLoadOperation({
          client: provider,
          gatewayUrl,
          cachedConfigSnapshot: gatewayConfigSnapshot.current,
          loadStudioSettings: () => loadStudioSettings(settingsLoadOptions),
          isDisconnectLikeError: isGatewayDisconnectLikeError,
          preferredSelectedAgentId: null,
          hasCurrentSelection: false,
          logError: console.error,
        });
        if (connectionEpochAtStart !== connectionEpochRef.current) {
          return;
        }
        executeStudioBootstrapLoadCommands({
          commands,
          setGatewayConfigSnapshot: (val: GatewayModelPolicySnapshot) => {
            gatewayConfigSnapshot.current = val;
          },
          hydrateAgents,
          dispatchUpdateAgent: (agentId, patch) => {
            dispatch({ type: "updateAgent", agentId, patch });
          },
          setError,
        });
        if (connectionEpochAtStart !== connectionEpochRef.current) {
          return;
        }
        const refreshedAgents = stateRef.current.agents;
        const debugCollector: OfficeDebugRow[] = [];
        const inferredByAgentId = new Map<string, boolean>();
        await Promise.all(
          refreshedAgents.map(async (agent) => {
          if (connectionEpochAtStart !== connectionEpochRef.current) {
            return;
          }
          try {
            const inference = await inferRunningFromAgentSessions({
              client: provider,
              agentId: agent.agentId,
            });
            if (connectionEpochAtStart !== connectionEpochRef.current) {
              return;
            }
            const inferredRunning = inference.inferredRunning;
            inferredByAgentId.set(agent.agentId, inferredRunning);
            const nextStatus: AgentState["status"] = inferredRunning
              ? "running"
              : "idle";
            if (agent.status !== nextStatus) {
              dispatch({
                type: "updateAgent",
                agentId: agent.agentId,
                patch: {
                  status: nextStatus,
                  runId: inferredRunning
                    ? (agent.runId ?? `inferred-${agent.agentId}`)
                    : null,
                },
              });
            }
            if (debugEnabled) {
              debugCollector.push({
                agentId: agent.agentId,
                name: agent.name,
                storeStatus: agent.status,
                runId: agent.runId,
                inferredRunning,
                lastRole: inference.lastRole,
                lastText: inference.lastText,
                messageCount: inference.messageCount,
                detectedSessionKey: inference.sessionKey,
                inspectedSessions: inference.inspectedSessions.join(" | "),
                inferenceSource: inference.inferenceSource,
                at: new Date().toISOString(),
              });
            }
          } catch (error) {
            if (!isGatewayDisconnectLikeError(error)) {
              console.warn(
                "Failed to infer agent run state from history.",
                error,
              );
            }
          }
          }),
        );
        if (connectionEpochAtStart !== connectionEpochRef.current) {
          return;
        }
        if (debugEnabled) {
          setDebugRows(debugCollector);
          console.info("[office-debug] Reconciled agent state.", debugCollector);
        }
        lastGatewayActivityAtRef.current = Date.now();
        rosterIsPlaceholderRef.current = false;
        setRosterFromGateway(true);
        setAgentsLoaded(true);
      } finally {
        if (!options?.silent) {
          setLoading(false);
        }
        loadAgentsInFlightRef.current = null;
      }
    })();
    loadAgentsInFlightRef.current = task;
    return task;
  }, [
    debugEnabled,
    dispatch,
    gatewayUrl,
    hydrateAgents,
    loadStudioSettings,
    provider,
    setError,
    setLoading,
    status,
  ]);

  // A proposal the person approved changed the team behind the office's back.
  const handleTeamChanged = useCallback(() => {
    void loadAgents({ silent: true });
  }, [loadAgents]);

  const handleCloseCreateAgentWizard = useCallback(
    (createdAgentId: string | null) => {
      setCreateAgentWizardOpen(false);
      setCreateAgentModalError(null);
      if (createdAgentId) {
        openAgentEditor(createdAgentId, "IDENTITY.md");
      }
    },
    [openAgentEditor],
  );
  const handleOpenCreateAgentWizard = useCallback(() => {
    setCreateAgentModalError(null);
    setCreateAgentWizardNonce((current) => current + 1);
    setCreateAgentWizardOpen(true);
  }, []);
  const clearDeletedAgentUiState = useCallback((agentId: string) => {
    setSelectedChatAgentId((current) => (current === agentId ? null : current));
    setAgentEditorAgentId((current) => (current === agentId ? null : current));
    setCallFeedDraft((current) => (current?.agentId === agentId ? null : current));
    setMessagingDraft((current) => (current?.agentId === agentId ? null : current));
  }, []);
  const createAgentStatusLine = useMemo(() => {
    if (!createAgentBlock) return null;
    if (createAgentBlock.phase === "queued") {
      return t("office.waitingRunsCreate");
    }
    return t("office.creatingAgent", { name: createAgentBlock.agentName });
  }, [createAgentBlock]);
  const deleteAgentStatusLine = useMemo(() => {
    if (!deleteAgentBlock) return null;
    if (deleteAgentBlock.phase === "queued") {
      return t("office.waitingRunsDelete", { name: deleteAgentBlock.agentName });
    }
    return t("office.deletingAgent", { name: deleteAgentBlock.agentName });
  }, [deleteAgentBlock]);
  const handleCreateAgentFromIdentity = useCallback(
    async (identity: AgentIdentityValues) => {
      let createdAgentId: string | null = null;
      const success = await runCreateAgentMutationLifecycle(
        {
          payload: {
            name: identity.name,
          },
          status,
          hasCreateBlock: Boolean(createAgentBlock),
          hasRenameBlock: false,
          hasDeleteBlock: Boolean(hasDeleteMutationBlock),
          createAgentBusy,
        },
        {
          enqueueConfigMutation,
          createAgent: async (name) => {
            const created = await createGatewayAgent({ client, name });
            const files = buildIdentityFileDraft(identity);
            await writeGatewayAgentFiles({
              client,
              agentId: created.id,
              files: {
                "IDENTITY.md": files["IDENTITY.md"],
              },
            });
            return { id: created.id };
          },
          setQueuedBlock: ({ agentName, startedAt }) => {
            const queuedCreateBlock = buildQueuedMutationBlock({
              kind: "create-agent",
              agentId: "",
              agentName,
              startedAt,
            });
            setCreateAgentBlock({
              agentName: queuedCreateBlock.agentName,
              phase: "queued",
              startedAt: queuedCreateBlock.startedAt,
            });
          },
          setCreatingBlock: (agentName) => {
            setCreateAgentBlock((current) => {
              if (!current || current.agentName !== agentName) return current;
              return { ...current, phase: "creating" };
            });
          },
          onCompletion: async (completion) => {
            createdAgentId = completion.agentId;
            await loadAgents({ forceSettings: true });
            const createdAgent =
              stateRef.current.agents.find(
                (entry) => entry.agentId === completion.agentId,
              ) ?? null;
            if (createdAgent?.sessionKey) {
              try {
                await applyCreateAgentBootstrapPermissions({
                  client,
                  agentId: createdAgent.agentId,
                  sessionKey: createdAgent.sessionKey,
                  draft: { ...CREATE_AGENT_DEFAULT_PERMISSIONS },
                  loadAgents: () => loadAgents({ forceSettings: true }),
                });
              } catch (error) {
                const message =
                  error instanceof Error
                    ? error.message
                    : t("office.permissionsFailed");
                setError(
                  t("office.createdWithoutPermissions", { message }),
                );
              }
            }
            focusLocalAgent(completion.agentId);
            setCreateAgentBlock(null);
            setCreateAgentModalError(null);
          },
          setCreateAgentModalError,
          setCreateAgentBusy,
          clearCreateBlock: () => {
            setCreateAgentBlock(null);
          },
          onError: setError,
        },
      );
      return success ? createdAgentId : null;
    },
    [
      client,
      createAgentBlock,
      createAgentBusy,
      enqueueConfigMutation,
      focusLocalAgent,
      hasDeleteMutationBlock,
      loadAgents,
      setError,
      status,
    ],
  );
  const handleFinishCreateAgentAvatar = useCallback(
    async (params: {
      agentId: string;
      draft: PersonalityBuilderDraft;
      profile: AgentAvatarProfile;
    }) => {
      setCreateAgentBusy(true);
      setCreateAgentModalError(null);
      try {
        const files = serializePersonalityFiles(params.draft);
        await writeGatewayAgentFiles({
          client,
          agentId: params.agentId,
          files,
        });
        const currentAgent =
          stateRef.current.agents.find((entry) => entry.agentId === params.agentId) ?? null;
        const nextName = params.draft.identity.name.trim();
        const currentName = currentAgent?.name.trim() ?? "";
        if (nextName && nextName !== currentName) {
          const renamed = await renameGatewayAgent({
            client,
            agentId: params.agentId,
            name: nextName,
          });
          if (!renamed) {
            throw new Error(t("office.wizardRenameFailed"));
          }
        }
        handleAvatarProfileSave(params.agentId, params.profile);
        await loadAgents({ forceSettings: true });
        setCreateAgentWizardOpen(false);
        setCreateAgentModalError(null);
        openAgentEditor(params.agentId, "IDENTITY.md");
      } catch (error) {
        const message =
          error instanceof Error ? error.message : t("office.finishCreateFailed");
        setCreateAgentModalError(message);
      } finally {
        setCreateAgentBusy(false);
      }
    },
    [client, handleAvatarProfileSave, loadAgents, openAgentEditor],
  );
  const handleDeleteAgent = useCallback(
    async (agentId: string) => {
      const decision = planAgentSettingsMutation(
        { kind: "delete-agent", agentId },
        {
          status,
          hasCreateBlock: Boolean(createAgentBlock),
          hasRenameBlock: false,
          hasDeleteBlock: Boolean(hasDeleteMutationBlock),
          cronCreateBusy: false,
          cronRunBusyJobId: null,
          cronDeleteBusyJobId: null,
        },
      );
      if (decision.kind === "deny") {
        setError(
          decision.message ?? resolveOfficeMutationGuardMessage(decision.guardReason),
        );
        return;
      }
      const agent = state.agents.find(
        (entry) => entry.agentId === decision.normalizedAgentId,
      );
      if (!agent) return;
      const confirmed = window.confirm(
        t("office.deleteConfirm", { name: agent.name }),
      );
      if (!confirmed) return;

      await runAgentConfigMutationLifecycle({
        kind: "delete-agent",
        label: t("office.deleteTitle", { name: agent.name }),
        isLocalGateway: false,
        deps: {
          enqueueConfigMutation,
          setQueuedBlock: () => {
            const queuedBlock = buildQueuedMutationBlock({
              kind: "delete-agent",
              agentId: decision.normalizedAgentId,
              agentName: agent.name,
              startedAt: Date.now(),
            });
            setDeleteAgentBlock({
              kind: "delete-agent",
              agentId: queuedBlock.agentId,
              agentName: queuedBlock.agentName,
              phase: queuedBlock.phase,
              startedAt: queuedBlock.startedAt,
              sawDisconnect: queuedBlock.sawDisconnect,
            });
          },
          setMutatingBlock: () => {
            setDeleteAgentBlock((current) => {
              if (!current || current.agentId !== decision.normalizedAgentId) {
                return current;
              }
              return {
                ...current,
                phase: "mutating",
              };
            });
          },
          patchBlockAwaitingRestart: (patch) => {
            setDeleteAgentBlock((current) => {
              if (!current || current.agentId !== decision.normalizedAgentId) {
                return current;
              }
              return {
                ...current,
                ...patch,
              };
            });
          },
          clearBlock: () => {
            setDeleteAgentBlock((current) => {
              if (!current || current.agentId !== decision.normalizedAgentId) {
                return current;
              }
              return null;
            });
          },
          executeMutation: async () => {
            await deleteAgentRecordViaStudio({
              client,
              agentId: decision.normalizedAgentId,
              logError: (message, error) => console.error(message, error),
            });
            clearDeletedAgentUiState(decision.normalizedAgentId);
            dispatch({
              type: "removeAgent",
              agentId: decision.normalizedAgentId,
            });
          },
          shouldAwaitRemoteRestart: async () => false,
          reloadAgents: () => loadAgents({ forceSettings: true }),
          setMobilePaneChat: () => {},
          onError: setError,
        },
      });
    },
    [
      clearDeletedAgentUiState,
      client,
      createAgentBlock,
      dispatch,
      enqueueConfigMutation,
      hasDeleteMutationBlock,
      loadAgents,
      setError,
      state.agents,
      status,
    ],
  );

  useEffect(() => {
    if (!createAgentBlock || createAgentBlock.phase === "queued") return;
    const maxWaitMs = 90_000;
    const elapsed = Date.now() - createAgentBlock.startedAt;
    const remaining = Math.max(0, maxWaitMs - elapsed);
    const timeoutId = window.setTimeout(() => {
      setCreateAgentBlock((current) => {
        if (!current || current.phase === "queued") return current;
        return null;
      });
      setCreateAgentBusy(false);
      setCreateAgentWizardOpen(false);
      setError(t("agents.createTimedOut"));
      void loadAgents({ forceSettings: true });
    }, remaining);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [createAgentBlock, loadAgents, setError]);

  const requestAgentHistoryRefresh = useCallback(
    async (params: {
      agentId: string;
      reason: "chat-final-no-trace" | "run-start-no-chat";
      sessionKey?: string;
    }) => {
      if (status !== "connected") return;
      const requestedSessionKey = params.sessionKey?.trim() ?? "";
      if (requestedSessionKey) {
        try {
          const history = await provider.call<{
            messages?: Record<string, unknown>[];
          }>("chat.history", {
            sessionKey: requestedSessionKey,
            limit: RUNTIME_SYNC_DEFAULT_HISTORY_LIMIT,
          });
          const messages = Array.isArray(history.messages)
            ? history.messages
            : [];
          const derived = buildHistoryLines(messages);
          let lastUser = derived.lastUser?.trim() ?? "";
          if (!lastUser) {
            const previewResult = await provider.call<SummaryPreviewSnapshot>(
              "sessions.preview",
              {
                keys: [requestedSessionKey],
                limit: 12,
                maxChars: 400,
              },
            );
            lastUser =
              resolveLatestUserTextFromPreview(
                previewResult,
                requestedSessionKey,
              ) ?? "";
          }
          const targetAgentId =
            parseAgentIdFromSessionKey(requestedSessionKey) ?? params.agentId;
          const patch: Partial<AgentState> = {};
          if (lastUser) {
            patch.lastUserMessage = lastUser;
          }
          if (derived.lastAssistant) {
            patch.latestPreview = derived.lastAssistant;
          }
          if (typeof derived.lastAssistantAt === "number") {
            patch.lastAssistantMessageAt = derived.lastAssistantAt;
          }
          if (typeof derived.lastUserAt === "number") {
            patch.lastActivityAt = derived.lastUserAt;
          }
          if (Object.keys(patch).length > 0) {
            dispatch({
              type: "updateAgent",
              agentId: targetAgentId,
              patch,
            });
          }
          // Do not replay movement directives from history refresh.
          // History can include old transport commands; replaying them causes auto-walks on load.
          setOpenClawLogEntries((previous) => {
            const next = [
              ...previous,
              createOpenClawLogEntry({
                eventName: "history-refresh",
                eventKind: "derived",
                summary: `session=${requestedSessionKey} reason=${params.reason} lastUser=${formatOpenClawValue(lastUser)} lastAssistant=${formatOpenClawValue(derived.lastAssistant)}`,
                messageText: lastUser || null,
                streamText: derived.lastAssistant ?? null,
                payload: {
                  sessionKey: requestedSessionKey,
                  reason: params.reason,
                  historyMessageCount: messages.length,
                  lastUser: lastUser || null,
                  lastAssistant: derived.lastAssistant ?? null,
                },
              }),
            ];
            return next.slice(-MAX_OPENCLAW_LOG_ENTRIES);
          });
          if (debugEnabled) {
            console.info(
              "[office-debug] Refreshed transport session history.",
              {
                agentId: targetAgentId,
                requestedSessionKey,
                reason: params.reason,
                lastUser: lastUser || null,
              },
            );
          }
        } catch (error) {
          setOpenClawLogEntries((previous) => {
            const next = [
              ...previous,
              createOpenClawLogEntry({
                eventName: "history-refresh",
                eventKind: "error",
                summary: `session=${requestedSessionKey} reason=${params.reason} refresh failed`,
                payload: {
                  sessionKey: requestedSessionKey,
                  reason: params.reason,
                  error: error instanceof Error ? error.message : String(error),
                },
              }),
            ];
            return next.slice(-MAX_OPENCLAW_LOG_ENTRIES);
          });
          if (!isGatewayDisconnectLikeError(error)) {
            console.error(
              "Failed to refresh transport session history.",
              error,
            );
          }
        }
        return;
      }
      const commands = await runHistorySyncOperation({
        client: provider,
        agentId: params.agentId,
        getAgent: (agentId) =>
          stateRef.current.agents.find((entry) => entry.agentId === agentId) ??
          null,
        inFlightSessionKeys: historyInFlightRef.current,
        requestId: randomUUID(),
        loadedAt: Date.now(),
        defaultLimit: RUNTIME_SYNC_DEFAULT_HISTORY_LIMIT,
        maxLimit: RUNTIME_SYNC_MAX_HISTORY_LIMIT,
        transcriptV2Enabled: TRANSCRIPT_V2_ENABLED,
      });
      executeHistorySyncCommands({
        commands,
        dispatch,
        logMetric: (metric, meta) => logTranscriptDebugMetric(metric, meta),
        isDisconnectLikeError: isGatewayDisconnectLikeError,
        logError: (message, error) => console.error(message, error),
      });
      if (debugEnabled) {
        console.info("[office-debug] Requested agent history refresh.", {
          agentId: params.agentId,
          reason: params.reason,
        });
      }
    },
    [debugEnabled, dispatch, provider, status],
  );

  const refreshRecentTransportSessionHistory = useCallback(
    (event: EventFrame) => {
      if (event.event !== "health") return;
      const payload =
        event.payload as
          | {
              agents?: Array<{
                agentId?: unknown;
                sessions?: {
                  recent?: Array<{ key?: unknown; updatedAt?: unknown }>;
                };
              }>;
            }
          | undefined;
      const gatewayAgents = Array.isArray(payload?.agents) ? payload.agents : [];
      if (gatewayAgents.length === 0) return;
      for (const gatewayAgent of gatewayAgents) {
        const agentId =
          typeof gatewayAgent?.agentId === "string"
            ? gatewayAgent.agentId.trim()
            : "";
        if (!agentId) continue;
        const localAgent = stateRef.current.agents.find(
          (agent) => agent.agentId === agentId,
        );
        if (!localAgent?.sessionKey) continue;
        const recentSessions = Array.isArray(gatewayAgent.sessions?.recent)
          ? gatewayAgent.sessions.recent
          : [];
        const latestTransportSession = recentSessions.find((entry) => {
          const sessionKey =
            typeof entry?.key === "string" ? entry.key.trim() : "";
          if (!sessionKey) return false;
          if (isSameSessionKey(sessionKey, localAgent.sessionKey)) return false;
          return parseAgentIdFromSessionKey(sessionKey) === agentId;
        });
        if (!latestTransportSession) continue;
        const sessionKey =
          typeof latestTransportSession.key === "string"
            ? latestTransportSession.key.trim()
            : "";
        if (!sessionKey) continue;
        const updatedAt =
          typeof latestTransportSession.updatedAt === "number" &&
          Number.isFinite(latestTransportSession.updatedAt)
            ? latestTransportSession.updatedAt
            : 0;
        const refreshKey = `${sessionKey}:${updatedAt}`;
        if (lastTransportHistoryRefreshKeyRef.current[agentId] === refreshKey) {
          continue;
        }
        lastTransportHistoryRefreshKeyRef.current[agentId] = refreshKey;
        void requestAgentHistoryRefresh({
          agentId,
          reason: "run-start-no-chat",
          sessionKey,
        });
      }
    },
    [requestAgentHistoryRefresh],
  );

  useEffect(() => {
    if (status !== "connected") return;
    // Loaded already, unless all we have is the offline demo seed.
    if (agentsLoaded && !rosterIsPlaceholderRef.current) return;
    void loadAgents({ forceSettings: true });
  }, [agentsLoaded, loadAgents, status]);

  useEffect(() => {
    if (status !== "connected") return;
    if (state.loading) return;
    if (state.agents.length > 0) return;
    const timeoutId = window.setTimeout(() => {
      void loadAgents({ forceSettings: true });
    }, 500);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [loadAgents, state.agents.length, state.loading, status]);

  useEffect(() => {
    if (status === "disconnected") {
      connectionEpochRef.current += 1;
      setCreateAgentWizardOpen(false);
      setCreateAgentBusy(false);
      setCreateAgentModalError(null);
      setCreateAgentBlock(null);
      setDeleteAgentBlock(null);
      loadAgentsInFlightRef.current = null;
      gatewayConfigSnapshot.current = null;
      lastLoadAgentsStartedAtRef.current = 0;
      setLoading(false);
      if (stateRef.current.agents.length === 0) {
        if (selectedAdapterType === "demo") {
          hydrateAgents([createDemoMainAgentSeed()], MAIN_AGENT_ID);
          rosterIsPlaceholderRef.current = true;
          setAgentsLoaded(true);
        } else {
          setAgentsLoaded(false);
          hydrateAgents([]);
        }
      }
      setDebugRows([]);
      lastGatewayActivityAtRef.current = 0;
    }
  }, [hydrateAgents, selectedAdapterType, setLoading, status]);

  useEffect(() => {
    if (selectedAdapterType !== "demo") return;
    if (status !== "disconnected") return;
    if (state.agents.length > 0) return;
    hydrateAgents([createDemoMainAgentSeed()], MAIN_AGENT_ID);
    rosterIsPlaceholderRef.current = true;
    setAgentsLoaded(true);
  }, [hydrateAgents, selectedAdapterType, state.agents.length, status]);

  useEffect(() => {
    if (status !== "connected" || !agentsLoaded) return;
    const runtimeHandler = createGatewayRuntimeEventHandler({
      getStatus: () => status,
      getAgents: () => stateRef.current.agents,
      dispatch: (action) => {
        dispatch(action as never);
      },
      queueLivePatch: (agentId, patch) => {
        dispatch({ type: "updateAgent", agentId, patch });
      },
      clearPendingLivePatch: () => {},
      loadSummarySnapshot: async () => {
        await loadAgents({
          minIntervalMs: 3_000,
          settingsMaxAgeMs: 60_000,
          silent: true,
        });
      },
      requestHistoryRefresh: requestAgentHistoryRefresh,
      refreshHeartbeatLatestUpdate: () => {},
      bumpHeartbeatTick: () => {},
      setTimeout: (fn, delayMs) => window.setTimeout(fn, delayMs),
      clearTimeout: (id) => window.clearTimeout(id),
      isDisconnectLikeError: isGatewayDisconnectLikeError,
      logWarn: (message, meta) => console.warn(message, meta),
      updateSpecialLatestUpdate: () => {},
    });

    // Run reconciliation before subscribing to events so dedup keys are
    // populated in the trigger state. This prevents stale gateway event
    // replays from re-raising old call, text or standup requests on page load.
    setOfficeTriggerState((previous) =>
      reconcileOfficeAnimationTriggerState({
        state: previous,
        agents: stateRef.current.agents,
      }),
    );
    // A large team emits hundreds of events a second. They are applied in
    // batches (same order) from one task, so React renders this screen once
    // per flush instead of once per event.
    let pendingEvents: EventFrame[] = [];
    let flushTimer: number | null = null;
    const handleEvent = (event: EventFrame) => {
      refreshRecentTransportSessionHistory(event);
      if (debugEnabled) {
        console.info("[office-debug] Gateway event.", {
          event: event.event,
          seq: event.seq,
          payload:
            typeof event.payload === "object" && event.payload !== null
              ? JSON.stringify(event.payload).slice(0, 220)
              : (event.payload ?? null),
        });
      }
      if (
        shouldSuppressPhoneBoothAssistantReply({
          event,
          agents: stateRef.current.agents,
          phoneCallByAgentId: officeTriggerStateRef.current.phoneCallByAgentId,
        })
      ) {
        return;
      }
      taskBoardEventHandlerRef.current(event);
      runtimeHandler.handleEvent(event);
    };
    const flushEvents = () => {
      flushTimer = null;
      const batch = pendingEvents;
      pendingEvents = [];
      if (batch.length === 0) return;
      setOpenClawLogEntries((previous) =>
        [...previous, ...batch.slice(-MAX_OPENCLAW_LOG_ENTRIES).map(formatOpenClawEventLogEntry)].slice(
          -MAX_OPENCLAW_LOG_ENTRIES,
        ),
      );
      setOfficeTriggerState((previous) =>
        batch.reduce(
          (state, batched) =>
            reduceOfficeAnimationTriggerEvent({
              state,
              event: batched,
              agents: stateRef.current.agents,
            }),
          previous,
        ),
      );
      for (const event of batch) handleEvent(event);
    };
    const unsubscribeEvent = client.onEvent((event) => {
      lastGatewayActivityAtRef.current = Date.now();
      pendingEvents.push(event);
      if (flushTimer === null) flushTimer = window.setTimeout(flushEvents, EVENT_FLUSH_MS);
    });
    const unsubscribeGap = client.onGap(() => {
      void loadAgents({
        minIntervalMs: 5_000,
        settingsMaxAgeMs: 30_000,
        silent: true,
      });
      void taskBoardRefreshRef.current();
    });

    return () => {
      unsubscribeEvent();
      unsubscribeGap();
      if (flushTimer !== null) window.clearTimeout(flushTimer);
      runtimeHandler.dispose();
    };
  }, [
    agentsLoaded,
    client,
    debugEnabled,
    dispatch,
    loadAgents,
    refreshRecentTransportSessionHistory,
    requestAgentHistoryRefresh,
    status,
  ]);

  useEffect(() => {
    if (status !== "connected" || !agentsLoaded) return;
    const intervalId = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void loadAgents({
        minIntervalMs: 60_000,
        onlyWhenIdleForMs: 120_000,
        settingsMaxAgeMs: 180_000,
        silent: true,
      });
    }, 60_000);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [agentsLoaded, loadAgents, status]);

  useEffect(() => {
    if (status !== "connected" || !agentsLoaded) return;
    const handleFocus = () => {
      if (document.visibilityState !== "visible") return;
      void loadAgents({
        minIntervalMs: 15_000,
        settingsMaxAgeMs: 30_000,
        silent: true,
      });
    };
    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleFocus);
    return () => {
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleFocus);
    };
  }, [agentsLoaded, loadAgents, status]);

  useEffect(() => {
    setOfficeTriggerState((previous) =>
      reconcileOfficeAnimationTriggerState({
        state: previous,
        agents: state.agents,
      }),
    );
  }, [state.agents]);

  useEffect(() => {
    if (status !== "connected") return;
    if (!runtimeSupportsModels) return;
    let cancelled = false;
    void (async () => {
      try {
        const result = await provider.call<{ models: GatewayModelChoice[] }>(
          "models.list",
          {},
        );
        if (!cancelled) {
          setGatewayModels(
            buildGatewayModelChoices(
              Array.isArray(result.models) ? result.models : [],
              null,
            ),
          );
        }
      } catch {
        // Models are optional - chat still works without model selection.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [status, provider, runtimeSupportsModels]);

  useEffect(() => {
    if (chatOpen && !selectedChatAgentId && state.agents.length > 0) {
      setSelectedChatAgentId(state.agents[0].agentId);
    }
  }, [chatOpen, selectedChatAgentId, state.agents]);

  const remoteChatAgentIds = useMemo(
    () =>
      (remoteOfficeSnapshot?.agents ?? []).map(
        (agent) => `${REMOTE_OFFICE_AGENT_ID_PREFIX}${agent.agentId}`,
      ),
    [remoteOfficeSnapshot],
  );

  const chatController = useChatInteractionController({
    client: provider,
    status,
    agents: state.agents,
    dispatch: (action) => dispatch(action as never),
    setError,
    getAgents: () => stateRef.current.agents,
    clearRunTracking: () => {},
    clearHistoryInFlight: () => {},
    clearSpecialUpdateMarker: () => {},
    clearSpecialLatestUpdateInFlight: () => {},
    setInspectSidebarNull: () => {},
    setMobilePaneChat: () => {},
  });

  const focusedChatAgent = selectedChatAgentId
    ? (state.agents.find((agent) => agent.agentId === selectedChatAgentId) ??
      null)
    : null;
  const selectedLocalChatAgentId = focusedChatAgent?.agentId ?? null;
  const agentEditorAgent = agentEditorAgentId
    ? (state.agents.find((agent) => agent.agentId === agentEditorAgentId) ?? null)
    : null;
  const mainAgent =
    state.agents.find((agent) => agent.agentId === MAIN_AGENT_ID) ?? null;

  useEffect(() => {
    if (!selectedChatAgentId) return;
    if (state.agents.some((agent) => agent.agentId === selectedChatAgentId)) return;
    if (remoteChatAgentIds.includes(selectedChatAgentId)) return;
    setSelectedChatAgentId(null);
  }, [remoteChatAgentIds, selectedChatAgentId, state.agents]);

  useEffect(() => {
    if (!agentEditorAgentId) return;
    if (state.agents.some((agent) => agent.agentId === agentEditorAgentId)) return;
    setAgentEditorAgentId(null);
  }, [agentEditorAgentId, state.agents]);

  const runLog = useRunLog({
    client,
    status,
    enabled: runtimeSupportsRunLifecycle,
    agents: state.agents,
  });
  const standupAgentSnapshots = useMemo<StandupAgentSnapshot[]>(
    () =>
      state.agents.map((agent) => ({
        agentId: agent.agentId,
        name: agent.name || agent.agentId,
        latestPreview: agent.latestPreview,
        lastUserMessage: agent.lastUserMessage,
      })),
    [state.agents],
  );
  const standupController = useOfficeStandupController({
    gatewayUrl,
    agents: standupAgentSnapshots,
  });
  // On Hermes the meeting room hosts real meetings chaired by the server
  // (live replies, a summary, tasks); elsewhere, the standup.
  const hermesMeetings = useHermesMeetingController(hermesControl);
  const meetingRoom = hermesMeetings.available ? hermesMeetings : standupController;
  const taskBoard = useTaskBoardController({
    gatewayUrl,
    settingsCoordinator,
    client,
    status,
    cronEnabled: runtimeSupportsCron,
    agents: state.agents,
    runLog,
    standup: standupController,
    // The capture debug is only shown in the OpenClaw console.
    captureDebugEnabled: showOpenClawConsole,
  });
  const ingestTaskBoardEvent = taskBoard.ingestGatewayEvent;
  taskBoardEventHandlerRef.current = ingestTaskBoardEvent;
  taskBoardRefreshRef.current = async () => {
    await taskBoard.refreshSharedTasks();
    await taskBoard.refreshRemoteTasks();
  };
  const marketplace = useOfficeSkillsMarketplace({
    client,
    status,
    enabled: runtimeSupportsSkills,
    agents: state.agents,
    preferredAgentId: selectedLocalChatAgentId,
  });
  // Always on. It is a local request that backs off to every thirty seconds
  // when nothing is live, and reaches the provider only for calls that
  // actually are.
  const callFeed = useOfficeCallFeed();
  // Read when the panel is open, and after each send. A sent message does not
  // change on its own, and there is no inbound channel for a reply.
  const messaging = useOfficeMessaging({ enabled: messagingOpen });
  const callFeedAgents = useMemo(
    () =>
      state.agents.map((agent) => ({
        agentId: agent.agentId,
        name: agent.name,
        // The role is what the phone prompt is built from, so the agent says
        // what it actually does rather than a generic greeting.
        role: agent.role ?? null,
      })),
    [state.agents],
  );
  const skillTriggers = useOfficeSkillTriggers({
    client,
    status,
    enabled: runtimeSupportsSkills,
    agents: state.agents,
  });
  // What the office still acts on from chat and gateway traffic: a call or a
  // text an agent was asked to make (the call feed and messaging panels open
  // for a person to finish it), a standup request, and the short "working"
  // latch that keeps an agent from flickering to idle between runs.
  const {
    pendingStandupRequest,
    phoneCallByAgentId,
    textMessageByAgentId,
    workingUntilByAgentId,
  } = useMemo(
    () => buildOfficeAnimationState({ state: officeTriggerState, agents: state.agents }),
    [officeTriggerState, state.agents],
  );

  useEffect(() => {
    const activeKeys = new Set(
      Object.values(phoneCallByAgentId).map((request) => request.key),
    );
    promptedPhoneCallKeysRef.current = new Set(
      [...promptedPhoneCallKeysRef.current].filter((key) => activeKeys.has(key)),
    );
    preparedPhoneCallKeysRef.current = new Set(
      [...preparedPhoneCallKeysRef.current].filter((key) => activeKeys.has(key)),
    );
  }, [phoneCallByAgentId]);

  useEffect(() => {
    const requests = Object.entries(phoneCallByAgentId);
    if (requests.length === 0) return;

    // "Call my wife" names a person, not a number, and a real call costs
    // money and rings a stranger. So a request opens the office phone with
    // what was asked for, and a human supplies the number and dials. Nothing
    // is placed, and nothing is invented, on an agent's say-so alone.
    const askForMessage = (agentId: string, request: OfficePhoneCallRequest) => {
      if (!state.agents.some((entry) => entry.agentId === agentId)) return;
      promptedPhoneCallKeysRef.current.add(request.key);
      focusLocalAgent(agentId);
      dispatch({
        type: "appendOutput",
        agentId,
        line: buildPhoneCallOutputLine(t("office.askCallScript", { callee: request.callee })),
      });
    };

    const openPhoneForRequest = (agentId: string, request: OfficePhoneCallRequest) => {
      preparedPhoneCallKeysRef.current.add(request.key);
      setCallFeedDraft({
        agentId,
        callee: request.callee,
        message: request.message,
      });
      setCallFeedOpen(true);
    };

    for (const [agentId, request] of requests) {
      if (
        request.phase === "needs_message" &&
        !promptedPhoneCallKeysRef.current.has(request.key)
      ) {
        askForMessage(agentId, request);
      }
      if (
        request.phase === "ready_to_call" &&
        !preparedPhoneCallKeysRef.current.has(request.key)
      ) {
        openPhoneForRequest(agentId, request);
      }
    }
  }, [dispatch, focusLocalAgent, phoneCallByAgentId, state.agents]);

  useEffect(() => {
    const activeKeys = new Set(
      Object.values(textMessageByAgentId).map((request) => request.key),
    );
    promptedTextMessageKeysRef.current = new Set(
      [...promptedTextMessageKeysRef.current].filter((key) => activeKeys.has(key)),
    );
    preparedTextMessageKeysRef.current = new Set(
      [...preparedTextMessageKeysRef.current].filter((key) => activeKeys.has(key)),
    );
  }, [textMessageByAgentId]);

  useEffect(() => {
    const requests = Object.entries(textMessageByAgentId);
    if (requests.length === 0) return;

    // Same rule as calls: a name is not a number, and a message costs money
    // and reaches a stranger. The request opens the messaging panel and a
    // human sends it.
    const askForText = (agentId: string, request: OfficeTextMessageRequest) => {
      if (!state.agents.some((entry) => entry.agentId === agentId)) return;
      promptedTextMessageKeysRef.current.add(request.key);
      focusLocalAgent(agentId);
      dispatch({
        type: "appendOutput",
        agentId,
        line: buildTextMessageOutputLine(
          t("office.askMessageText", { recipient: request.recipient }),
        ),
      });
    };

    const openMessagingForRequest = (
      agentId: string,
      request: OfficeTextMessageRequest,
    ) => {
      preparedTextMessageKeysRef.current.add(request.key);
      setMessagingDraft({
        agentId,
        recipient: request.recipient,
        message: request.message,
      });
      setMessagingOpen(true);
    };

    for (const [agentId, request] of requests) {
      if (
        request.phase === "needs_message" &&
        !promptedTextMessageKeysRef.current.has(request.key)
      ) {
        askForText(agentId, request);
      }
      if (
        request.phase === "ready_to_send" &&
        !preparedTextMessageKeysRef.current.has(request.key)
      ) {
        openMessagingForRequest(agentId, request);
      }
    }
  }, [dispatch, focusLocalAgent, state.agents, textMessageByAgentId]);

  const handleOpenAgentChat = useCallback(
    (agentId: string) => {
      focusChatTarget(agentId);
    },
    [focusChatTarget],
  );
  const updateRemoteChatSession = useCallback(
    (
      agentId: string,
      updater: (session: RemoteChatSessionState) => RemoteChatSessionState,
    ) => {
      setRemoteChatByAgentId((previous) => {
        const current = previous[agentId] ?? EMPTY_REMOTE_CHAT_SESSION;
        return {
          ...previous,
          [agentId]: updater(current),
        };
      });
    },
    [],
  );
  const handleRemoteAgentChatSend = useCallback(
    async (agentId: string, message: string) => {
      const trimmed = message.trim();
      if (!trimmed) return;
      if (trimmed.length > MAX_REMOTE_MESSAGE_CHARS) {
        updateRemoteChatSession(agentId, (session) => ({
          ...session,
          sending: false,
          error: t("office.remoteMessageTooLong", { max: MAX_REMOTE_MESSAGE_CHARS }),
        }));
        return;
      }
      const remoteAgentId = isRemoteOfficeAgentId(agentId)
        ? agentId.slice(REMOTE_OFFICE_AGENT_ID_PREFIX.length)
        : agentId;
      const sentAt = Date.now();
      updateRemoteChatSession(agentId, (session) => ({
        ...session,
        draft: "",
        sending: true,
        handoffing: false,
        error: null,
        messages: [
          ...session.messages,
          {
            id: randomUUID(),
            role: "user",
            text: trimmed,
            timestampMs: sentAt,
          },
        ],
      }));
      try {
        const deliveryMode =
          (remoteChatByAgentId[agentId]?.mode ?? EMPTY_REMOTE_CHAT_SESSION.mode) === "interval"
            ? "interval"
            : "direct";
        const response = await fetch("/api/office/remote-message", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            agentId: remoteAgentId,
            message: trimmed,
            mode: deliveryMode,
          }),
        });
        const payload = (await response.json()) as {
          error?: string;
          assistantText?: string | null;
        };
        if (!response.ok) {
          throw new Error(payload.error || t("office.remoteDeliverFailed"));
        }
        const assistantText =
          typeof payload.assistantText === "string" ? payload.assistantText.trim() : "";
        updateRemoteChatSession(agentId, (session) => ({
          ...session,
          sending: false,
          error: null,
          messages: [
            ...session.messages,
            {
              id: randomUUID(),
              role: "system",
              text: t("office.remoteDelivered"),
              timestampMs: Date.now(),
            },
            ...(assistantText
              ? [
                  {
                    id: randomUUID(),
                    role: "assistant" as const,
                    text: assistantText,
                    timestampMs: Date.now(),
                  },
                ]
              : []),
          ],
        }));
      } catch (error) {
        const messageText =
          error instanceof Error
            ? error.message
            : t("office.remoteDeliverFailed");
        updateRemoteChatSession(agentId, (session) => ({
          ...session,
          sending: false,
          error: messageText,
          messages: [
            ...session.messages,
            {
              id: randomUUID(),
              role: "system",
              text: t("office.deliveryFailed", { message: messageText }),
              timestampMs: Date.now(),
            },
          ],
        }));
      }
    },
    [remoteChatByAgentId, updateRemoteChatSession],
  );

  const handleRemoteAgentHandoff = useCallback(
    async (agentId: string, task: string) => {
      const trimmed = task.trim();
      if (!trimmed) return;
      if (trimmed.length > MAX_REMOTE_MESSAGE_CHARS) {
        updateRemoteChatSession(agentId, (session) => ({
          ...session,
          handoffing: false,
          error: t("office.handoffTooLong", { max: MAX_REMOTE_MESSAGE_CHARS }),
        }));
        return;
      }
      const remoteAgentId = isRemoteOfficeAgentId(agentId)
        ? agentId.slice(REMOTE_OFFICE_AGENT_ID_PREFIX.length)
        : agentId;
      const sessionSnapshot = remoteChatByAgentId[agentId] ?? EMPTY_REMOTE_CHAT_SESSION;
      const sentAt = Date.now();
      updateRemoteChatSession(agentId, (session) => ({
        ...session,
        draft: "",
        sending: false,
        handoffing: true,
        error: null,
        messages: [
          ...session.messages,
          {
            id: randomUUID(),
            role: "system",
            text: t("office.handoffQueued", { text: trimmed }),
            timestampMs: sentAt,
          },
        ],
      }));
      try {
        const historyContext = (
          sessionSnapshot.messages ?? []
        )
          .slice(-6)
          .map((entry) => `${entry.role}: ${entry.text}`)
          .join("\n");
        const response = await fetch("/api/office/remote-handoff", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            agentId: remoteAgentId,
            task: trimmed,
            context: sessionSnapshot.handoffContext.trim() || historyContext || undefined,
            deliverables:
              sessionSnapshot.handoffDeliverables
                .split(",")
                .map((entry) => entry.trim())
                .filter(Boolean).length > 0
                ? sessionSnapshot.handoffDeliverables
                    .split(",")
                    .map((entry) => entry.trim())
                    .filter(Boolean)
                : [t("office.handoffAck"), t("office.handoffNext")],
            acceptanceCriteria:
              sessionSnapshot.handoffAcceptance.trim() ||
              t("office.handoffAcceptance"),
          }),
        });
        const payload = (await response.json()) as { error?: string };
        if (!response.ok) {
          throw new Error(payload.error || t("office.handoffFailed"));
        }
        updateRemoteChatSession(agentId, (session) => ({
          ...session,
          handoffing: false,
          error: null,
          messages: [
            ...session.messages,
            {
              id: randomUUID(),
              role: "system",
              text: t("office.handoffDelivered"),
              timestampMs: Date.now(),
            },
          ],
        }));
      } catch (error) {
        const messageText =
          error instanceof Error ? error.message : t("office.handoffFailed");
        updateRemoteChatSession(agentId, (session) => ({
          ...session,
          handoffing: false,
          error: messageText,
          messages: [
            ...session.messages,
            {
              id: randomUUID(),
              role: "system",
              text: t("office.handoffFailedWith", { message: messageText }),
              timestampMs: Date.now(),
            },
          ],
        }));
      }
    },
    [remoteChatByAgentId, updateRemoteChatSession],
  );

  const lastStandupTriggerKeyRef = useRef<string | null>(null);
  const triggerStandupMeeting = useCallback(
    async (message: string) => {
      const trimmed = message.trim();
      if (!trimmed) return false;
      if (
        meetingRoom.meeting &&
        meetingRoom.meeting.phase !== "complete"
      ) {
        return false;
      }
      if (hermesMeetings.available) {
        // The request itself says what to talk about.
        await hermesMeetings.startMeeting("manual", trimmed);
      } else {
        await standupController.startMeeting("manual");
      }
      return true;
    },
    [hermesMeetings, meetingRoom.meeting, standupController],
  );

  const handleChatSend = useCallback(
    async (agentId: string, sessionKey: string, message: string) => {
      stopVoiceReplyPlayback();
      const trimmed = message.trim();
      if (!trimmed) return;
      if (isRemoteOfficeAgentId(agentId)) {
        await handleRemoteAgentChatSend(agentId, trimmed);
        return;
      }

      const intentSnapshot = resolveOfficeIntentSnapshot(trimmed);
      setOpenClawLogEntries((previous) => {
        const next = [
          ...previous,
          createOpenClawLogEntry({
            eventName: "office-intent",
            eventKind: "derived",
            summary: `agent=${agentId} gym=${intentSnapshot.gym?.source ?? "-"} qa=${intentSnapshot.qa ?? "-"} github=${intentSnapshot.github ?? "-"} desk=${intentSnapshot.desk ?? "-"} text=${intentSnapshot.text?.phase ?? "-"}`,
            payload: {
              agentId,
              message: trimmed,
              normalized: intentSnapshot.normalized,
              intentSnapshot,
            },
          }),
        ];
        return next.slice(-MAX_OPENCLAW_LOG_ENTRIES);
      });
      const pendingPhoneCall = phoneCallByAgentId[agentId] ?? null;
      const pendingTextMessage = textMessageByAgentId[agentId] ?? null;
      // A standup or a text request acts at once rather than waiting for the
      // gateway to echo the message back.
      const hasImmediateOfficeTrigger = Boolean(
        intentSnapshot.standup || intentSnapshot.text,
      );
      const isPhoneCallFollowUp =
        pendingPhoneCall?.phase === "needs_message" &&
        !intentSnapshot.call &&
        !intentSnapshot.text &&
        !intentSnapshot.desk &&
        !intentSnapshot.github &&
        !intentSnapshot.gym &&
        !intentSnapshot.qa &&
        !intentSnapshot.standup;
      const isTextMessageFollowUp =
        pendingTextMessage?.phase === "needs_message" &&
        !intentSnapshot.call &&
        !intentSnapshot.text &&
        !intentSnapshot.desk &&
        !intentSnapshot.github &&
        !intentSnapshot.gym &&
        !intentSnapshot.qa &&
        !intentSnapshot.standup;

      if (
        hasImmediateOfficeTrigger &&
        !intentSnapshot.call &&
        !isPhoneCallFollowUp &&
        !isTextMessageFollowUp
      ) {
        const nowMs = Date.now();
        const runId = randomUUID();
        setOfficeTriggerState((previous) =>
          reduceOfficeAnimationTriggerEvent({
            state: previous,
            agents: stateRef.current.agents,
            nowMs,
            event: {
              type: "event",
              event: "chat",
              payload: {
                runId,
                sessionKey,
                state: "final",
                message: {
                  role: "user",
                  content: trimmed,
                },
              },
            },
          }),
        );
      }

      if (intentSnapshot.call || isPhoneCallFollowUp) {
        const nowMs = Date.now();
        const runId = randomUUID();
        dispatch({
          type: "updateAgent",
          agentId,
          patch: {
            draft: "",
            lastUserMessage: trimmed,
            lastActivityAt: nowMs,
          },
        });
        dispatch({
          type: "appendOutput",
          agentId,
          line: `> ${trimmed}`,
          transcript: {
            source: "local-send",
            runId,
            sessionKey,
            timestampMs: nowMs,
            role: "user",
            kind: "user",
            confirmed: true,
          },
        });
        setOfficeTriggerState((previous) =>
          reduceOfficeAnimationTriggerEvent({
            state: previous,
            agents: stateRef.current.agents,
            nowMs,
            event: {
              type: "event",
              event: "chat",
              payload: {
                runId,
                sessionKey,
                state: "final",
                message: {
                  role: "user",
                  content: trimmed,
                },
              },
            },
          }),
        );
        return;
      }

      await chatController.handleSend(agentId, sessionKey, trimmed);
    },
    [
      chatController,
      dispatch,
      handleRemoteAgentChatSend,
      phoneCallByAgentId,
      stopVoiceReplyPlayback,
      textMessageByAgentId,
    ],
  );

  useEffect(() => {
    if (!pendingStandupRequest) return;
    if (lastStandupTriggerKeyRef.current === pendingStandupRequest.key) return;
    if (
      meetingRoom.meeting &&
      meetingRoom.meeting.phase !== "complete"
    ) {
      return;
    }
    lastStandupTriggerKeyRef.current = pendingStandupRequest.key;
    void triggerStandupMeeting(pendingStandupRequest.message).catch((error) => {
      console.error("Failed to trigger standup meeting.", error);
    });
  }, [pendingStandupRequest, meetingRoom.meeting, triggerStandupMeeting]);

  const transcribeVoicePayload = useCallback(
    async (payload: VoiceSendPayload) => {
      const file = new File([payload.blob], payload.fileName, {
        type: payload.mimeType,
      });
      const formData = new FormData();
      formData.set("audio", file);
      const response = await fetch("/api/office/voice/transcribe", {
        method: "POST",
        body: formData,
      });
      const result = (await response.json().catch(() => null)) as {
        transcript?: string | null;
        error?: string;
        ignored?: boolean;
      } | null;
      if (!response.ok) {
        throw new Error(
          result?.error?.trim() || t("office.transcribeFailed"),
        );
      }
      if (result?.ignored) {
        return null;
      }
      const transcript = result?.transcript?.trim() ?? "";
      if (!transcript) {
        throw new Error(t("office.emptyTranscript"));
      }
      return transcript;
    },
    [],
  );

  const sendVoicePayloadToAgent = useCallback(
    async (
      agent: Pick<AgentState, "agentId" | "sessionKey"> | null,
      payload: VoiceSendPayload,
    ) => {
      if (!agent) {
        throw new Error(t("office.targetNotFound"));
      }
      const transcript = await transcribeVoicePayload(payload);
      if (!transcript) return;
      await handleChatSend(agent.agentId, agent.sessionKey, transcript);
    },
    [handleChatSend, transcribeVoicePayload],
  );

  const handleVoiceSend = useCallback(
    async (payload: VoiceSendPayload) => {
      if (!focusedChatAgent) {
        throw new Error(t("office.selectForPtt"));
      }
      await sendVoicePayloadToAgent(focusedChatAgent, payload);
    },
    [focusedChatAgent, sendVoicePayloadToAgent],
  );

  // A voice command to the whole team becomes a briefing in the HQ: the
  // tribune rises, AM7 walks to it, everyone stands at their desk (running
  // back to it if away), AM7's answer goes up on the wall and is spoken once
  // he stands behind the tribune. It ends a few seconds after it was heard.
  const [hqBriefing, setHqBriefing] = useState<HqBriefing | null>(null);
  const hqBriefingRef = useRef<HqBriefing | null>(null);
  const briefingSpokeRef = useRef(false);
  // The briefing AM7 has reached the tribune for (the HQ reports it once).
  const [hqArrivedId, setHqArrivedId] = useState<string | null>(null);
  const hqArrivedRef = useRef<string | null>(null);
  // AM7's answer, waiting for him to reach the tribune before it is spoken.
  const pendingBriefingSpeechRef = useRef<{ id: string; text: string } | null>(null);
  useEffect(() => {
    hqBriefingRef.current = hqBriefing;
  }, [hqBriefing]);
  const startHqBriefing = useCallback((task: string) => {
    briefingSpokeRef.current = false;
    pendingBriefingSpeechRef.current = null;
    const next: HqBriefing = { id: `briefing-${Date.now().toString(36)}`, task, reply: "", speaking: false };
    hqBriefingRef.current = next;
    setHqBriefing(next);
  }, []);
  useEffect(() => {
    // AM7's answer is spoken while the voice plays and the answer has arrived.
    setHqBriefing((current) => {
      if (!current) return current;
      const speaking = voiceReplyPlaying && Boolean(current.reply);
      if (speaking) briefingSpokeRef.current = true;
      return current.speaking === speaking ? current : { ...current, speaking };
    });
  }, [voiceReplyPlaying]);
  useEffect(() => {
    if (!hqBriefing || hqBriefing.speaking) return;
    const voiced = voiceRepliesLoaded && voiceRepliesEnabled;
    const reply = hqBriefing.reply;
    // No answer yet: wait for it (two minutes at most). AM7 not behind the
    // tribune yet: wait for him (the answer is spoken from there). Then:
    // voiced, a few seconds after it was heard (or if its voice never starts);
    // unvoiced, reading time.
    const delay = !reply
      ? 120_000
      : hqArrivedId !== hqBriefing.id
        ? 90_000
        : briefingSpokeRef.current
        ? 5_000
        : voiced
          ? 25_000
          : Math.min(60_000, Math.max(10_000, reply.length * 70));
    const id = hqBriefing.id;
    const timer = window.setTimeout(() => {
      setHqBriefing((current) => (current && current.id === id ? null : current));
    }, delay);
    return () => window.clearTimeout(timer);
  }, [hqBriefing, hqArrivedId, voiceRepliesEnabled, voiceRepliesLoaded]);

  // After a sign-in the server leaves a short-lived hq_greet cookie (the name
  // to greet, server/access-gate.js): once the team has loaded, the HQ system
  // (not an agent) greets the operator by name, out loud only — the date and
  // time, unread news, operations and security. The cookie is cleared at once.
  const greetNameRef = useRef<string | null>(null);
  useEffect(() => {
    const match = /(?:^|;\s*)hq_greet=([^;]*)/.exec(document.cookie);
    if (!match) return;
    document.cookie = "hq_greet=; Max-Age=0; Path=/; SameSite=Lax";
    let name = "";
    try {
      name = decodeURIComponent(match[1]);
    } catch {
      name = "";
    }
    greetNameRef.current = name === "-" ? "" : name;
  }, []);

  // Hold Alt to talk to the main agent; Alt+Shift to address the whole team,
  // each of whom answers in their own voice.
  const voiceTargetRef = useRef<"main" | "all">("main");
  const [voiceTarget, setVoiceTarget] = useState<"main" | "all">("main");
  const sendVoicePayloadToEveryone = useCallback(
    async (payload: VoiceSendPayload) => {
      const transcript = await transcribeVoicePayload(payload);
      if (!transcript) return;
      startHqBriefing(transcript);
      const team = state.agents.filter((agent) => !isRemoteOfficeAgentId(agent.agentId));
      if (team.length === 0) throw new Error(t("office.targetNotFound"));
      for (const agent of team) {
        const note =
          agent.agentId === MAIN_AGENT_ID ? t("office.addressAllNoteMain") : t("office.addressAllNoteMember");
        await handleChatSend(agent.agentId, agent.sessionKey, `${transcript}\n\n${note}`);
      }
    },
    [handleChatSend, startHqBriefing, state.agents, transcribeVoicePayload],
  );
  const {
    state: mainVoiceState,
    error: mainVoiceError,
    supported: mainVoiceSupported,
    start: startMainVoiceRecording,
    stop: stopMainVoiceRecording,
    clearError: clearMainVoiceError,
  } = useVoiceRecorder({
    enabled: status === "connected" && Boolean(mainAgent),
    onVoiceSend: async (payload) => {
      if (voiceTargetRef.current === "all") {
        await sendVoicePayloadToEveryone(payload);
        return;
      }
      if (!mainAgent) {
        throw new Error(t("office.mainNotFound"));
      }
      await sendVoicePayloadToAgent(mainAgent, payload);
    },
  });

  /** Speaks AM7's briefing answer: in the office's reply voice, else (HQ sound on) straight out. */
  const speakBriefingReply = useCallback(
    (id: string, text: string) => {
      if (voiceRepliesLoaded && voiceRepliesEnabled) {
        enqueueVoiceReply({ text, provider: voiceRepliesPreference.provider, voiceId: voiceForAgent(MAIN_AGENT_ID) });
        return;
      }
      // AM7 answers the floor out loud even with the office's voice replies
      // off, as long as the HQ's sound is on.
      if (!hqSoundOn()) return;
      const mark = (speaking: boolean) =>
        setHqBriefing((current) => (current && current.id === id ? { ...current, speaking } : current));
      mark(true);
      void speakAgent(text, { voiceId: voiceForAgent(MAIN_AGENT_ID), speed: voiceRepliesPreference.speed }).then(
        (spoken) => {
          if (spoken) briefingSpokeRef.current = true;
          mark(false);
        },
      );
    },
    [enqueueVoiceReply, voiceForAgent, voiceRepliesEnabled, voiceRepliesLoaded, voiceRepliesPreference],
  );
  /**
   * AM7's first answer at a briefing: up on the wall at once, spoken once he
   * stands behind the tribune. False when there is no briefing waiting for one.
   */
  const takeBriefingReply = useCallback(
    (text: string): boolean => {
      const briefing = hqBriefingRef.current;
      if (!briefing || briefing.reply) return false;
      const id = briefing.id;
      hqBriefingRef.current = { ...briefing, reply: text };
      setHqBriefing((current) => (current && current.id === id && !current.reply ? { ...current, reply: text } : current));
      if (hqArrivedRef.current === id) speakBriefingReply(id, text);
      else pendingBriefingSpeechRef.current = { id, text };
      return true;
    },
    [speakBriefingReply],
  );
  const handleLeadAtTribune = useCallback(
    (id: string) => {
      hqArrivedRef.current = id;
      setHqArrivedId(id);
      const pending = pendingBriefingSpeechRef.current;
      if (pending && pending.id === id) {
        pendingBriefingSpeechRef.current = null;
        speakBriefingReply(id, pending.text);
      }
    },
    [speakBriefingReply],
  );
  // The archive cart and the maintenance service, as console lines: who took
  // the cart out and what it freed, a run with nothing to take out, and the dev
  // server's memory when it needs a restart. The cart parking stays quiet.
  const handleHqArchiveEvent = useCallback((event: HqMaintenanceLogEvent) => {
    const line = describeMaintenanceLogEvent(event);
    if (!line) return;
    const entry = createOpenClawLogEntry({
      eventName: "hq-archive",
      eventKind: "derived",
      summary: line,
      payload: event,
    });
    setOpenClawLogEntries((previous) =>
      [...previous, entry].slice(-MAX_OPENCLAW_LOG_ENTRIES),
    );
  }, []);
  useEffect(() => {
    // Development aid: start a briefing without a microphone, e.g.
    // window.__hqBriefing("Проверить периметр", "Цель: … План: …").
    if (process.env.NODE_ENV === "production") return;
    const w = window as unknown as { __hqBriefing?: (task: string, reply?: string) => void };
    w.__hqBriefing = (task: string, reply?: string) => {
      startHqBriefing(task);
      if (reply) takeBriefingReply(reply);
    };
    return () => {
      delete w.__hqBriefing;
    };
  }, [startHqBriefing, takeBriefingReply]);

  useFinalizedAssistantReplyListener(state.agents, ({ agentId, text }) => {
    if (hqBriefingRef.current) {
      // At a briefing AM7's first answer goes up on the screens; the rest of
      // the team answers in their chats, not all out loud at once.
      if (agentId !== MAIN_AGENT_ID) return;
      if (takeBriefingReply(text)) return;
    }
    if (!voiceRepliesLoaded || !voiceRepliesEnabled) return;
    enqueueVoiceReply({
      text,
      provider: voiceRepliesPreference.provider,
      voiceId: voiceForAgent(agentId),
    });
  });

  // What the main agent says to everyone, and what it asks the person to
  // decide, is spoken in its voice.
  useEffect(() => {
    if (!hermesControl.available) return;
    return hermesControl.onEvent((frame) => {
      if (!voiceRepliesLoaded || !voiceRepliesEnabled) return;
      let text = "";
      if (frame.event === "org.announcement") {
        text = String((frame.payload as { text?: unknown } | undefined)?.text ?? "");
      } else if (frame.event === "exec.approval.requested") {
        const payload = frame.payload as { escalation?: { reason?: unknown } | null; request?: { agentId?: unknown } } | undefined;
        if (!payload?.escalation) return;
        const agentId = String(payload.request?.agentId ?? "");
        const agentName = state.agents.find((agent) => agent.agentId === agentId)?.name ?? agentId;
        text = t("approvals.spokenEscalation", { agent: agentName, reason: String(payload.escalation.reason ?? "") });
      } else if (frame.event === "org.proposal") {
        const proposal = (frame.payload as { proposal?: { status?: string; kind?: string; name?: string; reason?: string } } | undefined)?.proposal;
        if (proposal?.status !== "pending") return;
        const reason = String(proposal.reason ?? "").slice(0, 300);
        text =
          proposal.kind === "hire"
            ? t("proposals.spokenHire", { name: proposal.name ?? "", reason })
            : t("proposals.spokenDismiss", { name: proposal.name ?? "", reason });
      }
      if (!text.trim()) return;
      enqueueVoiceReply({ text, provider: voiceRepliesPreference.provider, voiceId: voiceForAgent(MAIN_AGENT_ID) });
    });
  }, [enqueueVoiceReply, hermesControl, state.agents, voiceForAgent, voiceRepliesEnabled, voiceRepliesLoaded, voiceRepliesPreference.provider]);

  // Meetings are spoken turn by turn, each participant in their own voice,
  // as each finishes speaking (the queue keeps the order).
  const spokenMeetingTurnsRef = useRef<Set<string>>(new Set());
  const hermesMeeting = hermesMeetings.hermesMeeting;
  useEffect(() => {
    if (!hermesMeeting) return;
    const spoken = spokenMeetingTurnsRef.current;
    hermesMeeting.transcript.forEach((entry, index) => {
      const key = `${hermesMeeting.id}:${index}`;
      if (entry.status !== "done" || !entry.text || spoken.has(key)) return;
      spoken.add(key);
      if (!voiceRepliesLoaded || !voiceRepliesEnabled) return;
      enqueueVoiceReply({
        text: entry.text,
        provider: voiceRepliesPreference.provider,
        voiceId: voiceForAgent(entry.agentId),
      });
    });
  }, [enqueueVoiceReply, hermesMeeting, voiceForAgent, voiceRepliesEnabled, voiceRepliesLoaded, voiceRepliesPreference.provider]);

  useEffect(() => {
    const optionHeldRef = { current: false };
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Alt" || event.repeat || optionHeldRef.current) return;
      optionHeldRef.current = true;
      event.preventDefault();
      const target = event.shiftKey ? "all" : "main";
      voiceTargetRef.current = target;
      setVoiceTarget(target);
      void startMainVoiceRecording();
    };
    const handleKeyUp = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Alt") return;
      optionHeldRef.current = false;
      event.preventDefault();
      stopMainVoiceRecording();
    };
    const handleWindowBlur = () => {
      optionHeldRef.current = false;
      stopMainVoiceRecording();
    };
    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("keyup", handleKeyUp, true);
    window.addEventListener("blur", handleWindowBlur);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("keyup", handleKeyUp, true);
      window.removeEventListener("blur", handleWindowBlur);
    };
  }, [startMainVoiceRecording, stopMainVoiceRecording]);

  useEffect(() => {
    if (!settingsOpen) return;
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setSettingsOpen(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [settingsOpen]);

  useEffect(() => {
    if (!mainVoiceError) return;
    const timer = window.setTimeout(() => {
      clearMainVoiceError();
    }, 4000);
    return () => {
      window.clearTimeout(timer);
    };
  }, [clearMainVoiceError, mainVoiceError]);

  // An agent active a moment ago still shows as working, so the hall does not
  // flicker to idle between runs. Cached per agent, so a large team is not
  // re-mapped on every render.
  const officeAgents = useMemo(() => {
    void clockTick;
    const now = Date.now();
    const nextCache = new Map<string, OfficeAgentCacheEntry>();
    const nextOfficeAgents = state.agents.map((agent) => {
      const latchedWorking = (workingUntilByAgentId[agent.agentId] ?? 0) > now;
      const cached = officeAgentCacheRef.current.get(agent.agentId);
      if (cached && cached.agent === agent && cached.latchedWorking === latchedWorking) {
        nextCache.set(agent.agentId, cached);
        return cached.officeAgent;
      }
      const effectiveAgent: AgentState =
        latchedWorking && agent.status !== "error"
          ? {
              ...agent,
              status: "running",
              runId: agent.runId ?? `latched-${agent.agentId}`,
            }
          : agent;
      const officeAgent = mapAgentToOffice(effectiveAgent);
      nextCache.set(agent.agentId, { agent, latchedWorking, officeAgent });
      return officeAgent;
    });
    officeAgentCacheRef.current = nextCache;
    return nextOfficeAgents;
  }, [clockTick, state.agents, workingUntilByAgentId]);
  const openClawLiveStateText = useMemo(() => {
    const lines = [t("office.liveStateHeader")];
    if (state.agents.length === 0) {
      lines.push(t("office.noAgentsLoaded"));
      return lines.join("\n");
    }

    for (const agent of state.agents) {
      lines.push("");
      lines.push(`[${agent.agentId}] ${agent.name || t("office.agentFallback")}`);
      lines.push(
        `status=${agent.status} runId=${agent.runId ?? "-"} session=${agent.sessionKey}`,
      );
      lines.push(
        `lastActivity=${agent.lastActivityAt ? formatOpenClawTimestamp(agent.lastActivityAt) : "-"} lastAssistant=${agent.lastAssistantMessageAt ? formatOpenClawTimestamp(agent.lastAssistantMessageAt) : "-"}`,
      );
      lines.push(
        `latestPreview=${formatOpenClawValue(agent.latestPreview)} lastUser=${formatOpenClawValue(agent.lastUserMessage)}`,
      );
      if (agent.thinkingTrace?.trim()) {
        lines.push("thinking>");
        lines.push(agent.thinkingTrace.trim());
      }
      if (agent.streamText?.trim()) {
        lines.push("assistant_stream>");
        lines.push(agent.streamText.trim());
      }
      const recentOutput = agent.outputLines
        .slice(-MAX_OPENCLAW_AGENT_OUTPUT_LINES)
        .map((line) => line.trimEnd())
        .filter(Boolean);
      if (recentOutput.length > 0) {
        lines.push("recent_output>");
        lines.push(...recentOutput);
      }
    }

    return lines.join("\n");
  }, [state.agents]);
  const remoteOfficeAgents = useMemo(
    () =>
      (remoteOfficeSnapshot?.agents ?? []).map((agent) =>
        mapRemotePresenceAgentToOffice(agent)
      ),
    [remoteOfficeSnapshot]
  );
  const chatRosterEntries = useMemo<ChatRosterEntry[]>(
    () => [
      ...state.agents.map((agent) => ({
        id: agent.agentId,
        name: agent.name || agent.agentId,
        kind: "local" as const,
        isRunning: agent.status === "running",
      })),
      ...remoteOfficeAgents.map((agent) => ({
        id: agent.id,
        name: agent.name || agent.id,
        kind: "remote" as const,
        isRunning: agent.status === "working",
      })),
    ],
    [remoteOfficeAgents, state.agents],
  );
  const focusedRemoteChatTarget = selectedChatAgentId
    ? (remoteOfficeAgents.find((agent) => agent.id === selectedChatAgentId) ?? null)
    : null;
  const focusedRemoteChatState = focusedRemoteChatTarget
    ? (remoteChatByAgentId[focusedRemoteChatTarget.id] ?? EMPTY_REMOTE_CHAT_SESSION)
    : null;
  // The hall seats the local team and, when one is configured, the agents of
  // the remote office.
  const hqAgents = useMemo<HqAgentInput[]>(
    () =>
      [...officeAgents, ...remoteOfficeAgents].map((agent) => ({
        id: agent.id,
        name: agent.name,
        role: agent.subtitle ?? null,
        status: agent.status,
      })),
    [officeAgents, remoteOfficeAgents],
  );
  // The greeting is composed a moment after the team has loaded, so the
  // statuses it reports have arrived (the same ones the HQ's counters show).
  const greetAgentsRef = useRef({ hq: hqAgents, all: state.agents });
  useEffect(() => {
    greetAgentsRef.current = { hq: hqAgents, all: state.agents };
  }, [hqAgents, state.agents]);
  // The system speaks in the office's own voice (not AM7's), treated to sound synthetic.
  const greetVoiceRef = useRef<string | null>(voiceRepliesPreference.voiceId ?? null);
  useEffect(() => {
    greetVoiceRef.current = voiceRepliesPreference.voiceId ?? null;
  }, [voiceRepliesPreference.voiceId]);
  // The greeting, in step with the opening fly-through. The opening (the
  // welcome, today's date and the time) is fetched as soon as the page knows
  // it is a fresh sign-in and starts with the camera; the status report
  // (unread, operations, security) follows once the opening has finished and
  // the whole team has loaded, in the same voice. Silent while the HQ's sound
  // is off; if the browser holds sound back, it plays at the first click.
  const greetOpeningRef = useRef<PreparedSpeech | null>(null);
  const greetVoiceUsedRef = useRef<string | null>(null);
  const greetStartedRef = useRef(false);
  const greetStatusSpokenRef = useRef(false);
  const [greetOpeningDone, setGreetOpeningDone] = useState(false);
  useEffect(() => {
    const name = greetNameRef.current;
    if (name === null || greetOpeningRef.current) return;
    if (!hqSoundOn()) {
      greetNameRef.current = null;
      return;
    }
    greetVoiceUsedRef.current = greetVoiceRef.current;
    greetOpeningRef.current = prepareSystemSpeech(
      hqGreetingOpening({ name, now: new Date(), timeZone: hqTimeZone() }).join(" "),
      { voiceId: greetVoiceUsedRef.current },
    );
  }, []);
  useEffect(() => {
    const opening = greetOpeningRef.current;
    if (!opening || greetStartedRef.current) return;
    const start = () => {
      if (greetStartedRef.current) return;
      greetStartedRef.current = true;
      void opening.play().finally(() => setGreetOpeningDone(true));
    };
    if (hqIntroPlaying) {
      start();
      return;
    }
    // No fly-through (another view, or it never starts): speak anyway.
    const timer = window.setTimeout(start, GREET_WITHOUT_INTRO_MS);
    return () => window.clearTimeout(timer);
  }, [hqIntroPlaying]);
  useEffect(() => {
    if (!greetOpeningDone || greetStatusSpokenRef.current) return;
    if (!rosterFromGateway || status !== "connected") return;
    greetStatusSpokenRef.current = true;
    greetNameRef.current = null;
    const { hq, all } = greetAgentsRef.current;
    let working = 0;
    let errors = 0;
    for (const agent of hq) {
      if (agent.status === "working") working += 1;
      else if (agent.status === "error") errors += 1;
    }
    const lines = hqGreetingStatus({
      name: "",
      now: new Date(),
      timeZone: hqTimeZone(),
      unread: all.filter((agent) => agent.hasUnseenActivity).length,
      working,
      idle: hq.length - working - errors,
      errors,
      connected: true,
    });
    void speakSystem(lines.join(" "), { voiceId: greetVoiceUsedRef.current });
  }, [greetOpeningDone, rosterFromGateway, status]);
  const remoteMessagingAvailable =
    remoteOfficeSourceKind === "openclaw_gateway" &&
    remoteOfficeGatewayUrl.trim().length > 0;
  const remoteMessagingDisabledReason = remoteMessagingAvailable
    ? null
    : remoteOfficeSourceKind !== "openclaw_gateway"
      ? t("office.remoteMsgGatewayOnly")
      : remoteOfficeGatewayUrl.trim().length === 0
      ? t("office.remoteMsgNeedsUrl")
      : t("office.remoteMsgUnavailable");
  const normalizedOpenClawConsoleSearch = openClawConsoleSearch
    .trim()
    .toLowerCase();
  const filteredOpenClawLogEntries = useMemo(() => {
    if (!normalizedOpenClawConsoleSearch) return openClawLogEntries;
    return openClawLogEntries.filter((entry) =>
      [
        entry.timestamp,
        entry.eventName,
        entry.eventKind,
        entry.summary,
        entry.role ?? "",
        entry.messageText ?? "",
        entry.thinkingText ?? "",
        entry.streamText ?? "",
        entry.toolText ?? "",
        entry.payloadText,
      ]
        .join("\n")
        .toLowerCase()
        .includes(normalizedOpenClawConsoleSearch),
    );
  }, [normalizedOpenClawConsoleSearch, openClawLogEntries]);
  const openClawLiveStateMatchesSearch = useMemo(() => {
    if (!normalizedOpenClawConsoleSearch) return true;
    return openClawLiveStateText
      .toLowerCase()
      .includes(normalizedOpenClawConsoleSearch);
  }, [normalizedOpenClawConsoleSearch, openClawLiveStateText]);
  // Built on demand: serialising the log on every render of a busy office was wasted work.
  const buildOpenClawConsoleExportJson = useCallback(
    () =>
      safeJsonStringify({
        exportedAt: new Date().toISOString(),
        searchQuery: openClawConsoleSearch,
        visibleEventCount: filteredOpenClawLogEntries.length,
        totalEventCount: openClawLogEntries.length,
        liveStateMatchesSearch: openClawLiveStateMatchesSearch,
        liveStateText: openClawLiveStateText,
        events: filteredOpenClawLogEntries,
      }),
    [
      filteredOpenClawLogEntries,
      openClawConsoleSearch,
      openClawLiveStateMatchesSearch,
      openClawLiveStateText,
      openClawLogEntries.length,
    ],
  );

  const handleClearOpenClawConsole = useCallback(() => {
    setOpenClawLogEntries([]);
  }, []);
  const handleCopyOpenClawConsoleJson = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(buildOpenClawConsoleExportJson());
      setOpenClawConsoleCopyStatus("copied");
      window.setTimeout(() => {
        setOpenClawConsoleCopyStatus("idle");
      }, 1800);
    } catch (error) {
      console.error("Failed to copy OpenClaw console JSON.", error);
      setOpenClawConsoleCopyStatus("error");
      window.setTimeout(() => {
        setOpenClawConsoleCopyStatus("idle");
      }, 1800);
    }
  }, [buildOpenClawConsoleExportJson]);
  const handleDownloadOpenClawConsoleJson = useCallback(() => {
    const blob = new Blob([buildOpenClawConsoleExportJson()], {
      type: "application/json;charset=utf-8",
    });
    const url = window.URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `openclaw-events-${Date.now()}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.URL.revokeObjectURL(url);
  }, [buildOpenClawConsoleExportJson]);

  const soundclawSkill = useMemo<SkillStatusEntry | null>(
    () =>
      marketplace.skillsReport?.skills.find((skill) => {
        const normalizedKey = skill.skillKey.trim().toLowerCase();
        const normalizedName = skill.name.trim().toLowerCase();
        return normalizedKey === "soundclaw" || normalizedName === "soundclaw";
      }) ?? null,
    [marketplace.skillsReport],
  );
  const soundclawReady = useMemo(
    () => (soundclawSkill ? deriveSkillReadinessState(soundclawSkill) === "ready" : false),
    [soundclawSkill]
  );

  useEffect(() => {
    if (!soundclawReady || !jukeboxToken) {
      return;
    }

    const pending = pendingJukeboxCommandTimeoutsRef.current;
    const activeAgentIds = new Set<string>();

    for (const agent of state.agents) {
      if (skillTriggers.movementTargetByAgentId[agent.agentId] !== "jukebox") {
        continue;
      }

      const request = getLatestUserRequestForAgent(agent);
      if (!request) {
        continue;
      }

      activeAgentIds.add(agent.agentId);
      const handledKey = handledJukeboxRequestKeyByAgentIdRef.current[agent.agentId];
      if (handledKey === request.requestKey) {
        continue;
      }

      const existing = pending.get(agent.agentId);
      if (existing?.requestKey === request.requestKey) {
        continue;
      }
      if (existing) {
        window.clearTimeout(existing.timeoutId);
        pending.delete(agent.agentId);
      }

      const timeoutId = window.setTimeout(() => {
        void executeBrowserJukeboxCommand(request.text).then((result) => {
          if (result.ok) {
            handledJukeboxRequestKeyByAgentIdRef.current[agent.agentId] = request.requestKey;
            setJukeboxOpen(true);
            dispatch({
              type: "appendOutput",
              agentId: agent.agentId,
              line: result.reply,
              transcript: {
                role: "assistant",
                kind: "assistant",
                source: "legacy",
                sessionKey: agent.sessionKey,
                timestampMs: Date.now(),
                confirmed: true,
              },
            });
            dispatch({
              type: "updateAgent",
              agentId: agent.agentId,
              patch: {
                latestOverride: result.reply,
                latestOverrideKind: null,
                latestPreview: result.reply,
                lastAssistantMessageAt: Date.now(),
              },
            });
          }
          const latest = pendingJukeboxCommandTimeoutsRef.current.get(agent.agentId);
          if (latest?.timeoutId === timeoutId) {
            pendingJukeboxCommandTimeoutsRef.current.delete(agent.agentId);
          }
        });
      }, 1400);

      pending.set(agent.agentId, {
        requestKey: request.requestKey,
        timeoutId,
      });
    }

    for (const [agentId, pendingEntry] of pending.entries()) {
      if (activeAgentIds.has(agentId)) continue;
      window.clearTimeout(pendingEntry.timeoutId);
      pending.delete(agentId);
    }
  }, [
    dispatch,
    jukeboxToken,
    skillTriggers.movementTargetByAgentId,
    soundclawReady,
    state.agents,
  ]);

  // No longer force-close the jukebox panel when skill is disabled;
  // the panel handles the disabled state itself.

  useEffect(() => {
    if (
      status === "connecting" &&
      !agentsLoaded &&
      gatewayUrl.trim().length > 0 &&
      !shouldPromptForConnect
    ) {
      const timeoutId = window.setTimeout(() => {
        setShowDelayedGatewayLoadingOverlay(true);
      }, GATEWAY_LOADING_OVERLAY_DELAY_MS);
      return () => {
        window.clearTimeout(timeoutId);
      };
    }
    setShowDelayedGatewayLoadingOverlay(false);
  }, [agentsLoaded, gatewayUrl, shouldPromptForConnect, status]);

  useEffect(() => {
    if (
      status === "disconnected" &&
      !agentsLoaded &&
      didAttemptGatewayConnect &&
      !shouldPromptForConnect
    ) {
      const timeoutId = window.setTimeout(() => {
        setShowDelayedGatewayConnectOverlay(true);
      }, GATEWAY_CONNECT_OVERLAY_DELAY_MS);
      return () => {
        window.clearTimeout(timeoutId);
      };
    }
    setShowDelayedGatewayConnectOverlay(false);
  }, [agentsLoaded, didAttemptGatewayConnect, shouldPromptForConnect, status]);

  const showGatewayLoadingOverlay =
    !agentsLoaded &&
    (!connectPromptReady ||
      (gatewayUrl.trim().length > 0 &&
        !shouldPromptForConnect &&
        ((!didAttemptGatewayConnect && showDelayedGatewayLoadingOverlay) ||
          (status === "connecting" && showDelayedGatewayLoadingOverlay))));
  const showGatewayConnectOverlay =
    connectPromptReady &&
    status === "disconnected" &&
    !agentsLoaded &&
    (shouldPromptForConnect || showDelayedGatewayConnectOverlay);

  const runningCount = state.agents.filter(
    (agent) => agent.status === "running",
  ).length;
  const unseenInboxCount = state.agents.filter(
    (agent) => agent.hasUnseenActivity,
  ).length;
  const showEmptyFleetBanner =
    status === "connected" && agentsLoaded && state.agents.length === 0;
  const emptyFleetMessage =
    state.error?.trim() ||
    t("office.noAgentsInOffice");

  return (
    <HermesControlProvider value={hermesControl}>
    <main className="hq-theme relative h-full w-full overflow-hidden bg-black">
      {showGatewayLoadingOverlay ? (
        <div
          className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center bg-black/80"
          aria-label={t("office.connectingRuntime")}
          role="status"
        >
          <div className="overflow-hidden rounded-lg border border-border bg-card/95 shadow-[0_0_60px_rgba(0,0,0,0.85),0_0_32px_rgba(255,26,26,0.1)]">
            <div aria-hidden className="h-px bg-gradient-to-r from-transparent via-primary/80 to-transparent" />
            <RunningAvatarLoader
              size={28}
              trackWidth={76}
              label={t("office.connectingRuntimeLong")}
              className="px-8 py-6"
              labelClassName="uppercase tracking-[0.16em] text-white/70"
            />
          </div>
        </div>
      ) : null}
      {showGatewayConnectOverlay ? (
        // Scrolls on its own: on a short window the connect form is taller than
        // the screen, and the office behind it never scrolls.
        <div className="pointer-events-auto absolute inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/80 px-4 py-10">
          <div className="relative w-full max-w-[860px] overflow-hidden rounded-xl border border-border bg-background/95 p-3 shadow-[0_0_80px_rgba(0,0,0,0.9),0_0_40px_rgba(255,26,26,0.08)]">
            <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/80 to-transparent" />
            <GatewayConnectScreen
              gatewayUrl={gatewayUrl}
              token={token}
              selectedAdapterType={selectedAdapterType}
              activeAdapterType={activeAdapterType}
              localGatewayDefaults={localGatewayDefaults}
              status={status}
              error={gatewayError}
              showApprovalHint={didAttemptGatewayConnect}
              onGatewayUrlChange={setGatewayUrl}
              onTokenChange={setToken}
              onAdapterTypeChange={setSelectedAdapterType}
              onUseLocalDefaults={useLocalGatewayDefaults}
              onConnect={() => void connect()}
            />
          </div>
        </div>
      ) : null}
      <section className="relative h-full min-h-0 min-w-0 overflow-hidden">
        <HqOffice
          agents={hqAgents}
          namespace={activeFloor.id}
          selectedAgentId={selectedChatAgentId ?? state.selectedAgentId ?? null}
          onAgentSelect={handleOpenAgentChat}
          runtimeStatus={{ adapter: activeAdapterType, status }}
          settingsOpen={settingsOpen}
          onOpenSettings={() => setSettingsOpen((open) => !open)}
          onOpenCombat={() => setCombatOpen(true)}
          onIntroChange={setHqIntroPlaying}
          briefing={hqBriefing}
          onLeadAtTribune={handleLeadAtTribune}
          onArchiveEvent={handleHqArchiveEvent}
        />
        {jukeboxOpen ? (
          soundclawReady ? (
            <JukeboxPanel
              client={client}
              onClose={() => setJukeboxOpen(false)}
              selectedAgentName={focusedChatAgent?.name ?? null}
            />
          ) : (
            <JukeboxDisabledPanel
              onClose={() => setJukeboxOpen(false)}
              onInstall={() => {
                setJukeboxOpen(false);
                setMarketplaceOpen(true);
              }}
            />
          )
        ) : null}
      </section>

      {showEmptyFleetBanner ? (
        <div className="pointer-events-none fixed left-1/2 top-[100px] z-40 w-full max-w-xl -translate-x-1/2 px-4">
          <div className="pointer-events-auto rounded-lg border border-primary/35 bg-black/80 px-4 py-3 shadow-[0_0_40px_rgba(0,0,0,0.8),0_0_24px_rgba(255,26,26,0.12)] backdrop-blur-sm">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--status-running-fg)]">
                  <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary shadow-[0_0_8px_rgba(255,42,42,0.9)]" />
                  {t("office.fleetStatus")}
                </p>
                <p className="mt-1 text-sm text-white">{emptyFleetMessage}</p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="inline-flex items-center justify-center rounded-md bg-primary px-3 py-2 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-primary-foreground shadow-[0_0_14px_rgba(255,26,26,0.25)] transition-colors hover:bg-ring"
                  onClick={() => {
                    handleOpenCreateAgentWizard();
                  }}
                >
                  {t("office.addAgent")}
                </button>
                <button
                  type="button"
                  className="inline-flex items-center justify-center rounded-md border border-primary/35 bg-black/40 px-3 py-2 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-white/85 transition-colors hover:border-ring/60 hover:bg-primary/15 hover:text-white"
                  onClick={() => {
                    void loadAgents({ forceSettings: true });
                  }}
                >
                  {t("office.retry")}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <TeamProposalsTray onTeamChanged={handleTeamChanged} />
      <AnnouncementToast />
      <HermesUpdateCard />

      {deleteAgentStatusLine ? (
        <div className="pointer-events-none fixed left-1/2 top-[100px] z-40 -translate-x-1/2 px-4">
          <div className="pointer-events-auto rounded-lg border border-red-400/30 bg-black/85 px-4 py-3 shadow-2xl backdrop-blur">
            <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-red-200/75">
              {t("office.fleetMutation")}
            </div>
            <div className="mt-1 text-sm text-red-50">{deleteAgentStatusLine}</div>
          </div>
        </div>
      ) : null}

      {!debugEnabled ? (
        // Hidden with the rest of the chrome while the HQ fly-through plays.
        <div className={`transition-opacity duration-700 ${hqIntroPlaying ? "opacity-0 [&_*]:!pointer-events-none" : "opacity-100"}`}>
        <HQSidebar
          open={sidebarOpen}
          activeTab={activeSidebarTab}
          inboxCount={unseenInboxCount}
          onToggle={() => setSidebarOpen((prev) => !prev)}
          onTabChange={setActiveSidebarTab}
          onOpenMarketplace={() => setMarketplaceOpen(true)}
          onAddAgent={handleOpenCreateAgentWizard}
          inboxPanel={
            <InboxPanel
              agents={state.agents}
              onSelectAgent={(agentId) => {
                handleOpenAgentChat(agentId);
                setActiveSidebarTab("inbox");
              }}
            />
          }
          historyPanel={
            <HistoryPanel
              runs={runLog}
              agents={state.agents}
              onSelectAgent={(agentId) => {
                handleOpenAgentChat(agentId);
                setActiveSidebarTab("history");
              }}
            />
          }
          kanbanPanel={
            <TaskBoardPanel
              agents={state.agents}
              cardsByStatus={taskBoard.cardsByStatus}
              selectedCard={taskBoard.selectedCard}
              activeRuns={taskBoard.activeRuns}
              cronJobs={taskBoard.cronJobs}
              cronLoading={taskBoard.cronLoading}
              cronError={
                taskBoard.sharedTasksError ?? taskBoard.gatewayTasksError ?? taskBoard.cronError
              }
              taskCaptureDebug={showOpenClawConsole ? taskBoard.taskCaptureDebug : undefined}
              onCreateCard={() => {
                taskBoard.createManualCard();
                setActiveSidebarTab("kanban");
              }}
              onMoveCard={taskBoard.moveCard}
              onSelectCard={taskBoard.selectCard}
              onUpdateCard={taskBoard.updateCard}
              onDeleteCard={taskBoard.removeCard}
              onRefreshCronJobs={() => {
                void taskBoard.refreshSharedTasks();
                void taskBoard.refreshRemoteTasks();
                void taskBoard.refreshCronJobs();
              }}
            />
          }
          playbooksPanel={
            <PlaybooksPanel
              client={client}
              status={status}
              cronEnabled={runtimeSupportsCron}
              agents={state.agents}
              standup={standupController}
            />
          }
          analyticsPanel={
            <AnalyticsPanel
              client={client}
              status={status}
              approvalsEnabled={runtimeSupportsApprovals}
              agents={state.agents}
              runLog={runLog}
              gatewayUrl={gatewayUrl}
              settingsCoordinator={settingsCoordinator}
              onSelectAgent={(agentId) => {
                handleOpenAgentChat(agentId);
                setActiveSidebarTab("analytics");
              }}
            />
          }
          contourPanel={<AegisContourPanel />}
        />
        </div>
      ) : null}

      {combatOpen ? (
        <CombatConsole agents={state.agents} runLog={runLog} onClose={() => setCombatOpen(false)} />
      ) : null}

      {settingsOpen ? (
        // Above the scene, the HUD and the sidebar, below the chat (z-30); it
        // stops short of the chat button so nothing in it hides behind it.
        <div
          className="fixed inset-0 z-[25] flex justify-end bg-black/50 px-3 pb-[70px] pt-3 backdrop-blur-[1px]"
          onClick={(event) => {
            if (event.target === event.currentTarget) setSettingsOpen(false);
          }}
        >
          <div
            role="dialog"
            aria-labelledby="office-settings-title"
            className="relative flex h-full w-full max-w-[440px] flex-col overflow-hidden rounded-lg border border-border bg-background/95 shadow-[0_0_60px_rgba(0,0,0,0.85),0_0_32px_rgba(255,26,26,0.08)]"
          >
            <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/80 to-transparent" />
            <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
              <div>
                <div
                  id="office-settings-title"
                  className="flex items-center gap-2 font-mono text-[11px] font-semibold uppercase tracking-[0.24em] text-white"
                >
                  <span aria-hidden className="h-3 w-0.5 rounded-full bg-primary shadow-[0_0_8px_rgba(255,42,42,0.9)]" />
                  {t("office.studioSettings")}
                </div>
                <div className="mt-1 text-[11px] leading-snug text-white/55">{t("office.studioSettingsLead")}</div>
              </div>
              <button
                type="button"
                onClick={() => setSettingsOpen(false)}
                aria-label={t("office.closeStudioSettings")}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-primary/35 bg-black/40 text-white/65 transition-colors hover:border-ring/60 hover:bg-primary/15 hover:text-white"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <SettingsPanel
                gatewayStatus={status}
                gatewayUrl={gatewayUrl}
                gatewayToken={token}
                selectedAdapterType={selectedAdapterType}
                activeAdapterType={activeAdapterType}
                onGatewayDisconnect={() => {
                  disconnect();
                  setSettingsOpen(false);
                }}
                onGatewayConnect={() => void connect()}
                onGatewayUrlChange={setGatewayUrl}
                onGatewayTokenChange={setToken}
                onGatewayAdapterTypeChange={setSelectedAdapterType}
                onOpenOnboarding={() => {
                  handleOpenOnboarding();
                  setSettingsOpen(false);
                }}
                officeTitle={officeTitle}
                officeTitleLoaded={officeTitleLoaded}
                onOfficeTitleChange={setOfficeTitle}
                remoteOfficeEnabled={remoteOfficeEnabled}
                remoteOfficeSourceKind={remoteOfficeSourceKind}
                remoteOfficeLabel={remoteOfficeLabel}
                remoteOfficePresenceUrl={remoteOfficePresenceUrl}
                remoteOfficeGatewayUrl={remoteOfficeGatewayUrl}
                remoteOfficeTokenConfigured={remoteOfficeTokenConfigured}
                onRemoteOfficeEnabledChange={setRemoteOfficeEnabled}
                onRemoteOfficeSourceKindChange={setRemoteOfficeSourceKind}
                onRemoteOfficeLabelChange={setRemoteOfficeLabel}
                onRemoteOfficePresenceUrlChange={setRemoteOfficePresenceUrl}
                onRemoteOfficeGatewayUrlChange={setRemoteOfficeGatewayUrl}
                onRemoteOfficeTokenChange={setRemoteOfficeToken}
                voiceRepliesEnabled={voiceRepliesEnabled}
                voiceRepliesVoiceId={voiceRepliesVoiceId}
                voiceRepliesSpeed={voiceRepliesSpeed}
                voiceRepliesLoaded={voiceRepliesLoaded}
                onVoiceRepliesToggle={setVoiceRepliesEnabled}
                onVoiceRepliesVoiceChange={setVoiceRepliesVoiceId}
                onVoiceRepliesSpeedChange={setVoiceRepliesSpeed}
                onVoiceRepliesPreview={(voiceId, voiceName) => {
                  void previewVoiceReply({
                    text: t("office.voicePreview", { name: voiceName }),
                    provider: voiceRepliesPreference.provider,
                    voiceId,
                    speed: voiceRepliesSpeed,
                  });
                }}
                voiceSetup={voiceSetup}
                voiceAgents={state.agents
                  .filter((agent) => !isRemoteOfficeAgentId(agent.agentId))
                  .map((agent) => ({
                    agentId: agent.agentId,
                    name: agent.name || agent.agentId,
                    voiceId: voiceForAgent(agent.agentId),
                    chosen: Boolean(voiceRepliesPreference.agentVoices[agent.agentId]),
                  }))}
                onAgentVoiceChange={setVoiceRepliesAgentVoiceId}
              />
            </div>
          </div>
        </div>
      ) : null}

      <MessagingModal
        open={messagingOpen}
        messaging={messaging}
        agents={callFeedAgents}
        draft={messagingDraft}
        onClose={() => {
          setMessagingOpen(false);
          setMessagingDraft(null);
        }}
      />

      <CallFeedModal
        open={callFeedOpen}
        feed={callFeed}
        agents={callFeedAgents}
        draft={callFeedDraft}
        onClose={() => {
          setCallFeedOpen(false);
          setCallFeedDraft(null);
        }}
      />

      <SkillsMarketplaceModal
        open={marketplaceOpen}
        marketplace={marketplace}
        onClose={() => setMarketplaceOpen(false)}
        onSelectAgent={(agentId) => {
          handleOpenAgentChat(agentId);
          setMarketplaceOpen(false);
        }}
        onOpenAgentSettings={(agentId) => {
          handleOpenAgentChat(agentId);
          setMarketplaceOpen(false);
          router.push("/office");
        }}
      />

      {showOnboardingWizard ? (
        <OnboardingWizard
          gatewayConnected={status === "connected"}
          agentCount={state.agents.length}
          gatewayUrl={gatewayUrl}
          token={token}
          onGatewayUrlChange={setGatewayUrl}
          onTokenChange={setToken}
          onConnect={() => {
            void connect();
          }}
          onComplete={handleCompleteOnboarding}
          connectionError={gatewayError}
          connecting={status === "connecting"}
        />
      ) : null}

      {showOpenClawConsole ? (
        // Top left, in the HUD's glass (hq/hud/hudStyle.ts). Collapsed it is
        // a small status card whose header toggles it; the actions and the log
        // appear expanded. At most 420px wide, so even expanded it stays clear
        // of the HUD counters at the top centre on a 1280px screen.
        <section
          aria-label={t("office.eventConsole")}
          className={`fixed left-3 top-3 z-30 flex max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-lg border border-red-900/50 bg-black/70 shadow-lg backdrop-blur-sm transition-opacity duration-700 ${openClawConsoleCollapsed ? "w-[280px]" : "w-[420px]"} ${hqIntroPlaying ? "pointer-events-none opacity-0 [&_*]:!pointer-events-none" : "pointer-events-auto opacity-100"}`}
        >
          <button
            type="button"
            onClick={() =>
              setOpenClawConsoleCollapsed((previous) => !previous)
            }
            aria-expanded={!openClawConsoleCollapsed}
            title={openClawConsoleCollapsed ? t("office.expand") : t("office.minimize")}
            className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-red-950/40"
          >
            <span
              aria-hidden="true"
              className="h-1.5 w-1.5 shrink-0 rounded-full bg-red-500 shadow-[0_0_8px_rgba(255,42,42,0.9)]"
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-mono text-[10px] font-semibold uppercase leading-[14px] tracking-[0.16em] text-white">
                {t("office.eventConsole")}
              </span>
              <span className="block truncate font-mono text-[10px] leading-[14px] tabular-nums text-white/65">
                {t("office.consoleCounts", {
                  agents: state.agents.length,
                  shown: filteredOpenClawLogEntries.length,
                  total: openClawLogEntries.length,
                })}
              </span>
            </span>
            <ChevronDown
              aria-hidden="true"
              className={`h-4 w-4 shrink-0 text-white/65 transition-transform ${openClawConsoleCollapsed ? "" : "rotate-180"}`}
            />
          </button>
          {!openClawConsoleCollapsed ? (
            <>
            <div className="flex flex-wrap items-center gap-1.5 border-t border-red-900/40 px-3 py-1.5">
              <button
                type="button"
                onClick={() => {
                  void handleCopyOpenClawConsoleJson();
                }}
                className="h-6 whitespace-nowrap rounded-md border border-red-900/40 bg-black/40 px-2 font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-white transition-colors hover:border-red-500/50 hover:bg-red-950/40"
              >
                {openClawConsoleCopyStatus === "copied"
                  ? t("common.copied")
                  : openClawConsoleCopyStatus === "error"
                    ? t("office.copyFailed")
                    : t("office.copyJson")}
              </button>
              <button
                type="button"
                onClick={handleDownloadOpenClawConsoleJson}
                className="h-6 whitespace-nowrap rounded-md border border-red-900/40 bg-black/40 px-2 font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-white transition-colors hover:border-red-500/50 hover:bg-red-950/40"
              >
                {t("office.downloadJson")}
              </button>
              <button
                type="button"
                onClick={handleClearOpenClawConsole}
                className="h-6 whitespace-nowrap rounded-md border border-red-900/40 bg-black/40 px-2 font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-white transition-colors hover:border-red-500/50 hover:bg-red-950/40"
              >
                {t("office.clear")}
              </button>
            </div>
            <div className="flex h-[280px] flex-col gap-2 overflow-y-auto border-t border-red-900/40 bg-[#070404]/90 px-3 py-2 font-mono text-[10px] leading-4">
              <div className="flex items-center gap-1.5">
                <input
                  type="text"
                  value={openClawConsoleSearch}
                  onChange={(event) =>
                    setOpenClawConsoleSearch(event.target.value)
                  }
                  placeholder={t("office.searchLogs")}
                  className="h-7 min-w-0 flex-1 rounded-md border border-red-900/50 bg-black/60 px-2 text-[11px] normal-case tracking-normal text-white placeholder:text-white/35 focus:border-red-500/70 focus:outline-none focus:ring-1 focus:ring-red-500/30"
                />
                {openClawConsoleSearch ? (
                  <button
                    type="button"
                    onClick={() => setOpenClawConsoleSearch("")}
                    className="h-7 whitespace-nowrap rounded-md border border-red-900/40 bg-black/40 px-2 text-[10px] font-semibold uppercase tracking-[0.1em] text-white transition-colors hover:border-red-500/50 hover:bg-red-950/40"
                  >
                    {t("office.reset")}
                  </button>
                ) : null}
              </div>
            {openClawLiveStateMatchesSearch ? (
              <div className="rounded border border-red-500/10 bg-red-950/10 p-2">
                <div className="mb-1 text-[9px] uppercase tracking-[0.16em] text-white">
                  {t("office.liveState")}
                </div>
                <pre className="whitespace-pre-wrap break-words text-white">
                  {renderOpenClawHighlightedText(
                    openClawLiveStateText,
                    openClawConsoleSearch,
                  )}
                </pre>
              </div>
            ) : (
              <div className="rounded border border-red-500/10 bg-red-950/10 p-2 text-white">
                {t("office.liveStateNoMatch")}
              </div>
            )}
            <div className="text-[9px] uppercase tracking-[0.16em] text-white">
              {t("office.rawEvents")}
            </div>
            {filteredOpenClawLogEntries.length === 0 ? (
              <div className="rounded border border-red-500/10 bg-red-950/10 p-2 text-white">
                {openClawLogEntries.length === 0
                  ? t("office.noEvents")
                  : t("office.noEventsMatch")}
              </div>
            ) : (
              filteredOpenClawLogEntries.map((entry) => {
                const isUserMessage = entry.role === "user";
                return (
                  <div
                    key={entry.id}
                    className={`rounded border p-2 ${
                      isUserMessage
                        ? "border-red-400/30 bg-red-950/12"
                        : "border-red-500/12 bg-red-950/8"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div
                        className={`text-[9px] uppercase tracking-[0.16em] ${
                          isUserMessage
                            ? "text-white"
                            : "text-white"
                        }`}
                      >
                        {renderOpenClawHighlightedText(
                          `[${entry.timestamp}] ${entry.eventName} / ${entry.eventKind}`,
                          openClawConsoleSearch,
                        )}
                      </div>
                      {entry.role ? (
                        <span
                          className={`rounded px-1.5 py-0.5 text-[9px] uppercase ${
                            isUserMessage
                              ? "bg-red-400/15 text-white"
                              : "bg-red-400/10 text-white"
                          }`}
                        >
                          {messageRoleLabel(entry.role)}
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-1 whitespace-pre-wrap break-words text-white">
                      {renderOpenClawHighlightedText(
                        entry.summary,
                        openClawConsoleSearch,
                      )}
                    </div>
                    {entry.messageText ? (
                      <div className="mt-2 rounded border border-red-400/20 bg-red-950/25 px-2 py-1 text-white">
                        <div className="text-[9px] uppercase tracking-[0.16em] text-white">
                          {t("office.userText")}
                        </div>
                        <div className="mt-1 whitespace-pre-wrap break-words">
                          {renderOpenClawHighlightedText(
                            entry.messageText,
                            openClawConsoleSearch,
                          )}
                        </div>
                      </div>
                    ) : null}
                    {entry.thinkingText ? (
                      <div className="mt-2 rounded border border-red-400/15 bg-red-950/15 px-2 py-1 text-white">
                        <div className="text-[9px] uppercase tracking-[0.16em] text-white">
                          {t("office.thinking")}
                        </div>
                        <div className="mt-1 whitespace-pre-wrap break-words">
                          {renderOpenClawHighlightedText(
                            entry.thinkingText,
                            openClawConsoleSearch,
                          )}
                        </div>
                      </div>
                    ) : null}
                    {entry.streamText ? (
                      <div className="mt-2 rounded border border-red-400/15 bg-red-950/18 px-2 py-1 text-white">
                        <div className="text-[9px] uppercase tracking-[0.16em] text-white">
                          {t("office.stream")}
                        </div>
                        <div className="mt-1 whitespace-pre-wrap break-words">
                          {renderOpenClawHighlightedText(
                            entry.streamText,
                            openClawConsoleSearch,
                          )}
                        </div>
                      </div>
                    ) : null}
                    {entry.toolText ? (
                      <div className="mt-2 rounded border border-red-400/15 bg-red-950/15 px-2 py-1 text-white">
                        <div className="text-[9px] uppercase tracking-[0.16em] text-white">
                          {t("office.toolOutput")}
                        </div>
                        <div className="mt-1 whitespace-pre-wrap break-words">
                          {renderOpenClawHighlightedText(
                            entry.toolText,
                            openClawConsoleSearch,
                          )}
                        </div>
                      </div>
                    ) : null}
                    <details className="mt-2">
                      <summary className="cursor-pointer text-[9px] uppercase tracking-[0.16em] text-white">
                        {t("office.rawPayload")}
                      </summary>
                      <pre className="mt-1 whitespace-pre-wrap break-words text-white">
                        {renderOpenClawHighlightedText(
                          entry.payloadText,
                          openClawConsoleSearch,
                        )}
                      </pre>
                    </details>
                  </div>
                );
              })
            )}
            </div>
            </>
          ) : null}
        </section>
      ) : null}

      {/* The chat window floats above the bottom row (the camera bar and the
          chat button, 62px): left of the open HQ panel (312px at right-3) when
          both fit, over the wide board or on a narrow screen otherwise. */}
      <div
        className={`fixed bottom-[70px] z-30 flex flex-col items-end transition-opacity duration-700 ${
          // 1124px = the 780px window + the panel column (332px) + a 12px margin.
          sidebarOpen && activeSidebarTab !== "kanban" ? "right-3 min-[1124px]:right-[332px]" : "right-3"
        } ${debugEnabled ? "hidden" : ""} ${hqIntroPlaying ? "opacity-0 [&_*]:!pointer-events-none" : "opacity-100"}`}
      >
        {chatOpen && (
          <div
            className="flex overflow-hidden rounded-lg border border-red-900/50 bg-[#070404] shadow-[0_24px_70px_rgba(0,0,0,0.7),0_0_22px_rgba(255,26,26,0.1)]"
            style={{
              width: chatRosterCollapsed
                ? "min(680px, calc(100vw - 1.5rem))"
                : "min(780px, calc(100vw - 1.5rem))",
              height: "min(560px, calc(100vh - 5.5rem))",
            }}
          >
            <div
              className={`flex shrink-0 flex-col border-r border-red-900/40 bg-[#050404] transition-[width] ${
                chatRosterCollapsed ? "w-12" : "w-52"
              }`}
            >
              <div className="flex h-10 items-center justify-between border-b border-red-900/40 px-3">
                {!chatRosterCollapsed ? (
                  <>
                    <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-white/65">
                      {t("office.agents")}
                    </span>
                    <span className="rounded border border-red-900/40 bg-black/40 px-1.5 font-mono text-[10px] tabular-nums text-white">
                      {chatRosterEntries.length}
                    </span>
                  </>
                ) : (
                  <span className="mx-auto font-mono text-[10px] tabular-nums text-white">
                    {chatRosterEntries.length}
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={() => setChatRosterCollapsed((current) => !current)}
                className="mx-2 mt-2 inline-flex items-center justify-center rounded-md border border-red-900/40 bg-black/40 px-2 py-1.5 text-white/65 transition-colors hover:border-red-500/50 hover:bg-red-950/40 hover:text-white"
                aria-label={chatRosterCollapsed ? t("office.expandList") : t("office.collapseList")}
                title={chatRosterCollapsed ? t("office.expandList") : t("office.collapseList")}
              >
                {chatRosterCollapsed ? (
                  <ChevronRight className="h-4 w-4" />
                ) : (
                  <ChevronLeft className="h-4 w-4" />
                )}
              </button>
              <div className="mt-2 flex-1 overflow-y-auto">
                {chatRosterCollapsed ? (
                  <div className="flex flex-col items-center gap-2 px-1 py-2">
                    {chatRosterEntries.map((agent) => {
                      const isSelected = agent.id === selectedChatAgentId;
                      return (
                        <button
                          key={agent.id}
                          type="button"
                          onClick={() => handleOpenAgentChat(agent.id)}
                          className={`inline-flex h-8 w-8 items-center justify-center rounded-md border font-mono text-[11px] font-semibold transition-colors ${
                            isSelected
                              ? "border-red-500/60 bg-red-600/20 text-white shadow-[0_0_14px_rgba(255,26,26,0.25)]"
                              : "border-red-900/40 bg-black/40 text-white/65 hover:border-red-500/50 hover:bg-red-950/40 hover:text-white"
                          }`}
                          title={agent.name}
                        >
                          {agent.name.slice(0, 1).toUpperCase()}
                        </button>
                      );
                    })}
                  </div>
                ) : chatRosterEntries.length === 0 ? (
                  <div className="px-3 py-4 font-mono text-[11px] text-white/45">
                    {t("office.noAgentsShort")}
                  </div>
                ) : (
                  chatRosterEntries.map((agent) => {
                    const isSelected = agent.id === selectedChatAgentId;
                    const isRunning = agent.isRunning;
                    return (
                      <button
                        key={agent.id}
                        type="button"
                        onClick={() => handleOpenAgentChat(agent.id)}
                        className={`flex w-full items-center gap-2 border-l-2 px-3 py-2.5 text-left transition-colors ${
                          isSelected
                            ? "border-red-500 bg-red-600/20 text-white"
                            : "border-transparent text-white/65 hover:bg-red-950/40 hover:text-white"
                        }`}
                      >
                        <span
                          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                            isRunning ? "bg-red-500 shadow-[0_0_8px_rgba(255,42,42,0.8)]" : "bg-white/25"
                          }`}
                        />
                        <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
                          {agent.name}
                        </span>
                        {agent.kind === "remote" ? (
                          <span className="shrink-0 font-mono text-[9px] uppercase tracking-[0.14em] text-red-300/70">
                            {t("office.remote")}
                          </span>
                        ) : null}
                        <span className="sr-only">
                          {agent.kind === "remote" ? t("office.remoteAgent") : t("office.localAgent")}
                        </span>
                      </button>
                    );
                  })
                )}
              </div>
            </div>

            <div className="flex min-w-0 flex-1 flex-col">
              {focusedChatAgent ? (
                <AgentChatPanel
                  agent={focusedChatAgent}
                  isSelected={false}
                  canSend={status === "connected"}
                  models={gatewayModels}
                  stopBusy={
                    chatController.stopBusyAgentId === focusedChatAgent.agentId
                  }
                  onLoadMoreHistory={() => {}}
                  onOpenSettings={() =>
                    openAgentEditor(focusedChatAgent.agentId, "IDENTITY.md")
                  }
                  onNewSession={() =>
                    chatController.handleNewSession(focusedChatAgent.agentId)
                  }
                  onModelChange={(value) =>
                    dispatch({
                      type: "updateAgent",
                      agentId: focusedChatAgent.agentId,
                      patch: { model: value ?? undefined },
                    })
                  }
                  onThinkingChange={(value) =>
                    dispatch({
                      type: "updateAgent",
                      agentId: focusedChatAgent.agentId,
                      patch: { thinkingLevel: value ?? undefined },
                    })
                  }
                  onDraftChange={(value) =>
                    chatController.handleDraftChange(
                      focusedChatAgent.agentId,
                      value,
                    )
                  }
                  onSend={(message) => {
                    void handleChatSend(
                      focusedChatAgent.agentId,
                      focusedChatAgent.sessionKey,
                      message,
                    );
                  }}
                  onRemoveQueuedMessage={(index) =>
                    chatController.removeQueuedMessage(
                      focusedChatAgent.agentId,
                      index,
                    )
                  }
                  onStopRun={() => {
                    void chatController.handleStopRun(
                      focusedChatAgent.agentId,
                      focusedChatAgent.sessionKey,
                    );
                  }}
                  onAvatarShuffle={() =>
                    openAgentEditor(focusedChatAgent.agentId, "avatar")
                  }
                  onVoiceSend={handleVoiceSend}
                />
              ) : focusedRemoteChatTarget && focusedRemoteChatState ? (
                <RemoteAgentChatPanel
                  agentName={focusedRemoteChatTarget.name}
                  canSend={remoteMessagingAvailable}
                  sending={focusedRemoteChatState.sending}
                  handoffing={focusedRemoteChatState.handoffing}
                  draft={focusedRemoteChatState.draft}
                  mode={focusedRemoteChatState.mode}
                  handoffContext={focusedRemoteChatState.handoffContext}
                  handoffDeliverables={focusedRemoteChatState.handoffDeliverables}
                  handoffAcceptance={focusedRemoteChatState.handoffAcceptance}
                  error={focusedRemoteChatState.error}
                  messages={focusedRemoteChatState.messages}
                  disabledReason={remoteMessagingDisabledReason}
                  onDraftChange={(value) => {
                    updateRemoteChatSession(focusedRemoteChatTarget.id, (session) => ({
                      ...session,
                      draft: value,
                      error: null,
                    }));
                  }}
                  onModeChange={(value) => {
                    updateRemoteChatSession(focusedRemoteChatTarget.id, (session) => ({
                      ...session,
                      mode: value,
                      error: null,
                    }));
                  }}
                  onHandoffContextChange={(value) => {
                    updateRemoteChatSession(focusedRemoteChatTarget.id, (session) => ({
                      ...session,
                      handoffContext: value,
                    }));
                  }}
                  onHandoffDeliverablesChange={(value) => {
                    updateRemoteChatSession(focusedRemoteChatTarget.id, (session) => ({
                      ...session,
                      handoffDeliverables: value,
                    }));
                  }}
                  onHandoffAcceptanceChange={(value) => {
                    updateRemoteChatSession(focusedRemoteChatTarget.id, (session) => ({
                      ...session,
                      handoffAcceptance: value,
                    }));
                  }}
                  onSend={(message) => {
                    void handleRemoteAgentChatSend(focusedRemoteChatTarget.id, message);
                  }}
                  onHandoff={(message) => {
                    void handleRemoteAgentHandoff(focusedRemoteChatTarget.id, message);
                  }}
                />
              ) : (
                <div className="flex flex-1 items-center justify-center font-mono text-[12px] text-white/45">
                  {t("office.selectToChat")}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* The chat button, bottom right: the camera bar's glass, padding and
          button height (hq/hud/hudStyle.ts), so the bottom row reads as one. */}
      <div
        className={`fixed bottom-3 right-3 z-30 rounded-lg border border-red-900/50 bg-black/70 p-1.5 shadow-lg backdrop-blur-sm transition-opacity duration-700 ${
          debugEnabled ? "hidden" : ""
        } ${hqIntroPlaying ? "opacity-0 [&_*]:!pointer-events-none" : "opacity-100"}`}
      >
        <button
          type="button"
          onClick={() => setChatOpen((prev) => !prev)}
          aria-expanded={chatOpen}
          className={`flex h-9 items-center gap-2 rounded-md border px-3 font-mono text-[12px] font-semibold tracking-[0.1em] text-white transition-colors ${
            chatOpen
              ? "border-red-500/60 bg-red-600/20 shadow-[0_0_14px_rgba(255,26,26,0.25)]"
              : "border-red-900/40 bg-black/40 hover:border-red-500/50 hover:bg-red-950/40"
          }`}
        >
          {chatOpen ? (
            <>
              <ChevronDown className="h-4 w-4" />
              <span>{t("office.hideChat")}</span>
            </>
          ) : (
            <>
              <MessageSquare className="h-4 w-4" />
              <span>{t("office.chat")}</span>
              {runningCount > 0 ? (
                <span className="rounded-sm bg-[#e3141c] px-1.5 text-[10px] leading-4 tabular-nums text-white">
                  {runningCount}
                </span>
              ) : null}
            </>
          )}
        </button>
      </div>

      {/* Above the bottom row (camera bar and chat card, 62px) so it never covers them. */}
      {mainVoiceState !== "idle" || mainVoiceError ? (
        <div className="pointer-events-none fixed inset-x-0 bottom-[76px] z-40 flex justify-center">
          <div
            className={`flex min-w-[220px] items-center gap-3 rounded-full border px-4 py-3 font-mono text-[12px] shadow-2xl backdrop-blur ${
              mainVoiceError
                ? "border-red-500/45 bg-red-950/75 text-red-100"
                : "border-red-900/50 bg-black/70 text-white"
            }`}
          >
            <div
              className={`flex h-10 w-10 items-center justify-center rounded-full ${
                mainVoiceState === "recording"
                  ? "bg-red-500/25 text-red-200"
                  : mainVoiceState === "transcribing"
                    ? "bg-red-600/20 text-red-100"
                    : "bg-white/10 text-white"
              }`}
            >
              <Mic className="h-5 w-5" />
            </div>
            <div className="flex flex-col">
              <span className="text-[10px] uppercase tracking-[0.18em] text-white/55">
                {voiceTarget === "all" ? t("office.addressAll") : t("office.mainAgent")}
              </span>
              <span className="text-[12px] font-medium text-white">
                {mainVoiceError
                  ? mainVoiceError
                  : mainVoiceState === "recording"
                    ? t("office.pttListening")
                    : mainVoiceState === "transcribing"
                      ? t("office.pttTranscribing")
                      : mainVoiceState === "requesting"
                        ? t("office.pttRequesting")
                        : !mainVoiceSupported
                          ? t("office.pttUnsupported")
                          : t("office.pttReady")}
              </span>
            </div>
          </div>
        </div>
      ) : null}

      {debugEnabled ? (
        <section className="fixed bottom-3 right-3 z-50 max-h-[45vh] w-[560px] overflow-auto rounded border border-red-900/50 bg-black/90 p-3 font-mono text-[11px] text-white/85">
          <div className="mb-2 font-semibold text-red-300">{t("office.debugTitle")}</div>
          <div className="mb-2 text-white/55">
            {t("office.debugCounts", { status, agents: state.agents.length })}
          </div>
          {debugRows.length === 0 ? (
            <div className="text-white/45">{t("office.noDebug")}</div>
          ) : (
            <div className="space-y-2">
              {debugRows.map((row) => (
                <div
                  key={row.agentId}
                  className="rounded border border-red-900/40 p-2"
                >
                  <div className="text-red-200">
                    {row.name} ({row.agentId})
                  </div>
                  <div>
                    storeStatus={row.storeStatus} runId={row.runId ?? "null"}{" "}
                    inferredRunning=
                    {String(row.inferredRunning)}
                  </div>
                  <div>
                    lastRole={row.lastRole} messages={row.messageCount}
                  </div>
                  <div className="truncate text-white/55">
                    detectedSession={row.detectedSessionKey || "-"}
                  </div>
                  <div className="truncate text-white/55">
                    lastText={row.lastText || "-"}
                  </div>
                  <div className="truncate text-white/45">
                    sessions={row.inspectedSessions || "-"}
                  </div>
                  <div className="text-white/45">
                    source={row.inferenceSource}
                  </div>
                  <div className="text-white/45">at={row.at}</div>
                </div>
              ))}
            </div>
          )}
        </section>
      ) : null}
      {agentEditorAgent ? (
        <AgentEditorModal
          key={`${agentEditorAgent.agentId}:${agentEditorInitialSection}`}
          open
          client={client}
          agents={state.agents}
          agent={agentEditorAgent}
          initialSection={agentEditorInitialSection}
          onClose={() => {
            setAgentEditorAgentId(null);
          }}
          onAvatarSave={handleAvatarProfileSave}
          onRename={async (agentId, name) => {
            if (!client) return false;
            try {
              await renameGatewayAgent({ client, agentId, name });
              dispatch({ type: "updateAgent", agentId, patch: { name } });
              return true;
            } catch {
              return false;
            }
          }}
          onDelete={async (agentId) => {
            await handleDeleteAgent(agentId);
          }}
          onNavigateAgent={(agentId, section) => {
            openAgentEditor(agentId, section);
          }}
        />
      ) : null}
      <AgentCreateWizardModal
        key={`create-agent-${createAgentWizardNonce}`}
        open={createAgentWizardOpen}
        suggestedName={t("office.defaultAgentName", { number: state.agents.length + 1 })}
        busy={createAgentBusy}
        submitError={createAgentModalError}
        statusLine={createAgentStatusLine}
        onClose={handleCloseCreateAgentWizard}
        onCreateAgent={handleCreateAgentFromIdentity}
        onFinishWizard={handleFinishCreateAgentAvatar}
      />
    </main>
    </HermesControlProvider>
  );
}
