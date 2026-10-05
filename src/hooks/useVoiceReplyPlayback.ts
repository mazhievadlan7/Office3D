"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { VoiceReplyProvider } from "@/lib/voiceReply/provider";
import { t } from "@/lib/i18n";
import { acquireForegroundSpeech, SPEECH_PRIORITY } from "@/lib/voice/speechDuck";
import { splitSpeech } from "@/lib/voice/speechChunks";

export type VoiceReplyPlaybackRequest = {
  text: string;
  provider?: VoiceReplyProvider;
  voiceId?: string | null;
  speed?: number;
};

const normalizeVoiceReplyText = (value: string): string => {
  return value.replace(/\s+/g, " ").trim();
};

export const useVoiceReplyPlayback = (params: {
  enabled: boolean;
  provider?: VoiceReplyProvider;
  voiceId?: string | null;
  speed?: number;
}) => {
  const { enabled, provider = "local-speech", voiceId = null, speed = 1 } = params;
  const queueRef = useRef<VoiceReplyPlaybackRequest[]>([]);
  const processingRef = useRef(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  /** Ends the duck of the HQ's crew talk for what is playing now (see lib/voice/speechDuck). */
  const duckRef = useRef<(() => void) | null>(null);
  const [playing, setPlaying] = useState(false);

  const releaseAudio = useCallback(() => {
    duckRef.current?.();
    duckRef.current = null;
    const source = sourceRef.current;
    if (source) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        /* ignore */
      }
      source.disconnect();
      sourceRef.current = null;
    }
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.src = "";
      audioRef.current = null;
    }
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
    }
  }, []);

  const getAudioContext = useCallback(() => {
    if (typeof window === "undefined") return null;
    if (audioContextRef.current) return audioContextRef.current;
    const AudioContextCtor =
      window.AudioContext ||
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((window as any).webkitAudioContext as typeof AudioContext | undefined);
    if (!AudioContextCtor) return null;
    audioContextRef.current = new AudioContextCtor();
    return audioContextRef.current;
  }, []);

  const stop = useCallback(() => {
    generationRef.current += 1;
    queueRef.current = [];
    abortRef.current?.abort();
    abortRef.current = null;
    releaseAudio();
    setPlaying(false);
  }, [releaseAudio]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const unlockAudio = () => {
      const context = getAudioContext();
      if (!context || context.state !== "suspended") return;
      void context.resume().catch(() => {
        /* ignore */
      });
    };
    window.addEventListener("pointerdown", unlockAudio, true);
    window.addEventListener("keydown", unlockAudio, true);
    return () => {
      window.removeEventListener("pointerdown", unlockAudio, true);
      window.removeEventListener("keydown", unlockAudio, true);
    };
  }, [getAudioContext]);

  const playBlob = useCallback(
    async (blob: Blob, generation: number) => {
      if (generation !== generationRef.current) return;
      releaseAudio();
      // Take the single foreground-speech turn before any sound: a reply never
      // plays over the greeting, a briefing or a council. The lead (briefing /
      // council) outranks a reply and pre-empts it (lease.signal aborts). The
      // lease ducks the crew for its lifetime and is dropped on stop/unmount.
      const lease = await acquireForegroundSpeech({
        priority: SPEECH_PRIORITY.reply,
        external: abortRef.current?.signal,
      });
      if (!lease || generation !== generationRef.current) {
        lease?.release();
        return;
      }
      duckRef.current = lease.release;
      lease.signal.addEventListener("abort", () => releaseAudio(), { once: true });
      const audioContext = getAudioContext();
      if (audioContext) {
        try {
          if (audioContext.state === "suspended") {
            await audioContext.resume();
          }
          const buffer = await blob.arrayBuffer();
          const decoded = await audioContext.decodeAudioData(buffer.slice(0));
          if (generation !== generationRef.current || lease.signal.aborted) {
            lease.release();
            return;
          }
          const source = audioContext.createBufferSource();
          source.buffer = decoded;
          source.connect(audioContext.destination);
          sourceRef.current = source;
          setPlaying(true);
          await new Promise<void>((resolve, reject) => {
            source.onended = () => {
              resolve();
            };
            try {
              source.start();
            } catch (error) {
              reject(error);
            }
          }).finally(() => {
            lease.release();
            if (sourceRef.current === source) {
              source.disconnect();
              sourceRef.current = null;
            }
            setPlaying(false);
          });
          return;
        } catch (error) {
          console.warn("AudioContext playback fallback engaged.", error);
          releaseAudio();
        }
      }
      const nextUrl = URL.createObjectURL(blob);
      audioUrlRef.current = nextUrl;
      const audio = new Audio(nextUrl);
      audioRef.current = audio;
      setPlaying(true);
      duckRef.current = lease.release;
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          audio.removeEventListener("ended", handleDone);
          audio.removeEventListener("pause", handleDone);
          audio.removeEventListener("error", handleError);
        };
        const handleDone = () => {
          cleanup();
          resolve();
        };
        const handleError = () => {
          cleanup();
          reject(new Error(t("libHooks.voiceReplyPlaybackFailed")));
        };
        audio.addEventListener("ended", handleDone);
        audio.addEventListener("pause", handleDone);
        audio.addEventListener("error", handleError);
        audio.play().catch((error) => {
          cleanup();
          reject(error);
        });
      }).finally(() => {
        lease.release();
        if (audioRef.current === audio) {
          audioRef.current = null;
        }
        setPlaying(false);
        if (audioUrlRef.current === nextUrl) {
          URL.revokeObjectURL(nextUrl);
          audioUrlRef.current = null;
        }
      });
    },
    [getAudioContext, releaseAudio]
  );

  const requestAudio = useCallback(
    async (request: VoiceReplyPlaybackRequest, signal: AbortSignal) => {
      const response = await fetch("/api/office/voice/reply", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text: request.text,
          provider: request.provider ?? provider,
          voiceId: request.voiceId ?? voiceId,
          speed: request.speed ?? speed,
        }),
        signal,
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(body?.error?.trim() || t("libHooks.voiceReplyRequestFailed"));
      }
      return response.blob();
    },
    [provider, speed, voiceId]
  );

  const drainQueue = useCallback(async () => {
    if (processingRef.current) return;
    processingRef.current = true;
    // One request runs ahead: while a sentence plays, the next one renders,
    // so a long reply has no gap the length of a synthesis between sentences.
    // Both share one controller, so stop() aborts the playing and the next.
    let ahead: { generation: number; blob: Promise<Blob> } | null = null;
    const start = (request: VoiceReplyPlaybackRequest) => {
      const controller = abortRef.current ?? new AbortController();
      abortRef.current = controller;
      const blob = requestAudio(request, controller.signal);
      // Handled when awaited; this only keeps an early failure from being unhandled.
      blob.catch(() => {});
      return { generation: generationRef.current, blob };
    };
    try {
      while (ahead || queueRef.current.length > 0) {
        if (!enabled) {
          queueRef.current = [];
          break;
        }
        let current = ahead;
        ahead = null;
        if (!current || current.generation !== generationRef.current) {
          const nextRequest = queueRef.current.shift();
          if (!nextRequest) continue;
          current = start(nextRequest);
        }
        try {
          const blob = await current.blob;
          const following = queueRef.current.shift();
          if (following && current.generation === generationRef.current) ahead = start(following);
          await playBlob(blob, current.generation);
          if (!ahead) abortRef.current = null;
        } catch (error) {
          if (!ahead) abortRef.current = null;
          if (
            error instanceof DOMException &&
            (error.name === "AbortError" || error.name === "NotAllowedError")
          ) {
            continue;
          }
          console.error("Failed to play voice reply.", error);
        }
      }
    } finally {
      processingRef.current = false;
      setPlaying(false);
    }
  }, [enabled, playBlob, requestAudio]);

  const enqueue = useCallback(
    (request: VoiceReplyPlaybackRequest) => {
      const text = normalizeVoiceReplyText(request.text);
      if (!text || !enabled) return;
      // Sentence by sentence: the first sentence starts playing while the
      // rest is still being synthesised.
      for (const piece of splitSpeech(text)) {
        queueRef.current.push({
          text: piece,
          provider: request.provider ?? provider,
          voiceId: request.voiceId ?? voiceId,
          speed: request.speed ?? speed,
        });
      }
      void drainQueue();
    },
    [drainQueue, enabled, provider, speed, voiceId]
  );

  const preview = useCallback(
    async (request: VoiceReplyPlaybackRequest) => {
      const text = normalizeVoiceReplyText(request.text);
      if (!text) return;
      stop();
      const generation = generationRef.current;
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const blob = await requestAudio(
          {
            text,
            provider: request.provider ?? provider,
            voiceId: request.voiceId ?? voiceId,
            speed: request.speed ?? speed,
          },
          controller.signal
        );
        abortRef.current = null;
        await playBlob(blob, generation);
      } catch (error) {
        abortRef.current = null;
        if (
          error instanceof DOMException &&
          (error.name === "AbortError" || error.name === "NotAllowedError")
        ) {
          return;
        }
        console.error("Failed to preview voice reply.", error);
      }
    },
    [playBlob, provider, requestAudio, speed, stop, voiceId]
  );

  useEffect(() => {
    if (enabled) return;
    stop();
  }, [enabled, stop]);

  useEffect(() => {
    return () => {
      stop();
      const audioContext = audioContextRef.current;
      audioContextRef.current = null;
      if (audioContext && audioContext.state !== "closed") {
        void audioContext.close().catch(() => {
          /* ignore */
        });
      }
    };
  }, [stop]);

  return {
    enqueue,
    preview,
    stop,
    playing,
  };
};
