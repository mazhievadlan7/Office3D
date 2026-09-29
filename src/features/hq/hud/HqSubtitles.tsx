"use client";

import { useEffect, useRef, type MutableRefObject } from "react";
import { HQ_SUBTITLE_SLOTS, type HqSubtitleSink } from "@/features/hq/render/audio/HqSoundscape";

/**
 * Caption frames (off by default: voice, not text) over the heads of agents talking near the camera
 * (render/audio/HqSoundscape.tsx). The render loop writes text and position
 * straight into these nodes through `sinkRef`; React renders them once.
 */
export function HqSubtitles({ sinkRef }: { sinkRef: MutableRefObject<HqSubtitleSink | null> }) {
  const boxes = useRef<Array<HTMLDivElement | null>>([]);
  const texts = useRef<Array<HTMLSpanElement | null>>([]);
  const shown = useRef<string[]>([]);

  useEffect(() => {
    const sink: HqSubtitleSink = {
      show(slot, text, x, y, opacity) {
        const box = boxes.current[slot];
        const span = texts.current[slot];
        if (!box || !span) return;
        if (shown.current[slot] !== text) {
          shown.current[slot] = text;
          span.textContent = text;
        }
        box.style.opacity = String(opacity);
        box.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`;
      },
      hide(slot) {
        const box = boxes.current[slot];
        if (box && box.style.opacity !== "0") box.style.opacity = "0";
      },
    };
    sinkRef.current = sink;
    return () => {
      if (sinkRef.current === sink) sinkRef.current = null;
    };
  }, [sinkRef]);

  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-[5] overflow-hidden">
      {Array.from({ length: HQ_SUBTITLE_SLOTS }, (_, slot) => (
        <div
          key={slot}
          ref={(node) => {
            boxes.current[slot] = node;
          }}
          className="absolute left-0 top-0 max-w-[260px] rounded border border-primary/45 bg-black/80 px-2.5 py-1.5 font-mono text-[11px] leading-snug text-white/90 shadow-[0_0_18px_rgba(255,26,26,0.18)] transition-opacity duration-300"
          style={{ opacity: 0, willChange: "transform, opacity" }}
        >
          <span className="mr-1 text-primary">›</span>
          <span
            ref={(node) => {
              texts.current[slot] = node;
            }}
          />
        </div>
      ))}
    </div>
  );
}
