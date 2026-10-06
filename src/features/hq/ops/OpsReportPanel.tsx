"use client";

import { useEffect, useMemo, useState } from "react";
import { Copy, Download, FileText, X } from "lucide-react";

import { opsController } from "./opsController";
import {
  REPORT_SEVERITY_BADGE,
  REPORT_SEVERITY_RU,
  renderReportMarkdown,
  renderReportText,
  type OpsReport,
  type OpsReportMode,
  type OpsReportSeverity,
} from "./report";

/**
 * The «Отчёт» overlay (owner 2026-10-07, «как у Strix»): on demand, assembles
 * the clean delivered report from the current op's accumulated findings and
 * renders it as a readable document. Two modes: «исправим сами» (we fix it) and
 * «рекомендации» (hand to the owner's engineers). Export: Markdown / plain text.
 *
 * The model enforces the HARD INVARIANT in report.ts: no tool/command name ever
 * reaches a delivered field. The panel displays only what the model carries.
 */

export type OpsReportPanelProps = {
  open: boolean;
  onClose: () => void;
};

export function OpsReportPanel({ open, onClose }: OpsReportPanelProps) {
  const [mode, setMode] = useState<OpsReportMode>("recommendations");
  const [copied, setCopied] = useState(false);

  // Esc closes.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // The model distils from live findings each time open/mode changes — pure
  // compute, no state in effect. A tool-name leak would throw per the report
  // invariant; render a stub so the pult does not go dark.
  const report: OpsReport | null = useMemo(() => {
    if (!open) return null;
    try {
      return opsController.getReport(mode);
    } catch (error) {
      console.error("Отчёт не собран:", error);
      return null;
    }
  }, [open, mode]);

  const markdown = useMemo(() => (report ? renderReportMarkdown(report) : ""), [report]);

  if (!open) return null;

  const copy = async () => {
    if (!markdown) return;
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard may be unavailable (headless); the download still works.
    }
  };

  const download = (kind: "md" | "txt") => {
    if (!report) return;
    const content = kind === "md" ? markdown : renderReportText(report);
    const type = kind === "md" ? "text/markdown;charset=utf-8" : "text/plain;charset=utf-8";
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `отчёт-операции.${kind}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-4" role="dialog" aria-modal="true" aria-labelledby="ops-report-title">
      <div className="relative flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-white/10 bg-[#0b0b0c] text-white shadow-[0_20px_80px_rgba(0,0,0,0.6)]">
        <header className="flex items-center justify-between gap-3 border-b border-white/10 bg-black/60 px-5 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <FileText className="h-4 w-4 text-amber-300" aria-hidden />
            <h2 id="ops-report-title" className="font-mono text-sm font-semibold uppercase tracking-[0.22em]">
              Отчёт по авторизованной проверке
            </h2>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <ModeToggle mode={mode} setMode={setMode} />
            <button
              type="button"
              onClick={onClose}
              className="flex h-8 items-center gap-1.5 rounded-md border border-white/10 bg-black/40 px-3 font-mono text-[11px] uppercase tracking-[0.12em] text-white/80 transition-colors hover:border-white/30 hover:bg-white/5"
              aria-label="Закрыть отчёт"
            >
              <X className="h-3.5 w-3.5" />
              Закрыть
            </button>
          </div>
        </header>

        {report ? (
          <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5 text-[13px] leading-relaxed">
            <Section title="Цель">{report.target}</Section>
            <Section title="Что сделали">{report.summary}</Section>
            <Section title="Как получили доступ">{report.access}</Section>

            <section>
              <SectionTitle>Где были уязвимости</SectionTitle>
              {report.vulnerabilities.length ? (
                <ul className="mt-2 space-y-1.5">
                  {report.vulnerabilities.map((v, i) => (
                    <li key={i} className="flex items-start gap-2">
                      <SeverityBadge severity={v.severity} />
                      <span className="flex-1 text-white/90">
                        {v.title}
                        <span className="ml-2 font-mono text-[11px] text-white/50">— {v.where}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-white/60">Явных уязвимостей не зафиксировано.</p>
              )}
            </section>

            <section>
              <SectionTitle>Возможный ущерб</SectionTitle>
              <ul className="mt-2 space-y-1 text-white/85">
                {report.damage.map((d, i) => (
                  <li key={i} className="before:mr-2 before:text-white/40 before:content-['•']">
                    {d}
                  </li>
                ))}
              </ul>
            </section>

            <section>
              <SectionTitle>Рекомендации</SectionTitle>
              <ul className="mt-2 space-y-1 text-white/85">
                {report.recommendations.map((r, i) => (
                  <li key={i} className="before:mr-2 before:text-amber-300/80 before:content-['→']">
                    {r}
                  </li>
                ))}
              </ul>
            </section>

            <p className="pt-2 font-mono text-[11px] text-white/40">
              Сформировано: {new Date(report.generatedAt).toLocaleString("ru-RU")} · режим:{" "}
              {mode === "fix-ourselves" ? "исправим сами" : "рекомендации"}
            </p>
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center p-10 text-white/60">Отчёт пока не собран.</div>
        )}

        <footer className="flex items-center justify-between gap-3 border-t border-white/10 bg-black/50 px-5 py-3 font-mono text-[11px] uppercase tracking-[0.12em] text-white/60">
          <span>Инструменты в отчёте не перечисляются (политика).</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={copy}
              disabled={!markdown}
              className="flex h-8 items-center gap-1.5 rounded-md border border-white/10 bg-black/40 px-3 text-white/80 transition-colors hover:border-white/30 hover:bg-white/5 disabled:opacity-40"
            >
              <Copy className="h-3.5 w-3.5" />
              {copied ? "Скопировано" : "Копировать MD"}
            </button>
            <button
              type="button"
              onClick={() => download("md")}
              disabled={!report}
              className="flex h-8 items-center gap-1.5 rounded-md border border-white/10 bg-black/40 px-3 text-white/80 transition-colors hover:border-white/30 hover:bg-white/5 disabled:opacity-40"
            >
              <Download className="h-3.5 w-3.5" />
              .md
            </button>
            <button
              type="button"
              onClick={() => download("txt")}
              disabled={!report}
              className="flex h-8 items-center gap-1.5 rounded-md border border-white/10 bg-black/40 px-3 text-white/80 transition-colors hover:border-white/30 hover:bg-white/5 disabled:opacity-40"
            >
              <Download className="h-3.5 w-3.5" />
              .txt
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

function ModeToggle({ mode, setMode }: { mode: OpsReportMode; setMode: (m: OpsReportMode) => void }) {
  const tab = (value: OpsReportMode, label: string) => (
    <button
      key={value}
      type="button"
      onClick={() => setMode(value)}
      className={`h-8 rounded-md px-3 font-mono text-[11px] uppercase tracking-[0.1em] transition-colors ${
        mode === value ? "bg-amber-500/20 text-amber-100" : "text-white/60 hover:text-white"
      }`}
    >
      {label}
    </button>
  );
  return (
    <div className="hidden items-center gap-1 rounded-md border border-white/10 bg-black/40 p-0.5 md:flex">
      {tab("recommendations", "Рекомендации")}
      {tab("fix-ourselves", "Исправим сами")}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <SectionTitle>{title}</SectionTitle>
      <p className="mt-2 text-white/90">{children}</p>
    </section>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="font-mono text-[11px] uppercase tracking-[0.18em] text-white/50">{children}</h3>
  );
}

const SEVERITY_TONE: Record<OpsReportSeverity, string> = {
  critical: "border-red-500/60 bg-red-600/25 text-red-100",
  high: "border-orange-500/60 bg-orange-600/20 text-orange-100",
  medium: "border-amber-500/50 bg-amber-500/15 text-amber-100",
  low: "border-sky-500/50 bg-sky-600/15 text-sky-100",
  info: "border-white/20 bg-white/10 text-white/75",
};

function SeverityBadge({ severity }: { severity: OpsReportSeverity }) {
  return (
    <span
      className={`shrink-0 rounded border px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.1em] ${SEVERITY_TONE[severity]}`}
      title={REPORT_SEVERITY_RU[severity]}
    >
      {REPORT_SEVERITY_BADGE[severity]}
    </span>
  );
}
