"use client";

import { useFrame } from "@react-three/fiber";
import { useEffect, type MutableRefObject } from "react";
import type { HqAgentInput } from "@/features/hq/core/types";
import type { HqQuality } from "@/features/hq/render/scene/quality";
import type { HqScreenHub } from "./screenHub";

type Props = {
  screens: HqScreenHub;
  agentsRef: MutableRefObject<HqAgentInput[]>;
  quality: HqQuality;
};

/** Repaints the screens that are due, before the renderers draw (frame order 0). */
export function HqScreenDriver({ screens, agentsRef, quality }: Props) {
  useEffect(() => screens.setQuality(quality), [screens, quality]);
  useFrame((state) => screens.update(state.clock.elapsedTime, agentsRef.current), -10);
  return null;
}
