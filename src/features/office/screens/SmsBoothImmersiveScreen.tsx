"use client";

import { CheckCheck, MessageSquareText, Send, Smartphone } from "lucide-react";

import type { MessageStatus } from "@/lib/messaging/types";

/**
 * The messaging booth, showing a message that was actually sent.
 *
 * The booth used to invent the recipient's reply and report "Delivered" for
 * something that never left the building. It now shows what the office sent
 * and what the provider said about it, and nothing else — the office has no
 * inbound channel, so there are no replies to show.
 */

export type TextMessageStep =
  | "composing"
  | "sending"
  | "sent"
  | "failed";

export type BoothMessageView = {
  /** Who it went to, as it was addressed. */
  recipient: string;
  /** What the office sent. */
  text: string;
  status: MessageStatus | null;
  errorMessage: string | null;
};

export function SmsBoothImmersiveScreen({
  message,
  step,
  typedMessage,
  activeKey,
}: {
  message: BoothMessageView;
  step: TextMessageStep;
  typedMessage: string;
  activeKey: string | null;
}) {
  const statusLabel =
    step === "composing"
      ? "Composing"
      : step === "sending"
        ? "Sending"
        : step === "sent"
            // "Sent", not "Delivered": the provider accepted it, and only a
            // delivery receipt would say it reached a handset.
            ? "Sent"
            : "Not sent";
  const messageBody = typedMessage || message.text || "";

  return (
    <div className="absolute inset-0 overflow-hidden bg-[radial-gradient(circle_at_top,#0f172a_0%,#050816_48%,#02030a_100%)] text-white">
      <div className="pointer-events-none absolute inset-0 opacity-20 [background-image:linear-gradient(rgba(56,189,248,0.08)_1px,transparent_1px),linear-gradient(90deg,rgba(56,189,248,0.08)_1px,transparent_1px)] [background-size:22px_22px]" />
      <div className="relative flex h-full items-center justify-center px-8 py-10">
        <div className="grid w-full max-w-5xl grid-cols-[1fr_0.92fr] gap-10">
          <div className="rounded-[32px] border border-sky-300/18 bg-slate-950/65 p-8 shadow-[0_24px_90px_rgba(2,8,23,0.75)]">
            <div className="flex items-center gap-3 text-[11px] uppercase tracking-[0.28em] text-sky-200/70">
              <MessageSquareText className="h-4 w-4" />
              Messaging Booth
            </div>
            <div className="mt-4 text-4xl font-semibold tracking-[0.08em] text-sky-50">
              {message.recipient}
            </div>
            <div className="mt-2 text-sm uppercase tracking-[0.24em] text-sky-200/55">
              {statusLabel}
            </div>
            <div className="mt-8 rounded-[28px] border border-sky-300/16 bg-slate-900/90 p-6">
              <div className="flex items-center justify-between text-[11px] uppercase tracking-[0.24em] text-sky-200/60">
                <span>Typing from booth</span>
                <span>iPhone relay</span>
              </div>
              <div className="mt-5 rounded-[24px] border border-slate-700 bg-slate-950/80 px-5 py-4 text-base leading-7 text-sky-50">
                {messageBody || "Waiting for the first characters."}
                {step === "composing" ? <span className="ml-1 inline-block animate-pulse">|</span> : null}
              </div>
              <div className="mt-5 flex items-center justify-end gap-3 text-sm uppercase tracking-[0.22em]">
                <div className="inline-flex items-center gap-2 rounded-2xl border border-sky-300/22 bg-sky-400/10 px-4 py-2 text-sky-100/80">
                  <Smartphone className="h-4 w-4" />
                  Active
                </div>
                <div className="inline-flex items-center gap-2 rounded-2xl border border-emerald-300/24 bg-emerald-400/10 px-4 py-2 text-emerald-100/80">
                  {step === "sending" ? <Send className="h-4 w-4" /> : <CheckCheck className="h-4 w-4" />}
                  {step === "composing" ? "Drafting" : statusLabel}
                </div>
              </div>
            </div>
          </div>

          <div className="flex items-center justify-center">
            <div className="relative h-[74vh] max-h-[720px] w-[360px] rounded-[44px] border border-sky-200/20 bg-[#020617] p-3 shadow-[0_30px_120px_rgba(0,0,0,0.78)]">
              <div className="absolute left-1/2 top-3 h-1.5 w-28 -translate-x-1/2 rounded-full bg-slate-700" />
              <div className="relative flex h-full flex-col overflow-hidden rounded-[34px] border border-sky-300/12 bg-[linear-gradient(180deg,#081225_0%,#020617_100%)] px-5 py-6">
                <div className="flex items-center justify-between text-[11px] uppercase tracking-[0.24em] text-sky-200/65">
                  <span>Messages</span>
                  <Smartphone className="h-4 w-4" />
                </div>
                <div className="mt-5 text-center">
                  <div className="text-[13px] uppercase tracking-[0.26em] text-sky-200/55">
                    {statusLabel}
                  </div>
                  <div className="mt-2 text-2xl font-semibold text-sky-50">
                    {message.recipient}
                  </div>
                </div>
                <div className="mt-6 flex-1">
                    <div className="space-y-4">
                      <Bubble
                        align="right"
                        label="Agent"
                        text={messageBody || "Starting draft."}
                        tone="primary"
                      />
                      {step === "sent" ? (
                        <div className="text-right text-[11px] uppercase tracking-[0.2em] text-sky-200/45">
                          Sent
                        </div>
                      ) : null}
                      {step === "failed" ? (
                        <div className="rounded-[20px] border border-rose-400/40 bg-rose-500/12 px-4 py-3 text-sm text-rose-100">
                          {message.errorMessage ?? "The message was not sent."}
                        </div>
                      ) : null}
                  </div>
                </div>
                <div className="mt-4 rounded-[24px] border border-sky-300/14 bg-slate-950/75 p-3">
                  <PhoneKeyboard activeKey={activeKey} />
                </div>
                <div className="rounded-[24px] border border-sky-300/14 bg-slate-950/70 px-4 py-3 text-sm text-sky-100/78">
                  {statusLabel}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const KEYBOARD_ROWS = [
  ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
  ["a", "s", "d", "f", "g", "h", "j", "k", "l"],
  ["z", "x", "c", "v", "b", "n", "m", ",", ".", "?"],
] as const;

function PhoneKeyboard({ activeKey }: { activeKey: string | null }) {
  return (
    <div className="space-y-2">
      {KEYBOARD_ROWS.map((row, rowIndex) => (
        <div
          key={row.join("")}
          className={`flex gap-2 ${rowIndex === 1 ? "px-3" : rowIndex === 2 ? "px-6" : ""}`}
        >
          {row.map((keyValue) => (
            <KeyboardKey
              key={keyValue}
              label={keyValue}
              active={activeKey === keyValue}
            />
          ))}
        </div>
      ))}
      <div className="flex items-center gap-2">
        <KeyboardKey label="123" active={false} className="w-[18%]" />
        <KeyboardKey label="space" active={activeKey === "space"} className="flex-1" />
        <KeyboardKey label="return" active={activeKey === "return"} className="w-[22%]" />
      </div>
    </div>
  );
}

function KeyboardKey({
  label,
  active,
  className = "",
}: {
  label: string;
  active: boolean;
  className?: string;
}) {
  return (
    <div
      className={`flex h-9 min-w-0 flex-1 items-center justify-center rounded-2xl border text-[12px] font-medium uppercase tracking-[0.12em] transition-all duration-100 ${
        active
          ? "scale-[0.96] border-sky-200/70 bg-sky-300/30 text-sky-50 shadow-[0_0_20px_rgba(56,189,248,0.25)]"
          : "border-slate-700/90 bg-slate-800/90 text-slate-200"
      } ${className}`}
    >
      {label}
    </div>
  );
}

function Bubble({
  align,
  label,
  text,
  tone,
}: {
  align: "left" | "right";
  label: string;
  text: string;
  tone: "primary" | "secondary";
}) {
  return (
    <div className={align === "right" ? "ml-10" : "mr-10"}>
      <div
        className={`rounded-[24px] border px-4 py-4 ${
          tone === "primary"
            ? "border-sky-300/18 bg-sky-400/10 text-sky-50"
            : "border-slate-700 bg-slate-900/90 text-slate-100"
        }`}
      >
        <div className="text-[10px] uppercase tracking-[0.22em] opacity-60">{label}</div>
        <div className="mt-2 text-sm leading-6">{text}</div>
      </div>
    </div>
  );
}
