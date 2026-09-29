import { describe, expect, it } from "vitest";

import {
  BEAT_COUNT,
  BEAT_IDLE,
  BEAT_LEAN,
  BEAT_MIN,
  BEAT_READ,
  BEAT_STRETCH,
  BEAT_TURN,
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
  LISTEN_IDLE,
  LISTEN_PLAIN,
  LISTEN_SLOW,
  beatPause,
  beatSeconds,
  buildDeskNeighbourhood,
  guestNearby,
  helpVisitLimit,
  leanLimit,
  listenStyle,
  missionTempo,
  pairLimit,
  peerVisitLimit,
  pickBeat,
  reactionDelay,
  rollTraits,
  seatedNeighbours,
  stretchLimit,
} from "@/features/hq/core/beats";
import { HQ_BLEND_TIME, HQ_CLIP_INFO, HQ_CLIPS, HQ_SHOULDER, HqClip, WORKSTATION } from "@/features/hq/core/config";
import { generateHqLayout, seatToWorld } from "@/features/hq/core/layout";
import { HqRng } from "@/features/hq/core/rng";
import { isSeatedClip, isSpeakingClip, isTypingClip } from "@/features/hq/render/crowd/clipTable";

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

  const tally = (working: boolean, duty: boolean, social: number) => {
    const rng = new HqRng(17);
    const n = new Array<number>(BEAT_COUNT).fill(0);
    for (let k = 0; k < 20000; k++) n[pickBeat(working, duty, social, rng)]++;
    return n.map((c) => c / 20000);
  };

  it("keeps a working hacker mostly typing, then reading, sometimes leaning back, talking or stretching", () => {
    const w = tally(true, false, 1);
    expect(w[BEAT_TYPE]).toBeGreaterThan(0.45);
    expect(w[BEAT_READ]).toBeGreaterThan(0.18);
    expect(w[BEAT_LEAN]).toBeGreaterThan(0.03);
    expect(w[BEAT_TURN]).toBeGreaterThan(0.03);
    expect(w[BEAT_STRETCH]).toBeGreaterThan(0.02);
    // A working hacker never sits idle or walks off to someone else's desk.
    expect(w[BEAT_IDLE]).toBe(0);
    expect(w[BEAT_VISIT]).toBe(0);
  });

  it("lets a free hacker sit back, read, think, talk, visit and stretch; the shy talk and visit less", () => {
    const f = tally(false, false, 1);
    for (const b of [BEAT_IDLE, BEAT_READ, BEAT_LEAN, BEAT_TURN, BEAT_VISIT, BEAT_STRETCH]) expect(f[b]).toBeGreaterThan(0.03);
    expect(f[BEAT_IDLE]).toBeGreaterThan(f[BEAT_READ]);
    expect(f[BEAT_VISIT]).toBeLessThan(0.1);
    expect(f[BEAT_TYPE]).toBe(0);
    const shy = tally(false, false, 0.3);
    expect(shy[BEAT_TURN]).toBeLessThan(f[BEAT_TURN]);
    expect(shy[BEAT_VISIT]).toBeLessThan(f[BEAT_VISIT]);
  });

  it("uses only work beats on duty: typing and reading, a short word, a free hacker's help", () => {
    for (const working of [true, false]) {
      const d = tally(working, true, 1);
      expect(d[BEAT_IDLE]).toBe(0);
      expect(d[BEAT_LEAN]).toBe(0);
      expect(d[BEAT_STRETCH]).toBe(0);
      expect(d[BEAT_TYPE] + d[BEAT_READ]).toBeGreaterThan(0.85);
      if (working) expect(d[BEAT_VISIT]).toBe(0);
    }
    expect(tally(false, true, 1)[BEAT_READ]).toBeGreaterThan(tally(false, true, 1)[BEAT_TYPE]);
    expect(tally(false, true, 1)[BEAT_VISIT]).toBeLessThan(tally(false, false, 1)[BEAT_VISIT]);
  });

  it("times reading, leaning back and talking per design; a word on duty is short", () => {
    const rng = new HqRng(5);
    for (let k = 0; k < 300; k++) {
      const read = beatSeconds(BEAT_READ, true, false, rng);
      expect(read).toBeGreaterThanOrEqual(20);
      expect(read).toBeLessThanOrEqual(60);
      const lean = beatSeconds(BEAT_LEAN, false, false, rng);
      expect(lean).toBeGreaterThanOrEqual(20);
      expect(lean).toBeLessThanOrEqual(60);
      const talk = beatSeconds(BEAT_TURN, true, false, rng);
      expect(talk).toBeGreaterThanOrEqual(10);
      expect(talk).toBeLessThanOrEqual(25);
      const brief = beatSeconds(BEAT_TURN, true, true, rng);
      expect(brief).toBeGreaterThanOrEqual(6);
      expect(brief).toBeLessThanOrEqual(12);
      expect(beatSeconds(BEAT_TYPE, true, false, rng)).toBe(0);
      const pause = beatPause(false, 1, rng, true);
      expect(pause).toBeGreaterThanOrEqual(25);
      expect(pause).toBeLessThanOrEqual(70);
    }
  });

  it("caps leaning back, stretching and seated pairs over the hall", () => {
    expect(leanLimit(333)).toBe(26);
    expect(stretchLimit(333)).toBe(4);
    expect(pairLimit(333, false)).toBe(13);
    expect(pairLimit(333, true)).toBe(4);
    expect(leanLimit(5)).toBe(1);
    expect(stretchLimit(5)).toBe(1);
    expect(pairLimit(5, true)).toBe(1);
  });

  it("splits standing listeners 45% / 25% / 30% from the id hash", () => {
    const n = [0, 0, 0];
    for (let k = 0; k < 30000; k++) n[listenStyle((Math.imul(k, 2654435761) ^ (k >>> 3)) >>> 0)]++;
    expect(n[LISTEN_PLAIN] / 30000).toBeCloseTo(0.45, 1);
    expect(n[LISTEN_SLOW] / 30000).toBeCloseTo(0.25, 1);
    expect(n[LISTEN_IDLE] / 30000).toBeCloseTo(0.3, 1);
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
    expect(seated).toEqual([
      "SitDown",
      "SitType",
      "SitIdle",
      "SitType2",
      "SitRead",
      "SitStretch",
      "SitLeanBack",
      "SitTurnL",
      "SitTurnR",
      "SitShowScreen",
    ]);
    expect(HQ_CLIPS.filter((n) => HQ_CLIP_INFO[n].typing)).toEqual(["SitType", "SitType2"]);
    expect(HQ_CLIPS.filter((n) => HQ_CLIP_INFO[n].talk)).toEqual(["Talk", "Present", "SitTurnL", "SitTurnR", "StandLookOver"]);
    HQ_CLIPS.forEach((name, code) => expect(isSeatedClip(code)).toBe(HQ_CLIP_INFO[name].seated));
    HQ_CLIPS.forEach((name, code) => expect(isTypingClip(code)).toBe(HQ_CLIP_INFO[name].typing));
    expect(isSeatedClip(HqClip.SitType)).toBe(true);
    expect(isSeatedClip(HqClip.Walk)).toBe(false);
  });

  it("appends the wave-1 clips after Push without moving any code", () => {
    expect(HQ_CLIPS.slice(0, 9)).toEqual(["Idle", "Walk", "Run", "SitDown", "SitType", "SitIdle", "Talk", "Present", "Push"]);
    HQ_CLIPS.forEach((name, code) => expect(HqClip[name]).toBe(code));
  });

  it("speaks only inside a clip's talk window: the seated pair talks first, listens second", () => {
    expect(isSpeakingClip(HqClip.Talk, 0)).toBe(true);
    expect(isSpeakingClip(HqClip.Talk, 3)).toBe(true);
    expect(isSpeakingClip(HqClip.Idle, 1)).toBe(false);
    expect(isSpeakingClip(HqClip.StandListen, 1)).toBe(false);
    const [t0, t1] = HQ_CLIP_INFO.SitTurnL.talkWindow!;
    const [h0, h1] = HQ_CLIP_INFO.SitTurnL.hold!;
    expect(t0).toBeCloseTo(h0, 9);
    // The talk half is exactly the first half of the hold.
    expect(t1 - t0).toBeCloseTo((h1 - h0) / 2, 9);
    expect(isSpeakingClip(HqClip.SitTurnL, (t0 + t1) / 2)).toBe(true);
    expect(isSpeakingClip(HqClip.SitTurnR, t1 + 0.5)).toBe(false);
    expect(isSpeakingClip(HqClip.SitTurnL, 0.1)).toBe(false);
  });

  it("holds intro/hold/outro clips inside their one-shot length, the base pose at both ends", () => {
    for (const name of HQ_CLIPS) {
      const info = HQ_CLIP_INFO[name];
      if (!info.hold) continue;
      expect(info.loop, name).toBe(false);
      expect(info.hold[0], name).toBeGreaterThan(0.3);
      expect(info.hold[1], name).toBeLessThan(info.duration - 0.3);
      expect(info.hold[1] - info.hold[0], name).toBeGreaterThan(2);
    }
  });
});

