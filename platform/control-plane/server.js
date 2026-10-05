// Control-plane HTTP service (Phase 0) — the gate the future Execution Plane
// must call before any tool runs.
//
// This is the standalone, always-on front door to the AEGIS Security Core
// (platform/core). It is DELIBERATELY minimal and defensive:
//
//   • bound to 127.0.0.1 only (the bin passes host "127.0.0.1"), and every
//     request is re-checked to come from a loopback peer — a non-loopback peer
//     is refused outright;
//   • token-gated: all /v1/* endpoints require the PLATFORM_TOKEN bearer token
//     (constant-time compared). /health is loopback-only but unauthenticated so
//     a liveness probe needs no secret;
//   • it holds NO offensive capability — it only reuses createAegisCore to
//     answer yes/no (preflight), manage engagements with the customer's manual
//     activation, flip the kill-switch, render the egress allowlist, verify the
//     audit chain, and emit the governance system prompt from the single source.
//
// NOTE (TZ §II.5): the TZ's long-term control-plane target is Go. This Phase-0
// service is Node so it can reuse the proven JS core verbatim; the HTTP contract
// below is what a later Go reimplementation would preserve.

const http = require("node:http");
const crypto = require("node:crypto");

const MAX_BODY_BYTES = 1_000_000;

const isLoopback = (address) => {
  if (!address) return false;
  const addr = String(address);
  return (
    addr === "127.0.0.1" ||
    addr === "::1" ||
    addr === "::ffff:127.0.0.1" ||
    addr.startsWith("127.")
  );
};

const timingSafeEqual = (a, b) => {
  const ba = Buffer.from(String(a ?? ""), "utf8");
  const bb = Buffer.from(String(b ?? ""), "utf8");
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
};

const presentedToken = (req) => {
  const auth = req.headers["authorization"];
  if (typeof auth === "string" && auth.startsWith("Bearer ")) return auth.slice(7).trim();
  const header = req.headers["x-platform-token"];
  return typeof header === "string" ? header.trim() : "";
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("payload too large"), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error("invalid JSON body"), { statusCode: 400 }));
      }
    });
    req.on("error", reject);
  });

/**
 * @param {object} deps
 * @param {ReturnType<import("../core/index.js").createAegisCore>} deps.core
 * @param {ReturnType<import("../orchestrator/index.js").createOrchestrator>} [deps.orchestrator]  task-routing control plane
 * @param {string} deps.token  the PLATFORM_TOKEN; required (non-empty)
 * @param {(entry: object) => void} [deps.log]  structured logger (one JSON object per call)
 */
