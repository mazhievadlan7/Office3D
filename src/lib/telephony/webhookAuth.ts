import crypto from "node:crypto";

import { TelephonyError } from "@/lib/telephony/types";
import { t } from "@/lib/i18n";

/**
 * Authenticates the voice agent calling back into Office3D.
 *
 * The operator-instruction endpoint is a webhook: ElevenLabs reaches it from
 * their infrastructure, so it is on the open internet and behind no session.
 * The server's access gate does not cover it, which is precisely why it needs
 * a secret of its own.
 *
 * A shared secret rather than a signature, because ElevenLabs sends webhook
 * tool requests with headers this deployment configures on the tool, and does
 * not sign them. It is compared in constant time so the endpoint does not leak
 * the secret one character at a time to anyone who can measure it.
 */

export const TELEPHONY_WEBHOOK_HEADER = "x-office3d-telephony-secret";

/** Long enough that guessing is hopeless; refuses a token that is not. */
const MIN_SECRET_CHARS = 24;

export const resolveWebhookSecret = (
  env: NodeJS.ProcessEnv = process.env,
): string | null => {
  const secret = env.OFFICE3D_TELEPHONY_WEBHOOK_SECRET?.trim();
  if (!secret) return null;
  if (secret.length < MIN_SECRET_CHARS) {
    // Refused rather than accepted quietly: a short secret on a public
    // endpoint is worse than none, because it looks protected.
    throw new TelephonyError(
      t("libTelephony.webhookSecretTooShort", { length: secret.length, min: MIN_SECRET_CHARS }),
      503,
    );
  }
  return secret;
};

const matches = (a: string, b: string): boolean => {
  // Hashed first so the comparison is over equal-length buffers: length alone
  // would otherwise be readable from the timing.
  const left = crypto.createHash("sha256").update(a).digest();
  const right = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(left, right);
};

/**
 * Throws unless the request carries the configured secret.
 *
 * With no secret configured the endpoint is closed, not open: a deployment
 * that has not set one has not opted into a public callback.
 */
export const assertWebhookAuthorized = (
  request: Request,
  env: NodeJS.ProcessEnv = process.env,
): void => {
  const secret = resolveWebhookSecret(env);
  if (!secret) {
    throw new TelephonyError(
      t("libTelephony.operatorChannelOff"),
      503,
    );
  }

  const presented = request.headers.get(TELEPHONY_WEBHOOK_HEADER)?.trim() ?? "";
  if (!presented || !matches(presented, secret)) {
    // Deliberately says nothing about which part was wrong.
    throw new TelephonyError(t("libTelephony.unauthorized"), 401);
  }
};

/**
 * Whether this deployment can carry operator instructions into a live call.
 *
 * Both halves are needed: the secret, and a URL ElevenLabs can actually reach.
 * Unlike the rest of telephony, this one feature does need a public URL,
 * because it is the provider calling us rather than the other way round.
 */
export const describeOperatorChannelReadiness = (
  env: NodeJS.ProcessEnv = process.env,
): { configured: boolean; missing: string[] } => {
  const missing: string[] = [];
  let secretOk = false;
  try {
    secretOk = Boolean(resolveWebhookSecret(env));
  } catch {
    // A secret that is set but too short counts as missing here; the route
    // itself reports the real reason with its 503.
    secretOk = false;
  }
  if (!secretOk) missing.push("OFFICE3D_TELEPHONY_WEBHOOK_SECRET");
  if (!env.OFFICE3D_PUBLIC_URL?.trim()) missing.push("OFFICE3D_PUBLIC_URL");
  return { configured: missing.length === 0, missing };
};
