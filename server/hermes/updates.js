// Hermes updates, office side: asks the updater service (see
// server/updater) what version runs and what is newer, tells the office, and
// passes the person's "Обновить" on. "Позже" hides a version for a day.
//
// The updater is optional: without OFFICE3D_UPDATER_URL and its token the
// office simply does not offer updates (Hermes installed by hand is updated
// by hand).

const SNOOZE_MS = 24 * 60 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const FINISHED = new Set(["done", "rolled_back", "failed", "rollback_failed"]);
const PROGRESS_MS = 5_000;
const PROGRESS_MAX_MS = 2 * 60 * 60_000;

const isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/**
 * @param {object} deps
 * @param {{url: string, token: string} | null} deps.updater
 * @param {any} deps.store
 * @param {new (code: string, message: string) => Error} deps.AdapterError
 * @param {(event: string, payload: object) => void} deps.broadcast
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {() => number} [deps.now]
 * @param {(message: string) => void} [deps.log]
 */
const createUpdates = ({ updater, store, AdapterError, broadcast, fetchImpl = fetch, now = () => Date.now(), log = () => {} }) => {
  const available = Boolean(updater?.url && updater?.token);
  let last = null; // the last status from the updater
  let lastBroadcast = "";

  const request = async (method, path, body) => {
    let response;
    try {
      response = await fetchImpl(`${updater.url}${path}`, {
        method,
        headers: { Authorization: `Bearer ${updater.token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new AdapterError("UNAVAILABLE", "Сервис обновлений недоступен.");
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const code = response.status === 409 ? "CONFLICT" : response.status === 400 ? "INVALID_REQUEST" : "UNAVAILABLE";
      throw new AdapterError(code, typeof payload?.error === "string" ? payload.error : "Сервис обновлений не выполнил запрос.");
    }
    return payload;
  };

  const snoozed = () => (isRecord(store.getOrganization().hermesUpdates?.snoozed) ? store.getOrganization().hermesUpdates.snoozed : {});

  /** The office's view: what runs, what is newer, whether to offer it now, the job. */
  const view = (status) => {
    if (!available) return { available: false };
    if (!status) return { available: true, reachable: false };
    const latest = status.latest ?? status.current;
    const until = Number(snoozed()[latest] ?? 0);
    const job = isRecord(status.job) ? status.job : null;
    const running = Boolean(job && !FINISHED.has(job.status));
    // A version that already failed here is not offered again; a newer one is.
    const failedTo = job && job.status !== "done" && FINISHED.has(job.status) ? job.to : null;
    return {
      available: true,
      reachable: true,
      current: status.current,
      latest,
      newer: Array.isArray(status.newer) ? status.newer : [],
      checkedAt: status.checkedAt ?? null,
      offer: Boolean(latest && latest !== status.current && latest !== failedTo && !running && until <= now()),
      snoozedUntil: until > now() ? new Date(until).toISOString() : null,
      job,
      running,
    };
  };

  const announce = () => {
    const current = view(last);
    const key = JSON.stringify(current);
    if (key === lastBroadcast) return current;
    lastBroadcast = key;
    broadcast("hermes.update", current);
    return current;
  };

  /** Asks the updater; returns the office's view. Never throws. */
  const refresh = async ({ force = false } = {}) => {
    if (!available) return view(null);
    try {
      last = await request("GET", force ? "/status?refresh=1" : "/status");
    } catch (err) {
      log(`Hermes update check failed: ${err.message}`);
      last = null;
    }
    return announce();
  };

  // While an update runs, each step reaches the office within seconds —
  // including while Hermes itself is down for the switch.
  let following = null;
  const followProgress = () => {
    if (following) return;
    const startedAt = now();
    const tick = async () => {
      const current = await refresh();
      if (current.running && now() - startedAt < PROGRESS_MAX_MS) {
        following = setTimeout(() => void tick(), PROGRESS_MS);
        following.unref?.();
      } else {
        following = null;
      }
    };
    following = setTimeout(() => void tick(), PROGRESS_MS);
    following.unref?.();
  };

  const handlers = {
    async "hermes.update.status"(p) {
      return refresh({ force: Boolean(p?.refresh) });
    },

    async "hermes.update.start"(p) {
      if (!available) throw new AdapterError("UNAVAILABLE", "Обновления из офиса не настроены (нет сервиса обновлений).");
      const tag = typeof p.tag === "string" ? p.tag.trim() : "";
      if (!tag) throw new AdapterError("INVALID_REQUEST", "Не указана версия.");
      await request("POST", "/update", { tag });
      log(`Hermes update to ${tag} requested by the person.`);
      const current = await refresh();
      followProgress();
      return current;
    },

    async "hermes.update.later"(p) {
      const tag = typeof p.tag === "string" ? p.tag.trim() : "";
      if (!tag) throw new AdapterError("INVALID_REQUEST", "Не указана версия.");
      const next = { ...snoozed(), [tag]: now() + SNOOZE_MS };
      // Only the recent snoozes matter.
      const kept = Object.fromEntries(Object.entries(next).filter(([, until]) => Number(until) > now()));
      await store.updateOrganization({ hermesUpdates: { ...(store.getOrganization().hermesUpdates ?? {}), snoozed: kept } });
      return announce();
    },
  };

  const close = () => {
    if (following) clearTimeout(following);
    following = null;
  };

  return { handlers, refresh, available, close, isRunning: () => Boolean(view(last).running) };
};

module.exports = { createUpdates };
