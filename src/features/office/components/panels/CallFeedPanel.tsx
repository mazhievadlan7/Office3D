"use client";

import { AlertTriangle, Phone, PhoneCall, RefreshCw, Send } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { CallFeed } from "@/features/office/hooks/useOfficeCallFeed";
import { plural, t } from "@/lib/i18n";
import { isTerminalCallStatus, type CallRecord, type CallStatus } from "@/lib/telephony/types";

/**
 * The office phone: dial out as an agent, and watch the conversation arrive.
 *
 * One number serves every agent, so the agent placing the call is chosen here
 * and travels with the call — the person answering hears one caller id and the
 * office still knows which desk is speaking.
 */

const STATUS_LABEL: Record<CallStatus, string> = {
  queued: t("phone.statusQueued"),
  ringing: t("phone.statusRinging"),
  "in-progress": t("phone.statusInProgress"),
  processing: t("phone.statusProcessing"),
  completed: t("phone.statusCompleted"),
  busy: t("phone.statusBusy"),
  "no-answer": t("phone.statusNoAnswer"),
  canceled: t("phone.statusCanceled"),
  failed: t("phone.statusFailed"),
};

// HQ palette: a live call is white on red, ringing/processing a softer red,
// busy/no-answer the one sparing orange, finished calls muted, failure red.
const STATUS_TONE: Record<CallStatus, string> = {
  queued: "border-white/15 bg-white/[0.04] text-white/65",
  ringing: "border-red-500/45 bg-red-600/15 text-red-300",
  "in-progress": "border-red-500/60 bg-red-600/25 text-white shadow-[0_0_10px_rgba(255,26,26,0.25)]",
  processing: "border-red-600/35 bg-red-600/10 text-white/80",
  completed: "border-white/15 bg-white/[0.04] text-white/65",
  busy: "border-orange-400/35 bg-orange-500/10 text-orange-300",
  "no-answer": "border-orange-400/35 bg-orange-500/10 text-orange-300",
  canceled: "border-white/15 bg-white/[0.04] text-white/55",
  failed: "border-red-500/50 bg-red-950/40 text-red-400",
};

const PRIMARY_BUTTON =
  "inline-flex items-center justify-center gap-2 rounded-md border border-red-500/60 bg-[#e3141c] px-4 text-sm font-medium text-white shadow-[0_0_14px_rgba(255,26,26,0.25)] transition hover:border-red-400/70 hover:bg-[#ff2a2a] disabled:cursor-not-allowed disabled:border-red-900/40 disabled:bg-red-950/30 disabled:text-white/35 disabled:shadow-none";

const SPEAKER_LABEL = {
  agent: t("phone.agentLabel"),
  callee: t("phone.calleeLabel"),
  operator: t("phone.operatorLabel"),
  system: t("phone.systemLabel"),
} as const;

const formatTime = (iso: string): string => {
  const at = new Date(iso);
  return Number.isNaN(at.getTime())
    ? ""
    : at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
};

/**
 * A call somebody asked for, carried into the panel.
 *
 * "Call my wife" names a person, not a number, so the request is shown as
 * context and a human still supplies the number. Nothing dials itself.
 */
export type CallRequestDraft = {
  agentId: string;
  callee: string;
  message: string | null;
};

export type OfficeCallAgent = {
  agentId: string;
  name: string;
  /** What this agent does, which becomes part of its phone prompt. */
  role?: string | null;
};

