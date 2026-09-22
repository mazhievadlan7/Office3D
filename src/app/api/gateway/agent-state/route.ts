import { NextResponse } from "next/server";

import { restoreAgentStateLocally, trashAgentStateLocally } from "@/lib/agent-state/local";
import { isLikelyLocalGatewayUrl } from "@/lib/gateway/local-gateway";
import {
  resolveConfiguredSshTarget,
  resolveGatewaySshTargetFromGatewayUrl,
} from "@/lib/ssh/gateway-host";
import {
  restoreAgentStateOverSsh,
  trashAgentStateOverSsh,
} from "@/lib/ssh/agent-state";
import { loadStudioSettings } from "@/lib/studio/settings-store";
import { matchesPhrase, t, type TranslationKey } from "@/lib/i18n";

const INVALID_REQUEST_PHRASES: TranslationKey[] = [
  "apiCommon.invalidRequestPayload",
  "apiGateway.agentIdRequired",
  "apiGateway.invalidAgentId",
  "apiGateway.trashDirRequired",
  "libAgentState.agentIdRequired",
  "libAgentState.invalidAgentId",
  "libAgentState.trashDirRequired",
  "libAgentState.trashDirMissing",
  "libAgentState.trashDirOutsideBase",
  "libAgentState.restoreTargetExists",
  "libSsh.gatewayUrlMissing",
  "libSsh.invalidGatewayUrl",
];

export const runtime = "nodejs";

type TrashAgentStateRequest = {
  agentId: string;
};

type RestoreAgentStateRequest = {
  agentId: string;
  trashDir: string;
};

const isSafeAgentId = (value: string) => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value);

const resolveAgentStateSshTarget = (): string | null => {
  const configured = resolveConfiguredSshTarget(process.env);
  if (configured) return configured;
  const settings = loadStudioSettings();
  const gatewayUrl = settings.gateway?.url ?? "";
  if (isLikelyLocalGatewayUrl(gatewayUrl)) return null;
  return resolveGatewaySshTargetFromGatewayUrl(gatewayUrl, process.env);
};

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as unknown;
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: t("apiCommon.invalidRequestPayload") }, { status: 400 });
    }
    const { agentId } = body as Partial<TrashAgentStateRequest>;
    const trimmed = typeof agentId === "string" ? agentId.trim() : "";
    if (!trimmed) {
      return NextResponse.json({ error: t("apiGateway.agentIdRequired") }, { status: 400 });
    }
    if (!isSafeAgentId(trimmed)) {
      return NextResponse.json({ error: t("apiGateway.invalidAgentId", { agentId: trimmed }) }, { status: 400 });
    }

    const sshTarget = resolveAgentStateSshTarget();
    const result = sshTarget
      ? trashAgentStateOverSsh({ sshTarget, agentId: trimmed })
      : trashAgentStateLocally({ agentId: trimmed });
    return NextResponse.json({ result });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : t("apiGateway.trashAgentFailed");
    console.error(message);
    // Our own validation errors are matched by phrase; the English ones come
    // from the Python script that does the work over SSH.
    const status =
      INVALID_REQUEST_PHRASES.some((key) => matchesPhrase(message, key)) ||
      message.includes("agentId is required") ||
      message.includes("trashDir is required") ||
      message.includes("Invalid agentId") ||
      message.includes("trashDir does not exist") ||
      message.includes("trashDir is not under") ||
      message.includes("Refusing to restore over existing path") ||
      message.includes("require OPENCLAW_GATEWAY_SSH_TARGET")
        ? 400
        : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function PUT(request: Request) {
  try {
    const body = (await request.json()) as unknown;
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: t("apiCommon.invalidRequestPayload") }, { status: 400 });
    }
    const { agentId, trashDir } = body as Partial<RestoreAgentStateRequest>;
    const trimmedAgent = typeof agentId === "string" ? agentId.trim() : "";
    const trimmedTrash = typeof trashDir === "string" ? trashDir.trim() : "";
    if (!trimmedAgent) {
      return NextResponse.json({ error: t("apiGateway.agentIdRequired") }, { status: 400 });
    }
    if (!trimmedTrash) {
      return NextResponse.json({ error: t("apiGateway.trashDirRequired") }, { status: 400 });
    }
    if (!isSafeAgentId(trimmedAgent)) {
      return NextResponse.json({ error: t("apiGateway.invalidAgentId", { agentId: trimmedAgent }) }, { status: 400 });
    }

    const sshTarget = resolveAgentStateSshTarget();
    const result = sshTarget
      ? restoreAgentStateOverSsh({
          sshTarget,
          agentId: trimmedAgent,
          trashDir: trimmedTrash,
        })
      : restoreAgentStateLocally({
          agentId: trimmedAgent,
          trashDir: trimmedTrash,
        });
    return NextResponse.json({ result });
  } catch (err) {
    const message = err instanceof Error ? err.message : t("apiGateway.restoreAgentFailed");
    console.error(message);
    // Our own validation errors are matched by phrase; the English ones come
    // from the Python script that does the work over SSH.
    const status =
      INVALID_REQUEST_PHRASES.some((key) => matchesPhrase(message, key)) ||
      message.includes("agentId is required") ||
      message.includes("trashDir is required") ||
      message.includes("Invalid agentId") ||
      message.includes("require OPENCLAW_GATEWAY_SSH_TARGET")
        ? 400
        : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
