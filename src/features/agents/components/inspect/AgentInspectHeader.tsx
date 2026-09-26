"use client";

import { X } from "lucide-react";
import { t } from "@/lib/i18n";

export type AgentInspectHeaderProps = {
  label?: string;
  title?: string;
  onClose: () => void;
  closeTestId: string;
  closeDisabled?: boolean;
};

export const AgentInspectHeader = ({
  label,
  title,
  onClose,
  closeTestId,
  closeDisabled,
}: AgentInspectHeaderProps) => {
  const normalizedLabel = label?.trim() ?? "";
  const normalizedTitle = title?.trim() ?? "";
  const hasLabel = normalizedLabel.length > 0;
  const hasTitle = normalizedTitle.length > 0;

  if (!hasLabel && !hasTitle) {
    return null;
  }

  return (
    <div className="flex items-center justify-between pl-4 pr-2 pb-3 pt-2">
      <div>
        {hasLabel ? (
          <div className="font-mono text-[9px] font-semibold uppercase tracking-[0.16em] text-white/50">
            {normalizedLabel}
          </div>
        ) : null}
        {hasTitle ? (
          <div
            className={
              hasLabel
                ? "text-[1.45rem] font-semibold leading-[1.05] tracking-[0.01em] text-white"
                : "font-mono text-[12px] font-semibold uppercase tracking-[0.14em] text-white"
            }
          >
            {normalizedTitle}
          </div>
        ) : null}
      </div>
      <button
        className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-transparent text-white/55 transition-colors hover:border-red-500/50 hover:bg-red-950/40 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/50 disabled:cursor-not-allowed disabled:opacity-40"
        type="button"
        data-testid={closeTestId}
        aria-label={t("inspect.closePanel")}
        disabled={closeDisabled}
        onClick={onClose}
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
};
