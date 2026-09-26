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

/**
 * Uploads the screens' new frames (painted in a worker) before the renderers
 * draw, and tells the hub where the camera is looking so only the big
 * screens in view repaint at full rate.
 */
export function HqScreenDriver({ screens, agentsRef, quality }: Props) {
  useEffect(() => screens.setQuality(quality), [screens, quality]);
  useFrame((state) => screens.update(state.clock.elapsedTime, agentsRef.current, state.gl, state.camera), -10);
  return null;
}
