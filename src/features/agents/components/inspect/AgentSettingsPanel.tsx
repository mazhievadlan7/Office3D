"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Bell,
  CalendarDays,
  ChevronRight,
  ExternalLink,
  ListChecks,
  Play,
  Sun,
  Trash2,
} from "lucide-react";

import { AgentSkillsPanel } from "@/features/agents/components/AgentSkillsPanel";
import { SystemSkillsPanel } from "@/features/agents/components/SystemSkillsPanel";
import { AgentInspectHeader } from "@/features/agents/components/inspect/AgentInspectHeader";
import { HermesAgentModelSection } from "@/features/hermes/components/HermesAgentModelSection";
import { HermesSkillsSection } from "@/features/hermes/components/HermesSkillsSection";
import {
  resolveExecutionRoleFromAgent,
  resolvePresetDefaultsForRole,
  type AgentPermissionsDraft,
} from "@/features/agents/operations/agentPermissionsOperation";
import type { AgentState } from "@/features/agents/state/store";
import type { CronCreateDraft, CronCreateTemplateId } from "@/lib/cron/createPayloadBuilder";
import { formatCronPayload, formatCronSchedule, type CronJobSummary } from "@/lib/cron/types";
import type { SkillStatusReport } from "@/lib/skills/types";
import type { StudioGatewayAdapterType } from "@/lib/studio/settings";
import {
  HQ_FORM_BADGE_MUTED,
  HQ_FORM_BUTTON_DANGER,
  HQ_FORM_BUTTON_PRIMARY,
  HQ_FORM_BUTTON_SECONDARY,
  HQ_FORM_CARD,
  HQ_FORM_FIELD,
  HQ_FORM_INSET,
  HQ_FORM_LABEL,
  HQ_FORM_NOTICE_ERROR,
  HQ_FORM_SELECT,
} from "@/features/agents/components/hqFormStyles";
import { LOCALE, t } from "@/lib/i18n";

export type AgentSettingsPanelProps = {
  agent: AgentState;
  mode?: "capabilities" | "skills" | "system" | "automations" | "advanced";
  showHeader?: boolean;
  onClose: () => void;
  permissionsDraft?: AgentPermissionsDraft;
  onUpdateAgentPermissions?: (draft: AgentPermissionsDraft) => Promise<void> | void;
  onDelete: () => void;
  canDelete?: boolean;
  onToolCallingToggle: (enabled: boolean) => void;
  onThinkingTracesToggle: (enabled: boolean) => void;
  cronJobs: CronJobSummary[];
  cronLoading: boolean;
  cronError: string | null;
  cronRunBusyJobId: string | null;
  cronDeleteBusyJobId: string | null;
  onRunCronJob: (jobId: string) => Promise<void> | void;
  onDeleteCronJob: (jobId: string) => Promise<void> | void;
  cronCreateBusy?: boolean;
  onCreateCronJob?: (draft: CronCreateDraft) => Promise<void> | void;
  controlUiUrl?: string | null;
  adapterType?: StudioGatewayAdapterType | null;
  skillsReport?: SkillStatusReport | null;
  skillsLoading?: boolean;
  skillsError?: string | null;
  skillsBusy?: boolean;
  skillsBusyKey?: string | null;
  skillMessages?: Record<string, { kind: "success" | "error"; message: string }>;
  skillApiKeyDrafts?: Record<string, string>;
  defaultAgentScopeWarning?: string | null;
  systemInitialSkillKey?: string | null;
  onSystemInitialSkillHandled?: () => void;
  skillsAllowlist?: string[] | undefined;
  onSetSkillEnabled?: (skillName: string, enabled: boolean) => Promise<void> | void;
  onOpenSystemSetup?: (skillKey?: string) => void;
  onSetSkillGlobalEnabled?: (skillKey: string, enabled: boolean) => Promise<void> | void;
  onInstallSkill?: (skillKey: string, name: string, installId: string) => Promise<void> | void;
  onRemoveSkill?: (
    skill: { skillKey: string; source: string; baseDir: string }
  ) => Promise<void> | void;
  onSkillApiKeyChange?: (skillKey: string, value: string) => Promise<void> | void;
  onSaveSkillApiKey?: (skillKey: string) => Promise<void> | void;
};

const EVERY_UNIT_SHORT: Record<NonNullable<CronCreateDraft["everyUnit"]>, () => string> = {
  minutes: () => t("agentSettings.unitMinutesShort"),
  hours: () => t("agentSettings.unitHoursShort"),
  days: () => t("agentSettings.unitDaysShort"),
};

const formatCronStateLine = (job: CronJobSummary): string | null => {
  if (typeof job.state.runningAtMs === "number" && Number.isFinite(job.state.runningAtMs)) {
    return t("agentSettings.runningNow");
  }
  if (typeof job.state.nextRunAtMs === "number" && Number.isFinite(job.state.nextRunAtMs)) {
    return t("agentSettings.nextRun", { when: new Date(job.state.nextRunAtMs).toLocaleString(LOCALE) });
  }
  if (typeof job.state.lastRunAtMs === "number" && Number.isFinite(job.state.lastRunAtMs)) {
    const status = job.state.lastStatus ? `${job.state.lastStatus} ` : "";
    return t("agentSettings.lastRun", { status, when: new Date(job.state.lastRunAtMs).toLocaleString(LOCALE) }).trim();
  }
  return null;
};

