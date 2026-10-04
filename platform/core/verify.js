// Authorization Gateway — proof of asset ownership (§4.3).
//
// Before an engagement is authorized, the operator proves they control each
// asset. Two self-service proofs are strong evidence of control:
//
//   • DNS TXT   — a token in a TXT record on the domain (or _aegis-challenge.<domain>)
//   • HTTP file — the same token served at https://<host>/.well-known/aegis-challenge.txt
//
// The token is per-engagement and unguessable (HMAC of a persistent local
// secret and the engagement id), so it cannot be reused across engagements.
// WHOIS is offered too, but only as INFORMATIONAL context (registrar/org) —
// it is not proof of control.
//
// These checks contact only the operator's own declared asset with a harmless
// GET / DNS / WHOIS query — they are ownership proofs, not scanning, and they
// run in the control plane, never the sandboxed execution plane. Redirects are
// not followed and every call is bounded by a timeout and a size cap. The real
// enforcement boundary stays the scope matcher and the egress firewall; this
// gateway only decides whether an engagement MAY be authorized at all.

const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const dnsPromises = require("node:dns/promises");

const CHALLENGE_PREFIX = "aegis-verify=";
const WELL_KNOWN_PATH = "/.well-known/aegis-challenge.txt";
const TOKEN_LEN = 40;

/** A persistent per-install secret; the token derives from it so it survives restarts. */
const loadSecret = (dataDir, logError = () => {}) => {
  const file = path.join(dataDir, "verify-secret");
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing.length >= 32) return existing;
  } catch {
    // not created yet
  }
  const secret = crypto.randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, secret, { mode: 0o600 });
  } catch (err) {
    logError("AEGIS verify secret could not be persisted; using an in-memory one for now.", err);
  }
  return secret;
};

const tokenFor = (secret, engagementId) =>
  crypto.createHmac("sha256", secret).update(String(engagementId)).digest("hex").slice(0, TOKEN_LEN);

/** GET a bounded amount of a URL, no redirects; returns { ok, body?, status?, error? }. */
const defaultFetchFile = async (url, { timeoutMs = 5000, maxBytes = 4096 } = {}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      redirect: "manual",
      signal: controller.signal,
      headers: { "user-agent": "aegis-verify/1.0", accept: "text/plain" },
    });
    if (response.status >= 300) return { ok: false, status: response.status };
    const body = (await response.text()).slice(0, maxBytes);
    return { ok: true, body };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
};

/** One WHOIS query over TCP 43, bounded. */
const whoisQuery = (server, query, { timeoutMs = 6000, maxBytes = 8192 } = {}) =>
  new Promise((resolve) => {
    let data = "";
    let settled = false;
    const socket = net.connect(43, server);
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        // already gone
      }
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => finish({ ok: false, error: "timeout" }));
    socket.on("connect", () => socket.write(`${query}\r\n`));
    socket.on("data", (chunk) => {
      data += chunk.toString("utf8");
      if (data.length >= maxBytes) finish({ ok: true, text: data.slice(0, maxBytes) });
    });
    socket.on("end", () => finish({ ok: true, text: data }));
    socket.on("error", (error) => finish({ ok: false, error: error.message }));
  });

/** IANA referral then the registry WHOIS; informational only. */
const defaultWhois = async (domain) => {
  const iana = await whoisQuery("whois.iana.org", domain);
  if (!iana.ok) return iana;
  const refer = (iana.text.match(/refer:\s*(\S+)/i) || [])[1];
  if (!refer) return iana;
  const registry = await whoisQuery(refer, domain);
  return registry.ok ? registry : iana;
};

const fieldFrom = (text, labels) => {
  for (const label of labels) {
    const match = text.match(new RegExp(`^\\s*${label}:\\s*(.+)$`, "im"));
    if (match) return match[1].trim();
  }
  return null;
};

