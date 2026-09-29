"use client";

import type { AgentState } from "@/features/agents/state/store";
import type { TranscriptEntry } from "@/features/agents/state/transcript";
import {
  classifyGatewayEventKind,
  isReasoningRuntimeAgentStream,
  type AgentEventPayload,
  type ChatEventPayload,
} from "@/features/agents/state/runtimeEventBridge";
import {
  parseExecApprovalRequested,
  parseExecApprovalResolved,
  resolveExecApprovalAgentId,
} from "@/features/agents/approvals/execApprovalEvents";
import type { EventFrame } from "@/lib/gateway/GatewayClient";
import {
  isSameSessionKey,
  parseAgentIdFromSessionKey,
} from "@/lib/gateway/GatewayClient";
import type {
  OfficeCleaningCue,
  SessionEpochSnapshot,
} from "@/lib/office/janitorReset";
import {
  buildSessionEpochSnapshot,
  resolveResetAgentIds,
} from "@/lib/office/janitorReset";
import {
  resolveOfficeIntentSnapshot,
  resolveOfficeDeskDirective,
  resolveOfficeGithubDirective,
  resolveOfficeGymDirective,
  resolveOfficeQaDirective,
} from "@/lib/office/deskDirectives";
import { extractText, extractThinking } from "@/lib/text/message-extract";
import { randomUUID } from "@/lib/uuid";
import { t } from "@/lib/i18n";

// Office animation is derived in two passes:
// 1. Event reduction records short-lived latches from fresh gateway traffic.
// 2. Reconciliation rebuilds durable holds from current agent and transcript state.
// The 3D scene only consumes the distilled result from `buildOfficeAnimationState()`.
const WORKING_LATCH_MS = 5_000;
const GYM_WORKOUT_LATCH_MS = 60_000;
const STREAM_ACTIVITY_LATCH_MS = 6_000;
const THINKING_ACTIVITY_LATCH_MS = 6_000;
const STANDUP_TRIGGER_MAX_AGE_MS = 30_000;
const CLEANING_CUE_LIMIT = 24;

type BooleanByAgentId = Record<string, boolean>;
type NumberByAgentId = Record<string, number>;
type StringByAgentId = Record<string, string>;

type LatestDirective<TDirective> = {
  directive: TDirective;
  key: string;
  text: string;
};

export type OfficeStandupTriggerRequest = {
  key: string;
  message: string;
  requestedAt: number;
};

export type OfficeAnimationTriggerState = {
  cleaningCues: OfficeCleaningCue[];
  deskDirectiveKeyByAgentId: StringByAgentId;
  deskHoldByAgentId: BooleanByAgentId;
  githubDirectiveKeyByAgentId: StringByAgentId;
  githubHoldByAgentId: BooleanByAgentId;
  gymCooldownUntilByAgentId: NumberByAgentId;
  lastManualGymCommandKeyByAgentId: StringByAgentId;
  manualGymUntilByAgentId: NumberByAgentId;
  pendingStandupRequest: OfficeStandupTriggerRequest | null;
  qaDirectiveKeyByAgentId: StringByAgentId;
  qaHoldByAgentId: BooleanByAgentId;
  sessionEpochSnapshot: SessionEpochSnapshot;
  skillGymDirectiveKeyByAgentId: StringByAgentId;
  skillGymHoldByAgentId: BooleanByAgentId;
  streamingUntilByAgentId: NumberByAgentId;
  suppressedGithubDirectiveKeyByAgentId: StringByAgentId;
  suppressedQaDirectiveKeyByAgentId: StringByAgentId;
  thinkingUntilByAgentId: NumberByAgentId;
  workingUntilByAgentId: NumberByAgentId;
};

export type OfficeAnimationState = {
  awaitingApprovalByAgentId: BooleanByAgentId;
  cleaningCues: OfficeCleaningCue[];
  danceUntilByAgentId: NumberByAgentId;
  deskHoldByAgentId: BooleanByAgentId;
  githubHoldByAgentId: BooleanByAgentId;
  gymHoldByAgentId: BooleanByAgentId;
  jukeboxHoldByAgentId: BooleanByAgentId;
  manualGymUntilByAgentId: NumberByAgentId;
  pendingStandupRequest: OfficeStandupTriggerRequest | null;
  qaHoldByAgentId: BooleanByAgentId;
  skillGymHoldByAgentId: BooleanByAgentId;
  streamingByAgentId: BooleanByAgentId;
  thinkingByAgentId: BooleanByAgentId;
  workingUntilByAgentId: NumberByAgentId;
};

