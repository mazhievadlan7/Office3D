/**
 * Drives one Floor 27 council end to end, tying together the pure state machine
 * (core/council/machine.ts), the runtime sim (councilSim.ts), the voices
 * (lib/voice), the screen wall and the archive + task board.
 *
 * On a trigger:
 *   1. «Система штаба» announces the council by voice (no caption); the chiefs
 *      walk in and take their seats.
 *   2. once the announcement is done and the floor has gathered, each chief in
 *      turn gives a short voiced report (its own Silero voice) while the screen
 *      shows that floor; AM7 replies by voice; the next chief speaks. One voice
 *      at a time, the hall ducked like the briefing PA.
 *   3. AM7 gives his closing; the session is appended to the append-only
 *      council archive and its decisions are pushed to the task board.
 *
 * Every line is one request to /api/office/voice/reply, played through the hall
 * PA chain (lib/voice/briefingAddress), so the voice carries whatever the
 * camera does and the crew/hall duck while it speaks. With sound off the lines
 * are walked silently at reading pace, so the gather/screen/archive still run.
 */

import { prepareBriefingAddress } from "@/lib/voice/briefingAddress";
import { DEFAULT_SYSTEM_VOICE } from "@/lib/voice/voiceCatalog";
import { COUNCIL_AM7_VOICE, councilChiefVoiceId } from "@/lib/voice/councilVoices";
import { CouncilMachine, type CouncilCue, type CouncilKind } from "@/features/hq/core/council/machine";
import type { CouncilScreen } from "@/features/hq/core/council/agenda";
import type { CouncilHeader } from "@/features/hq/core/council/machine";
import type { CouncilSimulation } from "./councilSim";

export type CouncilScreenPaint =
  | { kind: "header"; header: CouncilHeader }
  | { kind: "floor"; screen: CouncilScreen };

export type CouncilControllerDeps = {
  sim: CouncilSimulation;
  /** Repaints the screen wall (header between speakers, floor while reporting). */
  paint: (view: CouncilScreenPaint) => void;
  /** Whether a voice should actually be fetched/played (sound or voice replies on). */
  audible: () => boolean;
  /** For the HUD: the phase/speaker changed. */
  onStateChange?: (phase: string, speaker: number) => void;
};

const voiceForCue = (cue: CouncilCue): string => {
  if (cue.role === "system") return DEFAULT_SYSTEM_VOICE;
  if (cue.role === "am7") return COUNCIL_AM7_VOICE;
  return cue.floor != null ? councilChiefVoiceId(cue.floor) : COUNCIL_AM7_VOICE;
};

export class CouncilController {
  private readonly machine: CouncilMachine;
  private running = false;
  private stopped = false;
  private current: { stop: () => void } | null = null;

  constructor(private readonly deps: CouncilControllerDeps) {
    this.machine = new CouncilMachine();
  }

  get active(): boolean {
    return this.running;
  }

  /** Cancels any running council (voice stopped, sim reset). */
  cancel(): void {
    this.stopped = true;
    this.current?.stop();
    this.current = null;
    this.deps.sim.stop();
    this.running = false;
  }

  /** Runs a council of `kind`. Ignores re-entry while one is already running. */
  async run(kind: CouncilKind, options: { oneononeFloor?: number } = {}): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    const { sim, paint, onStateChange } = this.deps;
    this.machine.start(kind, options);
    sim.start();
    const emit = () => onStateChange?.(this.machine.phase, this.machine.header.speaking);
    emit();

    try {
      // 1. Announcement by «Система штаба» while the floor gathers.
      paint({ kind: "header", header: this.machine.header });
      await this.speak(this.machine.cue);
      if (this.stopped) return;
      this.machine.markAnnounced();
      emit();

      // Wait for the chiefs to be seated (cap handled by the sim).
      await this.waitForGather();
      if (this.stopped) return;
      this.machine.markGathered();
      emit();

      // 2. Rounds: each chief reports, AM7 replies.
      while (this.machine.active && this.machine.phase !== "closing" && !this.stopped) {
        const cue = this.machine.cue;
        if (!cue) break;
        this.applyCue(cue);
        await this.speak(cue);
        if (this.stopped) return;
        this.machine.markLineDone();
        emit();
      }

      // 3. AM7's closing.
      if (!this.stopped && this.machine.phase === "closing") {
        const cue = this.machine.cue;
        this.applyCue(cue);
        sim.setSpeaker(-1);
        sim.setAm7Speaking(true);
        paint({ kind: "header", header: this.machine.header });
        await this.speak(cue);
        sim.setAm7Speaking(false);
        this.machine.markLineDone();
        emit();
      }

      // 4. Archive + tasks.
      if (!this.stopped) await this.finish();
    } finally {
      this.running = false;
      this.deps.sim.setSpeaker(-1);
      this.deps.sim.setAm7Speaking(false);
      emit();
    }
  }

  /** Updates the sim's speaker/AM7 state and the screen for the current cue. */
  private applyCue(cue: CouncilCue | null): void {
    if (!cue) return;
    const { sim, paint } = this.deps;
    if (cue.role === "chief") {
      sim.setSpeaker(cue.speakerIndex);
      sim.setAm7Speaking(false);
    } else if (cue.role === "am7") {
      sim.setAm7Speaking(true);
    }
    if (cue.screen) paint({ kind: "floor", screen: cue.screen });
    else paint({ kind: "header", header: this.machine.header });
  }

  /** Speaks one cue's line over the PA and resolves when it has finished. */
  private speak(cue: CouncilCue | null): Promise<void> {
    if (!cue || this.stopped) return Promise.resolve();
    const address = prepareBriefingAddress([cue.text], {
      voiceId: voiceForCue(cue),
      speed: cue.role === "chief" ? 0.97 : 0.95,
      audible: this.deps.audible(),
      gestureTimeoutMs: 180_000,
    });
    const handle = address.play();
    this.current = address;
    return handle.done.then(() => {
      this.current = null;
    });
  }

  private async waitForGather(): Promise<void> {
    const { sim } = this.deps;
    for (;;) {
      if (this.stopped) return;
      const view = sim.council;
      this.machine.setGatherProgress(view.gathered, view.expected);
      this.deps.paint({ kind: "header", header: this.machine.header });
      if (view.allSeated) return;
      await delay(250);
    }
  }

  private async finish(): Promise<void> {
    const { archive, decisions } = this.machine.result();
    // Append the session to the append-only, hash-chained council archive.
    try {
      await fetch("/api/office/council", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(archive),
      });
    } catch (error) {
      console.warn("[council] archive append failed", error);
    }
    // Push the decisions to the shared task board.
    if (decisions.length > 0) {
      const now = Date.now();
      const tasks = decisions.map((d, i) => ({
        id: `council-${archive.kind}-${now.toString(36)}-${d.floor}-${i}`,
        title: d.title,
        description: d.detail,
        status: d.priority ? "in_progress" : "todo",
        source: "office3d_manual",
        notes: [`Совет штаба (${archive.kind}), этаж ${d.floor} · ${d.callsign}`],
      }));
      try {
        await fetch("/api/task-store", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tasks }),
        });
      } catch (error) {
        console.warn("[council] task push failed", error);
      }
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
