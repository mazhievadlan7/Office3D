import { describe, expect, it } from "vitest";

import {
  OPS_ROLES,
  allocateSwarm,
  applyTransition,
  assertNoToolNames,
  buildReport,
  createBoard,
  createDemoScopeGate,
  createWorkItem,
  findToolNames,
  LEAD_CALLSIGN,
  OpsError,
  recommendAgentCount,
  rolesForTask,
  renderReportMarkdown,
  REPORT_TOOL_DENYLIST,
  stripToolNames,
  nextHandler,
  type OpsReportVuln,
} from "@/features/hq/ops";

const clock = (start = 1_700_000_000_000) => {
  let t = start;
  return () => {
    t += 1_000;
    return t;
  };
};

describe("ops · flat-role routing", () => {
  it("start takes the item to the target role; send-to-review moves it to the review role", () => {
    const now = clock();
    const item = createWorkItem(
      { title: "Разведка dev-окружения", originRole: "recon", targetRole: "recon", reviewRole: "reporting", target: "dev.example.com" },
      { now },
    );
    expect(item.status).toBe("created");

    const started = applyTransition(item, "start", { by: "WRAITH-07" }, { now }).item;
    expect(started.status).toBe("in_progress");
    expect(started.currentRole).toBe("recon");

    const inReview = applyTransition(started, "send-to-review", {}, { now }).item;
    expect(inReview.status).toBe("review");
    expect(inReview.currentRole).toBe("reporting");
  });

  it("verdict passes a non-critical item to verified, keeping an append-only trail", () => {
    const now = clock();
    const item = createWorkItem({ title: "T", originRole: "recon", targetRole: "recon", reviewRole: "reporting" }, { now });
    const started = applyTransition(item, "start", { by: "A" }, { now }).item;
    const review = applyTransition(started, "send-to-review", { by: "A" }, { now }).item;
    const verified = applyTransition(review, "verdict", { by: "B", pass: true }, { now }).item;
    expect(verified.status).toBe("verified");
    // Trail is append-only, strictly increasing seq.
    const seqs = verified.routingTrail.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it("a critical item cannot be verified by its own author (independent verifier required)", () => {
    const now = clock();
    const item = createWorkItem({ title: "crit", originRole: "identity", targetRole: "identity", reviewRole: "reporting", critical: true, assignee: "ONE" }, { now });
    const started = applyTransition(item, "start", { by: "ONE" }, { now }).item;
    const review = applyTransition(started, "send-to-review", { by: "ONE" }, { now }).item;
    expect(() => applyTransition(review, "verdict", { by: "ONE", pass: true }, { now })).toThrow(OpsError);
    const ok = applyTransition(review, "verdict", { by: "TWO", pass: true }, { now }).item;
    expect(ok.status).toBe("verified");
  });

  it("rework returns the item to the author with a recorded failure verdict", () => {
    const now = clock();
    const item = createWorkItem({ title: "T", originRole: "web-api", targetRole: "web-api", reviewRole: "reporting" }, { now });
    const started = applyTransition(item, "start", { by: "X" }, { now }).item;
    const review = applyTransition(started, "send-to-review", {}, { now }).item;
    const rew = applyTransition(review, "rework", { by: "R", note: "недостаёт доказательств" }, { now }).item;
    expect(rew.status).toBe("rework");
    expect(rew.currentRole).toBe("web-api");
    expect(rew.verdicts.at(-1)?.result).toBe("fail");
    // Restart from rework is allowed.
    const again = applyTransition(rew, "start", { by: "X" }, { now }).item;
    expect(again.status).toBe("in_progress");
  });

  it("nextHandler is deterministic and flat (no sanction route)", () => {
    const now = clock();
    const item = createWorkItem({ title: "T", originRole: "recon", targetRole: "web-api", reviewRole: "reporting" }, { now });
    expect(nextHandler(item, "start")).toBe("web-api");
    expect(nextHandler(item, "send-to-review")).toBe("reporting");
    expect(nextHandler(item, "help-request", { helper: "network" })).toBe("network");
    expect(() => nextHandler(item, "unknown")).toThrow();
  });

  it("the board keeps items by id and lists them, newest first", () => {
    const now = clock();
    const board = createBoard();
    const a = createWorkItem({ title: "A", originRole: "recon", targetRole: "recon" }, { now });
    const b = createWorkItem({ title: "B", originRole: "osint", targetRole: "osint" }, { now });
    board.put(a);
    board.put(b);
    const listed = board.list();
    expect(listed.length).toBe(2);
    expect(listed[0].id).toBe(b.id); // b is newer
    expect(board.get(a.id)?.title).toBe("A");
  });
});

describe("ops · chaining (role → role)", () => {
  it("a chain item carries parentId and chainedFrom from the source role", () => {
    const now = clock();
    const parent = createWorkItem({ title: "recon", originRole: "recon", targetRole: "recon" }, { now });
    const chain = createWorkItem(
      { title: "web/api", originRole: "recon", targetRole: "web-api", parentId: parent.id, chainedFrom: "recon", type: "chain" },
      { now },
    );
    expect(chain.parentId).toBe(parent.id);
    expect(chain.chainedFrom).toBe("recon");
    expect(chain.type).toBe("chain");
    expect(chain.routingTrail[0].action).toBe("chain");
  });
});

describe("ops · swarm allocation", () => {
  it("places exactly one lead with callsign AM7", () => {
    const alloc = allocateSwarm("Проверка периметра", 6);
    const leads = alloc.operatives.filter((o) => o.lead);
    expect(leads.length).toBe(1);
    expect(leads[0].callsign).toBe(LEAD_CALLSIGN);
    expect(alloc.operatives.length).toBe(6);
  });

  it("recommendAgentCount scales with task size and complexity", () => {
    const small = recommendAgentCount("разведка");
    const big = recommendAgentCount("Проверка внешнего периметра: веб, API, сеть, доступы, облако, устойчивость к фишингу");
    expect(small).toBeGreaterThanOrEqual(3);
    expect(big).toBeGreaterThan(small);
    expect(big).toBeLessThanOrEqual(12);
  });

  it("the roles represented include recon, reporting, exploitation and are all valid flat roles", () => {
    const roles = rolesForTask("дай полный аудит периметра");
    expect(roles).toContain("recon");
    expect(roles).toContain("reporting");
    expect(roles).toContain("exploitation");
    for (const role of roles) expect((OPS_ROLES as readonly string[]).includes(role)).toBe(true);
  });
});

describe("ops · scope gate (demo stand-in for AEGIS preflight)", () => {
  const gate = createDemoScopeGate("ENG-OSINT-DEMO");

  it("allows a target in the fictional reserved scope", () => {
    const d = gate.check({ engagementId: "ENG-OSINT-DEMO", actor: "A", action: "workitem:start", target: "dev.example.com" });
    expect(d.allowed).toBe(true);
    expect(d.assetId).toBe("a-example");
  });

  it("denies an out-of-scope target (default-deny)", () => {
    const d = gate.check({ engagementId: "ENG-OSINT-DEMO", actor: "A", action: "workitem:start", target: "not-authorized.test" });
    expect(d.allowed).toBe(false);
    expect(d.decision).toBe("deny_out_of_scope");
  });

  it("denies a mismatched engagement id", () => {
    const d = gate.check({ engagementId: "OTHER-ENG", actor: "A", action: "workitem:start", target: "dev.example.com" });
    expect(d.allowed).toBe(false);
    expect(d.decision).toBe("deny_engagement_mismatch");
  });

  it("admits a step with no concrete target (pure coordination)", () => {
    const d = gate.check({ engagementId: null, actor: "A", action: "workitem:plan", target: null });
    expect(d.allowed).toBe(true);
  });
});

describe("ops · report (owner invariant: no tool/command names)", () => {
  const findings: OpsReportVuln[] = [
    { title: "Возможная инъекция в API", severity: "critical", where: "dev.example.com" },
    { title: "Слабая аутентификация на служебном интерфейсе", severity: "critical", where: "203.0.113.21" },
    { title: "Устаревший компонент сетевого сервиса", severity: "high", where: "203.0.113.21" },
    { title: "Слабые заголовки безопасности", severity: "low", where: "dev.example.com" },
  ];

  it("has every required section with content", () => {
    const r = buildReport({ engagement: "example.com, TEST-NET-3", task: "Проверка периметра", findings });
    expect(r.target).toBeTruthy();
    expect(r.task).toBeTruthy();
    expect(r.summary.length).toBeGreaterThan(10);
    expect(r.access.length).toBeGreaterThan(10);
    expect(r.vulnerabilities.length).toBe(findings.length);
    expect(r.damage.length).toBeGreaterThan(0);
    expect(r.recommendations.length).toBeGreaterThan(0);
  });

  it("sorts vulnerabilities by criticality, most critical first", () => {
    const r = buildReport({ engagement: "e", task: "t", findings });
    const order = r.vulnerabilities.map((v) => v.severity);
    expect(order[0]).toBe("critical");
    expect(order.at(-1)).toBe("low");
  });

  it("has a different tone in «fix-ourselves» vs «recommendations» mode", () => {
    const a = buildReport({ engagement: "e", task: "t", findings }, "recommendations");
    const b = buildReport({ engagement: "e", task: "t", findings }, "fix-ourselves");
    expect(a.mode).toBe("recommendations");
    expect(b.mode).toBe("fix-ourselves");
    expect(a.recommendations.join(" ")).toContain("Рекомендуем");
    expect(b.recommendations.join(" ")).toContain("Исправим сами");
  });

  it("stripToolNames removes any denylisted token in a passed-in title", () => {
    for (const name of REPORT_TOOL_DENYLIST) {
      const line = `Нашли проблему через ${name}: инъекция в API`;
      const clean = stripToolNames(line);
      expect(findToolNames(clean)).toEqual([]);
    }
  });

  it("the delivered report NEVER contains a tool or command name (invariant)", () => {
    // Even if a tool name sneaks in through input, the model must strip it.
    const tainted: OpsReportVuln[] = [
      { title: "Nmap scan showed port 8080 open — exposure of service", severity: "medium", where: "dev.example.com" },
      { title: "sqlmap confirmed injection in /api/v1/search", severity: "critical", where: "dev.example.com" },
      { title: "mimikatz-style credential capture possible", severity: "high", where: "203.0.113.21" },
    ];
    const r = buildReport({ engagement: "example.com", task: "Проверка (использовали Burp Suite, hydra, metasploit)", findings: tainted });
    expect(() => assertNoToolNames(r)).not.toThrow();
    const everything = [
      r.target,
      r.task,
      r.summary,
      r.access,
      ...r.vulnerabilities.flatMap((v) => [v.title, v.where]),
      ...r.damage,
      ...r.recommendations,
    ].join(" ");
    expect(findToolNames(everything)).toEqual([]);
  });

  it("renderReportMarkdown produces a Markdown doc that is also tool-free", () => {
    const r = buildReport({ engagement: "e", task: "t", findings });
    const md = renderReportMarkdown(r);
    expect(md).toContain("# Отчёт по авторизованной проверке");
    expect(md).toContain("## Цель");
    expect(md).toContain("## Как получили доступ");
    expect(md).toContain("## Рекомендации");
    expect(findToolNames(md)).toEqual([]);
  });
});
