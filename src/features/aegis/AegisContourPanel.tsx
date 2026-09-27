"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import * as api from "@/features/aegis/api";
import type {
  AegisAssetKind,
  AegisAuditEntry,
  AegisEgress,
  AegisEngagement,
  AegisOverview,
  AegisStatus,
} from "@/lib/aegis/types";
import { t, type TranslationKey } from "@/lib/i18n";

const OPERATOR_KEY = "office3d.aegis.operator";

const STATUS_CLASS: Record<AegisStatus, string> = {
  draft: "border-white/15 text-white/60",
  authorized: "border-orange-400/40 text-orange-300",
  active: "border-red-500/50 bg-red-600/20 text-white",
  stopped: "border-white/15 text-white/55",
  completed: "border-red-900/40 text-white/70",
};

const STATUS_LABEL_KEY: Record<AegisStatus, TranslationKey> = {
  draft: "aegis.statusDraft",
  authorized: "aegis.statusAuthorized",
  active: "aegis.statusActive",
  stopped: "aegis.statusStopped",
  completed: "aegis.statusCompleted",
};

const statusLabel = (status: AegisStatus): string => t(STATUS_LABEL_KEY[status]);

const decisionClass = (decision: string | null): string =>
  decision === "allow" ? "text-red-300" : decision === "hold" ? "text-orange-300" : "text-white/45";

const fieldClass =
  "w-full rounded border border-red-900/50 bg-black/60 px-2 py-1.5 font-mono text-[11px] text-white placeholder:text-white/35 focus:border-red-500/70 focus:outline-none focus:ring-1 focus:ring-red-500/30 [color-scheme:dark]";
const labelClass = "font-mono text-[9px] font-semibold uppercase tracking-[0.16em] text-white/45";
const primaryBtn =
  "rounded border border-red-500/60 bg-[#e3141c] px-2.5 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-white shadow-[0_0_14px_rgba(255,26,26,0.25)] transition-colors enabled:hover:border-red-400 enabled:hover:bg-[#ff2a2a] disabled:opacity-40";
const ghostBtn =
  "rounded border border-red-900/50 bg-black/40 px-2.5 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-white/80 transition-colors enabled:hover:border-red-500/50 enabled:hover:bg-red-950/40 enabled:hover:text-white disabled:opacity-40";
const dangerBtn =
  "rounded border border-red-500/50 bg-red-950/50 px-2.5 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-red-200 transition-colors enabled:hover:border-red-400/70 enabled:hover:bg-red-900/50 disabled:opacity-40";

const Section = ({ title, children }: { title: React.ReactNode; children: React.ReactNode }) => (
  <section className="rounded-lg border border-red-900/40 bg-black/40 p-3">
    <div className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-white/55">{title}</div>
    {children}
  </section>
);

