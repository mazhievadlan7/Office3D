import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import type { RuntimeAgentMessageMode } from "@/lib/runtime/agentMessaging";
import { LOCALE, t, type TranslationKey } from "@/lib/i18n";

export type RemoteAgentChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  timestampMs: number;
};

type RemoteAgentChatPanelProps = {
  agentName: string;
  canSend: boolean;
  sending: boolean;
  handoffing?: boolean;
  draft: string;
  mode: RuntimeAgentMessageMode;
  handoffContext?: string;
  handoffDeliverables?: string;
  handoffAcceptance?: string;
  error: string | null;
  messages: RemoteAgentChatMessage[];
  disabledReason?: string | null;
  onDraftChange: (value: string) => void;
  onModeChange: (value: RuntimeAgentMessageMode) => void;
  onHandoffContextChange: (value: string) => void;
  onHandoffDeliverablesChange: (value: string) => void;
  onHandoffAcceptanceChange: (value: string) => void;
  onSend: (message: string) => void;
  onHandoff: (message: string) => void;
};

// 24-hour, like the HQ clock and the local agent chat. Built once.
const TIME_FORMAT = new Intl.DateTimeFormat(LOCALE, {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const formatTimestamp = (timestampMs: number) => TIME_FORMAT.format(new Date(timestampMs));

const MODE_LABEL_KEY = {
  direct: "remoteChat.modeDirect",
  interval: "remoteChat.modeInterval",
} as const satisfies Record<RuntimeAgentMessageMode, TranslationKey>;

const FIELD_CLASS =
  "w-full rounded-md border border-red-900/50 bg-black/60 px-3 text-white outline-none transition-colors placeholder:text-white/35 focus:border-red-500/70 focus:ring-1 focus:ring-red-500/30";

export const RemoteAgentChatPanel = memo(function RemoteAgentChatPanel({
  agentName,
  canSend,
  sending,
  handoffing = false,
  draft,
  mode,
  handoffContext = "",
  handoffDeliverables = "",
  handoffAcceptance = "",
  error,
  messages,
  disabledReason,
  onDraftChange,
  onModeChange,
  onHandoffContextChange,
  onHandoffDeliverablesChange,
  onHandoffAcceptanceChange,
  onSend,
  onHandoff,
}: RemoteAgentChatPanelProps) {
  const [draftValue, setDraftValue] = useState(draft);
  const feedRef = useRef<HTMLDivElement | null>(null);
  const sendDisabled = !canSend || sending || handoffing || !draftValue.trim();
  const handoffDisabled = !canSend || sending || handoffing || !draftValue.trim();
  const helperText = useMemo(() => {
    if (disabledReason?.trim()) return disabledReason.trim();
    if (sending) return t("remoteChat.forwarding");
    if (mode === "interval") {
      return t("remoteChat.intervalThread");
    }
    return t("remoteChat.directRelay");
  }, [disabledReason, mode, sending]);

  useEffect(() => {
    setDraftValue(draft);
  }, [draft]);

  useEffect(() => {
    if (!feedRef.current) return;
    feedRef.current.scrollTop = feedRef.current.scrollHeight;
  }, [messages, sending]);

  const handleSend = () => {
    const trimmed = draftValue.trim();
    if (!trimmed || sendDisabled) return;
    onSend(trimmed);
  };

  const handleHandoff = () => {
    const trimmed = draftValue.trim();
    if (!trimmed || handoffDisabled) return;
    onHandoff(trimmed);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    handleSend();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[#070404] text-white">
      <div className="border-b border-white/10 px-4 py-3">
        <div className="flex items-center gap-2 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-white/65">
          <span
            aria-hidden="true"
            className="h-1.5 w-1.5 rounded-full bg-red-500 shadow-[0_0_8px_rgba(255,42,42,0.8)]"
          />
          {t("remoteChat.title")}
        </div>
        <div className="mt-1 text-[15px] font-medium text-white">{agentName}</div>
        <div className="mt-2 font-mono text-[11px] text-white/45">{helperText}</div>
      </div>

      <div ref={feedRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {messages.length === 0 ? (
          <div className="rounded-md border border-dashed border-red-900/40 bg-black/30 px-3 py-3 font-mono text-[11px] text-white/45">
            {t("remoteChat.lead")}
          </div>
        ) : (
          messages.map((message) => (
            <div
              key={message.id}
              className={`max-w-[85%] rounded-md border px-3 py-2 ${
                message.role === "user"
                  ? "ml-auto border-red-600/35 bg-red-950/50 text-white"
                  : message.role === "assistant"
                    ? "border-red-900/40 bg-[#0b0707] text-white"
                    : "border-white/10 bg-white/5 text-white/65"
              }`}
            >
              <div className="whitespace-pre-wrap break-words text-[13px] leading-5">
                {message.text}
              </div>
              <div className="mt-2 font-mono text-[10px] tabular-nums text-white/45">
                {formatTimestamp(message.timestampMs)}
              </div>
            </div>
          ))
        )}
      </div>

      <div className="border-t border-white/10 px-4 py-3">
        {error ? (
          <div className="mb-3 rounded-md border border-red-500/50 bg-red-950/40 px-3 py-2 font-mono text-[11px] text-red-400">
            {error}
          </div>
        ) : null}
        <div className="mb-3 flex items-center gap-2">
          {(["direct", "interval"] as const).map((entry) => {
            const selected = mode === entry;
            return (
              <button
                key={entry}
                type="button"
                aria-pressed={selected}
                onClick={() => onModeChange(entry)}
                className={`rounded-md border px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.14em] transition-colors ${
                  selected
                    ? "border-red-500/60 bg-red-600/20 text-white shadow-[0_0_14px_rgba(255,26,26,0.25)]"
                    : "border-red-900/40 bg-black/40 text-white/65 hover:border-red-500/50 hover:bg-red-950/40 hover:text-white"
                }`}
              >
                {t(MODE_LABEL_KEY[entry])}
              </button>
            );
          })}
        </div>
        <textarea
          value={draftValue}
          onChange={(event) => {
            const nextValue = event.target.value;
            setDraftValue(nextValue);
            onDraftChange(nextValue);
          }}
          onKeyDown={handleKeyDown}
          placeholder={t("remoteChat.placeholder")}
          className={`${FIELD_CLASS} min-h-[92px] resize-none py-2 text-sm`}
        />
        <div className="mt-3 grid gap-2">
          <textarea
            value={handoffContext}
            onChange={(event) => onHandoffContextChange(event.target.value)}
            placeholder={t("remoteChat.handoffContext")}
            className={`${FIELD_CLASS} min-h-[68px] resize-none py-2 text-xs`}
          />
          <input
            value={handoffDeliverables}
            onChange={(event) => onHandoffDeliverablesChange(event.target.value)}
            placeholder={t("remoteChat.deliverables")}
            className={`${FIELD_CLASS} h-10 text-xs`}
          />
          <input
            value={handoffAcceptance}
            onChange={(event) => onHandoffAcceptanceChange(event.target.value)}
            placeholder={t("remoteChat.acceptance")}
            className={`${FIELD_CLASS} h-10 text-xs`}
          />
        </div>
        <div className="mt-3 flex items-center justify-between gap-3">
          <div className="font-mono text-[10px] text-white/45">{t("remoteChat.hint")}</div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleHandoff}
              disabled={handoffDisabled}
              className="rounded-md border border-red-600/35 bg-black/40 px-3 py-1.5 font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-white transition-colors enabled:hover:border-red-500/60 enabled:hover:bg-red-950/40 disabled:cursor-not-allowed disabled:opacity-45"
            >
              {handoffing ? t("remoteChat.handingOff") : t("remoteChat.handoff")}
            </button>
            <button
              type="button"
              onClick={handleSend}
              disabled={sendDisabled}
              className="rounded-md border border-red-500/60 bg-[#e3141c] px-3 py-1.5 font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-white shadow-[0_0_14px_rgba(255,26,26,0.25)] transition-colors enabled:hover:bg-[#ff2a2a] disabled:cursor-not-allowed disabled:border-white/10 disabled:bg-white/5 disabled:text-white/35 disabled:shadow-none"
            >
              {sending ? t("remoteChat.sending") : t("common.send")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
});
