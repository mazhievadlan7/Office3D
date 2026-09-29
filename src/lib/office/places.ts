
import { t } from "@/lib/i18n";
export const OFFICE_INTERACTION_TARGETS = [
  "desk",
  "server_room",
  "meeting_room",
  "gym",
  "jukebox",
  "qa_lab",
] as const;

export type OfficeInteractionTargetId =
  (typeof OFFICE_INTERACTION_TARGETS)[number];

export const OFFICE_SKILL_TRIGGER_MOVEMENT_TARGETS = [
  "desk",
  "github",
  "gym",
  "jukebox",
  "qa_lab",
] as const;

export type OfficeSkillTriggerMovementTarget =
  (typeof OFFICE_SKILL_TRIGGER_MOVEMENT_TARGETS)[number];

type OfficeSkillTriggerAnimationHoldKey =
  | "deskHoldByAgentId"
  | "githubHoldByAgentId"
  | "gymHoldByAgentId"
  | "jukeboxHoldByAgentId"
  | "qaHoldByAgentId";

export const OFFICE_SKILL_TRIGGER_PLACE_REGISTRY: Record<
  OfficeSkillTriggerMovementTarget,
  {
    label: string;
    interactionTarget: OfficeInteractionTargetId;
    animationHoldKey: OfficeSkillTriggerAnimationHoldKey;
    alsoSetsSkillGymHold?: boolean;
  }
> = {
  desk: {
    label: t("libOffice.placeDesk"),
    interactionTarget: "desk",
    animationHoldKey: "deskHoldByAgentId",
  },
  github: {
    label: t("libOffice.placeServerRoom"),
    interactionTarget: "server_room",
    animationHoldKey: "githubHoldByAgentId",
  },
  gym: {
    label: t("libOffice.placeGym"),
    interactionTarget: "gym",
    animationHoldKey: "gymHoldByAgentId",
    alsoSetsSkillGymHold: true,
  },
  jukebox: {
    label: t("libOffice.placeJukebox"),
    interactionTarget: "jukebox",
    animationHoldKey: "jukeboxHoldByAgentId",
  },
  qa_lab: {
    label: t("libOffice.placeQaLab"),
    interactionTarget: "qa_lab",
    animationHoldKey: "qaHoldByAgentId",
  },
};

export const isOfficeSkillTriggerMovementTarget = (
  value: unknown,
): value is OfficeSkillTriggerMovementTarget =>
  typeof value === "string" && value in OFFICE_SKILL_TRIGGER_PLACE_REGISTRY;

export type DefaultSkillTriggerFallback = {
  anyPhrases: string[];
  movementTarget: OfficeSkillTriggerMovementTarget;
  skipIfAlreadyThere?: boolean;
};

export const DEFAULT_SKILL_TRIGGER_FALLBACKS_BY_SKILL_KEY: Record<
  string,
  DefaultSkillTriggerFallback
> = {
  "todo-board": {
    anyPhrases: [
      "todo",
      "todo list",
      "blocked task",
      "blocked tasks",
      "add to my todo",
      "show my todo",
      "список дел",
      "мои дела",
      "заблокированн",
    ],
    movementTarget: "desk",
    skipIfAlreadyThere: true,
  },
  "task-manager": {
    anyPhrases: [
      "add a task",
      "create a task",
      "track this task",
      "task status",
      "mark this done",
      "block this task",
      "what tasks do we have",
      "добавь задачу",
      "создай задачу",
      "новая задача",
      "статус задачи",
      "какие задачи",
    ],
    movementTarget: "desk",
    skipIfAlreadyThere: true,
  },
  soundclaw: {
    anyPhrases: [
      "spotify",
      "play a song",
      "play this song",
      "play music",
      "play a playlist",
      "find a song",
      "queue this song",
      "music link",
      "включи музыку",
      "включи песню",
      "поставь песню",
      "найди песню",
      "плейлист",
    ],
    movementTarget: "jukebox",
    skipIfAlreadyThere: true,
  },
};

export const buildOfficeSkillTriggerHoldMaps = (
  movementTargetByAgentId: Record<string, OfficeSkillTriggerMovementTarget>,
): {
  deskHoldByAgentId: Record<string, boolean>;
  githubHoldByAgentId: Record<string, boolean>;
  gymHoldByAgentId: Record<string, boolean>;
  jukeboxHoldByAgentId: Record<string, boolean>;
  qaHoldByAgentId: Record<string, boolean>;
  skillGymHoldByAgentId: Record<string, boolean>;
} => {
  const next = {
    deskHoldByAgentId: {} as Record<string, boolean>,
    githubHoldByAgentId: {} as Record<string, boolean>,
    gymHoldByAgentId: {} as Record<string, boolean>,
    jukeboxHoldByAgentId: {} as Record<string, boolean>,
    qaHoldByAgentId: {} as Record<string, boolean>,
    skillGymHoldByAgentId: {} as Record<string, boolean>,
  };

  for (const [agentId, target] of Object.entries(movementTargetByAgentId)) {
    const place = OFFICE_SKILL_TRIGGER_PLACE_REGISTRY[target];
    next[place.animationHoldKey][agentId] = true;
    if (place.alsoSetsSkillGymHold) {
      next.skillGymHoldByAgentId[agentId] = true;
    }
  }

  return next;
};
