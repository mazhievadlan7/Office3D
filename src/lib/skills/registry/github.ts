import { fetchJson } from "@/lib/http";
import {
  MAX_SKILL_FILE_COUNT,
  SKILL_MANIFEST_FILENAME,
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
 * GitHub as a skill source.
 *
 * A slug is `owner/repo` for a skill at the repository root, or
 * `owner/repo/path/to/skill` for one in a subdirectory — the layout most
 * skill collections use. An optional version is a git ref (tag, branch or
 * commit), so an install can be pinned to a commit rather than tracking a
 * moving branch.
 *
 * Unauthenticated requests are rate limited to 60/hour per IP. GITHUB_TOKEN
 * raises that and is the only way to reach a private repository; it is read
 * from the environment and never accepted from the client.
 */
const GITHUB_API_URL = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";

/** Directory recursion is bounded: a skill is a small directory, not a tree. */
const MAX_DIRECTORY_DEPTH = 3;

type GitHubContentEntry = {
  type?: unknown;
  name?: unknown;
  path?: unknown;
  content?: unknown;
  encoding?: unknown;
  size?: unknown;
};

export type GitHubSkillLocation = {
  owner: string;
  repo: string;
  /** Directory inside the repository; empty means the repository root. */
  directory: string;
};

export const parseGitHubSlug = (slug: string): GitHubSkillLocation => {
  const parts = slug
    .trim()
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/\.git$/i, "")
    .split("/")
    .filter((part) => part.length > 0);

  if (parts.length < 2) {
    throw new Error(t("libSkills.githubSlugFormat", { slug }));
  }
  const [owner, repo, ...rest] = parts;
  // "tree/<ref>" appears in URLs copied from the GitHub UI; the ref belongs in
  // the version argument, so drop that prefix rather than treating it as a path.
  const directoryParts = rest[0] === "tree" ? rest.slice(2) : rest;
  return { owner, repo, directory: directoryParts.join("/") };
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const decodeContent = (entry: GitHubContentEntry): string | null => {
  if (typeof entry.content !== "string") return null;
  if (entry.encoding === "base64") {
    return Buffer.from(entry.content, "base64").toString("utf8");
  }
  return entry.content;
};

export class GitHubSkillRegistry implements SkillRegistry {
  readonly id = "github" as const;
  readonly label = "GitHub";

  constructor(
    private readonly apiUrl: string = GITHUB_API_URL,
    private readonly token: string | null = process.env.GITHUB_TOKEN?.trim() || null,
  ) {}

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    return headers;
  }

  async search(
    query: string,
    options: SkillRegistrySearchOptions = {},
  ): Promise<RegistrySkillSummary[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];

    const url = new URL("/search/repositories", `${this.apiUrl}/`);
    // Scoped to repositories that declare themselves as agent skills, so the
    // results are installable rather than any repository matching the words.
    url.searchParams.set("q", `${trimmed} topic:agent-skills`);
    url.searchParams.set("per_page", String(options.limit ?? 20));

    let payload: unknown;
    try {
      payload = await fetchJson<unknown>(url, {
        headers: this.headers(),
        signal: options.signal,
      });
    } catch (error) {
      throw new SkillRegistryError(
        this.id,
        t("libSkills.githubSearchFailed", { message: error instanceof Error ? error.message : String(error) }),
        error,
      );
    }

    const items = asRecord(payload)?.items;
    if (!Array.isArray(items)) return [];

    return items
      .map((item): RegistrySkillSummary | null => {
        const record = asRecord(item);
        const slug = typeof record?.full_name === "string" ? record.full_name : null;
        if (!slug) return null;
        return {
          registry: "github",
          slug,
          name: typeof record?.name === "string" ? record.name : slug,
          description: typeof record?.description === "string" ? record.description : "",
          version: null,
          homepageUrl: typeof record?.html_url === "string" ? record.html_url : null,
          downloads: null,
          stars:
            typeof record?.stargazers_count === "number" ? record.stargazers_count : null,
          updatedAt: typeof record?.updated_at === "string" ? record.updated_at : null,
        };
      })
      .filter((entry): entry is RegistrySkillSummary => entry !== null);
  }

  private async readPath(
    location: GitHubSkillLocation,
    path: string,
    ref: string | null,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const url = new URL(
      `/repos/${location.owner}/${location.repo}/contents/${path}`,
      `${this.apiUrl}/`,
    );
    if (ref) url.searchParams.set("ref", ref);
    return fetchJson<unknown>(url, { headers: this.headers(), signal });
  }

  private async collectFiles(
    location: GitHubSkillLocation,
    directory: string,
    /**
     * The skill's root directory. Relative paths are computed against this and
     * not against `directory`, or a nested file would lose its subdirectory and
     * collide with one of the same name at the root.
     */
    rootDirectory: string,
    ref: string | null,
    depth: number,
    signal: AbortSignal | undefined,
    collected: RegistrySkillFile[],
  ): Promise<void> {
    if (depth > MAX_DIRECTORY_DEPTH) return;

    const listing = await this.readPath(location, directory, ref, signal);
    if (!Array.isArray(listing)) {
      throw new Error(t("libSkills.expectedDirectory", { path: directory || "/" }));
    }

    for (const raw of listing) {
      if (collected.length >= MAX_SKILL_FILE_COUNT) {
        throw new Error(
          t("libSkills.tooManySkillFiles", { max: MAX_SKILL_FILE_COUNT }),
        );
      }
      const entry = asRecord(raw) as GitHubContentEntry | null;
      if (!entry) continue;
      const entryPath = typeof entry.path === "string" ? entry.path : null;
      const entryName = typeof entry.name === "string" ? entry.name : null;
      if (!entryPath || !entryName) continue;

      const relative = rootDirectory ? entryPath.slice(rootDirectory.length + 1) : entryPath;

      if (entry.type === "dir") {
        await this.collectFiles(
          location,
          entryPath,
          rootDirectory,
          ref,
          depth + 1,
          signal,
          collected,
        );
        continue;
      }
      if (entry.type !== "file") continue;

      // The listing omits file contents, so each file is read individually.
      const fileResponse = await this.readPath(location, entryPath, ref, signal);
      const fileRecord = asRecord(fileResponse) as GitHubContentEntry | null;
      const contents = fileRecord ? decodeContent(fileRecord) : null;
      if (contents === null) continue;
      collected.push({ path: relative, contents });
    }
  }

  async fetchPackage(
    slug: string,
    version?: string | null,
    options: { signal?: AbortSignal } = {},
  ): Promise<RegistrySkillPackage> {
    let location: GitHubSkillLocation;
    try {
      location = parseGitHubSlug(slug);
    } catch (error) {
      throw new SkillRegistryError(
        this.id,
        error instanceof Error ? error.message : String(error),
        error,
      );
    }

    const ref = version?.trim() || null;
    const collected: RegistrySkillFile[] = [];
    try {
      await this.collectFiles(
        location,
        location.directory,
        location.directory,
        ref,
        0,
        options.signal,
        collected,
      );
    } catch (error) {
      throw new SkillRegistryError(
        this.id,
        t("libSkills.githubFetchFailed", { slug, message: error instanceof Error ? error.message : String(error) }),
        error,
      );
    }

    let files: RegistrySkillFile[];
    try {
      files = assertValidSkillPackageFiles(collected);
    } catch (error) {
      throw new SkillRegistryError(
        this.id,
        t("libSkills.githubSkillUnusable", { slug, message: error instanceof Error ? error.message : String(error) }),
        error,
      );
    }

    const manifest = files.find((file) => file.path === SKILL_MANIFEST_FILENAME);
    const repoSlug = `${location.owner}/${location.repo}`;
    return {
      summary: {
        registry: this.id,
        slug,
        name: location.directory.split("/").pop() || location.repo,
        description: manifest ? describeFromManifest(manifest.contents) : "",
        version: ref,
        homepageUrl: `https://github.com/${repoSlug}`,
        downloads: null,
        stars: null,
        updatedAt: null,
      },
      files,
    };
  }
}

/** Pulls `description:` out of SKILL.md frontmatter for the listing. */
const describeFromManifest = (contents: string): string => {
  const match = contents.match(/^description:\s*(.+)$/m);
  return match ? match[1].trim().replace(/^["']|["']$/g, "") : "";
};
