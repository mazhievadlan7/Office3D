"use client";

import { t } from "@/lib/i18n";
import { HermesAgentModelSection } from "@/features/hermes/components/HermesAgentModelSection";
import { HermesEndpointsSection } from "@/features/hermes/components/HermesEndpointsSection";
import { HermesToolsetsSection } from "@/features/hermes/components/HermesToolsetsSection";
import { HermesSkillsSection } from "@/features/hermes/components/HermesSkillsSection";
import { HermesMcpSection } from "@/features/hermes/components/HermesMcpSection";
import { HermesMemorySection } from "@/features/hermes/components/HermesMemorySection";

/** Everything an agent can do in Hermes and what it remembers, in one place. */
export function HermesAgentCapabilitiesPanel({ agentId }: { agentId: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="hermes-agent-capabilities">
      <div className="border-b border-border/40 px-6 py-4">
        <div className="font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          {t("hermesCapabilities.title")}
        </div>
        <div className="mt-1 text-sm text-muted-foreground">{t("hermesCapabilities.lead")}</div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
        <div className="mx-auto w-full max-w-[760px]">
          <div className="mt-4">
            <HermesAgentModelSection agentId={agentId} />
          </div>
          <HermesEndpointsSection agentId={agentId} />
          <HermesToolsetsSection agentId={agentId} />
          <HermesSkillsSection agentId={agentId} />
          <HermesMcpSection agentId={agentId} />
          <HermesMemorySection agentId={agentId} />
        </div>
      </div>
    </div>
  );
}