export function AegisContourPanel() {
  const [overview, setOverview] = useState<AegisOverview | null>(null);
  const [detail, setDetail] = useState<{ engagement: AegisEngagement; egress: AegisEgress | null } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [audit, setAudit] = useState<AegisAuditEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [operator, setOperator] = useState("");
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedId;

  useEffect(() => {
    try {
      setOperator(window.localStorage.getItem(OPERATOR_KEY) ?? "");
    } catch {
      // storage blocked — the field just starts empty
    }
  }, []);
  const rememberOperator = useCallback((value: string) => {
    setOperator(value);
    try {
      window.localStorage.setItem(OPERATOR_KEY, value);
    } catch {
      // ignore
    }
  }, []);

  const refresh = useCallback(async () => {
    const [ov, au] = await Promise.all([
      api.fetchOverview(),
      api.fetchAudit({ engagementId: selectedRef.current ?? undefined, limit: 40 }),
    ]);
    setOverview(ov);
    setAudit(au.entries);
    if (selectedRef.current) {
      try {
        setDetail(await api.fetchEngagement(selectedRef.current));
      } catch {
        setSelectedId(null);
        setDetail(null);
      }
    }
  }, []);

  useEffect(() => {
    void refresh().catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
    const timer = window.setInterval(() => {
      void refresh().catch(() => {});
    }, 6000);
    return () => window.clearInterval(timer);
  }, [refresh, selectedId]);

  // Runs a mutation, then refreshes; surfaces a refusal inline.
  const run = useCallback(
    async (action: () => Promise<unknown>) => {
      setBusy(true);
      setError(null);
      try {
        await action();
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const needOperator = (): boolean => {
    if (operator.trim()) return true;
    setError(t("aegis.needOperator"));
    return false;
  };

  const kill = overview?.killSwitch;
  const integrity = overview?.audit;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto p-3">
        {error ? (
          <div className="rounded border border-red-500/50 bg-red-950/50 px-2.5 py-1.5 font-mono text-[11px] text-red-200">
            {error}
          </div>
        ) : null}

        {/* Operator identity — used as the "by"/signer on every audited act. */}
        <div>
          <label className={labelClass} htmlFor="aegis-operator">
            {t("aegis.operator")}
          </label>
          <input
            id="aegis-operator"
            className={`${fieldClass} mt-1`}
            value={operator}
            placeholder={t("aegis.operatorPh")}
            onChange={(event) => rememberOperator(event.target.value)}
          />
        </div>

        {/* Kill-switch — the whole platform's stop button. */}
        <Section title={t("aegis.killTitle")}>
          <div className="flex items-center justify-between gap-2">
            <span
              className={`inline-flex items-center gap-1.5 font-mono text-[11px] font-semibold uppercase tracking-[0.12em] ${
                kill?.global ? "text-red-300" : "text-white/70"
              }`}
            >
              <span
                aria-hidden="true"
                className={`h-2 w-2 rounded-full ${kill?.global ? "animate-pulse bg-red-500 shadow-[0_0_10px_rgba(255,42,42,0.9)]" : "bg-white/25"}`}
              />
              {kill?.global ? t("aegis.killOn") : t("aegis.killOff")}
            </span>
            <button
              type="button"
              disabled={busy}
              className={kill?.global ? ghostBtn : dangerBtn}
              onClick={() => {
                if (!needOperator()) return;
                void run(() => api.setKillSwitch({ on: !kill?.global, by: operator.trim(), reason: "" }));
              }}
            >
              {kill?.global ? t("aegis.release") : t("aegis.engage")}
            </button>
          </div>
          {kill?.global ? <p className="mt-1.5 font-mono text-[10px] text-red-200/80">{t("aegis.killedNote")}</p> : null}
        </Section>

        {/* Audit integrity at a glance. */}
        {integrity ? (
          <div
            className={`flex items-center gap-1.5 rounded border px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] ${
              integrity.ok ? "border-red-900/40 text-white/70" : "border-red-500/60 bg-red-950/50 text-red-200"
            }`}
          >
            <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${integrity.ok ? "bg-red-500" : "bg-red-400 animate-pulse"}`} />
            {integrity.ok ? t("aegis.integrityOk", { count: integrity.count }) : t("aegis.integrityBad")}
          </div>
        ) : null}

        {detail && selectedId ? (
          <EngagementDetail
            data={detail}
            operator={operator}
            busy={busy}
            run={run}
            needOperator={needOperator}
            onBack={() => {
              setSelectedId(null);
              setDetail(null);
            }}
          />
        ) : (
          <EngagementList
            overview={overview}
            busy={busy}
            operator={operator}
            run={run}
            onOpen={(id) => setSelectedId(id)}
          />
        )}

        {/* The audit trail — every decision and state change. */}
        <Section title={selectedId ? t("aegis.auditForEngagement") : t("aegis.audit")}>
          {audit.length === 0 ? (
            <p className="font-mono text-[10px] text-white/40">{t("aegis.noAudit")}</p>
          ) : (
            <ul className="space-y-1">
              {[...audit].reverse().map((entry) => (
                <li key={entry.seq} className="font-mono text-[10px] leading-tight text-white/70">
                  <span className="text-white/35">#{entry.seq}</span>{" "}
                  {entry.decision ? <span className={decisionClass(entry.decision)}>{entry.decision.toUpperCase()}</span> : null}{" "}
                  <span className="text-white/80">{entry.type}</span>
                  {entry.reason ? <span className="text-white/45"> — {entry.reason}</span> : null}
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </div>
  );
}

function EngagementList({
  overview,
  busy,
  operator,
  run,
  onOpen,
}: {
  overview: AegisOverview | null;
  busy: boolean;
  operator: string;
  run: (action: () => Promise<unknown>) => Promise<void>;
  onOpen: (id: string) => void;
}) {
  const [name, setName] = useState("");
  return (
    <Section title={t("aegis.engagements")}>
      {overview && overview.engagements.length > 0 ? (
        <ul className="space-y-1.5">
          {overview.engagements.map((engagement) => (
            <li key={engagement.id}>
              <button
                type="button"
                onClick={() => onOpen(engagement.id)}
                className="flex w-full items-center justify-between gap-2 rounded border border-red-900/40 bg-black/40 px-2.5 py-1.5 text-left transition-colors hover:border-red-500/50 hover:bg-red-950/40"
              >
                <span className="min-w-0 truncate font-mono text-[11px] text-white">{engagement.name}</span>
                <span className="flex shrink-0 items-center gap-1.5">
                  <span className="font-mono text-[9px] text-white/40">{engagement.assetCount}</span>
                  <span
                    className={`rounded border px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-[0.1em] ${STATUS_CLASS[engagement.status]}`}
                  >
                    {statusLabel(engagement.status)}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="font-mono text-[10px] text-white/40">{t("aegis.noEngagements")}</p>
      )}

      <form
        className="mt-2.5 flex gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          const trimmed = name.trim();
          if (!trimmed) return;
          void run(() => api.createEngagement({ name: trimmed })).then(() => setName(""));
        }}
      >
        <input
          className={fieldClass}
          value={name}
          placeholder={t("aegis.namePh")}
          onChange={(event) => setName(event.target.value)}
          aria-label={t("aegis.newEngagement")}
        />
        <button type="submit" disabled={busy || !name.trim()} className={primaryBtn}>
          {t("aegis.create")}
        </button>
      </form>
      {!operator.trim() ? <p className="mt-1.5 font-mono text-[9px] text-white/35">{t("aegis.operatorHint")}</p> : null}
    </Section>
  );
}

function EngagementDetail({
  data,
  operator,
  busy,
  run,
  needOperator,
  onBack,
}: {
  data: { engagement: AegisEngagement; egress: AegisEgress | null };
  operator: string;
  busy: boolean;
  run: (action: () => Promise<unknown>) => Promise<void>;
  needOperator: () => boolean;
  onBack: () => void;
}) {
  const { engagement, egress } = data;
  const isDraft = engagement.status === "draft";

  const [kind, setKind] = useState<AegisAssetKind>("domain");
  const [value, setValue] = useState("");
  const [subdomains, setSubdomains] = useState(false);
  const [letterRef, setLetterRef] = useState("");
  const [signer, setSigner] = useState("");
  const [showNft, setShowNft] = useState(false);

  return (
    <Section
      title={
        <span className="inline-flex items-center gap-1">
          <button type="button" onClick={onBack} className="text-white/50 hover:text-white" aria-label={t("aegis.back")}>
            ←
          </button>
          {t("aegis.engagement")}
        </span>
      }
    >
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate font-mono text-[12px] font-semibold text-white">{engagement.name}</span>
        <span className={`shrink-0 rounded border px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-[0.1em] ${STATUS_CLASS[engagement.status]}`}>
          {statusLabel(engagement.status)}
        </span>
      </div>

      {/* Scope assets */}
      <div className="mt-2.5">
        <div className={labelClass}>{t("aegis.assets")}</div>
        {engagement.assets.length === 0 ? (
          <p className="mt-1 font-mono text-[10px] text-white/40">{t("aegis.noAssets")}</p>
        ) : (
          <ul className="mt-1 space-y-1">
            {engagement.assets.map((asset) => (
              <li key={asset.id} className="flex items-center justify-between gap-2 rounded bg-black/40 px-2 py-1">
                <span className="min-w-0 truncate font-mono text-[10px] text-white/85">
                  <span className="text-red-300">{asset.kind}</span> {asset.value}
                  {asset.includeSubdomains ? <span className="text-white/40"> *</span> : null}
                  {asset.ports && asset.ports.length ? <span className="text-white/40"> :{asset.ports.join(",")}</span> : null}
                </span>
                {isDraft ? (
                  <button
                    type="button"
                    disabled={busy}
                    className="shrink-0 font-mono text-[11px] text-white/40 hover:text-red-300 disabled:opacity-40"
                    aria-label={t("aegis.remove")}
                    onClick={() => void run(() => api.engagementOp(engagement.id, { op: "removeAsset", assetId: asset.id }))}
                  >
                    ×
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      {isDraft ? (
        <form
          className="mt-2 space-y-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = value.trim();
            if (!trimmed) return;
            const asset: Record<string, unknown> = { kind, value: trimmed };
            if ((kind === "domain" || kind === "url") && subdomains) asset.includeSubdomains = true;
            void run(() => api.engagementOp(engagement.id, { op: "addAsset", asset })).then(() => setValue(""));
          }}
        >
          <div className="flex gap-1.5">
            <select
              className={`${fieldClass} w-auto`}
              value={kind}
              onChange={(event) => setKind(event.target.value as AegisAssetKind)}
              aria-label={t("aegis.kind")}
            >
              <option value="domain">{t("aegis.kindDomain")}</option>
              <option value="ip">{t("aegis.kindIp")}</option>
              <option value="cidr">{t("aegis.kindCidr")}</option>
              <option value="url">{t("aegis.kindUrl")}</option>
            </select>
            <input
              className={fieldClass}
              value={value}
              placeholder={t("aegis.valuePh")}
              onChange={(event) => setValue(event.target.value)}
              aria-label={t("aegis.value")}
            />
          </div>
          <div className="flex items-center justify-between gap-2">
            {kind === "domain" || kind === "url" ? (
              <label className="flex items-center gap-1.5 font-mono text-[10px] text-white/60">
                <input type="checkbox" className="accent-[#e3141c]" checked={subdomains} onChange={(event) => setSubdomains(event.target.checked)} />
                {t("aegis.subdomains")}
              </label>
            ) : (
              <span />
            )}
            <button type="submit" disabled={busy || !value.trim()} className={ghostBtn}>
              {t("aegis.add")}
            </button>
          </div>
        </form>
      ) : null}

      {/* Authorization + activation (the manual legal gate) */}
      {isDraft ? (
        <form
          className="mt-2.5 space-y-1.5 border-t border-red-900/40 pt-2.5"
          onSubmit={(event) => {
            event.preventDefault();
            if (!letterRef.trim() || !(signer.trim() || operator.trim())) return;
            void run(() =>
              api.engagementOp(engagement.id, { op: "authorize", letterRef: letterRef.trim(), signer: (signer.trim() || operator.trim()) }),
            );
          }}
        >
          <div className={labelClass}>{t("aegis.authorization")}</div>
          <input className={fieldClass} value={letterRef} placeholder={t("aegis.letterRefPh")} onChange={(event) => setLetterRef(event.target.value)} aria-label={t("aegis.letterRef")} />
          <input className={fieldClass} value={signer} placeholder={t("aegis.signerPh")} onChange={(event) => setSigner(event.target.value)} aria-label={t("aegis.signer")} />
          <button type="submit" disabled={busy || engagement.assets.length === 0 || !letterRef.trim()} className={ghostBtn}>
            {t("aegis.authorize")}
          </button>
        </form>
      ) : null}

      {engagement.authorization ? (
        <p className="mt-2 font-mono text-[10px] text-white/55">
          {t("aegis.authRecorded", { signer: engagement.authorization.signer, ref: engagement.authorization.letterRef })}
        </p>
      ) : null}

      {engagement.status === "authorized" ? (
        <div className="mt-2.5 border-t border-red-900/40 pt-2.5">
          <p className="mb-1.5 font-mono text-[10px] text-orange-300/90">{t("aegis.activateHint")}</p>
          <button
            type="button"
            disabled={busy}
            className={primaryBtn}
            onClick={() => {
              if (!needOperator()) return;
              void run(() => api.engagementOp(engagement.id, { op: "activate", by: operator.trim(), confirm: true }));
            }}
          >
            {t("aegis.activate")}
          </button>
        </div>
      ) : null}

      {/* Egress allowlist once active */}
      {engagement.status === "active" && egress ? (
        <div className="mt-2.5 border-t border-red-900/40 pt-2.5">
          <div className={labelClass}>{t("aegis.egress")}</div>
          <p className="mt-1 font-mono text-[10px] text-white/70">
            {t("aegis.egressCounts", { domains: egress.domains.length, ipv4: egress.ipv4.length, ipv6: egress.ipv6.length })}
          </p>
          <button type="button" className="mt-1 font-mono text-[10px] text-red-300 hover:text-red-200" onClick={() => setShowNft((prev) => !prev)}>
            {showNft ? t("aegis.hideNftables") : t("aegis.showNftables")}
          </button>
          {showNft ? (
            <pre className="mt-1 max-h-40 overflow-auto rounded border border-red-900/40 bg-black/60 p-2 font-mono text-[9px] leading-tight text-white/70">
              {egress.nftables}
            </pre>
          ) : null}
        </div>
      ) : null}

      {/* Lifecycle controls */}
      <div className="mt-2.5 flex flex-wrap gap-1.5 border-t border-red-900/40 pt-2.5">
        {engagement.status === "active" ? (
          <button
            type="button"
            disabled={busy}
            className={dangerBtn}
            onClick={() => {
              if (!needOperator()) return;
              void run(() => api.engagementOp(engagement.id, { op: "stop", by: operator.trim(), reason: "" }));
            }}
          >
            {t("aegis.stop")}
          </button>
        ) : null}
        {engagement.status === "stopped" ? (
          <button
            type="button"
            disabled={busy}
            className={ghostBtn}
            onClick={() => {
              if (!needOperator()) return;
              void run(() => api.engagementOp(engagement.id, { op: "reactivate", by: operator.trim() }));
            }}
          >
            {t("aegis.reactivate")}
          </button>
        ) : null}
        {engagement.status === "active" || engagement.status === "stopped" ? (
          <button
            type="button"
            disabled={busy}
            className={ghostBtn}
            onClick={() => {
              if (!needOperator()) return;
              void run(() => api.engagementOp(engagement.id, { op: "complete", by: operator.trim() }));
            }}
          >
            {t("aegis.complete")}
          </button>
        ) : null}
      </div>
    </Section>
  );
}
