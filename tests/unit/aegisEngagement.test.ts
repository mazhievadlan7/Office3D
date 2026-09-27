import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const { createAegisStore } = await import("../../server/aegis/store.js");
const { createEngagementManager } = await import("../../server/aegis/engagement.js");

let dir: string;
const makeManager = () => {
  const store = createAegisStore({ filePath: path.join(dir, "state.json") });
  return { manager: createEngagementManager({ store }), store };
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "aegis-eng-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("AEGIS engagement lifecycle", () => {
  it("walks draft → authorized → active only with the customer's manual activation", async () => {
    const { manager } = makeManager();
    const eng = await manager.create({ name: "Аудит своих активов" });
    expect(eng.status).toBe("draft");

    // cannot authorize with no assets
    await expect(manager.recordAuthorization(eng.id, { letterRef: "L-1", signer: "Заказчик" })).rejects.toMatchObject({ code: "INVALID_INPUT" });

    await manager.addAsset(eng.id, { kind: "domain", value: "example.com", includeSubdomains: true });

    // cannot activate before authorization
    await expect(manager.activate(eng.id, { by: "Адлан", confirm: true })).rejects.toMatchObject({ code: "CONFLICT" });

    const authorized = await manager.recordAuthorization(eng.id, { letterRef: "L-1", signer: "Заказчик" });
    expect(authorized.status).toBe("authorized");

    // activation requires an explicit confirm
    await expect(manager.activate(eng.id, { by: "Адлан", confirm: false })).rejects.toMatchObject({ code: "INVALID_INPUT" });

    const active = await manager.activate(eng.id, { by: "Адлан", confirm: true });
    expect(active.status).toBe("active");
    expect(active.activation).toMatchObject({ by: "Адлан" });
    expect(manager.actionable(eng.id).ok).toBe(true);
  });

  it("forbids adding assets outside draft", async () => {
    const { manager } = makeManager();
    const eng = await manager.create({ name: "e" });
    await manager.addAsset(eng.id, { kind: "ip", value: "203.0.113.9" });
    await manager.recordAuthorization(eng.id, { letterRef: "L", signer: "S" });
    await expect(manager.addAsset(eng.id, { kind: "ip", value: "203.0.113.10" })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("stops and reactivates, and the kill-switch overrides everything", async () => {
    const { manager } = makeManager();
    const eng = await manager.create({ name: "e" });
    await manager.addAsset(eng.id, { kind: "domain", value: "example.com" });
    await manager.recordAuthorization(eng.id, { letterRef: "L", signer: "S" });
    await manager.activate(eng.id, { by: "A", confirm: true });

    await manager.stop(eng.id, { by: "A", reason: "пауза" });
    expect(manager.actionable(eng.id).ok).toBe(false);

    await manager.reactivate(eng.id, { by: "A" });
    expect(manager.actionable(eng.id).ok).toBe(true);

    await manager.setGlobalKill({ on: true, by: "A", reason: "стоп всё" });
    expect(manager.actionable(eng.id)).toMatchObject({ ok: false });
    await manager.setGlobalKill({ on: false, by: "A" });
    expect(manager.actionable(eng.id).ok).toBe(true);
  });

  it("persists across a reload", async () => {
    const first = makeManager();
    const eng = await first.manager.create({ name: "persist" });
    await first.manager.addAsset(eng.id, { kind: "domain", value: "example.com" });
    await first.store.flush();

    const second = makeManager();
    const reloaded = second.manager.get(eng.id);
    expect(reloaded?.name).toBe("persist");
    expect(reloaded?.assets).toHaveLength(1);
  });
});
