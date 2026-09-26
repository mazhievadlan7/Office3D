"use client";

import { useState } from "react";
import {
  Brain,
  Boxes,
  ChevronLeft,
  ChevronRight,
  Database,
  FileText,
  HeartPulse,
  Palette,
  Shield,
  Trash2,
  UserRound,
  Wrench,
  X,
} from "lucide-react";
import type { AgentState } from "@/features/agents/state/store";
import { AgentAvatarEditorPanel } from "@/features/agents/components/AgentAvatarEditorPanel";
import { AgentBrainPanel } from "@/features/agents/components/inspect/AgentBrainPanel";
import type { AgentAvatarProfile } from "@/lib/avatars/profile";
import type { GatewayClient } from "@/lib/gateway/GatewayClient";
import type { AgentFileName } from "@/lib/agents/agentFiles";
import { AGENT_FILE_META } from "@/lib/agents/agentFiles";
import { renameGatewayAgent } from "@/lib/gateway/agentConfig";
import { t } from "@/lib/i18n";
import { useHermesControl } from "@/features/hermes/HermesControlContext";
import { HermesAgentCapabilitiesPanel } from "@/features/hermes/components/HermesAgentCapabilitiesPanel";
import {
  HQ_FORM_BUTTON_SMALL,
  HQ_FORM_LABEL,
  HQ_FORM_LEAD,
  HQ_FORM_SECTION_TITLE,
} from "@/features/agents/components/hqFormStyles";

export type AgentEditorSection = "avatar" | "hermes" | AgentFileName;

type AgentEditorModalProps = {
  open: boolean;
  client: GatewayClient | null;
  agents: AgentState[];
  agent: AgentState;
  initialSection?: AgentEditorSection;
  onClose: () => void;
  onAvatarSave: (agentId: string, profile: AgentAvatarProfile) => Promise<void> | void;
  onRename?: (agentId: string, name: string) => Promise<boolean>;
  onDelete?: (agentId: string) => Promise<void> | void;
  onNavigateAgent?: (agentId: string, section: AgentEditorSection) => void;
};

// The left tick (::before) lights red on the open section.
const menuButtonClassName =
  "relative flex w-full items-center gap-3 rounded-md border px-3 py-2.5 text-left transition-colors before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full before:content-[''] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/50";

const editorSections: Array<{
  id: AgentEditorSection;
  label: string;
  hint: string;
  icon: typeof Palette;
}> = [
  {
    id: "IDENTITY.md",
    label: t("wizard.stepIdentity"),
    hint: AGENT_FILE_META["IDENTITY.md"].hint,
    icon: FileText,
  },
  {
    id: "avatar",
    label: t("wizard.stepAvatar"),
    hint: t("editor.avatarHint"),
    icon: Palette,
  },
  {
    id: "SOUL.md",
    label: t("wizard.stepSoul"),
    hint: AGENT_FILE_META["SOUL.md"].hint,
    icon: Brain,
  },
  {
    id: "AGENTS.md",
    label: t("wizard.stepAgents"),
    hint: AGENT_FILE_META["AGENTS.md"].hint,
    icon: Shield,
  },
  {
    id: "USER.md",
    label: t("wizard.stepUser"),
    hint: AGENT_FILE_META["USER.md"].hint,
    icon: UserRound,
  },
  {
    id: "TOOLS.md",
    label: t("wizard.stepTools"),
    hint: AGENT_FILE_META["TOOLS.md"].hint,
    icon: Wrench,
  },
  {
    id: "MEMORY.md",
    label: t("wizard.stepMemory"),
    hint: AGENT_FILE_META["MEMORY.md"].hint,
    icon: Database,
  },
  {
    id: "HEARTBEAT.md",
    label: t("wizard.stepHeartbeat"),
    hint: AGENT_FILE_META["HEARTBEAT.md"].hint,
    icon: HeartPulse,
  },
];

