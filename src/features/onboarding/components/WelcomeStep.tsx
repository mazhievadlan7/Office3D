/**
 * WelcomeStep — First onboarding screen introducing Office3D.
 */
import { Building2, Eye, MessageSquare, Users } from "lucide-react";
import { t } from "@/lib/i18n";

const features = [
  {
    icon: Eye,
    title: t("onboarding.welcomeWatch"),
    description: t("onboarding.welcomeWatchLead"),
  },
  {
    icon: Users,
    title: t("onboarding.welcomeFleet"),
    description: t("onboarding.welcomeFleetLead"),
  },
  {
    icon: MessageSquare,
    title: t("onboarding.welcomeChat"),
    description: t("onboarding.welcomeChatLead"),
  },
  {
    icon: Building2,
    title: t("onboarding.welcomeBuild"),
    description: t("onboarding.welcomeBuildLead"),
  },
] as const;

export const WelcomeStep = () => (
  <div className="space-y-5">
    <div className="space-y-2">
      <p className="text-sm leading-relaxed text-white/80">
        {t("onboarding.welcomeLead1")}{" "}
        <span className="font-medium text-white">{t("onboarding.welcomeLead2")}</span> {t("onboarding.welcomeLead3")}
      </p>
      <p className="text-sm text-white/60">
        {t("onboarding.welcomeLead4")}
      </p>
    </div>

    <div className="grid grid-cols-2 gap-3">
      {features.map(({ icon: Icon, title, description }) => (
        <div
          key={title}
          className="rounded-lg border border-white/8 bg-white/[0.03] px-3.5 py-3"
        >
          <div className="flex items-center gap-2">
            <Icon className="h-4 w-4 shrink-0 text-amber-300" />
            <span className="text-xs font-semibold text-white">{title}</span>
          </div>
          <p className="mt-1.5 text-[11px] leading-snug text-white/55">
            {description}
          </p>
        </div>
      ))}
    </div>
  </div>
);
