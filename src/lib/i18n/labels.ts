import { t } from "@/lib/i18n";

// Russian labels for values that arrive as English identifiers — a message
// role, a GitHub file status — and are shown as they are. Explicit maps rather
// than keys built from the value: the dictionary check only sees keys written
// out in full, and a value nobody planned for should show as itself rather
// than as a missing key.

const MESSAGE_ROLES: Record<string, () => string> = {
  user: () => t("labels.roleUser"),
  assistant: () => t("labels.roleAssistant"),
  system: () => t("labels.roleSystem"),
  tool: () => t("labels.roleTool"),
  thinking: () => t("labels.roleThinking"),
};

export const messageRoleLabel = (role: string): string => MESSAGE_ROLES[role]?.() ?? role;

// https://docs.github.com/en/rest/pulls/pulls#list-pull-requests-files
const GITHUB_FILE_STATUSES: Record<string, () => string> = {
  added: () => t("labels.fileAdded"),
  removed: () => t("labels.fileRemoved"),
  modified: () => t("labels.fileModified"),
  renamed: () => t("labels.fileRenamed"),
  copied: () => t("labels.fileCopied"),
  changed: () => t("labels.fileChanged"),
  unchanged: () => t("labels.fileUnchanged"),
};

export const githubFileStatusLabel = (status: string): string =>
  GITHUB_FILE_STATUSES[status]?.() ?? status;

const STANDUP_SOURCES: Record<string, () => string> = {
  github: () => "GitHub",
  jira: () => "Jira",
  manual: () => t("labels.sourceManual"),
};

export const standupSourceLabel = (kind: string): string => STANDUP_SOURCES[kind]?.() ?? kind;

const GATEWAY_STATUSES: Record<string, () => string> = {
  connected: () => t("settings.gatewayStatusConnected"),
  connecting: () => t("settings.gatewayStatusConnecting"),
  disconnected: () => t("settings.gatewayStatusDisconnected"),
  reconnecting: () => t("settings.gatewayStatusReconnecting"),
  blocked: () => t("settings.gatewayStatusBlocked"),
};

export const gatewayStatusLabel = (status: string): string =>
  GATEWAY_STATUSES[status]?.() ?? status;

// Backend (adapter) kinds as the connection screens name them. Product names
// stay as they are; the generic kinds are words.
const ADAPTERS: Record<string, () => string> = {
  openclaw: () => "OpenClaw",
  hermes: () => "Hermes",
  office3d: () => "Office3D",
  demo: () => t("labels.adapterDemo"),
  local: () => t("labels.adapterLocal"),
  custom: () => t("labels.adapterCustom"),
};

export const adapterLabel = (adapter: string): string => ADAPTERS[adapter]?.() ?? adapter;
