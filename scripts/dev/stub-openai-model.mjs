#!/usr/bin/env node
/**
 * A scripted OpenAI-compatible model for exercising Office3D against a real
 * Hermes install without paying for (or depending on) a real provider.
 *
 *   node scripts/dev/stub-openai-model.mjs [port]      (default 18900)
 *
 * Behaviour, chosen from the last user message:
 *   - contains "удали" / "delete": first answers with a `terminal` tool call
 *     running a destructive command (so Hermes asks for approval), then, once
 *     the tool result is in the conversation, a short text answer;
 *   - anything else: a text answer that echoes the message.
 * Streams when asked to (`stream: true`), as Hermes normally does.
 */
import fs from "node:fs";
import http from "node:http";

// STUB_LOG_FILE=path appends each request's system prompt, for checking what
// Hermes actually hands the model (SOUL.md, mission, rules).
const logFile = process.env.STUB_LOG_FILE || "";

const port = Number(process.argv[2] || process.env.STUB_MODEL_PORT || 18900);

const textOf = (m) => {
  if (typeof m?.content === "string") return m.content;
  if (Array.isArray(m?.content)) return m.content.map((p) => p?.text ?? "").join("");
  return "";
};

const lastUserText = (messages) => {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "user") return textOf(messages[i]);
  }
  return "";
};

const hasTool = (body, name) =>
  Array.isArray(body.tools) && body.tools.some((tool) => tool?.function?.name === name);

const decide = (body) => {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const text = lastUserText(messages);
  // A kanban worker — the dispatcher opens it with "work kanban task <id>":
  // finish the card through the board tool, as the worker protocol requires,
  // then say so. The main agent has the board tools too, in every chat, so
  // the tool alone does not make a worker.
  const isWorker = messages.some((m) => m?.role === "user" && /\bwork kanban task \S+/.test(textOf(m)));
  if (isWorker && hasTool(body, "kanban_complete")) {
    const completed = messages.some((m) => m?.role === "tool" && String(m.content ?? "").includes("complet"));
    if (!messages.some((m) => m?.role === "tool")) {
      return {
        toolCall: {
          id: `call_${Date.now()}`,
          type: "function",
          function: { name: "kanban_complete", arguments: JSON.stringify({ summary: "Сделано заглушкой: задача выполнена." }) },
        },
      };
    }
    return { text: completed ? "Задача закрыта." : "Готово." };
  }
  // Only a tool result after the latest user message answers this request;
  // earlier turns of the same session carry their own.
  let lastUser = -1;
  messages.forEach((m, i) => {
    if (m?.role === "user") lastUser = i;
  });
  const hasToolResult = messages.slice(lastUser + 1).some((m) => m?.role === "tool");
  // Office3D's own notes (a review request, a meeting turn) quote commands;
  // they are not a request to run one.
  const wantsDelete = !text.startsWith("[Office3D") && /удали|delete/i.test(text);
  if (wantsDelete && !hasToolResult) {
    return {
      toolCall: {
        id: `call_${Date.now()}`,
        type: "function",
        function: { name: "terminal", arguments: JSON.stringify({ command: "rm -rf /tmp/office3d-stub-target" }) },
      },
    };
  }
  if (wantsDelete) return { text: "Удалил каталог." };
  return { text: `Заглушка слышит: ${text.slice(0, 200)}` };
};

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const url = req.url || "";
    if (url.endsWith("/models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "stub-model", object: "model", owned_by: "office3d" }] }));
      return;
    }
    if (!url.endsWith("/chat/completions")) {
      res.writeHead(404);
      res.end();
      return;
    }
    let body = {};
    try {
      body = JSON.parse(raw || "{}");
    } catch {}
    if (logFile) {
      const system = (Array.isArray(body.messages) ? body.messages : []).filter((m) => m?.role === "system").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
      fs.appendFileSync(logFile, `${JSON.stringify({ at: new Date().toISOString(), system })}\n`);
    }
    const answer = decide(body);
    const id = `chatcmpl-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);
    const usage = { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 };
    if (!body.stream) {
      const message = answer.toolCall
        ? { role: "assistant", content: null, tool_calls: [answer.toolCall] }
        : { role: "assistant", content: answer.text };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id, object: "chat.completion", created, model: "stub-model",
        choices: [{ index: 0, message, finish_reason: answer.toolCall ? "tool_calls" : "stop" }],
        usage,
      }));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    const chunk = (delta, finish = null, extra = {}) =>
      res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: "stub-model", choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`);
    if (answer.toolCall) {
      chunk({ role: "assistant", tool_calls: [{ index: 0, ...answer.toolCall }] });
      chunk({}, "tool_calls", { usage });
    } else {
      chunk({ role: "assistant", content: "" });
      for (const piece of answer.text.match(/.{1,8}/gsu) ?? []) chunk({ content: piece });
      chunk({}, "stop", { usage });
    }
    res.end("data: [DONE]\n\n");
  });
});

server.listen(port, "127.0.0.1", () => console.log(`stub model on http://127.0.0.1:${port}/v1`));
