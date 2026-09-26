"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import type { AgentState } from "@/features/agents/state/store";
import type { GatewayClient } from "@/lib/gateway/GatewayClient";
import { AgentIdentityFields } from "@/features/agents/components/AgentIdentityFields";
import {
  AGENT_FILE_META,
  PERSONALITY_FILE_NAMES,
  type AgentFileName,
} from "@/lib/agents/agentFiles";
import {
  createEmptyPersonalityDraft,
  parsePersonalityFiles,
  serializePersonalityFiles,
} from "@/lib/agents/personalityBuilder";
import { useAgentFilesEditor } from "@/features/agents/hooks/useAgentFilesEditor";
import {
  HQ_FORM_BUTTON_PRIMARY,
  HQ_FORM_BUTTON_SECONDARY,
  HQ_FORM_HINT,
  HQ_FORM_INSET,
  HQ_FORM_LEAD,
  HQ_FORM_NOTICE_ERROR,
  HQ_FORM_SECTION_TITLE,
  HQ_FORM_TEXTAREA,
} from "@/features/agents/components/hqFormStyles";
import { t } from "@/lib/i18n";

// AgentIdentityFields is shared with the create wizard and styled with theme
// tokens; inside the editor its fields take the HQ form look from here.
const IDENTITY_FIELDS_CLASS =
  "[&_label]:font-mono [&_label]:text-[10px] [&_label]:font-semibold [&_label]:uppercase [&_label]:tracking-[0.16em] [&_label]:text-white/60 [&_input]:border-red-900/50 [&_input]:bg-black/60 [&_input]:font-sans [&_input]:text-[13px] [&_input]:normal-case [&_input]:tracking-normal [&_input]:text-white [&_input]:caret-red-500 [&_input]:transition-colors [&_input]:placeholder:text-white/35 [&_input:hover]:border-red-600/45 [&_input:focus]:border-red-500/70 [&_input:focus]:ring-2 [&_input:focus]:ring-red-500/30 [&_input:disabled]:opacity-50";

export type AgentBrainPanelProps = {
  client: GatewayClient;
  agents: AgentState[];
  selectedAgentId: string | null;
  activeSection?: AgentFileName;
  onCancel?: () => void;
  onUnsavedChangesChange?: (dirty: boolean) => void;
  onRename?: (agentId: string, name: string) => Promise<boolean>;
};

