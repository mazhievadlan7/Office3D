"use client";

/**
 * CompleteStep — Final wizard screen before entering the office.
 */
import { Building2, Rocket } from "lucide-react";
import { t } from "@/lib/i18n";
import { HQ_INSET } from "@/features/agents/components/hqFormClasses";

export const CompleteStep = () => (
  <div className="relative flex flex-col items-center justify-center gap-5 py-4">
    <div className="flex h-14 w-14 items-center justify-center rounded-full border border-primary/40 bg-primary/15 shadow-[0_0_28px_rgba(255,26,26,0.35)]">
      <Rocket className="h-7 w-7 text-primary" />
    </div>

    <div className="space-y-2 text-center">
      <p className="text-base font-semibold text-white">{t("onboarding.welcomeOffice")}</p>
      <p className="max-w-sm text-sm text-white/65">{t("onboarding.gatewayReady")}</p>
    </div>

    <div className="w-full max-w-xs space-y-2">
      <div className={`${HQ_INSET} flex items-center gap-2.5 px-3.5 py-2.5`}>
        <Building2 className="h-4 w-4 shrink-0 text-primary" />
        <div>
          <p className="text-xs font-medium text-white">{t("onboarding.exploreOffice")}</p>
          <p className="text-[10px] text-white/55">{t("onboarding.exploreOfficeLead")}</p>
        </div>
      </div>
    </div>

    <p className="text-[11px] text-white/45">{t("onboarding.rerunHint")}</p>
  </div>
);
