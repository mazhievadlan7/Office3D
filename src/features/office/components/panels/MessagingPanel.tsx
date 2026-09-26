"use client";

import { AlertTriangle, MessageSquareText, Send, X } from "lucide-react";
import { useEffect, useState } from "react";

import type { OfficeMessaging } from "@/features/office/hooks/useOfficeMessaging";
import { LOCALE, t } from "@/lib/i18n";
import type { MessageRecord } from "@/lib/messaging/types";

/**
 * The office messaging booth.
 *
 * WhatsApp will not carry free-form text to someone who has not messaged you
 * recently, so the office sends an approved template and fills its one body
 * parameter. The panel says so, because a composer that looked like a chat
 * would mislead about what the recipient actually receives.
 */

export type MessageRequestDraft = {
  agentId: string;
  recipient: string;
  message: string | null;
};

export type MessagingAgent = {
  agentId: string;
  name: string;
};

const formatTime = (iso: string): string => {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? "" : at.toLocaleString(LOCALE);
};

export function MessagingPanel({
  messaging,
  agents,
  draft = null,
}: {
  messaging: OfficeMessaging;
  agents: MessagingAgent[];
  draft?: MessageRequestDraft | null;
}) {
  const [to, setTo] = useState("");
  const [typedText, setTypedText] = useState<string | null>(null);
  const [pickedAgentId, setPickedAgentId] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);

  // Derived rather than synced through an effect: the request's message is the
  // starting text until the operator edits it, and a new request replaces it.
  const text = typedText ?? draft?.message ?? "";
  const setText = setTypedText;

  const preferredAgentId = pickedAgentId ?? draft?.agentId ?? null;
  const agentId =
    preferredAgentId && agents.some((agent) => agent.agentId === preferredAgentId)
      ? preferredAgentId
      : (agents[0]?.agentId ?? "");

  const canSend =
    messaging.ready && !messaging.sending && to.trim().length > 0 && text.trim().length > 0 && agentId.length > 0;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSend) return;
    const sender = agents.find((agent) => agent.agentId === agentId);
    if (!sender) return;
    const failure = await messaging.send({
      to: to.trim(),
      text: text.trim(),
      agentId,
      agentName: sender.name,
    });
    setSendError(failure);
    if (!failure) setText("");
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 text-white">
      <header className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.28em] text-red-400">
        <MessageSquareText className="h-4 w-4" aria-hidden="true" />
        {t("messaging.title")}
      </header>

      {!messaging.ready && messaging.messaging ? (
        <Notice tone="warn">
          {t("messaging.notReady")}
          <span className="font-mono">{messaging.messaging.missing.join(", ")}</span>.
        </Notice>
      ) : null}
      {messaging.error ? <Notice tone="error">{messaging.error}</Notice> : null}

      {draft ? (
        <div className="rounded-md border border-red-600/35 border-l-2 border-l-red-500 bg-red-950/25 px-3 py-2.5 text-xs text-white/85">
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-red-400">
            {t("request.requested")}
          </div>
          <div className="mt-1">
            {t("request.messageVerb")} <span className="font-medium text-white">{draft.recipient}</span>
          </div>
          {/* A name is not a number, and a message costs money and reaches a
              stranger; the operator supplies the number. */}
          <div className="mt-1 text-white/55">{t("request.enterNumberMessage")}</div>
        </div>
      ) : null}

      <form
        onSubmit={submit}
        className="grid gap-3 rounded-lg border border-red-900/40 bg-[#0b0707] p-4"
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-white/45">
            {t("messaging.numberLabel")}
            <input
              value={to}
              onChange={(event) => setTo(event.target.value)}
              placeholder="+441234567890"
              inputMode="tel"
              className="rounded-md border border-red-900/50 bg-black/60 px-3 py-2 font-mono text-sm normal-case tracking-normal text-white placeholder:text-white/35 focus:border-red-500/70 focus:outline-none focus:ring-1 focus:ring-red-500/30"
            />
          </label>
          <label className="flex flex-col gap-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-white/45">
            {t("messaging.sendingAs")}
            <select
              value={agentId}
              onChange={(event) => setPickedAgentId(event.target.value)}
              className="rounded-md border border-red-900/50 bg-black/60 px-3 py-2 font-sans text-sm normal-case tracking-normal text-white [color-scheme:dark] focus:border-red-500/70 focus:outline-none focus:ring-1 focus:ring-red-500/30"
            >
              {agents.length === 0 ? <option value="">{t("phone.noAgents")}</option> : null}
              {agents.map((agent) => (
                <option key={agent.agentId} value={agent.agentId}>
                  {agent.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="flex flex-col gap-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-white/45">
          {t("messaging.messageLabel")}
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            rows={3}
            placeholder={t("messaging.messagePlaceholder")}
            className="resize-none rounded-md border border-red-900/50 bg-black/60 px-3 py-2 font-sans text-sm normal-case tracking-normal text-white placeholder:text-white/35 focus:border-red-500/70 focus:outline-none focus:ring-1 focus:ring-red-500/30"
          />
        </label>
        <div className="flex items-center gap-2 rounded-md border border-orange-400/25 bg-orange-500/[0.07] px-3 py-2 text-[11px] text-orange-300">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {/* Said plainly, because it changes what the recipient sees. */}
          {t("messaging.templateNotice")}
        </div>
        <button
          type="submit"
          disabled={!canSend}
          className="inline-flex h-[38px] items-center justify-center gap-2 self-start rounded-md border border-red-500/60 bg-[#e3141c] px-4 text-sm font-medium text-white shadow-[0_0_14px_rgba(255,26,26,0.25)] transition hover:border-red-400/70 hover:bg-[#ff2a2a] disabled:cursor-not-allowed disabled:border-red-900/40 disabled:bg-red-950/30 disabled:text-white/35 disabled:shadow-none"
        >
          <Send className="h-4 w-4" />
          {messaging.sending ? t("messaging.sending") : t("common.send")}
        </button>
        {sendError ? <Notice tone="error">{sendError}</Notice> : null}
      </form>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
        {messaging.messages.length === 0 ? (
          <div className="rounded-md border border-dashed border-red-900/50 px-3 py-6 text-center text-xs text-white/45">
            {t("messaging.nothingSent")}
          </div>
        ) : null}
        {messaging.messages.map((message) => (
          <Sent key={message.id} message={message} />
        ))}
      </div>
    </div>
  );
}

function Sent({ message }: { message: MessageRecord }) {
  return (
    <div className="rounded-md border border-red-900/40 bg-[#0b0707] px-3 py-2.5">
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span className="font-mono tabular-nums text-white">+{message.to}</span>
        <span
          className={`rounded-full border px-2 py-0.5 font-mono uppercase tracking-[0.14em] ${
            message.status === "failed"
              ? "border-red-500/50 bg-red-950/40 text-red-400"
              : "border-red-600/35 bg-red-600/10 text-white/80"
          }`}
        >
          {/* "Sent", never "Delivered": the provider accepted it, and only a
              delivery receipt would say it reached a handset. */}
          {message.status === "failed" ? t("messaging.statusFailed") : t("messaging.statusSent")}
        </span>
      </div>
      <div className="mt-1.5 text-sm text-white">{message.text}</div>
      <div className="mt-1 text-[11px] tabular-nums text-white/45">
        {message.agentName} · {formatTime(message.sentAt)}
        {message.template ? ` · ${t("messaging.templateOf", { name: message.template })}` : ""}
      </div>
      {message.errorMessage ? (
        <div className="mt-1.5 text-[11px] text-red-400">{message.errorMessage}</div>
      ) : null}
    </div>
  );
}

function Notice({
  tone,
  children,
}: {
  tone: "warn" | "error";
  children: React.ReactNode;
}) {
  return (
    <div
      className={`rounded-md border px-3 py-2 text-xs ${
        tone === "error"
          ? "border-red-500/50 bg-red-950/40 text-red-400"
          : "border-orange-400/30 bg-orange-500/[0.07] text-orange-300"
      }`}
    >
      {children}
    </div>
  );
}

export function MessagingModal({
  open,
  messaging,
  agents,
  draft = null,
  onClose,
}: {
  open: boolean;
  messaging: OfficeMessaging;
  agents: MessagingAgent[];
  draft?: MessageRequestDraft | null;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[125] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={t("messaging.title")}
      onClick={onClose}
    >
      <div
        className="flex h-[min(90vh,860px)] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-red-600/35 bg-[#070404]/95 text-white shadow-[0_0_48px_rgba(255,26,26,0.12)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-red-900/40 bg-gradient-to-r from-red-950/30 via-transparent to-transparent px-5 py-4">
          <div>
            <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.22em] text-red-400">
              <span
                className="h-1.5 w-1.5 rounded-full bg-red-500 shadow-[0_0_8px_rgba(255,26,26,0.9)]"
                aria-hidden="true"
              />
              {t("messaging.boothTitle")}
            </div>
            <div className="mt-1 font-mono text-[11px] text-white/55">
              {t("messaging.boothLead")}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center gap-1 rounded-md border border-red-900/40 bg-black/40 px-2 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-white/80 transition-colors hover:border-red-500/50 hover:bg-red-950/40 hover:text-white"
          >
            <X className="h-3.5 w-3.5" />
            {t("common.close")}
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden p-5">
          <MessagingPanel messaging={messaging} agents={agents} draft={draft} />
        </div>
      </div>
    </div>
  );
}
