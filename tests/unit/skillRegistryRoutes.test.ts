import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET as searchRegistries } from "@/app/api/skills/registry/route";
import {
  GET as listInstalled,
  POST as installSkill,
} from "@/app/api/skills/registry/install/route";

let skillsDir: string;

const base64 = (value: string) => Buffer.from(value, "utf8").toString("base64");

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** Serves a one-skill GitHub repository. */
const mockGitHubRepo = () => {
  const tree: Record<string, unknown> = {
    "": [{ type: "file", name: "SKILL.md", path: "SKILL.md" }],
    "SKILL.md": {
      type: "file",
      name: "SKILL.md",
      path: "SKILL.md",
      encoding: "base64",
      content: base64("---\nname: pdf-tools\ndescription: Read PDFs.\n---\n# Body"),
    },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const match = url.pathname.match(/^\/repos\/[^/]+\/[^/]+\/contents\/(.*)$/);
      const key = match ? match[1] : "";
      if (!(key in tree)) return json({ message: "Not Found" }, 404);
      return json(tree[key]);
    }),
  );
};

const postInstall = (body: unknown) =>
  installSkill(
    new Request("http://localhost/api/skills/registry/install", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );

beforeEach(() => {
  skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), "office3d-routes-"));
  process.env.HERMES_SKILLS_DIR = skillsDir;
});

afterEach(() => {
  fs.rmSync(skillsDir, { recursive: true, force: true });
  delete process.env.HERMES_SKILLS_DIR;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GET /api/skills/registry", () => {
  it("reports_a_failing_source_alongside_the_others_rather_than_failing", async () => {
    // One registry being unreachable must not blank the marketplace, so the
    // response is still 200 and names which source failed.
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    const response = await searchRegistries(
      new Request("http://localhost/api/skills/registry?q=pdf"),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.query).toBe("pdf");
    expect(body.results.map((entry: { registry: string }) => entry.registry).sort()).toEqual([
      "clawhub",
      "github",
    ]);
    for (const entry of body.results) {
      expect(entry.error).toMatch(/ECONNREFUSED/);
      expect(entry.results).toEqual([]);
    }
  });

  it("caps_an_oversized_limit", async () => {
    const spy = vi.fn().mockResolvedValue(json({ packages: [] }));
    vi.stubGlobal("fetch", spy);

    await searchRegistries(
      new Request("http://localhost/api/skills/registry?q=pdf&limit=9999"),
    );

    const limits = spy.mock.calls.map((call) => {
      const url = new URL(String(call[0]));
      return url.searchParams.get("limit") ?? url.searchParams.get("per_page");
    });
    expect(limits.every((value) => value === "50")).toBe(true);
  });
});

describe("POST /api/skills/registry/install", () => {
  it("fetches_a_skill_and_installs_it_for_the_requested_runtime", async () => {
    mockGitHubRepo();

    const response = await postInstall({
      registry: "github",
      slug: "owner/repo",
      runtime: "hermes",
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.installed).toMatchObject({
      skillName: "pdf-tools",
      registry: "github",
      slug: "owner/repo",
    });
    expect(fs.existsSync(path.join(skillsDir, "pdf-tools", "SKILL.md"))).toBe(true);
  });

  it("rejects_an_unknown_registry", async () => {
    const response = await postInstall({
      registry: "npm",
      slug: "a/b",
      runtime: "hermes",
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/Неизвестный реестр: npm/);
  });

  it("rejects_a_runtime_that_has_nowhere_to_install_to", async () => {
    // demo, local and custom have no skill storage; saying so beats writing
    // files nothing will ever read.
    const response = await postInstall({
      registry: "github",
      slug: "a/b",
      runtime: "demo",
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/Нельзя установить навыки в «demo»/);
  });

  it("rejects_a_missing_slug", async () => {
    const response = await postInstall({ registry: "github", runtime: "hermes" });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/Не заполнено обязательное поле: slug/);
  });

  it("reports_a_fetch_failure_as_a_client_error_and_writes_nothing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ message: "Not Found" }, 404)));

    const response = await postInstall({
      registry: "github",
      slug: "owner/missing",
      runtime: "hermes",
    });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/Не удалось получить «owner\/missing» с GitHub/);
    expect(fs.readdirSync(skillsDir)).toEqual([]);
  });
});

describe("GET /api/skills/registry/install", () => {
  it("lists_what_is_installed_for_a_runtime", async () => {
    mockGitHubRepo();
    await postInstall({ registry: "github", slug: "owner/repo", runtime: "hermes" });

    const response = await listInstalled(
      new Request("http://localhost/api/skills/registry/install?runtime=hermes"),
    );
    const body = await response.json();

    expect(body.root).toBe(skillsDir);
    expect(body.skills).toEqual([
      expect.objectContaining({ skillName: "pdf-tools", registry: "github" }),
    ]);
  });

  it("rejects_an_unknown_runtime", async () => {
    const response = await listInstalled(
      new Request("http://localhost/api/skills/registry/install?runtime=nope"),
    );
    expect(response.status).toBe(400);
  });
});
