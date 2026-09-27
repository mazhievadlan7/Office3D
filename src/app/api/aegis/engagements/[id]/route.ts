import {
  activate,
  addAsset,
  complete,
  egressFor,
  getEngagement,
  reactivate,
  recordAuthorization,
  removeAsset,
  stop,
} from "@/lib/aegis/core";
import { aegisError, aegisJson, readJson } from "@/lib/aegis/respond";

export const runtime = "nodejs";

const str = (value: unknown): string => (typeof value === "string" ? value : "");

/** One engagement, plus its egress allowlist once it is active. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const engagement = getEngagement(id);
    if (!engagement) return aegisJson({ error: `Engagement не найден: ${id}.`, code: "NOT_FOUND" }, 404);
    return aegisJson({ engagement, egress: engagement.status === "active" ? egressFor(id) : null });
  } catch (error) {
    return aegisError(error);
  }
}

/**
 * Command dispatch for one engagement. `op` picks the lifecycle transition; the
 * kernel validates every one and throws an AegisError that maps to a status.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await readJson(request);
    const op = str(body.op);
    switch (op) {
      case "addAsset":
        return aegisJson({ engagement: await addAsset(id, body.asset) });
      case "removeAsset":
        return aegisJson({ engagement: await removeAsset(id, str(body.assetId)) });
      case "authorize":
        return aegisJson({
          engagement: await recordAuthorization(id, {
            letterRef: str(body.letterRef),
            signer: str(body.signer),
            verification: body.verification,
          }),
        });
      case "activate":
        return aegisJson({ engagement: await activate(id, { by: str(body.by), confirm: body.confirm === true }) });
      case "stop":
        return aegisJson({ engagement: await stop(id, { by: str(body.by), reason: str(body.reason) }) });
      case "reactivate":
        return aegisJson({ engagement: await reactivate(id, { by: str(body.by) }) });
      case "complete":
        return aegisJson({ engagement: await complete(id, { by: str(body.by) }) });
      default:
        return aegisJson({ error: `Неизвестная операция: ${op || "(пусто)"}.`, code: "INVALID_INPUT" }, 400);
    }
  } catch (error) {
    return aegisError(error);
  }
}
