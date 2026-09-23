// Office3D's Model Context Protocol server: the tools Office3D gives its
// agents (team, proposals), served to Hermes over MCP.
//
// Transport: Streamable HTTP with plain JSON responses — every tool here
// answers in one step, so there is nothing to stream and no server-initiated
// messages. That is the smallest shape of the transport the spec allows: POST
// carries one JSON-RPC message (or, for 2025-03-26 clients, a batch), a
// request gets `application/json` back, a notification gets 202, and GET
// (the optional server→client stream) is 405. No session id is issued, so
// there is no session state to lose on restart.
//
// Protocol: the `initialize` handshake (revisions 2024-11-05 … 2025-11-25).
// Hermes offers the handshake first; the stateless 2026-07-28 envelope is not
// needed and `server/discover` answers "method not found", which every client
// treats as "use the handshake".
//
// Each agent authenticates as itself: the URL names its Hermes profile and the
// bearer token is derived from the office secret and that name, so one
// agent's token never works for another and nothing has to be stored.
//
// The listener is internal — loopback, or the compose network in Docker — and
// never published; the office's own port and access gate are not involved.

const http = require("node:http");
const crypto = require("node:crypto");

const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const LATEST_VERSION = SUPPORTED_VERSIONS[0];
const MAX_BODY_BYTES = 256 * 1024;
const TOOL_TIMEOUT_MS = 60_000;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_CALLS = 120;
const PROFILE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

const isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** The bearer token an agent presents to the MCP server. */
const deriveMcpToken = (secret, profile) =>
  crypto.createHmac("sha256", secret).update(`office3d:mcp:${profile}`).digest("hex");

const safeEqual = (a, b) => {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};

/** A tool failure the model should see and can act on (vs. a protocol error). */
class ToolError extends Error {}

/**
 * Checks tool arguments against the subset of JSON Schema the office's tools
 * use: an object with typed properties, required keys, string length limits
 * and enums. Returns the first problem, or null.
 */
const validateArgs = (schema, args) => {
  if (!isRecord(args)) return "arguments must be an object";
  const props = isRecord(schema?.properties) ? schema.properties : {};
  for (const key of Array.isArray(schema?.required) ? schema.required : []) {
    const value = args[key];
    if (value === undefined || value === null || (typeof value === "string" && !value.trim())) return `"${key}" is required`;
  }
  for (const [key, value] of Object.entries(args)) {
    const prop = props[key];
    if (!prop) {
      if (schema?.additionalProperties === false) return `unknown argument "${key}"`;
      continue;
    }
    if (value === undefined || value === null) continue;
    if (prop.type === "string") {
      if (typeof value !== "string") return `"${key}" must be a string`;
      if (typeof prop.maxLength === "number" && value.length > prop.maxLength) return `"${key}" is longer than ${prop.maxLength} characters`;
    } else if (prop.type === "integer" || prop.type === "number") {
      if (typeof value !== "number" || !Number.isFinite(value) || (prop.type === "integer" && !Number.isInteger(value))) return `"${key}" must be a ${prop.type}`;
    } else if (prop.type === "boolean" && typeof value !== "boolean") return `"${key}" must be a boolean`;
    if (Array.isArray(prop.enum) && !prop.enum.includes(value)) return `"${key}" must be one of ${prop.enum.join(", ")}`;
  }
  return null;
};

const withTimeout = (promise, ms) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new ToolError("The tool took too long; try again.")), ms);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
};

/**
 * @param {object} opts
 * @param {string} opts.secret                 office secret the agent tokens derive from
 * @param {(profile: string) => Promise<boolean>} opts.profileExists
 * @param {(profile: string) => Array<{name: string, description: string, inputSchema: object, handler: (args: any, ctx: {profile: string}) => Promise<{text: string, data?: object}>}>} opts.toolsFor
 * @param {string} [opts.version]
 * @param {(message: string) => void} [opts.log]
 * @param {(message: string, error?: unknown) => void} [opts.logError]
 */
