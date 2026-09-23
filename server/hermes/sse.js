// Server-Sent Events reader for the Hermes API.
//
// Hermes streams run events (GET /v1/runs/{id}/events) as SSE. It sends a
// ": keepalive" comment every 10 s while a tool runs, so a stream that is quiet
// for much longer than that is dead rather than busy; readSse turns such a
// silence into an error instead of hanging on it forever.

const { TextDecoder } = require("node:util");

class SseIdleTimeoutError extends Error {
  constructor(idleMs) {
    super(`No data from the event stream for ${Math.round(idleMs / 1000)} s.`);
    this.name = "SseIdleTimeoutError";
    this.code = "sse_idle_timeout";
  }
}

/**
 * Parses one SSE block (the lines between two blank lines). Returns null for a
 * block that carries no data — comments, keepalives, a lone "id:".
 */
const parseSseBlock = (block) => {
  let event = "message";
  let id = null;
  const data = [];
  for (const line of block.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value || "message";
    else if (field === "data") data.push(value);
    else if (field === "id") id = value;
  }
  if (data.length === 0) return null;
  const raw = data.join("\n");
  let parsed = raw;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Not JSON: hand the text over as it is.
  }
  return { event, id, data: parsed };
};

/**
 * Yields { event, id, data } for every event in a fetch Response body.
 *
 * idleTimeoutMs bounds the silence between chunks (keepalives count as
 * chunks). The caller's AbortSignal ends the stream early; the reader is
 * always released, so an abandoned stream never pins the connection.
 */
async function* readSse(body, { idleTimeoutMs = 45_000, signal } = {}) {
  if (!body || typeof body.getReader !== "function") {
    throw new TypeError("readSse needs a web ReadableStream body.");
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let idleTimer = null;
  let rejectIdle = null;
  const idle = new Promise((_, reject) => {
    rejectIdle = reject;
  });
  // The idle promise only matters while a read is pending; keep an unhandled
  // rejection from surfacing when the stream ends first.
  idle.catch(() => {});
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => rejectIdle(new SseIdleTimeoutError(idleTimeoutMs)), idleTimeoutMs);
  };
  const onAbort = () => {
    reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    armIdle();
    for (;;) {
      if (signal?.aborted) return;
      const { value, done } = await Promise.race([reader.read(), idle]);
      if (done) break;
      armIdle();
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const parsed = parseSseBlock(block);
        if (parsed) yield parsed;
        boundary = buffer.indexOf("\n\n");
      }
    }
    buffer += decoder.decode().replace(/\r\n?/g, "\n");
    const tail = parseSseBlock(buffer.trim());
    if (tail) yield tail;
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    signal?.removeEventListener("abort", onAbort);
    reader.cancel().catch(() => {});
    try {
      reader.releaseLock();
    } catch {}
  }
}

module.exports = { readSse, parseSseBlock, SseIdleTimeoutError };