const emptyObject = <T extends Record<string, unknown>>(): T => ({}) as T;

const normalizeCommandText = (value: string | null | undefined): string => {
  if (!value) return "";
  return value.trim().toLowerCase().replace(/\s+/g, " ");
};

const pruneBooleanMap = (
  source: BooleanByAgentId,
  activeAgentIds: Set<string>,
): BooleanByAgentId =>
  Object.fromEntries(
    Object.entries(source).filter(
      ([agentId, active]) => Boolean(active) && activeAgentIds.has(agentId),
    ),
  );

const pruneStringMap = (
  source: StringByAgentId,
  activeAgentIds: Set<string>,
): StringByAgentId =>
  Object.fromEntries(
    Object.entries(source).filter(
      ([agentId, value]) =>
        activeAgentIds.has(agentId) && value.trim().length > 0,
    ),
  );

const pruneFutureMap = (
  source: NumberByAgentId,
  activeAgentIds: Set<string>,
  nowMs: number,
): NumberByAgentId =>
  Object.fromEntries(
    Object.entries(source).filter(
      ([agentId, until]) =>
        activeAgentIds.has(agentId) &&
        typeof until === "number" &&
        Number.isFinite(until) &&
        until > nowMs,
    ),
  );

const resolveMessageRole = (message: unknown): string | null => {
  if (!message || typeof message !== "object") return null;
  const role = (message as Record<string, unknown>).role;
  return typeof role === "string" ? role : null;
};

const resolveChatPayloadRole = (
  payload: ChatEventPayload | undefined,
): string | null => {
  if (!payload) return null;
  const messageRole = resolveMessageRole(payload.message);
  if (messageRole) return messageRole;
  const payloadRole =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>).role
      : null;
  return typeof payloadRole === "string" ? payloadRole : null;
};

const isUserLikeChatRole = (
  role: string | null,
  state: ChatEventPayload["state"],
): boolean => {
  if (role === "user" || role === "human" || role === "input") return true;
  if (role === "system") return state === "final";
  return role === null && state === "final";
};

const resolveLatestDirective = <TDirective>(params: {
  lastUserMessage: string | null | undefined;
  transcriptEntries: TranscriptEntry[] | undefined;
  resolver: (value: string | null | undefined) => TDirective | null;
}): LatestDirective<TDirective> | null => {
  const latestMessageDirective = params.resolver(params.lastUserMessage);
  if (latestMessageDirective) {
    const text = params.lastUserMessage?.trim() ?? "";
    return {
      directive: latestMessageDirective,
      key: `latest:${normalizeCommandText(text)}`,
      text,
    };
  }
  if (
    !Array.isArray(params.transcriptEntries) ||
    params.transcriptEntries.length === 0
  ) {
    return null;
  }
  for (
    let index = params.transcriptEntries.length - 1;
    index >= 0;
    index -= 1
  ) {
    const entry = params.transcriptEntries[index];
    if (!entry || entry.role !== "user") continue;
    const directive = params.resolver(entry.text);
    if (!directive) continue;
    return {
      directive,
      key: `${entry.entryId || index}:${normalizeCommandText(entry.text)}`,
      text: entry.text.trim(),
    };
  }
  return null;
};

const resolveAgentIdForSessionKey = (
  agents: AgentState[],
  sessionKey: string | null | undefined,
): string | null => {
  const trimmed = sessionKey?.trim() ?? "";
  if (!trimmed) return null;
  const matched = agents.find((agent) =>
    isSameSessionKey(agent.sessionKey, trimmed),
  );
  if (matched) return matched.agentId;
  return parseAgentIdFromSessionKey(trimmed);
};

const applyHoldDirective = (
  currentHeld: boolean,
  directive: LatestDirective<"desk" | "github" | "qa_lab" | "release"> | null,
): boolean => {
  if (!directive) return currentHeld;
  if (directive.directive === "release") return false;
  return true;
};