export function CallFeedPanel({
  feed,
  agents,
  draft = null,
}: {
  feed: CallFeed;
  agents: OfficeCallAgent[];
  draft?: CallRequestDraft | null;
}) {
  const [toNumber, setToNumber] = useState("");
  const [pickedAgentId, setPickedAgentId] = useState<string | null>(null);
  const [selectedSid, setSelectedSid] = useState<string | null>(null);

  // Derived rather than held in state: the roster can change under the panel
  // (an agent is deleted, or the floor loads late), and a stored id would keep
  // pointing at someone who is no longer there. A request picks the agent it
  // came from, until the operator chooses otherwise.
  const preferredAgentId = pickedAgentId ?? draft?.agentId ?? null;
  const agentId =
    preferredAgentId && agents.some((agent) => agent.agentId === preferredAgentId)
      ? preferredAgentId
      : (agents[0]?.agentId ?? "");

  const selected = useMemo(() => {
    const match = feed.calls.find((call) => call.sid === selectedSid);
    // Falling back to the newest call keeps the feed showing something when the
    // selected one is evicted, rather than an empty pane.
    return match ?? feed.calls[0] ?? null;
  }, [feed.calls, selectedSid]);

  const canDial =
    feed.ready && !feed.dialing && toNumber.trim().length > 0 && agentId.length > 0;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canDial) return;
    const caller = agents.find((agent) => agent.agentId === agentId);
    if (!caller) return;
    const call = await feed.placeCall({
      toNumber: toNumber.trim(),
      agentId,
      agentName: caller.name,
      agentRole: caller.role ?? null,
    });
    if (call) {
      setSelectedSid(call.sid);
      setToNumber("");
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 text-white">
      <header className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.28em] text-red-400">
          <PhoneCall className="h-4 w-4" aria-hidden="true" />
          {t("phone.title")}
        </div>
        <button
          type="button"
          onClick={() => void feed.refresh()}
          className="inline-flex items-center gap-2 rounded-md border border-red-900/40 bg-black/40 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-white/80 transition-colors hover:border-red-500/50 hover:bg-red-950/40 hover:text-white"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${feed.loading ? "animate-spin text-red-400" : ""}`} />
          {t("common.refresh")}
        </button>
      </header>

      {!feed.ready && feed.voiceAgent ? (
        <NoticeBox tone="warn">
          {t("phone.notReady")}
          <span className="font-mono">{feed.voiceAgent.missing.join(", ")}</span>.
        </NoticeBox>
      ) : null}
      {feed.error ? <NoticeBox tone="error">{feed.error}</NoticeBox> : null}

      {draft ? (
        <div className="rounded-md border border-red-600/35 border-l-2 border-l-red-500 bg-red-950/25 px-3 py-2.5 text-xs text-white/85">
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-red-400">
            {t("request.requested")}
          </div>
          <div className="mt-1">
            {t("request.callVerb")} <span className="font-medium text-white">{draft.callee}</span>
            {draft.message ? <> — «{draft.message}»</> : null}
          </div>
          {/* The number is the operator's to supply: a name is not a number,
              and a real call costs money and rings a stranger. */}
          <div className="mt-1 text-white/55">{t("request.enterNumberCall")}</div>
        </div>
      ) : null}

      <form
        onSubmit={submit}
        className="grid gap-3 rounded-lg border border-red-900/40 bg-[#0b0707] p-4 sm:grid-cols-[1fr_1fr_auto]"
      >
        <label className="flex flex-col gap-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-white/45">
          {t("phone.numberLabel")}
          <input
            value={toNumber}
            onChange={(event) => setToNumber(event.target.value)}
            placeholder="+441234567890"
            inputMode="tel"
            className="rounded-md border border-red-900/50 bg-black/60 px-3 py-2 font-mono text-sm normal-case tracking-normal text-white placeholder:text-white/35 focus:border-red-500/70 focus:outline-none focus:ring-1 focus:ring-red-500/30"
          />
        </label>
        <label className="flex flex-col gap-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-white/45">
          {t("phone.callingAs")}
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
        <button
          type="submit"
          disabled={!canDial}
          className={`mt-auto h-[38px] ${PRIMARY_BUTTON}`}
        >
          <Phone className="h-4 w-4" />
          {feed.dialing ? t("phone.dialing") : t("phone.call")}
        </button>
        {feed.dialError ? (
          <div className="sm:col-span-3">
            <NoticeBox tone="error">{feed.dialError}</NoticeBox>
          </div>
        ) : null}
      </form>

      <div className="grid min-h-0 flex-1 gap-4 md:grid-cols-[minmax(0,260px)_minmax(0,1fr)]">
        <ul className="min-h-0 space-y-2 overflow-y-auto pr-1">
          {feed.calls.length === 0 ? (
            <li className="rounded-md border border-dashed border-red-900/50 px-3 py-6 text-center text-xs text-white/45">
              {t("phone.noCalls")}
            </li>
          ) : null}
          {feed.calls.map((call) => (
            <li key={call.sid}>
              <button
                type="button"
                onClick={() => setSelectedSid(call.sid)}
                className={`w-full rounded-md border px-3 py-2.5 text-left transition ${
                  selected?.sid === call.sid
                    ? "border-red-500/60 bg-red-600/15"
                    : "border-red-900/40 bg-[#0b0707] hover:border-red-500/50 hover:bg-red-950/40"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-mono text-sm tabular-nums text-white">{call.to}</span>
                  <StatusChip status={call.status} />
                </div>
                <div className="mt-1 truncate text-[11px] text-white/55">
                  {agents.find((agent) => agent.agentId === call.agentId)?.name ?? call.agentId}
                  {" · "}
                  {call.transcript.length}{" "}
                  {plural(call.transcript.length, ["реплика", "реплики", "реплик"])}
                </div>
                {feed.syncErrors[call.sid] ? (
                  <div className="mt-1 flex items-start gap-1.5 text-[11px] text-orange-300/85">
                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                    {/* Last known state, not live: saying so beats a stale
                        transcript that looks current. */}
                    <span className="truncate">
                      {t("phone.notUpdating", { reason: feed.syncErrors[call.sid] })}
                    </span>
                  </div>
                ) : null}
              </button>
            </li>
          ))}
        </ul>

        {selected ? (
          <Transcript
            call={selected}
            operatorChannel={feed.operatorChannel}
            onSend={(text) => feed.sendInstruction(selected.sid, text)}
          />
        ) : (
          <EmptyTranscript />
        )}
      </div>
    </div>
  );
}