const createControlPlaneServer = ({ core, orchestrator = null, token, log = () => {} }) => {
  if (!core) throw new Error("control-plane needs a core");
  if (!token) throw new Error("control-plane needs a PLATFORM_TOKEN");

  const errorStatus = (err) => {
    if (err && err.name === "AegisError") {
      switch (err.code) {
        case "INVALID_INPUT":
          return 400;
        case "NOT_FOUND":
          return 404;
        case "CONFLICT":
          return 409;
        case "FORBIDDEN":
        case "DENIED":
          return 403;
        case "UNAVAILABLE":
          return 503;
        default:
          return 400;
      }
    }
    return typeof err?.statusCode === "number" ? err.statusCode : 500;
  };

  const handler = async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url, "http://127.0.0.1");
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method || "GET";
    let status = 200;

    const send = (code, payload) => {
      status = code;
      const body = JSON.stringify(payload);
      res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(body);
    };

    try {
      // Defense in depth: never serve a non-loopback peer, even if a proxy or
      // misconfigured bind exposed us.
      if (!isLoopback(req.socket.remoteAddress)) {
        send(403, { error: "forbidden", reason: "control-plane принимает только loopback-подключения" });
        return;
      }

      // /health is the only unauthenticated route (loopback-only liveness).
      if (pathname === "/health" && method === "GET") {
        send(200, { ok: true, service: "aegis-control-plane", phase: 0, now: new Date().toISOString(), security: core.securityStatus() });
        return;
      }

      // Everything else is token-gated.
      if (!timingSafeEqual(presentedToken(req), token)) {
        send(401, { error: "unauthorized", reason: "нужен действительный PLATFORM_TOKEN" });
        return;
      }

      const body = method === "GET" || method === "DELETE" ? {} : await readBody(req);
      await route({ method, pathname, url, body, send });
    } catch (err) {
      send(errorStatus(err), { error: err?.code ?? "error", reason: err?.message ?? String(err) });
    } finally {
      log({ at: new Date().toISOString(), method, path: pathname, status, ms: Date.now() - started, peer: req.socket.remoteAddress });
    }
  };

  // --- routing -------------------------------------------------------------
  const route = async ({ method, pathname, url, body, send }) => {
    const seg = pathname.split("/").filter(Boolean); // e.g. ["v1","engagements","eng_x","activate"]

    if (seg[0] !== "v1") return send(404, { error: "not_found", reason: `нет маршрута ${pathname}` });

    // POST /v1/preflight — the gate the Execution Plane must call.
    if (seg.length === 2 && seg[1] === "preflight" && method === "POST") {
      return send(200, core.preflight.check(body));
    }

    // GET/POST /v1/killswitch
    if (seg.length === 2 && seg[1] === "killswitch") {
      if (method === "GET") return send(200, core.engagements.getKillSwitch());
      if (method === "POST") return send(200, await core.engagements.setGlobalKill(body));
    }

    // GET /v1/audit, GET /v1/audit/verify
    if (seg[1] === "audit") {
      if (seg.length === 3 && seg[2] === "verify" && method === "GET") return send(200, core.verifyAudit());
      if (seg.length === 2 && method === "GET") {
        const engagementId = url.searchParams.get("engagementId") || undefined;
        const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined;
        return send(200, { entries: core.audit.list({ engagementId, limit }) });
      }
    }

    // GET /v1/egress/:engagementId — nftables render + allowlist
    if (seg[1] === "egress" && seg.length === 3 && method === "GET") {
      const id = seg[2];
      return send(200, { allowlist: core.egressAllowlist(id), nftables: core.renderEgressNftables(id) });
    }

    // GET /v1/governance/system-prompt?engagementId= — single source (governance.js)
    if (seg[1] === "governance" && seg[2] === "system-prompt" && method === "GET") {
      const engagementId = url.searchParams.get("engagementId") || undefined;
      const { RULES, composeSystemPrompt } = require("../core/governance.js");
      const engagement = engagementId ? core.engagements.get(engagementId) : null;
      return send(200, { rules: RULES, prompt: composeSystemPrompt({ engagement, agentName: url.searchParams.get("agent") || "" }) });
    }

    // --- orchestrator: work items, board, capability registry -----------------
    // All loopback-only + token-gated like the rest; every transition is audited
    // inside the orchestrator, and acting transitions pass preflight (fail-closed).
    if (seg[1] === "work-items" || seg[1] === "board" || seg[1] === "registry") {
      if (!orchestrator) return send(503, { error: "unavailable", reason: "оркестратор не подключён" });

      // GET /v1/board — board summary + open items
      if (seg[1] === "board" && seg.length === 2 && method === "GET") {
        const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined;
        return send(200, { summary: orchestrator.summary(), items: orchestrator.listItems({ open: true, limit }) });
      }

      // GET /v1/registry — list; GET /v1/registry/:unit/:role — one capsule
      if (seg[1] === "registry" && method === "GET") {
        if (seg.length === 2) return send(200, { source: orchestrator.registry.source, entries: orchestrator.registry.list() });
        if (seg.length === 4) {
          const entry = orchestrator.registry.get(seg[2], seg[3]);
          return entry ? send(200, entry) : send(404, { error: "not_found", reason: `нет записи реестра для ${seg[2]}:${seg[3]}` });
        }
      }

      // /v1/work-items ...
      if (seg[1] === "work-items") {
        if (seg.length === 2) {
          if (method === "GET") {
            const filter = {};
            if (url.searchParams.has("unit")) filter.unit = Number(url.searchParams.get("unit"));
            if (url.searchParams.has("status")) filter.status = url.searchParams.get("status");
            if (url.searchParams.has("kind")) filter.kind = url.searchParams.get("kind");
            if (url.searchParams.has("engagementId")) filter.engagementId = url.searchParams.get("engagementId");
            if (url.searchParams.get("open") === "true") filter.open = true;
            if (url.searchParams.has("limit")) filter.limit = Number(url.searchParams.get("limit"));
            return send(200, { items: orchestrator.listItems(filter) });
          }
          if (method === "POST") return send(201, orchestrator.createItem(body));
        }
        const id = seg[2];
        if (id) {
          if (seg.length === 3 && method === "GET") {
            const item = orchestrator.getItem(id);
            return item ? send(200, item) : send(404, { error: "not_found", reason: `рабочий элемент не найден: ${id}` });
          }
          const action = seg[3];
          if (seg.length === 4 && method === "POST") {
            // quarantine is a Карцер hook, not a state-machine transition.
            if (action === "quarantine") return send(200, orchestrator.quarantine(id, body));
            if (orchestrator.ACTIONS.includes(action)) return send(200, orchestrator.transition(id, action, body));
            return send(404, { error: "not_found", reason: `неизвестный переход: ${action}` });
          }
        }
      }
    }

    // /v1/engagements ...
    if (seg[1] === "engagements") {
      if (seg.length === 2) {
        if (method === "GET") return send(200, { engagements: core.engagements.list() });
        if (method === "POST") return send(201, await core.engagements.create(body));
      }
      const id = seg[2];
      if (id) {
        if (seg.length === 3) {
          if (method === "GET") {
            const eng = core.engagements.get(id);
            return eng ? send(200, eng) : send(404, { error: "not_found", reason: `engagement не найден: ${id}` });
          }
        }
        const sub = seg[3];
        if (seg.length === 4 && method === "POST") {
          if (sub === "assets") return send(200, await core.engagements.addAsset(id, body));
          if (sub === "authorize") return send(200, await core.engagements.recordAuthorization(id, body));
          if (sub === "activate") return send(200, await core.engagements.activate(id, body)); // manual: confirm:true
          if (sub === "deactivate") return send(200, await core.engagements.stop(id, body));
          if (sub === "reactivate") return send(200, await core.engagements.reactivate(id, body));
          if (sub === "complete") return send(200, await core.engagements.complete(id, body));
        }
        if (seg.length === 5 && sub === "assets" && method === "DELETE") {
          return send(200, await core.engagements.removeAsset(id, seg[4]));
        }
      }
    }

    return send(404, { error: "not_found", reason: `нет маршрута ${method} ${pathname}` });
  };

  const server = http.createServer(handler);
  return server;
};

module.exports = { createControlPlaneServer, isLoopback, MAX_BODY_BYTES };
