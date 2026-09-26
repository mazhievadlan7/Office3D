/**
 * AgentsStep — Shows discovered agents after gateway connection.
 */
import { Bot, Users, WifiOff } from "lucide-react";
import { t } from "@/lib/i18n";
import { HQ_INSET } from "@/features/agents/components/hqFormClasses";

export type AgentsStepProps = {
  agentCount: number;
  connected: boolean;
};

export const AgentsStep = ({ agentCount, connected }: AgentsStepProps) => {
  if (!connected) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-8">
        <WifiOff className="h-8 w-8 text-primary/70" />
        <p className="text-sm text-white/65">
          {t("onboarding.connectFirstToDiscover")}
        </p>
      </div>
    );
  }

  if (agentCount === 0) {
    return (
      <div className="space-y-4">
        <div className="flex flex-col items-center justify-center gap-3 py-6">
          <div className="flex h-12 w-12 items-center justify-center rounded-full border border-border bg-black/40">
            <Bot className="h-6 w-6 text-white/55" />
          </div>
          <p className="text-sm font-medium text-white">{t("onboarding.noAgents")}</p>
          <p className="max-w-xs text-center text-xs text-white/60">
            {t("onboarding.noAgentsLead")}
          </p>
        </div>

        <div className={`${HQ_INSET} px-4 py-3`}>
          <p className="text-xs font-semibold text-white">{t("onboarding.quickStart")}</p>
          <ol className="mt-2 space-y-1.5 text-[11px] text-white/60">
            <li>{t("onboarding.quickStep1")}</li>
            <li>{t("onboarding.quickStep2")}</li>
            <li>{t("onboarding.quickStep3")}</li>
            <li>{t("onboarding.quickStep4")}</li>
          </ol>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 rounded-lg border border-primary/35 bg-primary/10 px-4 py-3 shadow-[0_0_18px_rgba(255,26,26,0.12)]">
        <Users className="h-5 w-5 text-primary" />
        <div>
          <p className="text-sm font-semibold text-white">
            {t("onboarding.agentsFound", { count: agentCount })}
          </p>
          <p className="text-[11px] text-white/65">
            {t("onboarding.teamReady")}
          </p>
        </div>
      </div>

      <div className="space-y-2">
        <p className="text-xs font-semibold text-white/80">
          {t("onboarding.whatAgentsDo")}
        </p>
        <div className="grid grid-cols-2 gap-2">
          {[
            { label: t("onboarding.featureChat"), desc: t("onboarding.featureChatLead") },
            { label: t("onboarding.featureApprove"), desc: t("onboarding.featureApproveLead") },
            { label: t("onboarding.featureConfigure"), desc: t("onboarding.featureConfigureLead") },
            { label: t("onboarding.featureMonitor"), desc: t("onboarding.featureMonitorLead") },
          ].map(({ label, desc }) => (
            <div
              key={label}
              className={`${HQ_INSET} px-3 py-2`}
            >
              <p className="text-[11px] font-semibold text-white">{label}</p>
              <p className="text-[10px] text-white/55">{desc}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
