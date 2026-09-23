// Gives each Hermes profile its way into Office3D's MCP server.
//
// Hermes connects MCP servers listed under `mcp_servers` in a profile's
// config.yaml and notices new or removed ones on its own (a housekeeping tick,
// about a minute) — no restart. Each profile gets:
//   - its token in its own .env (OFFICE3D_MCP_TOKEN), so config.yaml, which
//     Hermes shows in its UI, carries only a `${…}` reference;
//   - one server entry pointing at /mcp/<profile>.
//
// The main agent's entry and everyone else's have different names on purpose.
// A new hire is a clone of the main profile, config and .env included, and
// Hermes shares one live connection between profiles whose entries are
// identical. Under a different name the clone's inherited entry is simply
// removed, which Hermes tears down on its next tick, instead of being edited
// in place, which Hermes would only notice on a reconnect. And the clone gets
// its own token first, so even an inherited entry Hermes picked up in the
// meantime is refused by the server rather than speaking as the main agent.

const DEFAULT_PROFILE = "default";
const MAIN_SERVER = "office3d_team";
const MEMBER_SERVER = "office3d";
const TOKEN_ENV = "OFFICE3D_MCP_TOKEN";

const isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/**
 * @param {object} deps
 * @param {any} deps.client
 * @param {(profile: string) => ({url: string, token: string} | null)} deps.endpointFor
 * @param {(message: string) => void} [deps.log]
 */
const createMcpAccess = ({ client, endpointFor, log = () => {} }) => {
  // What this process last wrote per profile; the .env value cannot be read
  // back (Hermes redacts it), so it is written once per process and whenever
  // the endpoint changes.
  const written = new Map();

  const serverNames = (profile) =>
    profile === DEFAULT_PROFILE ? { want: MAIN_SERVER, other: MEMBER_SERVER } : { want: MEMBER_SERVER, other: MAIN_SERVER };

  const inflight = new Map();

  /**
   * Brings one profile's MCP access up to date. Resolves to whether anything
   * was written; rejects on a Hermes error (callers log and retry on the next
   * sweep).
   */
  const ensure = (profile) => {
    // The startup sweep and a first listing can ask for the same profile at
    // once; one pass is enough.
    const running = inflight.get(profile);
    if (running) return running;
    const pass = ensureOnce(profile).finally(() => inflight.delete(profile));
    inflight.set(profile, pass);
    return pass;
  };

  const ensureOnce = async (profile) => {
    const endpoint = endpointFor(profile);
    if (!endpoint) return false;
    const { want, other } = serverNames(profile);
    const signature = `${endpoint.url}\n${endpoint.token}`;
    const listed = await client.dashboard("/api/mcp/servers", { query: { profile } });
    const servers = Array.isArray(listed?.servers) ? listed.servers.filter(isRecord) : [];
    const current = servers.find((server) => server.name === want);
    const stale = servers.some((server) => server.name === other && server.source !== "plugin");
    const entryOk = current && current.url === endpoint.url && current.enabled !== false && current.auth === "header";
    if (entryOk && !stale && written.get(profile) === signature) return false;

    // 1. Its own token, before anything can connect with an inherited one.
    await client.setProfileEnv(profile, TOKEN_ENV, endpoint.token);
    // 2. Its own entry (deep-merged: keys Office3D does not set stay).
    if (!entryOk) {
      await client.dashboard("/api/config", {
        method: "PUT",
        query: { profile },
        body: {
          config: {
            mcp_servers: {
              [want]: {
                url: endpoint.url,
                headers: { Authorization: `Bearer \${${TOKEN_ENV}}` },
                timeout: 90,
                connect_timeout: 20,
                enabled: true,
              },
            },
          },
        },
      });
    }
    // 3. The entry that is not its to have (the main agent's, on a clone).
    if (stale) {
      await client.dashboard(`/api/mcp/servers/${encodeURIComponent(other)}`, { method: "DELETE", query: { profile } }).catch((err) => {
        if (err?.status !== 404) throw err;
      });
    }
    written.set(profile, signature);
    log(`Office3D MCP access set up for ${profile}.`);
    return true;
  };

  const forget = (profile) => written.delete(profile);

  return { ensure, forget, MAIN_SERVER, MEMBER_SERVER, TOKEN_ENV };
};

module.exports = { createMcpAccess, MAIN_SERVER, MEMBER_SERVER, TOKEN_ENV };
