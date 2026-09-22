
import { t } from "@/lib/i18n";
/**
 * Messages an office agent sends.
 *
 * Kept apart from telephony because the constraints are different: a call is a
 * live conversation, a message is one delivery with a receipt. What they share
 * is the rule that nothing here is invented — a message is recorded as sent
 * only when a provider accepted it, and a reply appears only if one arrives.
 *
 * This module holds the shapes only. Nothing here talks to a provider.
 */

export type MessageChannel = "whatsapp";

export type MessageStatus =
  /** Handed to the provider, which has not yet confirmed delivery. */
  | "sent"
  /** The provider refused it, or could not deliver it. */
  | "failed";

export type MessageRecord = {
  /** The provider's id for the message, and ours. */
  id: string;
  channel: MessageChannel;
  /** The agent the office sent it as. */
  agentId: string;
  agentName: string;
  /** Who it went to, as the provider identifies them. */
  to: string;
  /**
   * What the office put into the message. With a template channel this is the
   * text substituted into the template, not the whole message body — the
   * provider assembles the rest, and claiming otherwise would show the
   * operator words the recipient never saw in that form.
   */
  text: string;
  /** The template used, when the channel requires one. */
  template: string | null;
  sentAt: string;
  status: MessageStatus;
  errorMessage: string | null;
};

export class MessagingError extends Error {
  constructor(
    message: string,
    readonly status: number = 400,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "MessagingError";
  }
}

/** A runaway message costs money and reads badly; templates have limits too. */
export const MAX_MESSAGE_CHARS = 900;

export const assertMessageText = (value: string, field: string): string => {
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (!trimmed) {
    throw new MessagingError(t("libMessaging.fieldRequired", { field }));
  }
  if (trimmed.length > MAX_MESSAGE_CHARS) {
    throw new MessagingError(
      t("libMessaging.fieldTooLong", { field, length: trimmed.length, limit: MAX_MESSAGE_CHARS }),
    );
  }
  return trimmed;
};

/**
 * WhatsApp identifies a user by phone number in E.164 without the plus.
 * Accepted either way and normalised, because an operator will type the plus.
 */
export const normalizeWhatsAppUserId = (value: string, field: string): string => {
  const trimmed = value.trim().replace(/^\+/, "").replace(/[\s()-]/g, "");
  if (!/^[1-9]\d{7,14}$/.test(trimmed)) {
    throw new MessagingError(
      t("libMessaging.invalidPhone", { field, value }),
    );
  }
  return trimmed;
};
