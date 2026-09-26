"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useState } from "react";
import { RefreshCcw, Shuffle } from "lucide-react";
import {
  AGENT_AVATAR_CLOTHING_COLOR_OPTIONS,
  AGENT_AVATAR_HAIR_COLOR_OPTIONS,
  AGENT_AVATAR_HAIR_STYLE_OPTIONS,
  AGENT_AVATAR_HAT_STYLE_OPTIONS,
  AGENT_AVATAR_SKIN_TONE_OPTIONS,
  type AgentAvatarProfile,
  createDefaultAgentAvatarProfile,
} from "@/lib/avatars/profile";
import { AgentAvatar } from "@/features/agents/components/AgentAvatar";
import { AgentAvatarPreview3D } from "@/features/agents/components/AgentAvatarPreview3D";
import { PREVIEW_CLIPS, type PreviewClip } from "@/features/agents/components/avatarPreview/previewRig";
import {
  HQ_FORM_BUTTON_PRIMARY,
  HQ_FORM_BUTTON_SECONDARY,
  HQ_FORM_CHOICE,
  HQ_FORM_CHOICE_ACTIVE,
  HQ_FORM_LABEL,
  HQ_FORM_LEAD,
  HQ_FORM_SECTION,
  HQ_FORM_SECTION_TITLE,
} from "@/features/agents/components/hqFormStyles";
import { randomUUID } from "@/lib/uuid";
import { t, type TranslationKey } from "@/lib/i18n";

/**
 * The avatar tab: the agent as the HQ draws it, and its chat icon.
 *
 * The HQ gives every agent the same character (see AgentAvatarPreview3D), so
 * the 3D preview does not change with the profile. What the profile still
 * drives is the portrait in the chat and the agent lists
 * (lib/avatars/profilePortrait.ts): skin tone, hair, top colour, hat,
 * glasses and headset. Those stay editable, next to a live portrait. The
 * controls that only shaped the old block figure — top style, bottom style
 * and colour, shoe colour, backpack — are not shown; their values stay in
 * the saved profile untouched.
 */

export type AgentAvatarEditorPanelProps = {
  agentId: string;
  agentName: string;
  initialProfile: AgentAvatarProfile | null | undefined;
  onSave: (profile: AgentAvatarProfile) => Promise<void> | void;
  onDraftChange?: (profile: AgentAvatarProfile) => void;
  onCancel?: () => void;
  onSaved?: () => void;
  cancelLabel?: string;
  saveLabel?: string;
  showActions?: boolean;
};

export type AgentAvatarEditorPanelHandle = {
  save: () => Promise<void>;
};

const CLIP_LABELS: Record<PreviewClip, TranslationKey> = {
  Idle: "avatar.clipIdle",
  Talk: "avatar.clipTalk",
  Walk: "avatar.clipWalk",
};

const swatchClassName = (selected: boolean) =>
  `h-7 w-7 rounded-full border transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/60 ${
    selected
      ? "border-white ring-2 ring-red-500/80 ring-offset-2 ring-offset-[#0b0707]"
      : "border-white/15 hover:border-red-500/50"
  }`;

const choiceClassName = (selected: boolean) => (selected ? HQ_FORM_CHOICE_ACTIVE : HQ_FORM_CHOICE);

/** HUD brackets on the stage corners. */
const CORNERS = [
  "left-2 top-2 border-l border-t",
  "right-2 top-2 border-r border-t",
  "bottom-2 left-2 border-b border-l",
  "bottom-2 right-2 border-b border-r",
];

export const AgentAvatarEditorPanel = forwardRef<
  AgentAvatarEditorPanelHandle,
  AgentAvatarEditorPanelProps
