// Карцер (§19) — the quarantine hook.
//
// Когда вывод агента не прошёл проверку оркестратора, его контейнер
// останавливается, а из Capability Registry поднимается свежий клон; логи
// «виновного» уходят в СБ на аудит. Фактический рестарт контейнера — это
// рантайм-забота: здесь мы МОДЕЛИРУЕМ состояние и эмитим намерение (reclone
// intent) через колбэк плюс запись в неизменяемый аудит. Ничего не шеллим.
//
// Чистая функция `markQuarantined` ставит состояние на (клон) рабочего элемента;
// фабрика `createQuarantine` навешивает аудит и колбэк-хук и возвращает намерение
// реклонирования, которое рантайм (позже) исполнит.

const crypto = require("node:crypto");

const { invalid } = require("../core/errors");
const { SECURITY_UNIT, toUnit, unitLabel } = require("./directorates");

const cleanText = (value, max) => String(value ?? "").trim().slice(0, max);
const clone = (value) => (value == null ? value : JSON.parse(JSON.stringify(value)));

/**
 * Pure: return a new item flagged quarantined. Does not mutate the input.
 * @param {object} item
 * @param {{reason?: string, by?: string, failedUnit?: number, role?: string, at?: number, intentId?: string}} opts
 */
const markQuarantined = (item, opts = {}) => {
  if (!item || typeof item !== "object") throw invalid("Нет рабочего элемента для карцера.");
  const next = clone(item);
  const at = Number.isFinite(opts.at) ? opts.at : Date.now();
  const failedUnit = toUnit(opts.failedUnit) ?? next.currentUnit;
  next.quarantine = {
    quarantined: true,
    reason: cleanText(opts.reason, 500) || "вывод агента не прошёл проверку оркестратора",
    failedUnit,
    role: cleanText(opts.role, 80) || null,
    by: cleanText(opts.by, 120) || `unit:${SECURITY_UNIT}`,
    intentId: opts.intentId || `rc_${crypto.randomBytes(6).toString("hex")}`,
    recloneRequested: true,
    at,
  };
  const seq = (next.routingTrail[next.routingTrail.length - 1]?.seq ?? 0) + 1;
  next.routingTrail.push({
    seq,
    action: "quarantine",
    from: failedUnit,
    to: SECURITY_UNIT, // logs go to Внутренняя СБ for audit
    by: next.quarantine.by,
    reason: next.quarantine.reason,
    status: next.status,
    at,
  });
  next.updatedAt = at;
  return next;
};

/**
 * @param {object} deps
 * @param {ReturnType<import("../core/audit").createAuditLog>} deps.audit
 * @param {(intent: object) => void} [deps.onReclone]  the runtime hook: it will stop the
 *   failing container and raise a fresh clone from the Capability Registry.
 * @param {ReturnType<import("./registry").createRegistry>} [deps.registry]  to attach a clone reference
 * @param {() => number} [deps.now]
 * @param {(message: string, err?: unknown) => void} [deps.logError]
 */
const createQuarantine = ({ audit, onReclone = () => {}, registry = null, now = () => Date.now(), logError = () => {} } = {}) => {
  /**
   * Put an item's failing output into the Карцер: flag state, audit it, and emit
   * a reclone intent to the runtime hook. Returns { item, intent }.
   */
  const quarantine = (item, opts = {}) => {
    const next = markQuarantined(item, { ...opts, at: now() });
    const q = next.quarantine;

    // A fresh clone comes from the Capability Registry (§25). We only look up the
    // reference here; we do not start anything.
    let registryRef = null;
    if (registry && q.role) {
      try {
        registryRef = registry.get(q.failedUnit, q.role) ?? null;
      } catch (err) {
        logError("Карцер: не удалось получить ссылку из Capability Registry", err);
      }
    }

    const intent = {
      type: "reclone",
      intentId: q.intentId,
      workItemId: next.id,
      unit: q.failedUnit,
      role: q.role,
      reason: q.reason,
      registryRef: registryRef ? { id: registryRef.id, unit: registryRef.unit, role: registryRef.role } : null,
      at: q.at,
    };

    // Audit: the quarantine event itself, logged against Внутренняя СБ (§19 «логи
    // виновного — в СБ на аудит»).
    if (audit) {
      audit.append({
        type: "orchestrator.quarantine",
        engagementId: next.engagementId || null,
        actor: q.by,
        target: { unit: unitLabel(q.failedUnit), role: q.role },
        decision: "quarantine",
        reason: q.reason,
        detail: { workItemId: next.id, intentId: q.intentId, recloneRef: intent.registryRef },
      });
    }

    // Emit the intent to the runtime hook; never throw out of the audit/quarantine path.
    try {
      onReclone(intent);
    } catch (err) {
      logError("Карцер: обработчик reclone упал", err);
    }

    return { item: next, intent };
  };

  return { quarantine };
};

module.exports = { createQuarantine, markQuarantined };
