import { NextResponse } from "next/server";

import {
  SKILL_INSTALL_RUNTIMES,
  SkillInstallError,
  createSkillInstaller,
  type SkillRuntimeId,
} from "@/lib/skills/install";
import {
  SkillRegistryError,
  createSkillRegistries,
  findSkillRegistry,
  type SkillRegistryId,
} from "@/lib/skills/registry";
import { t } from "@/lib/i18n";

export const runtime = "nodejs";

const KNOWN_REGISTRIES = new Set<SkillRegistryId>(["clawhub", "github"]);

type InstallRequest = {
  registry: SkillRegistryId;
  slug: string;
  version: string | null;
  runtime: SkillRuntimeId;
};

class InvalidRequestError extends Error {}

const requireString = (value: unknown, field: string): string => {
  if (typeof value !== "string" || !value.trim()) {
    throw new InvalidRequestError(t("apiCommon.fieldRequired", { field }));
  }
  return value.trim();
};

const normalizeInstallRequest = (body: unknown): InstallRequest => {
  if (!body || typeof body !== "object") {
    throw new InvalidRequestError(t("apiCommon.invalidRequestPayload"));
  }
  const record = body as Record<string, unknown>;

  const registry = requireString(record.registry, "registry") as SkillRegistryId;
  if (!KNOWN_REGISTRIES.has(registry)) {
    throw new InvalidRequestError(t("apiSkills.unknownRegistry", { registry }));
  }

  const target = requireString(record.runtime, "runtime") as SkillRuntimeId;
  if (!SKILL_INSTALL_RUNTIMES.includes(target)) {
    throw new InvalidRequestError(
      t("apiSkills.unsupportedInstallRuntime", { target, supported: SKILL_INSTALL_RUNTIMES.join(", ") }),
    );
  }

  const version =
    typeof record.version === "string" && record.version.trim()
      ? record.version.trim()
      : null;

  return { registry, slug: requireString(record.slug, "slug"), version, runtime: target };
};

/**
 * Fetches a skill from a registry and installs it into a runtime's skills
 * directory.
 *
 * The two failure modes are reported apart on purpose: a registry error means
 * the skill could not be fetched and nothing was written, while an install
 * error means it was fetched but rejected or could not be stored. Both are
 * 400s the caller can act on, not server faults.
 */
export async function POST(request: Request) {
  let payload: InstallRequest;
  try {
    payload = normalizeInstallRequest(await request.json());
  } catch (error) {
    const message =
      error instanceof Error ? error.message : t("apiCommon.invalidRequestPayload");
    return NextResponse.json({ error: message }, { status: 400 });
  }

  try {
    const registry = findSkillRegistry(createSkillRegistries(), payload.registry);
    const pkg = await registry.fetchPackage(payload.slug, payload.version);
    const installed = createSkillInstaller(payload.runtime).install(pkg);

    return NextResponse.json(
      { installed, summary: pkg.summary },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof SkillRegistryError || error instanceof SkillInstallError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    const message =
      error instanceof Error ? error.message : t("apiSkills.installFailed");
    console.error(message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** Lists what is installed for a runtime, with each skill's provenance. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const target = (url.searchParams.get("runtime") ?? "openclaw") as SkillRuntimeId;
  if (!SKILL_INSTALL_RUNTIMES.includes(target)) {
    return NextResponse.json(
      { error: t("apiSkills.unknownRuntime", { runtime: target }) },
      { status: 400 },
    );
  }

  const installer = createSkillInstaller(target);
  return NextResponse.json(
    { runtime: target, root: installer.root, skills: installer.list() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
