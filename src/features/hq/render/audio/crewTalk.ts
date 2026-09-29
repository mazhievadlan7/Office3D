import { CREW_ACKS, CREW_EXCHANGES, CREW_SOLOS, type CrewLine } from "./crewScript";

/**
 * Who says what when an agent near the camera talks (render/audio/
 * HqSoundscape.tsx). The simulation decides *when* someone talks (their clip's
 * talk window: a seated pair alternates, a group at a spot passes the word
 * around); this decides the words, as a conversation:
 *
 * - one voice at a time within earshot of each other (TURN_RADIUS): whoever
 *   is due waits until the neighbour's phrase has ended;
 * - a question gets its answer from someone next to the asker, right after it;
 * - otherwise a new question, a remark, or (for a glance over a shoulder, or
 *   after someone else spoke) a short acknowledgement;
 * - lines heard recently are not picked again soon.
 *
 * Pure (no audio): `available` says which lines the speaker's voice has.
 */

/** How a talk window was opened: a seated pair, a group standing at a spot, a glance over a shoulder. */
export type TalkKind = "pair" | "group" | "glance";

export type TalkPick = {
  line: CrewLine;
  /** Index into CREW_EXCHANGES for a question or an answer, else -1. */
  exchange: number;
  role: "ask" | "answer" | "solo" | "ack";
};

type Said = {
  speaker: string;
  x: number;
  z: number;
  start: number;
  end: number;
  exchange: number;
  role: TalkPick["role"];
  answered: boolean;
};

/** Metres within which people hear each other (and take turns). */
export const TURN_RADIUS = 3.6;
/** Silence between two voices of one conversation (seconds). */
const TURN_GAP = 0.3;
/** How long after a question its answer may still come (seconds). */
const ANSWER_WITHIN = 5;
/** Lines not picked again for this many picks. */
const RECENT = 40;
const HISTORY = 24;

export class CrewTalkPlanner {
  private readonly said: Said[] = [];
  private readonly recent: string[] = [];

  constructor(private readonly random: () => number = Math.random) {}

  /**
   * Seconds `speaker` still has to wait before talking at (x, z), because
   * someone within earshot is talking (0: free to talk now).
   */
  waitFor(speaker: string, x: number, z: number, now: number): number {
    let wait = 0;
    for (const s of this.said) {
      if (s.speaker === speaker || s.end + TURN_GAP <= now) continue;
      if ((s.x - x) ** 2 + (s.z - z) ** 2 > TURN_RADIUS * TURN_RADIUS) continue;
      wait = Math.max(wait, s.end + TURN_GAP - now);
    }
    return wait;
  }

  /** A question nearby, just asked by someone else and not answered yet, or null. */
  openQuestion(speaker: string, x: number, z: number, now: number): number {
    let best = -1;
    let bestStart = -Infinity;
    for (let k = 0; k < this.said.length; k++) {
      const s = this.said[k];
      if (s.role !== "ask" || s.answered || s.speaker === speaker) continue;
      if (now - s.end > ANSWER_WITHIN) continue;
      if ((s.x - x) ** 2 + (s.z - z) ** 2 > TURN_RADIUS * TURN_RADIUS) continue;
      if (s.start > bestStart) {
        bestStart = s.start;
        best = s.exchange;
      }
    }
    return best;
  }

  /** What `speaker` says now, or null when nothing fits (no line in their voice). */
  pick(speaker: string, kind: TalkKind, x: number, z: number, now: number, available: (lineId: string) => boolean): TalkPick | null {
    const open = this.openQuestion(speaker, x, z, now);
    if (open >= 0) {
      const answer = CREW_EXCHANGES[open].answer;
      if (available(answer.id)) return { line: answer, exchange: open, role: "answer" };
    }
    const someoneSpoke = this.said.some(
      (s) => s.speaker !== speaker && now - s.end < 8 && (s.x - x) ** 2 + (s.z - z) ** 2 <= TURN_RADIUS * TURN_RADIUS,
    );
    const r = this.random();
    const order: Array<TalkPick["role"]> =
      kind === "glance"
        ? r < 0.55
          ? ["ack", "solo"]
          : ["solo", "ack"]
        : kind === "pair"
          ? someoneSpoke && r < 0.15
            ? ["ack", "ask", "solo"]
            : r < 0.65
              ? ["ask", "solo", "ack"]
              : ["solo", "ask", "ack"]
          : r < 0.5
            ? ["ask", "solo", "ack"]
            : ["solo", "ask", "ack"];
    for (const role of order) {
      const pick = this.choose(role, available);
      if (pick) return pick;
    }
    return null;
  }

  private choose(role: TalkPick["role"], available: (lineId: string) => boolean): TalkPick | null {
    const fresh = (line: CrewLine) => available(line.id) && !this.recent.includes(line.id);
    if (role === "ask") {
      const options: number[] = [];
      for (let k = 0; k < CREW_EXCHANGES.length; k++) if (fresh(CREW_EXCHANGES[k].ask)) options.push(k);
      if (options.length === 0) return null;
      const k = options[Math.floor(this.random() * options.length)];
      return { line: CREW_EXCHANGES[k].ask, exchange: k, role };
    }
    const pool = (role === "ack" ? CREW_ACKS : CREW_SOLOS).filter(fresh);
    if (pool.length === 0) return null;
    return { line: pool[Math.floor(this.random() * pool.length)], exchange: -1, role };
  }

  /** Records that `speaker` says `pick` from `start` to `end` (audio seconds). */
  spoke(speaker: string, pick: TalkPick, x: number, z: number, start: number, end: number): void {
    if (pick.role === "answer") {
      for (const s of this.said) if (s.role === "ask" && s.exchange === pick.exchange) s.answered = true;
    }
    this.said.push({ speaker, x, z, start, end, exchange: pick.exchange, role: pick.role, answered: false });
    if (this.said.length > HISTORY) this.said.shift();
    this.recent.push(pick.line.id);
    if (this.recent.length > RECENT) this.recent.shift();
  }

  /** Cuts `speaker`'s current phrase short at `time` (they walked off, or out of earshot). */
  stopped(speaker: string, time: number): void {
    for (const s of this.said) if (s.speaker === speaker && s.end > time) s.end = time;
  }
}
