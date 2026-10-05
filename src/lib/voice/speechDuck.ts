/**
 * Who is talking "to the viewer": «Система штаба», AM7 at a briefing / council,
 * an agent's spoken reply. Two jobs live here:
 *
 *   1. Ducking — while any foreground voice speaks the HQ's background crew talk
 *      ducks (render/audio/HqSoundscape.tsx), so the foreground is never masked.
 *      AM7 on the public address ducks harder ("pa").
 *
 *   2. One voice at a time — a single global lock every spoken source must hold
 *      while it plays (the greeting, the briefing/council, agents' replies).
 *      Only one lease is granted at a time; the rest queue, highest priority
 *      first. The ambient greeting never talks over the lead: it is refused
 *      while a council/briefing session runs or anything higher holds/waits,
 *      and an already-playing greeting is pre-empted (its lease.signal aborts)
 *      the moment a council/briefing asks to speak. Holding a lease ducks the
 *      crew for its lifetime, so acquiring is also how you duck.
 *
 * A plain module-level coordinator; no React. Reload/unmount safety is the
 * caller's: pass an `external` AbortSignal and the lease is released (and any
 * queued wait dropped) when it aborts.
 */

/** "voice": a spoken line; "pa": AM7's briefing / council over the public address (ducks harder). */
export type ForegroundSpeechKind = "voice" | "pa";

type Listener = (speaking: boolean, strong: boolean) => void;

let active = 0;
let strongActive = 0;
const listeners = new Set<Listener>();

const notify = () => {
  const speaking = active > 0;
  const strong = strongActive > 0;
  for (const listener of listeners) listener(speaking, strong);
};

/** Marks foreground speech as started; call the returned function once it ends (idempotent). */
export function beginForegroundSpeech(kind: ForegroundSpeechKind = "voice"): () => void {
  const strong = kind === "pa";
  const wasSpeaking = active > 0;
  const wasStrong = strongActive > 0;
  active += 1;
  if (strong) strongActive += 1;
  if (!wasSpeaking || (strong && !wasStrong)) notify();
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    active = Math.max(0, active - 1);
    if (strong) strongActive = Math.max(0, strongActive - 1);
    if (active === 0 || (strong && strongActive === 0)) notify();
  };
}

export function isForegroundSpeechActive(): boolean {
  return active > 0;
}

/** Whether the public address (AM7 at a briefing) is on: the hall ducks harder. */
export function isPublicAddressActive(): boolean {
  return strongActive > 0;
}

/** Called with (true, strong) when foreground speech starts or turns strong, (false, false) when the last one ends. */
export function onForegroundSpeech(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// --- the single foreground-speech lock -------------------------------------------------------

/**
 * Priority of a foreground voice. Higher wins the lock and pre-empts lower.
 *  - ambient: the «Система штаба» greeting (yields to everything).
 *  - reply: an agent's spoken reply.
 *  - briefing: the lead on the public address — a briefing or a council.
 */
export const SPEECH_PRIORITY = { ambient: 0, reply: 1, briefing: 2 } as const;
export type SpeechPriority = (typeof SPEECH_PRIORITY)[keyof typeof SPEECH_PRIORITY];

/** A granted turn to speak: play while `signal` is not aborted, then call `release`. */
export type ForegroundLease = { release: () => void; signal: AbortSignal };

export type AcquireOptions = {
  /** Ducking strength; defaults to "pa" for briefing priority, else "voice". */
  kind?: ForegroundSpeechKind;
  priority?: SpeechPriority;
  /** The caller's own stop/unmount signal: aborting it releases the lease or drops the wait. */
  external?: AbortSignal;
};

type Holder = {
  priority: number;
  release: () => void;
  /** Cuts an in-progress lower-priority voice (ambient greeting) when a higher one arrives. */
  preempt: () => void;
};

type Waiter = {
  priority: number;
  kind: ForegroundSpeechKind;
  external?: AbortSignal;
  onAbort?: () => void;
  seq: number;
  resolve: (lease: ForegroundLease | null) => void;
};

let holder: Holder | null = null;
let sessionDepth = 0;
let seqCounter = 0;
const waiters: Waiter[] = [];

// --- dev instrumentation: the real grant→release window of every turn ------------------------
// Since only one holder is ever live, these windows cannot overlap; the log lets
// a session confirm that (greeting + a whole council), and is dev-only.
export type ForegroundSpeechLogEntry = { priority: number; kind: ForegroundSpeechKind; startMs: number; endMs: number };
const speechLog: ForegroundSpeechLogEntry[] = [];
const nowMs = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** The grant/release windows recorded so far (dev only). */
export function foregroundSpeechLog(): readonly ForegroundSpeechLogEntry[] {
  return speechLog.slice();
}

/** Clears the recorded windows (dev only). */
export function clearForegroundSpeechLog(): void {
  speechLog.length = 0;
}

/**
 * Marks a lead "session" (a whole council or briefing) in progress for its
 * whole length, across the individual lines it speaks. While a session runs the
 * ambient greeting is refused outright, so it can never slip in between lines.
 * Returns an idempotent end.
 */
export function beginForegroundSession(): () => void {
  sessionDepth += 1;
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    sessionDepth = Math.max(0, sessionDepth - 1);
  };
}

