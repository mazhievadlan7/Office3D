"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GitBranch, Plus, Sparkles, Trash2, Wand2, X } from "lucide-react";
import { AgentAvatarPreview3D } from "@/features/agents/components/AgentAvatarPreview3D";
import { RunningAvatarLoader } from "@/features/agents/components/RunningAvatarLoader";
import { createDefaultAgentAvatarProfile } from "@/lib/avatars/profile";
import type {
  CompanyBuilderInput,
  CompanyBuilderPlan,
  CompanyBuilderRole,
} from "@/features/company-builder/types";
import { plural, t } from "@/lib/i18n";

type CompanyBuilderModalProps = {
  open: boolean;
  connected: boolean;
  agentCount: number;
  plannerAgentName: string | null;
  busy?: boolean;
  error?: string | null;
  statusLine?: string | null;
  initialInput?: CompanyBuilderInput;
  initialPlan?: CompanyBuilderPlan | null;
  onClose: () => void;
  onClear: () => void;
  onImproveBrief: (brief: string) => Promise<string>;
  onGeneratePlan: (brief: string) => Promise<CompanyBuilderPlan>;
  onCreateCompany: (params: {
    input: CompanyBuilderInput;
    plan: CompanyBuilderPlan;
  }) => Promise<void>;
};

// HQ field look: black glass, a red-tinted edge that lights up on focus.
const inputClassName =
  "w-full rounded-md border border-red-900/50 bg-black/60 px-3 py-2 font-sans text-sm normal-case tracking-normal text-white outline-none transition placeholder:text-white/35 focus:border-red-500/70 focus:ring-1 focus:ring-red-500/30";
const textareaClassName =
  "min-h-[120px] w-full rounded-md border border-red-900/50 bg-black/60 px-3 py-2 font-sans text-sm normal-case tracking-normal text-white outline-none transition placeholder:text-white/35 focus:border-red-500/70 focus:ring-1 focus:ring-red-500/30";

const createEmptyRole = (index: number): CompanyBuilderRole => ({
  id: `custom-role-${index + 1}`,
  title: "",
  purpose: "",
  soul: "",
  responsibilities: [],
  collaborators: [],
  tools: [],
  heartbeat: [],
  emoji: "🤖",
  creature: "specialist",
  vibe: t("company.defaultVibe"),
  userContext: "",
  commandMode: "ask",
});

const parseCommaList = (value: string) =>
  value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

const joinCommaList = (values: string[]) => values.join(", ");

const buildRoleAvatarProfile = (role: CompanyBuilderRole) =>
  createDefaultAgentAvatarProfile(
    [
      role.id,
      role.title,
      role.emoji,
      role.creature,
      role.vibe,
      role.commandMode,
    ]
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .join(":") || "company-role"
  );

const renderRoleFacts = (label: string, values: string[]) => {
  if (values.length === 0) return null;
  return (
    <div className="space-y-1">
      <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-red-400">
        {label}
      </p>
      <div className="text-xs leading-5 text-white/75">{values.join(", ")}</div>
    </div>
  );
};

