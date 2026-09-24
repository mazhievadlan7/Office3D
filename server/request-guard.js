// Checks on where a request comes from, before any authentication:
//
// - WebSocket upgrades from a browser must come from this site's own pages
//   (Origin equals Host), so another site open in the same browser cannot
//   drive the office through the person's session (cross-site WebSocket
//   hijacking). Clients that send no Origin (scripts) are not browsers.
// - Without an access token the office serves only loopback, and then only
//   requests addressed to a loopback name are answered: a public DNS name
//   rebound to 127.0.0.1 cannot read the office from another site.
// - X-Forwarded-For is believed only from the reverse proxy named in
//   TRUSTED_PROXY_HOSTS (resolved periodically), not from any peer that can
//   reach the port — agents' tools included.

const dns = require("node:dns");

const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

const hostnameOf = (hostHeader) => {
  const raw = String(hostHeader ?? "").trim().toLowerCase();
  if (!raw) return "";
  if (raw.startsWith("[")) return raw.slice(0, raw.indexOf("]") + 1);
  return raw.split(":")[0];
};

const isLoopbackName = (name) => LOOPBACK_NAMES.has(name) || /^127\.\d+\.\d+\.\d+$/.test(name) || name.endsWith(".localhost");

/**
 * @param {object} [options]
 * @param {string[]} [options.allowedOrigins]  extra origins allowed to open WebSockets (OFFICE3D_ALLOWED_ORIGINS)
 */
const createRequestGuard = ({ allowedOrigins = [] } = {}) => {
  const extra = new Set(allowedOrigins.map((origin) => origin.trim().replace(/\/+$/, "").toLowerCase()).filter(Boolean));

  /** Whether a WebSocket upgrade may proceed, judged by its Origin. */
  const allowWebSocketOrigin = (req) => {
    const origin = req.headers?.origin;
    if (origin === undefined) return true;
    let parsed;
    try {
      parsed = new URL(String(origin));
    } catch {
      return false;
    }
    if (extra.has(parsed.origin.toLowerCase())) return true;
    return parsed.host.toLowerCase() === String(req.headers?.host ?? "").trim().toLowerCase();
  };

  /** Whether a request is addressed to a loopback name (for the token-less local mode). */
  const addressedToLoopback = (req) => isLoopbackName(hostnameOf(req.headers?.host));

  return { allowWebSocketOrigin, addressedToLoopback };
};

/**
 * The addresses of the trusted reverse proxy, refreshed every minute.
 * Without names, `isTrusted` is null: X-Forwarded-For is then believed from
 * any peer when TRUSTED_PROXY=1 (the behaviour of older setups).
 */
const createTrustedProxies = ({ hosts, lookup = dns.promises.lookup, log = () => {} }) => {
  const names = hosts.map((host) => host.trim()).filter(Boolean);
  if (!names.length) return { isTrusted: null, close: () => {} };
  let addresses = new Set();
  const refresh = async () => {
    const next = new Set();
    for (const name of names) {
      try {
        for (const entry of await lookup(name, { all: true })) {
          next.add(entry.address);
          if (entry.family === 4) next.add(`::ffff:${entry.address}`);
        }
      } catch {
        // Not running (HTTPS profile off): nothing to trust.
      }
    }
    addresses = next;
  };
  void refresh().catch((err) => log(`Trusted proxy lookup failed: ${err.message}`));
  const timer = setInterval(() => void refresh(), 60_000);
  timer.unref?.();
  return { isTrusted: (ip) => addresses.has(String(ip ?? "")), refresh, close: () => clearInterval(timer) };
};

module.exports = { createRequestGuard, createTrustedProxies, hostnameOf, isLoopbackName };
