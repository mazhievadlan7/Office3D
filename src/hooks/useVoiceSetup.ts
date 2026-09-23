"use client";

import { useEffect, useState } from "react";
import type { VoiceSetup } from "@/lib/voice/agentVoices";

/** The server's voice setup (providers, readiness, offered voices), fetched once. */
export const useVoiceSetup = () => {
  const [setup, setSetup] = useState<VoiceSetup | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/office/voice/config", { cache: "no-store" })
      .then((response) => (response.ok ? (response.json() as Promise<VoiceSetup>) : null))
      .then((value) => {
        if (!cancelled && value?.tts) setSetup(value);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return setup;
};
