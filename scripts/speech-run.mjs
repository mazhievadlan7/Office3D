#!/usr/bin/env node
// `npm run speech` — starts the office's speech gateway for local work on
// 127.0.0.1:8765 (Silero voices and GigaAM recognition, all on the CPU: the
// GPU stays free for the HQ's 3D), from the install scripts/speech-setup.(ps1|sh)
// made in OFFICE3D_SPEECH_HOME. Stops on Ctrl+C.
//
// `npm run speech:check` — end-to-end check of a running gateway (the system's
// and AM7's voices and a transcription), with timings.
//
// Servers use systemd or docker compose instead; see docs/deployment.md.

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
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

const gatewayUrl = new URL(env.SPEECH_GATEWAY_URL?.trim() || "http://127.0.0.1:8765");
const gatewayPort = env.SPEECH_PORT?.trim() || gatewayUrl.port || "8765";

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
    console.error(`[${name}] stopped (${signal ?? `exit ${code}`}).`);
    stopAll(code || 1);
  });
  children.push(child);
  return child;
};

process.on("SIGINT", () => stopAll(0));
process.on("SIGTERM", () => stopAll(0));

if (await answers(`${gatewayUrl.origin}/health`)) {
  console.log(`[speech] a speech gateway already answers at ${gatewayUrl.origin}; not starting another.`);
} else {
  console.log(`[speech] starting the speech gateway on 127.0.0.1:${gatewayPort}`);
  start("speech", gatewayPython, ["-m", "speech_gateway"], {
    cwd: serviceDir,
    env: {
      OFFICE3D_SPEECH_HOME: speechHome,
      // GigaAM and Silero VAD download here.
      HF_HOME: path.join(speechHome, "hf"),
      SPEECH_HOST: "127.0.0.1",
      SPEECH_PORT: gatewayPort,
    },
  });
}

if (children.length === 0) process.exit(0);
