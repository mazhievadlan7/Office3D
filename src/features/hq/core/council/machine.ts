/**
 * The Floor 27 council state machine: pure and event-driven, so it is tested
 * with a fake clock and no audio. It owns the session's progression —
 * announcement → the floor gathers → each chief reports in turn while the
 * screen shows that floor, AM7 replies, next chief → AM7's closing → the
 * append-only archive record and the task-board items.
 *
 * The host (the Floor 27 controller) drives it with three signals:
 *   markAnnounced()  — «Система штаба»'s announcement has finished playing
 *   markGathered()   — the sim reports the chiefs are seated at the table
 *   markLineDone()   — the voiced line of the current cue has finished
 * and reads `cue` (what to speak now and what the screen shows) and, at the
 * end, `result()` (the archive record + the decisions to push as tasks).
 *
 * No wall clock drives it: increment 2's scheduler decides *when* to start;
 * this machine only advances on the signals above, so one speaker is heard at
 * a time and the screen follows the speaker, never a timer.
 */

import {
  am7Closing,
  am7Reply,
  chiefReport,
  councilAnnouncement,
  councilScreen,
  COUNCIL_FLOORS,
  decisionsFor,
  demoFloorState,
  type CouncilDecision,
  type CouncilFloor,
  type CouncilFloorState,
  type CouncilKind,
  type CouncilScreen,
} from "./agenda";

export type { CouncilKind } from "./agenda";

export type CouncilPhase =
  | "idle"
  | "announce"
  | "gather"
  | "report"
  | "reply"
  | "closing"
  | "done";

/** Who speaks a cue. The controller maps this to a Silero voice id. */
export type CouncilRole = "system" | "chief" | "am7";

/** What to speak now and what the screen wall shows while it is heard. */
export type CouncilCue = {
  role: CouncilRole;
  /** The directorate floor for a chief's report / AM7's reply to it, else null. */
  floor: number | null;
  /** 0-based position in the speaking order for a chief, else -1. */
  speakerIndex: number;
  /** The line spoken (no on-screen caption of it: voice, not text). */
  text: string;
  /** The compact visual on the screen wall, or null for the session header. */
  screen: CouncilScreen | null;
};

/** The session header shown on the screen when no single floor is in focus. */
export type CouncilHeader = {
  kind: CouncilKind;
  gathered: number;
  expected: number;
  /** 0-based index of the chief now reporting, or -1 before the rounds. */
  speaking: number;
};

/** One chief's contribution, kept for the archive. */
export type CouncilMinuteEntry = {
  floor: number;
  callsign: string;
  name: string;
  report: string;
  reply: string;
  findings: CouncilFloorState["findings"];
  incidents: number;
  agents: { active: number; total: number };
};

/** The session summary appended to the append-only council archive. */
export type CouncilArchiveRecord = {
  kind: CouncilKind;
  startedAt: number;
  endedAt: number;
  chiefCount: number;
  entries: CouncilMinuteEntry[];
  decisions: CouncilDecision[];
  closing: string;
};

export type CouncilResult = {
  archive: CouncilArchiveRecord;
  decisions: CouncilDecision[];
};

export type CouncilMachineOptions = {
  /** Clock for the archive timestamps; defaults to Date.now. */
  now?: () => number;
  /** Real floor state, e.g. from the aegis core / gateway; falls back to demo. */
  floorState?: (floor: number, kind: CouncilKind) => CouncilFloorState;
  /** For "oneonone": the single chief's floor (defaults to Hacking, floor 24). */
  oneononeFloor?: number;
};

/** The chiefs that speak at a council of this kind, in speaking order. */
export function speakingOrder(kind: CouncilKind, oneononeFloor = 24): CouncilFloor[] {
  if (kind === "oneonone") {
    const one = COUNCIL_FLOORS.find((f) => f.floor === oneononeFloor);
    return one ? [one] : [COUNCIL_FLOORS[0]];
  }
  return [...COUNCIL_FLOORS];
}

export class CouncilMachine {
  private readonly now: () => number;
  private readonly getState: (floor: number, kind: CouncilKind) => CouncilFloorState;
  private readonly defaultOneononeFloor: number;
  kind: CouncilKind = "daily";
  phase: CouncilPhase = "idle";
  /** The chiefs speaking this session, in order. */
  order: CouncilFloor[] = [];
  /** Per-floor state captured at the start of the session. */
  private states = new Map<number, CouncilFloorState>();
  private speaker = -1;
  private announced = false;
  private gathered = false;
  private gatheredCount = 0;
  private expectedCount = 0;
  private startedAt = 0;
  private entries: CouncilMinuteEntry[] = [];
  private decisions: CouncilDecision[] = [];
  private closing = "";
  private announcement = "";

  constructor(options: CouncilMachineOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    const demo = (floor: number, kind: CouncilKind) => demoFloorState(floor, kind);
    this.getState = options.floorState ?? demo;
    this.defaultOneononeFloor = options.oneononeFloor ?? 24;
  }

