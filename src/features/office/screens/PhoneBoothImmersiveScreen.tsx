"use client";

import { AudioLines, PhoneCall, Smartphone } from "lucide-react";

import type { CallStatus, TranscriptSpeaker } from "@/lib/telephony/types";
import { plural, t } from "@/lib/i18n";

/**
 * The phone booth, showing a call that is actually happening.
 *
 * Everything here comes from the call record: the number dialled, the status
 * the provider reported, and the words that were really said. Nothing is
 * scripted — an office that showed an invented conversation next to a real one
 * would make both unreadable.
 */

export type PhoneCallStep =
  | "dialing"
  | "ringing"
  | "speaking"
  | "complete";

export type PhoneBoothTurn = {
  id: string;
  speaker: TranscriptSpeaker;
  text: string;
};

export type PhoneBoothCallView = {
  /** The number dialled, as it was dialled. */
  dialNumber: string;
  /** The agent speaking, so the booth says whose call this is. */
  agentName: string;
  status: CallStatus;
  turns: PhoneBoothTurn[];
};

const STATUS_LABEL: Record<CallStatus, string> = {
  queued: t("phoneBooth.dialing"),
  ringing: t("phoneBooth.waitingAnswer"),
  "in-progress": t("phoneBooth.connected"),
  processing: t("phoneBooth.wrappingUp"),
  completed: t("phoneBooth.complete"),
  busy: t("phoneBooth.busy"),
  "no-answer": t("phone.statusNoAnswer"),
  canceled: t("phoneBooth.canceled"),
  failed: t("phoneBooth.failed"),
};

const SPEAKER_LABEL: Record<TranscriptSpeaker, string> = {
  agent: t("phone.agentLabel"),
  callee: t("phone.calleeLabel"),
  operator: t("phone.operatorLabel"),
  system: t("phone.systemLabel"),
};

/** The booth's animation stage, taken from the call rather than a timer. */
export const stepForCallStatus = (status: CallStatus): PhoneCallStep => {
  switch (status) {
    case "queued":
      return "dialing";
    case "ringing":
      return "ringing";
    case "in-progress":
    case "processing":
      return "speaking";
    default:
      return "complete";
  }
};

