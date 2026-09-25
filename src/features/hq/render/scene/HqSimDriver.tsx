"use client";

import { useRef, type MutableRefObject } from "react";
import { useFrame } from "@react-three/fiber";

import { HQ_STATUS_CODE } from "../../core/types";
import type { HqSimulation } from "../../core/sim";

// A long frame (tab switch, GC) must not teleport walkers through walls.
const MAX_STEP = 0.1;
const ACTIVITY_SAMPLE_SECONDS = 0.25;

/**
 * Advances the simulation once per frame, first thing (priority -100), so the
 * camera and every renderer read the same, current frame. Also keeps the
 * map's activity level: the share of agents at work, eased so the hologram
 * breathes rather than jumps.
 */
export function HqSimDriver({
  simRef,
  activityRef,
}: {
  simRef: MutableRefObject<HqSimulation | null>;
  activityRef: MutableRefObject<number>;
}) {
  const sampleClock = useRef(0);
  const activityTarget = useRef(0);

  useFrame((state, delta) => {
    const sim = simRef.current;
    if (!sim) return;
    const dt = Math.min(Math.max(delta, 0), MAX_STEP);
    sim.update(dt, state.clock.elapsedTime);

    sampleClock.current += dt;
    if (sampleClock.current >= ACTIVITY_SAMPLE_SECONDS) {
      sampleClock.current = 0;
      const frame = sim.frame;
      let working = 0;
      for (let i = 0; i < frame.count; i += 1) {
        if (frame.status[i] === HQ_STATUS_CODE.working) working += 1;
      }
      activityTarget.current = frame.count > 0 ? working / frame.count : 0;
    }
    activityRef.current += (activityTarget.current - activityRef.current) * Math.min(1, dt * 1.5);
  }, -100);

  return null;
}