const AgentBrainPanelSection = ({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) => (
  <section className="space-y-3 border-t border-red-900/30 pt-8 first:border-t-0 first:pt-0">
    <h3 className={HQ_FORM_SECTION_TITLE}>{title}</h3>
    {children}
  </section>
);

const AgentFileProvenance = ({
  path,
  workspace,
}: {
  path: string | null;
  workspace: string | null;
}) => {
  if (!path && !workspace) return null;
  return (
    <div className={`${HQ_FORM_INSET} space-y-0.5 px-3 py-2 text-[11px] text-white/45`}>
      {workspace ? (
        <div>
          {t("brain.workspace")} <span className="break-all font-mono text-white/85">{workspace}</span>
        </div>
      ) : null}
      {path ? (
        <div>
          {t("brain.file")} <span className="break-all font-mono text-white/85">{path}</span>
        </div>
      ) : null}
    </div>
  );
};

export const AgentBrainPanel = ({
  client,
  agents,
  selectedAgentId,
  activeSection,
  onCancel,
  onUnsavedChangesChange,
  onRename,
}: AgentBrainPanelProps) => {
  const selectedAgent = useMemo(
    () =>
      selectedAgentId
        ? agents.find((entry) => entry.agentId === selectedAgentId) ?? null
        : null,
    [agents, selectedAgentId]
  );

  const {
    agentFiles,
    agentFilesLoading,
    agentFilesSaving,
    agentFilesDirty,
    agentFilesError,
    setAgentFileContent,
    saveAgentFiles,
    initializeAgentFiles,
  } = useAgentFilesEditor({ client, agentId: selectedAgent?.agentId ?? null });
  const draft = useMemo(() => parsePersonalityFiles(agentFiles), [agentFiles]);
  const [saveError, setSaveError] = useState<string | null>(null);
  const missingPersonalityFiles = useMemo(
    () => PERSONALITY_FILE_NAMES.filter((name) => !agentFiles[name].exists),
    [agentFiles]
  );

  const setIdentityField = useCallback(
    (field: "name" | "creature" | "vibe" | "emoji" | "avatar", value: string) => {
      const nextDraft = parsePersonalityFiles(agentFiles);
      nextDraft.identity[field] = value;
      const serialized = serializePersonalityFiles(nextDraft);
      setAgentFileContent("IDENTITY.md", serialized["IDENTITY.md"]);
    },
    [agentFiles, setAgentFileContent]
  );

  const handleSave = useCallback(async () => {
    if (agentFilesLoading || agentFilesSaving || !agentFilesDirty) return;
    setSaveError(null);
    const saved = await saveAgentFiles();
    if (!saved || !selectedAgent || !onRename) {
      return;
    }
    const nextName = draft.identity.name.trim();
    const currentName = selectedAgent.name.trim();
    if (!nextName || nextName === currentName) {
      return;
    }
    const renamed = await onRename(selectedAgent.agentId, nextName);
    if (!renamed) {
      setSaveError(t("brain.renameFailed"));
    }
  }, [
    agentFilesDirty,
    agentFilesLoading,
    agentFilesSaving,
    draft.identity.name,
    onRename,
    saveAgentFiles,
    selectedAgent,
  ]);

  const handleInitializeMissingFiles = useCallback(async () => {
    if (!selectedAgent) return;
    setSaveError(null);
    const nextDraft = createEmptyPersonalityDraft();
    nextDraft.identity.name = selectedAgent.name.trim();
    nextDraft.identity.creature = selectedAgent.role?.trim() ?? "";
    const serialized = serializePersonalityFiles(nextDraft);
    const missingEntries = Object.fromEntries(
      missingPersonalityFiles.map((name) => [name, serialized[name]])
    ) as Partial<Record<AgentFileName, string>>;
    await initializeAgentFiles(missingEntries);
  }, [initializeAgentFiles, missingPersonalityFiles, selectedAgent]);

  useEffect(() => {
    onUnsavedChangesChange?.(agentFilesDirty);
  }, [agentFilesDirty, onUnsavedChangesChange]);

  useEffect(() => {
    return () => {
      onUnsavedChangesChange?.(false);
    };
  }, [onUnsavedChangesChange]);

  const renderMarkdownEditor = useCallback(
    (name: Exclude<AgentFileName, "IDENTITY.md">) => {
      const file = agentFiles[name];
      const trimmedContent = file.content.trim();
      const statusCopy = !file.exists
        ? t("brain.noCustomFile", { name })
        : !trimmedContent
          ? t("brain.emptyFile", { name })
          : null;
      return (
        <AgentBrainPanelSection title={AGENT_FILE_META[name].title}>
          <div className={HQ_FORM_LEAD}>{AGENT_FILE_META[name].hint}</div>
          {statusCopy ? (
            <div className={`${HQ_FORM_INSET} px-3 py-2 text-[12px] text-white/60`}>
              {statusCopy}
            </div>
          ) : null}
          <AgentFileProvenance path={file.path} workspace={file.workspace} />
          <textarea
            aria-label={AGENT_FILE_META[name].title}
            className={`h-[min(56vh,480px)] w-full resize-y ${HQ_FORM_TEXTAREA}`}
            value={file.content}
            placeholder={!file.exists ? t("brain.noFileYet", { name }) : ""}
            disabled={agentFilesLoading || agentFilesSaving}
            onChange={(event) => {
              setAgentFileContent(name, event.target.value);
            }}
          />
        </AgentBrainPanelSection>
      );
    },
    [agentFiles, agentFilesLoading, agentFilesSaving, setAgentFileContent],
  );

  const renderIdentityEditor = useCallback(
    () => (
      <section className="space-y-3 border-t border-red-900/30 pt-8 first:border-t-0 first:pt-0">
        <h3 className={HQ_FORM_SECTION_TITLE}>{AGENT_FILE_META["IDENTITY.md"].title}</h3>
        <div className={HQ_FORM_LEAD}>
          {AGENT_FILE_META["IDENTITY.md"].hint}
        </div>
        <div className={HQ_FORM_HINT}>
          {t("brain.renameHint")}
        </div>
        <AgentFileProvenance
          path={agentFiles["IDENTITY.md"].path}
          workspace={agentFiles["IDENTITY.md"].workspace}
        />
        <div className={IDENTITY_FIELDS_CLASS}>
          <AgentIdentityFields
            values={draft.identity}
            disabled={agentFilesLoading || agentFilesSaving}
            onChange={(field, value) => {
              setIdentityField(field, value);
            }}
          />
        </div>
      </section>
    ),
    [
      agentFiles,
      agentFilesLoading,
      agentFilesSaving,
      draft.identity,
      setIdentityField,
    ],
  );

  const renderedSections = useMemo(() => {
    if (activeSection === "IDENTITY.md") {
      return [renderIdentityEditor()];
    }
    if (activeSection) {
      return [renderMarkdownEditor(activeSection as Exclude<AgentFileName, "IDENTITY.md">)];
    }
    return [
      renderMarkdownEditor("SOUL.md"),
      renderMarkdownEditor("AGENTS.md"),
      renderMarkdownEditor("USER.md"),
      renderIdentityEditor(),
    ];
  }, [activeSection, renderIdentityEditor, renderMarkdownEditor]);

  return (
    <div
      className="agent-inspect-panel flex min-h-0 flex-col overflow-hidden"
      data-testid="agent-personality-panel"
      style={{ position: "relative", left: "auto", top: "auto", width: "100%", height: "100%" }}
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 py-6">
        <section
          className="mx-auto flex min-h-0 w-full max-w-[920px] flex-col"
          data-testid="agent-personality-files"
        >
          {agentFilesError ? (
            <div className={`mb-4 ${HQ_FORM_NOTICE_ERROR}`}>
              {agentFilesError}
            </div>
          ) : null}
          {saveError ? (
            <div className={`mb-4 ${HQ_FORM_NOTICE_ERROR}`}>
              {saveError}
            </div>
          ) : null}

          <div className="mb-6 flex items-center justify-end gap-2 border-b border-red-900/40 pb-4">
            {missingPersonalityFiles.length > 0 ? (
              <button
                type="button"
                className={HQ_FORM_BUTTON_SECONDARY}
                disabled={agentFilesLoading || agentFilesSaving}
                onClick={() => {
                  void handleInitializeMissingFiles();
                }}
              >
                {t("brain.initMissing")}
              </button>
            ) : null}
            <button
              type="button"
              className={HQ_FORM_BUTTON_SECONDARY}
              disabled={agentFilesLoading || agentFilesSaving}
              onClick={onCancel}
            >
              {t("brain.cancel")}
            </button>
            <button
              type="button"
              className={HQ_FORM_BUTTON_PRIMARY}
              disabled={agentFilesLoading || agentFilesSaving || !agentFilesDirty}
              onClick={() => {
                void handleSave();
              }}
            >
              {t("brain.save")}
            </button>
          </div>

          <div className="space-y-8 pb-8">
            {renderedSections.map((section, index) => (
              <div key={`${activeSection ?? "all"}-${index}`}>{section}</div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
};
