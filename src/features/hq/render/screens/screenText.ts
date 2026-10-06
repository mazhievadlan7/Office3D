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

// The Kali root sessions of a hacker on an operation (centre monitor, see
// screenApps.ts). Authorised work only, against the HQ's own lab and an agreed
// scope: PASSIVE open-source recon (theHarvester, recon-ng — the same toolkit
// the РАЗВЕДКА/OSINT view lists) plus the HQ's own wrappers (scope, findings).
// Nothing here is a usable attack command; the demo targets are fictional
// (example.com, TEST-NET-3), matching the OSINT demo dataset.

/** Passive OSINT recon of the authorised scope: open sources, not intrusion. */
export const KALI_RECON: TermLine[] = [
  cmd("scope show --op OP-2417"),
  out("operation  OP-2417 · authorised by AM7"),
  out("targets    example.com + *.example.com (own lab) · 203.0.113.0/24"),
  out("window     09:00–21:00 MSK · rules of engagement v3"),
  cmd("theHarvester -d example.com -b crtsh,otx -l 500"),
  dim("[*] passive sources only · domain in scope"),
  out("  api.example.com    mail.example.com"),
  out("  vpn.example.com    dev.example.com"),
  ok("[+] 4 subdomains · 2 emails (admin@, dev@)"),
  cmd("recon-ng -w op-2417 -m recon/domains-hosts/hackertarget"),
  out("  [hosts] 3 new · [contacts] 2 new → workspace graph"),
  warn("  203.0.113.21   outdated OpenSSH banner"),
  cmd("findings add --sev medium \"outdated OpenSSH banner on 203.0.113.21\""),
  ok("[+] F-0504 recorded · severity: medium"),
  cmd("notes sync --report OP-2417"),
  ok("[+] notes pushed to the report draft"),
];

/** Web and API assessment inside the scope: headers and an access-control review. */
export const KALI_WEB: TermLine[] = [
  cmd("scope check web-lab.range.local"),
  ok("[+] in scope · OP-2417 · test account issued"),
  cmd("http-review --headers https://web-lab.range.local"),
  out("HTTP/2 200 · server: nginx"),
  warn("missing: Content-Security-Policy"),
  warn("missing: Strict-Transport-Security"),
  cmd("findings add --sev low \"no CSP and HSTS headers\""),
  ok("[+] F-0193 recorded · severity: low"),
  cmd("api-review --spec openapi.yaml --role-matrix"),
  out("  42 endpoints · 3 roles · 126 checks"),
  { text: "  ! /api/v1/orders/{id}: owner not checked per user", kind: "err" },
  cmd("findings add --sev high \"order access not checked per owner\""),
  ok("[+] F-0194 recorded · severity: high · AM7 notified"),
  cmd("report draft --section web"),
  ok("[+] 3 findings · fixes attached"),
];

/** A session on the cyber-range (entered from the hacker's own desk). */
export const KALI_RANGE: TermLine[] = [
  cmd("range status"),
  out("cyber-range  range-07 · 6 VMs · snapshot 2026-09-28"),
  ok("[+] isolated network · egress blocked"),
  cmd("range start --scenario web-basics"),
  dim("[*] restoring the snapshot… done"),
  ok("[+] scenario running · timer 02:00:00"),
  cmd("range objectives"),
  out("  [x] 1. map the lab's services"),
  out("  [x] 2. find the misconfigured header"),
  out("  [ ] 3. write up the fix"),
  cmd("range submit --objective 2"),
  ok("[+] accepted · +150 pts"),
  cmd("range reset --keep-notes"),
  ok("[+] snapshot restored · notes kept"),
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

/** Kinds of operation work, for the log lines. */
export const TASK_KINDS = ["recon", "web", "api", "identity", "cloud", "network", "reverse", "report"];

/** Operation kinds (HQ_ROLE_FAMILY order), for tables. */
export const OPERATION_KINDS = ["hq", "recon", "web-api", "identity", "cloud", "network", "reverse", "report"];

/** Fallback callsigns when the floor has no names yet. */
export const CALLSIGNS = ["Ghost", "Viper", "Raven", "Cipher", "Nyx", "Wraith", "Onyx", "Specter"];

export const RESEARCH_TITLE = "Гибридный поиск для памяти агентов";
export const RESEARCH_TEXT = [
  "Гибридный поиск объединяет плотные векторы и классический BM25.",
  "В наших тестах он даёт +14% к точности на длинных запросах и",
  "заметно меньше промахов на редких терминах и названиях.",
  "",
  "Ключевые выводы:",
  "• векторы хорошо ловят смысл, но теряют точные совпадения;",
  "• BM25 держит имена, коды ошибок и номера находок;",
  "• переранжирование cross-encoder'ом добавляет ещё 6–8%.",
  "",
  "Рекомендация: включить гибридный режим для базы знаний штаба,",
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

/** The crew's ops channel: callsigns, scope, findings, severity, reports. */
export const CHAT_LINES = [
  ["AM7", "Сводка по ОП-2417 к 18:00, пожалуйста."],
  ["Ghost", "Скоуп подтверждён, работаем только в окне."],
  ["Viper", "Разведка полигона готова, 4 актива в скоупе."],
  ["Raven", "F-0194 — high, доступ к заказам без проверки."],
  ["AM7", "Принял. High — в отчёт первым пунктом."],
  ["Cipher", "Заголовки web-lab: CSP и HSTS нет, это low."],
  ["Nyx", "Рекомендации по фиксу приложил к находкам."],
  ["Wraith", "Стенд на киберполигоне сброшен, заметки целы."],
  ["Onyx", "Дубликат F-0188 закрыл, осталось три средних."],
  ["Specter", "Черновик отчёта готов, нужен вычитывающий."],
  ["Ghost", "Беру вычитку."],
  ["AM7", "Спасибо, команда. Держим скоуп."],
];

export const KANBAN = {
  todo: ["Разведка range-07", "Ревью ролей API", "Проверка после патча", "Отчёт за неделю"],
  doing: ["F-0194: доступ к заказам", "Заголовки web-lab", "Сценарий полигона"],
  review: ["Черновик отчёта ОП-2417", "Рекомендации по FTP"],
  done: ["Скоуп согласован", "Инвентаризация активов", "Сводка для AM7"],
};

export const DOC_TITLE = "Отчёт ОП-2417 (черновик)";
export const DOC_TEXT = [
  "Цель: проверка веб-приложения и API в согласованном скоупе.",
  "",
  "1. Скоуп: лабораторный сегмент 10.77.0.0/24 и web-lab,",
  "   окно работ 09:00–21:00, правила взаимодействия v3.",
  "2. Находки: 1 high, 1 medium, 1 low; критичных нет.",
  "   F-0194 (high): нет проверки владельца заказа в API.",
  "3. Рекомендации: проверка прав на каждый объект,",
  "   заголовки CSP и HSTS, обновить устаревший FTP.",
  "4. Повторная проверка — после исправлений заказчика.",
  "",
  "Сроки: черновик — пятница, финальный отчёт — вторник.",
  "Ответственные: веб — Raven, разведка — Viper, отчёт — Specter.",
];

export const REGIONS = ["eu-west", "us-east", "us-west", "ap-south", "ap-east", "sa-east", "me-central", "af-south"];
