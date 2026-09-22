import type { AgentStatus } from "@/features/agents/state/store";
import type { GatewayStatus } from "@/lib/gateway/GatewayClient";
import { t } from "@/lib/i18n";

export const AGENT_STATUS_LABEL: Record<AgentStatus, string> = {
  idle: t("fleet.statusIdle"),
  running: t("fleet.statusRunning"),
  error: t("fleet.statusError"),
};

export const AGENT_STATUS_BADGE_CLASS: Record<AgentStatus, string> = {
  idle: "ui-badge-status-idle",
  running: "ui-badge-status-running",
  error: "ui-badge-status-error",
};

export const GATEWAY_STATUS_LABEL: Record<GatewayStatus, string> = {
  disconnected: t("settings.gatewayStatusDisconnected"),
  connecting: t("settings.gatewayStatusConnecting"),
  connected: t("settings.gatewayStatusConnected"),
};

export const GATEWAY_STATUS_BADGE_CLASS: Record<GatewayStatus, string> = {
  disconnected: "ui-badge-status-disconnected",
  connecting: "ui-badge-status-connecting",
  connected: "ui-badge-status-connected",
};

export const NEEDS_APPROVAL_BADGE_CLASS = "ui-badge-approval";

export const resolveAgentStatusBadgeClass = (status: AgentStatus): string =>
  AGENT_STATUS_BADGE_CLASS[status];

export const resolveGatewayStatusBadgeClass = (status: GatewayStatus): string =>
  GATEWAY_STATUS_BADGE_CLASS[status];

export const resolveAgentStatusLabel = (status: AgentStatus): string => AGENT_STATUS_LABEL[status];

export const resolveGatewayStatusLabel = (status: GatewayStatus): string => GATEWAY_STATUS_LABEL[status];
