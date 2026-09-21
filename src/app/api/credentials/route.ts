import { NextResponse } from "next/server";

import { describeCredentials } from "@/lib/credentials/catalog";

export const runtime = "nodejs";

/**
 * Reports which credentials this deployment has configured.
 *
 * Returns whether each variable is set and never its value — the point is to
 * answer "is the host configured?" without handing secrets to a browser that
 * has no use for them. There is no POST: secrets are set in the environment,
 * not written through the app, so a compromised session cannot plant one.
 */
export async function GET() {
  const credentials = describeCredentials();
  return NextResponse.json(
    {
      credentials,
      missingRequired: credentials
        .filter((entry) => entry.requiredFor && !entry.configured)
        .map((entry) => entry.envVar),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
