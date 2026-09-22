
import { t } from "@/lib/i18n";
export const AGENT_FILE_NAMES = [
  "AGENTS.md",
  "SOUL.md",
  "IDENTITY.md",
  "USER.md",
  "TOOLS.md",
  "HEARTBEAT.md",
  "MEMORY.md",
] as const;

export type AgentFileName = (typeof AGENT_FILE_NAMES)[number];

export const PERSONALITY_FILE_NAMES = [
  "SOUL.md",
  "AGENTS.md",
  "USER.md",
  "IDENTITY.md",
] as const satisfies readonly AgentFileName[];

export type PersonalityFileName = (typeof PERSONALITY_FILE_NAMES)[number];

export const PERSONALITY_FILE_LABELS: Record<PersonalityFileName, string> = {
  "SOUL.md": t("agentFiles.labelPersona"),
  "AGENTS.md": t("agentFiles.labelDirectives"),
  "USER.md": t("agentFiles.labelContext"),
  "IDENTITY.md": t("agentFiles.labelIdentity"),
};

export const isAgentFileName = (value: string): value is AgentFileName =>
  AGENT_FILE_NAMES.includes(value as AgentFileName);

export const AGENT_FILE_META: Record<AgentFileName, { title: string; hint: string }> = {
  "AGENTS.md": {
    title: "AGENTS.md",
    hint: t("agentFiles.hintAgents"),
  },
  "SOUL.md": {
    title: "SOUL.md",
    hint: t("agentFiles.hintSoul"),
  },
  "IDENTITY.md": {
    title: "IDENTITY.md",
    hint: t("agentFiles.hintIdentity"),
  },
  "USER.md": {
    title: "USER.md",
    hint: t("agentFiles.hintUser"),
  },
  "TOOLS.md": {
    title: "TOOLS.md",
    hint: t("agentFiles.hintTools"),
  },
  "HEARTBEAT.md": {
    title: "HEARTBEAT.md",
    hint: t("agentFiles.hintHeartbeat"),
  },
  "MEMORY.md": {
    title: "MEMORY.md",
    hint: t("agentFiles.hintMemory"),
  },
};

export const AGENT_FILE_PLACEHOLDERS: Record<AgentFileName, string> = {
  "AGENTS.md": t("agentFiles.phAgents"),
  "SOUL.md": t("agentFiles.phSoul"),
  "IDENTITY.md": t("agentFiles.phIdentity"),
  "USER.md": t("agentFiles.phUser"),
  "TOOLS.md": t("agentFiles.phTools"),
  "HEARTBEAT.md": t("agentFiles.phHeartbeat"),
  "MEMORY.md": t("agentFiles.phMemory"),
};

export const createAgentFilesState = () =>
  Object.fromEntries(
    AGENT_FILE_NAMES.map((name) => [name, { content: "", exists: false, path: null, workspace: null }])
  ) as Record<AgentFileName, { content: string; exists: boolean; path: string | null; workspace: string | null }>;
