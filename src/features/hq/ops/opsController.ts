/**
 * The flat-roles ORCHESTRATOR + the task/delegation/report flow (TZ §3.1/§3.2,
 * owner 2026-10-07). One framework-free controller, like osintController /
 * geoController / chatterController: the demo swarm fills it now, the real
 * scope-enforced Execution Plane will drive the SAME seam (startOp) later.
 *
 * What it does:
 *   1. Allocates a swarm for a task (lead «Главный хакер» AM7 + N operatives, N
 *      from the task size) and distributes work by momentary FLAT ROLES onto a
 *      shared board of work items — each move routed, scope-gated and audited.
 *   2. Drives the organism: operatives self-delegate across roles, chain one
 *      role's finding into the next role's input, and post HUMAN-language chatter
 *      (through chatterController) while findings land (through osintController,
 *      which in turn projects targets onto the shared globe). One coherent live
 *      demo on the боевой пульт.
 *   3. On completion distils a CLEAN report (report.ts) — no tools, no commands.
 *
 * Display/coordination ONLY. Nothing here ever acts on a target or transmits
 * anything; every scope decision is fail-closed. See TZ §0.
 */

import { chatterController } from "../chatter";
import type { ChatterInput } from "../chatter";
import { osintController, DEMO_OSINT } from "../osint";
import type { OsintDataset, OsintFinding } from "../osint";
import { OPS_ROLE_META, roleLabel, type OpsRole } from "./roles";
import { createBoard, type OpsBoard } from "./board";
import { applyTransition, createWorkItem, OpsError, type CreateWorkItemInput } from "./workItem";
import { plan as routePlan } from "./routing";
import { createDemoScopeGate } from "./scope";
import { allocateSwarm, recommendAgentCount, type SwarmAllocation } from "./swarm";
import { buildReport, type OpsReport, type OpsReportMode, type OpsReportVuln } from "./report";
import type { OpsAuditEntry, OpsOperative, OpsScopeGate, OpsSource, OpsState, OpsListener, OpsWorkItem } from "./types";

/** The minimal chatter sink the controller needs (the real controller satisfies it). */
type ChatterSink = { post(input: ChatterInput): unknown };
/** The minimal OSINT sink (the real controller satisfies it). */
type OsintSink = { getData(): OsintDataset | null; setData(data: OsintDataset): void };

export type OpsControllerDeps = {
  chatter?: ChatterSink;
  osint?: OsintSink;
  scopeGate?: OpsScopeGate;
  now?: () => number;
};

export type StartOpOptions = {
  agentCount?: number;
  source?: OpsSource;
  engagementId?: string | null;
  deps?: OpsControllerDeps;
};

export type OpsHandle = { opId: string; stop: () => void };

/** The transitions that put an operative to work on a real target — gated by the
 *  scope gate when the item carries a concrete target + engagement (fail-closed). */
const ACTING_TRANSITIONS = new Set(["start", "help-request"]);

/** How often the demo organism emits its next beat. */
const BEAT_MS = 3500;
/** Backfill this many beats on start so the pult opens alive. */
const SEED_BEATS = 4;

const DEMO_ENGAGEMENT = "ENG-OSINT-DEMO";
const DEMO_SCOPE_SUMMARY = "example.com, *.example.com, 203.0.113.0/24 (TEST-NET-3) — собственная лаборатория";
const DEMO_TASK = "Проверить внешний периметр демо-стенда: сервисы, забытые поддомены и путь к полному контролю";

/**
 * The op's findings — distilled, scope-tagged, with a role and a target. They
 * feed BOTH the OSINT pult feed (with a tool for provenance, which the pult may
 * show) AND the report (where the tool is dropped — the report is tool-free).
 * `entityId` ties a finding to a demo OSINT entity so geolocated ones pin the
 * shared globe through osintController's projection.
 */
type OpFinding = {
  id: string;
  role: OpsRole;
  title: string;
  severity: OpsReportVuln["severity"];
  target: string;
  entityId?: string;
  toolId: OsintFinding["sourceToolId"];
  confidence: number;
};

