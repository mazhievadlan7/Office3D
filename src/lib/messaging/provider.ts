import { MessagingError } from "@/lib/messaging/types";

/**
 * Where office messages go.
 *
 * One provider today, behind an interface, because the choice is not settled:
 * WhatsApp through ElevenLabs works with the account this deployment already
 * has, while plain SMS needs credentials from a carrier. The seam is here so
 * adding the second does not disturb the first.
 */

export type MessagingConfig = {
  provider: "elevenlabs-whatsapp";
  apiKey: string;
  agentId: string;
  whatsappPhoneNumberId: string;
  /**
   * WhatsApp only carries pre-approved templates to a user outside an open
   * conversation window, so the office sends one named template and fills its
   * body parameter. Free-form text is not an option the API offers.
   */
  templateName: string;
  templateLanguageCode: string;
};

const REQUIRED: Array<[keyof MessagingConfig, string]> = [
  ["apiKey", "ELEVENLABS_API_KEY"],
  ["agentId", "ELEVENLABS_AGENT_ID"],
  ["whatsappPhoneNumberId", "ELEVENLABS_WHATSAPP_PHONE_NUMBER_ID"],
  ["templateName", "ELEVENLABS_WHATSAPP_TEMPLATE"],
  ["templateLanguageCode", "ELEVENLABS_WHATSAPP_TEMPLATE_LANGUAGE"],
];

const read = (env: NodeJS.ProcessEnv, name: string): string =>
  env[name]?.trim() ?? "";

export const describeMessagingReadiness = (
  env: NodeJS.ProcessEnv = process.env,
): { provider: MessagingConfig["provider"]; configured: boolean; missing: string[] } => {
  // Names only, never values.
  const missing = REQUIRED.filter(([, envVar]) => !read(env, envVar)).map(
    ([, envVar]) => envVar,
  );
  return { provider: "elevenlabs-whatsapp", configured: missing.length === 0, missing };
};

export const isMessagingConfigured = (
  env: NodeJS.ProcessEnv = process.env,
): boolean => describeMessagingReadiness(env).configured;

/** Throws a 503 naming every missing variable at once, not the first one. */
export const resolveMessagingConfig = (
  env: NodeJS.ProcessEnv = process.env,
): MessagingConfig => {
  const { missing } = describeMessagingReadiness(env);
  if (missing.length > 0) {
    throw new MessagingError(
      `Messaging is not configured. Missing: ${missing.join(", ")}.`,
      503,
    );
  }
  return {
    provider: "elevenlabs-whatsapp",
    apiKey: read(env, "ELEVENLABS_API_KEY"),
    agentId: read(env, "ELEVENLABS_AGENT_ID"),
    whatsappPhoneNumberId: read(env, "ELEVENLABS_WHATSAPP_PHONE_NUMBER_ID"),
    templateName: read(env, "ELEVENLABS_WHATSAPP_TEMPLATE"),
    templateLanguageCode: read(env, "ELEVENLABS_WHATSAPP_TEMPLATE_LANGUAGE"),
  };
};
