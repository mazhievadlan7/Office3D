import { describe, expect, it } from "vitest";

import { HqClip } from "@/features/hq/core/config";
import { generateHqLayout } from "@/features/hq/core/layout";
import { HqSimulation } from "@/features/hq/core/sim";
import type { HqAgentInput } from "@/features/hq/core/types";

// The creator signs in: AM7 stops typing and looks up at the viewer (the
// camera) for a few seconds, then gets back to work.
describe("HqSimulation creator acknowledgement", () => {
  const layout = generateHqLayout(300);
  const DT = 0.1;
  const people: HqAgentInput[] = [
    { id: "am7", name: "AM7", status: "working" },
    ...Array.from({ length: 40 }, (_, i) => ({ id: `agent-${i}`, name: `Agent ${i}`, status: "working" as const })),
  ];
  // Far off to the south-east, up high: where the overview camera sits.
  const camera = { x: layout.bounds.x1 + 40, y: 45, z: layout.bounds.z1 + 40 };

  const seatedLead = () => {
    const sim = new HqSimulation(layout, { seed: 5 });
    sim.setAgents(people);
    const li = () => sim.frame.ids.indexOf("am7");
    const atDesk = () => {
      const f = sim.frame;
      const i = li();
      return Math.hypot(f.x[i] - layout.leadDesk.x, f.z[i] - layout.leadDesk.z) < 0.05 && f.clip[i] === HqClip.SitType;
    };
    for (let step = 0; step < 3000 && !atDesk(); step++) sim.update(DT);
    expect(atDesk()).toBe(true);
    return { sim, li };
  };

  it("looks up at the creator from his chair, hands off the keys, then goes back to typing", () => {
    const { sim, li } = seatedLead();
    expect(sim.creatorAck).toBe(false);
    sim.setCreatorPoint(camera.x, camera.y, camera.z);
    sim.acknowledgeCreator(5);
    expect(sim.creatorAck).toBe(true);
    for (let step = 0; step < 25; step++) sim.update(DT);
    const f = sim.frame;
    const i = li();
    expect(f.clip[i]).toBe(HqClip.SitIdle);
    expect(f.lookWeight[i]).toBeGreaterThan(0.6);
    // The head is turned toward the camera, not the monitor in front of him.
    const toCamera = Math.hypot(f.lookX[i] - camera.x, f.lookZ[i] - camera.z);
    const toDesk = Math.hypot(f.lookX[i] - layout.leadDesk.x, f.lookZ[i] - layout.leadDesk.z);
    expect(toCamera).toBeLessThan(toDesk);
    // Everyone else keeps working.
    let typing = 0;
    for (let k = 0; k < f.count; k++) if (k !== i && f.clip[k] === HqClip.SitType) typing++;
    expect(typing).toBeGreaterThan(0);

    for (let step = 0; step < 60; step++) sim.update(DT);
    expect(sim.creatorAck).toBe(false);
    expect(sim.frame.clip[li()]).toBe(HqClip.SitType);
  });

  it("standing, turns to face the creator without talking over the greeting", () => {
    const sim = new HqSimulation(layout, { seed: 9 });
    // In trouble, AM7 stands beside his desk.
    sim.setAgents([{ id: "am7", name: "AM7", status: "error" }, ...people.slice(1)]);
    const li = () => sim.frame.ids.indexOf("am7");
    const standingStill = () => {
      const f = sim.frame;
      return f.clip[li()] === HqClip.Idle && Math.hypot(f.x[li()] - layout.leadDesk.x, f.z[li()] - layout.leadDesk.z) < 3;
    };
    for (let step = 0; step < 3000 && !standingStill(); step++) sim.update(DT);
    expect(standingStill()).toBe(true);
    sim.setCreatorPoint(camera.x, camera.y, camera.z);
    sim.acknowledgeCreator(6);
    for (let step = 0; step < 40; step++) sim.update(DT);
    const f = sim.frame;
    const i = li();
    const toCamera = Math.atan2(camera.x - f.x[i], camera.z - f.z[i]);
    const diff = Math.abs(((f.facing[i] - toCamera + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
    expect(diff).toBeLessThan(0.1);
    expect(f.clip[i]).toBe(HqClip.Idle);
    expect(f.lookWeight[i]).toBeGreaterThan(0.6);
  });

  it("gives way to a briefing", () => {
    const { sim, li } = seatedLead();
    sim.setCreatorPoint(camera.x, camera.y, camera.z);
    sim.acknowledgeCreator(30);
    sim.startBriefing(60);
    for (let step = 0; step < 20; step++) sim.update(DT);
    // Up and on his way to the podium, not looking at the camera.
    expect(sim.frame.clip[li()]).not.toBe(HqClip.SitIdle);
  });
});
