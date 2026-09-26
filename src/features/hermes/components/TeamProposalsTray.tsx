"use client";

import { useCallback, useEffect, useState } from "react";
import { X } from "lucide-react";
import { t } from "@/lib/i18n";
import { useHermesControl } from "@/features/hermes/HermesControlContext";

export type TeamProposal = {
  id: string;
  kind: "hire" | "dismiss";
  status: "pending" | "executing" | "done" | "rejected" | "failed";
  reason: string;
  createdAt: string;
  decidedAt: string | null;
  note: string | null;
  error: string | null;
  name: string | null;
  role: string | null;
  instructions: string | null;
  agentId: string | null;
};

const isProposal = (value: unknown): value is TeamProposal =>
  Boolean(value) && typeof value === "object" && typeof (value as TeamProposal).id === "string";

/** Newest state of each proposal wins; decided ones leave the tray. */
export const mergeProposal = (list: TeamProposal[], next: TeamProposal): TeamProposal[] => {
  const rest = list.filter((p) => p.id !== next.id);
  return next.status === "pending" || next.status === "executing" ? [...rest, next] : rest;
};

/**
 * The main agent's proposals to hire or dismiss, waiting for the person. The
 * main agent never changes the team on its own: each proposal names a reason
 * and stays here until approved or rejected.
 */
export function TeamProposalsTray({ onTeamChanged }: { onTeamChanged?: () => void }) {
  const control = useHermesControl();
  const [pending, setPending] = useState<TeamProposal[]>([]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!control) return;
    try {
      const result = await control.call<{ proposals: TeamProposal[] }>("org.proposals.list");
      setPending(result.proposals.filter((p) => p.status === "pending" || p.status === "executing"));
    } catch {
      // Older adapters have no proposals; the tray just stays empty.
    }
  }, [control]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!control) return;
    return control.onEvent((frame) => {
      if (frame.event !== "org.proposal") return;
      const proposal = (frame.payload as { proposal?: unknown } | undefined)?.proposal;
      if (!isProposal(proposal)) return;
      setPending((list) => mergeProposal(list, proposal));
      if (proposal.status === "done") onTeamChanged?.();
    });
  }, [control, onTeamChanged]);

  if (!control || (pending.length === 0 && !message)) return null;

  const decide = async (proposal: TeamProposal, approve: boolean) => {
    setBusyId(proposal.id);
    setMessage(null);
    try {
      const result = await control.call<{ proposal: TeamProposal }>("org.proposals.decide", {
        id: proposal.id,
        approve,
        note: notes[proposal.id]?.trim() || undefined,
      });
      setPending((list) => mergeProposal(list, result.proposal));
      const outcome = result.proposal;
      if (outcome.status === "failed") setMessage(t("proposals.failed", { error: outcome.error ?? "" }));
      else if (outcome.status === "done") {
        setMessage(outcome.kind === "hire" ? t("proposals.hired", { name: outcome.name ?? "" }) : t("proposals.dismissed", { name: outcome.name ?? "" }));
        onTeamChanged?.();
      } else setMessage(t("proposals.rejectedDone"));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      void load();
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div
      className="pointer-events-none fixed left-3 top-16 z-40 flex w-[380px] max-w-[calc(100vw-1.5rem)] flex-col gap-2"
      data-testid="team-proposals"
    >
      {pending.map((proposal) => {
        const busy = busyId === proposal.id || proposal.status === "executing";
        return (
          <section
            key={proposal.id}
            className="pointer-events-auto rounded-lg border border-red-600/35 border-l-2 border-l-red-500 bg-black/85 px-4 py-3 shadow-[0_0_24px_rgba(255,26,26,0.15)] backdrop-blur"
            aria-label={t("proposals.title")}
          >
            <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-red-400">
              {proposal.kind === "hire" ? t("proposals.hireTitle") : t("proposals.dismissTitle")}
            </div>
            <div className="mt-1 text-sm font-semibold text-white">
              {proposal.name}
              {proposal.role ? <span className="font-normal text-white/60"> · {proposal.role}</span> : null}
            </div>
            <div className="mt-2 whitespace-pre-wrap text-[12px] leading-snug text-white/85">
              <span className="text-white/45">{t("proposals.reason")}: </span>
              {proposal.reason}
            </div>
            {proposal.instructions ? (
              <details className="mt-2 text-[11px] text-white/70">
                <summary className="cursor-pointer text-white/55 transition-colors hover:text-red-300">{t("proposals.instructions")}</summary>
                <div className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap">{proposal.instructions}</div>
              </details>
            ) : null}
            <input
              type="text"
              className="mt-2 w-full rounded-md border border-red-900/50 bg-black/60 px-2 py-1 text-[12px] text-white outline-none transition placeholder:text-white/35 focus:border-red-500/70 focus:ring-1 focus:ring-red-500/30"
              placeholder={t("proposals.notePlaceholder")}
              aria-label={t("proposals.notePlaceholder")}
              maxLength={1000}
              value={notes[proposal.id] ?? ""}
              disabled={busy}
              onChange={(event) => setNotes((current) => ({ ...current, [proposal.id]: event.target.value }))}
            />
            <div className="mt-2 flex items-center justify-end gap-2">
              {busy ? (
                <span className="mr-auto inline-flex items-center gap-1.5 text-[11px] text-red-300">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-red-500" aria-hidden="true" />
                  {t("proposals.working")}
                </span>
              ) : null}
              <button
                type="button"
                className="ui-btn-secondary px-3 py-1.5 text-xs font-semibold"
                disabled={busy}
                onClick={() => void decide(proposal, false)}
              >
                {t("proposals.reject")}
              </button>
              <button
                type="button"
                className="ui-btn-primary px-3 py-1.5 text-xs font-semibold"
                disabled={busy}
                onClick={() => void decide(proposal, true)}
              >
                {t("proposals.approve")}
              </button>
            </div>
          </section>
        );
      })}
      {message ? (
        <div className="pointer-events-auto flex items-start justify-between gap-2 rounded-lg border border-red-900/40 bg-black/85 px-3 py-2 text-[12px] text-white/85 shadow-2xl backdrop-blur">
          <span>{message}</span>
          <button
            type="button"
            className="rounded p-0.5 text-white/50 transition-colors hover:bg-red-950/40 hover:text-white"
            aria-label={t("proposals.dismissMessage")}
            onClick={() => setMessage(null)}
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </div>
  );
}
