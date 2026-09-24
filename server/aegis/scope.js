// Scope model and target matcher — the heart of the legal core.
//
// An engagement authorizes a set of assets (domains, IPs, CIDR ranges, URLs).
// Every active action an agent proposes is checked here against the active
// engagement's assets. The rule is default-deny: a target is refused unless it
// unambiguously matches an authorized asset. The offensive execution plane
// (Phase 1) calls this before it may run any tool against any target.
//
// Deliberate separation: a DOMAIN target is matched only against domain/url
// assets, and an IP target only against ip/cidr/url assets. Domains are NOT
// resolved to IPs here — resolution-time enforcement is the egress firewall's
// job (see egress.js). This keeps the decision honest and free of DNS races.

const { parseIp, isIp, parseCidr, ipInCidr } = require("./ip");
const { invalid } = require("./errors");

const nodeUrl = require("node:url");

const ASSET_KINDS = new Set(["domain", "ip", "cidr", "url"]);
const MAX_ASSETS = 5000;
const MAX_PORTS = 128;

/**
 * Normalize a domain to lowercase punycode, or null if it is not a valid
 * hostname. Strips a trailing dot; refuses IP literals, empty labels, and any
 * character outside the hostname set.
 * @param {unknown} input
 * @returns {string|null}
 */
const normalizeDomain = (input) => {
  let raw = String(input ?? "").trim().toLowerCase();
  if (raw.endsWith(".")) raw = raw.slice(0, -1);
  if (!raw || raw.length > 253) return null;
  if (isIp(raw)) return null; // domains only
  const ascii = nodeUrl.domainToASCII(raw);
  if (!ascii) return null;
  if (!/^[a-z0-9.-]+$/.test(ascii)) return null;
  if (ascii.startsWith(".") || ascii.endsWith(".") || ascii.includes("..")) return null;
  if (ascii.split(".").some((label) => label.length === 0 || label.length > 63)) return null;
  return ascii;
};

const canonicalIp = (input) => {
  const ip = parseIp(String(input ?? "").trim());
  if (!ip) return null;
  return { version: ip.version, value: ip.value };
};

const samePorts = (input) => {
  if (input === undefined || input === null) return null; // null = any port
  if (!Array.isArray(input)) throw invalid("Порты актива — это список чисел.");
  if (input.length > MAX_PORTS) throw invalid("Слишком много портов у одного актива.");
  const ports = [];
  for (const value of input) {
    if (!Number.isInteger(value) || value < 1 || value > 65535) throw invalid(`Неверный порт: ${value}.`);
    ports.push(value);
  }
  return ports.length ? [...new Set(ports)].sort((a, b) => a - b) : null;
};

const portField = (ports, target) => {
  if (!ports) return true; // asset allows any port
  if (!Number.isInteger(target)) return false; // asset restricts ports; an unspecified target port cannot be proven in-scope
  return ports.includes(target);
};

/**
 * Validate and canonicalize one asset for storage. Throws AegisError on bad
 * input. The stored form is plain JSON (no BigInt) — matching re-parses on
 * demand, which is cheap for the small asset sets a real engagement holds.
 * @param {object} input
 * @returns {object}
 */