const OP_FINDINGS: readonly OpFinding[] = [
  { id: "OP-R01", role: "recon", title: "Забытый поддомен dev-окружения доступен извне", severity: "medium", target: "dev.example.com", entityId: "sub-dev", toolId: "theharvester", confidence: 0.9 },
  { id: "OP-R02", role: "recon", title: "Открытый порт/сервис на edge-узле", severity: "low", target: "203.0.113.10", entityId: "host-10", toolId: "shodan", confidence: 0.95 },
  { id: "OP-W01", role: "web-api", title: "Возможная инъекция в API dev-окружения", severity: "critical", target: "dev.example.com", entityId: "sub-dev", toolId: "recon-ng", confidence: 0.88 },
  { id: "OP-W02", role: "web-api", title: "Слабые заголовки безопасности", severity: "low", target: "dev.example.com", entityId: "sub-dev", toolId: "spiderfoot", confidence: 0.8 },
  { id: "OP-N01", role: "network", title: "Устаревший компонент сетевого сервиса", severity: "high", target: "203.0.113.21", entityId: "host-21", toolId: "shodan", confidence: 0.82 },
  { id: "OP-I01", role: "identity", title: "Слабая аутентификация на служебном интерфейсе", severity: "critical", target: "203.0.113.21", entityId: "host-21", toolId: "recon-ng", confidence: 0.85 },
  { id: "OP-X01", role: "exploitation", title: "Цепочка к повышению прав до полного контроля узла", severity: "critical", target: "203.0.113.21", entityId: "host-21", toolId: "recon-ng", confidence: 0.9 },
  { id: "OP-D01", role: "osint", title: "Раскрытие служебной информации в открытых источниках", severity: "medium", target: "203.0.113.34", entityId: "host-34", toolId: "spiderfoot", confidence: 0.7 },
];

let opSeq = 0;
const nextOpId = (): string => `op_${(opSeq += 1).toString(36)}_${Date.now().toString(36)}`;

class OpsController {
  private board: OpsBoard = createBoard();
  private audit: OpsAuditEntry[] = [];
  private auditSeq = 0;
  private state: OpsState | null = null;
  private report: OpsReport | null = null;
  private reportMode: OpsReportMode = "recommendations";
  private readonly listeners = new Set<OpsListener>();

  private timer: ReturnType<typeof setInterval> | null = null;
  private cursor = 0;
  private beats: Array<() => void> = [];
  private alloc: SwarmAllocation | null = null;
  private emittedFindings = new Set<string>();
  private reportFindings: OpsReportVuln[] = [];
  private demoRefs = 0;

  private chatter: ChatterSink = chatterController as unknown as ChatterSink;
  private osint: OsintSink = osintController as unknown as OsintSink;
  private scopeGate: OpsScopeGate = createDemoScopeGate(DEMO_ENGAGEMENT);
  private now: () => number = () => Date.now();

  // --- public read API --------------------------------------------------------

  getState(): OpsState | null {
    return this.state;
  }

  isRunning(): boolean {
    return this.state !== null && this.state.phase !== "stopped";
  }

