import fs from "node:fs/promises";
import path from "node:path";

import { parseVoiceBankManifest } from "@/lib/voice/voiceBank";
import { voiceBankDir } from "@/lib/voice/voiceBankServer";

export const runtime = "nodejs";

/**
 * The crew voice bank's manifest (scripts/voice-bank.mjs), sanitised. 404
 * while no bank has been rendered: the HQ then keeps its synthesised murmur.
 */
export async function GET() {
  try {
    const raw = await fs.readFile(path.join(voiceBankDir(), "manifest.json"), "utf8");
    const manifest = parseVoiceBankManifest(JSON.parse(raw));
    if (!manifest) return Response.json({ error: "empty" }, { status: 404, headers: { "Cache-Control": "no-store" } });
    // Short: a bank still rendering grows every few seconds.
    return Response.json(manifest, { headers: { "Cache-Control": "private, max-age=30" } });
  } catch {
    return Response.json({ error: "not found" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  }
}
