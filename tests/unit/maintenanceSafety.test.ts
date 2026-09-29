// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const safety = await import("../../server/maintenance/safety.js");
const { allowHttpOrigin } = await import("../../server/request-guard.js");

const fsp = fs.promises;

describe("maintenance safety: names and deny list", () => {
  it("rejects anything that is not a plain name", () => {
    for (const name of ["", ".", "..", "../x", "a/b", "a\\b", "c:x", "a\u0000b", "x".repeat(256)]) {
      expect(safety.checkName({ name, regex: /.*/ })).toBe("bad-name");
    }
  });

  it("rejects a regex mismatch", () => {
    expect(safety.checkName({ name: "trace.old", regex: /^trace$/ })).toBe("no-match");
    expect(safety.checkName({ name: "trace", regex: /^trace$/ })).toBeNull();
  });

  it("rejects every deny-listed name even when the pattern matches", () => {
    const names = [
      "settings.json",
      "SETTINGS.JSON",
      "tasks.json",
      "state.json",
      "runs.jsonl",
      "node_modules",
      "cache",
      "public",
      "blender",
      "uploads",
      "trash",
      "aegis",
      "hermes",
      "maintenance",
      ".git",
      ".env",
      ".env.local",
      "settings.json.corrupt-1700000000",
      "tasks.corrupt",
    ];
    for (const name of names) {
      expect(safety.checkName({ name, regex: /.*/ }), name).toBe("denied");
    }
  });

  it("rejects a deny-listed folder on the way from the anchor", () => {
    expect(safety.checkName({ name: "x.hot-update.js", regex: /.*/, anchorSegments: [".next", "dev", "cache"] })).toBe("denied");
    expect(safety.checkName({ name: "x.tmp", regex: /.*/, anchorSegments: ["node_modules", "pkg"] })).toBe("denied");
    expect(safety.checkName({ name: "x.hot-update.js", regex: /.*/, anchorSegments: [".next", "dev", "static", "webpack"] })).toBeNull();
  });

  it("refuses file-system roots and the home directory as roots", () => {
    expect(safety.isDangerousRoot(path.parse(process.cwd()).root, os.homedir())).toBe(true);
    expect(safety.isDangerousRoot(os.homedir(), os.homedir())).toBe(true);
    expect(safety.isDangerousRoot(path.join(os.homedir(), "x"), os.homedir())).toBe(false);
  });
});

