import fs from "node:fs/promises";
import path from "node:path";

import { isVoiceBankFile } from "@/lib/voice/voiceBank";
import { voiceBankDir } from "@/lib/voice/voiceBankServer";

export const runtime = "nodejs";

const MAX_BYTES = 2 * 1024 * 1024;

/**
 * One pre-rendered crew line. Only names of the bank's own form are served
 * (`<voice>.<line>.<hash12>.mp3`, nothing path-like); the name holds the
 * content's hash, so the file never changes and is cached for good.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  if (!isVoiceBankFile(file)) return new Response(null, { status: 400 });
  const dir = voiceBankDir();
  const target = path.resolve(dir, file);
  if (path.dirname(target) !== dir) return new Response(null, { status: 400 });
  try {
    const stat = await fs.stat(target);
    if (!stat.isFile() || stat.size > MAX_BYTES) return new Response(null, { status: 404 });
    const bytes = await fs.readFile(target);
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": "audio/mpeg",
        "Content-Length": String(bytes.length),
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch {
    return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
  }
}
