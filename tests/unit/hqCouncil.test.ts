import { describe, expect, it } from "vitest";

import {
  COUNCIL_CHIEF_COUNT,
  COUNCIL_FLOORS,
  COUNCIL_SCHEDULE,
  chiefReport,
  councilAnnouncement,
  demoFloorState,
  type CouncilFloorState,
} from "@/features/hq/core/council/agenda";
import { CouncilMachine, speakingOrder } from "@/features/hq/core/council/machine";
import { councilChiefVoiceId, councilVoiceFor } from "@/lib/voice/councilVoices";

const fakeClock = () => {
  let t = 1_000;
  return () => (t += 1000);
};

/** Runs a machine from a fresh start through to "done", recording the cues. */
function runCouncil(machine: CouncilMachine, kind: Parameters<CouncilMachine["start"]>[0]) {
  const cues: { role: string; floor: number | null; screenFloor: number | null; speaker: number }[] = [];
  machine.start(kind);
  // Announcement.
  const ann = machine.cue!;
  cues.push({ role: ann.role, floor: ann.floor, screenFloor: ann.screen?.floor ?? null, speaker: ann.speakerIndex });
  machine.markAnnounced();
  machine.markGathered();
  // Rounds + closing.
  while (machine.active) {
    const cue = machine.cue;
    if (!cue) break;
    cues.push({ role: cue.role, floor: cue.floor, screenFloor: cue.screen?.floor ?? null, speaker: cue.speakerIndex });
    machine.markLineDone();
  }
  return cues;
}

describe("Floor 27 council agenda", () => {
  it("has the 26 directorates, floor 26 down to 1", () => {
    expect(COUNCIL_CHIEF_COUNT).toBe(26);
    expect(COUNCIL_FLOORS[0].floor).toBe(26);
    expect(COUNCIL_FLOORS[COUNCIL_FLOORS.length - 1].floor).toBe(1);
    expect(new Set(COUNCIL_FLOORS.map((f) => f.floor)).size).toBe(26);
  });

  it("exposes a schedule (09:00 daily, 21:00 evening) without auto-firing", () => {
    const daily = COUNCIL_SCHEDULE.find((s) => s.kind === "daily");
    const evening = COUNCIL_SCHEDULE.find((s) => s.kind === "evening");
    expect(daily?.at).toBe("09:00");
    expect(evening?.at).toBe("21:00");
    expect(COUNCIL_SCHEDULE.find((s) => s.kind === "emergency")?.at).toBeNull();
  });

  it("builds a short, structured report per directorate (by name, never «этаж»)", () => {
    const floor = COUNCIL_FLOORS.find((f) => f.floor === 24)!;
    const state = demoFloorState(24, "daily");
    const report = chiefReport(floor, state);
    // Units are referred to by their directorate name + callsign, not «этаж N».
    expect(report).toContain(floor.name); // "Хакинг"
    expect(report).toContain(floor.callsign); // "ВЗЛОМ"
    expect(report.toLowerCase()).not.toContain("этаж");
    expect(report).toContain("находк");
    expect(report.length).toBeLessThan(400); // short, not an essay
  });

  it("announces by voice for each kind", () => {
    expect(councilAnnouncement("daily", 26)).toContain("ежедневное");
    expect(councilAnnouncement("emergency", 26)).toContain("Тревога");
  });
});

describe("Floor 27 council state machine", () => {
  it("runs gather → speaking order → screen-per-speaker → close → archive + tasks", () => {
    const machine = new CouncilMachine({ now: fakeClock() });
    const cues = runCouncil(machine, "daily");

    // Announcement first (system voice, no floor screen).
    expect(cues[0].role).toBe("system");
    expect(cues[0].screenFloor).toBeNull();

    // 26 chiefs, each a report then AM7's reply, in COUNCIL_FLOORS order.
    const reports = cues.filter((c) => c.role === "chief");
    expect(reports.length).toBe(26);
    expect(reports.map((c) => c.floor)).toEqual(COUNCIL_FLOORS.map((f) => f.floor));

    // Screen follows the speaker: a chief's report (and AM7's reply to it) shows
    // that floor's summary.
    for (const c of cues) {
      if (c.role === "chief" || (c.role === "am7" && c.speaker >= 0)) {
        expect(c.screenFloor).toBe(c.floor);
      }
    }

    // Ends on AM7's closing, then done.
    expect(machine.phase).toBe("done");
    const { archive, decisions } = machine.result();
    expect(archive.kind).toBe("daily");
    expect(archive.entries.length).toBe(26);
    expect(archive.closing.length).toBeGreaterThan(0);
    expect(archive.endedAt).toBeGreaterThan(archive.startedAt);
    // Decisions become task-board items; each references a real floor.
    expect(decisions.every((d) => COUNCIL_FLOORS.some((f) => f.floor === d.floor))).toBe(true);
  });

  it("does not begin the rounds until BOTH announced and gathered (either order)", () => {
    const machine = new CouncilMachine({ now: fakeClock() });
    machine.start("daily");
    machine.markGathered();
    expect(machine.phase).toBe("announce"); // still waiting on the announcement
    expect(machine.cue?.role).toBe("system");
    machine.markAnnounced();
    expect(machine.phase).toBe("report");
    expect(machine.cue?.role).toBe("chief");
    expect(machine.cue?.speakerIndex).toBe(0);
  });

  it("tracks gather progress for the screen header", () => {
    const machine = new CouncilMachine({ now: fakeClock() });
    machine.start("daily");
    machine.markAnnounced();
    machine.setGatherProgress(13, 26);
    expect(machine.header.gathered).toBe(13);
    expect(machine.header.expected).toBe(26);
    expect(machine.phase).toBe("gather");
  });

  it("one-on-one seats a single chief", () => {
    expect(speakingOrder("oneonone", 24)).toHaveLength(1);
    expect(speakingOrder("oneonone", 24)[0].floor).toBe(24);
    const machine = new CouncilMachine({ now: fakeClock() });
    const cues = runCouncil(machine, "oneonone");
    expect(cues.filter((c) => c.role === "chief").length).toBe(1);
    expect(machine.result().archive.entries.length).toBe(1);
  });

  it("pushes decisions for critical findings and incidents", () => {
    const critical: CouncilFloorState = {
      floor: 26,
      agentsTotal: 24,
      agentsActive: 20,
      incidents: 0,
      findings: { critical: 2, high: 1, medium: 3, low: 4 },
      operations: [{ label: "разбор инцидента", status: "в работе" }],
    };
    const machine = new CouncilMachine({ now: fakeClock(), floorState: () => critical, oneononeFloor: 26 });
    runCouncil(machine, "oneonone");
    const { decisions } = machine.result();
    expect(decisions.length).toBeGreaterThan(0);
    expect(decisions[0].priority).toBe(true);
    expect(decisions[0].floor).toBe(26);
  });
});

describe("Floor 27 council voices", () => {
  it("assigns a distinct, deterministic voice id per chief floor", () => {
    const ids = COUNCIL_FLOORS.map((f) => councilChiefVoiceId(f.floor));
    expect(new Set(ids).size).toBe(26);
    expect(councilChiefVoiceId(24)).toBe("silero:chief-24");
    expect(councilChiefVoiceId(1)).toBe("silero:chief-01");
  });

  it("routes the system announcement, AM7 and chiefs to the right voice", () => {
    expect(councilVoiceFor("system", null).role).toBe("system");
    expect(councilVoiceFor("am7", null).voiceId).toBe("silero:am7");
    expect(councilVoiceFor("chief", 24).voiceId).toBe("silero:chief-24");
  });
});
