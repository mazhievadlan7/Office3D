import { runVerification, verifyInstructions } from "@/lib/aegis/core";
import type { AegisVerifyMethod } from "@/lib/aegis/types";
import { aegisError, aegisJson, readJson } from "@/lib/aegis/respond";

export const runtime = "nodejs";

const METHODS: AegisVerifyMethod[] = ["dns", "file", "whois"];

/** What to place to prove control of this engagement's assets. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    return aegisJson(verifyInstructions(id));
  } catch (error) {
    return aegisError(error);
  }
}

/** Run one ownership check ({ assetId, method }) against a declared asset. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await readJson(request);
    const method = String(body.method) as AegisVerifyMethod;
    if (!METHODS.includes(method)) {
      return aegisJson({ error: `Неизвестный метод проверки: ${String(body.method)}.`, code: "INVALID_INPUT" }, 400);
    }
    const result = await runVerification(id, typeof body.assetId === "string" ? body.assetId : "", method);
    return aegisJson({ result });
  } catch (error) {
    return aegisError(error);
  }
}
