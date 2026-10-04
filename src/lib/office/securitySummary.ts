/**
 * The server's security summary (GET /api/security/summary, server/security-log.js):
 * how the person got in, the owner's previous sign-in and the unauthorized
 * attempts and blocks since then, and the name the greeting uses. A 200 answer also means the owner is signed
 * in (the endpoint sits behind the access gate) — the HQ's «СОЗДАТЕЛЬ В СЕТИ».
 */

export const SECURITY_SUMMARY_PATH = "/api/security/summary";

export type SecuritySummary = {
  /** "session": signed in through the access gate; "local": no gate, the owner's own machine. */
  access: "session" | "local";
  /** The name the HQ greets the owner by (STUDIO_OWNER_NAME, else STUDIO_LOGIN); "" for none. */
  ownerName: string;
  /** ISO time of the owner's previous sign-in, or null before the second one. */
  previousLoginAt: string | null;
  failedAttempts: number;
  blocked: number;
};

const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;

/** The answer's body, checked; null when it is not a summary. */
export function parseSecuritySummary(data: unknown): SecuritySummary | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  const access = record.access;
  if (access !== "session" && access !== "local") return null;
  const failedAttempts = count(record.failedAttempts);
  const blocked = count(record.blocked);
  if (failedAttempts === null || blocked === null) return null;
  const previousLoginAt = typeof record.previousLoginAt === "string" ? record.previousLoginAt : null;
  const ownerName = typeof record.ownerName === "string" ? record.ownerName.trim().slice(0, 80) : "";
  return { access, ownerName, previousLoginAt, failedAttempts, blocked };
}

/** Reads the summary; null when signed out, refused, or the server does not have it. */
export async function fetchSecuritySummary(signal?: AbortSignal): Promise<SecuritySummary | null> {
  try {
    const response = await fetch(SECURITY_SUMMARY_PATH, { cache: "no-store", credentials: "same-origin", signal });
    if (!response.ok) return null;
    return parseSecuritySummary(await response.json());
  } catch {
    return null;
  }
}
