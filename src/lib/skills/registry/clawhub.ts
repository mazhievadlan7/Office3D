import { fetchJson } from "@/lib/http";
import {
  SkillRegistryError,
  assertValidSkillPackageFiles,
  type RegistrySkillFile,
  type RegistrySkillPackage,
  type RegistrySkillSummary,
  type SkillRegistry,
  type SkillRegistrySearchOptions,
} from "@/lib/skills/registry/types";
import { t } from "@/lib/i18n";

/**
 * ClawHub — the public skill registry for OpenClaw.
 *
 * Endpoints are `GET /api/v1/packages` and `GET /api/v1/packages/search`, per
 * ClawHub's published CLI/API documentation. The exact JSON field names are not
 * pinned down there, so every reader below accepts the plausible spellings and
 * falls back rather than throwing: a registry that renames `downloads` to
 * `downloadCount` should cost us a missing figure, not a broken marketplace.
 *
 * The base URL is configurable so a self-hosted or mirrored registry works, and
 * so this can be pointed at a fixture server in an environment where
 * clawhub.ai is unreachable.
 */
const DEFAULT_CLAWHUB_API_URL = "https://clawhub.ai";

export const resolveClawHubApiUrl = (env: NodeJS.ProcessEnv = process.env): string =>
  (env.CLAWHUB_API_URL?.trim() || DEFAULT_CLAWHUB_API_URL).replace(/\/+$/, "");

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const readString = (source: Record<string, unknown>, ...keys: string[]): string | null => {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
};

const readNumber = (source: Record<string, unknown>, ...keys: string[]): number | null => {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
};

/** Registries wrap their results differently; accept the common shapes. */
const readList = (payload: unknown): unknown[] => {
  if (Array.isArray(payload)) return payload;
  const record = asRecord(payload);
  if (!record) return [];
  for (const key of ["packages", "results", "items", "data"]) {
    const value = record[key];
    if (Array.isArray(value)) return value;
  }
  return [];
};

export const normalizeClawHubSummary = (value: unknown): RegistrySkillSummary | null => {
  const record = asRecord(value);
  if (!record) return null;
  const slug = readString(record, "slug", "name", "id", "packageName");
  if (!slug) return null;
  return {
    registry: "clawhub",
    slug,
    name: readString(record, "displayName", "title", "name") ?? slug,
    description: readString(record, "description", "summary", "tagline") ?? "",
    version: readString(record, "version", "latestVersion", "latest"),
    homepageUrl: readString(record, "homepage", "homepageUrl", "url", "repository"),
    downloads: readNumber(record, "downloads", "downloadCount", "installs"),
    stars: readNumber(record, "stars", "starCount", "stargazers"),
    updatedAt: readString(record, "updatedAt", "publishedAt", "modifiedAt"),
  };
};

const normalizeFiles = (payload: unknown): RegistrySkillFile[] => {
  const record = asRecord(payload);
  const rawFiles = record ? record.files : null;
  const files: RegistrySkillFile[] = [];

  if (Array.isArray(rawFiles)) {
    for (const entry of rawFiles) {
      const fileRecord = asRecord(entry);
      if (!fileRecord) continue;
      const path = readString(fileRecord, "path", "name", "filename");
      const contents = fileRecord.content ?? fileRecord.contents ?? fileRecord.body;
      if (!path || typeof contents !== "string") continue;
      files.push({ path, contents });
    }
  } else if (rawFiles && typeof rawFiles === "object") {
    // Some registries return a { path: contents } map instead of a list.
    for (const [path, contents] of Object.entries(rawFiles as Record<string, unknown>)) {
      if (typeof contents === "string") files.push({ path, contents });
    }
  }

  // A registry may return the manifest on its own rather than in the file list.
  if (!files.some((file) => file.path === "SKILL.md") && record) {
    const manifest = readString(record, "skillMd", "skill_md", "manifest", "readme");
    if (manifest) files.push({ path: "SKILL.md", contents: manifest });
  }

  return files;
};

export class ClawHubRegistry implements SkillRegistry {
  readonly id = "clawhub" as const;
  readonly label = "ClawHub";

  constructor(private readonly apiUrl: string = resolveClawHubApiUrl()) {}

  async search(
    query: string,
    options: SkillRegistrySearchOptions = {},
  ): Promise<RegistrySkillSummary[]> {
    const trimmed = query.trim();
    const url = new URL(
      trimmed ? "/api/v1/packages/search" : "/api/v1/packages",
      `${this.apiUrl}/`,
    );
    if (trimmed) url.searchParams.set("q", trimmed);
    if (options.limit) url.searchParams.set("limit", String(options.limit));

    let payload: unknown;
    try {
      payload = await fetchJson<unknown>(url, {
        headers: { Accept: "application/json" },
        signal: options.signal,
      });
    } catch (error) {
      throw new SkillRegistryError(
        this.id,
        t("libSkills.clawhubSearchFailed", { message: error instanceof Error ? error.message : String(error) }),
        error,
      );
    }

    return readList(payload)
      .map(normalizeClawHubSummary)
      .filter((entry): entry is RegistrySkillSummary => entry !== null)
      .slice(0, options.limit ?? Infinity);
  }

  async fetchPackage(
    slug: string,
    version?: string | null,
    options: { signal?: AbortSignal } = {},
  ): Promise<RegistrySkillPackage> {
    const trimmedSlug = slug.trim();
    if (!trimmedSlug) {
      throw new SkillRegistryError(this.id, t("libSkills.slugRequired"));
    }

    const path = version?.trim()
      ? `/api/v1/packages/${trimmedSlug}/versions/${version.trim()}`
      : `/api/v1/packages/${trimmedSlug}`;
    const url = new URL(path, `${this.apiUrl}/`);

    let payload: unknown;
    try {
      payload = await fetchJson<unknown>(url, {
        headers: { Accept: "application/json" },
        signal: options.signal,
      });
    } catch (error) {
      throw new SkillRegistryError(
        this.id,
        t("libSkills.clawhubFetchFailed", { slug: trimmedSlug, message: error instanceof Error ? error.message : String(error) }),
        error,
      );
    }

    const record = asRecord(payload);
    const summarySource = asRecord(record?.package) ?? record;
    const summary = normalizeClawHubSummary({ slug: trimmedSlug, ...(summarySource ?? {}) });
    if (!summary) {
      throw new SkillRegistryError(this.id, t("libSkills.clawhubNoPackage", { slug: trimmedSlug }));
    }

    let files: RegistrySkillFile[];
    try {
      files = assertValidSkillPackageFiles(normalizeFiles(record));
    } catch (error) {
      throw new SkillRegistryError(
        this.id,
        t("libSkills.clawhubPackageUnusable", { slug: trimmedSlug, message: error instanceof Error ? error.message : String(error) }),
        error,
      );
    }

    return { summary: { ...summary, version: version?.trim() || summary.version }, files };
  }
}
