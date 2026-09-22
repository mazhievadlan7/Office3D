import { t } from "@/lib/i18n";
import type { StandupPhase } from "@/lib/office/standup/types";

// An explicit map rather than a key built from the phase: the dictionary check
// only sees keys written out in full.
const PHASE_LABELS: Record<StandupPhase, () => string> = {
  scheduled: () => t("standup.phaseScheduled"),
  gathering: () => t("standup.phaseGathering"),
  in_progress: () => t("standup.phaseInProgress"),
  complete: () => t("standup.phaseComplete"),
};

export const standupPhaseLabel = (phase: StandupPhase): string =>
  PHASE_LABELS[phase]?.() ?? phase;
