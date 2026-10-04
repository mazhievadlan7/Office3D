"use client";

import { useEffect, useRef } from "react";

import { HqAndroidLoader } from "@/features/agents/components/HqAndroidLoader";
import { t } from "@/lib/i18n";

import { HQ_THEME } from "./core/config";

/**
 * The entry screen, shown only when the browser holds the HQ's sound back
 * (lib/office/hqEntry.ts): the android on the HQ's dark background and one
 * button. A click anywhere, Enter or Space is the gesture that unlocks the
 * audio; the fly-through and the system's greeting start with it. No text of
 * the greeting appears here: it is heard, not read.
 */
export function HqEntryGate({ onEnter }: { onEnter: () => void }) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const onEnterRef = useRef(onEnter);
  useEffect(() => {
    onEnterRef.current = onEnter;
  });

  useEffect(() => {
    buttonRef.current?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== " " && event.key !== "Spacebar") return;
      // Nothing behind the screen reacts to this key.
      event.preventDefault();
      event.stopPropagation();
      onEnterRef.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("hqEntry.enter")}
      data-testid="hq-entry-gate"
      className="fixed inset-0 z-[200] flex cursor-pointer select-none flex-col items-center justify-center gap-10"
      style={{ backgroundColor: HQ_THEME.background }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        onEnterRef.current();
      }}
    >
      <HqAndroidLoader size={240} />
      <button
        ref={buttonRef}
        type="button"
        className="rounded-md border border-red-500/55 bg-red-600/15 px-8 py-3 font-mono text-[13px] font-semibold uppercase tracking-[0.3em] text-white shadow-[0_0_24px_rgba(232,53,42,0.25)] transition-colors hover:bg-red-600/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400/70"
      >
        {t("hqEntry.enter")}
      </button>
    </div>
  );
}