const getFirstLinePreview = (value: string, maxChars: number): string => {
  const firstLine =
    value
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";
  if (!firstLine) return "";
  if (firstLine.length <= maxChars) return firstLine;
  return `${firstLine.slice(0, maxChars)}...`;
};

type CronTemplateOption = {
  id: CronCreateTemplateId;
  title: string;
  description: string;
  icon: typeof Sun;
};

const CRON_TEMPLATE_OPTIONS: CronTemplateOption[] = [
  {
    id: "morning-brief",
    title: t("agentSettings.tplMorningTitle"),
    description: t("agentSettings.tplMorningDesc"),
    icon: Sun,
  },
  {
    id: "reminder",
    title: t("agentSettings.tplReminderTitle"),
    description: t("agentSettings.tplReminderDesc"),
    icon: Bell,
  },
  {
    id: "weekly-review",
    title: t("agentSettings.tplWeeklyTitle"),
    description: t("agentSettings.tplWeeklyDesc"),
    icon: CalendarDays,
  },
  {
    id: "inbox-triage",
    title: t("agentSettings.tplInboxTitle"),
    description: t("agentSettings.tplInboxDesc"),
    icon: ListChecks,
  },
  {
    id: "custom",
    title: t("agentSettings.tplCustomTitle"),
    description: t("agentSettings.tplCustomDesc"),
    icon: ListChecks,
  },
];

const TIMED_AUTOMATION_STEP_META: Array<{ title: string; indicator: string }> = [
  { title: t("agentSettings.stepChooseType"), indicator: t("agentSettings.stepType") },
  { title: t("agentSettings.stepDefine"), indicator: t("agentSettings.stepFunction") },
  { title: t("agentSettings.stepTiming"), indicator: t("agentSettings.stepTimingShort") },
  { title: t("agentSettings.stepReview"), indicator: t("agentSettings.stepReviewShort") },
];

const resolveLocalTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

const createInitialCronDraft = (): CronCreateDraft => ({
  templateId: "morning-brief",
  name: "",
  taskText: "",
  scheduleKind: "every",
  everyAmount: 30,
  everyUnit: "minutes",
  everyAtTime: "09:00",
  everyTimeZone: resolveLocalTimeZone(),
  deliveryMode: "none",
  deliveryChannel: "last",
});

const arePermissionsDraftEqual = (a: AgentPermissionsDraft, b: AgentPermissionsDraft): boolean =>
  a.commandMode === b.commandMode &&
  a.webAccess === b.webAccess &&
  a.fileTools === b.fileTools;

const applyTemplateDefaults = (templateId: CronCreateTemplateId, current: CronCreateDraft): CronCreateDraft => {
  const nextTimeZone = (current.everyTimeZone ?? "").trim() || resolveLocalTimeZone();
  const base = {
    ...createInitialCronDraft(),
    deliveryMode: current.deliveryMode ?? "none",
    deliveryChannel: current.deliveryChannel || "last",
    deliveryTo: current.deliveryTo,
    advancedSessionTarget: current.advancedSessionTarget,
    advancedWakeMode: current.advancedWakeMode,
    everyTimeZone: nextTimeZone,
  } satisfies CronCreateDraft;

  if (templateId === "morning-brief") {
    return {
      ...base,
      templateId,
      name: t("agentSettings.defMorningName"),
      taskText: t("agentSettings.defMorningTask"),
      scheduleKind: "every",
      everyAmount: 1,
      everyUnit: "days",
      everyAtTime: "07:00",
    };
  }
  if (templateId === "reminder") {
    return {
      ...base,
      templateId,
      name: t("agentSettings.tplReminderTitle"),
      taskText: t("agentSettings.defReminderTask"),
      scheduleKind: "at",
      scheduleAt: "",
    };
  }
  if (templateId === "weekly-review") {
    return {
      ...base,
      templateId,
      name: t("agentSettings.defWeeklyName"),
      taskText: t("agentSettings.defWeeklyTask"),
      scheduleKind: "every",
      everyAmount: 7,
      everyUnit: "days",
      everyAtTime: "09:00",
    };
  }
  if (templateId === "inbox-triage") {
    return {
      ...base,
      templateId,
      name: t("agentSettings.defInboxName"),
      taskText: t("agentSettings.defInboxTask"),
      scheduleKind: "every",
      everyAmount: 30,
      everyUnit: "minutes",
    };
  }
  return {
    ...base,
    templateId: "custom",
    name: "",
    taskText: "",
    scheduleKind: "every",
    everyAmount: 30,
    everyUnit: "minutes",
  };
};

