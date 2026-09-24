import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const { createAuditLog } = await import("../../server/aegis/audit.js");

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "aegis-audit-"));
  file = path.join(dir, "audit.jsonl");
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("AEGIS audit ledger", () => {
  it("hash-chains entries and verifies clean", async () => {
    const log = createAuditLog({ filePath: file });
    log.append({ type: "preflight", engagementId: "e1", decision: "allow", reason: "ok" });
    log.append({ type: "preflight", engagementId: "e1", decision: "deny", reason: "out of scope" });
    log.append({ type: "engagement.activated", engagementId: "e1", detail: { by: "A" } });
    await log.flush();

    const verdict = log.verify();
    expect(verdict).toMatchObject({ ok: true, count: 3 });
  });

  it("detects a tampered entry", async () => {
    const log = createAuditLog({ filePath: file });
    log.append({ type: "preflight", engagementId: "e1", decision: "deny", reason: "out of scope" });
    log.append({ type: "preflight", engagementId: "e1", decision: "deny", reason: "out of scope" });
    await log.flush();

    // Flip a recorded decision from deny to allow directly in the file.
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    const forged = JSON.parse(lines[0]);
    forged.decision = "allow";
    lines[0] = JSON.stringify(forged);
    fs.writeFileSync(file, lines.join("\n") + "\n");

    const verdict = createAuditLog({ filePath: file }).verify();
    expect(verdict.ok).toBe(false);
    expect(verdict.brokenAt).toBe(1);
  });

  it("detects a removed entry", async () => {
    const log = createAuditLog({ filePath: file });
    log.append({ type: "e", engagementId: "e1" });
    log.append({ type: "e", engagementId: "e1" });
    log.append({ type: "e", engagementId: "e1" });
    await log.flush();

    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    lines.splice(1, 1); // remove the middle entry
    fs.writeFileSync(file, lines.join("\n") + "\n");

    expect(createAuditLog({ filePath: file }).verify().ok).toBe(false);
  });

  it("continues the chain across a reload and filters by engagement", async () => {
    const first = createAuditLog({ filePath: file });
    first.append({ type: "e", engagementId: "e1" });
    await first.flush();

    const second = createAuditLog({ filePath: file });
    second.append({ type: "e", engagementId: "e2" });
    second.append({ type: "e", engagementId: "e1" });
    await second.flush();

    expect(second.verify()).toMatchObject({ ok: true, count: 3 });
    expect(second.list({ engagementId: "e1" })).toHaveLength(2);
    expect(second.list({ engagementId: "e2" })).toHaveLength(1);
  });
});
