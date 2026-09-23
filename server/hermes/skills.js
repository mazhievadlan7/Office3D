// Agents' skills through Hermes' own skill system.
//
// A skill lives in an agent's Hermes profile. The office lists an agent's
// skills and turns them on or off, and installs from Hermes' Skills Hub (the
// official catalog and a search across the hub's sources) — Hermes downloads,
// security-scans and installs; Office3D never writes skill files itself.
//
// Before an install the office asks Hermes for the same security scan its
// installer runs. A "block" verdict is refused; an "ask" verdict installs only
// when the person confirmed it after seeing the findings. The install itself
// is a background Hermes action whose progress the office polls.

const DEFAULT_PROFILE = "default";
const MAIN_AGENT_ID = "main";
const IDENT_RE = /^[A-Za-z0-9@._:\/+-]{1,200}$/;
const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
const ACTION_RE = /^skills-(install|uninstall|update)-[a-z0-9-]{1,60}$/;

const str = (value) => (typeof value === "string" ? value.trim() : "");
const isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/**
 * @param {object} deps
 * @param {any} deps.client
 * @param {(agentId: string) => Promise<string>} deps.profileFor   validates the agent, returns its profile
 * @param {() => Promise<Array<{name: string}>>} deps.listProfiles
 * @param {() => boolean} deps.hasDashboard
 * @param {new (code: string, message: string) => Error} deps.AdapterError
 * @param {(message: string) => void} [deps.log]
 */
const createSkillHandlers = ({ client, profileFor, listProfiles, hasDashboard, AdapterError, log = () => {} }) => {
  const requireDashboard = () => {
    if (!hasDashboard()) throw new AdapterError("UNAVAILABLE", "Навыки Hermes доступны при подключённой панели Hermes.");
  };
  const invalid = (message) => new AdapterError("INVALID_REQUEST", message);

  const identifierOf = (p) => {
    const identifier = str(p.identifier);
    if (!IDENT_RE.test(identifier)) throw invalid("Неверный идентификатор навыка.");
    return identifier;
  };

  const scan = async (profile, identifier) => {
    const result = await client.dashboard("/api/skills/hub/scan", { query: { identifier, profile } });
    return {
      identifier,
      trustLevel: str(result?.trust_level) || null,
      verdict: str(result?.verdict) || null,
      summary: str(result?.summary) || null,
      policy: ["allow", "ask", "block"].includes(result?.policy) ? result.policy : "ask",
      policyReason: str(result?.policy_reason) || null,
      findings: Array.isArray(result?.findings) ? result.findings.slice(0, 20) : [],
    };
  };

  const handlers = {
    /** The agent's skills, with whether each is on. */
    async "hermes.skills.list"(p) {
      requireDashboard();
      const profile = await profileFor(str(p.agentId) || MAIN_AGENT_ID);
      const rows = await client.dashboard("/api/skills", { query: { profile } });
      const skills = (Array.isArray(rows) ? rows : []).filter(isRecord).map((row) => ({
        name: str(row.name),
        description: str(row.description),
        category: str(row.category) || null,
        enabled: row.enabled !== false,
        provenance: str(row.provenance) || null,
      }));
      return { skills };
    },

    async "hermes.skills.toggle"(p) {
      requireDashboard();
      const profile = await profileFor(str(p.agentId) || MAIN_AGENT_ID);
      const name = str(p.name);
      if (!NAME_RE.test(name) || typeof p.enabled !== "boolean") throw invalid("Нужны навык и включён ли он.");
      await client.dashboard("/api/skills/toggle", { method: "PUT", query: { profile }, body: { name, enabled: p.enabled, profile } });
      return { ok: true, name, enabled: p.enabled };
    },

    /** Hermes' official optional skills, marked installed for the agent. */
    async "hermes.skills.catalog"(p) {
      requireDashboard();
      const profile = await profileFor(str(p.agentId) || MAIN_AGENT_ID);
      const result = await client.dashboard("/api/skills/hub/official", { query: { profile } });
      return { skills: Array.isArray(result?.skills) ? result.skills : [] };
    },

    /** A search across the hub's sources. */
    async "hermes.skills.search"(p) {
      requireDashboard();
      const profile = await profileFor(str(p.agentId) || MAIN_AGENT_ID);
      const q = str(p.query).slice(0, 200);
      if (!q) return { results: [], installed: {} };
      const result = await client.dashboard("/api/skills/hub/search", { query: { q, limit: 20, profile } });
      return {
        results: Array.isArray(result?.results) ? result.results : [],
        installed: isRecord(result?.installed) || Array.isArray(result?.installed) ? result.installed : {},
        timedOut: Array.isArray(result?.timed_out) ? result.timed_out : [],
      };
    },

    /** The security scan an install would run, without installing. */
    async "hermes.skills.scan"(p) {
      requireDashboard();
      const profile = await profileFor(str(p.agentId) || MAIN_AGENT_ID);
      return scan(profile, identifierOf(p));
    },

    /**
     * Installs a hub skill for one agent, or for everyone ("all"). Scans first:
     * "block" is refused, "ask" needs `confirmRisk: true`.
     */
    async "hermes.skills.install"(p) {
      requireDashboard();
      const identifier = identifierOf(p);
      const everyone = str(p.agentId) === "all";
      const profiles = everyone
        ? (await listProfiles()).map((profile) => profile.name)
        : [await profileFor(str(p.agentId) || MAIN_AGENT_ID)];
      const verdict = await scan(profiles[0] ?? DEFAULT_PROFILE, identifier);
      if (verdict.policy === "block") {
        throw new AdapterError("FORBIDDEN", `Hermes запретил установку: ${verdict.policyReason || verdict.summary || "проверка безопасности не пройдена"}.`);
      }
      if (verdict.policy === "ask" && p.confirmRisk !== true) {
        throw new AdapterError("CONFIRMATION_REQUIRED", "Проверка безопасности просит подтверждения: посмотрите результаты и подтвердите установку.");
      }
      const actions = [];
      for (const profile of profiles) {
        const started = await client.dashboard("/api/skills/hub/install", { method: "POST", query: { profile }, body: { identifier, profile } });
        actions.push({ profile, action: str(started?.name) || null });
      }
      log(`Skill ${identifier} installing for ${profiles.join(", ")}.`);
      return { ok: true, identifier, actions, scan: verdict };
    },

    async "hermes.skills.uninstall"(p) {
      requireDashboard();
      const profile = await profileFor(str(p.agentId) || MAIN_AGENT_ID);
      const name = str(p.name);
      if (!NAME_RE.test(name)) throw invalid("Неверное имя навыка.");
      const started = await client.dashboard("/api/skills/hub/uninstall", { method: "POST", query: { profile }, body: { name, profile } });
      return { ok: true, action: str(started?.name) || null };
    },

    /** Progress of a background install or uninstall. */
    async "hermes.skills.action"(p) {
      requireDashboard();
      const name = str(p.action);
      if (!ACTION_RE.test(name)) throw invalid("Неизвестное действие.");
      const result = await client.dashboard(`/api/actions/${encodeURIComponent(name)}/status`, { query: { lines: 20 } });
      return {
        running: Boolean(result?.running),
        exitCode: typeof result?.exit_code === "number" ? result.exit_code : null,
        lines: Array.isArray(result?.lines) ? result.lines.slice(-20).map((line) => String(line).slice(0, 300)) : [],
      };
    },
  };

  return handlers;
};

module.exports = { createSkillHandlers };