const pruneOfficeAnimationTriggerState = (
  state: OfficeAnimationTriggerState,
  agents: AgentState[],
  nowMs: number,
): OfficeAnimationTriggerState => {
  const activeAgentIds = new Set(agents.map((agent) => agent.agentId));
  return {
    ...state,
    deskDirectiveKeyByAgentId: pruneStringMap(
      state.deskDirectiveKeyByAgentId,
      activeAgentIds,
    ),
    deskHoldByAgentId: pruneBooleanMap(state.deskHoldByAgentId, activeAgentIds),
    githubDirectiveKeyByAgentId: pruneStringMap(
      state.githubDirectiveKeyByAgentId,
      activeAgentIds,
    ),
    githubHoldByAgentId: pruneBooleanMap(
      state.githubHoldByAgentId,
      activeAgentIds,
    ),
    gymCooldownUntilByAgentId: pruneFutureMap(
      state.gymCooldownUntilByAgentId,
      activeAgentIds,
      nowMs,
    ),
    lastManualGymCommandKeyByAgentId: pruneStringMap(
      state.lastManualGymCommandKeyByAgentId,
      activeAgentIds,
    ),
    manualGymUntilByAgentId: pruneFutureMap(
      state.manualGymUntilByAgentId,
      activeAgentIds,
      nowMs,
    ),
    qaDirectiveKeyByAgentId: pruneStringMap(
      state.qaDirectiveKeyByAgentId,
      activeAgentIds,
    ),
    qaHoldByAgentId: pruneBooleanMap(state.qaHoldByAgentId, activeAgentIds),
    skillGymDirectiveKeyByAgentId: pruneStringMap(
      state.skillGymDirectiveKeyByAgentId,
      activeAgentIds,
    ),
    skillGymHoldByAgentId: pruneBooleanMap(
      state.skillGymHoldByAgentId,
      activeAgentIds,
    ),
    streamingUntilByAgentId: pruneFutureMap(
      state.streamingUntilByAgentId,
      activeAgentIds,
      nowMs,
    ),
    suppressedGithubDirectiveKeyByAgentId: pruneStringMap(
      state.suppressedGithubDirectiveKeyByAgentId,
      activeAgentIds,
    ),
    suppressedQaDirectiveKeyByAgentId: pruneStringMap(
      state.suppressedQaDirectiveKeyByAgentId,
      activeAgentIds,
    ),
    thinkingUntilByAgentId: pruneFutureMap(
      state.thinkingUntilByAgentId,
      activeAgentIds,
      nowMs,
    ),
    workingUntilByAgentId: pruneFutureMap(
      state.workingUntilByAgentId,
      activeAgentIds,
      nowMs,
    ),
  };
};

const recordWorkingActivity = (
  current: NumberByAgentId,
  agentId: string,
  nowMs: number,
): NumberByAgentId => ({
  ...current,
  [agentId]: Math.max(current[agentId] ?? 0, nowMs + WORKING_LATCH_MS),
});

const recordStreamingActivity = (
  current: NumberByAgentId,
  agentId: string,
  nowMs: number,
): NumberByAgentId => ({
  ...current,
  [agentId]: Math.max(current[agentId] ?? 0, nowMs + STREAM_ACTIVITY_LATCH_MS),
});

const recordThinkingActivity = (
  current: NumberByAgentId,
  agentId: string,
  nowMs: number,
): NumberByAgentId => ({
  ...current,
  [agentId]: Math.max(
    current[agentId] ?? 0,
    nowMs + THINKING_ACTIVITY_LATCH_MS,
  ),
});