export const AgentSettingsPanel = ({
  agent,
  mode = "capabilities",
  showHeader = true,
  onClose,
  permissionsDraft,
  onUpdateAgentPermissions = () => {},
  onDelete,
  canDelete = true,
  cronJobs,
  cronLoading,
  cronError,
  cronRunBusyJobId,
  cronDeleteBusyJobId,
  onRunCronJob,
  onDeleteCronJob,
  cronCreateBusy = false,
  onCreateCronJob = () => {},
  controlUiUrl = null,
  adapterType = "openclaw",
  skillsReport = null,
  skillsLoading = false,
  skillsError = null,
  skillsBusy = false,
  skillsBusyKey = null,
  skillMessages = {},
  skillApiKeyDrafts = {},
  defaultAgentScopeWarning = null,
  systemInitialSkillKey = null,
  onSystemInitialSkillHandled = () => {},
  skillsAllowlist,
  onSetSkillEnabled = () => {},
  onOpenSystemSetup = () => {},
  onSetSkillGlobalEnabled = () => {},
  onInstallSkill = () => {},
  onRemoveSkill = () => {},
  onSkillApiKeyChange = () => {},
  onSaveSkillApiKey = () => {},
}: AgentSettingsPanelProps) => {
  const isOpenClawRuntime = adapterType === "openclaw";
  const initialPermissionsDraft =
    permissionsDraft ?? resolvePresetDefaultsForRole(resolveExecutionRoleFromAgent(agent));
  const [permissionsBaselineValue, setPermissionsBaselineValue] =
    useState<AgentPermissionsDraft>(initialPermissionsDraft);
  const [permissionsDraftValue, setPermissionsDraftValue] =
    useState<AgentPermissionsDraft>(initialPermissionsDraft);
  const [permissionsSaving, setPermissionsSaving] = useState(false);
  const [permissionsSaveState, setPermissionsSaveState] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const [permissionsSaveError, setPermissionsSaveError] = useState<string | null>(null);
  const permissionsSaveTimerRef = useRef<number | null>(null);
  const permissionsDraftAgentIdRef = useRef(agent.agentId);
  const [expandedCronJobIds, setExpandedCronJobIds] = useState<Set<string>>(() => new Set());
  const [cronCreateOpen, setCronCreateOpen] = useState(false);
  const [cronCreateStep, setCronCreateStep] = useState(0);
  const [cronCreateError, setCronCreateError] = useState<string | null>(null);
  const [cronDraft, setCronDraft] = useState<CronCreateDraft>(createInitialCronDraft);

  const resolvedExecutionRole = useMemo(() => resolveExecutionRoleFromAgent(agent), [agent]);
  const resolvedPermissionsDraft = useMemo(
    () => permissionsDraft ?? resolvePresetDefaultsForRole(resolvedExecutionRole),
    [permissionsDraft, resolvedExecutionRole]
  );
  const permissionsDirty = useMemo(
    () => !arePermissionsDraftEqual(permissionsDraftValue, permissionsBaselineValue),
    [permissionsBaselineValue, permissionsDraftValue]
  );

  useEffect(() => {
    const agentChanged = permissionsDraftAgentIdRef.current !== agent.agentId;
    permissionsDraftAgentIdRef.current = agent.agentId;
    setPermissionsBaselineValue(resolvedPermissionsDraft);
    if (!agentChanged && (permissionsSaving || permissionsDirty)) {
      return;
    }
    setPermissionsDraftValue(resolvedPermissionsDraft);
    setPermissionsSaveState("idle");
    setPermissionsSaveError(null);
    setPermissionsSaving(false);
  }, [agent.agentId, permissionsDirty, permissionsSaving, resolvedPermissionsDraft]);

  const runPermissionsSave = useCallback(
    async (draft: AgentPermissionsDraft) => {
      if (permissionsSaving) return;
      setPermissionsSaving(true);
      setPermissionsSaveState("saving");
      setPermissionsSaveError(null);
      try {
        await onUpdateAgentPermissions(draft);
        setPermissionsSaveState("saved");
      } catch (err) {
        const message = err instanceof Error ? err.message : t("agentSettings.permissionsFailed");
        setPermissionsSaveState("error");
        setPermissionsSaveError(message);
      } finally {
        setPermissionsSaving(false);
      }
    },
    [onUpdateAgentPermissions, permissionsSaving]
  );

  useEffect(() => {
    return () => {
      if (permissionsSaveTimerRef.current !== null) {
        window.clearTimeout(permissionsSaveTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!permissionsDirty) return;
    if (permissionsSaving) return;
    if (permissionsSaveTimerRef.current !== null) {
      window.clearTimeout(permissionsSaveTimerRef.current);
    }
    setPermissionsSaveState("idle");
    permissionsSaveTimerRef.current = window.setTimeout(() => {
      permissionsSaveTimerRef.current = null;
      void runPermissionsSave(permissionsDraftValue);
    }, 450);
    return () => {
      if (permissionsSaveTimerRef.current !== null) {
        window.clearTimeout(permissionsSaveTimerRef.current);
        permissionsSaveTimerRef.current = null;
      }
    };
  }, [permissionsDirty, permissionsDraftValue, permissionsSaving, runPermissionsSave]);

  const openCronCreate = () => {
    setCronCreateOpen(true);
    setCronCreateStep(0);
    setCronCreateError(null);
    setCronDraft(createInitialCronDraft());
  };

  const closeCronCreate = () => {
    setCronCreateOpen(false);
    setCronCreateStep(0);
    setCronCreateError(null);
    setCronDraft(createInitialCronDraft());
  };

  const updateCronDraft = (patch: Partial<CronCreateDraft>) => {
    setCronDraft((prev) => ({ ...prev, ...patch }));
  };

  const selectCronTemplate = (templateId: CronCreateTemplateId) => {
    setCronDraft((prev) => applyTemplateDefaults(templateId, prev));
  };

  const canMoveToScheduleStep = cronDraft.name.trim().length > 0 && cronDraft.taskText.trim().length > 0;
  const canMoveToReviewStep =
    cronDraft.scheduleKind === "every"
      ? Number.isFinite(cronDraft.everyAmount) &&
        (cronDraft.everyAmount ?? 0) > 0 &&
        (cronDraft.everyUnit !== "days" ||
          ((cronDraft.everyAtTime ?? "").trim().length > 0 &&
            (cronDraft.everyTimeZone ?? "").trim().length > 0))
      : (cronDraft.scheduleAt ?? "").trim().length > 0;
  const canSubmitCronCreate = canMoveToScheduleStep && canMoveToReviewStep;

  const submitCronCreate = async () => {
    if (cronCreateBusy || !canSubmitCronCreate) {
      return;
    }
    setCronCreateError(null);
    const payload: CronCreateDraft = {
      templateId: cronDraft.templateId,
      name: cronDraft.name.trim(),
      taskText: cronDraft.taskText.trim(),
      scheduleKind: cronDraft.scheduleKind,
      ...(typeof cronDraft.everyAmount === "number" ? { everyAmount: cronDraft.everyAmount } : {}),
      ...(cronDraft.everyUnit ? { everyUnit: cronDraft.everyUnit } : {}),
      ...(cronDraft.everyUnit === "days" && cronDraft.everyAtTime
        ? { everyAtTime: cronDraft.everyAtTime }
        : {}),
      ...(cronDraft.everyUnit === "days" && cronDraft.everyTimeZone
        ? { everyTimeZone: cronDraft.everyTimeZone }
        : {}),
      ...(cronDraft.scheduleAt ? { scheduleAt: cronDraft.scheduleAt } : {}),
      ...(cronDraft.deliveryMode ? { deliveryMode: cronDraft.deliveryMode } : {}),
      ...(cronDraft.deliveryChannel ? { deliveryChannel: cronDraft.deliveryChannel } : {}),
      ...(cronDraft.deliveryTo ? { deliveryTo: cronDraft.deliveryTo } : {}),
      ...(cronDraft.advancedSessionTarget
        ? { advancedSessionTarget: cronDraft.advancedSessionTarget }
        : {}),
      ...(cronDraft.advancedWakeMode ? { advancedWakeMode: cronDraft.advancedWakeMode } : {}),
    };
    try {
      await onCreateCronJob(payload);
      closeCronCreate();
    } catch (err) {
      setCronCreateError(err instanceof Error ? err.message : t("agentSettings.createFailed"));
    }
  };

  const moveCronCreateBack = () => {
    setCronCreateStep((prev) => Math.max(0, prev - 1));
  };

  const moveCronCreateNext = () => {
    if (cronCreateStep === 0) {
      setCronCreateStep(1);
      return;
    }
    if (cronCreateStep === 1 && canMoveToScheduleStep) {
      setCronCreateStep(2);
      return;
    }
    if (cronCreateStep === 2 && canMoveToReviewStep) {
      setCronCreateStep(3);
    }
  };

  const panelLabel =
    mode === "advanced"
      ? t("agentSettings.advanced")
      : mode === "skills"
        ? t("agentSettings.skills")
        : mode === "system"
          ? t("agentSettings.systemSetup")
          : "";
  const canOpenControlUi = typeof controlUiUrl === "string" && controlUiUrl.trim().length > 0;
  const timedAutomationStepMeta =
    TIMED_AUTOMATION_STEP_META[cronCreateStep] ??
    TIMED_AUTOMATION_STEP_META[TIMED_AUTOMATION_STEP_META.length - 1];

  return (
    <div
      className="agent-inspect-panel"
      data-testid="agent-settings-panel"
      style={{ position: "relative", left: "auto", top: "auto", width: "100%", height: "100%" }}
    >
      {showHeader ? (
        <AgentInspectHeader
          label={panelLabel}
          title={agent.name}
          onClose={onClose}
          closeTestId="agent-settings-close"
        />
      ) : null}

      <div className="flex flex-col gap-0 px-5 pb-5">
        {mode === "capabilities" ? <HermesAgentModelSection agentId={agent.agentId} /> : null}
        {mode === "capabilities" ? <HermesSkillsSection agentId={agent.agentId} /> : null}
        {mode === "capabilities" ? (
          <section className="sidebar-section" data-testid="agent-settings-permissions">
            <div className="mt-2 flex flex-col gap-8">
              <div className="px-1 py-1">
                <div className="sidebar-copy flex flex-col gap-1 text-[11px] text-white/60">
                  <span className={HQ_FORM_LABEL}>{t("agentSettings.runCommands")}</span>
                  <div
                    className="mt-2 grid grid-cols-3 gap-1 rounded-md border border-red-900/40 bg-black/40 p-1"
                    role="group"
                    aria-label={t("agentSettings.runCommands")}
                  >
                    {(
                      [
                        { id: "off", label: t("agentSettings.off") },
                        { id: "ask", label: t("agentSettings.ask") },
                        { id: "auto", label: t("agentSettings.auto") },
                      ] as const
                    ).map((option) => {
                      const selected = permissionsDraftValue.commandMode === option.id;
                      return (
                        <button
                          key={option.id}
                          type="button"
                          aria-label={t("agentSettings.runCommandsOption", { option: option.label.toLowerCase() })}
                          aria-pressed={selected}
                          className={`rounded border px-3 py-2 text-center font-mono text-[11px] font-semibold uppercase tracking-[0.12em] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/50 ${
                            selected
                              ? "border-red-500/60 bg-red-600/25 text-white shadow-[0_0_12px_rgba(255,26,26,0.2)]"
                              : "border-transparent text-white/55 hover:bg-red-950/40 hover:text-white"
                          }`}
                          data-active={selected ? "true" : "false"}
                          onClick={() =>
                            setPermissionsDraftValue((current) => ({
                              ...current,
                              commandMode: option.id,
                            }))
                          }
                        >
                          {option.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
              <div className="ui-settings-row flex min-h-[68px] items-center justify-between gap-6 px-4 py-3">
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    role="switch"
                    aria-label={t("agentSettings.webAccess")}
                    aria-checked={permissionsDraftValue.webAccess}
                    className={`ui-switch self-center ${permissionsDraftValue.webAccess ? "ui-switch--on" : ""}`}
                    onClick={() =>
                      setPermissionsDraftValue((current) => ({
                        ...current,
                        webAccess: !current.webAccess,
                      }))
                    }
                  >
                    <span className="ui-switch-thumb" />
                  </button>
                  <div className="sidebar-copy flex flex-col">
                    <span className="text-[12px] font-medium text-white">{t("agentSettings.webAccess")}</span>
                    <span className="text-[11px] text-white/50">{t("agentSettings.webAccessHint")}</span>
                  </div>
                </div>
                <ChevronRight className="h-4 w-4 text-white/40" aria-hidden="true" />
              </div>
              <div className="ui-settings-row flex min-h-[68px] items-center justify-between gap-6 px-4 py-3">
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    role="switch"
                    aria-label={t("agentSettings.fileTools")}
                    aria-checked={permissionsDraftValue.fileTools}
                    className={`ui-switch self-center ${permissionsDraftValue.fileTools ? "ui-switch--on" : ""}`}
                    onClick={() =>
                      setPermissionsDraftValue((current) => ({
                        ...current,
                        fileTools: !current.fileTools,
                      }))
                    }
                  >
                    <span className="ui-switch-thumb" />
                  </button>
                  <div className="sidebar-copy flex flex-col">
                    <span className="text-[12px] font-medium text-white">{t("agentSettings.fileTools")}</span>
                    <span className="text-[11px] text-white/50">{t("agentSettings.fileToolsHint")}</span>
                  </div>
                </div>
                <ChevronRight className="h-4 w-4 text-white/40" aria-hidden="true" />
              </div>
              <div className="ui-settings-row flex min-h-[68px] items-center justify-between gap-6 px-4 py-3">
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    role="switch"
                    aria-label={t("agentSettings.browserAutomation")}
                    aria-checked="false"
                    className="ui-switch self-center"
                    disabled
                  >
                    <span className="ui-switch-thumb" />
                  </button>
                  <div className="sidebar-copy flex flex-col">
                    <span className="text-[12px] font-medium text-white">{t("agentSettings.browserAutomation")}</span>
                    <span className="text-[11px] text-white/50">{t("agentSettings.comingSoon")}</span>
                  </div>
                </div>
                <ChevronRight className="h-4 w-4 text-white/40" aria-hidden="true" />
              </div>
            </div>
            <div className="sidebar-copy mt-3 text-[11px] text-white/60">
              {permissionsSaveState === "saving" ? t("agentSettings.saving") : null}
              {permissionsSaveState === "saved" ? t("agentSettings.saved") : null}
              {permissionsSaveState === "error" && permissionsSaveError ? (
                <span>
                  {t("agentSettings.saveFailedWith", { reason: permissionsSaveError ?? "" })}{" "}
                  <button
                    type="button"
                    className="text-red-300 underline underline-offset-2 hover:text-white"
                    onClick={() => {
                      void runPermissionsSave(permissionsDraftValue);
                    }}
                  >{t("agentSettings.retry")}</button>
                </span>
              ) : null}
            </div>
            {permissionsSaveState === "error" && !permissionsSaveError ? (
              <div className={`mt-3 ${HQ_FORM_NOTICE_ERROR}`}>
                {t("agentSettings.permissionsSaveFailed")}
              </div>
            ) : null}
          </section>
        ) : null}

        {mode === "skills" ? (
          <AgentSkillsPanel
            skillsReport={skillsReport}
            skillsLoading={skillsLoading}
            skillsError={skillsError}
            skillsBusy={skillsBusy}
            skillsBusyKey={skillsBusyKey}
            skillsAllowlist={skillsAllowlist}
            onSetSkillEnabled={onSetSkillEnabled}
            onOpenSystemSetup={onOpenSystemSetup}
          />
        ) : null}

        {mode === "system" ? (
          <SystemSkillsPanel
            skillsReport={skillsReport}
            skillsLoading={skillsLoading}
            skillsError={skillsError}
            skillsBusy={skillsBusy}
            skillsBusyKey={skillsBusyKey}
            skillMessages={skillMessages}
            skillApiKeyDrafts={skillApiKeyDrafts}
            defaultAgentScopeWarning={defaultAgentScopeWarning}
            initialSkillKey={systemInitialSkillKey}
            onInitialSkillKeyHandled={onSystemInitialSkillHandled}
            onSetSkillGlobalEnabled={onSetSkillGlobalEnabled}
            onInstallSkill={onInstallSkill}
            onRemoveSkill={onRemoveSkill}
            onSkillApiKeyChange={onSkillApiKeyChange}
            onSaveSkillApiKey={onSaveSkillApiKey}
          />
        ) : null}

        {mode === "automations" ? (
          <section className="sidebar-section" data-testid="agent-settings-cron">
            <div className="flex items-center justify-between gap-2">
              <h3 className="sidebar-section-title">{t("agentSettings.timedAutomations")}</h3>
              {!cronLoading && !cronError && cronJobs.length > 0 ? (
                <button
                  className={HQ_FORM_BUTTON_SECONDARY}
                  type="button"
                  onClick={openCronCreate}
                >{t("agentSettings.create")}</button>
              ) : null}
            </div>
            {cronLoading ? (
              <div className="mt-3 font-mono text-[11px] uppercase tracking-[0.14em] text-white/50">{t("agentSettings.loadingAutomations")}</div>
            ) : null}
            {!cronLoading && cronError ? (
              <div className={`mt-3 ${HQ_FORM_NOTICE_ERROR}`}>
                {cronError}
              </div>
            ) : null}
            {!cronLoading && !cronError && cronJobs.length === 0 ? (
              <div className="mt-3 flex flex-col items-center justify-center gap-4 rounded-md border border-dashed border-red-900/40 px-5 py-6 text-center">
                <CalendarDays
                  className="h-4 w-4 text-red-400/80"
                  aria-hidden="true"
                  data-testid="cron-empty-icon"
                />
                <div className="sidebar-copy text-[12px] text-white/55">{t("agentSettings.noAutomations")}</div>
                <button
                  className={`${HQ_FORM_BUTTON_PRIMARY} mt-2 min-w-[116px] self-center`}
                  type="button"
                  onClick={openCronCreate}
                >{t("agentSettings.create")}</button>
              </div>
            ) : null}
            {!cronLoading && !cronError && cronJobs.length > 0 ? (
              <div className="mt-3 flex flex-col gap-3">
                {cronJobs.map((job) => {
                  const runBusy = cronRunBusyJobId === job.id;
                  const deleteBusy = cronDeleteBusyJobId === job.id;
                  const busy = runBusy || deleteBusy;
                  const scheduleText = formatCronSchedule(job.schedule);
                  const payloadText = formatCronPayload(job.payload).trim();
                  const payloadPreview = getFirstLinePreview(payloadText, 160);
                  const payloadExpandable =
                    payloadText.length > payloadPreview.length || payloadText.split("\n").length > 1;
                  const expanded = expandedCronJobIds.has(job.id);
                  const stateLine = formatCronStateLine(job);
                  return (
                    <div
                      key={job.id}
                      className={`group/cron ${HQ_FORM_CARD} flex items-start justify-between gap-2 px-4 py-3 transition-colors hover:border-red-600/45`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <div className="min-w-0 flex-1 truncate font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-white">
                            {job.name}
                          </div>
                          {!job.enabled ? (
                            <div className={HQ_FORM_BADGE_MUTED}>{t("agentSettings.disabled")}</div>
                          ) : null}
                        </div>
                        <div className="mt-1 text-[11px] text-white/70">
                          <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-white/45">{t("agentSettings.frequency")}</span>
                          <div className="break-words">{scheduleText}</div>
                        </div>
                        {stateLine ? (
                          <div className="mt-1 break-words text-[11px] text-white/55">
                            {stateLine}
                          </div>
                        ) : null}
                        {payloadText ? (
                          <div className="mt-1 text-[11px] text-white/70">
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-white/45">{t("agentSettings.task")}</span>
                              {payloadExpandable ? (
                                <button
                                  className="shrink-0 rounded border border-red-600/35 bg-black/50 px-2 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-white/70 transition-colors hover:border-red-500/50 hover:bg-red-950/40 hover:text-white"
                                  type="button"
                                  onClick={() => {
                                    setExpandedCronJobIds((prev) => {
                                      const next = new Set(prev);
                                      if (next.has(job.id)) {
                                        next.delete(job.id);
                                      } else {
                                        next.add(job.id);
                                      }
                                      return next;
                                    });
                                  }}
                                >
                                  {expanded ? t("agentSettings.less") : t("agentSettings.more")}
                                </button>
                              ) : null}
                            </div>
                            <div className="mt-0.5 whitespace-pre-wrap break-words" title={payloadText}>
                              {expanded ? payloadText : payloadPreview || payloadText}
                            </div>
                          </div>
                        ) : null}
                      </div>
                      <div className="flex items-center gap-1 opacity-0 transition group-focus-within/cron:opacity-100 group-hover/cron:opacity-100">
                        <button
                          className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-red-600/35 bg-black/50 text-white/75 transition-colors hover:border-red-500/50 hover:bg-red-950/40 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/50 disabled:cursor-not-allowed disabled:opacity-60"
                          type="button"
                          aria-label={t("agentSettings.runNowLabel", { name: job.name })}
                          onClick={() => {
                            void onRunCronJob(job.id);
                          }}
                          disabled={busy}
                        >
                          <Play className="h-3.5 w-3.5" />
                        </button>
                        <button
                          className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-red-500/45 bg-red-950/40 text-red-300 transition-colors hover:border-red-500/70 hover:bg-red-900/50 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/50 disabled:cursor-not-allowed disabled:opacity-60"
                          type="button"
                          aria-label={t("agentSettings.deleteLabel", { name: job.name })}
                          onClick={() => {
                            void onDeleteCronJob(job.id);
                          }}
                          disabled={busy}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : null}
            {isOpenClawRuntime ? (
              <section className="sidebar-section" data-testid="agent-settings-heartbeat-coming-soon">
                <h3 className="sidebar-section-title">{t("agentSettings.heartbeats")}</h3>
                <div className="mt-3 text-[11px] text-white/55">{t("agentSettings.heartbeatsSoon")}</div>
              </section>
            ) : null}
          </section>
        ) : null}

        {mode === "advanced" ? (
          <>
            {isOpenClawRuntime ? (
              <section className="sidebar-section mt-8" data-testid="agent-settings-control-ui">
                <h3 className="sidebar-section-title ui-text-danger">{t("agentSettings.dangerZone")}</h3>
                <div className={`mt-3 ${HQ_FORM_NOTICE_ERROR}`}>
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    <div className="space-y-1">
                      <div className="font-medium">{t("agentSettings.advancedOnly")}</div>
                      <div>{t("agentSettings.controlUiHint")}</div>
                      <div>{t("agentSettings.controlUiWarning")}</div>
                    </div>
                  </div>
                </div>
                {canOpenControlUi ? (
                  <a
                    className={`${HQ_FORM_BUTTON_DANGER} mt-3`}
                    href={controlUiUrl ?? undefined}
                    target="_blank"
                    rel="noreferrer"
                  >{t("agentSettings.openControlUi")}<ExternalLink className="h-3 w-3" aria-hidden="true" />
                  </a>
                ) : (
                  <>
                    <button
                      className={`${HQ_FORM_BUTTON_DANGER} mt-3`}
                      type="button"
                      disabled
                    >{t("agentSettings.openControlUi")}</button>
                    <div className="mt-2 text-[11px] text-white/45">{t("agentSettings.controlUiUnavailable")}</div>
                  </>
                )}
              </section>
            ) : null}

            {canDelete ? (
              <section className="sidebar-section mt-8">
                <div className="text-[11px] text-white/55">{t("agentSettings.deleteHint")}</div>
                <button
                  className={`${HQ_FORM_BUTTON_DANGER} mt-3`}
                  type="button"
                  onClick={onDelete}
                >{t("agentSettings.deleteAgent")}</button>
              </section>
            ) : (
              <section className="sidebar-section mt-8">
                <h3 className="sidebar-section-title">{t("agentSettings.systemAgent")}</h3>
                <div className="mt-3 text-[11px] text-white/55">{t("agentSettings.mainReserved")}</div>
              </section>
            )}
          </>
        ) : null}
      </div>

      {cronCreateOpen ? (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-label={t("agentSettings.createAutomation")}
          onClick={closeCronCreate}
        >
          <div
            className="w-full max-w-2xl rounded-lg border border-red-900/50 bg-[#070404] text-white shadow-[0_0_40px_rgba(255,26,26,0.1)]"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3 border-b border-red-900/40 px-6 py-5">
              <div className="min-w-0">
                <div className={HQ_FORM_LABEL}>{t("agentSettings.composer")}</div>
                <div className="mt-1 text-base font-semibold text-white">
                  {timedAutomationStepMeta.title}
                </div>
              </div>
              <button
                type="button"
                className={HQ_FORM_BUTTON_SECONDARY}
                onClick={closeCronCreate}
              >{t("agentSettings.close")}</button>
            </div>
            <div className="space-y-4 px-5 py-5">
              {cronCreateError ? (
                <div className={HQ_FORM_NOTICE_ERROR}>
                  {cronCreateError}
                </div>
              ) : null}
              {cronCreateStep === 0 ? (
                <div className="space-y-3">
                  <div className="text-[13px] text-white/65">{t("agentSettings.pickTemplate")}</div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {CRON_TEMPLATE_OPTIONS.map((option) => {
                      const active = option.id === cronDraft.templateId;
                      const Icon = option.icon;
                      return (
                        <button
                          key={option.id}
                          type="button"
                          aria-label={option.title}
                          className={`rounded-md border px-3 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/50 ${
                            active
                              ? "border-red-500/60 bg-red-600/20 shadow-[0_0_14px_rgba(255,26,26,0.18)]"
                              : "border-red-900/40 bg-[#0b0707] hover:border-red-500/50 hover:bg-red-950/40"
                          }`}
                          onClick={() => selectCronTemplate(option.id)}
                        >
                          <div className="flex items-center gap-2">
                            <Icon className={`h-4 w-4 ${active ? "text-red-400" : "text-white/60"}`} />
                            <div className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-white">
                              {option.title}
                            </div>
                          </div>
                          <div className="mt-1 text-[11px] text-white/55">
                            {option.description}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : null}
              {cronCreateStep === 1 ? (
                <div className="space-y-3">
                  <div className="text-[13px] text-white/65">{t("agentSettings.nameAndDescribe")}</div>
                  <label className="flex flex-col gap-1.5 text-[11px] text-white/60">
                    <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em]">{t("agentSettings.automationName")}</span>
                    <input
                      aria-label={t("agentSettings.automationName")}
                      className={`h-10 ${HQ_FORM_FIELD}`}
                      value={cronDraft.name}
                      onChange={(event) => updateCronDraft({ name: event.target.value })}
                    />
                  </label>
                  <label className="flex flex-col gap-1.5 text-[11px] text-white/60">
                    <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em]">{t("agentSettings.task")}</span>
                    <textarea
                      aria-label={t("agentSettings.task")}
                      className={`min-h-28 ${HQ_FORM_FIELD}`}
                      value={cronDraft.taskText}
                      onChange={(event) => updateCronDraft({ taskText: event.target.value })}
                    />
                  </label>
                </div>
              ) : null}
              {cronCreateStep === 2 ? (
                <div className="space-y-3">
                  <div className="text-[13px] text-white/65">{t("agentSettings.chooseWhen")}</div>
                  <label className="flex flex-col gap-1.5 text-[11px] text-white/60">
                    <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em]">{t("agentSettings.scheduleType")}</span>
                    <select
                      className={`h-10 ${HQ_FORM_SELECT}`}
                      value={cronDraft.scheduleKind}
                      onChange={(event) =>
                        updateCronDraft({
                          scheduleKind: event.target.value as CronCreateDraft["scheduleKind"],
                        })
                      }
                    >
                      <option value="every">{t("agentSettings.every")}</option>
                      <option value="at">{t("agentSettings.oneTime")}</option>
                    </select>
                  </label>
                  {cronDraft.scheduleKind === "every" ? (
                    <div className="grid gap-2 sm:grid-cols-2">
                      <label className="flex flex-col gap-1.5 text-[11px] text-white/60">
                        <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em]">{t("agentSettings.every")}</span>
                        <input
                          type="number"
                          min={1}
                          step={1}
                          className={`h-10 ${HQ_FORM_FIELD}`}
                          value={String(cronDraft.everyAmount ?? 30)}
                          onChange={(event) =>
                            updateCronDraft({
                              everyAmount: Number.parseInt(event.target.value, 10) || 0,
                            })
                          }
                        />
                      </label>
                      <label className="flex flex-col gap-1.5 text-[11px] text-white/60">
                        <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em]">{t("agentSettings.unit")}</span>
                        <select
                          className={`h-10 ${HQ_FORM_SELECT}`}
                          value={cronDraft.everyUnit ?? "minutes"}
                          onChange={(event) =>
                            updateCronDraft({
                              everyUnit: event.target.value as CronCreateDraft["everyUnit"],
                            })
                          }
                        >
                          <option value="minutes">{t("agentSettings.minutes")}</option>
                          <option value="hours">{t("agentSettings.hours")}</option>
                          <option value="days">{t("agentSettings.days")}</option>
                        </select>
                      </label>
                      {cronDraft.everyUnit === "days" ? (
                        <>
                          <label className="flex flex-col gap-1.5 text-[11px] text-white/60">
                            <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em]">{t("agentSettings.timeOfDay")}</span>
                            <input
                              type="time"
                              className={`h-10 ${HQ_FORM_FIELD}`}
                              value={cronDraft.everyAtTime ?? "09:00"}
                              onChange={(event) => updateCronDraft({ everyAtTime: event.target.value })}
                            />
                          </label>
                          <label className="flex flex-col gap-1.5 text-[11px] text-white/60">
                            <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em]">{t("agentSettings.timezone")}</span>
                            <input
                              className={`h-10 ${HQ_FORM_FIELD}`}
                              value={cronDraft.everyTimeZone ?? resolveLocalTimeZone()}
                              onChange={(event) =>
                                updateCronDraft({ everyTimeZone: event.target.value })
                              }
                            />
                          </label>
                        </>
                      ) : null}
                    </div>
                  ) : null}
                  {cronDraft.scheduleKind === "at" ? (
                    <label className="flex flex-col gap-1.5 text-[11px] text-white/60">
                      <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em]">{t("agentSettings.runAt")}</span>
                      <input
                        type="datetime-local"
                        className={`h-10 ${HQ_FORM_FIELD}`}
                        value={cronDraft.scheduleAt ?? ""}
                        onChange={(event) => updateCronDraft({ scheduleAt: event.target.value })}
                      />
                    </label>
                  ) : null}
                </div>
              ) : null}
              {cronCreateStep === 3 ? (
                <div className="space-y-3 text-[13px] text-white/65">
                  <div>{t("agentSettings.reviewBeforeCreate")}</div>
                  <div className={`${HQ_FORM_INSET} px-3 py-2 text-white/75`}>
                    <div className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-white">
                      {cronDraft.name || t("agentSettings.untitled")}
                    </div>
                    <div className="mt-1 text-[11px]">
                      {cronDraft.taskText || t("agentSettings.noTask")}
                    </div>
                    <div className="mt-2 text-[11px]">
                      {t("agentSettings.scheduleLabel")}{" "}
                      {cronDraft.scheduleKind === "every"
                        ? t("agentSettings.everySummary", {
                            amount: cronDraft.everyAmount ?? 0,
                            unit: EVERY_UNIT_SHORT[cronDraft.everyUnit ?? "minutes"](),
                          }) +
                          (cronDraft.everyUnit === "days"
                            ? ` ${t("agentSettings.atTimeZone", {
                                time: cronDraft.everyAtTime ?? "",
                                zone: cronDraft.everyTimeZone ?? resolveLocalTimeZone(),
                              })}`
                            : "")
                        : t("agentSettings.atSummary", { at: cronDraft.scheduleAt ?? "" })}
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
            <div className="flex items-center justify-between gap-2 border-t border-red-900/40 px-5 pb-4 pt-5">
              <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/45">
                {t("agentSettings.stepOf", { indicator: timedAutomationStepMeta.indicator, step: cronCreateStep + 1, total: 4 })}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className={HQ_FORM_BUTTON_SECONDARY}
                  onClick={moveCronCreateBack}
                  disabled={cronCreateStep === 0 || cronCreateBusy}
                >{t("agentSettings.back")}</button>
                {cronCreateStep < 3 ? (
                  <button
                    type="button"
                    className={HQ_FORM_BUTTON_SECONDARY}
                    onClick={moveCronCreateNext}
                    disabled={
                      cronCreateBusy ||
                      (cronCreateStep === 1 && !canMoveToScheduleStep) ||
                      (cronCreateStep === 2 && !canMoveToReviewStep)
                    }
                  >{t("agentSettings.next")}</button>
                ) : null}
                {cronCreateStep === 3 ? (
                  <button
                    type="button"
                    className={HQ_FORM_BUTTON_PRIMARY}
                    onClick={() => {
                      void submitCronCreate();
                    }}
                    disabled={cronCreateBusy || !canSubmitCronCreate}
                  >{t("agentSettings.createAutomation")}</button>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
};
