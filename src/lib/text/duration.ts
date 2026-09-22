import { t } from "@/lib/i18n";

/**
 * A short duration for the interface: «45 с», «3 мин 20 с», «2 ч 5 мин».
 *
 * Two units at most — the next one down stops mattering once the larger one is
 * there — and a zero remainder is left out rather than shown as «2 ч 0 мин».
 */
export const formatDurationShort = (totalSeconds: number): string => {
  const seconds = Math.max(0, Math.round(totalSeconds));
  if (seconds < 60) return t("libCron.unitSeconds", { count: seconds });
  const minutes = Math.floor(seconds / 60);
  const restSeconds = seconds % 60;
  if (minutes < 60) {
    const head = t("libCron.unitMinutes", { count: minutes });
    return restSeconds > 0 ? `${head} ${t("libCron.unitSeconds", { count: restSeconds })}` : head;
  }
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  const head = t("libCron.unitHours", { count: hours });
  return restMinutes > 0 ? `${head} ${t("libCron.unitMinutes", { count: restMinutes })}` : head;
};
