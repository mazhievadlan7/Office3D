import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { resolveStateDir } from "@/lib/clawdbot/paths";
import {
  defaultStudioSettings,
  mergeStudioSettings,
  normalizeStudioSettings,
  type StudioGatewayAdapterType,
  type StudioGatewayProfile,
  type StudioGatewaySettings,
  type StudioSettings,
  type StudioSettingsPatch,
} from "@/lib/studio/settings";

// Studio settings are intentionally stored as a local JSON file for a single-user workflow.
// That includes gateway connection details, so treat the state directory as plaintext secret
// storage and document any changes to this threat model in README.md and SECURITY.md.
const SETTINGS_DIRNAME = "office3d";
const SETTINGS_FILENAME = "settings.json";
const OPENCLAW_CONFIG_FILENAME = "openclaw.json";
const DEFAULT_LOCAL_GATEWAY_PORT = 18789;

export const resolveStudioSettingsPath = () =>
  path.join(resolveStateDir(), SETTINGS_DIRNAME, SETTINGS_FILENAME);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object");

const buildGatewaySettings = (params: {
  adapterType: StudioGatewayAdapterType;
  url: string;
  token?: string;
  profiles?: Partial<Record<StudioGatewayAdapterType, StudioGatewayProfile>>;
}): StudioGatewaySettings => ({
  url: params.url,
  token: params.token ?? "",
  adapterType: params.adapterType,
  ...(params.profiles ? { profiles: params.profiles } : {}),
});

const buildLocalProfile = (url: string, token = ""): StudioGatewayProfile => ({ url, token });

const readOpenclawGatewayDefaults = (): StudioGatewaySettings | null => {
  try {
    const configPath = path.join(resolveStateDir(), OPENCLAW_CONFIG_FILENAME);
    if (!fs.existsSync(configPath)) return null;
    const raw = fs.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return null;
    const gateway = isRecord(parsed.gateway) ? parsed.gateway : null;
    if (!gateway) return null;
    const auth = isRecord(gateway.auth) ? gateway.auth : null;
    const token = typeof auth?.token === "string" ? auth.token.trim() : "";
    const port = typeof gateway.port === "number" && Number.isFinite(gateway.port) ? gateway.port : null;
    if (!token) return null;
    const url = port ? `ws://localhost:${port}` : `ws://localhost:${DEFAULT_LOCAL_GATEWAY_PORT}`;
    if (!url) return null;
    return buildGatewaySettings({
      adapterType: "openclaw",
      url,
      token,
      profiles: {
        openclaw: buildLocalProfile(url, token),
      },
    });
  } catch {
    return null;
  }
};

const normalizeAdapterType = (value: string | undefined): StudioGatewayAdapterType | null => {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === "openclaw" ||
    normalized === "hermes" ||
    normalized === "demo" ||
    normalized === "local" ||
    normalized === "office3d" ||
    normalized === "custom"
  ) {
    return normalized;
  }
  return null;
};

const readPortBasedGatewayProfile = (
  adapterType: Extract<StudioGatewayAdapterType, "demo">,
  envKey: "DEMO_ADAPTER_PORT"
): StudioGatewayProfile | null => {
  const rawPort = process.env[envKey]?.trim();
  if (!rawPort) return null;
  const port = Number.parseInt(rawPort, 10);
  if (!Number.isFinite(port) || port <= 0) return null;
  return buildLocalProfile(`ws://localhost:${port}`);
};

const toWebSocketUrl = (value: string | undefined): string | null => {
  const raw = value?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
};

