import type { TranscriptEntry } from "@/features/agents/state/transcript";
import { stripUiMetadata } from "@/lib/text/message-extract";
import { hasCyrillic } from "@/lib/text/transliterate";
import {
  resolveRuGymCommand,
  resolveRuGymSkill,
  resolveRuInteraction,
  resolveRuQa,
  resolveRuStandup,
} from "@/lib/office/deskDirectivesRu";

// This module is the single natural-language entry point for office movement and room intents.
// Runtime consumers should prefer the unified snapshot instead of scattering transport-specific
// regex checks across chat, office, or scene code.
export type OfficeDeskDirective = "desk" | "release";
export type OfficeGithubDirective = "github" | "release";
export type OfficeGymDirective = "gym" | "release";
export type OfficeQaDirective = "qa_lab" | "release";
export type OfficeStandupDirective = "standup";
export type OfficeIntentSnapshot = {
  normalized: string;
  desk: OfficeDeskDirective | null;
  github: OfficeGithubDirective | null;
  gym:
    | {
        directive: OfficeGymDirective;
        source: "manual" | "skill";
      }
    | null;
  qa: OfficeQaDirective | null;
  art: null;
  standup: OfficeStandupDirective | null;
};
type OfficeInteractionDirective =
  | { target: "desk"; action: "hold" | "release" }
  | { target: "github"; action: "hold" | "release" };

