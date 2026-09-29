import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defaultStudioSettings, type StudioSettings } from "@/lib/studio/settings";
import {
  applyStudioSettingsPatch,
  loadStudioSettings,
  resolveStudioSettingsPath,
  saveStudioSettings,
} from "@/lib/studio/settings-store";

const makeTempDir = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));

// Only the file round-trip matters here, so a minimal office entry is enough.
const withTitle = (title: string): StudioSettings =>
  ({
    ...defaultStudioSettings(),
    office: { "ws://example.test:1": { title } },
  }) as unknown as StudioSettings;

const listTempFiles = (dir: string) => fs.readdirSync(dir).filter((name) => name.endsWith(".tmp"));

describe("studio settings store", () => {
  const originalEnv = { ...process.env };
  let tempDir: string | null = null;

  beforeEach(() => {
    delete process.env.OFFICE3D_GATEWAY_URL;
    delete process.env.OFFICE3D_GATEWAY_TOKEN;
    delete process.env.OFFICE3D_GATEWAY_ADAPTER_TYPE;
    delete process.env.HERMES_API_URL;
    delete process.env.DEMO_ADAPTER_PORT;
    tempDir = makeTempDir("studio-settings-store");
    process.env.OPENCLAW_STATE_DIR = tempDir;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("saves through a temp file + rename and leaves no temp files behind", () => {
    const settingsPath = resolveStudioSettingsPath();
    const writeSpy = vi.spyOn(fs, "writeFileSync");
    const renameSpy = vi.spyOn(fs, "renameSync");

    saveStudioSettings(withTitle("old"));
    saveStudioSettings(withTitle("new"));

    // Never written in place: every write targets a temp file in the same directory.
    for (const call of writeSpy.mock.calls) {
      const target = String(call[0]);
      expect(target).not.toBe(settingsPath);
      expect(path.dirname(target)).toBe(path.dirname(settingsPath));
    }
    expect(renameSpy).toHaveBeenCalledTimes(2);
    expect(renameSpy.mock.calls[1]?.[1]).toBe(settingsPath);

    const saved = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as StudioSettings;
    expect(saved.office?.["ws://example.test:1"]?.title).toBe("new");
    expect(listTempFiles(path.dirname(settingsPath))).toEqual([]);
  });

  it("keeps the old complete file when a save fails before the rename", () => {
    const settingsPath = resolveStudioSettingsPath();
    saveStudioSettings(withTitle("old"));
    const before = fs.readFileSync(settingsPath, "utf8");

    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      // The temp file exists at this point; the target must still hold the old content.
      expect(fs.readFileSync(settingsPath, "utf8")).toBe(before);
      throw Object.assign(new Error("disk gone"), { code: "EIO" });
    });

    expect(() => saveStudioSettings(withTitle("new"))).toThrow("disk gone");
    expect(fs.readFileSync(settingsPath, "utf8")).toBe(before);
    expect(listTempFiles(path.dirname(settingsPath))).toEqual([]);
  });

  it("falls back to missing-file defaults on a corrupt file without throwing or overwriting it", () => {
    fs.writeFileSync(
      path.join(tempDir!, "openclaw.json"),
      JSON.stringify({ gateway: { port: 18791, auth: { token: "local-token" } } }),
      "utf8"
    );
    const missing = loadStudioSettings();

    const settingsPath = resolveStudioSettingsPath();
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    const full = JSON.stringify(withTitle("half"), null, 2);
    const partial = full.slice(0, Math.floor(full.length / 2));
    fs.writeFileSync(settingsPath, partial, "utf8");

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let loaded: StudioSettings | null = null;
    expect(() => {
      loaded = loadStudioSettings();
    }).not.toThrow();
    expect(loaded).toEqual(missing);
    // Repeated reads of the same broken file are reported once.
    loadStudioSettings();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/^\[studio\] /);
    expect(fs.readFileSync(settingsPath, "utf8")).toBe(partial);
  });

  it("still throws on a settings path it cannot read (not treated as a missing file)", () => {
    const settingsPath = resolveStudioSettingsPath();
    // A directory where the file should be: reading fails with EISDIR, not a parse error.
    fs.mkdirSync(settingsPath, { recursive: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(() => loadStudioSettings()).toThrow();
    expect(warn).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")(
    "keeps the existing file's permissions and writes through a symlinked settings file",
    () => {
      const settingsPath = resolveStudioSettingsPath();
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      const realDir = fs.mkdtempSync(path.join(tempDir!, "real-"));
      const realPath = path.join(realDir, "settings.json");
      fs.writeFileSync(realPath, JSON.stringify(withTitle("old")), "utf8");
      fs.chmodSync(realPath, 0o600);
      fs.symlinkSync(realPath, settingsPath);

      saveStudioSettings(withTitle("new"));

      expect(fs.lstatSync(settingsPath).isSymbolicLink()).toBe(true);
      expect(fs.statSync(realPath).mode & 0o777).toBe(0o600);
      const saved = JSON.parse(fs.readFileSync(realPath, "utf8")) as StudioSettings;
      expect(saved.office?.["ws://example.test:1"]?.title).toBe("new");
      expect(listTempFiles(realDir)).toEqual([]);
    }
  );

  it("does not replace a corrupt file with defaults when a patch is applied", () => {
    const settingsPath = resolveStudioSettingsPath();
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, "{\"office\": {", "utf8");

    expect(() => applyStudioSettingsPatch({ office: {} })).toThrow();
    expect(fs.readFileSync(settingsPath, "utf8")).toBe("{\"office\": {");
  });
});