describe("maintenance safety: the file system", () => {
  let base: string;
  let root: string;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "maint-safety-"));
    root = path.join(base, "root");
    fs.mkdirSync(root);
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("resolves a real root and refuses a missing one, the home dir and a file", async () => {
    const real = await safety.resolveRoot(fsp, root);
    expect(real && safety.samePath(real, fs.realpathSync(root))).toBe(true);
    expect(await safety.resolveRoot(fsp, path.join(base, "missing"))).toBeNull();
    expect(await safety.resolveRoot(fsp, os.homedir())).toBeNull();
    fs.writeFileSync(path.join(base, "file"), "x");
    expect(await safety.resolveRoot(fsp, path.join(base, "file"))).toBeNull();
  });

  it("passes a plain file inside the root", async () => {
    fs.writeFileSync(path.join(root, "trace"), "abc");
    const realRoot = fs.realpathSync(root);
    const check = await safety.checkItem(fsp, { realRoot, name: "trace", regex: /^trace$/, expect: "file" });
    expect(check.ok).toBe(true);
  });

  it("rejects paths outside the root and '..'", async () => {
    fs.writeFileSync(path.join(base, "outside"), "x");
    const realRoot = fs.realpathSync(root);
    const check = await safety.checkItem(fsp, { realRoot, name: "../outside", regex: /.*/, expect: "file" });
    expect(check).toEqual({ ok: false, reason: "bad-name" });
  });

  it("rejects a root reached through a junction (the parent's real path differs)", async () => {
    const target = path.join(base, "elsewhere");
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "trace"), "x");
    const link = path.join(base, "linked-root");
    fs.symlinkSync(target, link, "junction");
    const check = await safety.checkItem(fsp, { realRoot: link, name: "trace", regex: /^trace$/, expect: "file" });
    expect(check).toEqual({ ok: false, reason: "outside-root" });
  });

  it("rejects a junction inside the root", async () => {
    const target = path.join(base, "elsewhere");
    fs.mkdirSync(target);
    fs.symlinkSync(target, path.join(root, "office3d-test-abc123"), "junction");
    const realRoot = fs.realpathSync(root);
    const check = await safety.checkItem(fsp, { realRoot, name: "office3d-test-abc123", regex: /.*/, expect: "dir" });
    expect(check).toEqual({ ok: false, reason: "link" });
  });

  it("rejects a file symlink (skipped without the privilege to make one)", async (ctx) => {
    const target = path.join(base, "real.tmp");
    fs.writeFileSync(target, "x");
    try {
      fs.symlinkSync(target, path.join(root, "linked.tmp"), "file");
    } catch {
      ctx.skip();
      return;
    }
    const realRoot = fs.realpathSync(root);
    const check = await safety.checkItem(fsp, { realRoot, name: "linked.tmp", regex: /.*/, expect: "file" });
    expect(check).toEqual({ ok: false, reason: "link" });
  });

  it("rejects the wrong type, a failed rule and a replaced file", async () => {
    fs.mkdirSync(path.join(root, "trace"));
    fs.writeFileSync(path.join(root, "log.log"), "abc");
    const realRoot = fs.realpathSync(root);
    expect(await safety.checkItem(fsp, { realRoot, name: "trace", regex: /.*/, expect: "file" })).toEqual({
      ok: false,
      reason: "wrong-type",
    });
    expect(
      await safety.checkItem(fsp, { realRoot, name: "log.log", regex: /.*/, expect: "file", accept: (s) => s.size > 10 })
    ).toEqual({ ok: false, reason: "rule" });
    const first = fs.lstatSync(path.join(root, "log.log"));
    fs.rmSync(path.join(root, "log.log"));
    // Another file under the same name.
    fs.writeFileSync(path.join(root, "other"), "zzz");
    fs.writeFileSync(path.join(root, "log.log"), "abc");
    const second = await safety.checkItem(fsp, { realRoot, name: "log.log", regex: /.*/, expect: "file", previous: first });
    if (String(first.ino) !== String(fs.lstatSync(path.join(root, "log.log")).ino) && first.ino) {
      expect(second).toEqual({ ok: false, reason: "replaced" });
    }
  });

  it("rejects a deny-listed name inside a matching root", async () => {
    fs.writeFileSync(path.join(root, "settings.json"), "{}");
    const realRoot = fs.realpathSync(root);
    const check = await safety.checkItem(fsp, { realRoot, name: "settings.json", regex: /.*/, expect: "file" });
    expect(check).toEqual({ ok: false, reason: "denied" });
  });
});

describe("allowHttpOrigin", () => {
  it("passes same-origin requests and nothing else", () => {
    expect(allowHttpOrigin({ headers: { "sec-fetch-site": "same-origin" } })).toBe(true);
    expect(allowHttpOrigin({ headers: { "sec-fetch-site": "cross-site", origin: "http://localhost:3000", host: "localhost:3000" } })).toBe(false);
    expect(allowHttpOrigin({ headers: { "sec-fetch-site": "same-site" } })).toBe(false);
    expect(allowHttpOrigin({ headers: { origin: "http://localhost:3000", host: "localhost:3000" } })).toBe(true);
    expect(allowHttpOrigin({ headers: { origin: "https://office.example.com", host: "office.example.com" } })).toBe(true);
    expect(allowHttpOrigin({ headers: { origin: "http://evil.test", host: "localhost:3000" } })).toBe(false);
    expect(allowHttpOrigin({ headers: { origin: "null", host: "localhost:3000" } })).toBe(false);
    expect(allowHttpOrigin({ headers: { host: "localhost:3000" } })).toBe(false);
    expect(allowHttpOrigin({ headers: {} })).toBe(false);
  });
});
