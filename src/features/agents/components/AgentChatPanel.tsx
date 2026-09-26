import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type MutableRefObject,
  type ReactNode,
} from "react";
import type { AgentState as AgentRecord } from "@/features/agents/state/store";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Check,
  ChevronRight,
  Clock,
  Mic,
  Paperclip,
  Pencil,
  SlidersHorizontal,
  Square,
  Trash2,
  X,
} from "lucide-react";
import type { GatewayModelChoice } from "@/lib/gateway/models";
import type { AgentAvatarProfile } from "@/lib/avatars/profile";
import { rewriteMediaLinesToMarkdown } from "@/lib/text/media-markdown";
import { normalizeAssistantDisplayText } from "@/lib/text/assistantText";
import { isNearBottom } from "@/lib/dom";
import { useVoiceRecorder, type VoiceRecorderState, type VoiceSendPayload } from "@/hooks/useVoiceRecorder";
import { AgentAvatar } from "./AgentAvatar";
import type {
  ExecApprovalDecision,
  PendingExecApproval,
} from "@/features/agents/approvals/types";
import type { RuntimeAttachment } from "@/lib/runtime/types";
import {
  buildAgentChatRenderBlocks,
  buildFinalAgentChatItems,
  summarizeToolLabel,
  type AssistantTraceEvent,
  type AgentChatItem,
} from "./chatItems";
import { LOCALE, t } from "@/lib/i18n";

