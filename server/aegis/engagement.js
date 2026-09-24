// Engagement lifecycle and the kill-switch.
//
// An engagement is one authorized testing scope. It moves through a strict
// state machine, and only an ACTIVE one lets agents act:
//
//   draft ──record authorization──▶ authorized ──activate (customer)──▶ active
//     ▲                                                                   │
//     └── assets added/removed only in draft            stop / kill ◀─────┤
//                                                                         ▼
//                            active/stopped ──complete──▶ completed    stopped
//                                   stopped ──reactivate (audited)──▶ active
//
// Two rules make the "legal contour" real:
//   1. Final activation is the CUSTOMER's manual act (activate needs confirm:true
//      and records who/when). Nothing auto-activates.
//   2. The kill-switch — global or per-engagement — is checked before any
//      action (see preflight.js). Flipping it is instant.
//
// Ownership verification (DNS TXT / file token / WHOIS) is recorded here behind
// an injected verifier so the state machine is testable offline; live checks
// run on the server. recordAuthorization stores the authorization letter
// reference and signer; without that record an engagement cannot be activated.

const crypto = require("node:crypto");

const { AegisError, invalid } = require("./errors");
const { validateAsset, MAX_ASSETS } = require("./scope");

const STATUSES = new Set(["draft", "authorized", "active", "stopped", "completed"]);
const NAME_MAX = 200;

const newId = (prefix) => `${prefix}_${crypto.randomBytes(8).toString("hex")}`;

const cleanText = (value, max) => String(value ?? "").trim().slice(0, max);

/**
 * @param {object} deps
 * @param {ReturnType<import("./store").createAegisStore>} deps.store
 * @param {() => number} [deps.now]
 * @param {(entry: object) => void} [deps.onEvent]  called with an audit-shaped event for every state change
 */
