import { describe, expect, it } from "vitest";

import {
  BEAT_IDLE,
  BEAT_MIN,
  BEAT_TYPE,
  BEAT_VISIT,
  DEPART_BURST,
  DEPART_PER_SEC,
  GUEST_SPACING,
  HqDepartureLimiter,
  MISSION_TEMPO_MAX,
  MISSION_TEMPO_MIN,
  PEER_DESKS,
  PEER_ROWS,
  TEMPO_MAX,
  TEMPO_MIN,
  beatPause,
  buildDeskNeighbourhood,
  guestNearby,
  helpVisitLimit,
  missionTempo,
  peerVisitLimit,
  pickDeskBeat,
  reactionDelay,
  rollTraits,
} from "@/features/hq/core/beats";
import { HQ_BLEND_TIME, HQ_CLIP_INFO, HQ_CLIPS, HQ_SHOULDER, HqClip, WORKSTATION } from "@/features/hq/core/config";
import { generateHqLayout, seatToWorld } from "@/features/hq/core/layout";
import { HqRng } from "@/features/hq/core/rng";
import { isSeatedClip } from "@/features/hq/render/crowd/clipTable";

describe("beats: traits, tempo and timing", () => {
  it("rolls traits inside their ranges, differently per generator", () => {
    const tempos = new Set<number>();
    for (let seed = 1; seed <= 200; seed++) {
      const t = rollTraits(new HqRng(seed));
      expect(t.social).toBeGreaterThanOrEqual(0.3);
      expect(t.social).toBeLessThan(1);
      expect(t.fidget).toBeGreaterThanOrEqual(0.6);
      expect(t.fidget).toBeLessThan(1.5);
      expect(t.tempo).toBeGreaterThanOrEqual(TEMPO_MIN);
      expect(t.tempo).toBeLessThan(TEMPO_MAX);
      tempos.add(Math.round(t.tempo * 1000));
    }
    expect(tempos.size).toBeGreaterThan(50);
  });

  it("maps the agent's tempo onto the mission's faster typing", () => {
    expect(missionTempo(TEMPO_MIN)).toBeCloseTo(MISSION_TEMPO_MIN, 9);
    expect(missionTempo(TEMPO_MAX)).toBeCloseTo(MISSION_TEMPO_MAX, 9);
    expect(missionTempo(1)).toBeGreaterThan(MISSION_TEMPO_MIN);
    expect(missionTempo(1)).toBeLessThan(MISSION_TEMPO_MAX);
    expect(missionTempo(0)).toBe(MISSION_TEMPO_MIN);
  });

  it("reacts within 0.15-1.4 s", () => {
    const rng = new HqRng(9);
    let lo = Infinity;
    let hi = -Infinity;
    for (let k = 0; k < 500; k++) {
      const d = reactionDelay(rng);
      lo = Math.min(lo, d);
      hi = Math.max(hi, d);
    }
    expect(lo).toBeGreaterThanOrEqual(0.15);
    expect(hi).toBeLessThanOrEqual(1.4);
    expect(hi - lo).toBeGreaterThan(1);
  });

  it("never holds a beat under the minimum, fidgety or not", () => {
    const rng = new HqRng(3);
    for (let k = 0; k < 500; k++) {
      expect(beatPause(false, 0.01, rng)).toBeGreaterThanOrEqual(BEAT_MIN);
      expect(beatPause(true, 0.6, rng)).toBeGreaterThanOrEqual(BEAT_MIN);
    }
  });

  it("mostly leans back or types at the desk, sometimes goes over to a colleague, less so on duty", () => {
    const count = (duty: boolean, social: number) => {
      const rng = new HqRng(17);
      const n = [0, 0, 0];
      for (let k = 0; k < 20000; k++) n[pickDeskBeat(duty, social, rng)]++;
      return n;
    };
    const normal = count(false, 1);
    expect(normal[BEAT_IDLE]).toBeGreaterThan(normal[BEAT_TYPE]);
    expect(normal[BEAT_TYPE]).toBeGreaterThan(normal[BEAT_VISIT]);
    expect(normal[BEAT_VISIT] / 20000).toBeGreaterThan(0.03);
    expect(normal[BEAT_VISIT] / 20000).toBeLessThan(0.1);
    const shy = count(false, 0.3);
    expect(shy[BEAT_VISIT]).toBeLessThan(normal[BEAT_VISIT]);
    const duty = count(true, 1);
    expect(duty[BEAT_VISIT]).toBeLessThan(normal[BEAT_VISIT]);
  });

  it("limits visits to 3% of the hall (at least 2) and a mission's help to 1% (at least 1)", () => {
    expect(peerVisitLimit(10)).toBe(2);
    expect(peerVisitLimit(333)).toBe(9);
    expect(peerVisitLimit(1000)).toBe(30);
    expect(helpVisitLimit(10)).toBe(1);
    expect(helpVisitLimit(333)).toBe(3);
    expect(helpVisitLimit(1000)).toBe(10);
  });
});