const buildEnvGatewayDefaults = (): StudioGatewaySettings | null => {
  const envUrl = process.env.OFFICE3D_GATEWAY_URL?.trim();
  const envToken = process.env.OFFICE3D_GATEWAY_TOKEN?.trim() ?? "";
  // HERMES_API_URL means this server runs the Hermes adapter itself, which
  // makes Hermes the default backend. The profile URL is then only a label:
  // the gateway proxy routes Hermes to the in-process adapter whatever it says.
  const inProcessHermesUrl = toWebSocketUrl(process.env.HERMES_API_URL);
  const envAdapterType =
    normalizeAdapterType(process.env.OFFICE3D_GATEWAY_ADAPTER_TYPE) ??
    (inProcessHermesUrl ? "hermes" : "openclaw");

  const hermesProfile = inProcessHermesUrl ? buildLocalProfile(inProcessHermesUrl) : null;
  const demoProfile = readPortBasedGatewayProfile("demo", "DEMO_ADAPTER_PORT");

  const profiles: Partial<Record<StudioGatewayAdapterType, StudioGatewayProfile>> = {};
  if (hermesProfile) profiles.hermes = hermesProfile;
  if (demoProfile) profiles.demo = demoProfile;

  if (envUrl) {
    profiles[envAdapterType] = buildLocalProfile(envUrl, envToken);
    return buildGatewaySettings({
      adapterType: envAdapterType,
      url: envUrl,
      token: envToken,
      profiles,
    });
  }

  const fallbackProfile = profiles.hermes ?? profiles.demo ?? null;
  if (!fallbackProfile) return null;
  const fallbackAdapterType = profiles.hermes ? "hermes" : "demo";
  return buildGatewaySettings({
    adapterType: fallbackAdapterType,
    url: fallbackProfile.url,
    token: fallbackProfile.token,
    profiles,
  });
};

const mergeGatewayProfiles = (
  base: StudioGatewaySettings,
  extra: StudioGatewaySettings | null
): StudioGatewaySettings => {
  if (!extra?.profiles) {
    return base;
  }
  const mergedProfiles: Partial<Record<StudioGatewayAdapterType, StudioGatewayProfile>> = {
    ...(base.profiles ?? {}),
  };
  for (const [adapterType, profile] of Object.entries(extra.profiles) as Array<
    [StudioGatewayAdapterType, StudioGatewayProfile | undefined]
  >) {
    if (!profile || mergedProfiles[adapterType]) {
      continue;
    }
    mergedProfiles[adapterType] = profile;
  }
  return {
    ...base,
    profiles: mergedProfiles,
  };
};

export const loadLocalGatewayDefaults = (): StudioGatewaySettings | null => {
  const fromFile = readOpenclawGatewayDefaults();
  const fromEnv = buildEnvGatewayDefaults();
  if (fromEnv) {
    return mergeGatewayProfiles(fromEnv, fromFile);
  }
  if (fromFile) {
    return fromFile;
  }
  // No local defaults exist in either source.
  return null;
};

const buildMissingFileSettings = (): StudioSettings => {
  const defaults = defaultStudioSettings();
  const gateway = loadLocalGatewayDefaults();
  return gateway ? { ...defaults, gateway } : defaults;
};

// Remembers which unreadable file version was already reported so frequent
// polling of a corrupt settings file logs one line, not one per request.
let lastReportedUnreadableSettings: string | null = null;