/** Whether a council/briefing session is currently running. */
export function isForegroundSessionActive(): boolean {
  return sessionDepth > 0;
}

function makeHolder(priority: number, kind: ForegroundSpeechKind, external?: AbortSignal): Holder {
  const ac = new AbortController();
  const endDuck = beginForegroundSpeech(kind);
  const logEntry: ForegroundSpeechLogEntry = { priority, kind, startMs: nowMs(), endMs: -1 };
  speechLog.push(logEntry);
  if (speechLog.length > 500) speechLog.splice(0, speechLog.length - 500);
  let released = false;
  const self: Holder = {
    priority,
    preempt: () => {
      if (!ac.signal.aborted) ac.abort();
    },
    release: () => {
      if (released) return;
      released = true;
      logEntry.endMs = nowMs();
      external?.removeEventListener("abort", self.release);
      endDuck();
      if (holder === self) holder = null;
      grantNext();
    },
  };
  // The caller's stop/unmount aborts the whole turn.
  external?.addEventListener("abort", self.release, { once: true });
  // Store the lease on the holder for the acquirer.
  (self as Holder & { lease: ForegroundLease }).lease = { release: self.release, signal: ac.signal };
  return self;
}

function grantNext(): void {
  if (holder || waiters.length === 0) return;
  let idx = -1;
  let bestPriority = -1;
  let bestSeq = Infinity;
  for (let i = 0; i < waiters.length; i += 1) {
    const w = waiters[i];
    if (w.priority > bestPriority || (w.priority === bestPriority && w.seq < bestSeq)) {
      bestPriority = w.priority;
      bestSeq = w.seq;
      idx = i;
    }
  }
  const w = waiters.splice(idx, 1)[0];
  if (w.onAbort && w.external) w.external.removeEventListener("abort", w.onAbort);
  const h = makeHolder(w.priority, w.kind, w.external);
  holder = h;
  w.resolve((h as Holder & { lease: ForegroundLease }).lease);
}

/**
 * Acquires the single foreground-speech turn. Resolves to a lease once granted,
 * or to null if the turn is refused or dropped: the ambient greeting is refused
 * while a session runs or anything of reply priority or higher holds or waits,
 * and any waiter is dropped if its `external` signal aborts first. Hold the
 * lease (it ducks the crew) only while actually playing, then release it.
 */
export function acquireForegroundSpeech(opts: AcquireOptions = {}): Promise<ForegroundLease | null> {
  const priority = opts.priority ?? SPEECH_PRIORITY.reply;
  const kind = opts.kind ?? (priority >= SPEECH_PRIORITY.briefing ? "pa" : "voice");
  const external = opts.external;
  if (external?.aborted) return Promise.resolve(null);
  // The ambient greeting yields: never over a running session, nor over an
  // equal/higher voice already holding or already waiting for the lock.
  if (priority < SPEECH_PRIORITY.reply) {
    if (sessionDepth > 0) return Promise.resolve(null);
    if (holder && holder.priority >= SPEECH_PRIORITY.reply) return Promise.resolve(null);
    if (waiters.some((w) => w.priority >= SPEECH_PRIORITY.reply)) return Promise.resolve(null);
  }
  if (!holder) {
    holder = makeHolder(priority, kind, external);
    return Promise.resolve((holder as Holder & { lease: ForegroundLease }).lease);
  }
  // A higher-priority voice cuts a lower one that is mid-sentence (the greeting).
  if (holder.priority < priority) holder.preempt();
  return new Promise<ForegroundLease | null>((resolve) => {
    const w: Waiter = { priority, kind, external, seq: seqCounter++, resolve };
    w.onAbort = () => {
      const i = waiters.indexOf(w);
      if (i >= 0) waiters.splice(i, 1);
      resolve(null);
    };
    external?.addEventListener("abort", w.onAbort, { once: true });
    waiters.push(w);
  });
}