const applyUserMessageTriggers = (params: {
  state: OfficeAnimationTriggerState;
  agentId: string;
  message: string;
  nowMs: number;
}): OfficeAnimationTriggerState => {
  let next = params.state;
  // All room holds come from the unified office intent snapshot so every transport channel
  // shares the same command grammar and new rooms only need one parser entry point.
  const intentSnapshot = resolveOfficeIntentSnapshot(params.message);
  const deskDirective = intentSnapshot.desk;
  if (deskDirective) {
    next = {
      ...next,
      deskHoldByAgentId:
        deskDirective === "release"
          ? Object.fromEntries(
              Object.entries(next.deskHoldByAgentId).filter(
                ([agentId]) => agentId !== params.agentId,
              ),
            )
          : { ...next.deskHoldByAgentId, [params.agentId]: true },
    };
  }
  const githubDirective = intentSnapshot.github;
  if (githubDirective) {
    const directiveKey = normalizeCommandText(params.message);
    const isSuppressed =
      next.suppressedGithubDirectiveKeyByAgentId[params.agentId] ===
      directiveKey;
    next = {
      ...next,
      githubDirectiveKeyByAgentId: {
        ...next.githubDirectiveKeyByAgentId,
        [params.agentId]: directiveKey,
      },
      githubHoldByAgentId:
        githubDirective === "release" || isSuppressed
          ? Object.fromEntries(
              Object.entries(next.githubHoldByAgentId).filter(
                ([agentId]) => agentId !== params.agentId,
              ),
            )
          : { ...next.githubHoldByAgentId, [params.agentId]: true },
    };
  }
  const qaDirective = intentSnapshot.qa;
  if (qaDirective) {
    const directiveKey = normalizeCommandText(params.message);
    const isSuppressed =
      next.suppressedQaDirectiveKeyByAgentId[params.agentId] === directiveKey;
    next = {
      ...next,
      qaDirectiveKeyByAgentId: {
        ...next.qaDirectiveKeyByAgentId,
        [params.agentId]: directiveKey,
      },
      qaHoldByAgentId:
        qaDirective === "release" || isSuppressed
          ? Object.fromEntries(
              Object.entries(next.qaHoldByAgentId).filter(
                ([agentId]) => agentId !== params.agentId,
              ),
            )
          : { ...next.qaHoldByAgentId, [params.agentId]: true },
    };
  }
  if (intentSnapshot.gym?.source === "manual") {
    const gymCommandKey = normalizeCommandText(params.message);
    next = {
      ...next,
      lastManualGymCommandKeyByAgentId: {
        ...next.lastManualGymCommandKeyByAgentId,
        [params.agentId]: gymCommandKey,
      },
      manualGymUntilByAgentId: {
        ...next.manualGymUntilByAgentId,
        [params.agentId]: params.nowMs + GYM_WORKOUT_LATCH_MS,
      },
    };
  }
  if (params.agentId === "main" && intentSnapshot.standup === "standup") {
    const requestKey = `${normalizeCommandText(params.message)}:${params.nowMs}`;
    next = {
      ...next,
      pendingStandupRequest: {
        key: requestKey,
        message: params.message.trim(),
        requestedAt: params.nowMs,
      },
    };
  }
  return next;
};

export const createOfficeAnimationTriggerState =
  (): OfficeAnimationTriggerState => ({
    cleaningCues: [],
    deskDirectiveKeyByAgentId: emptyObject(),
    deskHoldByAgentId: emptyObject(),
    githubDirectiveKeyByAgentId: emptyObject(),
    githubHoldByAgentId: emptyObject(),
    gymCooldownUntilByAgentId: emptyObject(),
    lastManualGymCommandKeyByAgentId: emptyObject(),
    manualGymUntilByAgentId: emptyObject(),
    pendingStandupRequest: null,
    qaDirectiveKeyByAgentId: emptyObject(),
    qaHoldByAgentId: emptyObject(),
    sessionEpochSnapshot: {},
    skillGymDirectiveKeyByAgentId: emptyObject(),
    skillGymHoldByAgentId: emptyObject(),
    streamingUntilByAgentId: emptyObject(),
    suppressedGithubDirectiveKeyByAgentId: emptyObject(),
    suppressedQaDirectiveKeyByAgentId: emptyObject(),
    thinkingUntilByAgentId: emptyObject(),
    workingUntilByAgentId: emptyObject(),
  });