const reportUnreadableSettings = (settingsPath: string, err: unknown) => {
  let signature = settingsPath;
  try {
    const stat = fs.statSync(settingsPath);
    signature = `${settingsPath}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    // Keep the path-only signature.
  }
  if (signature === lastReportedUnreadableSettings) return;
  lastReportedUnreadableSettings = signature;
  const reason = err instanceof Error ? err.message : String(err);
  console.warn(
    `[studio] settings file ${settingsPath} is unreadable (${reason}); using defaults without overwriting it.`
  );
};

/**
 * Reads and parses the settings file. Returns `{ found: false }` when the file
 * does not exist. With `strict`, a partial/corrupt file throws (callers that
 * would write the result back must not replace the user's file with defaults);
 * otherwise it is treated exactly like a missing file. Other I/O errors
 * (permissions, a locked file, ...) still throw as before: silently falling
 * back to defaults there could point callers at the wrong gateway.
 */
const readStudioSettingsFile = (
  settingsPath: string,
  strict: boolean
): { found: false } | { found: true; parsed: unknown } => {
  if (!fs.existsSync(settingsPath)) return { found: false };
  let raw: string;
  try {
    raw = fs.readFileSync(settingsPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code === "ENOENT") return { found: false };
    throw err;
  }
  try {
    return { found: true, parsed: JSON.parse(raw) as unknown };
  } catch (err) {
    if (strict) throw err;
    reportUnreadableSettings(settingsPath, err);
    return { found: false };
  }
};

const loadStudioSettingsInternal = (strict: boolean): StudioSettings => {
  const settingsPath = resolveStudioSettingsPath();
  const file = readStudioSettingsFile(settingsPath, strict);
  if (!file.found) {
    return buildMissingFileSettings();
  }
  const parsed = file.parsed;
  const settings = normalizeStudioSettings(parsed);
  if (!settings.gateway?.token) {
    const gateway = loadLocalGatewayDefaults();
    if (gateway) {
      return {
        ...settings,
        gateway: settings.gateway?.url?.trim()
          ? {
              url: settings.gateway.url.trim(),
              token: gateway.token,
              adapterType: settings.gateway.adapterType,
            }
          : gateway,
      };
    }
  }
  return settings;
};

/**
 * Loads settings for readers. A partial or corrupt settings file is treated
 * exactly like a missing one (defaults + local gateway defaults) and is never
 * rewritten here.
 */
export const loadStudioSettings = (): StudioSettings => loadStudioSettingsInternal(false);

// Windows can briefly refuse to replace a file another process (editor,
// antivirus, a concurrent reader) holds open. These codes are transient there.
const TRANSIENT_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const RENAME_RETRY_DELAYS_MS = [10, 25, 50];

const sleepSync = (ms: number) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

const renameOverExisting = (from: string, to: string) => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      // renameSync replaces an existing target on POSIX and on Windows
      // (MoveFileEx with MOVEFILE_REPLACE_EXISTING), so readers observe either
      // the old or the new complete file, never a partial one.
      fs.renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      const delay = RENAME_RETRY_DELAYS_MS[attempt];
      if (process.platform !== "win32" || !code || !TRANSIENT_RENAME_CODES.has(code) || delay === undefined) {
        throw err;
      }
      sleepSync(delay);
    }
  }
};

export const saveStudioSettings = (next: StudioSettings) => {
  const settingsPath = resolveStudioSettingsPath();
  const dir = path.dirname(settingsPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  // The old in-place write followed a symlinked settings.json and kept the
  // file's permissions (it holds the gateway token). Keep both: replace the
  // real file, and give the replacement the existing file's mode.
  let targetPath = settingsPath;
  let existingMode: number | null = null;
  try {
    targetPath = fs.realpathSync(settingsPath);
    existingMode = fs.statSync(targetPath).mode & 0o777;
  } catch {
    // No existing file yet: write a new one at the configured path.
  }
  // Write to a temp file in the same directory, then rename over the target,
  // so a concurrent read or an interrupted write never sees a half-written file.
  const tmpPath = path.join(path.dirname(targetPath), `.settings-${crypto.randomUUID()}.tmp`);
  try {
    // POSIX permission bits only; on Windows they map to a read-only flag that
    // would make the temp file impossible to rename or clean up.
    const posixMode = existingMode !== null && process.platform !== "win32" ? existingMode : null;
    fs.writeFileSync(tmpPath, JSON.stringify(next, null, 2), {
      encoding: "utf8",
      mode: posixMode ?? 0o666,
    });
    if (posixMode !== null) {
      // The create mode is masked by the umask; set the old bits exactly.
      fs.chmodSync(tmpPath, posixMode);
    }
    renameOverExisting(tmpPath, targetPath);
  } catch (error) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // Best-effort cleanup.
    }
    throw error;
  }
};

export const applyStudioSettingsPatch = (patch: StudioSettingsPatch): StudioSettings => {
  // Strict read: if the existing file is unreadable, fail instead of replacing
  // the user's file with defaults + patch.
  const current = loadStudioSettingsInternal(true);
  const next = mergeStudioSettings(current, patch);
  saveStudioSettings(next);
  return next;
};
