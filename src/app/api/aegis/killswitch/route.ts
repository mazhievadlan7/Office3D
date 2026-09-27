import { getKillSwitch, setGlobalKill } from "@/lib/aegis/core";
import { aegisError, aegisJson, readJson } from "@/lib/aegis/respond";

export const runtime = "nodejs";

export async function GET() {
  try {
    return aegisJson({ killSwitch: getKillSwitch() });
  } catch (error) {
    return aegisError(error);
  }
}

/** Engage or release the global kill-switch — every action is barred while on. */
export async function POST(request: Request) {
  try {
    const body = await readJson(request);
    const killSwitch = await setGlobalKill({
      on: body.on === true,
      by: typeof body.by === "string" ? body.by : "",
      reason: typeof body.reason === "string" ? body.reason : "",
    });
    return aegisJson({ killSwitch });
  } catch (error) {
    return aegisError(error);
  }
}