const validateAsset = (input) => {
  if (!input || typeof input !== "object") throw invalid("Актив должен быть объектом.");
  const kind = String(input.kind ?? "").trim().toLowerCase();
  if (!ASSET_KINDS.has(kind)) throw invalid(`Неизвестный тип актива: ${kind || "(пусто)"}.`);
  const ports = samePorts(input.ports);
  const note = input.note === undefined ? "" : String(input.note).slice(0, 500);

  if (kind === "domain") {
    const value = normalizeDomain(input.value);
    if (!value) throw invalid(`Неверный домен: ${String(input.value ?? "")}.`);
    return { kind, value, includeSubdomains: input.includeSubdomains === true, ports, note };
  }
  if (kind === "ip") {
    const ip = canonicalIp(input.value);
    if (!ip) throw invalid(`Неверный IP-адрес: ${String(input.value ?? "")}.`);
    return { kind, value: String(input.value).trim(), ports, note };
  }
  if (kind === "cidr") {
    const cidr = parseCidr(String(input.value ?? "").trim());
    if (!cidr) throw invalid(`Неверный CIDR: ${String(input.value ?? "")}.`);
    if (cidr.prefix < 8) throw invalid("Слишком широкий диапазон CIDR (нельзя авторизовать пол-интернета); используйте /8 или уже.");
    return { kind, value: String(input.value).trim(), ports, note };
  }
  // url
  let parsed;
  try {
    parsed = new URL(String(input.value ?? ""));
  } catch {
    throw invalid(`Неверный URL: ${String(input.value ?? "")}.`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) throw invalid("URL должен быть http(s).");
  const rawHost = parsed.hostname.replace(/^\[|\]$/g, "");
  const host = isIp(rawHost) ? (canonicalIp(rawHost) ? rawHost : null) : normalizeDomain(rawHost);
  if (!host) throw invalid(`Неверный хост в URL: ${parsed.hostname}.`);
  const urlPorts = parsed.port ? samePorts([Number(parsed.port)]) : ports;
  const pathPrefix = parsed.pathname && parsed.pathname !== "/" ? parsed.pathname : "";
  return {
    kind,
    value: host,
    host,
    isIpHost: isIp(rawHost),
    includeSubdomains: input.includeSubdomains === true,
    pathPrefix,
    ports: urlPorts,
    note,
  };
};

/**
 * Parse a target into { host, ip, port, path } for matching, or null if it
 * cannot be understood (default-deny). Accepts a structured object or a string
 * (a full URL, a host, or host:port / [v6]:port).
 * @param {string|object} input
 * @returns {{host: string|null, ip: {version:4|6,value:bigint}|null, port: number|null, path: string}|null}
 */
const parseTarget = (input) => {
  let host;
  let port = null;
  let path = "/";

  if (input && typeof input === "object") {
    host = input.host;
    port = input.port === undefined || input.port === null ? null : Number(input.port);
    if (input.path !== undefined) path = String(input.path) || "/";
  } else {
    const text = String(input ?? "").trim();
    if (!text) return null;
    if (text.includes("://")) {
      let parsed;
      try {
        parsed = new URL(text);
      } catch {
        return null;
      }
      host = parsed.hostname.replace(/^\[|\]$/g, "");
      port = parsed.port ? Number(parsed.port) : null;
      path = parsed.pathname || "/";
    } else if (text.startsWith("[")) {
      const end = text.indexOf("]");
      if (end === -1) return null;
      host = text.slice(1, end);
      const rest = text.slice(end + 1);
      if (rest.startsWith(":")) port = Number(rest.slice(1));
      else if (rest !== "") return null;
    } else {
      const colon = text.indexOf(":");
      if (colon !== -1 && text.indexOf(":") === text.lastIndexOf(":")) {
        host = text.slice(0, colon);
        port = Number(text.slice(colon + 1));
      } else {
        host = text; // bare host (domain or IPv6 literal without brackets)
      }
    }
  }

  if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) return null;

  const rawHost = String(host ?? "").trim();
  if (!rawHost) return null;
  const ip = canonicalIp(rawHost);
  if (ip) return { host: null, ip, port, path };
  const domain = normalizeDomain(rawHost);
  if (domain) return { host: domain, ip: null, port, path };
  return null;
};

const domainMatches = (asset, targetHost) => {
  if (asset.value === targetHost) return true;
  return asset.includeSubdomains === true && targetHost.endsWith(`.${asset.value}`);
};

/**
 * Decide whether a target is inside an engagement's authorized assets.
 * @param {object[]} assets  canonical assets (from validateAsset)
 * @param {string|object} targetInput
 * @returns {{allowed: boolean, reason: string, asset?: object}}
 */
const matchTarget = (assets, targetInput) => {
  const target = parseTarget(targetInput);
  if (!target) return { allowed: false, reason: "цель не распознана" };
  const list = Array.isArray(assets) ? assets : [];

  for (const asset of list) {
    if (asset.kind === "domain") {
      if (target.host && domainMatches(asset, target.host) && portField(asset.ports, target.port)) {
        return { allowed: true, reason: "домен в scope", asset };
      }
    } else if (asset.kind === "ip") {
      if (target.ip) {
        const assetIp = canonicalIp(asset.value);
        if (assetIp && assetIp.version === target.ip.version && assetIp.value === target.ip.value && portField(asset.ports, target.port)) {
          return { allowed: true, reason: "IP в scope", asset };
        }
      }
    } else if (asset.kind === "cidr") {
      if (target.ip) {
        const cidr = parseCidr(asset.value);
        if (cidr && ipInCidr(target.ip, cidr) && portField(asset.ports, target.port)) {
          return { allowed: true, reason: "IP в диапазоне scope", asset };
        }
      }
    } else if (asset.kind === "url") {
      const hostOk = asset.isIpHost
        ? target.ip && (() => { const a = canonicalIp(asset.host); return a && a.version === target.ip.version && a.value === target.ip.value; })()
        : target.host && domainMatches(asset, target.host);
      const pathOk = !asset.pathPrefix || (typeof target.path === "string" && target.path.startsWith(asset.pathPrefix));
      if (hostOk && pathOk && portField(asset.ports, target.port)) {
        return { allowed: true, reason: "URL в scope", asset };
      }
    }
  }
  return { allowed: false, reason: "цель вне авторизованного scope" };
};

module.exports = { validateAsset, parseTarget, matchTarget, normalizeDomain, ASSET_KINDS, MAX_ASSETS };