const createMcpHandler = ({ secret, profileExists, toolsFor, version = "0.0.0", log = () => {}, logError = () => {} }) => {
  const calls = new Map(); // profile -> timestamps of recent tool calls

  const rateLimited = (profile) => {
    const now = Date.now();
    const recent = (calls.get(profile) ?? []).filter((at) => now - at < RATE_WINDOW_MS);
    const limited = recent.length >= RATE_MAX_CALLS;
    if (!limited) recent.push(now);
    calls.set(profile, recent);
    return limited;
  };

  const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
  const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });

  const callTool = async (profile, params) => {
    const name = typeof params?.name === "string" ? params.name : "";
    const tool = toolsFor(profile).find((candidate) => candidate.name === name);
    if (!tool) return { error: [INVALID_PARAMS, `Unknown tool: ${name || "(none)"}`] };
    const args = params?.arguments ?? {};
    const problem = validateArgs(tool.inputSchema, args);
    if (problem) return { result: { content: [{ type: "text", text: `Invalid arguments: ${problem}.` }], isError: true } };
    if (rateLimited(profile)) {
      return { result: { content: [{ type: "text", text: "Too many Office3D tool calls in the last minute; wait and try again." }], isError: true } };
    }
    const started = Date.now();
    try {
      const out = await withTimeout(Promise.resolve(tool.handler(args, { profile })), TOOL_TIMEOUT_MS);
      log(`mcp ${profile} ${name} ok ${Date.now() - started}ms`);
      const result = { content: [{ type: "text", text: String(out?.text ?? "") }] };
      if (isRecord(out?.data)) result.structuredContent = out.data;
      return { result };
    } catch (err) {
      const known = err instanceof ToolError || err?.name === "AdapterError";
      if (!known) logError(`mcp ${profile} ${name} failed`, err);
      else log(`mcp ${profile} ${name} refused ${Date.now() - started}ms: ${err.message}`);
      const text = known ? err.message : "Office3D could not complete the tool call.";
      return { result: { content: [{ type: "text", text }], isError: true } };
    }
  };

  /** One JSON-RPC message → a response object, or null for a notification. */
  const dispatch = async (profile, message) => {
    if (!isRecord(message) || message.jsonrpc !== "2.0") return rpcError(isRecord(message) ? message.id : null, INVALID_REQUEST, "Invalid JSON-RPC message");
    const isNotification = message.id === undefined;
    if (typeof message.method !== "string") {
      // A response to a server request; this server sends none.
      return isNotification ? null : rpcError(message.id, INVALID_REQUEST, "Unexpected message");
    }
    if (isNotification) return null;
    const { id, method } = message;
    const params = isRecord(message.params) ? message.params : {};
    switch (method) {
      case "initialize": {
        const offered = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
        return rpcResult(id, {
          protocolVersion: SUPPORTED_VERSIONS.includes(offered) ? offered : LATEST_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "office3d", title: "Office3D", version },
          instructions: "Office3D organization tools: the team, and proposals that wait for the person's decision.",
        });
      }
      case "ping":
        return rpcResult(id, {});
      case "tools/list":
        return rpcResult(id, {
          tools: toolsFor(profile).map(({ name, description, inputSchema, annotations }) => ({
            name,
            description,
            inputSchema,
            ...(annotations ? { annotations } : {}),
          })),
        });
      case "tools/call": {
        const outcome = await callTool(profile, params);
        return outcome.error ? rpcError(id, outcome.error[0], outcome.error[1]) : rpcResult(id, outcome.result);
      }
      default:
        return rpcError(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  };

  const send = (res, status, body, headers = {}) => {
    const payload = body === undefined ? "" : JSON.stringify(body);
    res.writeHead(status, {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      "Cache-Control": "no-store",
      ...headers,
    });
    res.end(payload);
  };

  // An oversized body is refused with a 413 the client can read: the rest of
  // it is drained (not buffered) and the connection closed after the reply.
  const tooLarge = () => Object.assign(new Error("too large"), { status: 413 });
  const readBody = (req) =>
    new Promise((resolve, reject) => {
      if (Number(req.headers["content-length"] ?? 0) > MAX_BODY_BYTES) {
        req.resume();
        reject(tooLarge());
        return;
      }
      const chunks = [];
      let size = 0;
      let refused = false;
      req.on("data", (chunk) => {
        if (refused) return;
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          refused = true;
          chunks.length = 0;
          reject(tooLarge());
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        if (!refused) resolve(Buffer.concat(chunks).toString("utf8"));
      });
      req.on("error", reject);
    });

  /** The authenticated profile of a request, or null (and the response is sent). */
  const authenticate = async (req, res, profile) => {
    // Browsers never talk to this server; a request with an Origin is a
    // DNS-rebinding attempt or a misconfiguration.
    if (req.headers.origin) {
      send(res, 403, rpcError(null, INVALID_REQUEST, "Forbidden"));
      return null;
    }
    const header = String(req.headers.authorization ?? "");
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!PROFILE_RE.test(profile) || !token || !safeEqual(token, deriveMcpToken(secret, profile))) {
      send(res, 401, rpcError(null, INVALID_REQUEST, "Unauthorized"), { "WWW-Authenticate": 'Bearer realm="office3d"' });
      return null;
    }
    if (!(await profileExists(profile).catch(() => false))) {
      // A dismissed agent's config may still hold its entry for a while.
      send(res, 403, rpcError(null, INVALID_REQUEST, "This agent is no longer on the team"));
      return null;
    }
    return profile;
  };

  /** Handles /mcp/<profile>; returns false for any other path. */
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://office3d.internal");
    if (url.pathname === "/health") {
      send(res, 200, { ok: true });
      return true;
    }
    const match = url.pathname.match(/^\/mcp\/([^/]+)\/?$/);
    if (!match) return false;
    const profile = decodeURIComponent(match[1]);
    try {
      if (req.method !== "POST") {
        // No server→client stream (GET) and no sessions to end (DELETE).
        send(res, 405, rpcError(null, INVALID_REQUEST, "Method not allowed"), { Allow: "POST" });
        return true;
      }
      if (!(await authenticate(req, res, profile))) return true;
      const headerVersion = req.headers["mcp-protocol-version"];
      if (headerVersion && !SUPPORTED_VERSIONS.includes(String(headerVersion))) {
        send(res, 400, rpcError(null, INVALID_REQUEST, `Unsupported MCP-Protocol-Version: ${headerVersion}`));
        return true;
      }
      let parsed;
      try {
        parsed = JSON.parse(await readBody(req));
      } catch (err) {
        if (err?.status === 413) send(res, 413, rpcError(null, INVALID_REQUEST, "Request too large"), { Connection: "close" });
        else send(res, 400, rpcError(null, PARSE_ERROR, "Parse error"));
        return true;
      }
      if (Array.isArray(parsed)) {
        if (parsed.length === 0) {
          send(res, 400, rpcError(null, INVALID_REQUEST, "Empty batch"));
          return true;
        }
        const responses = (await Promise.all(parsed.map((message) => dispatch(profile, message)))).filter(Boolean);
        if (responses.length === 0) send(res, 202);
        else send(res, 200, responses);
        return true;
      }
      const response = await dispatch(profile, parsed);
      if (response) send(res, 200, response);
      else send(res, 202);
    } catch (err) {
      logError("MCP request failed.", err);
      if (!res.headersSent) send(res, 500, rpcError(null, INTERNAL_ERROR, "Internal error"));
    }
    return true;
  };
};

/**
 * Starts the MCP listener. Resolves once it is listening.
 * @param {{host: string, port: number, handler: (req: any, res: any) => Promise<boolean>}} opts
 */
const startMcpServer = async ({ host, port, handler }) => {
  const server = http.createServer((req, res) => {
    handler(req, res)
      .then((handled) => {
        if (handled) return;
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
      })
      .catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
  });
  server.requestTimeout = TOOL_TIMEOUT_MS + 10_000;
  server.headersTimeout = 15_000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  return {
    server,
    port: typeof address === "object" && address ? address.port : port,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
};

module.exports = { createMcpHandler, startMcpServer, deriveMcpToken, validateArgs, ToolError, SUPPORTED_VERSIONS };
