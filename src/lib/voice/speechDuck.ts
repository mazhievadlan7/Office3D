/**
 * Who is talking "to the viewer": «Система штаба», AM7 at a briefing, an
 * agent's spoken reply. While any of them speaks, the HQ's background crew
 * talk ducks (render/audio/HqSoundscape.tsx), so the foreground voice is
 * never masked. A plain counter with listeners; no React.
 */

type Listener = (speaking: boolean) => void;

let active = 0;
const listeners = new Set<Listener>();

const notify = () => {
  const speaking = active > 0;
  for (const listener of listeners) listener(speaking);
};

/** Marks foreground speech as started; call the returned function once it ends (idempotent). */
export function beginForegroundSpeech(): () => void {
  active += 1;
  if (active === 1) notify();
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    active = Math.max(0, active - 1);
    if (active === 0) notify();
  };
}

export function isForegroundSpeechActive(): boolean {
  return active > 0;
}

/** Called with true when foreground speech starts and false when the last one ends. */
export function onForegroundSpeech(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
