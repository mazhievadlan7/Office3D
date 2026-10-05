// Shared board — the общая доска задач every floor can see (§II.3.2 единый организм).
//
// Holds work items and lets callers list them by unit or status. Persistence
// mirrors core/store.js exactly: in-memory state written to a temp file renamed
// over the real one (crash-safe), writes serialized so two quick updates cannot
// interleave, mode 0600 (routing data is operational). No DB — in-memory + a JSON
// file, per the task's constraints.
//
// The board is deliberately dumb: it stores and queries. The state machine lives
// in workItem.js and the policy in routing.js; the orchestrator (index.js) wires
// them together with audit and preflight.

const fs = require("node:fs");
const path = require("node:path");

const { toUnit } = require("./directorates");

const SCHEMA_VERSION = 1;
const isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

const emptyState = () => ({ schemaVersion: SCHEMA_VERSION, items: {} });

const normalizeState = (raw) => {
  if (!isRecord(raw)) return emptyState();
  return { schemaVersion: SCHEMA_VERSION, items: isRecord(raw.items) ? raw.items : {} };
};

/**
 * @param {object} deps
 * @param {string} [deps.filePath]  JSON board file; omit for a memory-only board (tests)
 * @param {(message: string, err?: unknown) => void} [deps.logError]
 */
const createBoard = ({ filePath, logError = () => {} } = {}) => {
  let state = emptyState();
  if (filePath) {
    try {
      if (fs.existsSync(filePath)) state = normalizeState(JSON.parse(fs.readFileSync(filePath, "utf8")));
    } catch (err) {
      logError("Доска задач нечитаема; стартуем с пустой (элементы придётся пересоздать).", err);
      try {
        fs.renameSync(filePath, `${filePath}.corrupt-${process.pid}`);
      } catch {}
      state = emptyState();
    }
  }

  let writeChain = Promise.resolve();
  const persist = () => {
    if (!filePath) return Promise.resolve();
    const snapshot = JSON.stringify(state, null, 2);
    writeChain = writeChain
      .then(async () => {
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
        const tmp = `${filePath}.${process.pid}.tmp`;
        await fs.promises.writeFile(tmp, snapshot, { mode: 0o600 });
        await fs.promises.rename(tmp, filePath);
      })
      .catch((err) => logError("Не удалось сохранить доску задач.", err));
    return writeChain;
  };

  const copy = (item) => (item ? JSON.parse(JSON.stringify(item)) : null);

  const matchUnit = (item, unit) => {
    const u = toUnit(unit);
    if (u === null) return false;
    // "involves this unit": current holder, origin, target, or open helper.
    return item.currentUnit === u || item.originUnit === u || item.targetUnit === u || item.help?.helper === u;
  };

  return {
    get: (id) => copy(state.items[id]),
    has: (id) => Object.prototype.hasOwnProperty.call(state.items, id),

    put(item) {
      if (!item || !item.id) throw new Error("board.put requires an item with an id");
      state.items[item.id] = copy(item);
      return persist();
    },

    remove(id) {
      delete state.items[id];
      return persist();
    },

    /**
     * List items, newest-updated first, with optional filters.
     * @param {{unit?: number, status?: string, kind?: string, engagementId?: string, open?: boolean, limit?: number}} [filter]
     */
    list(filter = {}) {
      let items = Object.values(state.items).map(copy);
      if (filter.unit !== undefined) items = items.filter((it) => matchUnit(it, filter.unit));
      if (filter.status) items = items.filter((it) => it.status === filter.status);
      if (filter.kind) items = items.filter((it) => it.kind === filter.kind);
      if (filter.engagementId) items = items.filter((it) => it.engagementId === filter.engagementId);
      if (filter.open === true) items = items.filter((it) => it.status !== "closed");
      items.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
      const limit = Number.isInteger(filter.limit) && filter.limit > 0 ? filter.limit : 0;
      return limit ? items.slice(0, limit) : items;
    },

    /** Count open items grouped by status — a cheap board summary. */
    summary() {
      const counts = {};
      for (const item of Object.values(state.items)) {
        counts[item.status] = (counts[item.status] ?? 0) + 1;
      }
      return { total: Object.keys(state.items).length, byStatus: counts };
    },

    flush: () => writeChain,
  };
};

module.exports = { createBoard };