const createEngagementManager = ({ store, now = () => Date.now(), onEvent = () => {} }) => {
  const snapshot = (engagement) => (engagement ? JSON.parse(JSON.stringify(engagement)) : null);

  const require_ = (id) => {
    const engagement = store.getEngagement(id);
    if (!engagement) throw new AegisError("NOT_FOUND", `Engagement не найден: ${id}.`);
    return engagement;
  };

  const mustBe = (engagement, status) => {
    if (engagement.status !== status) {
      throw new AegisError("CONFLICT", `Действие доступно только в состоянии «${status}», а engagement сейчас «${engagement.status}».`);
    }
  };

  const emit = (type, engagement, detail) => {
    onEvent({ type, engagementId: engagement.id, at: now(), detail: detail ?? {} });
  };

  const save = async (engagement) => {
    engagement.updatedAt = now();
    await store.putEngagement(engagement);
    return snapshot(engagement);
  };

  return {
    list: () => store.listEngagements(),
    get: (id) => snapshot(store.getEngagement(id)),

    async create({ name, note } = {}) {
      const clean = cleanText(name, NAME_MAX);
      if (!clean) throw invalid("У engagement должно быть название.");
      const engagement = {
        id: newId("eng"),
        name: clean,
        note: cleanText(note, 1000),
        status: "draft",
        assets: [],
        authorization: null,
        activation: null,
        stop: null,
        createdAt: now(),
        updatedAt: now(),
      };
      await store.putEngagement(engagement);
      emit("engagement.created", engagement, { name: clean });
      return snapshot(engagement);
    },

    async addAsset(id, assetInput) {
      const engagement = require_(id);
      mustBe(engagement, "draft");
      if (engagement.assets.length >= MAX_ASSETS) throw invalid("Достигнут предел числа активов в одном engagement.");
      const asset = { id: newId("ast"), ...validateAsset(assetInput) };
      engagement.assets.push(asset);
      emit("engagement.asset_added", engagement, { assetId: asset.id, kind: asset.kind, value: asset.value });
      return save(engagement);
    },

    async removeAsset(id, assetId) {
      const engagement = require_(id);
      mustBe(engagement, "draft");
      const before = engagement.assets.length;
      engagement.assets = engagement.assets.filter((asset) => asset.id !== assetId);
      if (engagement.assets.length === before) throw new AegisError("NOT_FOUND", `Актив не найден: ${assetId}.`);
      emit("engagement.asset_removed", engagement, { assetId });
      return save(engagement);
    },

    /**
     * Record the signed authorization for this engagement and move it to
     * "authorized". Optionally carry an ownership-verification result (from the
     * authorization gateway). Requires at least one asset.
     */
    async recordAuthorization(id, { letterRef, signer, verification } = {}) {
      const engagement = require_(id);
      mustBe(engagement, "draft");
      if (!engagement.assets.length) throw invalid("Нельзя авторизовать engagement без активов.");
      const ref = cleanText(letterRef, 500);
      const who = cleanText(signer, 200);
      if (!ref) throw invalid("Нужна ссылка на документ авторизации (authorization letter).");
      if (!who) throw invalid("Нужно указать подписанта авторизации.");
      engagement.authorization = {
        letterRef: ref,
        signer: who,
        verification: verification && typeof verification === "object" ? verification : null,
        recordedAt: now(),
      };
      engagement.status = "authorized";
      emit("engagement.authorized", engagement, { letterRef: ref, signer: who });
      return save(engagement);
    },

    /**
     * The customer's manual final activation. confirm must be true — nothing
     * activates on its own. Records who activated and when.
     */
    async activate(id, { by, confirm } = {}) {
      const engagement = require_(id);
      mustBe(engagement, "authorized");
      if (confirm !== true) throw invalid("Активация scope — ручное подтверждение заказчика (confirm: true).");
      const who = cleanText(by, 200);
      if (!who) throw invalid("Нужно указать, кто активирует scope.");
      engagement.activation = { by: who, at: now() };
      engagement.status = "active";
      emit("engagement.activated", engagement, { by: who });
      return save(engagement);
    },

    /** Per-engagement kill: stop accepting actions immediately. */
    async stop(id, { by, reason } = {}) {
      const engagement = require_(id);
      mustBe(engagement, "active");
      engagement.status = "stopped";
      engagement.stop = { by: cleanText(by, 200), reason: cleanText(reason, 500), at: now() };
      emit("engagement.stopped", engagement, { by: engagement.stop.by, reason: engagement.stop.reason });
      return save(engagement);
    },

    /** Bring a stopped engagement back — authorization must still be on file. */
    async reactivate(id, { by } = {}) {
      const engagement = require_(id);
      mustBe(engagement, "stopped");
      if (!engagement.authorization) throw new AegisError("CONFLICT", "Нет записи авторизации; повторно авторизуйте engagement.");
      const who = cleanText(by, 200);
      if (!who) throw invalid("Нужно указать, кто возобновляет scope.");
      engagement.status = "active";
      engagement.activation = { by: who, at: now() };
      engagement.stop = null;
      emit("engagement.reactivated", engagement, { by: who });
      return save(engagement);
    },

    async complete(id, { by } = {}) {
      const engagement = require_(id);
      if (engagement.status !== "active" && engagement.status !== "stopped") {
        throw new AegisError("CONFLICT", "Завершить можно только активный или остановленный engagement.");
      }
      engagement.status = "completed";
      engagement.completedBy = cleanText(by, 200);
      emit("engagement.completed", engagement, { by: engagement.completedBy });
      return save(engagement);
    },

    // --- kill-switch ---------------------------------------------------------

    getKillSwitch: () => store.getKillSwitch(),

    async setGlobalKill({ on, by, reason } = {}) {
      const next = { global: on === true, at: now(), by: cleanText(by, 200), reason: cleanText(reason, 500) };
      await store.setKillSwitch(next);
      onEvent({ type: on === true ? "killswitch.engaged" : "killswitch.released", engagementId: null, at: now(), detail: { by: next.by, reason: next.reason } });
      return store.getKillSwitch();
    },

    /**
     * Whether this engagement may accept actions right now — the single check
     * preflight relies on. Never throws; returns a reason on refusal.
     */
    actionable(id) {
      const kill = store.getKillSwitch();
      if (kill.global) return { ok: false, reason: "глобальный kill-switch включён" };
      const engagement = store.getEngagement(id);
      if (!engagement) return { ok: false, reason: `engagement не найден: ${id}` };
      if (engagement.status !== "active") return { ok: false, reason: `engagement не активен (${engagement.status})` };
      return { ok: true, engagement };
    },
  };
};

module.exports = { createEngagementManager, STATUSES };
