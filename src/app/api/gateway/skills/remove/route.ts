import { NextResponse } from "next/server";

import { isLikelyLocalGatewayUrl } from "@/lib/gateway/local-gateway";
import { removeSkillLocally } from "@/lib/skills/remove-local";
import type { RemovableSkillSource, SkillRemoveRequest } from "@/lib/skills/types";
import {
  resolveConfiguredSshTarget,
  resolveGatewaySshTargetFromGatewayUrl,
} from "@/lib/ssh/gateway-host";
import { removeSkillOverSsh } from "@/lib/ssh/skills-remove";
import { loadStudioSettings } from "@/lib/studio/settings-store";
import { matchesPhrase, t, type TranslationKey } from "@/lib/i18n";

const INVALID_REQUEST_PHRASES: TranslationKey[] = [
  "apiCommon.fieldRequired",
  "apiCommon.invalidRequestPayload",
  "apiGateway.unsupportedSkillSource",
  "libSkills.fieldRequired",
  "libSkills.removeOutsideRoot",
  "libSkills.removeSkillsRoot",
  "libSkills.notADirectory",
  "libSkills.removeNonSkillDir",
  "libSsh.gatewayUrlMissing",
  "libSsh.invalidGatewayUrl",
];

export const runtime = "nodejs";

const REMOVABLE_SOURCES = new Set<RemovableSkillSource>([
  "openclaw-managed",
  "openclaw-workspace",
]);

const normalizeRequired = (value: unknown, field: string): string => {
  if (typeof value !== "string") {
    throw new Error(t("apiCommon.fieldRequired", { field }));
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(t("apiCommon.fieldRequired", { field }));
  }
  return trimmed;
};

const resolveSkillRemovalSshTarget = (): string | null => {
  const configured = resolveConfiguredSshTarget(process.env);
  if (configured) return configured;
  const settings = loadStudioSettings();
  const gatewayUrl = settings.gateway?.url ?? "";
  if (isLikelyLocalGatewayUrl(gatewayUrl)) return null;
  return resolveGatewaySshTargetFromGatewayUrl(gatewayUrl, process.env);
};

const normalizeRemoveRequest = (body: unknown): SkillRemoveRequest => {
  if (!body || typeof body !== "object") {
    throw new Error(t("apiCommon.invalidRequestPayload"));
  }

  const record = body as Partial<Record<keyof SkillRemoveRequest, unknown>>;
  const sourceRaw = normalizeRequired(record.source, "source");
  if (!REMOVABLE_SOURCES.has(sourceRaw as RemovableSkillSource)) {
    throw new Error(t("apiGateway.unsupportedSkillSource", { source: sourceRaw }));
  }

  return {
    skillKey: normalizeRequired(record.skillKey, "skillKey"),
    source: sourceRaw as RemovableSkillSource,
    baseDir: normalizeRequired(record.baseDir, "baseDir"),
    workspaceDir: normalizeRequired(record.workspaceDir, "workspaceDir"),
    managedSkillsDir: normalizeRequired(record.managedSkillsDir, "managedSkillsDir"),
  };
};

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as unknown;
    const removeRequest = normalizeRemoveRequest(body);

    const sshTarget = resolveSkillRemovalSshTarget();
    const result = sshTarget
      ? removeSkillOverSsh({ sshTarget, request: removeRequest })
      : removeSkillLocally(removeRequest);

    return NextResponse.json({ result });
  } catch (err) {
    const message = err instanceof Error ? err.message : t("apiGateway.skillRemoveFailed");
    // Our own validation errors are matched by phrase; the English ones come
    // from the Python script that removes a skill over SSH.
    const status =
      INVALID_REQUEST_PHRASES.some((key) => matchesPhrase(message, key)) ||
      message.includes("required") ||
      message.includes("Unsupported skill source") ||
      message.includes("Refusing to remove") ||
      message.includes("not a directory") ||
      message.includes("Remote workspace skill removal is not supported over SSH") ||
      message.includes("require OPENCLAW_GATEWAY_SSH_TARGET")
        ? 400
        : 500;
    if (status >= 500) {
      console.error(message);
    }
    return NextResponse.json({ error: message }, { status });
  }
}