// 24-hour, like the HQ clock: a Russian interface should read «15:07», not
// «03:07 PM». Built once; every message card formats through it.
const CHAT_TIME_FORMAT = new Intl.DateTimeFormat(LOCALE, {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const formatChatTimestamp = (timestampMs: number): string =>
  CHAT_TIME_FORMAT.format(new Date(timestampMs));

const formatDurationLabel = (durationMs: number): string => {
  const seconds = durationMs / 1000;
  if (!Number.isFinite(seconds) || seconds <= 0) return t("chat.seconds", { value: "0.0" });
  if (seconds < 10) return t("chat.seconds", { value: seconds.toFixed(1) });
  return t("chat.seconds", { value: Math.round(seconds) });
};

const SPINE_LEFT = "left-[15px]";
const ASSISTANT_GUTTER_CLASS = "pl-[44px]";
const ASSISTANT_MAX_WIDTH_DEFAULT_CLASS = "max-w-[68ch]";
const ASSISTANT_MAX_WIDTH_EXPANDED_CLASS = "max-w-[1120px]";
const CHAT_TOP_THRESHOLD_PX = 8;

// Colours come from the HQ tokens on <html> (.hq-theme in globals.css): the
// bubbles, markdown, alerts and the thin red scrollbars all read them, so
// nothing here re-declares a token.

// Shared control looks, so every button in the chat reads as one set.
const CHAT_ICON_BUTTON_CLASS =
  "inline-flex shrink-0 items-center justify-center rounded-md border border-border bg-black/40 text-white/70 transition-colors enabled:hover:border-primary/55 enabled:hover:bg-primary/15 enabled:hover:text-white disabled:cursor-not-allowed disabled:opacity-40";
const CHAT_SECONDARY_BUTTON_CLASS =
  "rounded-md border border-border bg-black/40 font-mono font-medium text-white/85 transition-colors enabled:hover:border-primary/55 enabled:hover:bg-primary/15 enabled:hover:text-white disabled:cursor-not-allowed disabled:border-white/10 disabled:bg-white/5 disabled:text-white/35";
const CHAT_PRIMARY_BUTTON_CLASS =
  "rounded-md border border-primary bg-primary font-mono font-semibold uppercase text-white shadow-[0_0_14px_rgba(255,26,26,0.25)] transition-colors enabled:hover:border-ring enabled:hover:bg-ring disabled:cursor-not-allowed disabled:border-white/10 disabled:bg-white/5 disabled:text-white/35 disabled:shadow-none";
const CHAT_SELECT_CLASS =
  "h-6 min-w-0 rounded-md border border-border bg-card px-1.5 font-mono text-[10px] font-semibold text-white [color-scheme:dark] transition-colors hover:border-primary/55 focus:border-primary/70";
const CHAT_TIME_CHIP_CLASS =
  "shrink-0 rounded-md border border-border bg-black/40 px-2 py-0.5 font-mono text-[11px] tabular-nums text-white/65";
const CHAT_AUTHOR_CLASS =
  "min-w-0 truncate font-mono text-[11px] font-semibold uppercase tracking-[0.14em]";
const EMPTY_CHAT_INTRO_MESSAGES = [
  t("chat.intro1"),
  t("chat.intro2"),
  t("chat.intro3"),
  t("chat.intro4"),
  t("chat.intro5"),
];
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

type UploadAttachment = {
  id: string;
  name: string;
  url: string;
  contentType: string;
  extractedText?: string;
};

const stableStringHash = (value: string): number => {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash;
};

const resolveEmptyChatIntroMessage = (agentId: string, sessionEpoch: number | undefined): string => {
  if (EMPTY_CHAT_INTRO_MESSAGES.length === 0) return t("chat.intro1");
  const normalizedEpoch =
    typeof sessionEpoch === "number" && Number.isFinite(sessionEpoch)
      ? Math.max(0, Math.trunc(sessionEpoch))
      : 0;
  const offset = stableStringHash(agentId) % EMPTY_CHAT_INTRO_MESSAGES.length;
  const index = (offset + normalizedEpoch) % EMPTY_CHAT_INTRO_MESSAGES.length;
  return EMPTY_CHAT_INTRO_MESSAGES[index];
};

const looksLikePath = (value: string): boolean => {
  if (!value) return false;
  if (/(^|[\s(])(?:[A-Za-z]:\\|~\/|\/)/.test(value)) return true;
  if (/(^|[\s(])(src|app|packages|components)\//.test(value)) return true;
  if (/(^|[\s(])[\w.-]+\.(ts|tsx|js|jsx|json|md|py|go|rs|java|kt|rb|sh|yaml|yml)\b/.test(value)) {
    return true;
  }
  return false;
};

const isStructuredMarkdown = (text: string): boolean => {
  if (!text) return false;
  if (/```/.test(text)) return true;
  if (/^\s*#{1,6}\s+/m.test(text)) return true;
  if (/^\s*[-*+]\s+/m.test(text)) return true;
  if (/^\s*\d+\.\s+/m.test(text)) return true;
  if (/^\s*\|.+\|\s*$/m.test(text)) return true;
  if (looksLikePath(text) && text.split("\n").filter(Boolean).length >= 3) return true;
  return false;
};

const resolveAssistantMaxWidthClass = (text: string | null | undefined): string => {
  const value = (text ?? "").trim();
  if (!value) return ASSISTANT_MAX_WIDTH_DEFAULT_CLASS;
  if (isStructuredMarkdown(value)) return ASSISTANT_MAX_WIDTH_EXPANDED_CLASS;
  const nonEmptyLines = value.split("\n").filter((line) => line.trim().length > 0);
  const shortLineCount = nonEmptyLines.filter((line) => line.trim().length <= 44).length;
  if (nonEmptyLines.length >= 10 && shortLineCount / Math.max(1, nonEmptyLines.length) >= 0.65) {
    return ASSISTANT_MAX_WIDTH_EXPANDED_CLASS;
  }
  return ASSISTANT_MAX_WIDTH_DEFAULT_CLASS;
};

type AgentChatPanelProps = {
  agent: AgentRecord;
  isSelected: boolean;
  canSend: boolean;
  models: GatewayModelChoice[];
  stopBusy: boolean;
  stopDisabledReason?: string | null;
  onLoadMoreHistory: () => void;
  onOpenSettings?: () => void;
  onRename?: (name: string) => Promise<boolean>;
  onNewSession?: () => Promise<void> | void;
  onModelChange: (value: string | null) => void;
  onThinkingChange: (value: string | null) => void;
  onToolCallingToggle?: (enabled: boolean) => void;
  onThinkingTracesToggle?: (enabled: boolean) => void;
  onDraftChange: (value: string) => void;
  onSend: (message: string, attachments: RuntimeAttachment[]) => void;
  onRemoveQueuedMessage?: (index: number) => void;
  onStopRun: () => void;
  onAvatarShuffle: () => void;
  pendingExecApprovals?: PendingExecApproval[];
  onResolveExecApproval?: (id: string, decision: ExecApprovalDecision) => void;
  onVoiceSend?: (payload: VoiceSendPayload) => Promise<void>;
};

const formatApprovalExpiry = (timestampMs: number): string => {
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) return t("chat.unknown");
  return new Intl.DateTimeFormat(LOCALE, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestampMs));
};

const ExecApprovalCard = memo(function ExecApprovalCard({
  approval,
  onResolve,
}: {
  approval: PendingExecApproval;
  onResolve?: (id: string, decision: ExecApprovalDecision) => void;
}) {
  const disabled = approval.resolving || !onResolve;
  return (
    <div
      className={`w-full ${ASSISTANT_MAX_WIDTH_EXPANDED_CLASS} ${ASSISTANT_GUTTER_CLASS} ui-badge-approval self-start rounded-md px-3 py-2 shadow-2xs`}
      data-testid={`exec-approval-card-${approval.id}`}
    >
      <div className="font-mono text-[11px] font-semibold uppercase tracking-[0.14em]">{t("chat.approvalRequired")}</div>
      {approval.escalation ? (
        <div className="mt-1 text-[11px] text-white" data-testid={`exec-approval-escalation-${approval.id}`}>
          {approval.escalation.by === "main"
            ? t("chat.approvalEscalatedByMain", { reason: approval.escalation.reason ?? "" })
            : t("chat.approvalEscalatedAuto", { reason: approval.escalation.reason ?? "" })}
        </div>
      ) : null}
      <div className="mt-2 rounded-md border border-border bg-black/60 px-2 py-1.5">
        <div className="font-mono text-[10px] font-semibold text-white">{approval.command}</div>
      </div>
      <div className="mt-2 grid gap-1 text-[11px] text-white/65 sm:grid-cols-2">
        <div>{t("chat.approvalHost", { host: approval.host ?? t("chat.unknownLower") })}</div>
        <div>{t("chat.approvalExpires", { when: formatApprovalExpiry(approval.expiresAtMs) })}</div>
        {approval.cwd ? <div className="sm:col-span-2">{t("chat.approvalCwd", { cwd: approval.cwd })}</div> : null}
      </div>
      {approval.error ? (
        <div className="ui-alert-danger mt-2 rounded-md px-2 py-1 text-[11px] shadow-2xs">
          {approval.error}
        </div>
      ) : null}
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          className={`${CHAT_SECONDARY_BUTTON_CLASS} px-2.5 py-1 text-[12px] tracking-[0.02em]`}
          onClick={() => onResolve?.(approval.id, "allow-once")}
          disabled={disabled}
          aria-label={t("chat.allowOnceLabel", { id: approval.id })}
        >{t("chat.allowOnce")}</button>
        <button
          type="button"
          className={`${CHAT_SECONDARY_BUTTON_CLASS} px-2.5 py-1 text-[12px] tracking-[0.02em]`}
          onClick={() => onResolve?.(approval.id, "allow-always")}
          disabled={disabled}
          aria-label={t("chat.allowAlwaysLabel", { id: approval.id })}
        >{t("chat.allowAlways")}</button>
        <button
          type="button"
          className="ui-btn-danger rounded-md px-2.5 py-1 font-mono text-[12px] font-medium tracking-[0.02em] transition disabled:cursor-not-allowed disabled:opacity-60"
          onClick={() => onResolve?.(approval.id, "deny")}
          disabled={disabled}
          aria-label={t("chat.denyLabel", { id: approval.id })}
        >{t("chat.deny")}</button>
      </div>
    </div>
  );
});

const ToolCallDetails = memo(function ToolCallDetails({
  line,
  className,
}: {
  line: string;
  className?: string;
}) {
  const { summaryText, body, inlineOnly } = summarizeToolLabel(line);
  const [open, setOpen] = useState(false);
  const resolvedClassName =
    className ??
    `w-full ${ASSISTANT_MAX_WIDTH_EXPANDED_CLASS} ${ASSISTANT_GUTTER_CLASS} self-start rounded-md border border-border bg-surface-2 px-2 py-1 text-[10px] text-white/65`;
  if (inlineOnly) {
    return (
      <div className={resolvedClassName}>
        <div className="font-mono text-[10px] font-semibold tracking-[0.11em]">{summaryText}</div>
      </div>
    );
  }
  return (
    <details open={open} className={resolvedClassName}>
      <summary
        className="cursor-pointer select-none font-mono text-[10px] font-semibold tracking-[0.11em] transition-colors hover:text-white"
        onClick={(event) => {
          event.preventDefault();
          setOpen((current) => !current);
        }}
      >
        {summaryText}
      </summary>
      {open && body ? (
        <div className="agent-markdown agent-tool-markdown mt-1 text-white">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {rewriteMediaLinesToMarkdown(body)}
          </ReactMarkdown>
        </div>
      ) : null}
    </details>
  );
});

const ThinkingDetailsRow = memo(function ThinkingDetailsRow({
  events,
  thinkingText,
  toolLines = [],
  durationMs,
  showTyping,
}: {
  events?: AssistantTraceEvent[];
  thinkingText?: string | null;
  toolLines?: string[];
  durationMs?: number;
  showTyping?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const traceEvents = (() => {
    if (events && events.length > 0) return events;
    const normalizedThinkingText = thinkingText?.trim() ?? "";
    const next: AssistantTraceEvent[] = [];
    if (normalizedThinkingText) {
      next.push({ kind: "thinking", text: normalizedThinkingText });
    }
    for (const line of toolLines) {
      next.push({ kind: "tool", text: line });
    }
    return next;
  })();
  if (traceEvents.length === 0) return null;
  return (
    <details
      open={open}
      className="ui-chat-thinking group rounded-md px-2 py-1.5 text-[10px] shadow-2xs"
    >
      <summary
        className="flex cursor-pointer list-none items-center gap-2 text-white/65 transition-colors hover:text-white [&::-webkit-details-marker]:hidden"
        onClick={(event) => {
          event.preventDefault();
          setOpen((current) => !current);
        }}
      >
        <ChevronRight className="h-3 w-3 shrink-0 text-primary transition group-open:rotate-90" />
        <span className="flex min-w-0 items-center gap-2">
          <span className="font-mono text-[10px] font-medium uppercase tracking-[0.12em]">{t("chat.thinkingInternal")}</span>
          {typeof durationMs === "number" ? (
            <span className="inline-flex items-center gap-1 font-mono text-[10px] font-medium tabular-nums tracking-[0.02em] text-white/45">
              <Clock className="h-3 w-3" />
              {formatDurationLabel(durationMs)}
            </span>
          ) : null}
          {showTyping ? (
            <span className="typing-dots text-primary" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
          ) : null}
        </span>
      </summary>
      {open ? (
        <div className="mt-2 space-y-2 pl-5">
          {traceEvents.map((event, index) =>
            event.kind === "thinking" ? (
              <div
                key={`thinking-event-${index}-${event.text.slice(0, 48)}`}
                className="agent-markdown min-w-0 text-white/80"
              >
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{event.text}</ReactMarkdown>
              </div>
            ) : (
              <ToolCallDetails
                key={`thinking-tool-${index}-${event.text.slice(0, 48)}`}
                line={event.text}
                className="rounded-md border border-border bg-black/40 px-2 py-1 text-[10px] text-white/65"
              />
            )
          )}
        </div>
      ) : null}
    </details>
  );
});

const UserMessageCard = memo(function UserMessageCard({
  text,
  timestampMs,
}: {
  text: string;
  timestampMs?: number;
}) {
  return (
    <div className="ui-chat-user-card w-full max-w-[70ch] self-end overflow-hidden rounded-[var(--radius-small)] bg-[color:var(--chat-user-bg)]">
      <div className="flex items-center justify-between gap-3 border-b border-[color:var(--chat-user-border)] bg-[color:var(--chat-user-header-bg)] px-3 py-2 dark:px-3.5 dark:py-2.5">
        <div className={`${CHAT_AUTHOR_CLASS} text-white`}>
          {t("chat.you")}
        </div>
        {typeof timestampMs === "number" ? (
          <time className={CHAT_TIME_CHIP_CLASS}>
            {formatChatTimestamp(timestampMs)}
          </time>
        ) : null}
      </div>
      <div className="agent-markdown type-body px-3 py-3 text-white dark:px-3.5 dark:py-3.5">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
      </div>
    </div>
  );
});

const AssistantMessageCard = memo(function AssistantMessageCard({
  avatarSeed,
  avatarProfile,
  avatarUrl,
  name,
  timestampMs,
  thinkingEvents,
  thinkingText,
  thinkingToolLines,
  thinkingDurationMs,
  contentText,
  streaming,
}: {
  avatarSeed: string;
  avatarProfile?: AgentAvatarProfile | null;
  avatarUrl: string | null;
  name: string;
  timestampMs?: number;
  thinkingEvents?: AssistantTraceEvent[];
  thinkingText?: string | null;
  thinkingToolLines?: string[];
  thinkingDurationMs?: number;
  contentText?: string | null;
  streaming?: boolean;
}) {
  const resolvedTimestamp = typeof timestampMs === "number" ? timestampMs : null;
  const hasThinking = Boolean(
    (thinkingEvents?.length ?? 0) > 0 ||
      thinkingText?.trim() ||
      (thinkingToolLines?.length ?? 0) > 0
  );
  const widthClass = hasThinking
    ? ASSISTANT_MAX_WIDTH_EXPANDED_CLASS
    : resolveAssistantMaxWidthClass(contentText);
  const hasContent = Boolean(contentText?.trim());
  const compactStreamingIndicator = Boolean(streaming && !hasThinking && !hasContent);

  return (
    <div className="w-full self-start">
      <div className={`relative w-full ${widthClass} ${ASSISTANT_GUTTER_CLASS}`}>
        <div className="absolute left-[4px] top-[2px]">
          <AgentAvatar
            seed={avatarSeed}
            name={name}
            avatarProfile={avatarProfile}
            avatarUrl={avatarUrl}
            size={22}
          />
        </div>
        <div className="flex items-center justify-between gap-3 py-0.5">
          <div className={`${CHAT_AUTHOR_CLASS} text-white`}>
            {name}
          </div>
          {resolvedTimestamp !== null ? (
            <time className={CHAT_TIME_CHIP_CLASS}>
              {formatChatTimestamp(resolvedTimestamp)}
            </time>
          ) : null}
        </div>

        {compactStreamingIndicator ? (
          <div
            className="mt-2 inline-flex items-center gap-2 rounded-md border border-border bg-surface-1 px-3 py-2 text-[10px] text-white/65"
            role="status"
            aria-live="polite"
            data-testid="agent-typing-indicator"
          >
            <span className="font-mono text-[10px] font-medium uppercase tracking-[0.12em]">{t("chat.thinking")}</span>
            <span className="typing-dots text-primary" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
          </div>
        ) : (
          <div className="mt-2 space-y-3 dark:space-y-5">
            {streaming && !hasThinking ? (
              <div
                className="flex items-center gap-2 text-[10px] text-white/65"
                role="status"
                aria-live="polite"
                data-testid="agent-typing-indicator"
              >
                <span className="font-mono text-[10px] font-medium uppercase tracking-[0.12em]">{t("chat.thinking")}</span>
                <span className="typing-dots text-primary" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </span>
              </div>
            ) : null}

            {hasThinking ? (
              <ThinkingDetailsRow
                events={thinkingEvents}
                thinkingText={thinkingText}
                toolLines={thinkingToolLines ?? []}
                durationMs={thinkingDurationMs}
                showTyping={streaming}
              />
            ) : null}

            {contentText ? (
              <div className="ui-chat-assistant-card">
                {streaming ? (
                  (() => {
                    if (!contentText.includes("MEDIA:")) {
                      return (
                        <div className="whitespace-pre-wrap break-words text-white">
                          {contentText}
                        </div>
                      );
                    }
                    const rewritten = rewriteMediaLinesToMarkdown(contentText);
                    if (!rewritten.includes("![](")) {
                      return (
                        <div className="whitespace-pre-wrap break-words text-white">
                          {contentText}
                        </div>
                      );
                    }
                    return (
                      <div className="agent-markdown text-white">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{rewritten}</ReactMarkdown>
                      </div>
                    );
                  })()
                ) : (
                  <div className="agent-markdown text-white">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {rewriteMediaLinesToMarkdown(contentText)}
                    </ReactMarkdown>
                  </div>
                )}
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
});

const AssistantIntroCard = memo(function AssistantIntroCard({
  avatarSeed,
  avatarProfile,
  avatarUrl,
  name,
  title,
}: {
  avatarSeed: string;
  avatarProfile?: AgentAvatarProfile | null;
  avatarUrl: string | null;
  name: string;
  title: string;
}) {
  return (
    <div className="w-full self-start">
      <div className={`relative w-full ${ASSISTANT_MAX_WIDTH_DEFAULT_CLASS} ${ASSISTANT_GUTTER_CLASS}`}>
        <div className="absolute left-[4px] top-[2px]">
          <AgentAvatar
            seed={avatarSeed}
            name={name}
            avatarProfile={avatarProfile}
            avatarUrl={avatarUrl}
            size={22}
          />
        </div>
        <div className="flex items-center justify-between gap-3 py-0.5">
          <div className={`${CHAT_AUTHOR_CLASS} text-white`}>
            {name}
          </div>
        </div>
        <div className="ui-chat-assistant-card mt-2">
          <div className="text-[14px] leading-[1.65] text-white">{title}</div>
          <div className="mt-2 font-mono text-[10px] tracking-[0.03em] text-white/45">{t("chat.emptyHint")}</div>
        </div>
      </div>
    </div>
  );
});

const AgentChatFinalItems = memo(function AgentChatFinalItems({
  agentId,
  name,
  avatarSeed,
  avatarProfile,
  avatarUrl,
  chatItems,
  running,
  runStartedAt,
}: {
  agentId: string;
  name: string;
  avatarSeed: string;
  avatarProfile?: AgentAvatarProfile | null;
  avatarUrl: string | null;
  chatItems: AgentChatItem[];
  running: boolean;
  runStartedAt: number | null;
}) {
  const blocks = buildAgentChatRenderBlocks(chatItems);

  return (
    <>
      {blocks.map((block, index) => {
        if (block.kind === "user") {
          return (
            <UserMessageCard
              key={`chat-${agentId}-user-${index}`}
              text={block.text}
              timestampMs={block.timestampMs}
            />
          );
        }
        const streaming = running && index === blocks.length - 1 && !block.text;
        return (
          <AssistantMessageCard
            key={`chat-${agentId}-assistant-${index}`}
            avatarSeed={avatarSeed}
            avatarProfile={avatarProfile}
            avatarUrl={avatarUrl}
            name={name}
            timestampMs={block.timestampMs ?? (streaming ? runStartedAt ?? undefined : undefined)}
            thinkingEvents={block.traceEvents}
            thinkingDurationMs={block.thinkingDurationMs}
            contentText={block.text}
            streaming={streaming}
          />
        );
      })}
    </>
  );
});

const AgentChatTranscript = memo(function AgentChatTranscript({
  agentId,
  name,
  avatarSeed,
  avatarProfile,
  avatarUrl,
  status,
  historyMaybeTruncated,
  historyFetchedCount,
  historyFetchLimit,
  onLoadMoreHistory,
  chatItems,
  liveThinkingText,
  liveAssistantText,
  showTypingIndicator,
  outputLineCount,
  liveAssistantCharCount,
  liveThinkingCharCount,
  runStartedAt,
  scrollToBottomNextOutputRef,
  pendingExecApprovals,
  onResolveExecApproval,
  emptyStateTitle,
}: {
  agentId: string;
  name: string;
  avatarSeed: string;
  avatarProfile?: AgentAvatarProfile | null;
  avatarUrl: string | null;
  status: AgentRecord["status"];
  historyMaybeTruncated: boolean;
  historyFetchedCount: number | null;
  historyFetchLimit: number | null;
  onLoadMoreHistory: () => void;
  chatItems: AgentChatItem[];
  liveThinkingText: string;
  liveAssistantText: string;
  showTypingIndicator: boolean;
  outputLineCount: number;
  liveAssistantCharCount: number;
  liveThinkingCharCount: number;
  runStartedAt: number | null;
  scrollToBottomNextOutputRef: MutableRefObject<boolean>;
  pendingExecApprovals: PendingExecApproval[];
  onResolveExecApproval?: (id: string, decision: ExecApprovalDecision) => void;
  emptyStateTitle: string;
}) {
  const chatRef = useRef<HTMLDivElement | null>(null);
  const chatBottomRef = useRef<HTMLDivElement | null>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const pinnedRef = useRef(true);
  const [isPinned, setIsPinned] = useState(true);
  const [isAtTop, setIsAtTop] = useState(false);
  const [nowMs, setNowMs] = useState<number | null>(null);

  const scrollChatToBottom = useCallback(() => {
    if (!chatRef.current) return;
    if (chatBottomRef.current) {
      chatBottomRef.current.scrollIntoView({ block: "end" });
      return;
    }
    chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, []);

  const setPinned = useCallback((nextPinned: boolean) => {
    if (pinnedRef.current === nextPinned) return;
    pinnedRef.current = nextPinned;
    setIsPinned(nextPinned);
  }, []);

  const updatePinnedFromScroll = useCallback(() => {
    const el = chatRef.current;
    if (!el) return;
    const nextAtTop = el.scrollTop <= CHAT_TOP_THRESHOLD_PX;
    setIsAtTop((current) => (current === nextAtTop ? current : nextAtTop));
    setPinned(
      isNearBottom(
        {
          scrollTop: el.scrollTop,
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
        },
        48
      )
    );
  }, [setPinned]);

  const scheduleScrollToBottom = useCallback(() => {
    if (scrollFrameRef.current !== null) return;
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      scrollChatToBottom();
    });
  }, [scrollChatToBottom]);

  useEffect(() => {
    updatePinnedFromScroll();
  }, [updatePinnedFromScroll]);

  const showJumpToLatest =
    !isPinned && (outputLineCount > 0 || liveAssistantCharCount > 0 || liveThinkingCharCount > 0);

  useEffect(() => {
    const shouldForceScroll = scrollToBottomNextOutputRef.current;
    if (shouldForceScroll) {
      scrollToBottomNextOutputRef.current = false;
      scheduleScrollToBottom();
      return;
    }

    if (pinnedRef.current) {
      scheduleScrollToBottom();
      return;
    }
  }, [
    liveAssistantCharCount,
    liveThinkingCharCount,
    outputLineCount,
    pendingExecApprovals.length,
    scheduleScrollToBottom,
    scrollToBottomNextOutputRef,
  ]);

  useEffect(() => {
    return () => {
      if (scrollFrameRef.current !== null) {
        cancelAnimationFrame(scrollFrameRef.current);
        scrollFrameRef.current = null;
      }
    };
  }, []);

  const showLiveAssistantCard =
    status === "running" && Boolean(liveThinkingText || liveAssistantText || showTypingIndicator);
  const hasApprovals = pendingExecApprovals.length > 0;
  const hasTranscriptContent = chatItems.length > 0 || hasApprovals;

  useEffect(() => {
    if (status !== "running" || typeof runStartedAt !== "number" || !showLiveAssistantCard) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setNowMs(Date.now());
    }, 0);
    const intervalId = window.setInterval(() => setNowMs(Date.now()), 250);

    return () => {
      window.clearTimeout(timeoutId);
      window.clearInterval(intervalId);
    };
  }, [runStartedAt, showLiveAssistantCard, status]);

  return (
    <div className="relative flex-1 overflow-hidden">
      <div
        ref={chatRef}
        data-testid="agent-chat-scroll"
        className={`ui-chat-scroll ui-chat-scroll-borderless h-full overflow-auto p-4 dark:p-6 sm:p-5 dark:sm:p-7 ${showJumpToLatest ? "pb-20" : ""}`}
        onScroll={() => updatePinnedFromScroll()}
        onWheel={(event) => {
          event.stopPropagation();
        }}
        onWheelCapture={(event) => {
          event.stopPropagation();
        }}
      >
        <div className="relative flex flex-col gap-6 dark:gap-8 text-[14px] leading-[1.65] text-white">
          <div aria-hidden className={`pointer-events-none absolute ${SPINE_LEFT} top-0 bottom-0 w-px bg-border/50`} />
          {historyMaybeTruncated && isAtTop ? (
            <div className="-mx-1 flex items-center justify-between gap-3 rounded-md border border-border bg-surface-1 px-3 py-2">
              <div className="min-w-0 truncate font-mono text-[11px] tabular-nums text-white/65">
                {t("chat.showingRecent", {
                  count: typeof historyFetchedCount === "number" ? historyFetchedCount : "?",
                })}
                {typeof historyFetchLimit === "number"
                  ? ` ${t("chat.historyLimit", { limit: historyFetchLimit })}`
                  : ""}
              </div>
              <button
                type="button"
                className={`${CHAT_SECONDARY_BUTTON_CLASS} shrink-0 px-3 py-1.5 text-[12px] tracking-[0.02em]`}
                onClick={onLoadMoreHistory}
              >{t("chat.loadMore")}</button>
            </div>
          ) : null}
          {!hasTranscriptContent ? (
            <AssistantIntroCard
              avatarSeed={avatarSeed}
              avatarProfile={avatarProfile}
              avatarUrl={avatarUrl}
              name={name}
              title={emptyStateTitle}
            />
          ) : (
            <>
              <AgentChatFinalItems
                agentId={agentId}
                name={name}
                avatarSeed={avatarSeed}
                avatarProfile={avatarProfile}
                avatarUrl={avatarUrl}
                chatItems={chatItems}
                running={status === "running"}
                runStartedAt={runStartedAt}
              />
              {showLiveAssistantCard ? (
                <AssistantMessageCard
                  avatarSeed={avatarSeed}
                  avatarProfile={avatarProfile}
                  avatarUrl={avatarUrl}
                  name={name}
                  timestampMs={runStartedAt ?? undefined}
                  thinkingText={liveThinkingText || null}
                  thinkingDurationMs={
                    typeof runStartedAt === "number" && typeof nowMs === "number"
                      ? Math.max(0, nowMs - runStartedAt)
                      : undefined
                  }
                  contentText={liveAssistantText || null}
                  streaming={status === "running"}
                />
              ) : null}
              {pendingExecApprovals.map((approval) => (
                <ExecApprovalCard
                  key={approval.id}
                  approval={approval}
                  onResolve={onResolveExecApproval}
                />
              ))}
              <div ref={chatBottomRef} />
            </>
          )}
        </div>
      </div>

      {showJumpToLatest ? (
        <button
          type="button"
          className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-md border border-primary/55 bg-card px-3 py-1.5 font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-white shadow-[0_0_14px_rgba(255,26,26,0.25)] transition-colors hover:bg-primary/20"
          onClick={() => {
            setPinned(true);
            scrollChatToBottom();
          }}
          aria-label={t("chat.jumpToLatest")}
        >{t("chat.jumpToLatest")}</button>
      ) : null}
    </div>
  );
});

const noopToggle = () => {};
const InlineHoverTooltip = ({
  text,
  children,
}: {
  text: string;
  children: ReactNode;
}) => {
  return (
    <div className="group/tooltip relative inline-flex">
      {children}
      <span
        role="tooltip"
        className="pointer-events-none absolute -top-7 left-1/2 z-20 w-max max-w-none -translate-x-1/2 whitespace-nowrap rounded-md border border-border bg-card px-2 py-1 font-mono text-[10px] text-white opacity-0 shadow-[0_6px_18px_rgba(0,0,0,0.6)] transition-opacity duration-150 group-hover/tooltip:opacity-100 group-focus-within/tooltip:opacity-100"
      >
        {text}
      </span>
    </div>
  );
};

const AgentChatComposer = memo(function AgentChatComposer({
  value,
  onChange,
  onKeyDown,
  onSend,
  onAttachmentFiles,
  attachments,
  onRemoveAttachment,
  onVoiceToggle,
  onStop,
  canSend,
  stopBusy,
  stopDisabledReason,
  running,
  sendDisabled,
  voiceEnabled,
  voiceSupported,
  voiceState,
  voiceError,
  attachmentStatus,
  attachmentInputRef,
  queuedMessages,
  onRemoveQueuedMessage,
  inputRef,
  modelOptions,
  modelValue,
  allowThinking,
  thinkingValue,
  onModelChange,
  onThinkingChange,
  toolCallingEnabled,
  showThinkingTraces,
  onToolCallingToggle,
  onThinkingTracesToggle,
}: {
  value: string;
  onChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onSend: () => void;
  onAttachmentFiles: (event: ChangeEvent<HTMLInputElement>) => void;
  attachments: UploadAttachment[];
  onRemoveAttachment: (id: string) => void;
  onVoiceToggle?: () => void;
  onStop: () => void;
  canSend: boolean;
  stopBusy: boolean;
  stopDisabledReason?: string | null;
  running: boolean;
  sendDisabled: boolean;
  voiceEnabled: boolean;
  voiceSupported: boolean;
  voiceState: VoiceRecorderState;
  voiceError?: string | null;
  attachmentStatus?: string | null;
  attachmentInputRef: MutableRefObject<HTMLInputElement | null>;
  queuedMessages: string[];
  onRemoveQueuedMessage?: (index: number) => void;
  inputRef: (el: HTMLTextAreaElement | HTMLInputElement | null) => void;
  modelOptions: { value: string; label: string }[];
  modelValue: string;
  allowThinking: boolean;
  thinkingValue: string;
  onModelChange: (value: string | null) => void;
  onThinkingChange: (value: string | null) => void;
  toolCallingEnabled: boolean;
  showThinkingTraces: boolean;
  onToolCallingToggle: (enabled: boolean) => void;
  onThinkingTracesToggle: (enabled: boolean) => void;
}) {
  const stopReason = stopDisabledReason?.trim() ?? "";
  const stopDisabled = !canSend || stopBusy || Boolean(stopReason);
  const stopAriaLabel = stopReason ? t("chat.stopUnavailable", { reason: stopReason }) : t("chat.stop");
  const voiceBusy = voiceState === "requesting" || voiceState === "transcribing";
  const voiceRecording = voiceState === "recording";
  const voiceDisabled = voiceRecording ? false : !voiceEnabled || !voiceSupported || !canSend || voiceBusy;
  const voiceLabel =
    voiceState === "recording"
      ? t("chat.stop")
      : voiceState === "transcribing"
        ? "..."
        : voiceState === "requesting"
          ? t("chat.micRequesting")
          : t("chat.mic");
  const voiceStatusText =
    voiceState === "recording"
      ? t("chat.recording")
      : voiceState === "transcribing"
        ? t("chat.transcribing")
        : voiceState === "requesting"
          ? t("chat.requestingMic")
          : !voiceSupported && voiceEnabled
            ? t("chat.micUnsupported")
            : null;
  const modelSelectedLabel = useMemo(() => {
    if (modelOptions.length === 0) return t("chat.noModels");
    return modelOptions.find((option) => option.value === modelValue)?.label ?? modelValue;
  }, [modelOptions, modelValue]);
  const modelSelectWidthCh = Math.max(11, Math.min(44, modelSelectedLabel.length + 6));
  const thinkingSelectedLabel = useMemo(() => {
    switch (thinkingValue) {
      case "off":
        return t("chat.effortOff");
      case "minimal":
        return t("chat.effortMinimal");
      case "low":
        return t("chat.effortLow");
      case "medium":
        return t("chat.effortMedium");
      case "high":
        return t("chat.effortHigh");
      case "xhigh":
        return t("chat.effortXHigh");
      default:
        return t("chat.effortDefault");
    }
  }, [thinkingValue]);
  const thinkingSelectWidthCh = Math.max(9, Math.min(22, thinkingSelectedLabel.length + 6));
  return (
    <>
      <div className="mb-1.5 flex items-center justify-between gap-2 px-1">
        <div className="flex min-w-0 items-center gap-2">
          <InlineHoverTooltip text={t("chat.chooseModel")}>
            <select
              className={CHAT_SELECT_CLASS}
              aria-label={t("chat.model")}
              value={modelValue}
              style={{ width: `${modelSelectWidthCh}ch` }}
              onChange={(event) => {
                const nextValue = event.target.value.trim();
                onModelChange(nextValue ? nextValue : null);
                event.currentTarget.blur();
              }}
            >
              {modelOptions.length === 0 ? (
                <option value="">{t("chat.noModels")}</option>
              ) : null}
              {modelOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </InlineHoverTooltip>
          {allowThinking ? (
            <InlineHoverTooltip text={t("chat.selectEffort")}>
              <select
                className={CHAT_SELECT_CLASS}
                aria-label={t("chat.thinking")}
                value={thinkingValue}
                style={{ width: `${thinkingSelectWidthCh}ch` }}
                onChange={(event) => {
                  const nextValue = event.target.value.trim();
                  onThinkingChange(nextValue ? nextValue : null);
                }}
              >
                <option value="">{t("chat.effortDefault")}</option>
                <option value="off">{t("chat.effortOff")}</option>
                <option value="minimal">{t("chat.effortMinimal")}</option>
                <option value="low">{t("chat.effortLow")}</option>
                <option value="medium">{t("chat.effortMedium")}</option>
                <option value="high">{t("chat.effortHigh")}</option>
                <option value="xhigh">{t("chat.effortXHigh")}</option>
              </select>
            </InlineHoverTooltip>
          ) : null}
        </div>
        <div className="hidden">
          <span className="font-mono tracking-[0.02em]">{t("chat.show")}</span>
          <button
            type="button"
            role="switch"
            aria-label={t("chat.showTools")}
            aria-checked={toolCallingEnabled}
            className={`inline-flex h-5 items-center rounded-sm border px-1.5 font-mono text-[10px] tracking-[0.01em] transition ${
              toolCallingEnabled
                ? "border-primary/60 bg-primary/20 text-white"
                : "border-border bg-black/40 text-white/65 hover:text-white"
            }`}
            onClick={() => onToolCallingToggle(!toolCallingEnabled)}
          >{t("chat.tools")}</button>
          <button
            type="button"
            role="switch"
            aria-label={t("chat.showThinking")}
            aria-checked={showThinkingTraces}
            className={`inline-flex h-5 items-center rounded-sm border px-1.5 font-mono text-[10px] tracking-[0.01em] transition ${
              showThinkingTraces
                ? "border-primary/60 bg-primary/20 text-white"
                : "border-border bg-black/40 text-white/65 hover:text-white"
            }`}
            onClick={() => onThinkingTracesToggle(!showThinkingTraces)}
          >{t("chat.thinking")}</button>
        </div>
      </div>
      <div className="rounded-lg border border-border bg-black/60 px-3 py-2 transition-[border-color,box-shadow] duration-200 focus-within:border-primary/60 focus-within:shadow-[0_0_14px_rgba(255,26,26,0.18)]">
        {queuedMessages.length > 0 ? (
          <div
            className={`mb-2 grid items-start gap-2 ${
              running ? "grid-cols-[minmax(0,1fr)_auto_auto]" : "grid-cols-[minmax(0,1fr)_auto]"
            }`}
          >
            <div
              className="min-w-0 max-w-full space-y-1 overflow-hidden"
              data-testid="queued-messages-bar"
              aria-label={t("chat.queuedMessages")}
            >
              {queuedMessages.map((queuedMessage, index) => (
                <div
                  key={`${index}-${queuedMessage}`}
                  className="flex w-full min-w-0 max-w-full items-center gap-1.5 overflow-hidden rounded-md border border-border bg-card px-2 py-1 text-[11px] text-white"
                >
                  <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-white/45">{t("chat.queued")}</span>
                  <span
                    className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap"
                    title={queuedMessage}
                  >
                    {queuedMessage}
                  </span>
                  <button
                    type="button"
                    className="inline-flex h-4 w-4 flex-none items-center justify-center rounded-sm text-white/45 transition-colors enabled:hover:bg-primary/20 enabled:hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                    aria-label={t("chat.removeQueued", { index: index + 1 })}
                    onClick={() => onRemoveQueuedMessage?.(index)}
                    disabled={!onRemoveQueuedMessage}
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
            {running ? (
              <button
                type="button"
                aria-hidden="true"
                tabIndex={-1}
                disabled
                className={`${CHAT_SECONDARY_BUTTON_CLASS} invisible px-3 py-2 text-[12px] tracking-[0.02em]`}
              >
                {stopBusy ? t("chat.stopping") : t("chat.stop")}
              </button>
            ) : null}
            <button
              type="button"
              aria-hidden="true"
              tabIndex={-1}
              disabled
              className={`${CHAT_PRIMARY_BUTTON_CLASS} invisible px-3.5 py-2 text-[12px] tracking-[0.12em]`}
            >{t("chat.send")}</button>
          </div>
        ) : null}
        {attachments.length > 0 ? (
          <div className="mb-2 flex flex-wrap gap-2">
            {attachments.map((attachment) => {
              const isImage = attachment.contentType.startsWith("image/");
              return (
                <div
                  key={attachment.id}
                  className="relative overflow-hidden rounded-md border border-border bg-card"
                >
                  {isImage ? (
                    // A thumbnail of a file the person just uploaded, served by
                    // /api/files; next/image would only proxy it back again.
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={attachment.url}
                      alt={attachment.name}
                      className="h-16 w-16 object-cover"
                    />
                  ) : (
                    <div className="flex h-16 w-16 items-center justify-center px-2 text-center font-mono text-[10px] uppercase tracking-[0.14em] text-white/65">{t("chat.file")}</div>
                  )}
                  <button
                    type="button"
                    className="absolute right-1 top-1 inline-flex h-4 w-4 items-center justify-center rounded-full bg-black/75 text-white transition-colors hover:bg-primary"
                    aria-label={t("chat.removeAttachment", { name: attachment.name })}
                    onClick={() => onRemoveAttachment(attachment.id)}
                  >
                    <X className="h-3 w-3" />
                  </button>
                  <div className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/85 to-transparent px-1 py-0.5 text-[10px] text-white">
                    {attachment.name}
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}
        {voiceStatusText || voiceError || attachmentStatus ? (
          <div
            className={`mb-2 rounded-md px-2.5 py-1.5 font-mono text-[10px] tracking-[0.02em] ${
              voiceError
                ? "ui-alert-danger"
                : "border border-border bg-surface-2 text-white/80"
            }`}
            data-testid="agent-voice-status"
          >
            {voiceError ?? voiceStatusText ?? attachmentStatus}
          </div>
        ) : null}
        {/* The text gets the full width; the actions sit on their own row below. */}
        <div className="flex flex-col gap-2">
          <input
            ref={attachmentInputRef}
            type="file"
            className="hidden"
            multiple
            accept=".txt,.md,.markdown,.json,.js,.jsx,.ts,.tsx,.py,.rb,.go,.rs,.java,.kt,.sql,.html,.css,.xml,.yaml,.yml,.csv,.log,.png,.jpg,.jpeg,.gif,.webp,.pdf,text/*,application/json,application/xml,image/*,application/pdf"
            onChange={onAttachmentFiles}
          />
          <textarea
            ref={inputRef}
            rows={1}
            value={value}
            className="chat-composer-input min-h-[64px] w-full resize-none border-0 bg-transparent px-0 py-1 text-[15px] leading-6 text-white caret-primary outline-none shadow-none transition placeholder:text-white/35 focus:outline-none focus-visible:outline-none focus-visible:ring-0"
            onChange={onChange}
            onKeyDown={onKeyDown}
            placeholder={t("chat.placeholder")}
          />
          <div className="flex flex-wrap items-center justify-end gap-2">
          <button
            className={`${CHAT_SECONDARY_BUTTON_CLASS} px-2.5 py-2 text-[11px] tracking-[0.02em]`}
            type="button"
            onClick={() => attachmentInputRef.current?.click()}
            disabled={!canSend}
            aria-label={t("chat.attachFiles")}
            title={t("chat.attachFiles")}
          >
            <span className="inline-flex items-center gap-1.5">
              <Paperclip className="h-3.5 w-3.5" />
              <span>{t("chat.attach")}</span>
            </span>
          </button>
          {voiceEnabled ? (
            <button
              className={`px-2.5 py-2 text-[11px] tracking-[0.02em] ${
                voiceRecording
                  ? "rounded-md border border-primary/70 bg-primary/25 font-mono font-medium text-white shadow-[0_0_14px_rgba(255,26,26,0.35)] transition-colors"
                  : CHAT_SECONDARY_BUTTON_CLASS
              }`}
              type="button"
              onClick={onVoiceToggle}
              disabled={voiceDisabled}
              data-testid="agent-voice-toggle"
              aria-label={voiceRecording ? t("chat.stopRecording") : t("chat.startRecording")}
              title={voiceRecording ? t("chat.stopRecording") : t("chat.startRecording")}
            >
              <span className="inline-flex items-center gap-1.5">
                {voiceRecording ? <Square className="h-3.5 w-3.5" /> : <Mic className="h-3.5 w-3.5" />}
                <span>{voiceLabel}</span>
              </span>
            </button>
          ) : null}
          {running ? (
            <span className="inline-flex" title={stopReason || undefined}>
              <button
                className={`${CHAT_SECONDARY_BUTTON_CLASS} px-3 py-2 text-[12px] tracking-[0.02em]`}
                type="button"
                onClick={onStop}
                disabled={stopDisabled}
                aria-label={stopAriaLabel}
              >
                {stopBusy ? t("chat.stopping") : t("chat.stop")}
              </button>
            </span>
          ) : null}
          <button
            className={`${CHAT_PRIMARY_BUTTON_CLASS} px-3.5 py-2 text-[12px] tracking-[0.12em]`}
            type="button"
            onClick={onSend}
            disabled={sendDisabled}
          >{t("chat.send")}</button>
          </div>
        </div>
      </div>
    </>
  );
});

export const AgentChatPanel = ({
  agent,
  isSelected,
  canSend,
  models,
  stopBusy,
  stopDisabledReason = null,
  onLoadMoreHistory,
  onOpenSettings,
  onRename,
  onNewSession,
  onModelChange,
  onThinkingChange,
  onToolCallingToggle = noopToggle,
  onThinkingTracesToggle = noopToggle,
  onDraftChange,
  onSend,
  onRemoveQueuedMessage,
  onStopRun,
  onAvatarShuffle,
  pendingExecApprovals = [],
  onResolveExecApproval,
  onVoiceSend,
}: AgentChatPanelProps) => {
  const [draftValue, setDraftValue] = useState(agent.draft);
  const [newSessionBusy, setNewSessionBusy] = useState(false);
  const [renameEditing, setRenameEditing] = useState(false);
  const [renameSaving, setRenameSaving] = useState(false);
  const [renameDraft, setRenameDraft] = useState(agent.name);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [attachmentStatus, setAttachmentStatus] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<UploadAttachment[]>([]);
  const draftRef = useRef<HTMLTextAreaElement | null>(null);
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const renameEditorRef = useRef<HTMLDivElement | null>(null);
  const scrollToBottomNextOutputRef = useRef(false);
  const plainDraftRef = useRef(agent.draft);
  const draftIdentityRef = useRef<{ agentId: string; sessionKey: string }>({
    agentId: agent.agentId,
    sessionKey: agent.sessionKey,
  });
  const pendingResizeFrameRef = useRef<number | null>(null);
  const {
    state: voiceState,
    error: voiceError,
    supported: voiceSupported,
    toggle: toggleVoiceRecording,
  } = useVoiceRecorder({
    enabled: Boolean(onVoiceSend),
    onVoiceSend,
  });

  const resizeDraft = useCallback(() => {
    const el = draftRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
    el.style.overflowY = el.scrollHeight > el.clientHeight ? "auto" : "hidden";
  }, []);

  const handleDraftRef = useCallback((el: HTMLTextAreaElement | HTMLInputElement | null) => {
    draftRef.current = el instanceof HTMLTextAreaElement ? el : null;
  }, []);

  useEffect(() => {
    const previousIdentity = draftIdentityRef.current;
    const identityChanged =
      previousIdentity.agentId !== agent.agentId ||
      previousIdentity.sessionKey !== agent.sessionKey;
    if (identityChanged) {
      draftIdentityRef.current = {
        agentId: agent.agentId,
        sessionKey: agent.sessionKey,
      };
      plainDraftRef.current = agent.draft;
      setDraftValue(agent.draft);
      setAttachments([]);
      setAttachmentStatus(null);
      return;
    }
    if (agent.draft === plainDraftRef.current) return;
    if (agent.draft.length !== 0) return;
    plainDraftRef.current = "";
    setDraftValue("");
  }, [agent.agentId, agent.draft, agent.sessionKey]);

  useEffect(() => {
    setRenameEditing(false);
    setRenameSaving(false);
    setRenameError(null);
    setRenameDraft(agent.name);
  }, [agent.agentId, agent.name]);

  useEffect(() => {
    if (!renameEditing) return;
    const frameId = requestAnimationFrame(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    });
    return () => {
      cancelAnimationFrame(frameId);
    };
  }, [renameEditing]);

  useEffect(() => {
    if (pendingResizeFrameRef.current !== null) {
      cancelAnimationFrame(pendingResizeFrameRef.current);
    }
    pendingResizeFrameRef.current = requestAnimationFrame(() => {
      pendingResizeFrameRef.current = null;
      resizeDraft();
    });
    return () => {
      if (pendingResizeFrameRef.current !== null) {
        cancelAnimationFrame(pendingResizeFrameRef.current);
        pendingResizeFrameRef.current = null;
      }
    };
  }, [resizeDraft, draftValue]);

  const handleSend = useCallback(
    (message: string) => {
      if (!canSend) return;
      const trimmed = message.trim();
      if (!trimmed && attachments.length === 0) return;
      const pendingAttachments = attachments.map(({ id: _id, ...rest }) => rest as RuntimeAttachment);
      plainDraftRef.current = "";
      setDraftValue("");
      setAttachments([]);
      setAttachmentStatus(null);
      onDraftChange("");
      scrollToBottomNextOutputRef.current = true;
      onSend(trimmed, pendingAttachments);
    },
    [attachments, canSend, onDraftChange, onSend]
  );

  const chatItems = useMemo(
    () =>
      buildFinalAgentChatItems({
        outputLines: agent.outputLines,
        showThinkingTraces: agent.showThinkingTraces,
        toolCallingEnabled: agent.toolCallingEnabled,
      }),
    [agent.outputLines, agent.showThinkingTraces, agent.toolCallingEnabled]
  );
  const running = agent.status === "running";
  const renderBlocks = useMemo(() => buildAgentChatRenderBlocks(chatItems), [chatItems]);
  const hasActiveStreamingTailInTranscript =
    running && renderBlocks.length > 0 && !renderBlocks[renderBlocks.length - 1].text;
  const liveAssistantText =
    running && agent.streamText ? normalizeAssistantDisplayText(agent.streamText) : "";
  const liveThinkingText =
    running && agent.showThinkingTraces && agent.thinkingTrace ? agent.thinkingTrace.trim() : "";
  const hasVisibleLiveThinking = Boolean(liveThinkingText.trim());
  const showTypingIndicator =
    running &&
    !hasVisibleLiveThinking &&
    !liveAssistantText &&
    !hasActiveStreamingTailInTranscript;

  const modelOptions = useMemo(
    () =>
      models.map((entry) => {
        const key = `${entry.provider}/${entry.id}`;
        const alias = typeof entry.name === "string" ? entry.name.trim() : "";
        return {
          value: key,
          label: !alias || alias === key ? key : alias,
          reasoning: entry.reasoning,
        };
      }),
    [models]
  );
  const modelValue = agent.model ?? "";
  const modelOptionsWithFallback =
    modelValue && !modelOptions.some((option) => option.value === modelValue)
      ? [{ value: modelValue, label: modelValue, reasoning: undefined }, ...modelOptions]
      : modelOptions;
  const selectedModel = modelOptionsWithFallback.find((option) => option.value === modelValue);
  const allowThinking = selectedModel?.reasoning !== false;

  const avatarSeed = agent.avatarSeed ?? agent.agentId;
  const avatarProfile = agent.avatarProfile ?? null;
  const emptyStateTitle = useMemo(
    () => resolveEmptyChatIntroMessage(agent.agentId, agent.sessionEpoch),
    [agent.agentId, agent.sessionEpoch]
  );
  const sendDisabled = !canSend || (!draftValue.trim() && attachments.length === 0);

  const handleComposerChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      const value = event.target.value;
      plainDraftRef.current = value;
      setDraftValue(value);
      onDraftChange(value);
    },
    [onDraftChange]
  );

  const handleComposerKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
      if (event.key !== "Enter" || event.shiftKey) return;
      if (event.defaultPrevented) return;
      event.preventDefault();
      handleSend(draftValue);
    },
    [draftValue, handleSend]
  );

  const handleComposerSend = useCallback(() => {
    handleSend(draftValue);
  }, [draftValue, handleSend]);

  const handleAttachmentFiles = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files ?? []);
      event.target.value = "";
      if (files.length === 0) return;
      const oversized = files.filter((file) => file.size > MAX_UPLOAD_BYTES);
      const supported = files.filter((file) => file.size <= MAX_UPLOAD_BYTES);
      if (supported.length === 0) {
        setAttachmentStatus(t("chat.allOversized"));
        return;
      }
      try {
        const uploaded = await Promise.all(
          supported.map(async (file) => {
            const formData = new FormData();
            formData.append("file", file);
            const response = await fetch("/api/files/upload", {
              method: "POST",
              body: formData,
            });
            const payload = (await response.json()) as Record<string, unknown>;
            if (!response.ok) {
              const message =
                typeof payload.error === "string"
                  ? payload.error
                  : t("chat.uploadFailed", { name: file.name });
              throw new Error(message);
            }
            return {
              id: String(payload.id ?? ""),
              name: String(payload.name ?? file.name),
              url: String(payload.url ?? ""),
              contentType: String(payload.contentType ?? file.type ?? "application/octet-stream"),
              extractedText:
                typeof payload.extractedText === "string" ? payload.extractedText : undefined,
            } satisfies UploadAttachment;
          })
        );
        setAttachments((current) => [...current, ...uploaded]);
        const statusParts = [t("chat.uploaded", { count: uploaded.length })];
        if (oversized.length > 0) {
          statusParts.push(t("chat.oversizedSkipped", { count: oversized.length }));
        }
        setAttachmentStatus(statusParts.join(" "));
        scrollToBottomNextOutputRef.current = true;
      } catch (error) {
        setAttachmentStatus(
          error instanceof Error ? error.message : t("chat.readAttachmentsFailed")
        );
      }
    },
    []
  );

  const handleRemoveAttachment = useCallback((id: string) => {
    setAttachments((current) => current.filter((attachment) => attachment.id !== id));
  }, []);

  const handleVoiceToggle = useCallback(
    () => {
      if (!canSend && voiceState !== "recording") return;
      void toggleVoiceRecording();
    },
    [canSend, toggleVoiceRecording, voiceState],
  );

  const beginRename = useCallback(() => {
    if (!onRename) return;
    setRenameEditing(true);
    setRenameDraft(agent.name);
    setRenameError(null);
  }, [agent.name, onRename]);

  const cancelRename = useCallback(() => {
    if (renameSaving) return;
    setRenameEditing(false);
    setRenameDraft(agent.name);
    setRenameError(null);
  }, [agent.name, renameSaving]);

  useEffect(() => {
    if (!renameEditing) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (renameEditorRef.current?.contains(target)) return;
      cancelRename();
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
    };
  }, [cancelRename, renameEditing]);

  const submitRename = useCallback(async () => {
    if (!onRename || renameSaving) return;
    const nextName = renameDraft.trim();
    const currentName = agent.name.trim();
    if (!nextName) {
      setRenameError(t("chat.nameRequired"));
      return;
    }
    if (nextName === currentName) {
      setRenameEditing(false);
      setRenameError(null);
      setRenameDraft(agent.name);
      return;
    }
    setRenameSaving(true);
    setRenameError(null);
    try {
      const ok = await onRename(nextName);
      if (!ok) {
        setRenameError(t("chat.renameFailed"));
        return;
      }
      setRenameEditing(false);
      setRenameDraft(nextName);
    } finally {
      setRenameSaving(false);
    }
  }, [agent.name, onRename, renameDraft, renameSaving]);

  const handleRenameInputKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void submitRename();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        cancelRename();
      }
    },
    [cancelRename, submitRename]
  );

  const handleNewSession = useCallback(async () => {
    if (!onNewSession || newSessionBusy || !canSend) return;
    setNewSessionBusy(true);
    try {
      await onNewSession();
    } finally {
      setNewSessionBusy(false);
    }
  }, [canSend, newSessionBusy, onNewSession]);

  const newSessionDisabled = newSessionBusy || !canSend || !onNewSession;

  return (
    <div data-agent-panel className="group fade-up relative flex h-full w-full flex-col text-white">
      <div className="border-b border-white/10 px-3 pb-3 pt-2.5 sm:px-4 sm:pt-3">
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <div className="group/avatar relative">
              <AgentAvatar
                seed={avatarSeed}
                name={agent.name}
                avatarProfile={avatarProfile}
                avatarUrl={agent.avatarUrl ?? null}
                size={52}
                isSelected={isSelected}
              />
              <button
                className="nodrag absolute -bottom-0.5 -right-0.5 inline-flex h-5 w-5 items-center justify-center rounded-full border border-primary/60 bg-card text-white shadow-[0_0_10px_rgba(255,26,26,0.35)] transition-colors hover:border-primary hover:bg-primary"
                type="button"
                aria-label={t("chat.customizeAvatar")}
                data-testid="agent-avatar-customize"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onAvatarShuffle();
                }}
              >
                <Pencil className="h-2.5 w-2.5" />
              </button>
            </div>

            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <div className="min-w-0 w-[clamp(11rem,34vw,16rem)]">
                  {renameEditing ? (
                    <div ref={renameEditorRef} className="flex h-8 items-center gap-1.5">
                      <input
                        ref={renameInputRef}
                        className="ui-input agent-rename-input h-8 min-w-0 flex-1 rounded-md px-2 text-[12px] font-semibold text-white"
                        aria-label={t("chat.editName")}
                        data-testid="agent-rename-input"
                        value={renameDraft}
                        disabled={renameSaving}
                        onChange={(event) => {
                          setRenameDraft(event.target.value);
                          if (renameError) setRenameError(null);
                        }}
                        onKeyDown={handleRenameInputKeyDown}
                      />
                      <button
                        className={`${CHAT_ICON_BUTTON_CLASS} agent-rename-control h-8 w-8`}
                        type="button"
                        aria-label={t("chat.saveName")}
                        data-testid="agent-rename-save"
                        onClick={() => {
                          void submitRename();
                        }}
                        disabled={renameSaving}
                      >
                        <Check className="h-3.5 w-3.5" />
                      </button>
                      <button
                        className={`${CHAT_ICON_BUTTON_CLASS} agent-rename-control h-8 w-8`}
                        type="button"
                        aria-label={t("chat.cancelRename")}
                        data-testid="agent-rename-cancel"
                        onClick={cancelRename}
                        disabled={renameSaving}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ) : (
                    <div className="flex h-8 min-w-0 items-center gap-1.5">
                      <div className="type-agent-name min-w-0 truncate text-white">
                        {agent.name}
                      </div>
                      {onRename ? (
                        <button
                          className={`${CHAT_ICON_BUTTON_CLASS} agent-rename-control h-6 w-6`}
                          type="button"
                          aria-label={t("chat.rename")}
                          data-testid="agent-rename-toggle"
                          onClick={beginRename}
                        >
                          <Pencil className="h-3 w-3" />
                        </button>
                      ) : null}
                    </div>
                  )}
                </div>
              </div>
              {renameError ? (
                <div className="ui-text-danger mt-1 text-[11px]">{renameError}</div>
              ) : null}
            </div>
          </div>

          <div className="mt-0.5 flex items-center gap-2">
            {onOpenSettings ? (
              <button
                className={`nodrag ${CHAT_ICON_BUTTON_CLASS} h-7 w-7`}
                type="button"
                data-testid="agent-settings-toggle"
                aria-label={t("chat.openBehavior")}
                title={t("chat.openBehavior")}
                onClick={onOpenSettings}
              >
                <SlidersHorizontal className="h-3.5 w-3.5" />
              </button>
            ) : null}
            <button
              className="nodrag inline-flex h-7 items-center whitespace-nowrap rounded-md border border-primary/45 bg-primary/15 px-2.5 font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-white transition-colors enabled:hover:border-primary/70 enabled:hover:bg-primary/25 disabled:cursor-not-allowed disabled:opacity-40"
              type="button"
              data-testid="agent-new-session-toggle"
              aria-label={t("chat.newSessionLabel")}
              title={t("chat.newSessionLabel")}
              onClick={() => {
                void handleNewSession();
              }}
              disabled={newSessionDisabled}
            >
              {newSessionBusy ? t("chat.starting") : t("chat.newSession")}
            </button>
          </div>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col px-3 pb-3 sm:px-4 sm:pb-4">
        <AgentChatTranscript
          agentId={agent.agentId}
          name={agent.name}
          avatarSeed={avatarSeed}
          avatarProfile={avatarProfile}
          avatarUrl={agent.avatarUrl ?? null}
          status={agent.status}
          historyMaybeTruncated={agent.historyMaybeTruncated}
          historyFetchedCount={agent.historyFetchedCount}
          historyFetchLimit={agent.historyFetchLimit}
          onLoadMoreHistory={onLoadMoreHistory}
          chatItems={chatItems}
          liveThinkingText={liveThinkingText}
          liveAssistantText={liveAssistantText}
          showTypingIndicator={showTypingIndicator}
          outputLineCount={agent.outputLines.length}
          liveAssistantCharCount={liveAssistantText.length}
          liveThinkingCharCount={liveThinkingText.length}
          runStartedAt={agent.runStartedAt}
          scrollToBottomNextOutputRef={scrollToBottomNextOutputRef}
          pendingExecApprovals={pendingExecApprovals}
          onResolveExecApproval={onResolveExecApproval}
          emptyStateTitle={emptyStateTitle}
        />

        <div className="mt-3">
          <AgentChatComposer
            value={draftValue}
            inputRef={handleDraftRef}
            onChange={handleComposerChange}
            onKeyDown={handleComposerKeyDown}
            onSend={handleComposerSend}
            onAttachmentFiles={handleAttachmentFiles}
            attachments={attachments}
            onRemoveAttachment={handleRemoveAttachment}
            onVoiceToggle={handleVoiceToggle}
            onStop={onStopRun}
            canSend={canSend}
            stopBusy={stopBusy}
            stopDisabledReason={stopDisabledReason}
            running={running}
            sendDisabled={sendDisabled}
            voiceEnabled={Boolean(onVoiceSend)}
            voiceSupported={voiceSupported}
            voiceState={voiceState}
            voiceError={voiceError}
            attachmentStatus={attachmentStatus}
            attachmentInputRef={attachmentInputRef}
            queuedMessages={agent.queuedMessages ?? []}
            onRemoveQueuedMessage={onRemoveQueuedMessage}
            modelOptions={modelOptionsWithFallback.map((option) => ({
              value: option.value,
              label: option.label,
            }))}
            modelValue={modelValue}
            allowThinking={allowThinking}
            thinkingValue={agent.thinkingLevel ?? ""}
            onModelChange={onModelChange}
            onThinkingChange={onThinkingChange}
            toolCallingEnabled={agent.toolCallingEnabled}
            showThinkingTraces={agent.showThinkingTraces}
            onToolCallingToggle={onToolCallingToggle}
            onThinkingTracesToggle={onThinkingTracesToggle}
          />
        </div>
      </div>
    </div>
  );
};
