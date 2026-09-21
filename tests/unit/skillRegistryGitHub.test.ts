import { afterEach, describe, expect, it, vi } from "vitest";

import { GitHubSkillRegistry, parseGitHubSlug } from "@/lib/skills/registry/github";

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const base64 = (value: string) => Buffer.from(value, "utf8").toString("base64");

/** Serves a fake repository tree keyed by contents API path. */
const mockRepo = (byPath: Record<string, unknown>) => {
  const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    void init;
    const url = new URL(String(input));
    const match = url.pathname.match(/^\/repos\/[^/]+\/[^/]+\/contents\/(.*)$/);
    const path = match ? match[1] : "";
    if (!(path in byPath)) {
      return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    }
    return json(byPath[path]);
  });
  vi.stubGlobal("fetch", spy);
  return spy;
};

const file = (path: string, contents: string) => ({
  type: "file",
  name: path.split("/").pop(),
  path,
  content: base64(contents),
  encoding: "base64",
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("parseGitHubSlug", () => {
  it("parses_repo_and_subdirectory_forms", () => {
    expect(parseGitHubSlug("owner/repo")).toEqual({
      owner: "owner",
      repo: "repo",
      directory: "",
    });
    expect(parseGitHubSlug("owner/repo/skills/pdf")).toEqual({
      owner: "owner",
      repo: "repo",
      directory: "skills/pdf",
    });
  });

  it("accepts_a_pasted_github_url_and_drops_the_tree_ref", () => {
    // A URL copied from the GitHub UI carries "tree/<branch>"; the ref belongs
    // in the version argument, not in the directory path.
    expect(parseGitHubSlug("https://github.com/owner/repo/tree/main/skills/pdf")).toEqual({
      owner: "owner",
      repo: "repo",
      directory: "skills/pdf",
    });
    expect(parseGitHubSlug("https://github.com/owner/repo.git")).toEqual({
      owner: "owner",
      repo: "repo",
      directory: "",
    });
  });

  it("rejects_a_slug_without_a_repository", () => {
    expect(() => parseGitHubSlug("owner")).toThrow(/owner\/repo/);
  });
});

describe("GitHubSkillRegistry.fetchPackage", () => {
  it("collects_a_skill_directory_and_reads_its_description", async () => {
    mockRepo({
      "skills/pdf": [
        { type: "file", name: "SKILL.md", path: "skills/pdf/SKILL.md" },
        { type: "file", name: "run.sh", path: "skills/pdf/run.sh" },
      ],
      "skills/pdf/SKILL.md": file(
        "skills/pdf/SKILL.md",
        "---\nname: pdf\ndescription: Read and write PDFs.\n---\n",
      ),
      "skills/pdf/run.sh": file("skills/pdf/run.sh", "echo hi"),
    });

    const pkg = await new GitHubSkillRegistry("https://api.test", null).fetchPackage(
      "owner/repo/skills/pdf",
    );

    expect(pkg.files).toEqual([
      {
        path: "SKILL.md",
        contents: "---\nname: pdf\ndescription: Read and write PDFs.\n---\n",
      },
      { path: "run.sh", contents: "echo hi" },
    ]);
    expect(pkg.summary).toMatchObject({
      registry: "github",
      name: "pdf",
      description: "Read and write PDFs.",
      homepageUrl: "https://github.com/owner/repo",
    });
  });

  it("pins_the_requested_ref_on_every_request", async () => {
    const spy = mockRepo({
      "": [{ type: "file", name: "SKILL.md", path: "SKILL.md" }],
      "SKILL.md": file("SKILL.md", "# x"),
    });

    const pkg = await new GitHubSkillRegistry("https://api.test", null).fetchPackage(
      "owner/repo",
      "v1.2.0",
    );

    for (const call of spy.mock.calls) {
      expect(new URL(String(call[0])).searchParams.get("ref")).toBe("v1.2.0");
    }
    expect(pkg.summary.version).toBe("v1.2.0");
  });

  it("descends_into_nested_directories", async () => {
    mockRepo({
      "": [
        { type: "file", name: "SKILL.md", path: "SKILL.md" },
        { type: "dir", name: "scripts", path: "scripts" },
      ],
      "SKILL.md": file("SKILL.md", "# x"),
      scripts: [{ type: "file", name: "run.sh", path: "scripts/run.sh" }],
      "scripts/run.sh": file("scripts/run.sh", "echo nested"),
    });

    const pkg = await new GitHubSkillRegistry("https://api.test", null).fetchPackage(
      "owner/repo",
    );

    expect(pkg.files.map((entry) => entry.path)).toEqual(["SKILL.md", "scripts/run.sh"]);
  });

  it("refuses_a_directory_without_a_manifest", async () => {
    mockRepo({
      "": [{ type: "file", name: "README.md", path: "README.md" }],
      "README.md": file("README.md", "hi"),
    });

    await expect(
      new GitHubSkillRegistry("https://api.test", null).fetchPackage("owner/repo"),
    ).rejects.toThrow(/SKILL\.md/);
  });

  it("reports_a_missing_repository_rather_than_returning_nothing", async () => {
    mockRepo({});
    await expect(
      new GitHubSkillRegistry("https://api.test", null).fetchPackage("owner/missing"),
    ).rejects.toThrow(/GitHub fetch of "owner\/missing" failed/);
  });

  it("sends_the_token_only_when_one_is_configured", async () => {
    const tree = {
      "": [{ type: "file", name: "SKILL.md", path: "SKILL.md" }],
      "SKILL.md": file("SKILL.md", "# x"),
    };

    const anonymous = mockRepo(tree);
    await new GitHubSkillRegistry("https://api.test", null).fetchPackage("owner/repo");
    const anonHeaders = (anonymous.mock.calls[0][1] as RequestInit).headers as Record<
      string,
      string
    >;
    expect(anonHeaders.Authorization).toBeUndefined();

    const authorised = mockRepo(tree);
    await new GitHubSkillRegistry("https://api.test", "ghp_x").fetchPackage("owner/repo");
    const authHeaders = (authorised.mock.calls[0][1] as RequestInit).headers as Record<
      string,
      string
    >;
    expect(authHeaders.Authorization).toBe("Bearer ghp_x");
  });
});

describe("GitHubSkillRegistry.search", () => {
  it("scopes_the_query_to_agent_skill_repositories", async () => {
    const spy = vi.fn().mockResolvedValue(
      json({
        items: [
          {
            full_name: "owner/pdf-skill",
            name: "pdf-skill",
            description: "PDF helpers",
            html_url: "https://github.com/owner/pdf-skill",
            stargazers_count: 12,
            updated_at: "2026-01-02T03:04:05Z",
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", spy);

    const results = await new GitHubSkillRegistry("https://api.test", null).search("pdf", {
      limit: 5,
    });

    const url = new URL(String(spy.mock.calls[0][0]));
    expect(url.pathname).toBe("/search/repositories");
    expect(url.searchParams.get("q")).toBe("pdf topic:agent-skills");
    expect(url.searchParams.get("per_page")).toBe("5");

    expect(results).toEqual([
      {
        registry: "github",
        slug: "owner/pdf-skill",
        name: "pdf-skill",
        description: "PDF helpers",
        version: null,
        homepageUrl: "https://github.com/owner/pdf-skill",
        downloads: null,
        stars: 12,
        updatedAt: "2026-01-02T03:04:05Z",
      },
    ]);
  });

  it("returns_nothing_for_an_empty_query_without_calling_github", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    expect(await new GitHubSkillRegistry("https://api.test", null).search("  ")).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});
