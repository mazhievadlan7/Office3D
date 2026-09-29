#!/usr/bin/env node
// `npm run voice:bank` — pre-renders the crew's HQ talk (src/features/hq/render/
// audio/crewScript.ts) in every crew voice and AM7's, through the local speech
// gateway (services/speech: VoxCPM2 in VoiceStudio, the voices' FX), into a bank
// directory outside the repository:
//
//   OFFICE3D_VOICE_BANK_DIR, default <speech home>/voice-bank
//     manifest.json                      which file says which line in which voice
//     <voice>.<line>.<hash12>.mp3        content-addressed: a new text, voice, reference
//                                        clip or FX gives a new name (served immutable)
//
// The office serves it at /api/office/voice/bank; without it the HQ keeps its
// synthesised murmur. Resumable: lines already in the manifest (same hash, file
// present) are skipped, so an interrupted run just continues. Lines the gateway
// could only speak with a Silero fallback are not stored (unless
// --allow-fallback), so a later run with VoiceStudio up fills them in.
//
//   node scripts/voice-bank.mjs [--voices=crew-m1,am7] [--limit=N] [--allow-fallback] [--no-prune] [--check]
//
// Pruning (on unless --no-prune): voices voices.json no longer offers leave the
// manifest, and files no manifest entry names are deleted after the run.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, appendFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import nextEnv from "@next/env";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
nextEnv.loadEnvConfig(repoRoot, true, { info: () => {}, error: console.error });

const env = process.env;
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => args.find((arg) => arg.startsWith(`--${name}=`))?.split("=", 2)[1] ?? null;

const isWindows = process.platform === "win32";
const speechHome =
  env.OFFICE3D_SPEECH_HOME?.trim() ||
  (isWindows
    ? path.join(env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "office3d-speech")
    : path.join(env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "office3d-speech"));
const bankDir = path.resolve(env.OFFICE3D_VOICE_BANK_DIR?.trim() || path.join(speechHome, "voice-bank"));
const gateway = (env.SPEECH_GATEWAY_URL?.trim() || "http://127.0.0.1:8765").replace(/\/+$/, "").replace(/\/v1$/, "");
const serviceDir = path.join(repoRoot, "services", "speech");

/** Bumped when the bank's layout or rendering settings change: everything renders again. */
const BANK_VERSION = 1;
const SPEED = 1;
const FILE_RE = /^[a-z0-9-]{1,40}\.[a-z0-9]{1,12}\.[0-9a-f]{12}\.mp3$/;

const sha = (data) => createHash("sha256").update(data).digest("hex");

// MPEG-1/2 Layer III frame headers: bitrate (kbps) and sample-rate tables.
const MP3_BITRATES = {
  1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const MP3_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
/** Seconds of audio in an MP3 (the gateway sends no duration for a cached line). */
const mp3Duration = (data) => {
  let i = 0;
  if (data.subarray(0, 3).toString("latin1") === "ID3") {
    i = 10 + ((data[6] & 0x7f) << 21) + ((data[7] & 0x7f) << 14) + ((data[8] & 0x7f) << 7) + (data[9] & 0x7f);
  }
  let seconds = 0;
  while (i + 4 <= data.length) {
    if (data[i] !== 0xff || (data[i + 1] & 0xe0) !== 0xe0) {
      i += 1;
      continue;
    }
    const version = (data[i + 1] >> 3) & 3; // 3: MPEG-1, 2: MPEG-2, 0: MPEG-2.5
    const layer = (data[i + 1] >> 1) & 3; // 1: Layer III
    const bitrate = MP3_BITRATES[version === 3 ? 1 : 2]?.[(data[i + 2] >> 4) & 15];
    const rate = MP3_RATES[version]?.[(data[i + 2] >> 2) & 3];
    if (layer !== 1 || !bitrate || !rate) {
      i += 1;
      continue;
    }
    const samples = version === 3 ? 1152 : 576;
    const size = Math.floor(((samples / 8) * bitrate * 1000) / rate) + ((data[i + 2] >> 1) & 1);
    seconds += samples / rate;
    i += Math.max(size, 1);
  }
  return Math.round(seconds * 1000) / 1000;
};
const readOr = (file, fallback = "") => (existsSync(file) ? readFileSync(file) : fallback);

const { allCrewLines } = await import(
  pathToFileURL(path.join(repoRoot, "src", "features", "hq", "render", "audio", "crewScript.ts")).href
);

const presets = JSON.parse(readFileSync(path.join(serviceDir, "voices.json"), "utf8")).voices;
const wanted = option("voices")?.split(",").map((v) => v.trim()).filter(Boolean) ?? null;
// Crew first, AM7 last: the soundscape needs the crew most.
const voices = [
  ...presets.filter((p) => p.role === "crew"),
  ...presets.filter((p) => p.role === "lead"),
].filter((p) => !wanted || wanted.includes(p.id) || wanted.includes(p.id.split(":")[1]));
if (voices.length === 0) {
  console.error("[voice-bank] no voices to render");
  process.exit(1);
}

// Everything that changes the sound goes into each line's hash.
const referenceSha = (preset) => {
  const file = preset.reference?.file;
  if (!file) return null;
  for (const dir of [path.join(speechHome, "voice-refs"), path.join(serviceDir, "voice-refs")]) {
    const candidate = path.join(dir, file);
    if (existsSync(candidate)) return sha(readFileSync(candidate));
  }
  return null;
};
const engineSha = sha(
  Buffer.concat([
    readOr(path.join(serviceDir, "speech_gateway", "fx.py")),
    readOr(path.join(serviceDir, "stress.json")),
    readOr(path.join(serviceDir, "lexicon.json")),
  ]),
).slice(0, 16);
const slug = (preset) => preset.id.split(":")[1].toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 40);
const lineHash = (preset, text) =>
  sha(
    JSON.stringify({
      v: BANK_VERSION,
      voice: { id: preset.id, params: preset.params, fx: preset.fx ?? "none", ref: referenceSha(preset) },
      engine: engineSha,
      text,
      speed: SPEED,
    }),
  ).slice(0, 12);