export function CompanyBuilderModal({
  open,
  connected,
  agentCount,
  plannerAgentName,
  busy = false,
  error = null,
  statusLine = null,
  initialInput,
  initialPlan,
  onClose,
  onClear,
  onImproveBrief,
  onGeneratePlan,
  onCreateCompany,
}: CompanyBuilderModalProps) {
  const [input, setInput] = useState<CompanyBuilderInput>({
    businessDescription: initialInput?.businessDescription ?? "",
    improvedBrief: initialInput?.improvedBrief ?? "",
  });
  const [plan, setPlan] = useState<CompanyBuilderPlan | null>(initialPlan ?? null);
  const [promptModalOpen, setPromptModalOpen] = useState(
    () =>
      !(
        (initialInput?.businessDescription ?? "").trim() ||
        (initialInput?.improvedBrief ?? "").trim()
      )
  );
  const [promptDraft, setPromptDraft] = useState(initialInput?.businessDescription ?? "");
  const [replaceConfirmOpen, setReplaceConfirmOpen] = useState(false);
  const [orgChartOpen, setOrgChartOpen] = useState(false);
  const [hoveredOrgRoleId, setHoveredOrgRoleId] = useState<string | null>(null);
  const roleListContainerRef = useRef<HTMLElement | null>(null);
  const pendingRoleScrollRef = useRef(false);

  const effectiveBrief = useMemo(
    () => input.improvedBrief.trim() || input.businessDescription.trim(),
    [input.businessDescription, input.improvedBrief]
  );
  const canUseAi = connected && agentCount > 0;
  const canGenerate = canUseAi && effectiveBrief.length > 0 && !busy;
  const canPreviewChart = Boolean(plan && plan.roles.length > 0);
  const canCreate = Boolean(connected && plan && plan.roles.length > 0 && !busy);
  const canClear = Boolean(
    !busy &&
      (input.businessDescription.trim() ||
        input.improvedBrief.trim() ||
        promptDraft.trim() ||
        plan?.roles.length)
  );
  const replacesExistingAgents = agentCount > 0;

  useEffect(() => {
    if (!plan || !pendingRoleScrollRef.current) return;
    pendingRoleScrollRef.current = false;
    requestAnimationFrame(() => {
      roleListContainerRef.current?.scrollTo({
        top: roleListContainerRef.current.scrollHeight,
        behavior: "smooth",
      });
    });
  }, [plan]);

  const fireAutoGenerate = useCallback(
    (brief: string) => {
      void onGeneratePlan(brief)
        .then((nextPlan) => {
          setPlan(nextPlan);
        })
        .catch((error) => {
          console.error("Failed to auto-generate company plan.", error);
        });
    },
    [onGeneratePlan],
  );

  const orgChartDefaultRoleId = orgChartOpen && plan?.roles.length
    ? plan.roles[0]?.id ?? null
    : null;
  const resolvedHoveredOrgRoleId =
    hoveredOrgRoleId && plan?.roles.some((role) => role.id === hoveredOrgRoleId)
      ? hoveredOrgRoleId
      : orgChartDefaultRoleId;

  const triggerCreateCompany = () => {
    if (!plan) return;
    void onCreateCompany({ input, plan }).catch((error) => {
      console.error("Failed to create company.", error);
    });
  };

  if (!open) return null;

  const hoveredOrgRole =
    plan?.roles.find((role) => role.id === resolvedHoveredOrgRoleId) ?? plan?.roles[0] ?? null;

  return (
    <div className="fixed inset-0 z-[100100] flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
      <div className="flex h-[min(92vh,920px)] w-full max-w-6xl flex-col overflow-hidden rounded-xl border border-red-600/35 bg-[#070404]/95 text-white shadow-[0_0_48px_rgba(255,26,26,0.12)]">
        <div className="flex items-center justify-between border-b border-red-900/40 bg-gradient-to-r from-red-950/30 via-transparent to-transparent px-6 py-4">
          <div>
            <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.16em] text-red-400">
              <Sparkles className="h-4 w-4" aria-hidden="true" />{t("company.title")}</div>
            <h2 className="mt-1 text-lg font-semibold">{t("company.heading")}</h2>
            <p className="mt-1 text-sm text-white/55">
              {plannerAgentName
                ? t("company.usesRuntimeVia", { name: plannerAgentName })
                : t("company.usesRuntime")}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="inline-flex items-center justify-center gap-2 rounded-md px-3 py-2 text-xs font-semibold border border-red-500/50 bg-red-950/40 text-red-300 transition hover:border-red-400/70 hover:bg-red-900/40 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
              onClick={() => {
                setInput({ businessDescription: "", improvedBrief: "" });
                setPromptDraft("");
                setPlan(null);
                setPromptModalOpen(true);
                setReplaceConfirmOpen(false);
                onClear();
              }}
              disabled={!canClear}
            >{t("company.clear")}</button>
            <button
              type="button"
              className="inline-flex items-center justify-center gap-2 rounded-md px-3 py-2 text-xs font-semibold border border-red-500/50 bg-red-600/20 text-white transition hover:border-red-500/70 hover:bg-red-600/30 disabled:cursor-not-allowed disabled:opacity-40"
              onClick={() => {
                void onGeneratePlan(effectiveBrief)
                  .then((nextPlan) => {
                    setPlan(nextPlan);
                  })
                  .catch(() => {});
              }}
              disabled={!canGenerate}
            >
              <Sparkles className="h-3.5 w-3.5" />{t("company.generate")}</button>
            <button
              type="button"
              className="inline-flex items-center justify-center gap-2 rounded-md px-3 py-2 text-xs font-semibold border border-red-900/40 bg-black/40 text-white/85 transition hover:border-red-500/50 hover:bg-red-950/40 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
              onClick={() => {
                setOrgChartOpen(true);
              }}
              disabled={!canPreviewChart}
            >
              <GitBranch className="h-3.5 w-3.5" />{t("company.orgChart")}</button>
            <button
              type="button"
              className="inline-flex items-center justify-center gap-2 rounded-md px-3 py-2 text-xs font-semibold border border-red-500/60 bg-[#e3141c] text-white shadow-[0_0_14px_rgba(255,26,26,0.25)] transition hover:border-red-400/70 hover:bg-[#ff2a2a] disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
              onClick={() => {
                if (!plan) return;
                if (replacesExistingAgents) {
                  setReplaceConfirmOpen(true);
                  return;
                }
                triggerCreateCompany();
              }}
              disabled={!canCreate}
            >
              <Wand2 className="h-3.5 w-3.5" />{t("company.create")}</button>
            <button
              type="button"
              className="rounded-md border border-red-900/40 bg-black/40 p-2 text-white/70 transition hover:border-red-500/50 hover:bg-red-950/40 hover:text-white"
              onClick={onClose}
              disabled={busy}
              aria-label={t("company.close")}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="grid min-h-0 flex-1 gap-0 lg:grid-cols-[360px_minmax(0,1fr)]">
          <section className="overflow-y-auto border-b border-red-900/40 px-6 py-5 lg:border-b-0 lg:border-r">
            <div className="space-y-5">
              <div className="rounded-lg border border-red-900/40 bg-[#0b0707] p-4">
                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-white/55">{t("company.sourcePrompt")}</p>
                    <button
                      type="button"
                      className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11px] font-semibold border border-red-500/50 bg-red-600/20 text-white transition hover:border-red-500/70 hover:bg-red-600/30 disabled:cursor-not-allowed disabled:opacity-40"
                      onClick={() => {
                        setPromptDraft(input.businessDescription);
                        setPromptModalOpen(true);
                      }}
                      disabled={busy}
                    >
                      <Wand2 className="h-3 w-3" />
                      {input.businessDescription.trim() ? t("company.editPrompt") : t("company.describe")}
                    </button>
                  </div>
                  <div className="text-sm leading-6 text-white/70">
                    {input.businessDescription.trim()
                      ? input.businessDescription
                      : t("company.describePlaceholder")}
                  </div>
                </div>
              </div>

              <div className="rounded-lg border border-red-900/40 bg-[#0b0707] p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-white/55">{t("company.improvedBrief")}</p>
                    <p className="mt-1 text-[11px] text-white/45">{t("company.improvedBriefLead")}</p>
                  </div>
                </div>
                <textarea
                  className={`${textareaClassName} mt-3 min-h-[340px]`}
                  placeholder={t("company.briefPh")}
                  value={input.improvedBrief}
                  onChange={(event) =>
                    setInput((current) => ({
                      ...current,
                      improvedBrief: event.target.value,
                    }))
                  }
                  disabled={busy}
                />
              </div>

              <div className="space-y-3 rounded-lg border border-red-900/40 bg-[#0b0707] p-4">
                <div>
                  <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-white/55">{t("company.actions")}</p>
                  <p className="mt-1 text-[11px] text-white/45">{t("company.actionsLead")}</p>
                </div>
                {replacesExistingAgents ? (
                  <div className="rounded-md border border-orange-400/25 bg-orange-500/[0.07] px-3 py-2 text-xs leading-5 text-orange-300">
                    {t("company.replaceNotice", { count: agentCount })}
                  </div>
                ) : null}
                {!canUseAi ? (
                  <p className="text-xs text-orange-300/85">
                    {t("company.needRuntime")}
                  </p>
                ) : null}
                {statusLine ? <p className="text-xs text-red-300">{statusLine}</p> : null}
                {error ? <p className="rounded-md border border-red-500/50 bg-red-950/40 px-3 py-2 text-xs text-red-400">{error}</p> : null}
              </div>
            </div>
          </section>

          <section ref={roleListContainerRef} className="min-h-0 overflow-y-auto px-6 py-5">
            {plan ? (
              <div className="space-y-5">
                <div className="grid gap-4 md:grid-cols-2">
                  <label className="flex flex-col gap-2 font-mono text-[10px] uppercase tracking-[0.16em] text-white/45">{t("company.name")}<input
                      className={inputClassName}
                      value={plan.companyName}
                      onChange={(event) =>
                        setPlan((current) =>
                          current
                            ? {
                                ...current,
                                companyName: event.target.value,
                              }
                            : current
                        )
                      }
                      disabled={busy}
                    />
                  </label>
                  <label className="flex flex-col gap-2 font-mono text-[10px] uppercase tracking-[0.16em] text-white/45">{t("company.sharedRules")}<input
                      className={inputClassName}
                      value={joinCommaList(plan.sharedRules)}
                      onChange={(event) =>
                        setPlan((current) =>
                          current
                            ? {
                                ...current,
                                sharedRules: parseCommaList(event.target.value),
                              }
                            : current
                        )
                      }
                      disabled={busy}
                    />
                  </label>
                </div>

                <label className="flex flex-col gap-2 font-mono text-[10px] uppercase tracking-[0.16em] text-white/45">{t("company.summary")}<textarea
                    className={`${textareaClassName} min-h-[110px]`}
                    value={plan.summary}
                    onChange={(event) =>
                      setPlan((current) =>
                        current
                          ? {
                              ...current,
                              summary: event.target.value,
                            }
                          : current
                      )
                    }
                    disabled={busy}
                  />
                </label>

                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-white">{t("company.orgStructure")}</p>
                    <p className="text-xs text-white/55">{t("company.editTeam")}</p>
                  </div>
                  <button
                    type="button"
                    className="inline-flex items-center gap-2 rounded-md px-3 py-2 text-xs font-semibold border border-red-900/40 bg-black/40 text-white/85 transition hover:border-red-500/50 hover:bg-red-950/40 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                    onClick={() => {
                      pendingRoleScrollRef.current = true;
                      setPlan((current) =>
                        current
                          ? {
                              ...current,
                              roles: [...current.roles, createEmptyRole(current.roles.length)],
                            }
                          : current
                      );
                    }}
                    disabled={busy}
                  >
                    <Plus className="h-3.5 w-3.5" />{t("company.addRole")}</button>
                </div>

                <div className="space-y-4">
                  {plan.roles.map((role, index) => (
                    <div
                      key={role.id || `role-${index}`}
                      className="rounded-lg border border-red-900/40 bg-[#0b0707] p-4 transition-colors hover:border-red-600/35"
                    >
                      <div className="mb-4 flex items-start justify-between gap-4">
                        <div className="flex min-w-0 items-start gap-4">
                          <div className="h-28 w-24 overflow-hidden rounded-md border border-red-900/40 bg-gradient-to-b from-[#140909] to-black">
                            <AgentAvatarPreview3D
                              profile={buildRoleAvatarProfile(role)}
                              className="h-full w-full"
                            />
                          </div>
                          <div className="min-w-0">
                            <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-red-400">
                              {t("company.role")} {index + 1}
                            </div>
                            <div className="mt-2 text-sm font-semibold text-white">
                              {role.title || t("company.untitledRole")}
                            </div>
                            <div className="mt-1 text-xs text-white/45">
                              {t("company.avatarPreview")}
                            </div>
                          </div>
                        </div>
                        <button
                          type="button"
                          className="rounded-md p-2 border border-red-500/50 bg-red-950/40 text-red-300 transition hover:border-red-400/70 hover:bg-red-900/40 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                          onClick={() =>
                            setPlan((current) =>
                              current
                                ? {
                                    ...current,
                                    roles: current.roles.filter((_, roleIndex) => roleIndex !== index),
                                  }
                                : current
                            )
                          }
                          disabled={busy || plan.roles.length <= 1}
                          aria-label={t("company.removeRole", { index: index + 1 })}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>

                      <div className="grid gap-4 md:grid-cols-2">
                        <label className="flex flex-col gap-2 font-mono text-[10px] uppercase tracking-[0.16em] text-white/45">{t("company.fieldName")}<input
                            className={inputClassName}
                            value={role.title}
                            onChange={(event) =>
                              setPlan((current) =>
                                current
                                  ? {
                                      ...current,
                                      roles: current.roles.map((entry, roleIndex) =>
                                        roleIndex === index
                                          ? { ...entry, title: event.target.value }
                                          : entry
                                      ),
                                    }
                                  : current
                              )
                            }
                            disabled={busy}
                          />
                        </label>
                        <label className="flex flex-col gap-2 font-mono text-[10px] uppercase tracking-[0.16em] text-white/45">{t("company.emoji")}<input
                            className={inputClassName}
                            value={role.emoji}
                            onChange={(event) =>
                              setPlan((current) =>
                                current
                                  ? {
                                      ...current,
                                      roles: current.roles.map((entry, roleIndex) =>
                                        roleIndex === index
                                          ? { ...entry, emoji: event.target.value }
                                          : entry
                                      ),
                                    }
                                  : current
                              )
                            }
                            disabled={busy}
                          />
                        </label>
                      </div>

                      <div className="mt-4 grid gap-4 md:grid-cols-2">
                        <label className="flex flex-col gap-2 font-mono text-[10px] uppercase tracking-[0.16em] text-white/45">{t("company.purpose")}<textarea
                            className={textareaClassName}
                            value={role.purpose}
                            onChange={(event) =>
                              setPlan((current) =>
                                current
                                  ? {
                                      ...current,
                                      roles: current.roles.map((entry, roleIndex) =>
                                        roleIndex === index
                                          ? { ...entry, purpose: event.target.value }
                                          : entry
                                      ),
                                    }
                                  : current
                              )
                            }
                            disabled={busy}
                          />
                        </label>
                        <label className="flex flex-col gap-2 font-mono text-[10px] uppercase tracking-[0.16em] text-white/45">{t("company.soul")}<textarea
                            className={textareaClassName}
                            value={role.soul}
                            onChange={(event) =>
                              setPlan((current) =>
                                current
                                  ? {
                                      ...current,
                                      roles: current.roles.map((entry, roleIndex) =>
                                        roleIndex === index
                                          ? { ...entry, soul: event.target.value }
                                          : entry
                                      ),
                                    }
                                  : current
                              )
                            }
                            disabled={busy}
                          />
                        </label>
                      </div>

                      <div className="mt-4 grid gap-4 md:grid-cols-2">
                        <label className="flex flex-col gap-2 font-mono text-[10px] uppercase tracking-[0.16em] text-white/45">{t("company.responsibilities")}<input
                            className={inputClassName}
                            value={joinCommaList(role.responsibilities)}
                            onChange={(event) =>
                              setPlan((current) =>
                                current
                                  ? {
                                      ...current,
                                      roles: current.roles.map((entry, roleIndex) =>
                                        roleIndex === index
                                          ? {
                                              ...entry,
                                              responsibilities: parseCommaList(event.target.value),
                                            }
                                          : entry
                                      ),
                                    }
                                  : current
                              )
                            }
                            disabled={busy}
                          />
                        </label>
                        <label className="flex flex-col gap-2 font-mono text-[10px] uppercase tracking-[0.16em] text-white/45">{t("company.collaborators")}<input
                            className={inputClassName}
                            value={joinCommaList(role.collaborators)}
                            onChange={(event) =>
                              setPlan((current) =>
                                current
                                  ? {
                                      ...current,
                                      roles: current.roles.map((entry, roleIndex) =>
                                        roleIndex === index
                                          ? {
                                              ...entry,
                                              collaborators: parseCommaList(event.target.value),
                                            }
                                          : entry
                                      ),
                                    }
                                  : current
                              )
                            }
                            disabled={busy}
                          />
                        </label>
                        <label className="flex flex-col gap-2 font-mono text-[10px] uppercase tracking-[0.16em] text-white/45">{t("company.toolNotes")}<input
                            className={inputClassName}
                            value={joinCommaList(role.tools)}
                            onChange={(event) =>
                              setPlan((current) =>
                                current
                                  ? {
                                      ...current,
                                      roles: current.roles.map((entry, roleIndex) =>
                                        roleIndex === index
                                          ? { ...entry, tools: parseCommaList(event.target.value) }
                                          : entry
                                      ),
                                    }
                                  : current
                              )
                            }
                            disabled={busy}
                          />
                        </label>
                        <label className="flex flex-col gap-2 font-mono text-[10px] uppercase tracking-[0.16em] text-white/45">{t("company.heartbeatChecklist")}<input
                            className={inputClassName}
                            value={joinCommaList(role.heartbeat)}
                            onChange={(event) =>
                              setPlan((current) =>
                                current
                                  ? {
                                      ...current,
                                      roles: current.roles.map((entry, roleIndex) =>
                                        roleIndex === index
                                          ? { ...entry, heartbeat: parseCommaList(event.target.value) }
                                          : entry
                                      ),
                                    }
                                  : current
                              )
                            }
                            disabled={busy}
                          />
                        </label>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-red-900/50 bg-[#0b0707]/60 p-8 text-center">
                <div className="max-w-md space-y-3">
                  <Sparkles className="mx-auto h-8 w-8 text-red-500" aria-hidden="true" />
                  <p className="text-lg font-semibold text-white">{t("company.noneYet")}</p>
                  <p className="text-sm text-white/55">
                    {t("company.emptyLead")}
                  </p>
                </div>
              </div>
            )}
          </section>
        </div>
      </div>
      {busy ? (
        <div className="fixed inset-0 z-[100120] flex items-center justify-center bg-black/80 backdrop-blur-md">
          <div className="w-full max-w-md rounded-xl border border-red-600/35 bg-[#070404] px-6 py-6 text-center shadow-[0_0_48px_rgba(255,26,26,0.15)]">
            <RunningAvatarLoader size={40} trackWidth={104} />
            <p className="mt-4 text-sm font-semibold text-white">
              {statusLine?.trim() || t("company.working")}
            </p>
            <p className="mt-2 text-xs leading-5 text-white/55">{t("company.waitNote")}</p>
            <div className="mt-5 flex gap-2">
              {Array.from({ length: 4 }, (_, index) => (
                <span
                  key={`company-loading-${index}`}
                  className="h-1.5 flex-1 rounded-full bg-red-500/45 animate-pulse"
                  style={{ animationDelay: `${index * 120}ms` }}
                />
              ))}
            </div>
          </div>
        </div>
      ) : null}
      {replaceConfirmOpen ? (
        <div className="fixed inset-0 z-[100115] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
          <div className="w-full max-w-lg rounded-xl border border-red-600/35 bg-[#070404] p-6 shadow-[0_0_48px_rgba(255,26,26,0.12)]">
            <div className="space-y-2">
              <p className="text-sm font-semibold text-white">{t("company.replaceTitle")}</p>
              <p className="text-sm leading-6 text-white/65">
                {t("company.replaceWarning", {
                  agents: `${agentCount} ${plural(agentCount, ["агент", "агента", "агентов"])}`,
                })}
              </p>
            </div>
            <div className="mt-6 flex items-center justify-end gap-3">
              <button
                type="button"
                className="rounded-md px-4 py-2 text-sm font-semibold border border-red-900/40 bg-black/40 text-white/85 transition hover:border-red-500/50 hover:bg-red-950/40 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                onClick={() => {
                  setReplaceConfirmOpen(false);
                }}
                disabled={busy}
              >{t("company.cancel")}</button>
              <button
                type="button"
                className="rounded-md px-4 py-2 text-sm font-semibold border border-red-500/60 bg-[#e3141c] text-white shadow-[0_0_14px_rgba(255,26,26,0.25)] transition hover:border-red-400/70 hover:bg-[#ff2a2a] disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
                onClick={() => {
                  setReplaceConfirmOpen(false);
                  triggerCreateCompany();
                }}
                disabled={busy}
              >{t("company.create")}</button>
            </div>
          </div>
        </div>
      ) : null}
      {orgChartOpen && plan ? (
        <div className="fixed inset-0 z-[100112] flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
          <div className="flex h-[min(88vh,860px)] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-red-600/35 bg-[#070404] shadow-[0_0_48px_rgba(255,26,26,0.12)]">
            <div className="flex items-center justify-between border-b border-red-900/40 px-6 py-4">
              <div>
                <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-red-400">{t("company.previewTitle")}</p>
                <p className="mt-2 text-sm text-white/60">{t("company.previewLead")}</p>
              </div>
              <button
                type="button"
                className="rounded-md border border-red-900/40 bg-black/40 p-2 text-white/70 transition hover:border-red-500/50 hover:bg-red-950/40 hover:text-white"
                onClick={() => {
                  setOrgChartOpen(false);
                }}
                disabled={busy}
                aria-label={t("company.closePreview")}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
              <div className="mx-auto grid max-w-5xl gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
                <div className="flex min-h-0 flex-col items-center">
                  <button
                    type="button"
                    className={`flex w-full max-w-xs flex-col items-center rounded-lg border px-5 py-5 text-center transition ${
                      resolvedHoveredOrgRoleId === plan.roles[0]?.id
                        ? "border-red-500/60 bg-red-600/20 shadow-[0_0_14px_rgba(255,26,26,0.25)]"
                        : "border-red-600/35 bg-red-600/10 hover:border-red-500/50"
                    }`}
                    onMouseEnter={() => {
                      setHoveredOrgRoleId(plan.roles[0]?.id ?? null);
                    }}
                    onFocus={() => {
                      setHoveredOrgRoleId(plan.roles[0]?.id ?? null);
                    }}
                  >
                    <div className="h-28 w-24 overflow-hidden rounded-md border border-red-900/40 bg-gradient-to-b from-[#140909] to-black">
                      <AgentAvatarPreview3D
                        profile={buildRoleAvatarProfile(plan.roles[0])}
                        className="h-full w-full"
                      />
                    </div>
                    <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.16em] text-red-400">{t("company.role1")}</p>
                    <p className="mt-1 text-lg font-semibold text-white">
                      {plan.roles[0].title || t("company.untitledRole")}
                    </p>
                    <p className="mt-1 text-sm text-white/60">
                      {plan.roles[0].purpose || t("company.noPurpose")}
                    </p>
                  </button>
                  {plan.roles.length > 1 ? (
                    <>
                      <div className="h-10 w-px bg-red-600/40" />
                      <div className="mb-8 h-px w-[min(100%,720px)] bg-red-600/40" />
                      <div className="grid w-full max-w-4xl gap-5 md:grid-cols-2 xl:grid-cols-3">
                        {plan.roles.slice(1).map((role, index) => (
                          <button
                            key={role.id || `org-chart-role-${index + 2}`}
                            type="button"
                            className={`flex flex-col items-center rounded-lg border px-4 py-5 text-center transition ${
                              resolvedHoveredOrgRoleId === role.id
                                ? "border-red-500/60 bg-red-600/15"
                                : "border-red-900/40 bg-[#0b0707] hover:border-red-500/50 hover:bg-red-950/40"
                            }`}
                            onMouseEnter={() => {
                              setHoveredOrgRoleId(role.id);
                            }}
                            onFocus={() => {
                              setHoveredOrgRoleId(role.id);
                            }}
                          >
                            <div className="h-24 w-20 overflow-hidden rounded-md border border-red-900/40 bg-gradient-to-b from-[#140909] to-black">
                              <AgentAvatarPreview3D
                                profile={buildRoleAvatarProfile(role)}
                                className="h-full w-full"
                              />
                            </div>
                            <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.16em] text-white/45">
                              {t("company.roleN", { index: index + 2 })}
                            </p>
                            <p className="mt-1 text-base font-semibold text-white">
                              {role.title || t("company.untitledRole")}
                            </p>
                            <p className="mt-1 text-sm text-white/60">
                              {role.purpose || t("company.noPurpose")}
                            </p>
                          </button>
                        ))}
                      </div>
                    </>
                  ) : null}
                </div>
                <aside className="rounded-lg border border-red-900/40 bg-[#0b0707] p-5 lg:sticky lg:top-0 lg:h-fit">
                  {hoveredOrgRole ? (
                    <div className="space-y-4">
                      <div>
                        <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-red-400">{t("company.activeRole")}</p>
                        <p className="mt-2 text-xl font-semibold text-white">
                          {hoveredOrgRole.title || t("company.untitledRole")}
                        </p>
                        <p className="mt-2 text-sm leading-6 text-white/70">
                          {hoveredOrgRole.soul || t("company.noSoul")}
                        </p>
                      </div>
                      <div className="rounded-md border border-red-900/40 bg-black/40 px-4 py-3">
                        <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-red-400">{t("company.purpose")}</p>
                        <p className="mt-2 text-sm leading-6 text-white/75">
                          {hoveredOrgRole.purpose || t("company.noPurpose")}
                        </p>
                      </div>
                      {renderRoleFacts(t("company.responsibilities"), hoveredOrgRole.responsibilities)}
                      {renderRoleFacts(t("company.collaborators"), hoveredOrgRole.collaborators)}
                      {renderRoleFacts(t("company.tools"), hoveredOrgRole.tools)}
                      {renderRoleFacts(t("company.heartbeat"), hoveredOrgRole.heartbeat)}
                    </div>
                  ) : (
                    <p className="text-sm text-white/55">{t("company.hoverRole")}</p>
                  )}
                </aside>
              </div>
            </div>
          </div>
        </div>
      ) : null}
      {promptModalOpen ? (
        <div className="fixed inset-0 z-[100110] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
          <div className="w-full max-w-2xl rounded-xl border border-red-600/35 bg-[#070404] p-6 shadow-[0_0_48px_rgba(255,26,26,0.12)]">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-red-400">{t("company.promptTitle")}</p>
                <p className="mt-2 text-sm text-white/55">
                  {t("company.submitNote")}
                </p>
              </div>
              <button
                type="button"
                className="rounded-md border border-red-900/40 bg-black/40 p-2 text-white/70 transition hover:border-red-500/50 hover:bg-red-950/40 hover:text-white"
                onClick={() => {
                  if (busy) return;
                  setPromptModalOpen(false);
                }}
                disabled={busy}
                aria-label={t("company.closePrompt")}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <textarea
              className={`${textareaClassName} mt-5 min-h-[220px]`}
              placeholder={t("company.promptPh")}
              value={promptDraft}
              onChange={(event) => {
                setPromptDraft(event.target.value);
              }}
              disabled={busy}
            />
            <div className="mt-5 flex items-center justify-between gap-3">
              <div>
                <p className="text-xs text-white/45">{t("company.promptNote")}</p>
                {error ? <p className="mt-2 text-xs text-red-400">{error}</p> : null}
              </div>
              <button
                type="button"
                className="inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-semibold border border-red-500/60 bg-[#e3141c] text-white shadow-[0_0_14px_rgba(255,26,26,0.25)] transition hover:border-red-400/70 hover:bg-[#ff2a2a] disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
                onClick={() => {
                  const trimmedPrompt = promptDraft.trim();
                  if (!trimmedPrompt) return;
                  void (async () => {
                    try {
                      const improvedBrief = await onImproveBrief(trimmedPrompt);
                      setInput({
                        businessDescription: trimmedPrompt,
                        improvedBrief,
                      });
                      setPromptModalOpen(false);
                      fireAutoGenerate(improvedBrief);
                    } catch {}
                  })();
                }}
                disabled={!canUseAi || promptDraft.trim().length === 0 || busy}
              >
                <Sparkles className="h-4 w-4" />{t("company.generateCompany")}</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
