import crypto from "node:crypto";

import { TelephonyError, assertE164, type CallStatus } from "@/lib/telephony/types";

/**
 * Twilio REST client, written against the API directly rather than the SDK to
 * match how the rest of this app talks to third parties.
 *
 * Nothing here is reachable from a test environment, so every request shape is
 * asserted in tests against a mocked fetch: the URL, the auth header and the
 * form fields Twilio requires.
 */

const TWILIO_API_BASE = "https://api.twilio.com/2010-04-01";

export type TwilioConfig = {
  accountSid: string;
  authToken: string;
  /** The Twilio number calls are placed from. */
  fromNumber: string;
  /**
   * Public base URL Twilio calls back on. Twilio dials out from its own
   * infrastructure, so this must be reachable from the internet — localhost
   * will never work without a tunnel.
   */
  publicBaseUrl: string;
};

export const resolveTwilioConfig = (
  env: NodeJS.ProcessEnv = process.env,
): TwilioConfig => {
  const accountSid = env.TWILIO_ACCOUNT_SID?.trim() ?? "";
  const authToken = env.TWILIO_AUTH_TOKEN?.trim() ?? "";
  const fromNumber = env.TWILIO_PHONE_NUMBER?.trim() ?? "";
  const publicBaseUrl = env.OFFICE3D_PUBLIC_URL?.trim() ?? "";

  const missing = [
    !accountSid && "TWILIO_ACCOUNT_SID",
    !authToken && "TWILIO_AUTH_TOKEN",
    !fromNumber && "TWILIO_PHONE_NUMBER",
    !publicBaseUrl && "OFFICE3D_PUBLIC_URL",
  ].filter(Boolean);

  if (missing.length > 0) {
    throw new TelephonyError(
      `Telephony is not configured. Missing: ${missing.join(", ")}.`,
      503,
    );
  }

  return {
    accountSid,
    authToken,
    fromNumber: assertE164(fromNumber, "TWILIO_PHONE_NUMBER"),
    publicBaseUrl: publicBaseUrl.replace(/\/+$/, ""),
  };
};

export const isTelephonyConfigured = (
  env: NodeJS.ProcessEnv = process.env,
): boolean => {
  try {
    resolveTwilioConfig(env);
    return true;
  } catch {
    return false;
  }
};

const authHeader = (config: TwilioConfig): string =>
  `Basic ${Buffer.from(`${config.accountSid}:${config.authToken}`).toString("base64")}`;

const callsUrl = (config: TwilioConfig, sid?: string): string =>
  `${TWILIO_API_BASE}/Accounts/${encodeURIComponent(config.accountSid)}/Calls${
    sid ? `/${encodeURIComponent(sid)}` : ""
  }.json`;

const request = async (
  config: TwilioConfig,
  url: string,
  init: { method: string; body?: URLSearchParams },
): Promise<Record<string, unknown>> => {
  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method,
      headers: {
        Authorization: authHeader(config),
        ...(init.body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      },
      body: init.body,
    });
  } catch (error) {
    throw new TelephonyError(
      `Could not reach Twilio: ${error instanceof Error ? error.message : String(error)}`,
      502,
      error,
    );
  }

  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }

  if (!response.ok) {
    const record = (parsed ?? {}) as Record<string, unknown>;
    const message =
      typeof record.message === "string"
        ? record.message
        : `Twilio returned ${response.status}.`;
    // Twilio's own status is preserved: a 401 is a credentials problem and a
    // 400 is a bad number, and telling those apart matters to the caller.
    throw new TelephonyError(`Twilio: ${message}`, response.status, parsed);
  }

  return (parsed ?? {}) as Record<string, unknown>;
};

export type PlaceCallParams = {
  to: string;
  /** Correlates the call with the agent that placed it. */
  agentId: string;
};

export type PlacedCall = {
  sid: string;
  status: CallStatus;
  to: string;
  from: string;
};

const readStatus = (value: unknown): CallStatus => {
  const known: CallStatus[] = [
    "queued",
    "ringing",
    "in-progress",
    "completed",
    "busy",
    "no-answer",
    "canceled",
    "failed",
  ];
  const found = known.find((status) => status === value);
  // An unrecognised status is reported as queued rather than crashing a live
  // call; the status webhook corrects it moments later.
  return found ?? "queued";
};

export const placeCall = async (
  params: PlaceCallParams,
  config: TwilioConfig = resolveTwilioConfig(),
): Promise<PlacedCall> => {
  const to = assertE164(params.to, "to");
  const agentId = params.agentId.trim();
  if (!agentId) {
    throw new TelephonyError("agentId is required.");
  }

  // Twilio fetches TwiML from this URL when the call connects, and reports
  // progress to the status callback. The agent id travels in the query so the
  // webhooks know which agent is on the line without a lookup.
  const twimlUrl = new URL("/api/telephony/twiml", config.publicBaseUrl);
  twimlUrl.searchParams.set("agentId", agentId);
  const statusUrl = new URL("/api/telephony/status", config.publicBaseUrl);

  const body = new URLSearchParams({
    To: to,
    From: config.fromNumber,
    Url: twimlUrl.toString(),
    Method: "POST",
    StatusCallback: statusUrl.toString(),
    StatusCallbackMethod: "POST",
  });
  for (const event of ["initiated", "ringing", "answered", "completed"]) {
    body.append("StatusCallbackEvent", event);
  }

  const payload = await request(config, callsUrl(config), { method: "POST", body });
  const sid = typeof payload.sid === "string" ? payload.sid : "";
  if (!sid) {
    throw new TelephonyError("Twilio accepted the call but returned no SID.", 502);
  }

  return {
    sid,
    status: readStatus(payload.status),
    to,
    from: config.fromNumber,
  };
};

/** Ends a call in progress. */
export const hangUpCall = async (
  sid: string,
  config: TwilioConfig = resolveTwilioConfig(),
): Promise<void> => {
  if (!sid.trim()) {
    throw new TelephonyError("A call SID is required.");
  }
  await request(config, callsUrl(config, sid.trim()), {
    method: "POST",
    body: new URLSearchParams({ Status: "completed" }),
  });
};

/**
 * Verifies Twilio's request signature.
 *
 * The webhooks are public URLs that feed the operator's transcript and decide
 * what an agent says next. Without this check anyone who found the URL could
 * inject speech into a live call or fake what the other party said, so an
 * unverified request is refused rather than merely logged.
 *
 * The algorithm is Twilio's: the full request URL, then every POST parameter
 * appended as key followed by value in sorted key order, HMAC-SHA1 with the
 * auth token, base64.
 */
export const isValidTwilioSignature = (params: {
  signature: string;
  url: string;
  form: Record<string, string>;
  authToken: string;
}): boolean => {
  if (!params.signature || !params.authToken) return false;

  const data = Object.keys(params.form)
    .sort()
    .reduce((acc, key) => acc + key + params.form[key], params.url);

  const expected = crypto
    .createHmac("sha1", params.authToken)
    .update(Buffer.from(data, "utf8"))
    .digest("base64");

  const provided = Buffer.from(params.signature);
  const computed = Buffer.from(expected);
  if (provided.length !== computed.length) return false;
  // Constant-time: a length-independent comparison would leak the expected
  // signature one byte at a time to anyone able to time the endpoint.
  return crypto.timingSafeEqual(provided, computed);
};