const manifestPath = path.join(bankDir, "manifest.json");
const loadManifest = () => {
  try {
    const data = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (data && data.version === BANK_VERSION && data.voices && typeof data.voices === "object") return data;
  } catch {
    // none yet, or unreadable: start a new one
  }
  return { version: BANK_VERSION, voices: {} };
};
const manifest = loadManifest();
const saveManifest = () => {
  manifest.generatedAt = new Date().toISOString();
  const tmp = `${manifestPath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(manifest));
  renameSync(tmp, manifestPath);
};

const lines = allCrewLines();
// Entries stored without a length (older runs; cached lines) get it from their file.
for (const entry of Object.values(manifest.voices)) {
  for (const item of Object.values(entry.lines ?? {})) {
    const file = path.join(bankDir, item.file);
    if (!item.duration && existsSync(file)) item.duration = mp3Duration(readFileSync(file));
  }
}
const limit = Number(option("limit")) || Infinity;

if (flag("check")) {
  let files = 0;
  let bytes = 0;
  let seconds = 0;
  for (const [voice, entry] of Object.entries(manifest.voices)) {
    const count = Object.keys(entry.lines ?? {}).length;
    for (const item of Object.values(entry.lines ?? {})) {
      const file = path.join(bankDir, item.file);
      if (existsSync(file)) {
        files += 1;
        bytes += statSync(file).size;
        seconds += item.duration ?? 0;
      }
    }
    console.log(`${voice}: ${count}/${lines.length} lines`);
  }
  console.log(`${files} files, ${(bytes / 1048576).toFixed(1)} MB, ${(seconds / 60).toFixed(1)} min of speech in ${bankDir}`);
  process.exit(0);
}

mkdirSync(bankDir, { recursive: true });

// Voices voices.json no longer offers (retired presets) leave the manifest;
// their files are pruned at the end with the other outdated ones.
if (!flag("no-prune")) {
  const offered = new Set(presets.filter((p) => p.role === "crew" || p.role === "lead").map((p) => p.id));
  const retired = Object.keys(manifest.voices).filter((id) => !offered.has(id));
  for (const id of retired) delete manifest.voices[id];
  if (retired.length) {
    saveManifest();
    console.log(`[voice-bank] dropped retired voices: ${retired.join(", ")}`);
  }
}
const logPath = path.join(bankDir, "render-log.jsonl");

const health = await fetch(`${gateway}/health`, { signal: AbortSignal.timeout(5000) })
  .then((r) => r.json())
  .catch(() => null);
if (!health) {
  console.error(`[voice-bank] the speech gateway does not answer at ${gateway}: start it with npm run speech`);
  process.exit(1);
}
if (!health.engines?.voicestudio?.reachable && !flag("allow-fallback")) {
  console.error("[voice-bank] VoiceStudio is not reachable: the designed voices would fall back to Silero. Start it, or pass --allow-fallback.");
  process.exit(1);
}

// Line-major: every voice gets its first lines early, so a partial bank is already usable.
const jobs = [];
for (const line of lines) {
  for (const preset of voices) {
    const text = line.text;
    const hash = lineHash(preset, text);
    const file = `${slug(preset)}.${line.id}.${hash}.mp3`;
    if (!FILE_RE.test(file)) throw new Error(`bad bank file name ${file}`);
    const entry = (manifest.voices[preset.id] ??= { label: preset.label, lines: {} });
    entry.label = preset.label;
    delete entry.gender;
    const known = entry.lines[line.id];
    if (known && known.file === file && existsSync(path.join(bankDir, file))) continue;
    jobs.push({ preset, line, text, file });
  }
}

let stopping = false;
process.on("SIGINT", () => {
  if (stopping) process.exit(130);
  stopping = true;
  console.log("\n[voice-bank] stopping after this line …");
});

const total = Math.min(jobs.length, limit);
console.log(`[voice-bank] ${voices.length} voices × ${lines.length} lines; ${total} to render into ${bankDir}`);
const started = Date.now();
let done = 0;
let fallbacks = 0;
let failures = 0;
let audioSeconds = 0;
for (const job of jobs.slice(0, total)) {
  if (stopping) break;
  const t0 = Date.now();
  let response;
  try {
    response = await fetch(`${gateway}/v1/audio/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voice: job.preset.id, input: job.text, response_format: "mp3", speed: SPEED }),
      signal: AbortSignal.timeout(600_000),
    });
  } catch (error) {
    failures += 1;
    console.error(`[voice-bank] ${job.file}: ${error instanceof Error ? error.message : error}`);
    if (failures >= 5 && done === 0) break;
    continue;
  }
  if (!response.ok) {
    failures += 1;
    console.error(`[voice-bank] ${job.file}: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
    continue;
  }
  const fallback = response.headers.get("x-speech-fallback");
  const data = Buffer.from(await response.arrayBuffer());
  const duration = Number(response.headers.get("x-speech-duration")) || mp3Duration(data);
  if (fallback && !flag("allow-fallback")) {
    fallbacks += 1;
    console.error(`[voice-bank] ${job.file}: spoken by the fallback ${fallback}; not stored`);
    if (fallbacks >= 3) {
      console.error("[voice-bank] VoiceStudio keeps failing; stopping. Run again once it answers.");
      break;
    }
    continue;
  }
  const target = path.join(bankDir, job.file);
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, target);
  manifest.voices[job.preset.id].lines[job.line.id] = {
    file: job.file,
    duration: Math.round(duration * 1000) / 1000,
    ...(fallback ? { engine: fallback } : {}),
  };
  done += 1;
  audioSeconds += duration;
  const took = (Date.now() - t0) / 1000;
  appendFileSync(logPath, `${JSON.stringify({ file: job.file, voice: job.preset.id, took, duration, bytes: data.length })}\n`);
  if (done % 10 === 0 || done === total) saveManifest();
  const elapsed = (Date.now() - started) / 1000;
  const eta = (elapsed / done) * (total - done);
  console.log(
    `[voice-bank] ${done}/${total} ${job.file} ${duration.toFixed(1)}s audio in ${took.toFixed(1)}s` +
      ` (ETA ${Math.floor(eta / 60)}m${String(Math.round(eta % 60)).padStart(2, "0")}s)`,
  );
}
saveManifest();

// Files no manifest entry names any more (old texts, old takes).
if (!flag("no-prune") && !stopping) {
  const keep = new Set(["manifest.json", "render-log.jsonl"]);
  for (const entry of Object.values(manifest.voices)) for (const item of Object.values(entry.lines)) keep.add(item.file);
  let pruned = 0;
  for (const name of readdirSync(bankDir)) {
    if (keep.has(name) || !(FILE_RE.test(name) || name.endsWith(".tmp"))) continue;
    unlinkSync(path.join(bankDir, name));
    pruned += 1;
  }
  if (pruned) console.log(`[voice-bank] removed ${pruned} outdated files`);
}
const minutes = (Date.now() - started) / 60000;
console.log(
  `[voice-bank] rendered ${done} lines (${(audioSeconds / 60).toFixed(1)} min of speech) in ${minutes.toFixed(1)} min;` +
    ` ${fallbacks} fallbacks, ${failures} failures`,
);
process.exit(failures > 0 && done === 0 ? 1 : 0);
