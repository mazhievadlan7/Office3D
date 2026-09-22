import { MessagingError, type MessageRecord } from "@/lib/messaging/types";
import { t } from "@/lib/i18n";

/**
 * Messages this process has sent.
 *
 * In memory, like the call store, and with the same consequence: a restart
 * loses the log and a second instance has its own. Unlike a live call, a sent
 * message is a durable fact, so this is a convenience for the office's own
 * view rather than the record of record — the provider holds that. Worth
 * saying plainly rather than implying the office keeps history it does not.
 */

const MAX_RETAINED = 100;

const messages = new Map<string, MessageRecord>();

/** Newest first, so the office shows what just went out at the top. */
export const listMessages = (): MessageRecord[] =>
  [...messages.values()].sort((a, b) => b.sentAt.localeCompare(a.sentAt));

export const getMessage = (id: string): MessageRecord | null =>
  messages.get(id.trim()) ?? null;

export const recordMessage = (record: MessageRecord): MessageRecord => {
  messages.set(record.id, record);
  if (messages.size > MAX_RETAINED) {
    const oldest = [...messages.values()].sort((a, b) =>
      a.sentAt.localeCompare(b.sentAt),
    );
    for (const entry of oldest) {
      if (messages.size <= MAX_RETAINED) break;
      messages.delete(entry.id);
    }
  }
  return record;
};

export const requireMessage = (id: string): MessageRecord => {
  const record = getMessage(id);
  if (!record) {
    throw new MessagingError(t("libMessaging.messageNotFound", { id }), 404);
  }
  return record;
};

/** Test seam: drops every record. */
export const resetMessageStore = (): void => {
  messages.clear();
};