  subscribe(listener: OpsListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  listItems(): OpsWorkItem[] {
    return this.board.list();
  }

  getAudit(limit = 200): OpsAuditEntry[] {
    return this.audit.slice(-limit);
  }

  /** The report for the current (or last) op, built on demand in `mode`. */
  getReport(mode: OpsReportMode = this.reportMode): OpsReport {
    if (this.report && this.report.mode === mode) return this.report;
    const report = buildReport(
      {
        engagement: DEMO_SCOPE_SUMMARY,
        task: this.state?.task ?? DEMO_TASK,
        findings: this.reportFindings.length ? this.reportFindings : OP_FINDINGS.map((f) => ({ title: f.title, severity: f.severity, where: f.target })),
        roleLabels: (this.alloc?.roles ?? ["recon", "web-api", "network", "identity", "exploitation"]).map((r) => OPS_ROLE_META[r]?.short ?? r),
        generatedAt: this.now(),
      },
      mode,
    );
    this.report = report;
    this.reportMode = mode;
    return report;
  }

  // --- op lifecycle -----------------------------------------------------------

  /**
   * Start (or replace) an op: allocate the swarm, seed the board, and drive the
   * live organism. The seam the real runtime drives. Returns a handle to stop it.
   */
  startOp(task: string, options: StartOpOptions = {}): OpsHandle {
    this.teardownTimeline();
    this.applyDeps(options.deps);

    const source: OpsSource = options.source ?? "briefing";
    const engagementId = options.engagementId ?? DEMO_ENGAGEMENT;
    const cleanTask = String(task ?? "").trim() || DEMO_TASK;
    const count = options.agentCount ?? recommendAgentCount(cleanTask);
    const alloc = allocateSwarm(cleanTask, count);
    this.alloc = alloc;

    const opId = nextOpId();
    const at = this.now();
    this.board.clear();
    this.audit = [];
    this.auditSeq = 0;
    this.report = null;
    this.emittedFindings = new Set();
    this.reportFindings = [];
    this.cursor = 0;

    this.state = {
      opId,
      source,
      task: cleanTask,
      engagementId,
      phase: "allocating",
      operatives: alloc.operatives,
      roles: alloc.roles,
      counts: { operatives: alloc.operatives.length, items: 0, findings: 0, verified: 0, closed: 0 },
      startedAt: at,
      updatedAt: at,
      completedAt: null,
    };

    this.appendAudit({ type: "ops.start", engagementId, actor: alloc.lead.callsign, decision: "start", reason: `Операция начата: ${alloc.operatives.length} оператор(ов)`, detail: { opId, task: cleanTask, roles: alloc.roles } });

    this.buildBeats(engagementId, alloc, cleanTask);
    this.seedAndRun();
    this.emit();

    return { opId, stop: () => this.stopIfOp(opId) };
  }

  /** Start a demo op only if none is running (the pult calls this). Ref-counted:
   *  the demo stops when the last pult closes, but a briefing/runtime op is left
   *  untouched. Returns a release function. */
  ensureDemo(deps?: OpsControllerDeps): () => void {
    this.demoRefs += 1;
    if (!this.isRunning()) {
      this.startOp(DEMO_TASK, { source: "demo", deps });
    }
    return () => this.releaseDemo();
  }

  private releaseDemo(): void {
    this.demoRefs = Math.max(0, this.demoRefs - 1);
    if (this.demoRefs === 0 && this.state?.source === "demo") {
      this.stop();
    }
  }

  /** Stop the current op (clears the timeline; keeps the last report queryable). */
  stop(): void {
    this.teardownTimeline();
    if (this.state) {
      this.state = { ...this.state, phase: "stopped", updatedAt: this.now() };
      this.appendAudit({ type: "ops.stop", engagementId: this.state.engagementId, actor: null, decision: "stop", reason: "Операция остановлена", detail: { opId: this.state.opId } });
    }
    this.emit();
  }

  private stopIfOp(opId: string): void {
    if (this.state?.opId === opId) this.stop();
  }

  // --- scope-gated, audited transition (the orchestrator core wiring) ---------

  /** Apply a transition to a work item: route → scope-gate (acting steps) → state
   *  machine → persist → audit. Fail-closed; a denied scope stops the move. */
  transition(id: string, action: string, params: Record<string, unknown> = {}): OpsWorkItem {
    const current = this.board.get(id);
    if (!current) throw new OpsError("NOT_FOUND", `Рабочий элемент не найден: ${id}.`);

    // 1. Flat route plan (seam for a future policy check; no sanction gate).
    routePlan(current, action, params as { helper?: unknown; assignTo?: unknown });

    // 2. Scope gate (fail-closed) for anything touching a real target.
    if (ACTING_TRANSITIONS.has(action) && current.engagementId && current.target != null) {
      const decision = this.scopeGate.check({
        engagementId: current.engagementId,
        actor: String(params.by ?? current.assignee ?? `role:${current.currentRole}`),
        action: `workitem:${action}`,
        target: current.target,
      });
      this.appendAudit({
        type: "ops.preflight",
        engagementId: current.engagementId,
        actor: String(params.by ?? current.assignee ?? ""),
        decision: decision.decision,
        reason: decision.reason,
        detail: { workItemId: id, action, target: current.target, allowed: decision.allowed, assetId: decision.assetId },
      });
      if (!decision.allowed) {
        throw new OpsError("DENIED", `Переход '${action}' отклонён scope-gate: ${decision.reason}`);
      }
    }

    // 3. State machine (pure) + persist + audit.
    const { item, reason } = applyTransition(current, action, params as Record<string, unknown>, { now: this.now });
    this.board.put(item);
    const last = item.routingTrail[item.routingTrail.length - 1];
    this.appendAudit({
      type: "ops.transition",
      engagementId: item.engagementId,
      actor: String(params.by ?? last.by),
      decision: action,
      reason,
      detail: { workItemId: item.id, action, from: last.from, to: last.to, status: item.status },
    });
    return item;
  }

  /** Create a work item on the board (audited). */
  createItem(input: CreateWorkItemInput): OpsWorkItem {
    const item = createWorkItem(input, { now: this.now });
    this.board.put(item);
    const birth = item.routingTrail[item.routingTrail.length - 1];
    this.appendAudit({ type: "ops.create", engagementId: item.engagementId, actor: item.createdBy, decision: birth.action, reason: birth.reason, detail: { workItemId: item.id, originRole: item.originRole, targetRole: item.targetRole } });
    this.refreshCounts();
    return item;
  }

  // --- the demo organism ------------------------------------------------------

  private buildBeats(engagementId: string, alloc: SwarmAllocation, task: string): void {
    const beats: Array<() => void> = [];
    const lead = alloc.lead.callsign;
    const op = (role: OpsRole): OpsOperative => alloc.operatives.find((o) => o.role === role && !o.lead) ?? alloc.operatives.find((o) => o.role === role) ?? alloc.lead;
    const say = (callsign: string, kind: ChatterInput["kind"], text: string, extra: Partial<ChatterInput> = {}) => () => this.chatter.post({ callsign, kind, text, ...extra });

    // Lead announces the task and the allocation (organism forms).
    beats.push(say(lead, "status", `Scope подтверждён: ${DEMO_SCOPE_SUMMARY}. Беру ${alloc.operatives.length} оператор(ов) на задачу.`));
    beats.push(say(lead, "delegate", `Распределяю роли: ${alloc.roles.map((r) => OPS_ROLE_META[r].short).join(", ")}. Работаем единым организмом, находки передаём по цепочке.`));

    // Create the role tracks on the board as items (recon leads, chained onward).
    const reconItem = this.createItem({ title: `Разведка периметра: ${task}`.slice(0, 120), type: "task", originRole: "recon", targetRole: "recon", reviewRole: "reporting", assignee: op("recon").callsign, engagementId, target: "example.com" });
    beats.push(() => {
      this.setPhase("running");
      this.safeTransition(reconItem.id, "start", { by: op("recon").callsign, reason: "разведка начата" });
      this.chatter.post({ callsign: op("recon").callsign, kind: "accept", text: "Беру разведку. Пассивно картирую поддомены и сервисы, строго в scope." });
    });

    // Recon findings → chain to web-api (one role's finding becomes another's input).
    beats.push(this.findingBeat("OP-R01", op("recon").callsign));
    beats.push(this.findingBeat("OP-R02", op("recon").callsign));
    beats.push(() => {
      const webItem = this.chainTo(reconItem.id, "web-api", { title: "Проверка dev.example.com по цепочке от разведки", target: "dev.example.com", assignee: op("web-api").callsign, engagementId });
      this.chatter.post({ callsign: op("recon").callsign, kind: "delegate", text: `${op("web-api").callsign}, передаю dev.example.com — забытое dev-окружение, посмотри API.` });
      this.chatter.post({ callsign: op("web-api").callsign, kind: "accept", text: "Принял dev.example.com, захожу аккуратно — только проверка, без воздействия." });
      if (webItem) this.safeTransition(webItem.id, "start", { by: op("web-api").callsign });
      this.webItemId = webItem?.id ?? null;
    });

    // Web/API finds the critical injection; network + identity work in parallel.
    beats.push(this.findingBeat("OP-W01", op("web-api").callsign));
    beats.push(this.findingBeat("OP-W02", op("web-api").callsign));
    beats.push(this.findingBeat("OP-N01", op("network").callsign));
    beats.push(() => {
      this.chatter.post({ callsign: op("network").callsign, kind: "delegate", text: `${op("identity").callsign}, на 203.0.113.21 слабый служебный вход — твой профиль по доступам.` });
      const idItem = this.createItem({ title: "Доступы на 203.0.113.21", type: "chain", originRole: "network", targetRole: "identity", reviewRole: "reporting", critical: true, assignee: op("identity").callsign, engagementId, target: "203.0.113.21", chainedFrom: "network" });
      this.safeTransition(idItem.id, "start", { by: op("identity").callsign });
      this.idItemId = idItem.id;
    });
    beats.push(this.findingBeat("OP-I01", op("identity").callsign));

    // Exploitation chains the findings toward full control (sandbox only).
    beats.push(() => {
      this.setPhase("chaining");
      this.chatter.post({ callsign: op("exploitation").callsign, kind: "finding", severity: "critical", text: "Цепочка складывается: слабый вход + устаревший сервис → путь к полному контролю узла. Отрабатываю в песочнице.", geo: { lat: 52.3676, lon: 4.9041 } });
      const xItem = this.createItem({ title: "Повышение прав до полного контроля (в песочнице)", type: "chain", originRole: "identity", targetRole: "exploitation", reviewRole: "reporting", critical: true, assignee: op("exploitation").callsign, engagementId, target: "203.0.113.21", chainedFrom: "identity" });
      this.safeTransition(xItem.id, "start", { by: op("exploitation").callsign });
      this.xItemId = xItem.id;
    });
    beats.push(this.findingBeat("OP-X01", op("exploitation").callsign));
    beats.push(this.findingBeat("OP-D01", op("osint").callsign));

    // Independent verification of the critical items (a DIFFERENT operative).
    beats.push(() => {
      this.setPhase("verifying");
      const verifier = op("reporting").callsign;
      for (const id of [this.idItemId, this.xItemId]) {
        if (!id) continue;
        this.safeTransition(id, "send-to-review", { by: this.board.get(id)?.assignee ?? verifier });
        this.safeTransition(id, "verdict", { by: verifier, pass: true, note: "воспроизведено независимо в песочнице" });
      }
      this.chatter.post({ callsign: verifier, kind: "verify", text: "Подтверждаю критичные находки независимо — воспроизведено в песочнице. Статус: confirmed." });
    });

    // Guardrail reminder + reporting closes the loop and the report is ready.
    beats.push(() => this.chatter.post({ callsign: lead, kind: "escalate", text: "Напоминание: внешние письма — только через оператора. Мы фиксируем находки и готовим отчёт, не действуем по целям." }));
    beats.push(() => {
      this.setPhase("reporting");
      for (const id of [this.idItemId, this.xItemId]) if (id && this.board.get(id)?.status === "verified") this.safeTransition(id, "close", { by: op("reporting").callsign });
      this.chatter.post({ callsign: op("reporting").callsign, kind: "status", text: "Собираю доказательства и формирую отчёт: цель, что сделали, как вошли, где слабости, возможный ущерб, рекомендации." });
      this.completeOp();
    });

    this.beats = beats;
  }

  private webItemId: string | null = null;
  private idItemId: string | null = null;
  private xItemId: string | null = null;

  /** A beat that emits one op finding into the OSINT feed (→ pult + globe) and
   *  records it for the report (tool dropped there). */
  private findingBeat(findingId: string, by: string): () => void {
    return () => {
      const finding = OP_FINDINGS.find((f) => f.id === findingId);
      if (!finding) return;
      this.emitFinding(finding, by);
    };
  }

  private emitFinding(finding: OpFinding, by: string): void {
    if (this.emittedFindings.has(finding.id)) return;
    this.emittedFindings.add(finding.id);

    // Into the OSINT feed (augment the current dataset; a new object re-projects
    // geolocated entities onto the shared globe through osintController).
    const base = this.osint.getData() ?? DEMO_OSINT;
    const osintFinding: OsintFinding = {
      id: finding.id,
      sourceToolId: finding.toolId,
      title: finding.title,
      entityId: finding.entityId,
      target: finding.target,
      severity: finding.severity === "critical" || finding.severity === "high" ? "high" : finding.severity === "info" ? "info" : finding.severity,
      confidence: finding.confidence,
    };
    if (!base.findings.some((f) => f.id === finding.id)) {
      this.osint.setData({ ...base, findings: [...base.findings, osintFinding] });
    }

    // For the report (tool-free): title + severity + where.
    this.reportFindings.push({ title: finding.title, severity: finding.severity, where: finding.target });

    // Human-language chatter line for the finding.
    const severe = finding.severity === "critical" || finding.severity === "high";
    this.chatter.post({
      callsign: by,
      kind: "finding",
      severity: finding.severity,
      text: `${finding.title} — ${finding.target}.${severe ? " Критично, беру на подтверждение." : " В отчёт."}`,
    });
    this.refreshCounts();
  }

  /** Chain one role's finding into a new item for another role (within scope). */
  private chainTo(parentId: string, toRole: OpsRole, opts: { title: string; target: string; assignee: string; engagementId: string }): OpsWorkItem | null {
    const parent = this.board.get(parentId);
    if (!parent) return null;
    return this.createItem({
      title: opts.title.slice(0, 120),
      type: "chain",
      originRole: parent.currentRole,
      targetRole: toRole,
      reviewRole: "reporting",
      assignee: opts.assignee,
      engagementId: opts.engagementId,
      target: opts.target,
      parentId,
      chainedFrom: parent.currentRole,
      reason: `цепочка от ${roleLabel(parent.currentRole)}`,
    });
  }

  private safeTransition(id: string, action: string, params: Record<string, unknown>): void {
    try {
      this.transition(id, action, params);
      this.refreshCounts();
    } catch (err) {
      // A refused scope/transition is audited inside transition(); never throw out
      // of the demo driver (fail-closed, but the organism keeps talking).
      if (!(err instanceof OpsError)) throw err;
    }
  }

  private completeOp(): void {
    if (!this.state) return;
    this.report = null; // force a rebuild from the accumulated findings
    this.getReport(this.reportMode);
    this.state = { ...this.state, phase: "complete", completedAt: this.now(), updatedAt: this.now() };
    this.appendAudit({ type: "ops.complete", engagementId: this.state.engagementId, actor: null, decision: "complete", reason: "Операция завершена, отчёт сформирован", detail: { opId: this.state.opId, findings: this.reportFindings.length } });
    this.emit();
  }

  // --- timeline plumbing ------------------------------------------------------

  private seedAndRun(): void {
    // Backfill a few beats so the pult opens populated.
    const seed = Math.min(SEED_BEATS, this.beats.length);
    for (let i = 0; i < seed; i += 1) this.runNextBeat();
    this.timer = setInterval(() => this.tick(), BEAT_MS);
  }

  private tick(): void {
    if (this.cursor < this.beats.length) {
      this.runNextBeat();
      return;
    }
    // After the script, keep a light ambient heartbeat (no new findings/report).
    const lead = this.alloc?.lead.callsign ?? "AM7";
    this.chatter.post({ callsign: lead, kind: "status", text: "Периметр под наблюдением, цели отвечают стабильно, scope держим." });
  }

  private runNextBeat(): void {
    const beat = this.beats[this.cursor];
    this.cursor += 1;
    if (beat) beat();
  }

  private teardownTimeline(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.cursor = 0;
    this.beats = [];
    this.webItemId = this.idItemId = this.xItemId = null;
  }

  private applyDeps(deps?: OpsControllerDeps): void {
    if (!deps) return;
    if (deps.chatter) this.chatter = deps.chatter;
    if (deps.osint) this.osint = deps.osint;
    if (deps.scopeGate) this.scopeGate = deps.scopeGate;
    if (deps.now) this.now = deps.now;
  }

  private setPhase(phase: OpsState["phase"]): void {
    if (!this.state || this.state.phase === phase) return;
    this.state = { ...this.state, phase, updatedAt: this.now() };
    this.emit();
  }

  private refreshCounts(): void {
    if (!this.state) return;
    const items = this.board.list();
    const counts = {
      operatives: this.state.operatives.length,
      items: items.length,
      findings: this.emittedFindings.size,
      verified: items.filter((i) => i.status === "verified" || i.status === "closed").length,
      closed: items.filter((i) => i.status === "closed").length,
    };
    this.state = { ...this.state, counts, updatedAt: this.now() };
    this.emit();
  }

  private appendAudit(entry: Omit<OpsAuditEntry, "seq" | "at">): void {
    this.audit.push({ seq: (this.auditSeq += 1), at: this.now(), ...entry });
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.state);
  }
}

/** The one ops controller shared by the pult, the briefing and (later) the backend. */
export const opsController = new OpsController();

export { DEMO_TASK as OPS_DEMO_TASK, DEMO_SCOPE_SUMMARY as OPS_DEMO_SCOPE };
