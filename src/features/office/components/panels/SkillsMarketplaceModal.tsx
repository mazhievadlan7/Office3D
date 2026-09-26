"use client";

import { useEffect } from "react";

import { X } from "lucide-react";

import type { OfficeSkillsMarketplaceController } from "@/features/office/hooks/useOfficeSkillsMarketplace";

import { SkillsMarketplacePanel } from "./SkillsMarketplacePanel";
import { t } from "@/lib/i18n";

type SkillsMarketplaceModalProps = {
  open: boolean;
  marketplace: OfficeSkillsMarketplaceController;
  onClose: () => void;
  onSelectAgent: (agentId: string) => void;
  onOpenAgentSettings: (agentId: string) => void;
};

export function SkillsMarketplaceModal({
  open,
  marketplace,
  onClose,
  onSelectAgent,
  onOpenAgentSettings,
}: SkillsMarketplaceModalProps) {
  useEffect(() => {
    if (!open) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose, open]);

  if (!open) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-[125] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={t("market.title")}
      onClick={onClose}
    >
      <div
        className="flex h-[min(90vh,960px)] w-full max-w-6xl flex-col overflow-hidden rounded-xl border border-red-600/35 bg-[#070404]/95 text-white shadow-[0_0_48px_rgba(255,26,26,0.12)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-red-900/40 bg-gradient-to-r from-red-950/30 via-transparent to-transparent px-5 py-4">
          <div>
            <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.22em] text-red-400">
              <span
                className="h-1.5 w-1.5 rounded-full bg-red-500 shadow-[0_0_8px_rgba(255,26,26,0.9)]"
                aria-hidden="true"
              />
              {t("market.title")}
            </div>
            <div className="mt-1 font-mono text-[11px] text-white/55">
              {t("market.lead")}
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

        <div className="min-h-0 flex-1">
          <SkillsMarketplacePanel
            marketplace={marketplace}
            onSelectAgent={onSelectAgent}
            onOpenAgentSettings={onOpenAgentSettings}
          />
        </div>
      </div>
    </div>
  );
}
