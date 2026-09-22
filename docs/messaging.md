# Agent messages

Agents message people from the office messaging booth, through the same
ElevenLabs account that runs the phone.

## WhatsApp, and why not SMS

**ElevenLabs has no SMS API.** It has outbound WhatsApp messages and outbound
calls, and nothing else that sends text. Plain SMS would mean credentials from
a carrier (Sinch, Infobip, or whoever provides the SIP trunk) and a second
provider in the chain — which is exactly the trade-off the voice platform was
chosen to avoid. It is not built.

**WhatsApp messages are template-only.** WhatsApp will not carry free-form text
to somebody who has not messaged you recently, so the API takes an approved
template name and its parameters. The office sends one template and fills its
single body parameter with what the agent wanted to say. The panel says so,
because a composer that looked like a chat would mislead about what the
recipient actually receives.

## Configuration

| Variable | What it is |
| --- | --- |
| `ELEVENLABS_API_KEY` | Shared with telephony. |
| `ELEVENLABS_AGENT_ID` | Shared with telephony. |
| `ELEVENLABS_WHATSAPP_PHONE_NUMBER_ID` | The WhatsApp Business number registered with ElevenLabs. |
| `ELEVENLABS_WHATSAPP_TEMPLATE` | The approved template name, e.g. `office_notice`. |
| `ELEVENLABS_WHATSAPP_TEMPLATE_LANGUAGE` | Its language code, e.g. `en`. |

With any missing, the booth opens but will not send, and names the missing
variable rather than a bare "not configured". The template must be approved in
Meta's WhatsApp Manager and have exactly one body parameter; a name or language
that does not match an approved template comes back as a `422`, passed through
with the provider's own wording.

## What is recorded

A message is recorded only when the provider accepted it and returned an id. A
refusal records nothing: a failed row in the log would read like a message that
exists.

The record says **sent**, never *delivered*. The provider took it; whether it
reached a handset is something only a delivery receipt would say, and there is
no receipt channel here.

There is **no inbound channel**, so there are no replies. The booth used to
invent one — a hardcoded recipient, a message to them, and a reply they never
sent, all animated as though it had happened. That is removed. The booth now
shows what the office actually sent, or nothing.

## Messages an agent asks for

Saying "text my wife" to an agent does not send anything. The office opens the
messaging panel with the request as context and a human supplies the number and
sends. A name is not a number, and a message costs money and reaches a
stranger — not a decision to take on an agent's say-so.

## API

| Route | What it does |
| --- | --- |
| `POST /api/messaging/messages` | `{to, text, agentId, agentName}` → sends and records it. `to` is a phone number in international form, with or without the plus. |
| `GET /api/messaging/messages` | Readiness plus what this process has sent. |

Errors keep the status they earned: `400` for a recipient that is not a number
or text that is empty or over the 900-character cap, `503` naming the missing
variables, and the provider's own status when it refuses.

## Known limits

- **The sent log is in the server process.** A restart loses it and a second
  instance keeps its own. Unlike a live call a sent message is a durable fact,
  so this is the office's own view rather than the record of record — the
  provider holds that.
- **No delivery receipts, and no replies.** Both would need webhooks from the
  provider and a public URL, the same machinery the mid-call operator channel
  uses.
- **No SMS.** See above: it needs a carrier, not ElevenLabs.
