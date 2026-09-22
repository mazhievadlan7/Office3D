import { NextResponse } from "next/server";
import { t } from "@/lib/i18n";

export const runtime = "nodejs";

type CustomRuntimeRequestBody = {
  runtimeUrl?: string;
  pathname?: string;
  method?: string;
  body?: unknown;
};

const isRuntimeUrlAllowed = (runtimeUrl: string): boolean => {
  const rawAllowlist = (
    process.env.CUSTOM_RUNTIME_ALLOWLIST ||
    process.env.UPSTREAM_ALLOWLIST ||
    ""
  ).trim();
  if (!rawAllowlist) {
    return process.env.NODE_ENV !== "production";
  }
  try {
    const parsed = new URL(runtimeUrl);
    const allowed = rawAllowlist
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean);
    return allowed.includes(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
};

const normalizeRuntimeUrl = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(t("apiRuntime.runtimeUrlRequired"));
  }
  const parsed = new URL(trimmed);
  if (parsed.protocol === "ws:") {
    parsed.protocol = "http:";
  } else if (parsed.protocol === "wss:") {
    parsed.protocol = "https:";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(t("apiRuntime.runtimeUrlProtocol"));
  }
  parsed.username = "";
  parsed.password = "";
  const normalized = parsed.toString().replace(/\/$/, "");
  if (!isRuntimeUrlAllowed(normalized)) {
    throw new Error(t("apiRuntime.runtimeUrlNotAllowed"));
  }
  return normalized;
};

const normalizePathname = (value: unknown): string => {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(t("apiRuntime.pathnameRequired"));
  }
  const trimmed = value.trim();
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
};

const normalizeMethod = (value: unknown): "GET" | "POST" => {
  if (typeof value !== "string") return "GET";
  const upper = value.trim().toUpperCase();
  if (upper === "POST") return "POST";
  return "GET";
};

export async function POST(request: Request) {
  let payload;
  try {
    payload = (await request.json()) as CustomRuntimeRequestBody;
  } catch (error) {
    console.error("[runtime/custom] Invalid JSON request body.", error);
    return NextResponse.json(
      { error: t("apiCommon.invalidJsonBody") },
      { status: 400 }
    );
  }

  try {
    const runtimeUrl = normalizeRuntimeUrl(payload.runtimeUrl ?? "");
    const pathname = normalizePathname(payload.pathname);
    const method = normalizeMethod(payload.method);
    // Propagate the browser abort signal so that cancelling the client-side fetch
    // (e.g. hitting Stop) also cancels the upstream runtime request.
    const response = await fetch(`${runtimeUrl}${pathname}`, {
      method,
      headers: {
        Accept: "application/json",
        ...(method === "POST" ? { "Content-Type": "application/json" } : null),
      },
      body: method === "POST" ? JSON.stringify(payload.body ?? {}) : undefined,
      cache: "no-store",
      signal: request.signal,
    });
    const text = await response.text();
    return new NextResponse(text, {
      status: response.status,
      headers: {
        "Content-Type": response.headers.get("content-type") ?? "application/json",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : t("apiRuntime.proxyFailed");
    const status =
      message === t("apiRuntime.runtimeUrlRequired") ||
      message === t("apiRuntime.pathnameRequired") ||
      message === t("apiRuntime.runtimeUrlProtocol") ||
      message === t("apiRuntime.runtimeUrlNotAllowed")
        ? 400
        : 502;
    console.error("[runtime/custom] Proxy request failed.", error);
    return NextResponse.json(
      {
        error:
          status === 400
            ? message
            : t("apiRuntime.proxyFailed"),
      },
      { status }
    );
  }
}