const normalizeDirectiveText = (value: string | null | undefined): string => {
  if (!value) return "";
  const cleaned = stripUiMetadata(value).trim().replace(/^>\s*/, "");
  return cleaned
    .toLowerCase()
    .replace(/[.!?]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
};

const INTENT_SNAPSHOT_CACHE_LIMIT = 250;
const intentSnapshotCache = new Map<string, OfficeIntentSnapshot>();

const getCachedIntentSnapshot = (
  normalized: string,
): OfficeIntentSnapshot | undefined => {
  const cached = intentSnapshotCache.get(normalized);
  if (!cached) return undefined;
  intentSnapshotCache.delete(normalized);
  intentSnapshotCache.set(normalized, cached);
  return cached;
};

const cacheIntentSnapshot = (normalized: string, snapshot: OfficeIntentSnapshot) => {
  intentSnapshotCache.set(normalized, snapshot);
  if (intentSnapshotCache.size <= INTENT_SNAPSHOT_CACHE_LIMIT) return snapshot;
  const oldestKey = intentSnapshotCache.keys().next().value;
  if (oldestKey) intentSnapshotCache.delete(oldestKey);
  return snapshot;
};

const resolveOfficeInteractionDirectiveFromNormalized = (
  normalized: string,
): OfficeInteractionDirective | null => {
  const mentionsDesk = /\b(?:your|the)?\s*desk\b/.test(normalized);
  const deskCommandPatterns = [
    /\bgo\s+to\s+(?:your|the)\s+desk\b/,
    /\bhead\s+to\s+(?:your|the)\s+desk\b/,
    /\breturn\s+to\s+(?:your|the)\s+desk\b/,
    /\bgo\s+back\s+to\s+(?:your|the)\s+desk\b/,
    /\bback\s+to\s+(?:your|the)\s+desk\b/,
    /\bgo\s+sit\s+(?:at|on)\s+(?:your|the)\s+desk\b/,
    /\bsit\s+(?:at|on)\s+(?:your|the)\s+desk\b/,
  ];
  const isDeskCommand = deskCommandPatterns.some((pattern) =>
    pattern.test(normalized),
  );
  if (isDeskCommand) return { target: "desk", action: "hold" };

  const isDeskRelease =
    mentionsDesk &&
    (normalized.includes("leave") ||
      normalized.includes("leave your desk") ||
      normalized.includes("leave the desk"));
  const isWalkRelease =
    normalized.includes("walk") &&
    (normalized.includes("go on a walk") ||
      normalized.includes("go to walk") ||
      normalized.includes("go for a walk") ||
      normalized.includes("go walk"));
  if (isDeskRelease || isWalkRelease)
    return { target: "desk", action: "release" };

  const mentionsServerRoom =
    normalized.includes("server room") ||
    normalized.includes("github") ||
    normalized.includes("api") ||
    normalized.includes("code review") ||
    normalized.includes("pull request") ||
    normalized.includes("pull requests") ||
    normalized.includes(" prs") ||
    normalized.startsWith("pr ");
  const githubReviewIntentPatterns = [
    /\b(?:lets|let's)\s+review\s+(?:some\s+)?(?:prs?|pull requests?)\b/,
    /\b(?:lets|let's)\s+review\s+(?:some\s+)?(?:apis?|code)\b/,
    /\breview\s+(?:some\s+)?(?:prs?|pull requests?)\b/,
    /\breview\s+(?:some\s+)?(?:apis?|code)\b/,
    /\b(?:is|are)\s+there\s+any\s+(?:prs?|pull requests?)(?:\s+to\s+review)?\b/,
    /\b(?:is|are)\s+there\s+any\s+(?:apis?|code)(?:\s+to\s+review)?\b/,
    /\bany\s+(?:prs?|pull requests?)\s+to\s+review\b/,
    /\bany\s+(?:apis?|code)\s+to\s+review\b/,
    /\bcheck\s+github\b/,
    /\bcheck\s+(?:the\s+)?pull requests?\b/,
    /\bopen\s+github\b/,
    /\bshow\s+github\b/,
    /\bgo\s+to\s+(?:the\s+)?server room\b/,
    /\bwalk\s+to\s+(?:the\s+)?server room\b/,
    /\bhead\s+to\s+(?:the\s+)?server room\b/,
    /\bgo\s+review\b/,
  ];
  const matchesGithubReviewIntent = githubReviewIntentPatterns.some((pattern) =>
    pattern.test(normalized),
  );
  const isGithubCommand =
    matchesGithubReviewIntent || normalized.includes("review github");
  if (isGithubCommand && (mentionsServerRoom || matchesGithubReviewIntent)) {
    return { target: "github", action: "hold" };
  }

  const isGithubRelease =
    mentionsServerRoom &&
    (normalized.includes("leave") ||
      normalized.includes("exit") ||
      normalized.includes("close github") ||
      normalized.includes("stop reviewing") ||
      normalized.includes("done reviewing") ||
      normalized.includes("leave the server room"));
  if (isGithubRelease) return { target: "github", action: "release" };

  return null;
};

const resolveOfficeGymSkillDirectiveFromNormalized = (
  normalized: string,
): OfficeGymDirective | null => {
  const gymSkillReleasePatterns = [
    /\bleave\s+(?:the\s+)?gym\b/,
    /\bexit\s+(?:the\s+)?gym\b/,
    /\bdone\s+(?:with\s+(?:the\s+)?)?(?:gym|skill(?:\s+building)?)\b/,
    /\bstop\s+(?:working\s+on\s+)?skills?\b/,
    /\bleave\s+the\s+skill(?:\s+building)?(?:\s+room)?\b/,
  ];
  if (gymSkillReleasePatterns.some((pattern) => pattern.test(normalized))) {
    return "release";
  }
  const skillIntentPatterns = [
    /\bskills?\b/,
    /\bskills?\s+marketplace\b/,
    /\bbuild\s+(?:another\s+)?skill\b/,
    /\bcreate\s+(?:another\s+)?skill\b/,
    /\bdevelop\s+(?:another\s+)?skill\b/,
    /\binstall\s+(?:a\s+)?skill\b/,
    /\benable\s+(?:a\s+)?skill\b/,
    /\bsetup\s+(?:a\s+)?skill\b/,
    /\bconfigure\s+(?:a\s+)?skill\b/,
    /\bopenclaw\s+skill\b/,
    /\bskill\s+for\s+openclaw\b/,
  ];
  return skillIntentPatterns.some((pattern) => pattern.test(normalized))
    ? "gym"
    : null;
};

const resolveOfficeGymCommandDirectiveFromNormalized = (
  normalized: string,
): OfficeGymDirective | null => {
  const gymCommandReleasePatterns = [
    /\bleave\s+(?:the\s+)?gym\b/,
    /\bexit\s+(?:the\s+)?gym\b/,
    /\bdone\s+(?:with\s+(?:the\s+)?)?gym\b/,
    /\bstop\s+gym(?:ning)?\b/,
    /\bleave\s+skill(?:\s+building)?(?:\s+room)?\b/,
  ];
  if (gymCommandReleasePatterns.some((pattern) => pattern.test(normalized))) {
    return "release";
  }
  const gymCommandPatterns = [
    /\b(?:lets|let's)\s+go\s+to\s+the\s+gym\b/,
    /\b(?:lets|let's)\s+go\s+to\s+gym\b/,
    /\bgo\s+to\s+the\s+gym\b/,
    /\bgo\s+to\s+gym\b/,
    /\bhead\s+to\s+the\s+gym\b/,
    /\bhead\s+to\s+gym\b/,
    /\bgo\s+work\s+out\b/,
    /\bgo\s+workout\b/,
  ];
  return gymCommandPatterns.some((pattern) => pattern.test(normalized))
    ? "gym"
    : null;
};

const resolveOfficeQaDirectiveFromNormalized = (
  normalized: string,
): OfficeQaDirective | null => {
  const qaIntentPatterns = [
    /\bwrite\s+tests?\b/,
    /\brun\s+tests?\b/,
    /\b(?:verify|verification)\b/,
    /\breproduce\b/,
    /\bcheck\s+if\s+this\s+works\b/,
    /\btest\s+this\b/,
    /\btest\s+this\s+build\b/,
    /\bqa\s+(?:room|lab)\b/,
    /\bquality\s+assurance\b/,
    /\bdebug\s+this\b/,
  ];
  const qaReleasePatterns = [
    /\bleave\s+(?:the\s+)?(?:qa\s+(?:room|lab)|testing\s+lab)\b/,
    /\bexit\s+(?:the\s+)?(?:qa\s+(?:room|lab)|testing\s+lab)\b/,
    /\bclose\s+(?:the\s+)?qa\s+(?:room|lab)\b/,
    /\bdone\s+(?:testing|verifying|reproducing)\b/,
    /\bstop\s+(?:testing|verifying|reproducing)\b/,
  ];

  if (qaReleasePatterns.some((pattern) => pattern.test(normalized))) {
    return "release";
  }

  return qaIntentPatterns.some((pattern) => pattern.test(normalized))
    ? "qa_lab"
    : null;
};

const resolveOfficeStandupDirectiveFromNormalized = (
  normalized: string,
): OfficeStandupDirective | null => {
  const hasMeetingKeyword =
    normalized.includes("standup") ||
    normalized.includes("scrum") ||
    normalized.includes("standard meeting");
  if (
    normalized.includes("meeting time") ||
    normalized.includes("standup meeting") ||
    normalized.includes("scrum meeting") ||
    normalized.includes("standard meeting")
  ) {
    return "standup";
  }
  if (
    hasMeetingKeyword &&
    (normalized.includes("let's have") ||
      normalized.includes("lets have") ||
      normalized.includes("have a") ||
      normalized.includes("start the") ||
      normalized.includes("start "))
  ) {
    return "standup";
  }
  const standupIntentPatterns = [
    /\b(?:lets|let's)\s+have\s+(?:a\s+)?standup(?:\s+meeting)?\b/,
    /\b(?:lets|let's)\s+have\s+(?:a\s+)?scrum(?:\s+meeting)?\b/,
    /\b(?:lets|let's)\s+have\s+(?:a\s+)?standard\s+meeting\b/,
    /\bstandup\s+meeting\b/,
    /\bscrum\s+meeting\b/,
    /\bstandard\s+meeting\b/,
    /\bmeeting\s+time\b/,
    /\bscrum\s+meeting\s+time\b/,
    /\bstandup\s+time\b/,
    /\bstart\s+(?:the\s+)?standup\b/,
    /\bstart\s+(?:the\s+)?scrum\b/,
    /\bhave\s+(?:a\s+)?meeting\b/,
  ];
  return standupIntentPatterns.some((pattern) => pattern.test(normalized))
    ? "standup"
    : null;
};

export const resolveOfficeIntentSnapshot = (
  value: string | null | undefined,
): OfficeIntentSnapshot => {
  // Normalize once so every downstream intent category is derived from the same text view.
  const normalized = normalizeDirectiveText(value);
  if (!normalized) {
    return {
      normalized: "",
      desk: null,
      github: null,
      gym: null,
      qa: null,
      art: null,
      standup: null,
    };
  }

  const cached = getCachedIntentSnapshot(normalized);
  if (cached) return cached;

  // Russian commands are read first when the message is in Russian; the English
  // rules still apply as a fallback, so a mixed message is understood either way.
  const ru = hasCyrillic(normalized);
  const interactionDirective =
    (ru ? resolveRuInteraction(normalized) : null) ??
    resolveOfficeInteractionDirectiveFromNormalized(normalized);
  const gymManualDirective =
    (ru ? resolveRuGymCommand(normalized) : null) ??
    resolveOfficeGymCommandDirectiveFromNormalized(normalized);
  const qaDirective =
    (ru ? resolveRuQa(normalized) : null) ?? resolveOfficeQaDirectiveFromNormalized(normalized);
  const gymSkillDirective =
    (ru ? resolveRuGymSkill(normalized) : null) ??
    resolveOfficeGymSkillDirectiveFromNormalized(normalized);
  const standupDirective =
    (ru ? resolveRuStandup(normalized) : null) ??
    resolveOfficeStandupDirectiveFromNormalized(normalized);
  const gymDirective = gymManualDirective
    ? {
        directive: gymManualDirective,
        source: "manual" as const,
      }
    : gymSkillDirective
      ? {
          directive: gymSkillDirective,
          source: "skill" as const,
        }
      : null;

  return cacheIntentSnapshot(normalized, {
    normalized,
    desk:
      interactionDirective?.target === "desk"
        ? interactionDirective.action === "hold"
          ? "desk"
          : "release"
        : null,
    github:
      interactionDirective?.target === "github"
        ? interactionDirective.action === "hold"
          ? "github"
          : "release"
        : null,
    gym: gymDirective,
    qa: qaDirective,
    art: null,
    standup: standupDirective,
  });
};

export const resolveOfficeDeskDirective = (
  value: string | null | undefined,
): OfficeDeskDirective | null => resolveOfficeIntentSnapshot(value).desk;

export const resolveOfficeGithubDirective = (
  value: string | null | undefined,
): OfficeGithubDirective | null => resolveOfficeIntentSnapshot(value).github;

export const resolveOfficeGymDirective = (
  value: string | null | undefined,
): OfficeGymDirective | null => {
  const gymIntent = resolveOfficeIntentSnapshot(value).gym;
  return gymIntent?.source === "skill" ? gymIntent.directive : null;
};

export const resolveOfficeGymCommandDirective = (
  value: string | null | undefined,
): OfficeGymDirective | null => {
  const gymIntent = resolveOfficeIntentSnapshot(value).gym;
  return gymIntent?.source === "manual" ? gymIntent.directive : null;
};

export const resolveOfficeQaDirective = (
  value: string | null | undefined,
): OfficeQaDirective | null => resolveOfficeIntentSnapshot(value).qa;

export const resolveOfficeStandupDirective = (
  value: string | null | undefined,
): OfficeStandupDirective | null => resolveOfficeIntentSnapshot(value).standup;

const resolveTranscriptDirective = <
  TDirective extends
    | OfficeDeskDirective
    | OfficeGithubDirective
    | OfficeGymDirective
    | OfficeQaDirective
    | OfficeStandupDirective,
>(
  entries: TranscriptEntry[] | undefined,
  resolver: (value: string | null | undefined) => TDirective | null,
): TDirective | null => {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry || entry.role !== "user") continue;
    const directive = resolver(entry.text);
    if (directive) return directive;
  }
  return null;
};

export const reduceOfficeDeskHoldState = (params: {
  currentHeld: boolean;
  lastUserMessage: string | null | undefined;
  transcriptEntries: TranscriptEntry[] | undefined;
}): boolean => {
  // Hold reducers intentionally fall back to transcript history so transport-specific sessions
  // can recover the latest durable directive after canonical history refreshes.
  const latestMessageDirective = resolveOfficeDeskDirective(
    params.lastUserMessage,
  );
  if (latestMessageDirective === "desk") return true;
  if (latestMessageDirective === "release") return false;

  const transcriptDirective = resolveTranscriptDirective(
    params.transcriptEntries,
    resolveOfficeDeskDirective,
  );
  if (transcriptDirective === "desk") return true;
  if (transcriptDirective === "release") return false;

  return params.currentHeld;
};

export const reduceOfficeGithubHoldState = (params: {
  currentHeld: boolean;
  lastUserMessage: string | null | undefined;
  transcriptEntries: TranscriptEntry[] | undefined;
}): boolean => {
  const latestMessageDirective = resolveOfficeGithubDirective(
    params.lastUserMessage,
  );
  if (latestMessageDirective === "github") return true;
  if (latestMessageDirective === "release") return false;

  const transcriptDirective = resolveTranscriptDirective(
    params.transcriptEntries,
    resolveOfficeGithubDirective,
  );
  if (transcriptDirective === "github") return true;
  if (transcriptDirective === "release") return false;

  return params.currentHeld;
};

export const reduceOfficeGymHoldState = (params: {
  currentHeld: boolean;
  isAgentRunning: boolean;
  lastUserMessage: string | null | undefined;
  transcriptEntries: TranscriptEntry[] | undefined;
}): boolean => {
  if (!params.isAgentRunning) return false;

  const latestMessageDirective = resolveOfficeGymDirective(
    params.lastUserMessage,
  );
  if (latestMessageDirective === "gym") return true;

  const transcriptDirective = resolveTranscriptDirective(
    params.transcriptEntries,
    resolveOfficeGymDirective,
  );
  if (transcriptDirective === "gym") return true;

  return params.currentHeld;
};

export const reduceOfficeQaHoldState = (params: {
  currentHeld: boolean;
  lastUserMessage: string | null | undefined;
  transcriptEntries: TranscriptEntry[] | undefined;
}): boolean => {
  const latestMessageDirective = resolveOfficeQaDirective(
    params.lastUserMessage,
  );
  if (latestMessageDirective === "qa_lab") return true;
  if (latestMessageDirective === "release") return false;

  const transcriptDirective = resolveTranscriptDirective(
    params.transcriptEntries,
    resolveOfficeQaDirective,
  );
  if (transcriptDirective === "qa_lab") return true;
  if (transcriptDirective === "release") return false;

  return params.currentHeld;
};
