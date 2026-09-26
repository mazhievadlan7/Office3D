import { Building2, Sparkles, Users, Wand2 } from "lucide-react";
import { t } from "@/lib/i18n";
import {
  HQ_BUTTON_PRIMARY,
  HQ_INSET,
} from "@/features/agents/components/hqFormClasses";

export type CompanyStepProps = {
  connected: boolean;
  agentCount: number;
  onOpenCompanyBuilder: () => void;
};

export const CompanyStep = ({
  connected,
  agentCount,
  onOpenCompanyBuilder,
}: CompanyStepProps) => {
  const canOpenBuilder = connected && agentCount > 0;

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-primary/35 bg-primary/10 px-4 py-4 shadow-[0_0_18px_rgba(255,26,26,0.12)]">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-primary/40 bg-primary/15">
            <Building2 className="h-5 w-5 text-primary" />
          </div>
          <div className="space-y-2">
            <p className="text-sm font-semibold text-white">{t("onboarding.companyTitle")}</p>
            <p className="text-xs leading-5 text-white/65">
              {t("onboarding.companyLead")}
            </p>
          </div>
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-3">
        {[
          {
            icon: Sparkles,
            title: t("onboarding.improveBrief"),
            description: t("onboarding.improveBriefLead"),
          },
          {
            icon: Users,
            title: t("onboarding.generateTeam"),
            description: t("onboarding.generateTeamLead"),
          },
          {
            icon: Wand2,
            title: t("onboarding.createAll"),
            description: t("onboarding.createAllLead"),
          },
        ].map(({ icon: Icon, title, description }) => (
          <div
            key={title}
            className={`${HQ_INSET} px-3 py-3`}
          >
            <Icon className="h-4 w-4 text-primary" />
            <p className="mt-2 text-[11px] font-semibold text-white">{title}</p>
            <p className="mt-1 text-[10px] leading-4 text-white/55">{description}</p>
          </div>
        ))}
      </div>

      <div className="pt-4">
        {canOpenBuilder ? (
          <div className="flex justify-center">
            <button
              type="button"
              className={`${HQ_BUTTON_PRIMARY} px-4 py-2 text-[10px]`}
              onClick={onOpenCompanyBuilder}
            >
              <Sparkles className="h-3.5 w-3.5" />
              {t("onboarding.openCompanyBuilder")}
            </button>
          </div>
        ) : (
          <div className="rounded-md border border-primary/35 bg-primary/10 px-4 py-3 text-xs text-white/75">
            {t("onboarding.companyRequirement")}
          </div>
        )}
      </div>
    </div>
  );
};
