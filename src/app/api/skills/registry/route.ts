import { NextResponse } from "next/server";

import {
  createSkillRegistries,
  searchSkillRegistries,
} from "@/lib/skills/registry";

export const runtime = "nodejs";

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;

const parseLimit = (raw: string | null): number => {
  if (!raw) return DEFAULT_LIMIT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
};

/**
 * Searches every configured skill source.
 *
 * Always 200: a source that is down, rate limited or unreachable reports its
 * own error alongside the sources that answered, so one bad registry cannot
 * blank the marketplace. The caller decides how to show a partial result.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const query = url.searchParams.get("q") ?? "";
  const limit = parseLimit(url.searchParams.get("limit"));

  const results = await searchSkillRegistries(createSkillRegistries(), query, {
    limit,
  });

  return NextResponse.json(
    { query, results },
    { headers: { "Cache-Control": "no-store" } },
  );
}
