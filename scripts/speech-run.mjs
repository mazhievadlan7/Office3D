#!/usr/bin/env node
// `npm run speech` — starts the office's speech services for local work:
//   VoiceStudio's backend   127.0.0.1:3900  (designed voices, recognition)
//   the speech gateway      127.0.0.1:8765  (Silero; the one API Office3D calls)
// from the install scripts/speech-setup.(ps1|sh) made in OFFICE3D_SPEECH_HOME.
// Both stop together on Ctrl+C. A VoiceStudio already answering is reused.
//
// `npm run speech:check` — end-to-end check of a running gateway (Silero,
// VoiceStudio and a transcription), with timings.
//
// Servers use systemd or docker compose instead; see docs/deployment.md.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import nextEnv from "@next/env";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
nextEnv.loadEnvConfig(repoRoot, true, { info: () => {}, error: console.error });

const isWindows = process.platform === "win32";
const env = process.env;
const speechHome =
  env.OFFICE3D_SPEECH_HOME?.trim() ||
  (isWindows
    ? path.join(env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "office3d-speech")
    : path.join(env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "office3d-speech"));
const serviceDir = path.join(repoRoot, "services", "speech");
const venvPython = (venv) => path.join(venv, isWindows ? "Scripts\\python.exe" : "bin/python");
const gatewayPython = venvPython(path.join(speechHome, "gateway-venv"));
const voiceStudioDir = path.join(speechHome, "voicestudio");
const voiceStudioPython = venvPython(path.join(voiceStudioDir, ".venv"));

const gatewayUrl = new URL(env.SPEECH_GATEWAY_URL?.trim() || "http://127.0.0.1:8765");
const gatewayPort = env.SPEECH_PORT?.trim() || gatewayUrl.port || "8765";
const voiceStudioUrl = new URL(env.VOICESTUDIO_URL?.trim() || "http://127.0.0.1:3900");
const voiceStudioPort = voiceStudioUrl.port || "3900";

const fail = (message) => {
  console.error(`[speech] ${message}`);
  process.exit(1);
};

if (!existsSync(gatewayPython)) {
  fail(
    `No speech gateway in ${speechHome}. Install it first:\n` +
      (isWindows
        ? "  powershell -ExecutionPolicy Bypass -File scripts\\speech-setup.ps1"
        : "  bash scripts/speech-setup.sh") +
      "\n(or set OFFICE3D_SPEECH_HOME in .env to where it was installed)",
  );
}

if (process.argv.includes("--check")) {
  const out = path.join(os.tmpdir(), "office3d-speech-check");
  const result = spawnSync(
    gatewayPython,
    ["-m", "speech_gateway.tools", "smoke", "--url", gatewayUrl.origin, "--out", out],
    { cwd: serviceDir, stdio: "inherit", env: { ...env, PYTHONIOENCODING: "utf-8" } },
  );
  process.exit(result.status ?? 1);
}

const answers = async (url) => {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return response.ok;
  } catch {
    return false;
  }
};

const children = [];
let stopping = false;

const prefixLines = (name, stream, target) => {
  let rest = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    const lines = (rest + chunk).split(/\r?\n/);
    rest = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) target.write(`[${name}] ${line}\n`);
  });
};

const killTree = (child) => {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (isWindows) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
};

const stopAll = (code) => {
  if (stopping) return;
  stopping = true;
  for (const child of children) killTree(child);
  setTimeout(() => process.exit(code), 300);
};

const start = (name, command, args, options) => {
  const child = spawn(command, args, {
    ...options,
    env: { ...env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1", ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: !isWindows,
    windowsHide: true,
  });
  prefixLines(name, child.stdout, process.stdout);
  prefixLines(name, child.stderr, process.stderr);
  child.on("exit", (code, signal) => {
    if (stopping) return;
    console.error(`[${name}] stopped (${signal ?? `exit ${code}`}); stopping the speech services.`);
    stopAll(code || 1);
  });
  children.push(child);
  return child;
};

process.on("SIGINT", () => stopAll(0));
process.on("SIGTERM", () => stopAll(0));

const skipVoiceStudio = env.SPEECH_SKIP_VOICESTUDIO === "1";
if (skipVoiceStudio) {
  console.log("[speech] VoiceStudio skipped (SPEECH_SKIP_VOICESTUDIO=1): designed voices fall back to Silero.");
} else if (await answers(`${voiceStudioUrl.origin}/health`)) {
  console.log(`[speech] VoiceStudio already answers at ${voiceStudioUrl.origin}; using it.`);
} else if (!existsSync(voiceStudioPython)) {
  console.log(`[speech] VoiceStudio is not installed in ${voiceStudioDir}: designed voices fall back to Silero, recognition is off.`);
} else {
  const data = path.join(speechHome, "voicestudio-data");
  const hf = path.join(speechHome, "hf");
  mkdirSync(data, { recursive: true });
  mkdirSync(hf, { recursive: true });
  console.log(`[speech] starting VoiceStudio on 127.0.0.1:${voiceStudioPort}`);
  start("voicestudio", voiceStudioPython, [path.join("backend", "main.py")], {
    cwd: voiceStudioDir,
    env: {
      OMNIVOICE_DATA_DIR: data,
      HF_HOME: hf,
      OMNIVOICE_BIND_HOST: "127.0.0.1",
      OMNIVOICE_PORT: voiceStudioPort,
    },
  });
}

if (await answers(`${gatewayUrl.origin}/health`)) {
  console.log(`[speech] a speech gateway already answers at ${gatewayUrl.origin}; not starting another.`);
} else {
  console.log(`[speech] starting the speech gateway on 127.0.0.1:${gatewayPort}`);
  start("speech", gatewayPython, ["-m", "speech_gateway"], {
    cwd: serviceDir,
    env: {
      OFFICE3D_SPEECH_HOME: speechHome,
      SPEECH_HOST: "127.0.0.1",
      SPEECH_PORT: gatewayPort,
      VOICESTUDIO_URL: voiceStudioUrl.origin,
    },
  });
}

if (children.length === 0) process.exit(0);