describe("beats: departure limiter", () => {
  it("lets a burst go at once, then about DEPART_PER_SEC a second", () => {
    const lim = new HqDepartureLimiter();
    let burst = 0;
    while (lim.take()) burst++;
    expect(burst).toBe(DEPART_BURST);
    let taken = 0;
    for (let k = 0; k < 600; k++) {
      lim.refill(0.1);
      // Everyone wants to go, every frame.
      while (lim.take()) taken++;
    }
    expect(taken).toBeGreaterThanOrEqual(Math.floor(60 * DEPART_PER_SEC) - 1);
    expect(taken).toBeLessThanOrEqual(Math.ceil(60 * DEPART_PER_SEC) + 1);
  });

  it("never stores more than its burst, and takes back a departure that did not happen", () => {
    const lim = new HqDepartureLimiter();
    lim.refill(1000);
    expect(lim.tokens).toBe(DEPART_BURST);
    expect(lim.take()).toBe(true);
    lim.refund();
    expect(lim.tokens).toBe(DEPART_BURST);
    lim.tokens = 0.5;
    expect(lim.take()).toBe(false);
    lim.refill(-5);
    expect(lim.tokens).toBe(0.5);
  });
});

describe("beats: desk neighbourhood", () => {
  for (const capacity of [100, 300, 1000] as const) {
    it(`orders every row west to east and lists near desks only (${capacity})`, () => {
      const layout = generateHqLayout(capacity);
      const nb = buildDeskNeighbourhood(layout.desks, layout.arena);
      const n = layout.desks.length;
      // Rows as the layout numbers them (podId is the row), each desk once.
      const seen = new Uint8Array(n);
      for (let r = 0; r + 1 < nb.rowStart.length; r++) {
        let lastAngle = -Infinity;
        for (let k = nb.rowStart[r]; k < nb.rowStart[r + 1]; k++) {
          const d = nb.rowDesks[k];
          seen[d]++;
          expect(nb.row[d]).toBe(r);
          expect(layout.desks[d].podId).toBe(r);
          expect(nb.pos[d]).toBe(k - nb.rowStart[r]);
          const angle = Math.atan2(layout.desks[d].x - layout.arena.x, layout.desks[d].z - layout.arena.z);
          expect(angle).toBeGreaterThan(lastAngle);
          lastAngle = angle;
        }
      }
      expect(Array.from(seen).every((c) => c === 1)).toBe(true);
      for (let d = 0; d < n; d++) {
        const list = Array.from(nb.near.subarray(nb.nearStart[d], nb.nearStart[d + 1]));
        expect(list.length).toBeGreaterThan(0);
        expect(list).not.toContain(d);
        expect(new Set(list).size).toBe(list.length);
        for (const e of list) {
          expect(Math.abs(nb.row[e] - nb.row[d])).toBeLessThanOrEqual(PEER_ROWS);
          if (nb.row[e] === nb.row[d]) expect(Math.abs(nb.pos[e] - nb.pos[d])).toBeLessThanOrEqual(PEER_DESKS);
        }
        // Nearest first: the same row's neighbours lead.
        const first = list[0];
        expect(nb.row[first]).toBe(nb.row[d]);
        expect(Math.abs(nb.pos[first] - nb.pos[d])).toBe(1);
      }
    });
  }

  it("sees a guest within GUEST_SPACING desks along the row, and only there", () => {
    const layout = generateHqLayout(300);
    const nb = buildDeskNeighbourhood(layout.desks, layout.arena);
    const guests = new Uint8Array(layout.desks.length);
    const row = 1;
    const at = (k: number) => nb.rowDesks[nb.rowStart[row] + k];
    const rowLength = nb.rowStart[row + 1] - nb.rowStart[row];
    expect(rowLength).toBeGreaterThan(2 * GUEST_SPACING + 4);
    const mid = Math.floor(rowLength / 2);
    guests[at(mid)] = 1;
    for (let k = 0; k < rowLength; k++) {
      expect(guestNearby(nb, guests, at(k), GUEST_SPACING), `pos ${k}`).toBe(Math.abs(k - mid) <= GUEST_SPACING);
    }
    // Other rows do not count.
    const other = nb.rowDesks[nb.rowStart[0]];
    expect(guestNearby(nb, guests, other, GUEST_SPACING)).toBe(false);
    expect(guestNearby(nb, guests, -1, GUEST_SPACING)).toBe(false);
  });
});

