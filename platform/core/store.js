// Persistent state for the AEGIS legal core: engagements and the global
// kill-switch. Mirrors the Hermes adapter store — writes go to a temp file
// renamed over the real one (crash-safe) and are serialized so two quick
// updates cannot interleave. Mode 0600: the scope is authorization data.
//
// The append-only audit ledger is NOT here — it lives in audit.js, which never
// rewrites, only appends. This store holds mutable current state; the ledger
// holds the immutable history of decisions.

const fs = require("node:fs");
const path = require("node:path");

const SCHEMA_VERSION = 1;

const isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

const emptyState = () => ({
  schemaVersion: SCHEMA_VERSION,
  engagements: {},
  killSwitch: { global: false, at: null, by: null, reason: null },
});

const normalizeState = (raw) => {
  if (!isRecord(raw)) return emptyState();
  return {
    schemaVersion: SCHEMA_VERSION,
    engagements: isRecord(raw.engagements) ? raw.engagements : {},
    killSwitch: isRecord(raw.killSwitch) ? { global: false, at: null, by: null, reason: null, ...raw.killSwitch } : emptyState().killSwitch,
  };
};

const createAegisStore = ({ filePath, logError = () => {} }) => {
  let state = emptyState();
  try {
    if (fs.existsSync(filePath)) {
      state = normalizeState(JSON.parse(fs.readFileSync(filePath, "utf8")));
    }
  } catch (err) {
    // A corrupt store must not take the control plane down, but it also must
    // not silently drop authorization state. Keep the broken file for
    // inspection and start clean; nothing here can grant access on its own —
    // an engagement must be re-authorized and re-activated to accept actions.
    logError("AEGIS store is unreadable; starting empty (engagements must be re-authorized).", err);
    try {
      fs.renameSync(filePath, `${filePath}.corrupt-${process.pid}`);
    } catch {}
    state = emptyState();
  }

  let writeChain = Promise.resolve();
  const persist = () => {
    const snapshot = JSON.stringify(state, null, 2);
    writeChain = writeChain
      .then(async () => {
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
        const tmp = `${filePath}.${process.pid}.tmp`;
        await fs.promises.writeFile(tmp, snapshot, { mode: 0o600 });
        await fs.promises.rename(tmp, filePath);
      })
      .catch((err) => logError("Failed to save the AEGIS store.", err));
    return writeChain;
  };

  return {
    getEngagement: (id) => state.engagements[id] ?? null,
    listEngagements: () => Object.values(state.engagements).map((e) => ({ ...e })),
    putEngagement(engagement) {
      state.engagements[engagement.id] = engagement;
      return persist();
    },
    removeEngagement(id) {
      delete state.engagements[id];
      return persist();
    },
    getKillSwitch: () => ({ ...state.killSwitch }),
    setKillSwitch(next) {
      state.killSwitch = { ...state.killSwitch, ...next };
      return persist();
    },
    flush: () => writeChain,
  };
};

module.exports = { createAegisStore };
