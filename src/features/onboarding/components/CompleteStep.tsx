"use client";

/**
 * CompleteStep — Final wizard screen before entering the office.
 */
import { useEffect, useRef } from "react";
import confetti from "canvas-confetti";
import { Building2, Rocket } from "lucide-react";
import { t } from "@/lib/i18n";
import { HQ_INSET } from "@/features/agents/components/hqFormClasses";

export const CompleteStep = ({
  companyCreated = false,
  companyName = null,
}: {
  companyCreated?: boolean;
  companyName?: string | null;
}) => {
  const hasFiredConfettiRef = useRef(false);

  useEffect(() => {
    if (!companyCreated || hasFiredConfettiRef.current) return;
    hasFiredConfettiRef.current = true;
    const defaults = {
      spread: 68,
      startVelocity: 32,
      ticks: 220,
      gravity: 1.05,
      zIndex: 100130,
      // The HQ palette: reds and white.
      colors: ["#e3141c", "#ff2a2a", "#ff6b6b", "#ffffff", "#7a151a"],
    };
    void confetti({
      ...defaults,
      particleCount: 90,
      origin: { x: 0.5, y: 0.35 },
    });
    window.setTimeout(() => {
      void confetti({
        ...defaults,
        particleCount: 70,
        angle: 60,
        origin: { x: 0.15, y: 0.45 },
      });
      void confetti({
        ...defaults,
        particleCount: 70,
        angle: 120,
        origin: { x: 0.85, y: 0.45 },
      });
    }, 180);
  }, [companyCreated]);

  return (
    <div className="relative flex flex-col items-center justify-center gap-5 py-4">
      <div className="flex h-14 w-14 items-center justify-center rounded-full border border-primary/40 bg-primary/15 shadow-[0_0_28px_rgba(255,26,26,0.35)]">
        <Rocket className="h-7 w-7 text-primary" />
      </div>

      <div className="space-y-2 text-center">
        <p className="text-base font-semibold text-white">
          {companyCreated
            ? t("onboarding.companyCreated", { name: companyName?.trim() || t("onboarding.yourCompany") })
            : t("onboarding.welcomeOffice")}
        </p>
        <p className="max-w-sm text-sm text-white/65">
          {companyCreated
            ? t("onboarding.companyReady", { name: companyName?.trim() || t("onboarding.yourCompany") })
            : t("onboarding.gatewayReady")}
        </p>
      </div>

      <div className="w-full max-w-xs space-y-2">
        <div className={`${HQ_INSET} flex items-center gap-2.5 px-3.5 py-2.5`}>
          <Building2 className="h-4 w-4 shrink-0 text-primary" />
          <div>
            <p className="text-xs font-medium text-white">
              {companyCreated ? t("onboarding.meetTeam") : t("onboarding.exploreOffice")}
            </p>
            <p className="text-[10px] text-white/55">
              {companyCreated
                ? t("onboarding.meetTeamLead")
                : t("onboarding.exploreOfficeLead")}
            </p>
          </div>
        </div>
      </div>

      <p className="text-[11px] text-white/45">
        {t("onboarding.rerunHint")}
      </p>
    </div>
  );
};