export const reduceOfficeAnimationTriggerEvent = (params: {
  agents: AgentState[];
  event: EventFrame;
  nowMs?: number;
  state: OfficeAnimationTriggerState;
}): OfficeAnimationTriggerState => {
  const nowMs = params.nowMs ?? Date.now();
  let next = pruneOfficeAnimationTriggerState(
    params.state,
    params.agents,
    nowMs,
  );
  const kind = classifyGatewayEventKind(params.event.event);

  if (kind === "runtime-chat") {
    const payload = params.event.payload as ChatEventPayload | undefined;
    const agentId = resolveAgentIdForSessionKey(
      params.agents,
      payload?.sessionKey,
    );
    if (!payload || !agentId) return next;
    const messageText = extractText(payload.message)?.trim() ?? "";
    const thinkingText =
      extractThinking(payload.message ?? payload)?.trim() ?? "";
    const role = resolveChatPayloadRole(payload);
    if (payload.runId) {
      next = {
        ...next,
        workingUntilByAgentId: recordWorkingActivity(
          next.workingUntilByAgentId,
          agentId,
          nowMs,
        ),
      };
    }
    if (isUserLikeChatRole(role, payload.state) && messageText) {
      next = applyUserMessageTriggers({
        state: next,
        agentId,
        message: messageText,
        nowMs,
      });
    }
    if (role === "assistant" && messageText) {
      next = {
        ...next,
        streamingUntilByAgentId: recordStreamingActivity(
          next.streamingUntilByAgentId,
          agentId,
          nowMs,
        ),
      };
    }
    if (thinkingText) {
      next = {
        ...next,
        thinkingUntilByAgentId: recordThinkingActivity(
          next.thinkingUntilByAgentId,
          agentId,
          nowMs,
        ),
      };
    }
  } else if (kind === "runtime-agent") {
    const payload = params.event.payload as AgentEventPayload | undefined;
    const agentId = resolveAgentIdForSessionKey(
      params.agents,
      payload?.sessionKey,
    );
    if (!payload || !agentId) return next;
    if (payload.runId) {
      next = {
        ...next,
        workingUntilByAgentId: recordWorkingActivity(
          next.workingUntilByAgentId,
          agentId,
          nowMs,
        ),
      };
    }
    const thinkingText = extractThinking(payload.data ?? payload)?.trim() ?? "";
    const streamText =
      payload.data && typeof payload.data === "object"
        ? typeof (payload.data as Record<string, unknown>).text === "string"
          ? String((payload.data as Record<string, unknown>).text).trim()
          : typeof (payload.data as Record<string, unknown>).delta === "string"
            ? String((payload.data as Record<string, unknown>).delta).trim()
            : ""
        : "";
    if (thinkingText || isReasoningRuntimeAgentStream(payload.stream ?? "")) {
      next = {
        ...next,
        thinkingUntilByAgentId: recordThinkingActivity(
          next.thinkingUntilByAgentId,
          agentId,
          nowMs,
        ),
      };
    } else if (streamText) {
      next = {
        ...next,
        streamingUntilByAgentId: recordStreamingActivity(
          next.streamingUntilByAgentId,
          agentId,
          nowMs,
        ),
      };
    }
  }

  const requested = parseExecApprovalRequested(params.event);
  if (requested) {
    const approvalAgentId = resolveExecApprovalAgentId({
      requested,
      agents: params.agents,
    });
    if (approvalAgentId) {
      next = {
        ...next,
        workingUntilByAgentId: recordWorkingActivity(
          next.workingUntilByAgentId,
          approvalAgentId,
          nowMs,
        ),
      };
    }
  }

  const resolved = parseExecApprovalResolved(params.event);
  if (resolved) {
    const approvalAgentId = params.agents.find(
      (agent) => agent.awaitingUserInput,
    )?.agentId;
    if (approvalAgentId) {
      next = {
        ...next,
        workingUntilByAgentId: recordWorkingActivity(
          next.workingUntilByAgentId,
          approvalAgentId,
          nowMs,
        ),
      };
    }
  }

  return next;
};