export const AgentEditorModal = ({
  open,
  client,
  agents,
  agent,
  initialSection = "avatar",
  onClose,
  onAvatarSave,
  onRename,
  onDelete,
  onNavigateAgent,
}: AgentEditorModalProps) => {
  const hermes = useHermesControl();
  const [activeSection, setActiveSection] = useState<AgentEditorSection>(initialSection);
  // Hermes' own settings for the agent exist only while connected to Hermes.
  const sections = hermes
    ? [
        editorSections[0],
        { id: "hermes" as const, label: t("hermesCapabilities.title"), hint: t("hermesCapabilities.hint"), icon: Boxes },
        ...editorSections.slice(1),
      ]
    : editorSections;
  const shownSection = activeSection === "hermes" && !hermes ? "avatar" : activeSection;
  const activeAgentIndex = agents.findIndex((entry) => entry.agentId === agent.agentId);
  const previousAgent =
    activeAgentIndex > 0 ? agents[activeAgentIndex - 1] : null;
  const nextAgent =
    activeAgentIndex >= 0 && activeAgentIndex < agents.length - 1
      ? agents[activeAgentIndex + 1]
      : null;

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[145] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={t("editor.editLabel", { name: agent.name })}
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-7xl"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute -right-3 -top-3 z-20 inline-flex h-10 w-10 items-center justify-center rounded-full border border-red-600/40 bg-[#070404] text-white/70 shadow-[0_0_18px_rgba(255,26,26,0.18)] transition-colors hover:border-red-500/70 hover:bg-red-950/60 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/50"
          aria-label={t("editor.close")}
        >
          <X className="h-4 w-4" />
        </button>
        <div className="relative flex h-[min(90vh,920px)] w-full overflow-hidden rounded-lg border border-red-900/50 bg-[#070404] text-white shadow-[0_0_48px_rgba(255,26,26,0.08)]">
          {/* A red hairline along the top edge, like the HQ's panels. */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 top-0 z-10 h-px bg-gradient-to-r from-transparent via-red-500/70 to-transparent"
          />
          <aside className="flex w-[248px] shrink-0 flex-col border-r border-red-900/40 bg-[#050303]">
            <div className="border-b border-red-900/40 px-5 py-4">
              <div className={HQ_FORM_LABEL}>{t("editor.title")}</div>
              <div className="mt-1 truncate text-lg font-semibold text-white">
                {agent.name}
              </div>
              <div className="mt-1 text-[11px] leading-4 text-white/50">{t("editor.lead")}</div>
              {onNavigateAgent ? (
                <div className="mt-4 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      if (!previousAgent) return;
                      onNavigateAgent(previousAgent.agentId, activeSection);
                    }}
                    disabled={!previousAgent}
                    className={HQ_FORM_BUTTON_SMALL}
                  >
                    <ChevronLeft className="h-3.5 w-3.5" />
                    <span>{t("editor.previous")}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (!nextAgent) return;
                      onNavigateAgent(nextAgent.agentId, activeSection);
                    }}
                    disabled={!nextAgent}
                    className={HQ_FORM_BUTTON_SMALL}
                  >
                    <span>{t("wizard.next")}</span>
                    <ChevronRight className="h-3.5 w-3.5" />
                  </button>
                </div>
              ) : null}
            </div>

            <div className="flex-1 space-y-1.5 overflow-y-auto p-3">
              {sections.map((section) => {
                const Icon = section.icon;
                const active = shownSection === section.id;
                return (
                  <button
                    key={section.id}
                    type="button"
                    aria-current={active ? "true" : undefined}
                    onClick={() => setActiveSection(section.id)}
                    className={`${menuButtonClassName} ${
                      active
                        ? "border-red-500/60 bg-red-600/20 text-white shadow-[0_0_14px_rgba(255,26,26,0.15)] before:bg-[#e3141c] before:shadow-[0_0_8px_rgba(255,26,26,0.7)]"
                        : "border-transparent text-white/65 before:bg-transparent hover:border-red-500/40 hover:bg-red-950/30 hover:text-white"
                    }`}
                  >
                    <Icon className={`h-4 w-4 shrink-0 ${active ? "text-red-400" : "text-white/40"}`} />
                    <div className="min-w-0">
                      <div className="text-[13px] font-medium">{section.label}</div>
                      <div className={`text-[11px] leading-4 ${active ? "text-white/65" : "text-white/45"}`}>{section.hint}</div>
                    </div>
                  </button>
                );
              })}
            </div>
            {onDelete ? (
              <div className="border-t border-red-900/40 p-3">
                <button
                  type="button"
                  onClick={() => {
                    void onDelete(agent.agentId);
                  }}
                  className="flex w-full items-center gap-3 rounded-md border border-red-500/45 bg-red-950/40 px-3 py-3 text-left text-red-300 transition-colors hover:border-red-500/70 hover:bg-red-900/50 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/50"
                >
                  <Trash2 className="h-4 w-4 shrink-0" />
                  <div>
                    <div className="text-[13px] font-semibold text-inherit">{t("editor.deleteAgent")}</div>
                    <div className="text-[11px] leading-4 text-red-200/70">{t("editor.deleteHint")}</div>
                  </div>
                </button>
              </div>
            ) : null}
          </aside>

          <section className="flex min-w-0 flex-1 flex-col bg-[#070404]">
            {shownSection === "hermes" ? (
              <HermesAgentCapabilitiesPanel agentId={agent.agentId} />
            ) : shownSection === "avatar" ? (
              <AgentAvatarEditorPanel
                agentId={agent.agentId}
                agentName={agent.name}
                initialProfile={agent.avatarProfile}
                onCancel={onClose}
                onSave={(profile) => onAvatarSave(agent.agentId, profile)}
              />
            ) : client ? (
              <div className="flex min-h-0 flex-1 flex-col">
                <div className="border-b border-red-900/40 px-6 py-4">
                  <div className={HQ_FORM_SECTION_TITLE}>{t("editor.fileEditor")}</div>
                  <div className={`mt-1 ${HQ_FORM_LEAD}`}>{t("editor.fileEditorLead")}</div>
                </div>
                <div className="min-h-0 flex-1">
                  <AgentBrainPanel
                    client={client}
                    agents={agents}
                    selectedAgentId={agent.agentId}
                    activeSection={shownSection}
                    onCancel={onClose}
                    onRename={
                      onRename ??
                      (async (agentId, name) => {
                        if (!client) return false;
                        try {
                          await renameGatewayAgent({ client, agentId, name });
                          return true;
                        } catch {
                          return false;
                        }
                      })
                    }
                  />
                </div>
              </div>
            ) : (
              <div className="flex h-full items-center justify-center p-8 font-mono text-[11px] uppercase tracking-[0.14em] text-white/55">{t("editor.connectFirst")}</div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
};
