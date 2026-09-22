"use client";

import { X } from "lucide-react";
import { useEffect } from "react";

import {
  CallFeedPanel,
  type CallRequestDraft,
  type OfficeCallAgent,
} from "@/features/office/components/panels/CallFeedPanel";
import type { CallFeed } from "@/features/office/hooks/useOfficeCallFeed";

/**
 * The phone booth, opened from the office floor.
 *
 * Clicking the booth is how a call starts: the operator picks the agent to
 * speak as, dials, and watches the conversation arrive in the same panel.
 */
export function CallFeedModal({
  open,
  feed,
  agents,
  draft = null,
  onClose,
}: {
  open: boolean;
  feed: CallFeed;
  agents: OfficeCallAgent[];
  /** What an agent was asked to do, when the phone was opened by a request. */
  draft?: CallRequestDraft | null;
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
      aria-label="Office phone"
      onClick={onClose}
    >
      <div
        className="flex h-[min(90vh,900px)] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-cyan-500/20 bg-[#050607]/95 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-cyan-500/10 px-5 py-4">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-cyan-300/80">
              Phone Booth
            </div>
            <div className="mt-1 font-mono text-[11px] text-white/45">
              One number for the whole office. Pick who is calling and watch the line.
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center gap-1 rounded border border-white/10 bg-white/5 px-2 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-white/75 transition-colors hover:bg-white/10"
          >
            <X className="h-3.5 w-3.5" />
            Close
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden p-5">
          <CallFeedPanel feed={feed} agents={agents} draft={draft} />
        </div>
      </div>
    </div>
  );
}
