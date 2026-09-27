// In-world text for the HQ's desk monitors: code the builders type, terminal
// sessions, log lines, research notes, chat (the big screens write theirs
// from the feed, screenStories.ts). Decoration inside the 3D scene (like the
// demo gateway's scripts), not UI copy, so it is not routed through the i18n
// dictionary. Everything is deterministic for a given seed.

/** mulberry32: a tiny deterministic PRNG. */
export function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable 0..1 hash of two integers. */
export function hash2(a: number, b: number): number {
  let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export function pick<T>(list: readonly T[], r: number): T {
  return list[Math.min(list.length - 1, Math.floor(r * list.length))];
}

export const CODE_TS = `import { EventEmitter } from "node:events";
import type { Agent, Task, TaskResult } from "./types";

const MAX_PARALLEL = 8;
const RETRY_DELAYS_MS = [250, 1000, 4000];

export class TaskRouter extends EventEmitter {
  private readonly queue: Task[] = [];
  private readonly running = new Map<string, Task>();

  constructor(private readonly agents: Agent[]) {
    super();
  }

  submit(task: Task): void {
    this.queue.push(task);
    this.queue.sort((a, b) => b.priority - a.priority);
    this.emit("queued", task.id);
    void this.drain();
  }

  private async drain(): Promise<void> {
    while (this.running.size < MAX_PARALLEL && this.queue.length > 0) {
      const task = this.queue.shift()!;
      const agent = this.pickAgent(task);
      if (!agent) {
        this.queue.unshift(task);
        return;
      }
      this.running.set(task.id, task);
      void this.run(agent, task);
    }
  }

  private pickAgent(task: Task): Agent | undefined {
    return this.agents
      .filter((a) => a.status === "idle" && a.skills.includes(task.kind))
      .sort((a, b) => a.load - b.load)[0];
  }

  private async run(agent: Agent, task: Task, attempt = 0): Promise<void> {
    const started = performance.now();
    try {
      const result: TaskResult = await agent.execute(task);
      this.emit("done", { id: task.id, agent: agent.name, ms: performance.now() - started, result });
    } catch (error) {
      if (attempt < RETRY_DELAYS_MS.length) {
        await sleep(RETRY_DELAYS_MS[attempt]);
        return this.run(agent, task, attempt + 1);
      }
      this.emit("failed", { id: task.id, agent: agent.name, error });
    } finally {
      this.running.delete(task.id);
      void this.drain();
    }
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function summarize(results: TaskResult[]): string {
  const ok = results.filter((r) => r.ok).length;
  const p95 = percentile(results.map((r) => r.ms), 0.95);
  return \`\${ok}/\${results.length} ok, p95 \${p95.toFixed(0)} ms\`;
}

function percentile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
}
`.split("\n");

export const CODE_PY = `import asyncio
import numpy as np
import pandas as pd
from dataclasses import dataclass

WINDOW = 48
THRESHOLD = 3.5


@dataclass
class Signal:
    source: str
    values: np.ndarray
    unit: str = "req/s"


def robust_zscore(x: np.ndarray) -> np.ndarray:
    median = np.median(x)
    mad = np.median(np.abs(x - median)) or 1e-9
    return 0.6745 * (x - median) / mad


def detect(signal: Signal) -> pd.DataFrame:
    z = robust_zscore(signal.values[-WINDOW:])
    hits = np.where(np.abs(z) > THRESHOLD)[0]
    return pd.DataFrame({
        "source": signal.source,
        "index": hits,
        "score": z[hits].round(2),
    })


async def fetch(region: str) -> Signal:
    await asyncio.sleep(0.05)
    rng = np.random.default_rng(abs(hash(region)) % 2**32)
    values = rng.normal(1200, 90, size=512)
    values[-7] *= 1.9
    return Signal(source=region, values=values)


async def main() -> None:
    regions = ["eu-west", "us-east", "ap-south", "sa-east", "me-central"]
    signals = await asyncio.gather(*(fetch(r) for r in regions))
    report = pd.concat([detect(s) for s in signals], ignore_index=True)
    report = report.sort_values("score", key=np.abs, ascending=False)
    print(report.head(12).to_string(index=False))
    print(f"anomalies: {len(report)} across {len(regions)} regions")


if __name__ == "__main__":
    asyncio.run(main())
`.split("\n");

export const CODE_SQL = [
  "SELECT a.name, a.role,",
  "       count(t.id)             AS tasks,",
  "       avg(t.duration_ms)::int AS avg_ms,",
  "       sum(t.ok::int) * 100 / count(t.id) AS ok_pct",
  "  FROM agents a",
  "  JOIN tasks t ON t.agent_id = a.id",
  " WHERE t.finished_at > now() - interval '1 hour'",
  " GROUP BY a.name, a.role",
  " ORDER BY tasks DESC",
  " LIMIT 14;",
];

export const TS_KEYWORDS = new Set([
  "import", "from", "export", "const", "let", "class", "extends", "private", "readonly", "constructor",
  "return", "if", "else", "while", "for", "async", "await", "try", "catch", "finally", "new", "void",
  "function", "type", "throw", "super", "this", "of", "in", "def", "and", "or", "not", "is", "None",
  "True", "False", "with", "as", "pass", "print", "SELECT", "FROM", "JOIN", "ON", "WHERE", "GROUP",
  "BY", "ORDER", "LIMIT", "AS", "DESC", "interface", "public", "static",
]);

export type TermLine = { text: string; kind: "cmd" | "out" | "ok" | "warn" | "err" | "dim" };

const cmd = (text: string): TermLine => ({ text, kind: "cmd" });
const out = (text: string): TermLine => ({ text, kind: "out" });
const ok = (text: string): TermLine => ({ text, kind: "ok" });
const warn = (text: string): TermLine => ({ text, kind: "warn" });
const dim = (text: string): TermLine => ({ text, kind: "dim" });

export const TERM_BUILD: TermLine[] = [
  cmd("npm run test -- --run"),
  dim(" RUN  v4.1.11 /srv/hq/agent-core"),
  ok(" ✓ router.test.ts (18 tests) 212ms"),
  ok(" ✓ scheduler.test.ts (24 tests) 348ms"),
  ok(" ✓ memory/vector.test.ts (11 tests) 97ms"),
  ok(" ✓ tools/http.test.ts (9 tests) 1204ms"),
  ok(" ✓ gateway/session.test.ts (31 tests) 640ms"),
  out(" Test Files  5 passed (5)"),
  out("      Tests  93 passed (93)"),
  out("   Duration  2.61s"),
  cmd("npm run build"),
  dim("> agent-core@4.2.0 build"),
  dim("> tsc -p tsconfig.build.json && esbuild src/index.ts --bundle"),
  out("  dist/index.js      412.7kb"),
  out("  dist/index.js.map  1.1mb"),
  ok("⚡ Done in 1843ms"),
  cmd("git add -A && git commit -m \"router: retry with backoff\""),
  out("[feature/router-retry 3f9c2a1] router: retry with backoff"),
  out(" 3 files changed, 64 insertions(+), 12 deletions(-)"),
  cmd("git push origin feature/router-retry"),
  dim("Enumerating objects: 11, done."),
  dim("Writing objects: 100% (6/6), 1.94 KiB | 1.94 MiB/s, done."),
  out("remote: Create a pull request for 'feature/router-retry'"),
  ok("   7d1e0b4..3f9c2a1  feature/router-retry -> feature/router-retry"),
];

export const TERM_OPS: TermLine[] = [
  cmd("kubectl get pods -n agents"),
  dim("NAME                         READY   STATUS    RESTARTS   AGE"),
  out("gateway-7c9f5d8b6-2xkqp      1/1     Running   0          6d2h"),
  out("gateway-7c9f5d8b6-9mfzt      1/1     Running   0          6d2h"),
  out("router-5b7d9c4f8-lq2wd       1/1     Running   1          2d11h"),
  out("memory-0                     2/2     Running   0          14d"),
  out("memory-1                     2/2     Running   0          14d"),
  warn("worker-84f6c-7hzqn          0/1     Pending   0          12s"),
  out("worker-84f6c-cc8tr           1/1     Running   0          41m"),
  cmd("kubectl rollout status deploy/worker -n agents"),
  dim("Waiting for deployment \"worker\" rollout to finish: 7 of 8 updated..."),
  ok("deployment \"worker\" successfully rolled out"),
  cmd("curl -s https://gw.hq.internal/health | jq ."),
  out("{"),
  out("  \"status\": \"ok\","),
  out("  \"sessions\": 312,"),
  out("  \"queue_depth\": 7,"),
  out("  \"p95_ms\": 184"),
  out("}"),
  cmd("helm upgrade router ./charts/router --set replicas=4"),
  ok("Release \"router\" has been upgraded. Happy Helming!"),
  cmd("terraform plan -out=tfplan"),
  out("Plan: 2 to add, 1 to change, 0 to destroy."),
];

export const TERM_TESTS: TermLine[] = [
  cmd("npx playwright test --reporter=line"),
  dim("Running 42 tests using 6 workers"),
  ok("  ✓  1 [chromium] › login.spec.ts:12:3 › signs in with a key (2.1s)"),
  ok("  ✓  2 [chromium] › chat.spec.ts:30:3 › sends a message to AM7 (3.4s)"),
  ok("  ✓  3 [chromium] › tasks.spec.ts:8:3 › moves a card to done (1.8s)"),
  { text: "  ✗  4 [webkit] › upload.spec.ts:44:3 › attaches a 20MB file (30.0s)", kind: "err" },
  dim("     TimeoutError: locator.click: Timeout 30000ms exceeded."),
  ok("  ✓  5 [firefox] › settings.spec.ts:19:3 › switches the theme (1.2s)"),
  ok("  ✓  6 [chromium] › office.spec.ts:61:3 › opens the HQ view (4.7s)"),
  warn("  ↻  4 [webkit] retry #1 › upload.spec.ts:44:3"),
  ok("  ✓  4 [webkit] › upload.spec.ts:44:3 › attaches a 20MB file (8.2s)"),
  out("  41 passed, 1 flaky (1.4m)"),
  cmd("npm run lint"),
  ok("✔ No problems found"),
];

export const LOG_SERVICES = ["gateway", "router", "memory", "worker", "planner", "tools", "auth", "search"];

export const LOG_MESSAGES = [
  "task.completed id=%id ms=%ms",
  "task.started id=%id kind=%kind",
  "session.open agent=%name",
  "tool.call http.get status=200 ms=%ms",
  "tool.call search.query hits=%n ms=%ms",
  "memory.upsert vectors=%n dim=1536",
  "cache.hit ratio=0.%n",
  "queue.depth=%n workers=%w",
  "plan.step %n/%w agent=%name",
  "retry attempt=2 backoff=1000ms id=%id",
  "rate.limit ok remaining=%n",
  "deploy.check worker healthy=%w/%w",
];

export const TASK_KINDS = ["research", "code", "review", "analysis", "report", "deploy", "test", "design"];

export const RESEARCH_TITLE = "Гибридный поиск для памяти агентов";
export const RESEARCH_TEXT = [
  "Гибридный поиск объединяет плотные векторы и классический BM25.",
  "В наших тестах он даёт +14% к точности на длинных запросах и",
  "заметно меньше промахов на редких терминах и названиях.",
  "",
  "Ключевые выводы:",
  "• векторы хорошо ловят смысл, но теряют точные совпадения;",
  "• BM25 держит имена, коды ошибок и номера задач;",
  "• переранжирование cross-encoder'ом добавляет ещё 6–8%.",
  "",
  "Рекомендация: включить гибридный режим для памяти команды,",
  "вес BM25 = 0.35, top-k = 40, переранжирование для top-10.",
  "Задержка растёт на 18 мс в p95 — в пределах бюджета.",
  "",
  "Открытые вопросы: кеширование эмбеддингов запросов и",
  "обновление индекса без простоя при переходе на новую модель.",
];

export const PAPERS = [
  ["Retrieval-Augmented Agents at Scale", "Chen, Okafor, Lindqvist", "2026", "412"],
  ["Hybrid Search Beats Dense Retrieval on Long Queries", "Ivanova, Park", "2025", "288"],
  ["Tool Use Without Hallucinated Calls", "Moreau, Singh, Alvarez", "2026", "197"],
  ["Planning Graphs for Multi-Agent Teams", "Tanaka, Novak", "2025", "364"],
  ["Cheap Evaluation of Agent Trajectories", "Rahman, Kowalski", "2026", "96"],
  ["Memory Compaction for Long Sessions", "Silva, Weber, Ito", "2025", "151"],
  ["Latency Budgets in Agent Pipelines", "Olsen, Mehta", "2026", "73"],
];

export const CHAT_LINES = [
  ["AM7", "Сводка к 18:00, пожалуйста."],
  ["Nova", "Готовлю. Аналитика уже прислала цифры."],
  ["Vex", "Тесты зелёные, деплой воркеров через 10 минут."],
  ["Rune", "Нашла причину таймаутов — лимит пула соединений."],
  ["AM7", "Отлично. Поднимите лимит и проверьте p95."],
  ["Kade", "Сделано: p95 упал с 410 до 184 мс."],
  ["Lyra", "Отчёт по конкурентам в папке «Исследования»."],
  ["Orion", "Дизайн дашборда согласован, отдаю в разработку."],
  ["Echo", "Очередь пуста, беру задачи из бэклога."],
  ["Juno", "Нужен ревьюер на PR #412 — кто свободен?"],
  ["Mika", "Беру ревью."],
  ["AM7", "Спасибо, команда. Держим темп."],
];

export const KANBAN = {
  todo: ["Сравнить модели эмбеддингов", "Обновить онбординг", "Лимиты API партнёров", "Отчёт за неделю"],
  doing: ["Ретраи в роутере", "Дашборд задержек", "Миграция индекса"],
  review: ["PR #412: кеш ответов", "Макет штаба v3"],
  done: ["Алерты по ошибкам", "Нагрузочный тест", "Сводка для AM7"],
};

export const DOC_TITLE = "План релиза 4.3";
export const DOC_TEXT = [
  "Цель релиза — ускорить ответы агентов и снизить долю ошибок.",
  "",
  "1. Роутер задач: ретраи с экспоненциальной задержкой,",
  "   приоритеты и честное распределение нагрузки.",
  "2. Память: гибридный поиск (векторы + BM25), компактизация",
  "   длинных сессий, переиндексация без простоя.",
  "3. Наблюдаемость: дашборд задержек p50/p95/p99 по операциям,",
  "   алерты при росте ошибок выше 2% за 5 минут.",
  "4. Безопасность: ротация ключей, аудит вызовов инструментов.",
  "",
  "Сроки: заморозка кода — пятница, релиз — вторник.",
  "Ответственные: разработка — Vex, данные — Rune, QA — Kade.",
];

export const REGIONS = ["eu-west", "us-east", "us-west", "ap-south", "ap-east", "sa-east", "me-central", "af-south"];
