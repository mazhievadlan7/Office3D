/**
 * PrerequisitesStep — Tells users what they need before connecting.
 */
import { CheckCircle2, ExternalLink } from "lucide-react";
import { t } from "@/lib/i18n";
import {
  HQ_INSET,
  HQ_TEXT_ON,
} from "@/features/agents/components/hqFormClasses";

const prerequisites = [
  {
    label: t("onboarding.preInstalled"),
    detail: t("onboarding.preInstalledLead"),
    link: "https://docs.openclaw.ai",
    linkLabel: t("onboarding.preInstallDocs"),
  },
  {
    label: t("onboarding.preGateway"),
    detail: t("onboarding.preGatewayLead"),
    command: "openclaw gateway start",
  },
  {
    label: t("onboarding.preCredentials"),
    detail: t("onboarding.preCredentialsLead"),
  },
  {
    label: "Node.js 22.22+",
    detail: t("onboarding.preNodeLead"),
    link: "https://nodejs.org",
    linkLabel: t("onboarding.preNodeDownload"),
  },
] as const;

export const PrerequisitesStep = () => (
  <div className="space-y-2.5">
    <p className="text-[13px] leading-5 text-white/75">
      {t("onboarding.preLead")}
    </p>

    <div className="space-y-1.5">
      {prerequisites.map(({ label, detail, ...rest }) => (
        <div
          key={label}
          className={`${HQ_INSET} flex gap-2.5 px-3 py-2`}
        >
          <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary/80" />
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold text-white">{label}</p>
            <p className="mt-0.5 text-[10px] leading-4 text-white/55">{detail}</p>
            {"command" in rest ? (
              <code className="mt-1 block rounded border border-primary/25 bg-black/60 px-2 py-0.5 font-mono text-[10px] text-white">
                {rest.command}
              </code>
            ) : null}
            {"link" in rest && rest.link ? (
              <a
                href={rest.link}
                target="_blank"
                rel="noopener noreferrer"
                className={`mt-1 inline-flex items-center gap-1 text-[10px] leading-4 ${HQ_TEXT_ON} transition-colors hover:text-white`}
              >
                {rest.linkLabel ?? t("onboarding.learnMore")}
                <ExternalLink className="h-3 w-3" />
              </a>
            ) : null}
          </div>
        </div>
      ))}
    </div>

    <p className="text-[10px] leading-4 text-white/45">
      {t("onboarding.needHelp")}{" "}
      <a
        href="https://docs.openclaw.ai"
        target="_blank"
        rel="noopener noreferrer"
        className={`${HQ_TEXT_ON} transition-colors hover:text-white`}
      >
        docs.openclaw.ai
      </a>{" "}
      {t("onboarding.or")}{" "}
      <a
        href="https://discord.com/invite/clawd"
        target="_blank"
        rel="noopener noreferrer"
        className={`${HQ_TEXT_ON} transition-colors hover:text-white`}
      >
        {t("onboarding.joinDiscord")}
      </a>
      .
    </p>
  </div>
);
