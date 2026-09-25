"use client";

import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";

import type { HqQuality } from "./quality";
import { HqQualityGovernor, tierForQuality, type HqQualityTier } from "./qualityGovernor";

export type HqQualityMode = "auto" | HqQuality;

/**
 * Walks the quality ladder from measured frame times (see qualityGovernor).
 * In a manual mode it pins the best tier of that level and stops measuring.
 *
 * It only reports the tier index; the owner turns that into the Canvas `dpr`
 * prop and the quality level, because R3F re-applies `dpr` from props on
 * every Canvas render and would undo a setDpr made from in here. Changes are
 * rare by design, so React sees a handful of updates per session.
 */
export function HqAdaptiveQuality({
  tiers,
  mode,
  onTierChange,
}: {
  tiers: readonly HqQualityTier[];
  mode: HqQualityMode;
  onTierChange: (tierIndex: number) => void;
}) {
  const governor = useMemo(() => new HqQualityGovernor(tiers.length, 0), [tiers]);
  const report = useRef(onTierChange);

  useEffect(() => {
    report.current = onTierChange;
  });

  useEffect(() => {
    // Back to auto continues measuring from the pinned tier.
    if (mode !== "auto") governor.pin(tierForQuality(tiers, mode));
    report.current(governor.tier);
  }, [mode, governor, tiers]);

  // A hidden tab stops the loop; restart measuring when it comes back.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "visible") governor.reset();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [governor]);

  useFrame((_, delta) => {
    if (mode !== "auto") return;
    const next = governor.sample(delta);
    if (next >= 0) report.current(next);
  });

  return null;
}
