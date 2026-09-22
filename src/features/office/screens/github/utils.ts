"use client";

import { matchesPhrase, t } from "@/lib/i18n";

export const GITHUB_RECORDING_PRIVACY_MASK_ACTIVE = false;

export const maskGitHubRecordingText = (
  value: string | null | undefined,
): string => {
  return value ?? "";
};

export const formatRelativeTime = (value: string | null): string => {
  if (!value) return t("opsGithub.unknownUpdate");
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  const deltaMinutes = Math.max(0, Math.round((Date.now() - timestamp) / 60_000));
  if (deltaMinutes < 1) return t("opsGithub.updatedJustNow");
  if (deltaMinutes < 60) return t("opsGithub.updatedMinutesAgo", { minutes: deltaMinutes });
  const deltaHours = Math.round(deltaMinutes / 60);
  if (deltaHours < 24) return t("opsGithub.updatedHoursAgo", { hours: deltaHours });
  const deltaDays = Math.round(deltaHours / 24);
  return t("opsGithub.updatedDaysAgo", { days: deltaDays });
};

export const summarizeChecksTone = (summary: string | null): string => {
  if (!summary) return "text-white/45";
  if (matchesPhrase(summary, "libOffice.checksFailing")) return "text-rose-300";
  if (matchesPhrase(summary, "libOffice.checksPending")) return "text-amber-200";
  return "text-emerald-200";
};
