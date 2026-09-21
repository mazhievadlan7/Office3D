import { afterEach, describe, expect, it } from "vitest";

import { GET as getCredentials } from "@/app/api/credentials/route";
import {
  CREDENTIAL_CATALOG,
  describeCredentials,
  readCredential,
} from "@/lib/credentials/catalog";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("credential catalogue", () => {
  it("declares a unique id and env var per entry", () => {
    const ids = CREDENTIAL_CATALOG.map((entry) => entry.id);
    const envVars = CREDENTIAL_CATALOG.map((entry) => entry.envVar);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(envVars).size).toBe(envVars.length);
  });

  it("contains no secret values", () => {
    // The catalogue describes where a secret lives; committing one would put
    // it in git history permanently.
    const serialized = JSON.stringify(CREDENTIAL_CATALOG);
    expect(serialized).not.toMatch(/ghp_[A-Za-z0-9]/);
    expect(serialized).not.toMatch(/sk-[A-Za-z0-9]/);
    expect(serialized).not.toMatch(/AIza[A-Za-z0-9]/);
  });

  it("reports configured state from the environment", () => {
    const withKey = describeCredentials({
      GITHUB_TOKEN: "ghp_example",
    } as unknown as NodeJS.ProcessEnv);
    expect(withKey.find((entry) => entry.id === "github-token")?.configured).toBe(true);
    expect(withKey.find((entry) => entry.id === "qwen-api-key")?.configured).toBe(false);
  });

  it("treats a blank variable as unset", () => {
    const blank = describeCredentials({
      GITHUB_TOKEN: "   ",
    } as unknown as NodeJS.ProcessEnv);
    expect(blank.find((entry) => entry.id === "github-token")?.configured).toBe(false);
  });
});

describe("readCredential", () => {
  it("returns a trimmed value and null for an unknown id", () => {
    const env = { GITHUB_TOKEN: " ghp_example " } as unknown as NodeJS.ProcessEnv;
    expect(readCredential("github-token", env)).toBe("ghp_example");
    expect(readCredential("nope", env)).toBeNull();
    expect(readCredential("qwen-api-key", env)).toBeNull();
  });
});

describe("GET /api/credentials", () => {
  it("never returns a credential value", async () => {
    process.env.GITHUB_TOKEN = "ghp_super_secret_value";

    const response = await getCredentials();
    const body = await response.json();
    const serialized = JSON.stringify(body);

    expect(serialized).not.toContain("ghp_super_secret_value");
    expect(
      body.credentials.find((entry: { id: string }) => entry.id === "github-token")
        .configured,
    ).toBe(true);
  });

  it("names the required credentials that are missing", async () => {
    delete process.env.STUDIO_ACCESS_TOKEN;

    const body = await (await getCredentials()).json();

    expect(body.missingRequired).toContain("STUDIO_ACCESS_TOKEN");
  });
});
