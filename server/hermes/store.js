// Office3D's own state for the Hermes adapter.
//
// Hermes owns agents (profiles), their memory, sessions and runs. What is left
// for Office3D to remember is small and presentation-side:
//   - how an agent is shown in the office (name, emoji) — profile ids are
//     latin slugs, office names are free text;
//   - which Hermes session backs each office session key, and how many times
//     it was reset;
//   - per-session model overrides picked in the office;
//   - agent files that Hermes has no slot for (IDENTITY.md and friends), which
//     are handed to the agent with every run;
//   - the office's gateway config overlay.
//
// Writes go to a temp file that is renamed over the real one, so a crash
// mid-write never leaves a truncated store, and they are serialized so two
// quick updates cannot interleave.

const fs = require("node:fs");
const path = require("node:path");

const SCHEMA_VERSION = 1;

const emptyState = () => ({
  schemaVersion: SCHEMA_VERSION,
  agents: {},
  sessions: {},
  configOverlay: {},
});

const isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

const normalizeState = (raw) => {
  if (!isRecord(raw)) return emptyState();
  return {
    schemaVersion: SCHEMA_VERSION,
    agents: isRecord(raw.agents) ? raw.agents : {},
    sessions: isRecord(raw.sessions) ? raw.sessions : {},
    configOverlay: isRecord(raw.configOverlay) ? raw.configOverlay : {},
  };
};

const createHermesStore = ({ filePath, logError = () => {} }) => {
  let state = emptyState();
  try {
    if (fs.existsSync(filePath)) {
      state = normalizeState(JSON.parse(fs.readFileSync(filePath, "utf8")));
    }
  } catch (err) {
    // A corrupt store must not take the office down. Keep the broken file for
    // inspection and start clean; everything in it is recoverable (names can
    // be set again, sessions are recreated lazily).
    logError("Hermes adapter store is unreadable; starting with an empty one.", err);
    try {
      fs.renameSync(filePath, `${filePath}.corrupt-${Date.now()}`);
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
      .catch((err) => logError("Failed to save the Hermes adapter store.", err));
    return writeChain;
  };

  const agent = (id) => state.agents[id] ?? null;

  return {
    getAgent: agent,
    listAgents: () => ({ ...state.agents }),
    upsertAgent(id, patch) {
      state.agents[id] = { ...(state.agents[id] ?? {}), ...patch, updatedAt: Date.now() };
      return persist();
    },
    removeAgent(id) {
      delete state.agents[id];
      for (const key of Object.keys(state.sessions)) {
        if (state.sessions[key]?.agentId === id) delete state.sessions[key];
      }
      return persist();
    },
    getAgentFile(id, name) {
      return agent(id)?.files?.[name];
    },
    setAgentFile(id, name, content) {
      const current = agent(id) ?? {};
      state.agents[id] = { ...current, files: { ...(current.files ?? {}), [name]: content }, updatedAt: Date.now() };
      return persist();
    },
    getSession: (key) => state.sessions[key] ?? null,
    upsertSession(key, patch) {
      state.sessions[key] = { ...(state.sessions[key] ?? {}), ...patch };
      return persist();
    },
    getConfigOverlay: () => state.configOverlay,
    setConfigOverlay(next) {
      state.configOverlay = isRecord(next) ? next : {};
      return persist();
    },
    flush: () => writeChain,
  };
};

module.exports = { createHermesStore };
