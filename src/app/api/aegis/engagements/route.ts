import { createEngagement, listEngagements } from "@/lib/aegis/core";
import { aegisError, aegisJson, readJson } from "@/lib/aegis/respond";

export const runtime = "nodejs";

export async function GET() {
  try {
    return aegisJson({ engagements: listEngagements() });
  } catch (error) {
    return aegisError(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = await readJson(request);
    const engagement = await createEngagement({
      name: typeof body.name === "string" ? body.name : "",
      note: typeof body.note === "string" ? body.note : "",
    });
    return aegisJson({ engagement }, 201);
  } catch (error) {
    return aegisError(error);
  }
}
