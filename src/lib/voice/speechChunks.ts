/**
 * Splits a line for sentence-by-sentence speech: the first piece is one short
 * sentence, so its audio is ready (and playing) while the rest still renders.
 *
 * A designed voice (VoxCPM2) renders slower than real time on an 8 GB GPU and
 * every request carries a fixed cost of a few seconds, so later pieces take
 * whole sentences up to `max` characters: fewer requests finish the line
 * sooner, while the pauses between pieces stay at sentence boundaries.
 */

export type SpeechChunkOptions = {
  /** The first piece's longest length, in characters. */
  firstMax?: number;
  /** Any later piece's longest length, in characters. */
  max?: number;
  /** A sentence shorter than this rides along with the next one. */
  minSentence?: number;
};

// A sentence ends at . ! ? … (with closing quotes/brackets) before a space
// and something that starts a sentence: a capital, a digit, a quote or a dash.
const SENTENCE_END = /(?<=[.!?…]["»”)\]]*)\s+(?=["«„“(\[—–-]?\s*[A-ZА-ЯЁ0-9])/u;
// Where a sentence that is too long may be cut: after , ; : or before a dash.
const SOFT_BREAK = /(?<=[,;:])\s+|\s+(?=[—–]\s)/u;

function cutLong(sentence: string, max: number): string[] {
  if (sentence.length <= max) return [sentence];
  const out: string[] = [];
  let current = "";
  const push = () => {
    if (current) out.push(current);
    current = "";
  };
  for (const clause of sentence.split(SOFT_BREAK)) {
    if (clause.length > max) {
      push();
      // No punctuation to cut at: cut between words.
      for (const word of clause.split(/\s+/)) {
        if (current && current.length + 1 + word.length > max) push();
        current = current ? `${current} ${word}` : word;
      }
      continue;
    }
    if (current && current.length + 1 + clause.length > max) push();
    current = current ? `${current} ${clause}` : clause;
  }
  push();
  return out;
}

/** Sentences of `text` grouped into speakable pieces (whitespace normalised). */
export function splitSpeech(text: string, options: SpeechChunkOptions = {}): string[] {
  const firstMax = options.firstMax ?? 140;
  const max = Math.max(firstMax, options.max ?? 160);
  const minSentence = options.minSentence ?? 18;
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];

  const sentences = clean.split(SENTENCE_END).flatMap((sentence) => cutLong(sentence.trim(), max));
  const pieces: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    if (!sentence) continue;
    const limit = pieces.length === 0 ? firstMax : max;
    const joined = current ? `${current} ${sentence}` : sentence;
    // The first piece is one sentence (plus any too-short ones before it);
    // later pieces take whole sentences up to `max`.
    const firstIsDone = pieces.length === 0 && current.length >= minSentence;
    if (current && (joined.length > limit || firstIsDone)) {
      pieces.push(current);
      current = sentence;
    } else {
      current = joined;
    }
  }
  if (current) pieces.push(current);
  if (pieces[0].length > firstMax) {
    // One very long first sentence: start on its first clause.
    const [head, ...rest] = cutLong(pieces[0], firstMax);
    pieces.splice(0, 1, head, ...(rest.length ? [rest.join(" ")] : []));
  }
  return pieces;
}
