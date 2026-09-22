import { buildAgentMainSessionKey, type GatewayClient } from "@/lib/gateway/GatewayClient";
import {
  removeGatewayAgentFromConfigOnly,
  updateGatewayAgentOverrides,
} from "@/lib/gateway/agentConfig";
import type { SkillRemoveRequest, SkillRemoveResult } from "@/lib/skills/types";
import { t } from "@/lib/i18n";

const normalizeRequired = (value: string, field: string): string => {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(t("libSkills.fieldRequired", { field }));
  }
  return trimmed;
};

const escapeForJsonString = (value: string) => JSON.stringify(value);

const resolveRunId = (payload: unknown): string => {
  if (!payload || typeof payload !== "object") {
    throw new Error(t("libGateway.invalidChatSendResponse"));
  }
  const record = payload as Record<string, unknown>;
  const runId = typeof record.runId === "string" ? record.runId.trim() : "";
  if (!runId) {
    throw new Error(t("libGateway.chatSendMissingRunId"));
  }
  return runId;
};

const resolveMainKey = async (client: GatewayClient): Promise<string> => {
  const result = (await client.call("agents.list", {})) as { mainKey?: unknown };
  return typeof result?.mainKey === "string" && result.mainKey.trim() ? result.mainKey.trim() : "main";
};

const buildSkillRemovalMessage = (params: {
  baseDir: string;
  allowedRoot: string;
}) => {
  return [
    t("libSkills.removerDeleteOne"),
    t("libSkills.removerTools"),
    t("libSkills.removerTargetDir", { path: escapeForJsonString(params.baseDir) }),
    t("libSkills.removerAllowedRoot", { path: escapeForJsonString(params.allowedRoot) }),
    "",
    t("libSkills.removerRules"),
    t("libSkills.removerRule1"),
    t("libSkills.removerRule2"),
    t("libSkills.removerRule3"),
    t("libSkills.removerRule4"),
    t("libSkills.removerRule5"),
    t("libSkills.removerRule6"),
  ].join("\n");
};

const resolveRemovalWorkspace = (request: SkillRemoveRequest): string => {
  return request.source === "openclaw-managed" ? request.managedSkillsDir : request.workspaceDir;
};

const resolveAllowedRoot = (request: SkillRemoveRequest): string => {
  return request.source === "openclaw-managed"
    ? request.managedSkillsDir
    : `${request.workspaceDir.replace(/[\\/]+$/, "")}/skills`;
};

export const removeSkillViaGatewayAgent = async (params: {
  client: GatewayClient;
  request: SkillRemoveRequest;
}): Promise<SkillRemoveResult> => {
  const skillKey = normalizeRequired(params.request.skillKey, "skillKey");
  const source = params.request.source;
  const baseDir = normalizeRequired(params.request.baseDir, "baseDir");
  const workspaceDir = normalizeRequired(params.request.workspaceDir, "workspaceDir");
  const managedSkillsDir = normalizeRequired(params.request.managedSkillsDir, "managedSkillsDir");
  const workspace = resolveRemovalWorkspace({
    ...params.request,
    skillKey,
    baseDir,
    workspaceDir,
    managedSkillsDir,
  });
  const allowedRoot = resolveAllowedRoot({
    ...params.request,
    skillKey,
    baseDir,
    workspaceDir,
    managedSkillsDir,
  });
  const removerName = `Skill Remover ${Date.now()}`;

  let removerAgentId: string | null = null;
  try {
    const created = (await params.client.call("agents.create", {
      name: removerName,
      workspace,
    })) as { agentId?: unknown };
    removerAgentId = typeof created?.agentId === "string" ? created.agentId.trim() : "";
    if (!removerAgentId) {
      throw new Error(t("libGateway.agentsCreateMissingAgentId"));
    }

    await updateGatewayAgentOverrides({
      client: params.client,
      agentId: removerAgentId,
      overrides: {
        tools: {
          alsoAllow: ["group:runtime", "group:fs"],
          deny: ["group:web"],
        },
      },
    });

    const mainKey = await resolveMainKey(params.client);
    const sessionKey = buildAgentMainSessionKey(removerAgentId, mainKey);
    const sendResult = await params.client.call("chat.send", {
      sessionKey,
      message: buildSkillRemovalMessage({ baseDir, allowedRoot }),
      deliver: false,
      idempotencyKey: `skill-remove:${skillKey}:${Date.now()}`,
    });
    const runId = resolveRunId(sendResult);
    await params.client.call("agent.wait", { runId, timeoutMs: 60_000 });

    return {
      removed: true,
      removedPath: baseDir,
      source,
    };
  } finally {
    if (removerAgentId) {
      try {
        await removeGatewayAgentFromConfigOnly({
          client: params.client,
          agentId: removerAgentId,
        });
      } catch {
        // Best-effort cleanup for temporary remover agents.
      }
    }
  }
};
