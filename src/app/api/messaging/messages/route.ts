import { NextResponse } from "next/server";

import {
  describeMessagingReadiness,
  resolveMessagingConfig,
} from "@/lib/messaging/provider";
import { listMessages, recordMessage } from "@/lib/messaging/store";
import {
  MessagingError,
  assertMessageText,
  normalizeWhatsAppUserId,
  type MessageRecord,
} from "@/lib/messaging/types";
import { sendWhatsAppTemplateMessage } from "@/lib/messaging/whatsapp";

export const runtime = "nodejs";

/**
 * Messages the office has sent.
 *
 * POST sends one and records what the provider accepted; GET lists what went
 * out from this process. Nothing is recorded as sent that a provider did not
 * take, and no reply is shown unless one actually arrives — the office has no
 * inbound channel yet, so it shows none.
 */

const NO_STORE = { "Cache-Control": "no-store" } as const;

const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: NO_STORE });

const fail = (error: unknown) => {
  if (error instanceof MessagingError) {
    return json({ error: error.message }, error.status);
  }
  console.error("[messaging] unhandled error", error);
  return json({ error: "Sending failed unexpectedly." }, 500);
};

const readString = (value: unknown, field: string): string => {
  if (typeof value !== "string" || !value.trim()) {
    throw new MessagingError(`${field} is required.`);
  }
  return value.trim();
};

export async function POST(request: Request) {
  try {
    let parsed: unknown;
    try {
      parsed = await request.json();
    } catch {
      throw new MessagingError("Could not read the request body as JSON.");
    }
    if (!parsed || typeof parsed !== "object") {
      throw new MessagingError("Expected a JSON object.");
    }
    const body = parsed as Record<string, unknown>;

    const to = normalizeWhatsAppUserId(readString(body.to, "to"), "to");
    const text = assertMessageText(readString(body.text, "text"), "text");
    const agentId = readString(body.agentId, "agentId");
    const agentName = readString(body.agentName, "agentName");

    // Resolved before sending so a half-configured deployment fails with the
    // names of what it is missing rather than a provider error.
    const config = resolveMessagingConfig();

    const sent = await sendWhatsAppTemplateMessage({ toUserId: to, text }, config);

    const record: MessageRecord = {
      id: sent.conversationId,
      channel: "whatsapp",
      agentId,
      agentName,
      to,
      text,
      template: config.templateName,
      sentAt: new Date().toISOString(),
      // "sent", not "delivered": the provider accepted it, and whether it
      // reached a handset is something only a delivery receipt would say.
      status: "sent",
      errorMessage: null,
    };

    return json({ message: recordMessage(record) }, 201);
  } catch (error) {
    // A send that failed leaves no record: there is no message, and a row in
    // the log would read like one that exists.
    return fail(error);
  }
}

export async function GET() {
  const messaging = describeMessagingReadiness();
  return json({
    ready: messaging.configured,
    messaging,
    messages: listMessages(),
  });
}