  /** Begins a council of `kind`. Idempotent per session: a second start resets. */
  start(kind: CouncilKind, options: { oneononeFloor?: number } = {}): void {
    this.kind = kind;
    this.order = speakingOrder(kind, options.oneononeFloor ?? this.defaultOneononeFloor);
    this.states.clear();
    for (const floor of this.order) this.states.set(floor.floor, this.getState(floor.floor, kind));
    this.speaker = -1;
    this.announced = false;
    this.gathered = false;
    this.gatheredCount = 0;
    this.expectedCount = this.order.length;
    this.startedAt = this.now();
    this.entries = [];
    this.decisions = [];
    this.closing = "";
    this.announcement = councilAnnouncement(kind, this.order.length);
    this.phase = "announce";
  }

  /** True while a council is running (not idle or done). */
  get active(): boolean {
    return this.phase !== "idle" && this.phase !== "done";
  }

  get header(): CouncilHeader {
    return { kind: this.kind, gathered: this.gatheredCount, expected: this.expectedCount, speaking: this.phase === "report" || this.phase === "reply" ? this.speaker : -1 };
  }

  /** The screen for the floor now in focus (report/reply), else the header view. */
  private screenFor(index: number): CouncilScreen | null {
    const floor = this.order[index];
    if (!floor) return null;
    const state = this.states.get(floor.floor);
    return state ? councilScreen(floor, state) : null;
  }

  /** What to speak now and what the screen shows, or null when nothing is due. */
  get cue(): CouncilCue | null {
    switch (this.phase) {
      case "announce":
      case "gather":
        return { role: "system", floor: null, speakerIndex: -1, text: this.announcement, screen: null };
      case "report": {
        const floor = this.order[this.speaker];
        const state = floor && this.states.get(floor.floor);
        if (!floor || !state) return null;
        return { role: "chief", floor: floor.floor, speakerIndex: this.speaker, text: chiefReport(floor, state), screen: this.screenFor(this.speaker) };
      }
      case "reply": {
        const floor = this.order[this.speaker];
        const state = floor && this.states.get(floor.floor);
        if (!floor || !state) return null;
        return { role: "am7", floor: floor.floor, speakerIndex: this.speaker, text: am7Reply(floor, state), screen: this.screenFor(this.speaker) };
      }
      case "closing":
        return { role: "am7", floor: null, speakerIndex: -1, text: this.closing || am7Closing(this.kind), screen: null };
      default:
        return null;
    }
  }

  /** The sim reports how many chiefs stand/sit at the table so far. */
  setGatherProgress(gathered: number, expected: number): void {
    this.gatheredCount = Math.min(gathered, expected);
    this.expectedCount = expected;
  }

  /** «Система штаба»'s announcement has finished playing. */
  markAnnounced(): void {
    if (this.phase !== "announce") return;
    this.announced = true;
    this.phase = "gather";
    this.maybeBeginRounds();
  }

  /** The sim reports the chiefs are seated at the table. */
  markGathered(): void {
    this.gathered = true;
    this.gatheredCount = this.expectedCount;
    if (this.phase === "gather") this.maybeBeginRounds();
  }

  private maybeBeginRounds(): void {
    if (this.announced && this.gathered && this.phase === "gather") {
      this.speaker = 0;
      this.phase = this.order.length > 0 ? "report" : "closing";
      if (this.phase === "closing") this.closing = am7Closing(this.kind);
    }
  }

  /** The voiced line of the current cue has finished; advance. */
  markLineDone(): void {
    switch (this.phase) {
      case "report":
        this.phase = "reply";
        break;
      case "reply": {
        const floor = this.order[this.speaker];
        const state = floor && this.states.get(floor.floor);
        if (floor && state) {
          this.entries.push({
            floor: floor.floor,
            callsign: floor.callsign,
            name: floor.name,
            report: chiefReport(floor, state),
            reply: am7Reply(floor, state),
            findings: state.findings,
            incidents: state.incidents,
            agents: { active: state.agentsActive, total: state.agentsTotal },
          });
          for (const d of decisionsFor(floor, state)) this.decisions.push(d);
        }
        if (this.speaker + 1 < this.order.length) {
          this.speaker += 1;
          this.phase = "report";
        } else {
          this.phase = "closing";
          this.closing = am7Closing(this.kind);
        }
        break;
      }
      case "closing":
        this.phase = "done";
        break;
      default:
        break;
    }
  }

  /** The archive record + decisions; only meaningful once the phase is "done". */
  result(): CouncilResult {
    const archive: CouncilArchiveRecord = {
      kind: this.kind,
      startedAt: this.startedAt,
      endedAt: this.now(),
      chiefCount: this.order.length,
      entries: this.entries,
      decisions: this.decisions,
      closing: this.closing || am7Closing(this.kind),
    };
    return { archive, decisions: this.decisions };
  }
}
