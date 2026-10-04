// Server-side append-only, hash-chained archive of Floor 27 council sessions.
//
// Reuses the AEGIS audit ledger (platform/core/audit.js: sha256 chain over the
// previous hash + a stable JSON of the record) as an independent chain written
// to <state dir>/aegis/council-archive.jsonl. One instance per process, cached
// on globalThis so concurrent requests never race on the file and it survives
// dev HMR. Imported only by the /api/office/council route — never by client code.

import path from "node:path";

import { resolveStateDir } from "@/lib/clawdbot/paths";
// JSDoc-typed CommonJS; allowJs lets it import cleanly (same as src/lib/aegis/core.ts).
import { createAuditLog } from "../../../server/aegis/audit.js";

type AuditLog = {
  append: (input: Record<string, unknown>) => {
    seq: number;
    at: number;
    hash: string;
    prevHash: string;
    detail: Record<string, unknown>;
  };
  list: (input: { limit?: number }) => Array<{ seq: number; at: number; detail: Record<string, unknown>; hash: string }>;
  verify: () => { ok: boolean; count: number; brokenAt?: number; reason?: string };
  flush: () => Promise<void>;
};

const CACHE_KEY = Symbol.for("office3d.council.archive");

const ledger = (): AuditLog => {
  const store = globalThis as unknown as Record<symbol, AuditLog | undefined>;
  if (!store[CACHE_KEY]) {
    store[CACHE_KEY] = createAuditLog({
      filePath: path.join(resolveStateDir(), "aegis", "council-archive.jsonl"),
      logError: (message: string, err?: unknown) => console.error(`[council-archive] ${message}`, err ?? ""),
    }) as unknown as AuditLog;
  }
  return store[CACHE_KEY]!;
};

export type CouncilArchiveAppend = {
  kind: string;
  startedAt: number;
  endedAt: number;
  chiefCount: number;
  decisions: unknown[];
  entries: unknown[];
  closing: string;
};

/** Appends one council session to the chain; returns its seq and chain hash. */
export async function appendCouncilSession(record: CouncilArchiveAppend): Promise<{ seq: number; hash: string; at: number }> {
  const entry = ledger().append({
    type: "council_session",
    actor: "AM7",
    decision: record.kind,
    reason: `council:${record.kind}`,
    detail: record as unknown as Record<string, unknown>,
  });
  await ledger().flush();
  return { seq: entry.seq, hash: entry.hash, at: entry.at };
}

/** The most recent council sessions, newest last (chain order). */
export function listCouncilSessions(limit = 50): Array<{ seq: number; at: number; detail: Record<string, unknown>; hash: string }> {
  return ledger().list({ limit });
}

/** Verifies the council archive's hash chain. */
export function verifyCouncilArchive(): { ok: boolean; count: number; brokenAt?: number; reason?: string } {
  return ledger().verify();
}
