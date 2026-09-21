import { afterEach, describe, expect, it, vi } from "vitest";

import { ClawHubRegistry, resolveClawHubApiUrl } from "@/lib/skills/registry/clawhub";
import {
  MAX_SKILL_FILE_COUNT,
  assertSafeSkillFilePath,
  assertValidSkillPackageFiles,
} from "@/lib/skills/registry/types";

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const mockFetch = (body: unknown) => {
  const spy = vi.fn().mockResolvedValue(jsonResponse(body));
  vi.stubGlobal("fetch", spy);
  return spy;
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("skill file path validation", () => {
  it("rejects_paths_that_would_escape_the_skills_directory", () => {
    // Registry content is untrusted and these paths are joined onto a skills
    // directory, so traversal has to be refused rather than sanitised.
    for (const path of [
      "../outside.md",
      "nested/../../outside.md",
      "/etc/passwd",
      "C:\\Windows\\system32",
      "windows\\style.md",
      "..",
      "  ",
      "double//slash.md",
    ]) {
      expect(() => assertSafeSkillFilePath(path)).toThrow();
    }
  });

  it("accepts_ordinary_relative_paths", () => {
    expect(assertSafeSkillFilePath(" SKILL.md ")).toBe("SKILL.md");
    expect(assertSafeSkillFilePath("scripts/run.sh")).toBe("scripts/run.sh");
    expect(assertSafeSkillFilePath("assets/img/logo.png")).toBe("assets/img/logo.png");
  });
});

describe("skill package validation", () => {
  it("requires_a_manifest", () => {
    expect(() =>
      assertValidSkillPackageFiles([{ path: "README.md", contents: "hi" }]),
    ).toThrow(/SKILL\.md/);
  });

  it("rejects_duplicate_paths", () => {
    expect(() =>
      assertValidSkillPackageFiles([
        { path: "SKILL.md", contents: "a" },
        { path: "SKILL.md", contents: "b" },
      ]),
    ).toThrow(/more than once/);
  });

  it("rejects_a_package_with_too_many_files", () => {
    const files = Array.from({ length: MAX_SKILL_FILE_COUNT + 1 }, (_, index) => ({
      path: index === 0 ? "SKILL.md" : `file-${index}.txt`,
      contents: "x",
    }));
    expect(() => assertValidSkillPackageFiles(files)).toThrow(/over the/);
  });

  it("rejects_a_package_over_the_size_cap", () => {
    expect(() =>
      assertValidSkillPackageFiles([
        { path: "SKILL.md", contents: "x" },
        { path: "big.bin", contents: "x".repeat(3 * 1024 * 1024) },
      ]),
    ).toThrow(/over the/);
  });

  it("accepts_and_trims_a_valid_package", () => {
    expect(
      assertValidSkillPackageFiles([
        { path: " SKILL.md ", contents: "# Skill" },
        { path: "scripts/run.sh", contents: "echo hi" },
      ]),
    ).toEqual([
      { path: "SKILL.md", contents: "# Skill" },
      { path: "scripts/run.sh", contents: "echo hi" },
    ]);
  });
});

describe("resolveClawHubApiUrl", () => {
  it("defaults_to_clawhub_and_honours_an_override", () => {
    expect(resolveClawHubApiUrl({} as unknown as NodeJS.ProcessEnv)).toBe("https://clawhub.ai");
    expect(
      resolveClawHubApiUrl({ CLAWHUB_API_URL: "https://mirror.example/ " } as unknown as NodeJS.ProcessEnv),
    ).toBe("https://mirror.example");
  });
});

describe("ClawHubRegistry.search", () => {
  it("queries_the_search_endpoint_and_maps_results", async () => {
    const spy = mockFetch({
      packages: [
        {
          slug: "openclaw/pdf-tools",
          title: "PDF Tools",
          description: "Read and write PDFs.",
          version: "1.2.0",
          downloads: 4120,
          stars: 37,
        },
      ],
    });

    const results = await new ClawHubRegistry("https://registry.test").search("pdf", {
      limit: 5,
    });

    const requestedUrl = new URL(String(spy.mock.calls[0][0]));
    expect(requestedUrl.pathname).toBe("/api/v1/packages/search");
    expect(requestedUrl.searchParams.get("q")).toBe("pdf");
    expect(requestedUrl.searchParams.get("limit")).toBe("5");

    expect(results).toEqual([
      {
        registry: "clawhub",
        slug: "openclaw/pdf-tools",
        name: "PDF Tools",
        description: "Read and write PDFs.",
        version: "1.2.0",
        homepageUrl: null,
        downloads: 4120,
        stars: 37,
        updatedAt: null,
      },
    ]);
  });

  it("browses_the_catalog_when_the_query_is_empty", async () => {
    const spy = mockFetch([{ slug: "a/b" }]);
    await new ClawHubRegistry("https://registry.test").search("   ");
    expect(new URL(String(spy.mock.calls[0][0])).pathname).toBe("/api/v1/packages");
  });

  it("tolerates_alternative_field_names_and_skips_unusable_rows", async () => {
    // The published docs name the endpoints but not the field spellings, so
    // the reader accepts the plausible variants instead of trusting one.
    mockFetch({
      results: [
        { name: "alt/skill", summary: "Alt shape", latestVersion: "2.0.0", downloadCount: 9 },
        { description: "no slug, unusable" },
        "not an object",
      ],
    });

    const results = await new ClawHubRegistry("https://registry.test").search("alt");

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      slug: "alt/skill",
      description: "Alt shape",
      version: "2.0.0",
      downloads: 9,
      stars: null,
    });
  });

  it("wraps_transport_failures_in_a_registry_error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    await expect(
      new ClawHubRegistry("https://registry.test").search("x"),
    ).rejects.toThrow(/ClawHub search failed: ECONNREFUSED/);
  });
});