/**
 * @param {object} deps
 * @param {string} deps.dataDir
 * @param {(name: string) => Promise<string[][]>} [deps.resolveTxt]
 * @param {(url: string) => Promise<{ok: boolean, body?: string, status?: number, error?: string}>} [deps.fetchFile]
 * @param {(domain: string) => Promise<{ok: boolean, text?: string, error?: string}>} [deps.whois]
 * @param {() => number} [deps.now]
 * @param {(m: string, e?: unknown) => void} [deps.logError]
 */
const createVerifier = ({
  dataDir,
  resolveTxt = (name) => dnsPromises.resolveTxt(name),
  fetchFile = defaultFetchFile,
  whois = defaultWhois,
  now = () => Date.now(),
  logError = () => {},
} = {}) => {
  if (!dataDir) throw new Error("AEGIS verifier needs a dataDir.");
  const secret = loadSecret(dataDir, logError);
  const token = (engagementId) => tokenFor(secret, engagementId);
  const challenge = (engagementId) => CHALLENGE_PREFIX + token(engagementId);

  // domain / url(domain host) can use DNS; anything with a concrete host can use the file.
  const hostForAsset = (asset) => {
    if (!asset || typeof asset !== "object") return null;
    if (asset.kind === "domain") return { domain: asset.value, host: asset.value };
    if (asset.kind === "ip") return { domain: null, host: asset.value };
    if (asset.kind === "url") return { domain: asset.isIpHost ? null : asset.host, host: asset.host };
    return { domain: null, host: null }; // cidr: no single host to probe
  };

  const checkDns = async (domain, tok) => {
    if (!domain) return { ok: false, reason: "DNS-проверка возможна только для домена" };
    for (const name of [domain, `_aegis-challenge.${domain}`]) {
      try {
        const records = await resolveTxt(name);
        for (const chunks of records || []) {
          const value = Array.isArray(chunks) ? chunks.join("") : String(chunks);
          if (value.includes(tok)) return { ok: true, name, value };
        }
      } catch {
        // try the next name
      }
    }
    return { ok: false, reason: "TXT-запись с токеном не найдена" };
  };

  const checkFile = async (host, tok) => {
    if (!host) return { ok: false, reason: "нет хоста для проверки файлом" };
    for (const scheme of ["https", "http"]) {
      const url = `${scheme}://${host}${WELL_KNOWN_PATH}`;
      const result = await fetchFile(url);
      if (result.ok && typeof result.body === "string" && result.body.includes(tok)) return { ok: true, url };
    }
    return { ok: false, reason: "файл .well-known с токеном не найден" };
  };

  const lookupWhois = async (domain) => {
    if (!domain) return { ok: false, reason: "WHOIS доступен только для домена" };
    const result = await whois(domain);
    if (!result.ok) return { ok: false, reason: result.error || "WHOIS недоступен" };
    return {
      ok: true,
      informational: true,
      registrar: fieldFrom(result.text, ["Registrar", "registrar"]),
      org: fieldFrom(result.text, ["Registrant Organization", "org", "OrgName", "organization"]),
      updated: fieldFrom(result.text, ["Updated Date", "changed", "last-update"]),
    };
  };

  /**
   * Run one ownership check for one asset of an engagement.
   * @param {{engagementId: string, method: "dns"|"file"|"whois", asset: object}} request
   */
  const check = async ({ engagementId, method, asset }) => {
    const tok = token(engagementId);
    const where = hostForAsset(asset);
    const checkedAt = now();
    let outcome;
    if (method === "dns") outcome = await checkDns(where?.domain ?? null, tok);
    else if (method === "file") outcome = await checkFile(where?.host ?? null, tok);
    else if (method === "whois") outcome = await lookupWhois(where?.domain ?? null);
    else outcome = { ok: false, reason: `неизвестный метод: ${method}` };
    return {
      method,
      assetId: asset?.id ?? null,
      assetValue: asset?.value ?? null,
      ok: outcome.ok === true,
      informational: outcome.informational === true,
      detail: outcome,
      checkedAt,
    };
  };

  return { token, challenge, wellKnownPath: WELL_KNOWN_PATH, check };
};

module.exports = { createVerifier, tokenFor, CHALLENGE_PREFIX, WELL_KNOWN_PATH };