describe("clip table: blends and flags", () => {
  it("fades locomotion quickly and seated pose changes slowly", () => {
    expect(HQ_CLIP_INFO.Walk.blend).toBe(HQ_BLEND_TIME);
    expect(HQ_CLIP_INFO.Run.blend).toBe(HQ_BLEND_TIME);
    expect(HQ_CLIP_INFO.Push.blend).toBe(HQ_BLEND_TIME);
    for (const name of ["SitType", "SitIdle"] as const) {
      expect(HQ_CLIP_INFO[name].blend).toBeGreaterThanOrEqual(0.5);
      expect(HQ_CLIP_INFO[name].blend).toBeLessThanOrEqual(0.8);
    }
  });

  it("marks the seated, typing and talking clips; isSeatedClip reads the table", () => {
    const seated = HQ_CLIPS.filter((n) => HQ_CLIP_INFO[n].seated);
    expect(seated).toEqual(["SitDown", "SitType", "SitIdle"]);
    expect(HQ_CLIPS.filter((n) => HQ_CLIP_INFO[n].typing)).toEqual(["SitType"]);
    expect(HQ_CLIPS.filter((n) => HQ_CLIP_INFO[n].talk)).toEqual(["Talk", "Present"]);
    HQ_CLIPS.forEach((name, code) => expect(isSeatedClip(code)).toBe(HQ_CLIP_INFO[name].seated));
    expect(isSeatedClip(HqClip.SitType)).toBe(true);
    expect(isSeatedClip(HqClip.Walk)).toBe(false);
  });
});

describe("the shoulder place", () => {
  it("stands behind the sitter's right shoulder, clear of the chair and of the neighbours' chairs", () => {
    const layout = generateHqLayout(300);
    // Behind the chair back and on the sitter's right (-X).
    expect(HQ_SHOULDER.z).toBeLessThan(-0.31);
    expect(HQ_SHOULDER.x).toBeLessThan(0);
    expect(Math.hypot(HQ_SHOULDER.x, HQ_SHOULDER.z)).toBeGreaterThan(0.6);
    // The hand rests at the chair back's right top corner.
    expect(HQ_SHOULDER.hand.z).toBeGreaterThanOrEqual(-0.31);
    expect(HQ_SHOULDER.hand.z).toBeLessThanOrEqual(-0.25);
    expect(HQ_SHOULDER.hand.y).toBeGreaterThan(WORKSTATION.seatHeight);
    const pos = layout.nav.positions;
    let closestChair = Infinity;
    let closestStep = Infinity;
    for (const d of layout.desks) {
      const p = seatToWorld(d.x, d.z, d.rotY, HQ_SHOULDER.x, HQ_SHOULDER.z);
      for (const e of layout.desks) {
        if (e === d) continue;
        closestChair = Math.min(closestChair, Math.hypot(e.x - p.x, e.z - p.z));
      }
      // The straight step in from the ring node behind the chair passes clear of the chair.
      const ax = pos[d.navNode * 2];
      const az = pos[d.navNode * 2 + 1];
      const ux = p.x - ax;
      const uz = p.z - az;
      const len2 = ux * ux + uz * uz;
      const t = Math.max(0, Math.min(1, ((d.x - ax) * ux + (d.z - az) * uz) / len2));
      closestStep = Math.min(closestStep, Math.hypot(d.x - ax - ux * t, d.z - az - uz * t));
    }
    expect(closestChair).toBeGreaterThan(0.9);
    expect(closestStep).toBeGreaterThan(0.5);
  });
});
