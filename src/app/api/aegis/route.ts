import { overview } from "@/lib/aegis/core";
import { aegisError, aegisJson } from "@/lib/aegis/respond";

export const runtime = "nodejs";

/** The legal contour at a glance: kill-switch, engagements, audit integrity. */
export async function GET() {
  try {
    return aegisJson(overview());
  } catch (error) {
    return aegisError(error);
  }
}
