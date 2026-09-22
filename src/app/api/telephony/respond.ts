import { NextResponse } from "next/server";

import { TelephonyError } from "@/lib/telephony/types";

/** Every telephony response is live state; none of it may be cached. */
export const NO_STORE = { "Cache-Control": "no-store" } as const;

export const telephonyJson = (body: unknown, status = 200): NextResponse =>
  NextResponse.json(body, { status, headers: NO_STORE });

/**
 * Turns a thrown error into a response.
 *
 * A TelephonyError already carries the status it earned — 400 for a bad
 * number, 404 for an unknown call, 503 for a deployment that is not
 * configured, and the provider's own status for anything it refused — so that
 * distinction is preserved rather than flattened to 500. Anything else is a
 * bug here, and reports as one without leaking its message.
 */
export const telephonyError = (error: unknown): NextResponse => {
  if (error instanceof TelephonyError) {
    return telephonyJson({ error: error.message }, error.status);
  }
  console.error("[telephony] unhandled error", error);
  return telephonyJson({ error: "Telephony failed unexpectedly." }, 500);
};