function StatusChip({ status }: { status: CallStatus }) {
  return (
    <span
      className={`shrink-0 rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] ${STATUS_TONE[status]}`}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

function EmptyTranscript() {
  return (
    <div className="flex min-h-0 items-center justify-center rounded-lg border border-dashed border-red-900/50 text-sm text-white/45">
      {t("phone.emptyTranscript")}
    </div>
  );
}

function Transcript({
  call,
  operatorChannel,
  onSend,
}: {
  call: CallRecord;
  operatorChannel: CallFeed["operatorChannel"];
  onSend: (text: string) => Promise<string | null>;
}) {
  const endRef = useRef<HTMLDivElement | null>(null);
  const live = !isTerminalCallStatus(call.status);

  useEffect(() => {
    // Only a live call follows the conversation down. Scrolling a finished one
    // would yank the view away from an operator reading back through it.
    const anchor = endRef.current;
    // Guarded: scrollIntoView is missing in non-browser renderers, and a
    // transcript that throws while following itself is worse than one that
    // does not scroll.
    if (live && typeof anchor?.scrollIntoView === "function") {
      anchor.scrollIntoView({ block: "end" });
    }
  }, [call.transcript.length, live]);

  return (
    <div className="flex min-h-0 flex-col rounded-lg border border-red-900/40 bg-[#070404]/80">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-red-900/40 px-4 py-3">
        <div>
          <div className="font-mono text-sm tabular-nums text-white">{call.to}</div>
          <div className="text-[11px] tabular-nums text-white/45">
            {call.from ? `${t("phone.from", { number: call.from })} · ` : ""}
            {t("phone.startedAt", { time: formatTime(call.startedAt) })}
            {call.endedAt
              ? ` · ${t("phone.endedAt", { time: formatTime(call.endedAt) }).replace(/^, /, "")}`
              : ""}
          </div>
        </div>
        <StatusChip status={call.status} />
      </div>

      {call.errorMessage ? (
        <div className="border-b border-red-900/40 px-4 py-2">
          <NoticeBox tone="error">{call.errorMessage}</NoticeBox>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {call.transcript.length === 0 ? (
          <div className="text-sm text-white/45">
            {live ? t("phone.waitingFirstWords") : t("phone.nothingSaid")}
          </div>
        ) : null}
        {call.transcript.map((turn) => (
          <div
            key={turn.id}
            className={`rounded-lg border px-4 py-3 ${
              turn.speaker === "agent"
                ? "border-red-600/35 bg-red-600/10"
                : turn.speaker === "callee"
                  ? "border-white/10 bg-white/[0.03]"
                  : "border-dashed border-red-900/50 bg-black/40"
            }`}
          >
            <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.18em] text-white/45">
              <span className={turn.speaker === "agent" ? "text-red-400" : undefined}>
                {SPEAKER_LABEL[turn.speaker]}
              </span>
              <span className="tabular-nums">{formatTime(turn.at)}</span>
            </div>
            <div className="mt-1.5 text-sm leading-6 text-white">{turn.text}</div>
          </div>
        ))}
        <div ref={endRef} />
      </div>

      {live ? (
        <InstructionComposer
          call={call}
          operatorChannel={operatorChannel}
          onSend={onSend}
        />
      ) : (
        <Recording sid={call.sid} />
      )}
    </div>
  );
}

/**
 * A note for the agent to work into its next line.
 *
 * Queued, not spoken. The agent collects it when it next calls its tool, so
 * the button says "Send to agent" rather than anything that implies the words
 * go straight down the line.
 */
function InstructionComposer({
  call,
  operatorChannel,
  onSend,
}: {
  call: CallRecord;
  operatorChannel: CallFeed["operatorChannel"];
  onSend: (text: string) => Promise<string | null>;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const available = operatorChannel?.configured ?? false;

  const send = async (event: React.FormEvent) => {
    event.preventDefault();
    const note = text.trim();
    if (!note || sending || !available) return;
    setSending(true);
    const failure = await onSend(note);
    setSending(false);
    setError(failure);
    if (!failure) setText("");
  };

  if (!available) {
    return (
      <div className="border-t border-red-900/40 px-4 py-3">
        <NoticeBox tone="warn">
          {t("phone.noteOff")}
          <span className="font-mono">
            {operatorChannel?.missing.join(", ") ?? t("common.notConfigured")}
          </span>
          .
        </NoticeBox>
      </div>
    );
  }

  return (
    <form onSubmit={send} className="border-t border-red-900/40 px-4 py-3">
      <div className="flex items-end gap-2">
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            // Enter sends, shift+Enter breaks the line: a live call is not the
            // place to reach for a mouse.
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send(event);
            }
          }}
          rows={2}
          placeholder={t("phone.notePlaceholder")}
          className="min-h-[44px] flex-1 resize-none rounded-md border border-red-900/50 bg-black/60 px-3 py-2 text-sm text-white placeholder:text-white/35 focus:border-red-500/70 focus:outline-none focus:ring-1 focus:ring-red-500/30"
        />
        <button
          type="submit"
          disabled={sending || !text.trim()}
          className={`h-[44px] ${PRIMARY_BUTTON}`}
        >
          <Send className="h-4 w-4" />
          {sending ? t("phone.noteSending") : t("phone.noteSend")}
        </button>
      </div>
      <div className="mt-1.5 text-[11px] text-white/45">
        {call.pendingSay ? t("phone.notePending") : t("phone.nextTurnNotice")}
      </div>
      {error ? (
        <div className="mt-2">
          <NoticeBox tone="error">{error}</NoticeBox>
        </div>
      ) : null}
    </form>
  );
}

/**
 * The recording, once the call is over.
 *
 * There is no live equivalent: ElevenLabs serves the recording of a
 * conversation, not a tap on one in progress, so the panel offers listening
 * back rather than listening in.
 */
function Recording({ sid }: { sid: string }) {
  return (
    <div className="border-t border-red-900/40 px-4 py-3">
      <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-white/45">
        {t("phone.recordingTitle")}
      </div>
      <audio
        controls
        preload="none"
        src={`/api/telephony/calls/${encodeURIComponent(sid)}/audio`}
        className="w-full [color-scheme:dark]"
      />
      <div className="mt-1.5 text-[11px] text-white/45">
        {t("phone.recordingHint")}
      </div>
    </div>
  );
}

function NoticeBox({
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