export function PhoneBoothImmersiveScreen({
  call,
  typedDigits,
}: {
  call: PhoneBoothCallView;
  typedDigits: string;
}) {
  const step = stepForCallStatus(call.status);
  const statusLabel = STATUS_LABEL[call.status];
  // The last few turns: a booth is a glance, not a reading pane. The full
  // transcript lives in the phone panel.
  const recentTurns = call.turns.slice(-3);

  return (
    <div className="absolute inset-0 overflow-hidden bg-[radial-gradient(circle_at_top,#0f172a_0%,#050816_46%,#02030a_100%)] text-white">
      <div className="pointer-events-none absolute inset-0 opacity-25 [background-image:linear-gradient(rgba(56,189,248,0.08)_1px,transparent_1px),linear-gradient(90deg,rgba(56,189,248,0.08)_1px,transparent_1px)] [background-size:22px_22px]" />
      <div className="relative flex h-full items-center justify-center px-8 py-10">
        <div className="grid w-full max-w-5xl grid-cols-[1.05fr_0.95fr] gap-10">
          <div className="rounded-[32px] border border-sky-300/18 bg-slate-950/65 p-8 shadow-[0_24px_90px_rgba(2,8,23,0.75)]">
            <div className="flex items-center gap-3 text-[11px] uppercase tracking-[0.28em] text-sky-200/70">
              <PhoneCall className="h-4 w-4" />
              {t("phoneBooth.title")}
            </div>
            <div className="mt-4 font-mono text-4xl font-semibold tracking-[0.08em] text-sky-50">
              {call.dialNumber}
            </div>
            <div className="mt-2 text-sm uppercase tracking-[0.24em] text-sky-200/55">
              {statusLabel}
            </div>
            <div className="mt-8 rounded-[28px] border border-sky-300/16 bg-slate-900/90 p-6">
              <div className="flex items-center justify-between text-[11px] uppercase tracking-[0.24em] text-sky-200/60">
                <span>{t("phone.callingAs")}</span>
                <span>{call.agentName}</span>
              </div>
              <div className="mt-5 font-mono text-3xl font-medium tracking-[0.24em] text-sky-50">
                {typedDigits || call.dialNumber}
              </div>
              <div className="mt-6 grid grid-cols-3 gap-3">
                {["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"].map((digit) => (
                  <div
                    key={digit}
                    className={`flex h-14 items-center justify-center rounded-2xl border text-xl ${
                      typedDigits.includes(digit)
                        ? "border-sky-300/40 bg-sky-400/16 text-sky-50"
                        : "border-slate-700 bg-slate-900/75 text-slate-300"
                    }`}
                  >
                    {digit}
                  </div>
                ))}
              </div>
              <div className="mt-5 flex items-center justify-end">
                <div
                  className={`inline-flex items-center gap-3 rounded-2xl border px-5 py-3 text-sm uppercase tracking-[0.22em] transition-all ${
                    step === "dialing"
                      ? "border-emerald-300/18 bg-emerald-400/8 text-emerald-100/72"
                      : "border-emerald-300/45 bg-emerald-400/18 text-emerald-50 shadow-[0_0_24px_rgba(74,222,128,0.22)]"
                  }`}
                >
                  <PhoneCall className="h-4 w-4" />
                  {statusLabel}
                </div>
              </div>
            </div>
          </div>

          <div className="flex items-center justify-center">
            <div className="relative h-[74vh] max-h-[720px] w-[360px] rounded-[44px] border border-sky-200/20 bg-[#020617] p-3 shadow-[0_30px_120px_rgba(0,0,0,0.78)]">
              <div className="absolute left-1/2 top-3 h-1.5 w-28 -translate-x-1/2 rounded-full bg-slate-700" />
              <div className="relative flex h-full flex-col overflow-hidden rounded-[34px] border border-sky-300/12 bg-[linear-gradient(180deg,#081225_0%,#020617_100%)] px-6 py-8">
                <div className="flex items-center justify-between text-[11px] uppercase tracking-[0.24em] text-sky-200/65">
                  <span>{t("phoneBooth.cellularRelay")}</span>
                  <Smartphone className="h-4 w-4" />
                </div>
                <div className="mt-8 flex h-28 w-28 items-center justify-center self-center rounded-full border border-sky-300/22 bg-sky-400/10 text-sky-100">
                  {step === "speaking" ? (
                    <AudioLines className="h-12 w-12" />
                  ) : (
                    <PhoneCall className="h-12 w-12" />
                  )}
                </div>
                <div className="mt-6 text-center">
                  <div className="text-[13px] uppercase tracking-[0.26em] text-sky-200/55">
                    {statusLabel}
                  </div>
                  <div className="mt-2 font-mono text-2xl font-semibold text-sky-50">
                    {call.dialNumber}
                  </div>
                  <div className="mt-2 text-sm tracking-[0.22em] text-sky-200/60">
                    {call.agentName}
                  </div>
                </div>
                <div className="mt-8 flex-1 space-y-4 overflow-hidden">
                  {recentTurns.length === 0 ? (
                    <Bubble
                      label={t("phoneBooth.line")}
                      // Said, not guessed: before anyone speaks there is
                      // nothing to show, and inventing an opening line would
                      // put words in the agent's mouth.
                      text={
                        step === "complete"
                          ? t("phone.nothingSaid")
                          : t("phone.waitingFirstWords")
                      }
                      tone="secondary"
                    />
                  ) : null}
                  {recentTurns.map((turn) => (
                    <Bubble
                      key={turn.id}
                      label={SPEAKER_LABEL[turn.speaker]}
                      text={turn.text}
                      tone={turn.speaker === "agent" ? "primary" : "secondary"}
                    />
                  ))}
                </div>
                <div className="rounded-[24px] border border-sky-300/14 bg-slate-950/70 px-4 py-3 text-sm text-sky-100/78">
                  {statusLabel}
                  {call.turns.length > recentTurns.length
                    ? ` · ${call.turns.length} ${plural(call.turns.length, [
                        "реплика",
                        "реплики",
                        "реплик",
                      ])}`
                    : ""}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Bubble({
  label,
  text,
  tone,
}: {
  label: string;
  text: string;
  tone: "primary" | "secondary";
}) {
  return (
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
  );
}