export const reconcileOfficeAnimationTriggerState = (params: {
  agents: AgentState[];
  nowMs?: number;
  state: OfficeAnimationTriggerState;
}): OfficeAnimationTriggerState => {
  // Reconciliation is the durable source of truth. It replays the latest user-visible intent
  // from current agent state so recovered history can restore holds even when chat events were missed.
  const nowMs = params.nowMs ?? Date.now();
  const next = pruneOfficeAnimationTriggerState(
    params.state,
    params.agents,
    nowMs,
  );

  const activeAgentIds = new Set(params.agents.map((agent) => agent.agentId));
  const currentImmediateGymKeys = pruneStringMap(
    next.lastManualGymCommandKeyByAgentId,
    activeAgentIds,
  );

  const deskHoldByAgentId: BooleanByAgentId = {};
  const deskDirectiveKeyByAgentId: StringByAgentId = {};
  const githubHoldByAgentId: BooleanByAgentId = {};
  const githubDirectiveKeyByAgentId: StringByAgentId = {};
  const qaHoldByAgentId: BooleanByAgentId = {};
  const qaDirectiveKeyByAgentId: StringByAgentId = {};
  const skillGymHoldByAgentId: BooleanByAgentId = {};
  const skillGymDirectiveKeyByAgentId: StringByAgentId = {};
  let workingUntilByAgentId = next.workingUntilByAgentId;
  const manualGymUntilByAgentId = next.manualGymUntilByAgentId;
  let pendingStandupRequest = next.pendingStandupRequest;
  if (
    pendingStandupRequest &&
    nowMs - pendingStandupRequest.requestedAt > STANDUP_TRIGGER_MAX_AGE_MS
  ) {
    pendingStandupRequest = null;
  }

  for (const agent of params.agents) {
    const agentId = agent.agentId;
    const isAgentRunning = agent.status === "running" || Boolean(agent.runId);
    if (isAgentRunning) {
      workingUntilByAgentId = recordWorkingActivity(
        workingUntilByAgentId,
        agentId,
        nowMs,
      );
    }

    const deskDirective = resolveLatestDirective({
      lastUserMessage: agent.lastUserMessage,
      transcriptEntries: agent.transcriptEntries,
      resolver: resolveOfficeDeskDirective,
    });
    if (deskDirective) {
      deskDirectiveKeyByAgentId[agentId] = deskDirective.key;
      if (
        applyHoldDirective(
          Boolean(next.deskHoldByAgentId[agentId]),
          deskDirective,
        )
      ) {
        deskHoldByAgentId[agentId] = true;
      }
    } else if (next.deskHoldByAgentId[agentId]) {
      deskHoldByAgentId[agentId] = true;
    }

    const githubDirective = resolveLatestDirective({
      lastUserMessage: agent.lastUserMessage,
      transcriptEntries: agent.transcriptEntries,
      resolver: resolveOfficeGithubDirective,
    });
    if (githubDirective) {
      githubDirectiveKeyByAgentId[agentId] = githubDirective.key;
      const suppressedKey =
        next.suppressedGithubDirectiveKeyByAgentId[agentId] ?? "";
      if (
        githubDirective.directive !== "release" &&
        suppressedKey !== githubDirective.key
      ) {
        githubHoldByAgentId[agentId] = true;
      }
    } else if (next.githubHoldByAgentId[agentId]) {
      githubHoldByAgentId[agentId] = true;
    }

    const qaDirective = resolveLatestDirective({
      lastUserMessage: agent.lastUserMessage,
      transcriptEntries: agent.transcriptEntries,
      resolver: resolveOfficeQaDirective,
    });
    if (qaDirective) {
      qaDirectiveKeyByAgentId[agentId] = qaDirective.key;
      const suppressedKey =
        next.suppressedQaDirectiveKeyByAgentId[agentId] ?? "";
      if (
        qaDirective.directive !== "release" &&
        suppressedKey !== qaDirective.key
      ) {
        qaHoldByAgentId[agentId] = true;
      }
    } else if (next.qaHoldByAgentId[agentId]) {
      qaHoldByAgentId[agentId] = true;
    }

    const skillGymDirective = resolveLatestDirective({
      lastUserMessage: agent.lastUserMessage,
      transcriptEntries: agent.transcriptEntries,
      resolver: resolveOfficeGymDirective,
    });
    if (skillGymDirective) {
      skillGymDirectiveKeyByAgentId[agentId] = skillGymDirective.key;
      if (skillGymDirective.directive === "gym") {
        skillGymHoldByAgentId[agentId] = true;
      }
      // "release" directive clears the gym hold — do not set skillGymHoldByAgentId[agentId]
    } else if (next.skillGymHoldByAgentId[agentId]) {
      skillGymHoldByAgentId[agentId] = true;
    }
  }

  const triggeredAgentIds = resolveResetAgentIds({
    previous: next.sessionEpochSnapshot,
    agents: params.agents,
  });
  const agentMap = new Map(
    params.agents.map((agent) => [agent.agentId, agent]),
  );
  const cleaningCues = [...next.cleaningCues];
  for (const agentId of triggeredAgentIds) {
    const agent = agentMap.get(agentId);
    if (!agent) continue;
    cleaningCues.unshift({
      id: randomUUID(),
      agentId,
      agentName: agent.name || t("office.agentFallback"),
      ts: nowMs,
    });
  }

  return {
    ...next,
    cleaningCues: cleaningCues.slice(0, CLEANING_CUE_LIMIT),
    deskDirectiveKeyByAgentId,
    deskHoldByAgentId,
    githubDirectiveKeyByAgentId,
    githubHoldByAgentId,
    lastManualGymCommandKeyByAgentId: currentImmediateGymKeys,
    manualGymUntilByAgentId,
    pendingStandupRequest,
    qaDirectiveKeyByAgentId,
    qaHoldByAgentId,
    sessionEpochSnapshot: buildSessionEpochSnapshot(params.agents),
    skillGymDirectiveKeyByAgentId,
    skillGymHoldByAgentId,
    workingUntilByAgentId,
  };
};

