"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * useVoiceCapture — a tiny push-to-talk recorder for the «ГЕО» analyst.
 *
 * The hook owns the microphone lifecycle: user holds a button, we start a
 * MediaRecorder, release the button and the recorded blob is uploaded to
 * our own /api/office/voice/transcribe (GigaAM STT server-side, local-first,
 * nothing goes to a third party). The hook returns the transcript text and
 * exposes start/stop handlers for the UI. On error it surfaces a message
 * instead of throwing — the UI shows it and the globe keeps running.
 */

export type VoiceCaptureState = "idle" | "recording" | "transcribing" | "error";

const PREFERRED_MIMES = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];

function pickMime(): string {
  if (typeof MediaRecorder === "undefined") return "";
  for (const mime of PREFERRED_MIMES) if (MediaRecorder.isTypeSupported(mime)) return mime;
  return "";
}

export type UseVoiceCaptureParams = {
  /** Called with the transcript text when STT finishes. */
  onTranscript: (text: string) => void;
};

export function useVoiceCapture({ onTranscript }: UseVoiceCaptureParams) {
  const [state, setState] = useState<VoiceCaptureState>("idle");
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const mimeRef = useRef<string>("");

  const cleanup = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    recorderRef.current = null;
    chunksRef.current = [];
  }, []);

  useEffect(() => cleanup, [cleanup]);

  const start = useCallback(async () => {
    if (state === "recording" || state === "transcribing") return;
    setError(null);
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setError("Браузер не поддерживает захват микрофона.");
      setState("error");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mime = pickMime();
      mimeRef.current = mime;
      const recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) chunksRef.current.push(ev.data);
      };
      recorder.start();
      recorderRef.current = recorder;
      setState("recording");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setState("error");
      cleanup();
    }
  }, [cleanup, state]);

  const stop = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") {
      cleanup();
      setState("idle");
      return;
    }
    setState("transcribing");
    const done = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
    });
    recorder.stop();
    await done;
    const chunks = chunksRef.current;
    cleanup();
    if (chunks.length === 0) {
      setState("idle");
      return;
    }
    const blob = new Blob(chunks, { type: mimeRef.current || "audio/webm" });
    try {
      const form = new FormData();
      // The transcribe route picks the file extension from the name, so give it
      // a shape it understands even when the browser handed us webm bytes.
      const ext = (mimeRef.current || "").includes("mp4") ? "mp4" : "webm";
      form.append("audio", blob, `geo-ask.${ext}`);
      const response = await fetch("/api/office/voice/transcribe", { method: "POST", body: form });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error?.trim() || `STT ${response.status}`);
      }
      const data = (await response.json()) as { transcript?: string | null; ignored?: boolean };
      const text = (data.transcript ?? "").trim();
      if (text && !data.ignored) onTranscript(text);
      setState("idle");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setState("error");
    }
  }, [cleanup, onTranscript]);

  return { state, error, start, stop };
}