describe("ClawHubRegistry.fetchPackage", () => {
  it("returns_a_validated_package", async () => {
    const spy = mockFetch({
      slug: "openclaw/pdf-tools",
      version: "1.2.0",
      files: [
        { path: "SKILL.md", content: "# PDF Tools" },
        { path: "scripts/run.sh", content: "echo hi" },
      ],
    });

    const pkg = await new ClawHubRegistry("https://registry.test").fetchPackage(
      "openclaw/pdf-tools",
    );

    expect(new URL(String(spy.mock.calls[0][0])).pathname).toBe(
      "/api/v1/packages/openclaw/pdf-tools",
    );
    expect(pkg.summary.slug).toBe("openclaw/pdf-tools");
    expect(pkg.files.map((file) => file.path)).toEqual(["SKILL.md", "scripts/run.sh"]);
  });

  it("requests_a_pinned_version_when_one_is_given", async () => {
    const spy = mockFetch({ files: [{ path: "SKILL.md", content: "# x" }] });
    const pkg = await new ClawHubRegistry("https://registry.test").fetchPackage("a/b", "1.0.1");
    expect(new URL(String(spy.mock.calls[0][0])).pathname).toBe(
      "/api/v1/packages/a/b/versions/1.0.1",
    );
    expect(pkg.summary.version).toBe("1.0.1");
  });

  it("accepts_a_manifest_returned_outside_the_file_list", async () => {
    mockFetch({ slug: "a/b", skillMd: "# Inline manifest" });
    const pkg = await new ClawHubRegistry("https://registry.test").fetchPackage("a/b");
    expect(pkg.files).toEqual([{ path: "SKILL.md", contents: "# Inline manifest" }]);
  });

  it("refuses_a_package_whose_paths_would_escape_the_skills_directory", async () => {
    mockFetch({
      slug: "a/b",
      files: [
        { path: "SKILL.md", content: "# x" },
        { path: "../../../etc/cron.d/pwn", content: "* * * * * root sh" },
      ],
    });

    await expect(
      new ClawHubRegistry("https://registry.test").fetchPackage("a/b"),
    ).rejects.toThrow(/traverse directories/);
  });

  it("refuses_a_package_with_no_manifest", async () => {
    mockFetch({ slug: "a/b", files: [{ path: "README.md", content: "hi" }] });
    await expect(
      new ClawHubRegistry("https://registry.test").fetchPackage("a/b"),
    ).rejects.toThrow(/SKILL\.md/);
  });

  it("rejects_an_empty_slug", async () => {
    await expect(
      new ClawHubRegistry("https://registry.test").fetchPackage("  "),
    ).rejects.toThrow(/slug is required/);
  });
});

describe("searchSkillRegistries", () => {
  it("reports_a_failing_source_without_blanking_the_others", async () => {
    const { searchSkillRegistries } = await import("@/lib/skills/registry");
    const ok = {
      id: "github" as const,
      label: "GitHub",
      search: async () => [
        {
          registry: "github" as const,
          slug: "a/b",
          name: "b",
          description: "",
          version: null,
          homepageUrl: null,
          downloads: null,
          stars: null,
          updatedAt: null,
        },
      ],
      fetchPackage: async () => {
        throw new Error("unused");
      },
    };
    const broken = {
      id: "clawhub" as const,
      label: "ClawHub",
      search: async () => {
        throw new Error("rate limited");
      },
      fetchPackage: async () => {
        throw new Error("unused");
      },
    };

    const results = await searchSkillRegistries([broken, ok], "x");

    expect(results).toEqual([
      { registry: "clawhub", results: [], error: "rate limited" },
      { registry: "github", results: [expect.objectContaining({ slug: "a/b" })], error: null },
    ]);
  });
});