describe("the shoulder place", () => {
  it("stands behind the sitter's right shoulder, clear of the chair and of the neighbours' chairs", () => {
    const layout = generateHqLayout(300);
    // Behind the chair back and on the sitter's right (-X).
    expect(HQ_SHOULDER.z).toBeLessThan(-0.31);
    expect(HQ_SHOULDER.x).toBeLessThan(0);
    expect(Math.hypot(HQ_SHOULDER.x, HQ_SHOULDER.z)).toBeGreaterThan(0.6);
    // The hand rests on the chair back's right top corner (the back reclines to z -0.33 at its top).
    expect(HQ_SHOULDER.hand.z).toBeGreaterThanOrEqual(-0.34);
    expect(HQ_SHOULDER.hand.z).toBeLessThanOrEqual(-0.25);
    expect(HQ_SHOULDER.hand.x).toBeLessThan(-0.15);
    expect(HQ_SHOULDER.hand.y).toBeGreaterThan(1.05);
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

describe("seated neighbours", () => {
  for (const capacity of [100, 300, 1000] as const) {
    it(`finds the desk beside each sitter, left and right, in the same row (${capacity})`, () => {
      const layout = generateHqLayout(capacity);
      const nb = buildDeskNeighbourhood(layout.desks, layout.arena);
      const { left, right } = seatedNeighbours(layout.desks, nb);
      let pairs = 0;
      layout.desks.forEach((d, i) => {
        for (const [e, side] of [
          [left[i], 1],
          [right[i], -1],
        ] as const) {
          if (e < 0) continue;
          pairs++;
          const o = layout.desks[e];
          expect(nb.row[e]).toBe(nb.row[i]);
          // In d's frame (+X the sitter's left): 1.2-2 m to that side, about level.
          const dx = o.x - d.x;
          const dz = o.z - d.z;
          const lx = dx * Math.cos(d.rotY) - dz * Math.sin(d.rotY);
          const lz = dx * Math.sin(d.rotY) + dz * Math.cos(d.rotY);
          expect(Math.sign(lx)).toBe(side);
          expect(Math.abs(lx)).toBeGreaterThan(1.2);
          expect(Math.abs(lx)).toBeLessThan(2);
          expect(Math.abs(lz)).toBeLessThan(0.4);
          // ...and the neighbour sees this desk on its other side.
          expect(side > 0 ? right[e] : left[e]).toBe(i);
        }
      });
      // Nearly every desk has someone beside it.
      expect(pairs).toBeGreaterThan(layout.desks.length);
    });
  }
});
