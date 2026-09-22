"use client";

import { AlertTriangle, Phone, PhoneCall, RefreshCw, Send } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { CallFeed } from "@/features/office/hooks/useOfficeCallFeed";
import { isTerminalCallStatus, type CallRecord, type CallStatus } from "@/lib/telephony/types";

/**
 * The office phone: dial out as an agent, and watch the conversation arrive.
 *
 * One number serves every agent, so the agent placing the call is chosen here
 * and travels with the call — the person answering hears one caller id and the
 * office still knows which desk is speaking.
 */

const STATUS_LABEL: Record<CallStatus, string> = {
  queued: "Queued",
  ringing: "Ringing",
  "in-progress": "On the line",
  processing: "Wrapping up",
  completed: "Ended",
  busy: "Busy",
  "no-answer": "No answer",
  canceled: "Canceled",
  failed: "Failed",
};

const STATUS_TONE: Record<CallStatus, string> = {
  queued: "border-slate-600 bg-slate-800/70 text-slate-200",
  ringing: "border-amber-300/40 bg-amber-400/15 text-amber-100",
  "in-progress": "border-emerald-300/45 bg-emerald-400/18 text-emerald-50",
  processing: "border-sky-300/40 bg-sky-400/15 text-sky-100",
  completed: "border-slate-600 bg-slate-800/70 text-slate-200",
  busy: "border-orange-300/40 bg-orange-400/15 text-orange-100",
  "no-answer": "border-orange-300/40 bg-orange-400/15 text-orange-100",
  canceled: "border-slate-600 bg-slate-800/70 text-slate-200",
  failed: "border-rose-300/45 bg-rose-500/18 text-rose-50",
};

const SPEAKER_LABEL = {
  agent: "Agent",
  callee: "Caller",
  operator: "You",
  system: "System",
} as const;