export const clearOfficeAnimationTriggerHold = (params: {
  agentId: string;
  hold: "github" | "qa";
  state: OfficeAnimationTriggerState;
}): OfficeAnimationTriggerState => {
  const next = { ...params.state };
  if (params.hold === "github") {
    const directiveKey = next.githubDirectiveKeyByAgentId[params.agentId] ?? "";
    const githubHoldByAgentId = { ...next.githubHoldByAgentId };
    delete githubHoldByAgentId[params.agentId];
    return {
      ...next,
      githubHoldByAgentId,
      suppressedGithubDirectiveKeyByAgentId: directiveKey
        ? {
            ...next.suppressedGithubDirectiveKeyByAgentId,
            [params.agentId]: directiveKey,
          }
        : next.suppressedGithubDirectiveKeyByAgentId,
    };
  }
  const directiveKey = next.qaDirectiveKeyByAgentId[params.agentId] ?? "";
  const qaHoldByAgentId = { ...next.qaHoldByAgentId };
  delete qaHoldByAgentId[params.agentId];
  return {
    ...next,
    qaHoldByAgentId,
    suppressedQaDirectiveKeyByAgentId: directiveKey
      ? {
          ...next.suppressedQaDirectiveKeyByAgentId,
          [params.agentId]: directiveKey,
        }
      : next.suppressedQaDirectiveKeyByAgentId,
  };
};

export const buildOfficeAnimationState = (params: {
  agents: AgentState[];
  marketplaceGymHoldByAgentId?: BooleanByAgentId;
  nowMs?: number;
  state: OfficeAnimationTriggerState;
}): OfficeAnimationState => {
  // This final projection is intentionally smaller than the trigger state because the scene
  // only needs present-tense booleans and timers, not the bookkeeping used to derive them.
  const nowMs = params.nowMs ?? Date.now();
  const marketplaceGymHoldByAgentId = params.marketplaceGymHoldByAgentId ?? {};
  const awaitingApprovalByAgentId: BooleanByAgentId = {};
  const deskHoldByAgentId: BooleanByAgentId = {};
  const gymHoldByAgentId: BooleanByAgentId = {};
  const jukeboxHoldByAgentId: BooleanByAgentId = {};
  const streamingByAgentId: BooleanByAgentId = {};
  const thinkingByAgentId: BooleanByAgentId = {};

  for (const agent of params.agents) {
    const agentId = agent.agentId;
    if (agent.awaitingUserInput) {
      awaitingApprovalByAgentId[agentId] = true;
    }
    if (
      params.state.skillGymHoldByAgentId[agentId] ||
      marketplaceGymHoldByAgentId[agentId] ||
      (params.state.manualGymUntilByAgentId[agentId] ?? 0) > nowMs ||
      (params.state.gymCooldownUntilByAgentId[agentId] ?? 0) > nowMs
    ) {
      gymHoldByAgentId[agentId] = true;
    }
    if ((params.state.streamingUntilByAgentId[agentId] ?? 0) > nowMs) {
      streamingByAgentId[agentId] = true;
    }
    if ((params.state.thinkingUntilByAgentId[agentId] ?? 0) > nowMs) {
      thinkingByAgentId[agentId] = true;
    }
    if (params.state.deskHoldByAgentId[agentId] && !gymHoldByAgentId[agentId]) {
      deskHoldByAgentId[agentId] = true;
    }
  }

  return {
    awaitingApprovalByAgentId,
    cleaningCues: params.state.cleaningCues,
    danceUntilByAgentId: {},
    deskHoldByAgentId,
    githubHoldByAgentId: params.state.githubHoldByAgentId,
    gymHoldByAgentId,
    jukeboxHoldByAgentId,
    manualGymUntilByAgentId: params.state.manualGymUntilByAgentId,
    pendingStandupRequest: params.state.pendingStandupRequest,
    qaHoldByAgentId: params.state.qaHoldByAgentId,
    skillGymHoldByAgentId: params.state.skillGymHoldByAgentId,
    streamingByAgentId,
    thinkingByAgentId,
    workingUntilByAgentId: params.state.workingUntilByAgentId,
  };
};
