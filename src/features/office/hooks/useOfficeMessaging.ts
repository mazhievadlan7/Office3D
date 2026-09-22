"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { MessageRecord } from "@/lib/messaging/types";
import { t } from "@/lib/i18n";

/**
 * Messages the office has sent.
 *
 * Read once when the panel opens and after each send, rather than polled:
 * a sent message does not change on its own, and there is no inbound channel
 * for a reply to arrive through. Polling would suggest otherwise.
 */

export type MessagingReadiness = {
  provider: string;
  configured: boolean;
  missing: string[];
};

export type OfficeMessaging = {
  ready: boolean;
  messaging: MessagingReadiness | null;
  messages: MessageRecord[];
  loading: boolean;
  error: string | null;
  sending: boolean;
  refresh: () => Promise<void>;
  send: (params: {
    to: string;
    text: string;
    agentId: string;
    agentName: string;
  }) => Promise<string | null>;
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

export const useOfficeMessaging = ({
  enabled = true,
}: { enabled?: boolean } = {}): OfficeMessaging => {
  const [messages, setMessages] = useState<MessageRecord[]>([]);
  const [messaging, setMessaging] = useState<MessagingReadiness | null>(null);
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    try {
      const response = await fetch("/api/messaging/messages", { cache: "no-store" });
      if (!response.ok) {
        throw new Error(await readError(response, t("opsOffice.messagesReadFailed")));
      }
      const body = (await response.json()) as {
        ready?: boolean;
        messaging?: MessagingReadiness;
        messages?: MessageRecord[];
      };
      if (!mountedRef.current) return;
      setReady(Boolean(body.ready));
      setMessaging(body.messaging ?? null);
      setMessages(body.messages ?? []);
      setError(null);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    if (enabled) void refresh();
  }, [enabled, refresh]);

  const send = useCallback(
    async (params: { to: string; text: string; agentId: string; agentName: string }) => {
      setSending(true);
      try {
        const response = await fetch("/api/messaging/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(params),
        });
        if (!response.ok) {
          return await readError(response, t("opsOffice.messageSendFailed"));
        }
        const body = (await response.json()) as { message?: MessageRecord };
        if (body.message && mountedRef.current) {
          setMessages((current) => [body.message!, ...current]);
        }
        return null;
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      } finally {
        if (mountedRef.current) setSending(false);
      }
    },
    [],
  );

  return { ready, messaging, messages, loading, error, sending, refresh, send };
};
