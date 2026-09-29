/**
 * Who is talking "to the viewer": «Система штаба», AM7 at a briefing, an
 * agent's spoken reply. While any of them speaks, the HQ's background crew
 * talk ducks (render/audio/HqSoundscape.tsx), so the foreground voice is
 * never masked. AM7 on the public address at a briefing ducks harder ("pa"):
 * the crew's voices almost out, the keyboards well down, as a hall falls
 * quiet when the speaker starts. A plain counter with listeners; no React.
 */

/** "voice": a spoken line; "pa": AM7's briefing over the public address (ducks harder). */
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
