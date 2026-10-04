import { NextResponse } from "next/server";

import { appendCouncilSession, listCouncilSessions, verifyCouncilArchive, type CouncilArchiveAppend } from "@/lib/council/archive";

export const runtime = "nodejs";

const MAX_ENTRIES = 200;

/** GET: the recent council sessions and the chain's integrity. */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const limit = Math.min(MAX_ENTRIES, Math.max(1, Number(url.searchParams.get("limit")) || 50));
    const sessions = listCouncilSessions(limit).map((entry) => ({ seq: entry.seq, at: entry.at, hash: entry.hash, ...entry.detail }));
    return NextResponse.json({ sessions, integrity: verifyCouncilArchive() });
  } catch (error) {
    console.error("[council] Failed to read the archive:", error);
    return NextResponse.json({ error: "Не удалось прочитать архив совета." }, { status: 500 });
  }
}

/** POST: append one finished council session to the append-only archive. */
export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as Partial<CouncilArchiveAppend>;
    if (!body || typeof body.kind !== "string" || !Array.isArray(body.entries)) {
      return NextResponse.json({ error: "Нужны поля kind и entries." }, { status: 400 });
    }
    const record: CouncilArchiveAppend = {
      kind: body.kind,
      startedAt: Number(body.startedAt) || Date.now(),
      endedAt: Number(body.endedAt) || Date.now(),
      chiefCount: Number(body.chiefCount) || (Array.isArray(body.entries) ? body.entries.length : 0),
      decisions: Array.isArray(body.decisions) ? body.decisions : [],
      entries: body.entries,
      closing: typeof body.closing === "string" ? body.closing : "",
    };
    const result = await appendCouncilSession(record);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    console.error("[council] Failed to append the session:", error);
    return NextResponse.json({ error: "Не удалось записать совет в архив." }, { status: 500 });
  }
}
