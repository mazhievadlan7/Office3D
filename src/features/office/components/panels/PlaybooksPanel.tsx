"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import type { AgentState } from "@/features/agents/state/store";
import {
  HQ_BADGE,
  HQ_BADGE_ERROR,
  HQ_BUTTON_DANGER,
  HQ_BUTTON_PRIMARY,
  HQ_BUTTON_SECONDARY,
  HQ_CARD,
  HQ_CARD_BUTTON_SELECTED,
  HQ_CHECKBOX,
  HQ_EMPTY,
  HQ_FIELD,
  HQ_FIELD_PROSE,
  HQ_HINT,
  HQ_INSET,
  HQ_LABEL,
  HQ_NOTICE_ERROR,
  HQ_NOTICE_OK,
  HQ_PANEL_HEADER,
  HQ_PANEL_LEAD,
  HQ_PANEL_TITLE,
  HQ_SECTION,
  HQ_SECTION_TITLE,
  HQ_SELECT,
} from "@/features/office/components/panels/hqPanelStyles";
import type { OfficeStandupController } from "@/features/office/hooks/useOfficeStandupController";
import {
  createCronJob,
  formatCronSchedule,
  listCronJobs,
  removeCronJob,
  runCronJobNow,
  sortCronJobsByUpdatedAt,
  type CronJobCreateInput,
  type CronJobSummary,
} from "@/lib/cron/types";
import type { GatewayClient, GatewayStatus } from "@/lib/gateway/GatewayClient";
import { isGatewayDisconnectLikeError } from "@/lib/gateway/GatewayClient";
import { t } from "@/lib/i18n";
import { standupPhaseLabel } from "@/lib/office/standup/labels";

type TemplateDefinition = {
  id: string;
  name: string;
  description: string;
  buildInput: (agent: AgentState, customName: string) => CronJobCreateInput;
};

const PLAYBOOK_TEMPLATES: TemplateDefinition[] = [
  {
    id: "daily-briefing",
    name: t("playbookTemplate.briefingName"),
    description: t("playbookTemplate.briefingDescription"),
    buildInput: (agent, customName) => ({
      name: customName || t("playbookTemplate.briefingName"),
      agentId: agent.agentId,
      sessionKey: agent.sessionKey,
      enabled: true,
      schedule: { kind: "cron", expr: "0 9 * * *" },
      sessionTarget: "main",
      wakeMode: "now",
      payload: {
        kind: "agentTurn",
        message:
          t("playbookTemplate.briefingPrompt"),
        thinking: "high",
      },
    }),
  },
  {
    id: "nightly-code-review",
    name: t("playbookTemplate.reviewName"),
    description: t("playbookTemplate.reviewDescription"),
    buildInput: (agent, customName) => ({
      name: customName || t("playbookTemplate.reviewName"),
      agentId: agent.agentId,
      sessionKey: agent.sessionKey,
      enabled: true,
      schedule: { kind: "cron", expr: "0 0 * * *" },
      sessionTarget: "main",
      wakeMode: "now",
      payload: {
        kind: "agentTurn",
        message:
          t("playbookTemplate.reviewPrompt"),
        thinking: "high",
      },
    }),
  },
  {
    id: "hourly-health-check",
    name: t("playbookTemplate.healthName"),
    description: t("playbookTemplate.healthDescription"),
    buildInput: (agent, customName) => ({
      name: customName || t("playbookTemplate.healthName"),
      agentId: agent.agentId,
      sessionKey: agent.sessionKey,
      enabled: true,
      schedule: { kind: "every", everyMs: 60 * 60 * 1000 },
      sessionTarget: "main",
      wakeMode: "now",
      payload: {
        kind: "agentTurn",
        message:
          t("playbookTemplate.healthPrompt"),
        thinking: "medium",
      },
    }),
  },
  {
    id: "weekly-progress-report",
    name: t("playbookTemplate.weeklyName"),
    description: t("playbookTemplate.weeklyDescription"),
    buildInput: (agent, customName) => ({
      name: customName || t("playbookTemplate.weeklyName"),
      agentId: agent.agentId,
      sessionKey: agent.sessionKey,
      enabled: true,
      schedule: { kind: "cron", expr: "0 8 * * 1" },
      sessionTarget: "main",
      wakeMode: "now",
      payload: {
        kind: "agentTurn",
        message:
          t("playbookTemplate.weeklyPrompt"),
        thinking: "high",
      },
    }),
  },
  {
    id: "continuous-monitor",
    name: t("playbookTemplate.monitorName"),
    description: t("playbookTemplate.monitorDescription"),
    buildInput: (agent, customName) => ({
      name: customName || t("playbookTemplate.monitorName"),
      agentId: agent.agentId,
      sessionKey: agent.sessionKey,
      enabled: true,
      schedule: { kind: "every", everyMs: 15 * 60 * 1000 },
      sessionTarget: "main",
      wakeMode: "now",
      payload: {
        kind: "agentTurn",
        message:
          t("playbookTemplate.monitorPrompt"),
        thinking: "medium",
      },
    }),
  },
];

