import { buildAgentMainSessionKey, parseAgentIdFromSessionKey } from "@/lib/gateway/GatewayClient";
import { buildAgentInstruction } from "@/lib/text/message-extract";
import { randomUUID } from "@/lib/uuid";
import { t } from "@/lib/i18n";

export type RuntimeAgentMessageMode = "direct" | "interval";

export type RuntimeAgentMessagePayload = {
  targetAgentId: string;
  message: string;
  sourceAgentId?: string | null;
  sourceLabel?: string | null;
  mode?: RuntimeAgentMessageMode;
  cadenceHint?: string | null;
  idempotencyKey?: string | null;
};

export type RuntimeAgentHandoffPayload = {
  targetAgentId: string;
  task: string;
  sourceAgentId?: string | null;
  sourceLabel?: string | null;
  context?: string | null;
  deliverables?: string[];
  acceptanceCriteria?: string | null;
  idempotencyKey?: string | null;
};

type GatewayCallLike = {
  call: <T = unknown>(method: string, params: unknown) => Promise<T>;
};

type GatewayAgentsListResult = {
  mainKey?: string;
  agents?: Array<{ id?: string; name?: string }>;
};

const resolveLabel = (sourceAgentId?: string | null, sourceLabel?: string | null) =>
  sourceLabel?.trim() || sourceAgentId?.trim() || t("libRuntime.anotherAgent");

export const buildDirectedAgentMessageInstruction = (
  payload: RuntimeAgentMessagePayload,
): string => {
  const mode = payload.mode ?? "direct";
  const sourceLabel = resolveLabel(payload.sourceAgentId, payload.sourceLabel);
  const message = payload.message.trim();
  const cadenceHint = payload.cadenceHint?.trim();
  if (mode === "interval") {
    return [
      t("libRuntime.intervalMessageIntro", { sourceLabel }),
      t("libRuntime.intervalOngoingThread"),
      t("libRuntime.intervalRespond"),
      cadenceHint ? t("libRuntime.cadenceHint", { cadenceHint }) : null,
      "",
      t("libRuntime.messageLine", { message }),
    ]
      .filter(Boolean)
      .join("\n");
  }
  return [
    t("libRuntime.directMessageIntro", { sourceLabel }),
    t("libRuntime.directReplyPlain"),
    t("libRuntime.directNoTools"),
    "",
    t("libRuntime.messageLine", { message }),
  ].join("\n");
};

export const buildAgentHandoffInstruction = (
  payload: RuntimeAgentHandoffPayload,
): string => {
  const sourceLabel = resolveLabel(payload.sourceAgentId, payload.sourceLabel);
  const task = payload.task.trim();
  const context = payload.context?.trim();
  const acceptanceCriteria = payload.acceptanceCriteria?.trim();
  const deliverables =
    payload.deliverables?.map((entry) => entry.trim()).filter(Boolean) ?? [];
  return [
    t("libRuntime.handoffIntro", { sourceLabel }),
    t("libRuntime.handoffAcknowledge"),
    t("libRuntime.handoffClarify"),
    "",
    t("libRuntime.handoffTask", { task }),
    context ? t("libRuntime.handoffContext", { context }) : null,
    acceptanceCriteria ? t("libRuntime.handoffAcceptance", { acceptanceCriteria }) : null,
    deliverables.length > 0 ? t("libRuntime.handoffDeliverables") + deliverables.join("\n- ") : null,
  ]
    .filter(Boolean)
    .join("\n");
};

const resolveSessionKeyFromAgentList = async (
  client: GatewayCallLike,
  targetAgentId: string,
): Promise<string> => {
  const agentsResult = await client.call<GatewayAgentsListResult>("agents.list", {});
  const remoteAgents = Array.isArray(agentsResult.agents) ? agentsResult.agents : [];
  if (!remoteAgents.some((entry) => (entry.id?.trim() ?? "") === targetAgentId)) {
    throw new Error(t("libRuntime.targetAgentUnavailable"));
  }
  return buildAgentMainSessionKey(targetAgentId, agentsResult.mainKey?.trim() || "main");
};

export const sendDirectedAgentMessageViaRuntime = async (
  client: GatewayCallLike,
  payload: RuntimeAgentMessagePayload,
) => {
  const targetAgentId = payload.targetAgentId.trim();
  const message = payload.message.trim();
  if (!targetAgentId || !message) {
    throw new Error(t("libRuntime.targetAndMessageRequired"));
  }
  const sessionKey = await resolveSessionKeyFromAgentList(client, targetAgentId);
  return client.call("chat.send", {
    sessionKey,
    message: buildAgentInstruction({
      message: buildDirectedAgentMessageInstruction(payload),
    }),
    deliver: false,
    echoUserMessage: false,
    sourceAgentId: payload.sourceAgentId?.trim() || parseAgentIdFromSessionKey(sessionKey),
    idempotencyKey: payload.idempotencyKey?.trim() || randomUUID(),
  });
};

export const sendAgentHandoffViaRuntime = async (
  client: GatewayCallLike,
  payload: RuntimeAgentHandoffPayload,
) => {
  const targetAgentId = payload.targetAgentId.trim();
  const task = payload.task.trim();
  if (!targetAgentId || !task) {
    throw new Error(t("libRuntime.targetAndTaskRequired"));
  }
  const sessionKey = await resolveSessionKeyFromAgentList(client, targetAgentId);
  return client.call("chat.send", {
    sessionKey,
    message: buildAgentInstruction({
      message: buildAgentHandoffInstruction(payload),
    }),
    deliver: false,
    echoUserMessage: false,
    sourceAgentId: payload.sourceAgentId?.trim() || parseAgentIdFromSessionKey(sessionKey),
    idempotencyKey: payload.idempotencyKey?.trim() || randomUUID(),
  });
};
