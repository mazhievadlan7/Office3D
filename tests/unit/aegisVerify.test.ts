import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { CHALLENGE_PREFIX, createVerifier, tokenFor } from "../../server/aegis/verify.js";

const dirs: string[] = [];
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aegis-verify-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch {
      // best effort
    }
  }
});

const domainAsset = { id: "ast-1", kind: "domain", value: "example.com" };
const cidrAsset = { id: "ast-2", kind: "cidr", value: "10.0.0.0/24" };
const urlAsset = { id: "ast-3", kind: "url", value: "example.com", host: "example.com", isIpHost: false };

describe("AEGIS ownership tokens", () => {
  it("are per-engagement, stable across restarts, and unguessable per engagement", () => {
    const dir = tmp();
    const a = createVerifier({ dataDir: dir });
    const b = createVerifier({ dataDir: dir }); // same install → same secret
    expect(a.token("eng_1")).toBe(b.token("eng_1"));
    expect(a.token("eng_1")).not.toBe(a.token("eng_2"));
    expect(a.challenge("eng_1")).toBe(CHALLENGE_PREFIX + a.token("eng_1"));

    const other = createVerifier({ dataDir: tmp() }); // a different install → a different secret
    expect(other.token("eng_1")).not.toBe(a.token("eng_1"));
  });

  it("derives the token by HMAC over the engagement id", () => {
    expect(tokenFor("secret", "eng_1")).toBe(tokenFor("secret", "eng_1"));
    expect(tokenFor("secret", "eng_1")).not.toBe(tokenFor("secret", "eng_2"));
    expect(tokenFor("secret-a", "eng_1")).not.toBe(tokenFor("secret-b", "eng_1"));
  });
});

describe("AEGIS DNS TXT ownership proof", () => {
  it("passes only when the token is in a TXT record on the domain", async () => {
    const dir = tmp();
    const token = createVerifier({ dataDir: dir }).token("eng_1");
    const resolveTxt = async (name: string) =>
      name === "example.com" ? [["v=spf1 -all"], [`${CHALLENGE_PREFIX}${token}`]] : [];
    const verifier = createVerifier({ dataDir: dir, resolveTxt });
    const ok = await verifier.check({ engagementId: "eng_1", method: "dns", asset: domainAsset });
    expect(ok.ok).toBe(true);

    const miss = createVerifier({ dataDir: dir, resolveTxt: async () => [["nothing here"]] });
    expect((await miss.check({ engagementId: "eng_1", method: "dns", asset: domainAsset })).ok).toBe(false);
  });

  it("also accepts the token on the _aegis-challenge subdomain", async () => {
    const dir = tmp();
    const token = createVerifier({ dataDir: dir }).token("eng_1");
    const resolveTxt = async (name: string) =>
      name === "_aegis-challenge.example.com" ? [[`${CHALLENGE_PREFIX}${token}`]] : [];
    const verifier = createVerifier({ dataDir: dir, resolveTxt });
    expect((await verifier.check({ engagementId: "eng_1", method: "dns", asset: domainAsset })).ok).toBe(true);
  });

  it("does not apply DNS to a CIDR range", async () => {
    const verifier = createVerifier({ dataDir: tmp(), resolveTxt: async () => [] });
    const result = await verifier.check({ engagementId: "eng_1", method: "dns", asset: cidrAsset });
    expect(result.ok).toBe(false);
  });
});

describe("AEGIS well-known file ownership proof", () => {
  it("passes when the token is served at /.well-known and falls back http→ only on failure", async () => {
    const dir = tmp();
    const token = createVerifier({ dataDir: dir }).token("eng_1");
    const seen: string[] = [];
    const fetchFile = async (url: string) => {
      seen.push(url);
      return url.startsWith("https://") ? { ok: true, body: `${CHALLENGE_PREFIX}${token}\n` } : { ok: false, status: 404 };
    };
    const verifier = createVerifier({ dataDir: dir, fetchFile });
    const result = await verifier.check({ engagementId: "eng_1", method: "file", asset: urlAsset });
    expect(result.ok).toBe(true);
    expect(seen[0]).toBe("https://example.com/.well-known/aegis-challenge.txt");
  });

  it("fails when the file has the wrong token", async () => {
    const dir = tmp();
    const verifier = createVerifier({ dataDir: dir, fetchFile: async () => ({ ok: true, body: "aegis-verify=wrong" }) });
    expect((await verifier.check({ engagementId: "eng_1", method: "file", asset: domainAsset })).ok).toBe(false);
  });
});

describe("AEGIS WHOIS is informational, not proof", () => {
  it("returns registrar/org context and is flagged informational", async () => {
    const whois = async () => ({ ok: true, text: "Registrar: Example Registrar LLC\nRegistrant Organization: Acme Inc\n" });
    const verifier = createVerifier({ dataDir: tmp(), whois });
    const result = await verifier.check({ engagementId: "eng_1", method: "whois", asset: domainAsset });
    expect(result.ok).toBe(true);
    expect(result.informational).toBe(true);
    const detail = result.detail as { registrar?: string; org?: string };
    expect(detail.registrar).toBe("Example Registrar LLC");
    expect(detail.org).toBe("Acme Inc");
  });
});
