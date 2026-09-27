import { aegisErrorStatus } from "@/lib/aegis/core";

/** JSON, never cached — control-plane state must always be read fresh. */
export const aegisJson = (body: unknown, status = 200): Response =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

/** Maps an AegisError to its HTTP status; everything else is a logged 500. */
export const aegisError = (error: unknown): Response => {
  const mapped = aegisErrorStatus(error);
  const status = mapped ?? 500;
  const message = error instanceof Error ? error.message : "AEGIS: внутренняя ошибка.";
  if (mapped === null) console.error("[aegis] route error:", error);
  return aegisJson({ error: message, code: (error as { code?: string })?.code ?? null }, status);
};

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const readJson = async (request: Request): Promise<Record<string, unknown>> => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  return isRecord(body) ? body : {};
};