>(function AgentAvatarEditorPanel(
  {
    agentId,
    agentName,
    initialProfile,
    onSave,
    onDraftChange,
    onCancel,
    onSaved,
    cancelLabel = t("avatar.cancel"),
    saveLabel = t("avatar.save"),
    showActions = true,
  }: AgentAvatarEditorPanelProps,
  ref
) {
  const fallbackProfile = useMemo(
    () => createDefaultAgentAvatarProfile(agentId),
    [agentId]
  );
  const resolvedInitialProfile = initialProfile ?? fallbackProfile;
  const [draft, setDraft] = useState<AgentAvatarProfile>(resolvedInitialProfile);
  const [saving, setSaving] = useState(false);
  // Preview only: which HQ clip the stage plays. Not part of the profile.
  const [clip, setClip] = useState<PreviewClip>("Idle");

  useEffect(() => {
    setDraft(resolvedInitialProfile);
  }, [resolvedInitialProfile]);

  useEffect(() => {
    onDraftChange?.(draft);
  }, [draft, onDraftChange]);

  const save = useCallback(async () => {
    if (saving) return;
    setSaving(true);
    try {
      await onSave(draft);
      onSaved?.();
    } finally {
      setSaving(false);
    }
  }, [draft, onSave, onSaved, saving]);

  useImperativeHandle(
    ref,
    () => ({
      save,
    }),
    [save]
  );

  return (
    <div className="grid h-full min-h-0 overflow-y-auto xl:grid-cols-[minmax(340px,440px)_minmax(0,1fr)] xl:overflow-hidden">
      <div className="flex flex-col border-b border-red-900/40 bg-[#050303] p-5 xl:min-h-0 xl:overflow-y-auto xl:border-b-0 xl:border-r">
        <div className={HQ_FORM_LABEL}>{t("avatar.creator")}</div>
        <div className="mt-1 truncate text-lg font-semibold text-white">{agentName}</div>
        <div className={`mt-1 ${HQ_FORM_LEAD}`}>{t("avatar.creatorLead")}</div>
        <div className="relative mt-4 overflow-hidden rounded-lg border border-red-900/50 shadow-[0_0_28px_rgba(255,26,26,0.08)]">
          <AgentAvatarPreview3D
            profile={draft}
            clip={clip}
            className="h-[clamp(300px,50vh,500px)] w-full"
          />
          {CORNERS.map((corner) => (
            <span
              key={corner}
              aria-hidden="true"
              className={`pointer-events-none absolute z-20 h-3 w-3 border-red-500/60 ${corner}`}
            />
          ))}
          <div className="pointer-events-none absolute bottom-3 left-5 z-20 font-mono text-[9px] uppercase tracking-[0.18em] text-white/50">
            {t("avatar.stageCaption", { clip: t(CLIP_LABELS[clip]) })}
          </div>
          <div className="pointer-events-none absolute bottom-3 right-5 z-20 font-mono text-[9px] uppercase tracking-[0.16em] text-white/45">
            {t("avatar.dragToRotate")}
          </div>
        </div>
        <div className="mt-4">
          <div className={HQ_FORM_LABEL}>{t("avatar.animation")}</div>
          <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label={t("avatar.animation")}>
            {PREVIEW_CLIPS.map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={clip === option}
                className={choiceClassName(clip === option)}
                onClick={() => setClip(option)}
              >
                {t(CLIP_LABELS[option])}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="p-5 xl:min-h-0 xl:overflow-y-auto">
        {showActions ? (
          <div className="mb-5 flex items-center justify-end gap-2 border-b border-red-900/40 pb-4">
            <button
              type="button"
              className={HQ_FORM_BUTTON_SECONDARY}
              onClick={onCancel}
              disabled={saving}
            >
              {cancelLabel}
            </button>
            <button
              type="button"
              className={HQ_FORM_BUTTON_PRIMARY}
              onClick={() => {
                void save();
              }}
              disabled={saving}
            >
              {saving ? t("avatar.saving") : saveLabel}
            </button>
          </div>
        ) : null}

        <section className={`${HQ_FORM_SECTION} space-y-2`}>
          <h3 className={HQ_FORM_SECTION_TITLE}>{t("avatar.hqLook")}</h3>
          <p className={HQ_FORM_LEAD}>{t("avatar.hqLookLead")}</p>
        </section>

        <section className={`${HQ_FORM_SECTION} mt-4`}>
          <div className="flex flex-wrap items-start gap-4">
            <div className="shrink-0 rounded-full ring-1 ring-red-500/40 ring-offset-2 ring-offset-[#0b0707]">
              <AgentAvatar seed={draft.seed} name={agentName} avatarProfile={draft} size={64} />
            </div>
            <div className="min-w-0 flex-1">
              <h3 className={HQ_FORM_SECTION_TITLE}>{t("avatar.chatIcon")}</h3>
              <p className={`mt-1 ${HQ_FORM_LEAD}`}>{t("avatar.chatIconLead")}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  className={HQ_FORM_BUTTON_SECONDARY}
                  onClick={() => setDraft(createDefaultAgentAvatarProfile(agentId))}
                  disabled={saving}
                >
                  <RefreshCcw className="h-3.5 w-3.5" aria-hidden="true" />
                  {t("avatar.reset")}
                </button>
                <button
                  type="button"
                  className={HQ_FORM_BUTTON_SECONDARY}
                  onClick={() => setDraft(createDefaultAgentAvatarProfile(randomUUID()))}
                  disabled={saving}
                >
                  <Shuffle className="h-3.5 w-3.5" aria-hidden="true" />
                  {t("avatar.randomize")}
                </button>
              </div>
            </div>
          </div>

          <div className="mt-5 grid gap-5 border-t border-red-900/30 pt-5 xl:grid-cols-2">
            <section className="space-y-2.5">
              <h4 className={HQ_FORM_LABEL}>{t("avatar.skinTone")}</h4>
              <div className="flex flex-wrap gap-2">
                {AGENT_AVATAR_SKIN_TONE_OPTIONS.map((option) => {
                  const selected = draft.body.skinTone === option.color;
                  return (
                    <button
                      key={option.id}
                      type="button"
                      aria-label={option.label}
                      aria-pressed={selected}
                      className={swatchClassName(selected)}
                      style={{ backgroundColor: option.color }}
                      onClick={() =>
                        setDraft((current) => ({
                          ...current,
                          body: { ...current.body, skinTone: option.color },
                        }))
                      }
                    />
                  );
                })}
              </div>
            </section>

            <section className="space-y-2.5">
              <h4 className={HQ_FORM_LABEL}>{t("avatar.hairStyle")}</h4>
              <div className="flex flex-wrap gap-2">
                {AGENT_AVATAR_HAIR_STYLE_OPTIONS.map((option) => {
                  const selected = draft.hair.style === option.id;
                  return (
                    <button
                      key={option.id}
                      type="button"
                      aria-pressed={selected}
                      className={choiceClassName(selected)}
                      onClick={() =>
                        setDraft((current) => ({
                          ...current,
                          hair: { ...current.hair, style: option.id },
                        }))
                      }
                    >
                      {option.label}
                    </button>
                  );
                })}
              </div>
            </section>

            <section className="space-y-2.5">
              <h4 className={HQ_FORM_LABEL}>{t("avatar.hairColor")}</h4>
              <div className="flex flex-wrap gap-2">
                {AGENT_AVATAR_HAIR_COLOR_OPTIONS.map((option) => {
                  const selected = draft.hair.color === option.color;
                  return (
                    <button
                      key={option.id}
                      type="button"
                      aria-label={option.label}
                      aria-pressed={selected}
                      className={swatchClassName(selected)}
                      style={{ backgroundColor: option.color }}
                      onClick={() =>
                        setDraft((current) => ({
                          ...current,
                          hair: { ...current.hair, color: option.color },
                        }))
                      }
                    />
                  );
                })}
              </div>
            </section>

            <section className="space-y-2.5">
              <h4 className={HQ_FORM_LABEL}>{t("avatar.topColor")}</h4>
              <div className="flex flex-wrap gap-2">
                {AGENT_AVATAR_CLOTHING_COLOR_OPTIONS.map((option) => {
                  const selected = draft.clothing.topColor === option.color;
                  return (
                    <button
                      key={`top-${option.id}`}
                      type="button"
                      aria-label={option.label}
                      aria-pressed={selected}
                      className={swatchClassName(selected)}
                      style={{ backgroundColor: option.color }}
                      onClick={() =>
                        setDraft((current) => ({
                          ...current,
                          clothing: { ...current.clothing, topColor: option.color },
                        }))
                      }
                    />
                  );
                })}
              </div>
            </section>

            <section className="space-y-2.5">
              <h4 className={HQ_FORM_LABEL}>{t("avatar.hat")}</h4>
              <div className="flex flex-wrap gap-2">
                {AGENT_AVATAR_HAT_STYLE_OPTIONS.map((option) => {
                  const selected = draft.accessories.hatStyle === option.id;
                  return (
                    <button
                      key={option.id}
                      type="button"
                      aria-pressed={selected}
                      className={choiceClassName(selected)}
                      onClick={() =>
                        setDraft((current) => ({
                          ...current,
                          accessories: { ...current.accessories, hatStyle: option.id },
                        }))
                      }
                    >
                      {option.label}
                    </button>
                  );
                })}
              </div>
            </section>

            <section className="space-y-2.5">
              <h4 className={HQ_FORM_LABEL}>{t("avatar.accessories")}</h4>
              <div className="flex flex-wrap gap-2">
                {[
                  {
                    key: "glasses" as const,
                    label: t("avatar.glasses"),
                    enabled: draft.accessories.glasses,
                  },
                  {
                    key: "headset" as const,
                    label: t("avatar.headset"),
                    enabled: draft.accessories.headset,
                  },
                ].map((option) => (
                  <button
                    key={option.key}
                    type="button"
                    aria-pressed={option.enabled}
                    className={choiceClassName(option.enabled)}
                    onClick={() =>
                      setDraft((current) => ({
                        ...current,
                        accessories: {
                          ...current.accessories,
                          [option.key]: !current.accessories[option.key],
                        },
                      }))
                    }
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </section>
          </div>
        </section>
      </div>
    </div>
  );
});
