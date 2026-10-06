/**
 * The demo scope gate — a small, deterministic stand-in for the AEGIS preflight
 * (server/aegis/preflight.js) that the browser-side demo can call synchronously.
 *
 * It answers the SAME contract as core.preflight.check() — {allowed, decision,
 * reason, assetId} — so the real preflight can be injected in its place with no
 * change to the orchestrator (opsController accepts a scopeGate). Default-deny:
 * a target that matches no authorized asset is refused, exactly like the kernel.
 *
 * This is NOT the security boundary (the server kernel is). It is the display/
 * coordination gate that keeps the demo honest: nothing in the swarm moves onto
 * a target the active scope does not list. Demo scope is the fictional reserved
 * lab (example.com / *.example.com / 203.0.113.0/24 TEST-NET-3).
 */

import type { OpsScopeDecision, OpsScopeGate, OpsScopeRequest } from "./types";

/** A scope asset the gate matches against (a light mirror of AegisAsset). */
export type OpsScopeAsset = {
  id: string;
  kind: "domain" | "ip" | "cidr" | "url";
  value: string;
  includeSubdomains?: boolean;
};

/** The fictional reserved demo scope (RFC 2606 / RFC 5737). Display only. */
export const DEMO_SCOPE_ASSETS: readonly OpsScopeAsset[] = [
  { id: "a-example", kind: "domain", value: "example.com", includeSubdomains: true },
  { id: "a-testnet3", kind: "cidr", value: "203.0.113.0/24" },
] as const;

/** Pull a comparable host/ip token out of a free target string. */
const hostOf = (target: string): string => {
  let t = target.trim().toLowerCase();
  t = t.replace(/^[a-z]+:\/\//, ""); // strip scheme
  t = t.split("/")[0]; // strip path
  t = t.split("?")[0];
  t = t.split("@").pop() ?? t; // strip creds
  t = t.replace(/:\d+$/, ""); // strip port
  return t;
};

const isIpv4 = (value: string): boolean => /^(\d{1,3})(\.\d{1,3}){3}$/.test(value);

/** Does an IPv4 fall inside a simple a.b.c.0/24-style block? (demo-grade). */
const inCidr24 = (ip: string, cidr: string): boolean => {
  const [net, bitsRaw] = cidr.split("/");
  const bits = Number(bitsRaw);
  if (!isIpv4(ip) || !isIpv4(net)) return false;
  const toNum = (v: string) => v.split(".").reduce((acc, oct) => (acc << 8) + (Number(oct) & 255), 0) >>> 0;
  const mask = bits <= 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (toNum(ip) & mask) === (toNum(net) & mask);
};

/** Match a host/ip token against one asset. */
const matchesAsset = (host: string, asset: OpsScopeAsset): boolean => {
  const value = asset.value.trim().toLowerCase();
  if (asset.kind === "domain") {
    if (host === value) return true;
    return asset.includeSubdomains === true && host.endsWith(`.${value}`);
  }
  if (asset.kind === "ip") return host === value;
  if (asset.kind === "cidr") return inCidr24(host, value);
  if (asset.kind === "url") return host === hostOf(value);
  return false;
};

/**
 * Build a scope gate over a list of assets. Default-deny: an empty scope or an
 * unmatched target is refused. `engagementId` is carried through for the audit.
 */
export const createScopeGate = (
  assets: readonly OpsScopeAsset[],
  { engagementId = null }: { engagementId?: string | null } = {},
): OpsScopeGate => ({
  check(request: OpsScopeRequest): OpsScopeDecision {
    if (engagementId && request.engagementId && request.engagementId !== engagementId) {
      return { allowed: false, decision: "deny_engagement_mismatch", reason: "Цель относится к другому engagement.", assetId: null };
    }
    if (request.target == null) {
      // No concrete target → nothing to gate (a pure coordination step).
      return { allowed: true, decision: "allow_no_target", reason: "Шаг без конкретной цели.", assetId: null };
    }
    if (!assets.length) {
      return { allowed: false, decision: "deny_no_scope", reason: "Нет активного scope — действие запрещено (fail-closed).", assetId: null };
    }
    const raw = typeof request.target === "string" ? request.target : JSON.stringify(request.target);
    const host = hostOf(raw);
    const hit = assets.find((asset) => matchesAsset(host, asset));
    if (hit) {
      return { allowed: true, decision: "allow", reason: `Цель в scope (${hit.value}).`, assetId: hit.id };
    }
    return { allowed: false, decision: "deny_out_of_scope", reason: `Цель вне scope: ${host}. Отказано (default-deny).`, assetId: null };
  },
});

/** The demo scope gate over the fictional reserved lab. */
export const createDemoScopeGate = (engagementId: string | null = "ENG-OSINT-DEMO"): OpsScopeGate =>
  createScopeGate(DEMO_SCOPE_ASSETS, { engagementId });