const formatTime = (iso: string): string => {
  const at = new Date(iso);
  return Number.isNaN(at.getTime())
    ? ""
    : at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
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
}: {
  feed: CallFeed;
  agents: OfficeCallAgent[];
}) {
  const [toNumber, setToNumber] = useState("");
  const [pickedAgentId, setPickedAgentId] = useState<string | null>(null);
  const [selectedSid, setSelectedSid] = useState<string | null>(null);

  // Derived rather than held in state: the roster can change under the panel
  // (an agent is deleted, or the floor loads late), and a stored id would keep
  // pointing at someone who is no longer there.
  const agentId =
    pickedAgentId && agents.some((agent) => agent.agentId === pickedAgentId)
      ? pickedAgentId
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
    <div className="flex h-full min-h-0 flex-col gap-4 text-slate-100">
      <header className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.28em] text-sky-200/70">
          <PhoneCall className="h-4 w-4" />
          Office phone
        </div>
        <button
          type="button"
          onClick={() => void feed.refresh()}
          className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-900/70 px-3 py-1.5 text-xs text-slate-300 hover:border-slate-500 hover:text-slate-100"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${feed.loading ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </header>

      {!feed.ready && feed.voiceAgent ? (
        <NoticeBox tone="warn">
          Calling is off until this deployment is configured. Missing:{" "}
          <span className="font-mono">{feed.voiceAgent.missing.join(", ")}</span>.
        </NoticeBox>
      ) : null}
      {feed.error ? <NoticeBox tone="error">{feed.error}</NoticeBox> : null}

      <form
        onSubmit={submit}
        className="grid gap-3 rounded-2xl border border-slate-700 bg-slate-900/60 p-4 sm:grid-cols-[1fr_1fr_auto]"
      >
        <label className="flex flex-col gap-1.5 text-xs text-slate-400">
          Number to call
          <input
            value={toNumber}
            onChange={(event) => setToNumber(event.target.value)}
            placeholder="+441234567890"
            inputMode="tel"
            className="rounded-lg border border-slate-700 bg-slate-950/80 px-3 py-2 font-mono text-sm text-slate-100 placeholder:text-slate-600 focus:border-sky-400/60 focus:outline-none"
          />
        </label>
        <label className="flex flex-col gap-1.5 text-xs text-slate-400">
          Calling as
          <select
            value={agentId}
            onChange={(event) => setPickedAgentId(event.target.value)}
            className="rounded-lg border border-slate-700 bg-slate-950/80 px-3 py-2 text-sm text-slate-100 focus:border-sky-400/60 focus:outline-none"
          >
            {agents.length === 0 ? <option value="">No agents available</option> : null}
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
          className="mt-auto inline-flex h-[38px] items-center justify-center gap-2 rounded-lg border border-emerald-300/45 bg-emerald-400/18 px-4 text-sm font-medium text-emerald-50 transition hover:bg-emerald-400/28 disabled:cursor-not-allowed disabled:border-slate-700 disabled:bg-slate-800/60 disabled:text-slate-500"
        >
          <Phone className="h-4 w-4" />
          {feed.dialing ? "Dialing…" : "Call"}
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
            <li className="rounded-xl border border-dashed border-slate-700 px-3 py-6 text-center text-xs text-slate-500">
              No calls yet.
            </li>
          ) : null}
          {feed.calls.map((call) => (
            <li key={call.sid}>
              <button
                type="button"
                onClick={() => setSelectedSid(call.sid)}
                className={`w-full rounded-xl border px-3 py-2.5 text-left transition ${
                  selected?.sid === call.sid
                    ? "border-sky-400/50 bg-sky-400/10"
                    : "border-slate-700 bg-slate-900/60 hover:border-slate-500"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-mono text-sm text-slate-100">{call.to}</span>
                  <StatusChip status={call.status} />
                </div>
                <div className="mt-1 truncate text-[11px] text-slate-400">
                  {agents.find((agent) => agent.agentId === call.agentId)?.name ?? call.agentId}
                  {" · "}
                  {call.transcript.length} turn{call.transcript.length === 1 ? "" : "s"}
                </div>
                {feed.syncErrors[call.sid] ? (
                  <div className="mt-1 flex items-start gap-1.5 text-[11px] text-amber-200/80">
                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                    {/* Last known state, not live: saying so beats a stale
                        transcript that looks current. */}
                    <span className="truncate">Not updating: {feed.syncErrors[call.sid]}</span>
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
      className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.14em] ${STATUS_TONE[status]}`}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

function EmptyTranscript() {
  return (
    <div className="flex min-h-0 items-center justify-center rounded-2xl border border-dashed border-slate-700 text-sm text-slate-500">
      Place a call to watch the conversation here.
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
    <div className="flex min-h-0 flex-col rounded-2xl border border-slate-700 bg-slate-950/60">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 px-4 py-3">
        <div>
          <div className="font-mono text-sm text-slate-100">{call.to}</div>
          <div className="text-[11px] text-slate-500">
            {call.from ? `from ${call.from} · ` : ""}
            started {formatTime(call.startedAt)}
            {call.endedAt ? ` · ended ${formatTime(call.endedAt)}` : ""}
          </div>
        </div>
        <StatusChip status={call.status} />
      </div>

      {call.errorMessage ? (
        <div className="border-b border-slate-800 px-4 py-2">
          <NoticeBox tone="error">{call.errorMessage}</NoticeBox>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {call.transcript.length === 0 ? (
          <div className="text-sm text-slate-500">
            {live ? "Waiting for the first words…" : "Nothing was said on this call."}
          </div>
        ) : null}
        {call.transcript.map((turn) => (
          <div
            key={turn.id}
            className={`rounded-2xl border px-4 py-3 ${
              turn.speaker === "agent"
                ? "border-sky-300/20 bg-sky-400/10"
                : turn.speaker === "callee"
                  ? "border-slate-700 bg-slate-900/80"
                  : "border-amber-300/25 bg-amber-400/10"
            }`}
          >
            <div className="flex items-center justify-between text-[10px] uppercase tracking-[0.18em] text-slate-400">
              <span>{SPEAKER_LABEL[turn.speaker]}</span>
              <span>{formatTime(turn.at)}</span>
            </div>
            <div className="mt-1.5 text-sm leading-6 text-slate-100">{turn.text}</div>
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
      <div className="border-t border-slate-800 px-4 py-3">
        <NoticeBox tone="warn">
          Notes to the agent are off. Missing:{" "}
          <span className="font-mono">
            {operatorChannel?.missing.join(", ") ?? "configuration"}
          </span>
          .
        </NoticeBox>
      </div>
    );
  }

  return (
    <form onSubmit={send} className="border-t border-slate-800 px-4 py-3">
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
          placeholder="Tell the agent what to say next…"
          className="min-h-[44px] flex-1 resize-none rounded-lg border border-slate-700 bg-slate-950/80 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:border-sky-400/60 focus:outline-none"
        />
        <button
          type="submit"
          disabled={sending || !text.trim()}
          className="inline-flex h-[44px] items-center gap-2 rounded-lg border border-sky-300/45 bg-sky-400/18 px-4 text-sm text-sky-50 transition hover:bg-sky-400/28 disabled:cursor-not-allowed disabled:border-slate-700 disabled:bg-slate-800/60 disabled:text-slate-500"
        >
          <Send className="h-4 w-4" />
          {sending ? "Sending…" : "Send to agent"}
        </button>
      </div>
      <div className="mt-1.5 text-[11px] text-slate-500">
        {call.pendingSay
          ? "A note is waiting; sending another replaces it."
          : "The agent picks this up on its next turn, so it is not said instantly."}
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
    <div className="border-t border-slate-800 px-4 py-3">
      <div className="mb-2 text-[11px] uppercase tracking-[0.18em] text-slate-500">
        Recording
      </div>
      <audio
        controls
        preload="none"
        src={`/api/telephony/calls/${encodeURIComponent(sid)}/audio`}
        className="w-full"
      />
      <div className="mt-1.5 text-[11px] text-slate-500">
        Available once ElevenLabs has finished writing it, which can take a
        moment after the call ends.
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
      className={`rounded-xl border px-3 py-2 text-xs ${
        tone === "error"
          ? "border-rose-400/40 bg-rose-500/12 text-rose-100"
          : "border-amber-300/40 bg-amber-400/12 text-amber-100"
      }`}
    >
      {children}
    </div>
  );
}