const CRON_STATUS_LABELS: Record<NonNullable<CronJobSummary["state"]["lastStatus"]> | "ready", () => string> = {
  ok: () => t("playbooks.statusOk"),
  error: () => t("playbooks.statusError"),
  skipped: () => t("playbooks.statusSkipped"),
  ready: () => t("playbooks.ready"),
};

const formatRelativeDateTime = (timestampMs?: number) => {
  if (!timestampMs || !Number.isFinite(timestampMs)) return t("playbooks.unknown");
  return new Date(timestampMs).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
};

export function PlaybooksPanel({
  client,
  status,
  cronEnabled = true,
  agents,
  standup,
}: {
  client: GatewayClient;
  status: GatewayStatus;
  cronEnabled?: boolean;
  agents: AgentState[];
  standup: OfficeStandupController;
}) {
  const [jobs, setJobs] = useState<CronJobSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [nameOverride, setNameOverride] = useState("");
  const [createBusy, setCreateBusy] = useState(false);
  const [runBusyJobId, setRunBusyJobId] = useState<string | null>(null);
  const [deleteBusyJobId, setDeleteBusyJobId] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const agentById = useMemo(
    () => new Map(agents.map((agent) => [agent.agentId, agent])),
    [agents]
  );

  const activeTemplate = useMemo(
    () => PLAYBOOK_TEMPLATES.find((template) => template.id === selectedTemplateId) ?? null,
    [selectedTemplateId]
  );
  const [standupAgentId, setStandupAgentId] = useState("");
  const [standupCronExpr, setStandupCronExpr] = useState("0 9 * * 1-5");
  const [standupTimezone, setStandupTimezone] = useState("UTC");
  const [standupSpeakerSeconds, setStandupSpeakerSeconds] = useState("8");
  const [standupAutoOpenBoard, setStandupAutoOpenBoard] = useState(true);
  const [standupScheduleEnabled, setStandupScheduleEnabled] = useState(false);
  const [jiraEnabled, setJiraEnabled] = useState(false);
  const [jiraBaseUrl, setJiraBaseUrl] = useState("");
  const [jiraEmail, setJiraEmail] = useState("");
  const [jiraApiToken, setJiraApiToken] = useState("");
  const [jiraApiTokenConfigured, setJiraApiTokenConfigured] = useState(false);
  const [jiraProjectKey, setJiraProjectKey] = useState("");
  const [jiraJql, setJiraJql] = useState("");
  const [manualTask, setManualTask] = useState("");
  const [manualBlockers, setManualBlockers] = useState("");
  const [manualNote, setManualNote] = useState("");
  const [manualJiraAssignee, setManualJiraAssignee] = useState("");

  useEffect(() => {
    if (!standup.config) return;
    setStandupScheduleEnabled(standup.config.schedule.enabled);
    setStandupCronExpr(standup.config.schedule.cronExpr);
    setStandupTimezone(standup.config.schedule.timezone);
    setStandupSpeakerSeconds(String(standup.config.schedule.speakerSeconds));
    setStandupAutoOpenBoard(standup.config.schedule.autoOpenBoard);
    setJiraEnabled(standup.config.jira.enabled);
    setJiraBaseUrl(standup.config.jira.baseUrl);
    setJiraEmail(standup.config.jira.email);
    setJiraApiToken(standup.config.jira.apiToken);
    setJiraApiTokenConfigured(standup.config.jira.apiTokenConfigured);
    setJiraProjectKey(standup.config.jira.projectKey);
    setJiraJql(standup.config.jira.jql);
  }, [standup.config]);

  useEffect(() => {
    if (standupAgentId || agents.length === 0) return;
    setStandupAgentId(agents[0]?.agentId ?? "");
  }, [agents, standupAgentId]);

  useEffect(() => {
    if (!standup.config || !standupAgentId) return;
    const manual = standup.config.manualByAgentId[standupAgentId];
    setManualTask(manual?.currentTask ?? "");
    setManualBlockers(manual?.blockers ?? "");
    setManualNote(manual?.note ?? "");
    setManualJiraAssignee(manual?.jiraAssignee ?? "");
  }, [standup.config, standupAgentId]);

  const loadJobs = useCallback(async () => {
    if (!cronEnabled || status !== "connected") {
      setJobs([]);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await listCronJobs(client, { includeDisabled: true });
      setJobs(sortCronJobsByUpdatedAt(result.jobs));
    } catch (err) {
      const message = err instanceof Error ? err.message : t("playbooks.loadFailed");
      setError(message);
      if (!isGatewayDisconnectLikeError(err)) {
        console.error(message);
      }
    } finally {
      setLoading(false);
    }
  }, [client, cronEnabled, status]);

  useEffect(() => {
    void loadJobs();
  }, [loadJobs]);

  const handleCreate = useCallback(async () => {
    if (!cronEnabled) {
      setError(t("playbooks.unsupported"));
      return;
    }
    if (!activeTemplate) return;
    const agent = agentById.get(selectedAgentId);
    if (!agent) {
      setError(t("playbooks.pickAgentRun"));
      return;
    }

    setCreateBusy(true);
    setError(null);
    setActionMessage(null);
    try {
      await createCronJob(client, activeTemplate.buildInput(agent, nameOverride.trim()));
      setActionMessage(t("playbooks.created", { name: nameOverride.trim() || activeTemplate.name }));
      setSelectedTemplateId(null);
      setSelectedAgentId("");
      setNameOverride("");
      await loadJobs();
    } catch (err) {
      const message = err instanceof Error ? err.message : t("playbooks.createFailed");
      setError(message);
    } finally {
      setCreateBusy(false);
    }
  }, [activeTemplate, agentById, client, cronEnabled, loadJobs, nameOverride, selectedAgentId]);

  const handleRunNow = useCallback(
    async (jobId: string) => {
      if (!cronEnabled) {
        setError(t("playbooks.unsupported"));
        return;
      }
      setRunBusyJobId(jobId);
      setError(null);
      setActionMessage(null);
      try {
        const result = await runCronJobNow(client, jobId);
        setActionMessage(result.ok ? t("playbooks.triggered") : t("playbooks.triggerFailed"));
        await loadJobs();
      } catch (err) {
        setError(err instanceof Error ? err.message : t("playbooks.runFailed"));
      } finally {
        setRunBusyJobId(null);
      }
    },
    [client, cronEnabled, loadJobs]
  );

  const handleDelete = useCallback(
    async (jobId: string) => {
      if (!cronEnabled) {
        setError(t("playbooks.unsupported"));
        return;
      }
      setDeleteBusyJobId(jobId);
      setError(null);
      setActionMessage(null);
      try {
        const result = await removeCronJob(client, jobId);
        setActionMessage(result.ok && result.removed ? t("playbooks.removed") : t("playbooks.notRemoved"));
        await loadJobs();
      } catch (err) {
        setError(err instanceof Error ? err.message : t("playbooks.deleteFailed"));
      } finally {
        setDeleteBusyJobId(null);
      }
    },
    [client, cronEnabled, loadJobs]
  );

  const handleSaveStandupConfig = useCallback(async () => {
    setError(null);
    setActionMessage(null);
    try {
      await standup.saveConfig({
        schedule: {
          enabled: standupScheduleEnabled,
          cronExpr: standupCronExpr.trim() || "0 9 * * 1-5",
          timezone: standupTimezone.trim() || "UTC",
          speakerSeconds: Number(standupSpeakerSeconds) || 8,
          autoOpenBoard: standupAutoOpenBoard,
        },
        jira: {
          enabled: jiraEnabled,
          baseUrl: jiraBaseUrl.trim(),
          email: jiraEmail.trim(),
          apiToken: jiraApiToken.trim(),
          projectKey: jiraProjectKey.trim().toUpperCase(),
          jql: jiraJql.trim(),
        },
      });
      setActionMessage(t("playbooks.standupSaved"));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("playbooks.standupSaveFailed"));
    }
  }, [
    jiraApiToken,
    jiraBaseUrl,
    jiraEmail,
    jiraEnabled,
    jiraJql,
    jiraProjectKey,
    standup,
    standupAutoOpenBoard,
    standupCronExpr,
    standupScheduleEnabled,
    standupSpeakerSeconds,
    standupTimezone,
  ]);

  const handleSaveManualNotes = useCallback(async () => {
    if (!standupAgentId) {
      setError(t("playbooks.pickAgentNotes"));
      return;
    }
    setError(null);
    setActionMessage(null);
    try {
      await standup.updateManualEntry(standupAgentId, {
        jiraAssignee: manualJiraAssignee.trim() || null,
        currentTask: manualTask.trim(),
        blockers: manualBlockers.trim(),
        note: manualNote.trim(),
      });
      setActionMessage(t("playbooks.standupNotesSaved"));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("playbooks.standupNotesFailed"));
    }
  }, [
    manualBlockers,
    manualJiraAssignee,
    manualNote,
    manualTask,
    standup,
    standupAgentId,
  ]);

  return (
    <section className="flex h-full min-h-0 flex-col">
      <div className={HQ_PANEL_HEADER}>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className={HQ_PANEL_TITLE}>{t("playbooks.title")}</div>
            <div className={HQ_PANEL_LEAD}>{t("playbooks.subtitle")}</div>
          </div>
          <button
            type="button"
            onClick={() => void loadJobs()}
            disabled={!cronEnabled}
            className={HQ_BUTTON_SECONDARY}
          >
            {t("common.refresh")}
          </button>
        </div>
        {!cronEnabled ? (
          <div className={`mt-2 ${HQ_HINT}`}>{t("playbooks.unsupported")}</div>
        ) : null}
        {error ? <div className={`mt-2 ${HQ_NOTICE_ERROR}`}>{error}</div> : null}
        {actionMessage ? <div className={`mt-2 ${HQ_NOTICE_OK}`}>{actionMessage}</div> : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="border-b border-red-900/40 px-3 py-3">
          <div className={HQ_SECTION_TITLE}>{t("playbooks.activeJobs")}</div>
          <div className="mt-2.5 space-y-2">
            {loading ? (
              <div className={HQ_EMPTY}>{t("playbooks.loadingJobs")}</div>
            ) : jobs.length === 0 ? (
              <div className={HQ_EMPTY}>{t("playbooks.noJobs")}</div>
            ) : (
              jobs.map((job) => {
                const agentName = agentById.get(job.agentId ?? "")?.name || job.agentId || t("playbooks.unknown");
                return (
                  <div key={job.id} className={`${HQ_CARD} px-3 py-2.5`}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-white">
                          {job.name}
                        </div>
                        <div className="mt-0.5 truncate font-mono text-[11px] text-white/60">{agentName}</div>
                      </div>
                      <span
                        className={
                          job.state.lastStatus === "error"
                            ? HQ_BADGE_ERROR
                            : HQ_BADGE
                        }
                      >
                        {CRON_STATUS_LABELS[job.state.lastStatus ?? "ready"]()}
                      </span>
                    </div>

                    <div className="mt-2.5 space-y-1 font-mono text-[11px] leading-4 text-white/75">
                      <div className="text-white">{formatCronSchedule(job.schedule)}</div>
                      <div>{t("playbooks.nextRun", { when: formatRelativeDateTime(job.state.nextRunAtMs) })}</div>
                      <div className="text-white/55">
                        {t("playbooks.lastRun", { when: formatRelativeDateTime(job.state.lastRunAtMs) })}
                      </div>
                    </div>

                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => void handleRunNow(job.id)}
                        disabled={runBusyJobId === job.id || deleteBusyJobId === job.id}
                        className={HQ_BUTTON_SECONDARY}
                      >
                        {runBusyJobId === job.id ? t("playbooks.running") : t("playbooks.run")}
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDelete(job.id)}
                        disabled={deleteBusyJobId === job.id || runBusyJobId === job.id}
                        className={HQ_BUTTON_DANGER}
                      >
                        {deleteBusyJobId === job.id ? t("playbooks.deleting") : t("playbooks.delete")}
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        <div className="px-3 py-3">
          <div className={HQ_SECTION}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className={HQ_SECTION_TITLE}>{t("playbooks.standupTitle")}</div>
                <div className="mt-1 text-[11px] leading-4 text-white/55">
                  {t("playbooks.standupSubtitle")}
                </div>
              </div>
              <button
                type="button"
                onClick={() => void standup.startMeeting("manual")}
                className={HQ_BUTTON_PRIMARY}
              >
                {t("playbooks.startNow")}
              </button>
            </div>

            <div className="mt-3 grid gap-3">
              <label className="flex cursor-pointer items-start gap-2 text-[12px] leading-4 text-white/85">
                <input
                  type="checkbox"
                  className={`mt-px ${HQ_CHECKBOX}`}
                  checked={standupScheduleEnabled}
                  onChange={(event) => setStandupScheduleEnabled(event.target.checked)}
                />
                {t("playbooks.enableSchedule")}
              </label>

              <label className="flex flex-col gap-1.5">
                <span className={HQ_LABEL}>
                  {t("playbooks.cronExpression")}
                </span>
                <input
                  value={standupCronExpr}
                  onChange={(event) => setStandupCronExpr(event.target.value)}
                  className={HQ_FIELD}
                />
              </label>

              <label className="flex flex-col gap-1.5">
                <span className={HQ_LABEL}>
                  {t("playbooks.timezone")}
                </span>
                <input
                  value={standupTimezone}
                  onChange={(event) => setStandupTimezone(event.target.value)}
                  className={HQ_FIELD}
                />
              </label>

              <label className="flex flex-col gap-1.5">
                <span className={HQ_LABEL}>
                  {t("playbooks.secondsPerSpeaker")}
                </span>
                <input
                  value={standupSpeakerSeconds}
                  onChange={(event) => setStandupSpeakerSeconds(event.target.value)}
                  className={HQ_FIELD}
                />
              </label>

              <label className="flex cursor-pointer items-start gap-2 text-[12px] leading-4 text-white/85">
                <input
                  type="checkbox"
                  className={`mt-px ${HQ_CHECKBOX}`}
                  checked={standupAutoOpenBoard}
                  onChange={(event) => setStandupAutoOpenBoard(event.target.checked)}
                />
                {t("playbooks.autoOpenBoard")}
              </label>

              <label className="flex cursor-pointer items-start gap-2 text-[12px] leading-4 text-white/85">
                <input
                  type="checkbox"
                  className={`mt-px ${HQ_CHECKBOX}`}
                  checked={jiraEnabled}
                  onChange={(event) => setJiraEnabled(event.target.checked)}
                />
                {t("playbooks.enableJira")}
              </label>

              <label className="flex flex-col gap-1.5">
                <span className={HQ_LABEL}>
                  {t("playbooks.jiraBaseUrl")}
                </span>
                <input
                  value={jiraBaseUrl}
                  onChange={(event) => setJiraBaseUrl(event.target.value)}
                  placeholder="https://company.atlassian.net"
                  className={HQ_FIELD}
                />
              </label>

              <label className="flex flex-col gap-1.5">
                <span className={HQ_LABEL}>
                  {t("playbooks.jiraEmail")}
                </span>
                <input
                  value={jiraEmail}
                  onChange={(event) => setJiraEmail(event.target.value)}
                  className={HQ_FIELD}
                />
              </label>

              <label className="flex flex-col gap-1.5">
                <span className={HQ_LABEL}>
                  {t("playbooks.jiraToken")}
                </span>
                <input
                  type="password"
                  value={jiraApiToken}
                  onChange={(event) => {
                    setJiraApiToken(event.target.value);
                    setJiraApiTokenConfigured(event.target.value.trim().length > 0);
                  }}
                  placeholder={
                    jiraApiTokenConfigured ? t("playbooks.jiraTokenHint") : ""
                  }
                  className={HQ_FIELD}
                />
                {jiraApiTokenConfigured ? (
                  <span className={HQ_HINT}>{t("playbooks.jiraTokenStored")}</span>
                ) : null}
              </label>

              <label className="flex flex-col gap-1.5">
                <span className={HQ_LABEL}>
                  {t("playbooks.jiraProjectKey")}
                </span>
                <input
                  value={jiraProjectKey}
                  onChange={(event) => setJiraProjectKey(event.target.value)}
                  className={HQ_FIELD}
                />
              </label>

              <label className="flex flex-col gap-1.5">
                <span className={HQ_LABEL}>
                  {t("playbooks.jiraJql")}
                </span>
                <textarea
                  value={jiraJql}
                  onChange={(event) => setJiraJql(event.target.value)}
                  rows={3}
                  className={`${HQ_FIELD} resize-y`}
                />
              </label>

              <button
                type="button"
                onClick={() => void handleSaveStandupConfig()}
                disabled={standup.saving}
                className={`${HQ_BUTTON_SECONDARY} w-full`}
              >
                {standup.saving ? t("playbooks.savingStandup") : t("playbooks.saveStandup")}
              </button>
            </div>

            <div className="mt-4 border-t border-red-900/40 pt-4">
              <div className={HQ_SECTION_TITLE}>{t("playbooks.manualInput")}</div>
              <div className="mt-3 grid gap-3">
                <label className="flex flex-col gap-1.5">
                  <span className={HQ_LABEL}>
                    {t("playbooks.agent")}
                  </span>
                  <select
                    value={standupAgentId}
                    onChange={(event) => setStandupAgentId(event.target.value)}
                    className={HQ_SELECT}
                  >
                    <option value="">{t("playbooks.selectAgent")}</option>
                    {agents.map((agent) => (
                      <option key={agent.agentId} value={agent.agentId}>
                        {agent.name || agent.agentId}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="flex flex-col gap-1.5">
                  <span className={HQ_LABEL}>
                    {t("playbooks.jiraAssignee")}
                  </span>
                  <input
                    value={manualJiraAssignee}
                    onChange={(event) => setManualJiraAssignee(event.target.value)}
                    className={HQ_FIELD}
                  />
                </label>

                <label className="flex flex-col gap-1.5">
                  <span className={HQ_LABEL}>
                    {t("playbooks.currentTask")}
                  </span>
                  <input
                    value={manualTask}
                    onChange={(event) => setManualTask(event.target.value)}
                    className={HQ_FIELD_PROSE}
                  />
                </label>

                <label className="flex flex-col gap-1.5">
                  <span className={HQ_LABEL}>
                    {t("playbooks.blockers")}
                  </span>
                  <textarea
                    value={manualBlockers}
                    onChange={(event) => setManualBlockers(event.target.value)}
                    rows={3}
                    className={`${HQ_FIELD_PROSE} resize-y`}
                  />
                </label>

                <label className="flex flex-col gap-1.5">
                  <span className={HQ_LABEL}>
                    {t("playbooks.manualNote")}
                  </span>
                  <textarea
                    value={manualNote}
                    onChange={(event) => setManualNote(event.target.value)}
                    rows={4}
                    className={`${HQ_FIELD_PROSE} resize-y`}
                  />
                </label>

                <button
                  type="button"
                  onClick={() => void handleSaveManualNotes()}
                  className={`${HQ_BUTTON_SECONDARY} w-full`}
                >
                  {t("playbooks.saveNotes")}
                </button>
              </div>
            </div>

            {standup.meeting ? (
              <div className={`mt-4 space-y-1 px-3 py-2.5 font-mono text-[11px] leading-4 text-white/60 ${HQ_INSET}`}>
                <div>
                  {t("playbooks.meetingPhase")}{" "}
                  <span className="text-white">{standupPhaseLabel(standup.meeting.phase)}</span>
                </div>
                <div>
                  {t("playbooks.participants")}{" "}
                  <span className="tabular-nums text-white">{standup.meeting.participantOrder.length}</span>
                </div>
                <div>
                  {t("playbooks.currentSpeaker")}{" "}
                  <span className="text-white">
                    {standup.meeting.currentSpeakerAgentId
                      ? (agentById.get(standup.meeting.currentSpeakerAgentId)?.name ||
                        standup.meeting.currentSpeakerAgentId)
                      : t("playbooks.waiting")}
                  </span>
                </div>
              </div>
            ) : null}
          </div>

          <div className={`mt-5 ${HQ_SECTION_TITLE}`}>{t("playbooks.templates")}</div>
          <div className="mt-2.5 space-y-2">
            {PLAYBOOK_TEMPLATES.map((template) => {
              const isSelected = template.id === selectedTemplateId;
              return (
                <div
                  key={template.id}
                  className={`px-3 py-2.5 ${
                    isSelected
                      ? HQ_CARD_BUTTON_SELECTED
                      : `${HQ_CARD} transition-colors hover:border-red-500/50 hover:bg-red-950/40`
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedTemplateId((current) =>
                        current === template.id ? null : template.id
                      );
                      setError(null);
                      setActionMessage(null);
                    }}
                    aria-expanded={isSelected}
                    className="w-full rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/50"
                  >
                    <div className="font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-white">
                      {template.name}
                    </div>
                    <div className="mt-1 text-[11px] leading-4 text-white/60">
                      {template.description}
                    </div>
                  </button>

                  {isSelected ? (
                    <div className="mt-3 space-y-3 border-t border-red-900/40 pt-3">
                      <label className="flex flex-col gap-1.5">
                        <span className={HQ_LABEL}>
                          {t("playbooks.agent")}
                        </span>
                        <select
                          value={selectedAgentId}
                          onChange={(event) => setSelectedAgentId(event.target.value)}
                          className={HQ_SELECT}
                        >
                          <option value="">{t("playbooks.selectAgent")}</option>
                          {agents.map((agent) => (
                            <option key={agent.agentId} value={agent.agentId}>
                              {agent.name || agent.agentId}
                            </option>
                          ))}
                        </select>
                      </label>

                      <label className="flex flex-col gap-1.5">
                        <span className={HQ_LABEL}>
                          {t("playbooks.nameOverride")}
                        </span>
                        <input
                          value={nameOverride}
                          onChange={(event) => setNameOverride(event.target.value)}
                          placeholder={template.name}
                          className={HQ_FIELD}
                        />
                      </label>

                      <button
                        type="button"
                        onClick={() => void handleCreate()}
                        disabled={createBusy}
                        className={`${HQ_BUTTON_PRIMARY} w-full`}
                      >
                        {createBusy ? t("playbooks.creating") : t("playbooks.launch")}
                      </button>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
