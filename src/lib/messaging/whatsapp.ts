import type { MessagingConfig } from "@/lib/messaging/provider";
import { MessagingError } from "@/lib/messaging/types";

/**
 * WhatsApp messages through ElevenLabs.
 *
 * Template-only, and that is the API's constraint rather than a simplification
 * here: WhatsApp will not carry free-form text to someone who has not messaged
 * you recently, so the endpoint takes a template name and its parameters. The
 * office fills one body parameter with what the agent wanted to say.
 *
 * Request and response shapes were taken from the official SDK's generated
 * types and serializers (@elevenlabs/elevenlabs-js), not guessed:
 * elevenlabs.io is unreachable from the build environment, so the package on
 * npm was the authoritative source available.
 */

const ELEVENLABS_API_BASE = "https://api.elevenlabs.io";

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

export type SentWhatsAppMessage = {
  /** ElevenLabs returns a conversation id; it is the handle for the message. */
  conversationId: string;
};

export const sendWhatsAppTemplateMessage = async (
  params: { toUserId: string; text: string },
  config: MessagingConfig,
): Promise<SentWhatsAppMessage> => {
  const url = new URL("v1/convai/whatsapp/outbound-message", `${ELEVENLABS_API_BASE}/`);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": config.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        whatsapp_phone_number_id: config.whatsappPhoneNumberId,
        whatsapp_user_id: params.toUserId,
        template_name: config.templateName,
        template_language_code: config.templateLanguageCode,
        template_params: [
          { type: "body", parameters: [{ type: "text", text: params.text }] },
        ],
        agent_id: config.agentId,
      }),
    });
  } catch (error) {
    throw new MessagingError(
      `Could not reach ElevenLabs: ${
        error instanceof Error ? error.message : String(error)
      }`,
      502,
      error,
    );
  }

  const body = await response.text();
  let parsed: unknown = null;
  try {
    parsed = body ? JSON.parse(body) : null;
  } catch {
    parsed = null;
  }

  if (!response.ok) {
    const record = (parsed ?? {}) as Record<string, unknown>;
    const detail =
      asString(record.detail) ??
      asString(record.message) ??
      `ElevenLabs returned ${response.status}.`;
    // The status is preserved: 401 is a bad key and 422 usually a template
    // name or language that does not match an approved one, and telling those
    // apart saves a deployment looking in the wrong place.
    throw new MessagingError(`ElevenLabs: ${detail}`, response.status, parsed);
  }

  const conversationId = asString(
    (parsed as Record<string, unknown> | null)?.conversation_id,
  );
  if (!conversationId) {
    // Without an id there is nothing to record the message against, and
    // reporting it as sent would put a delivery in the log that cannot be
    // traced.
    throw new MessagingError(
      "ElevenLabs accepted the request but returned no conversation id.",
      502,
      parsed,
    );
  }

  return { conversationId };
};
