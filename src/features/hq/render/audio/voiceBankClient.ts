import {
  VOICE_BANK_ROUTE,
  parseVoiceBankManifest,
  type VoiceBankManifest,
  type VoiceBankVoice,
} from "@/lib/voice/voiceBank";

/** Decoded phrases kept, by total length (seconds): ~25 MB of float samples at 48 kHz. */
const LRU_SECONDS = 130;
/** Phrases fetched and decoded at once. */
const PARALLEL = 3;
/** While there is no bank, or one still rendering, look again this often (ms). */
const RETRY_MS = 60_000;
const REFRESH_MS = 120_000;

type Entry = { buffer: AudioBuffer | null; pending: boolean; failed: boolean };

/**
 * The crew's pre-rendered phrases in the browser (scripts/voice-bank.mjs,
 * served by /api/office/voice/bank). Phrases are fetched and decoded ahead of
 * when they are needed (`prefetch`), never inside the render loop: the loop
 * only asks for an already decoded buffer (`ready`), and a phrase that is not
 * ready yet is simply not spoken this time. decodeAudioData runs off the main
 * thread; the files are immutable, so the browser's HTTP cache keeps them too.
 */
export class VoiceBankClient {
  private manifest: VoiceBankManifest | null = null;
  private crewIds: string[] = [];
  private readonly cache = new Map<string, Entry>();
  private cachedSeconds = 0;
  private readonly queue: Array<{ key: string; file: string }> = [];
  private inFlight = 0;
  private timer: number | null = null;
  private disposed = false;
  private loading = false;

  constructor(private readonly context: () => AudioContext | null) {}

  /** Loads the manifest now and keeps it fresh while the bank grows. */
  start(): void {
    if (this.timer !== null || this.disposed || typeof window === "undefined") return;
    void this.refresh();
    const tick = () => {
      this.timer = window.setTimeout(tick, this.manifest ? REFRESH_MS : RETRY_MS);
      void this.refresh();
    };
    this.timer = window.setTimeout(tick, this.manifest ? REFRESH_MS : RETRY_MS);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    this.cache.clear();
    this.queue.length = 0;
  }

  private async refresh(): Promise<void> {
    if (this.loading || this.disposed) return;
    this.loading = true;
    try {
      const response = await fetch(VOICE_BANK_ROUTE, { cache: "no-cache" });
      if (!response.ok) return;
      const manifest = parseVoiceBankManifest(await response.json().catch(() => null));
      if (!manifest || this.disposed) return;
      this.manifest = manifest;
      this.crewIds = Object.keys(manifest.voices).filter((id) => id !== LEAD_VOICE);
    } catch {
      // No bank (yet): the HQ keeps its murmur.
    } finally {
      this.loading = false;
    }
  }

  /** Whether any phrase can be played at all. */
  get available(): boolean {
    return this.manifest !== null;
  }

  /** The crew voices in the bank (AM7's excluded), in the gateway's order. */
  get crewVoiceIds(): readonly string[] {
    return this.crewIds;
  }

  voice(voiceId: string): VoiceBankVoice | null {
    return this.manifest?.voices[voiceId] ?? null;
  }

  has(voiceId: string, lineId: string): boolean {
    return Boolean(this.manifest?.voices[voiceId]?.lines[lineId]);
  }

  duration(voiceId: string, lineId: string): number {
    return this.manifest?.voices[voiceId]?.lines[lineId]?.duration ?? 0;
  }

  /** The decoded phrase if it is ready (marks it recently used), else null. */
  ready(voiceId: string, lineId: string): AudioBuffer | null {
    const file = this.manifest?.voices[voiceId]?.lines[lineId]?.file;
    if (!file) return null;
    const entry = this.cache.get(file);
    if (!entry?.buffer) return null;
    this.cache.delete(file);
    this.cache.set(file, entry);
    return entry.buffer;
  }

  /** Starts fetching and decoding a phrase (no-op when cached, pending or failed). */
  prefetch(voiceId: string, lineId: string): void {
    const file = this.manifest?.voices[voiceId]?.lines[lineId]?.file;
    if (!file || this.cache.has(file) || this.disposed) return;
    this.cache.set(file, { buffer: null, pending: true, failed: false });
    this.queue.push({ key: file, file });
    this.pump();
  }

  private pump(): void {
    while (this.inFlight < PARALLEL && this.queue.length > 0) {
      const job = this.queue.shift()!;
      this.inFlight += 1;
      void this.load(job.file).finally(() => {
        this.inFlight -= 1;
        this.pump();
      });
    }
  }

  private async load(file: string): Promise<void> {
    const entry = this.cache.get(file);
    const ctx = this.context();
    if (!entry || !ctx) {
      this.cache.delete(file);
      return;
    }
    try {
      const response = await fetch(`${VOICE_BANK_ROUTE}/${file}`);
      if (!response.ok) throw new Error(String(response.status));
      const data = await response.arrayBuffer();
      const buffer = await ctx.decodeAudioData(data);
      if (this.disposed || this.cache.get(file) !== entry) return;
      entry.buffer = buffer;
      entry.pending = false;
      this.cachedSeconds += buffer.duration;
      this.evict();
    } catch {
      entry.pending = false;
      entry.failed = true;
    }
  }

  /** Oldest decoded phrases go first once the cache holds more than LRU_SECONDS. */
  private evict(): void {
    for (const [file, entry] of this.cache) {
      if (this.cachedSeconds <= LRU_SECONDS) break;
      if (!entry.buffer) continue;
      this.cachedSeconds -= entry.buffer.duration;
      this.cache.delete(file);
    }
  }
}

/** AM7's voice in the bank. */
export const LEAD_VOICE = "silero:am7";
