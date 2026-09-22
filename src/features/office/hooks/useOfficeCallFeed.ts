"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { isTerminalCallStatus, type CallRecord } from "@/lib/telephony/types";

/**
 * The office's live call feed.
 *
 * Polls rather than streams. The call store lives in the server process, so
 * there is one place to read from and a poll is honest about that; a stream
 * would imply the server is pushing the provider's updates as they land, when
 * in fact it is reading the conversation on a timer either way. When the feed
 * moves to a shared store and provider webhooks, this is the seam to replace.
 *
 * Polling only runs while something is live: an office with no call on the
 * line costs nothing.
 */

const LIVE_POLL_MS = 3000;
const IDLE_POLL_MS = 30000;

export type VoiceAgentReadiness = {
  provider: string;
  configured: boolean;
  missing: string[];
};

export type CallFeed = {
  ready: boolean;
  voiceAgent: VoiceAgentReadiness | null;
  calls: CallRecord[];
  /** Calls the server could not read this round, by sid. */
  syncErrors: Record<string, string>;
  loading: boolean;
  /** Set when the feed itself could not be read at all. */
  error: string | null;
  dialing: boolean;
  dialError: string | null;
  refresh: () => Promise<void>;
  placeCall: (params: { toNumber: string; agentId: string }) => Promise<CallRecord | null>;
};

const readError = async (response: Response, fallback: string): Promise<string> => {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error.trim()) return body.error;
  } catch {
    // A non-JSON body from a proxy or a crash; the status is all we have.
  }
  return `${fallback} (HTTP ${response.status})`;
};

export const useOfficeCallFeed = ({ enabled = true }: { enabled?: boolean } = {}): CallFeed => {
  const [calls, setCalls] = useState<CallRecord[]>([]);
  const [voiceAgent, setVoiceAgent] = useState<VoiceAgentReadiness | null>(null);
  const [ready, setReady] = useState(false);
  const [syncErrors, setSyncErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dialing, setDialing] = useState(false);
  const [dialError, setDialError] = useState<string | null>(null);

  // Guards a slow response from overwriting a newer one, which on a live feed
  // would show the operator a transcript that has since moved on.
  const requestIdRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setLoading(true);
    try {
      const response = await fetch("/api/telephony/calls", { cache: "no-store" });
      if (!response.ok) {
        throw new Error(await readError(response, "The call feed could not be read"));
      }
      const body = (await response.json()) as {
        ready?: boolean;
        voiceAgent?: VoiceAgentReadiness;
        calls?: CallRecord[];
        syncErrors?: Record<string, string>;
      };
      if (!mountedRef.current || requestId !== requestIdRef.current) return;
      setReady(Boolean(body.ready));
      setVoiceAgent(body.voiceAgent ?? null);
      setCalls(body.calls ?? []);
      setSyncErrors(body.syncErrors ?? {});
      setError(null);
    } catch (err) {
      if (!mountedRef.current || requestId !== requestIdRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mountedRef.current && requestId === requestIdRef.current) {
        setLoading(false);
      }
    }
  }, [enabled]);

  const hasLiveCall = calls.some((call) => !isTerminalCallStatus(call.status));

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const interval = window.setInterval(
      () => {
        void refresh();
      },
      hasLiveCall ? LIVE_POLL_MS : IDLE_POLL_MS,
    );
    return () => window.clearInterval(interval);
  }, [enabled, hasLiveCall, refresh]);

  const placeCall = useCallback(
    async ({ toNumber, agentId }: { toNumber: string; agentId: string }) => {
      setDialing(true);
      setDialError(null);
      try {
        const response = await fetch("/api/telephony/calls", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ toNumber, agentId }),
        });
        if (!response.ok) {
          throw new Error(await readError(response, "The call could not be placed"));
        }
        const body = (await response.json()) as { call?: CallRecord };
        const call = body.call ?? null;
        if (call && mountedRef.current) {
          // Shown immediately rather than waiting for the next poll: the
          // operator pressed call and needs to see it ringing.
          setCalls((current) => [call, ...current.filter((entry) => entry.sid !== call.sid)]);
        }
        return call;
      } catch (err) {
        if (mountedRef.current) {
          setDialError(err instanceof Error ? err.message : String(err));
        }
        return null;
      } finally {
        if (mountedRef.current) setDialing(false);
      }
    },
    [],
  );

  return {
    ready,
    voiceAgent,
    calls,
    syncErrors,
    loading,
    error,
    dialing,
    dialError,
    refresh,
    placeCall,
  };
};
