# Agent phone calls

Agents call out from the office phone booth. One number serves the whole
office: the person answering sees a single caller id, and the agent says which
desk it is speaking for.

## How a call travels

```
Office floor              Office3D server            ElevenLabs           SIP carrier
  phone booth  ──click──▶  POST /api/telephony/calls ──▶ outbound call ──▶ the callee
                           (stores the conversation)
  live feed    ◀──poll───  GET  /api/telephony/calls ◀── conversation ───
```

ElevenLabs runs the call: it dials out over a SIP trunk registered with them,
holds the conversation, handles barge-in and returns the transcript. Office3D
asks for the call and reads back what was said. That means:

- This app holds **no carrier credentials** and needs **no public URL** — there
  is no webhook for a provider to reach, so no tunnel in development.
- The audio and the transcript are **processed by ElevenLabs**, and the call
  transits the carrier. Neither is avoidable with a hosted voice platform.

## Configuration

Four variables, all documented in `.env.example`:

| Variable | What it is |
| --- | --- |
| `ELEVENLABS_API_KEY` | Account key, sent as `xi-api-key`. |
| `ELEVENLABS_AGENT_ID` | The conversational agent created in the ElevenLabs dashboard. |
| `ELEVENLABS_PHONE_NUMBER_ID` | The number registered with ElevenLabs that agents call from. |
| `OFFICE3D_ORG_NAME` | Optional. The organisation agents say they are calling for. |

One more step in the ElevenLabs dashboard: on the agent, enable **allow
overrides** for the prompt and the first message (Security). Office3D sends
both per call, and without that switch ElevenLabs refuses the call. The
refusal is passed through with a hint naming the setting.

With any of them missing, the phone booth opens but will not dial, and says
which variable is missing rather than a bare "not configured".
`GET /api/telephony/status` answers the same question without placing a call —
it reports names only, never values.

## Who the agent is on the call

You do not write a system prompt in the ElevenLabs dashboard. One ElevenLabs
agent and one number serve the whole office; who is speaking is decided per
call, from the agent's own name and role as the office already knows them:

```
You are Nova, calling on behalf of Northwind.
Your role: Chases overdue invoices.

<AI disclosure>

On this call:
- Give your name early, and say why you are calling in one sentence.
- …
```

The prompt is composed **on the server**, from facts, and a prompt sent in the
request body is ignored. That is a security boundary, not a style choice: a
caller who could supply prompt text could delete the disclosure below. For the
same reason `OFFICE3D_ORG_NAME` comes from the environment — who an agent
claims to represent on a real phone call is the deployment's to decide, not a
session's. A name or role is flattened to one line and length-capped before it
reaches the prompt, so neither can pose as a new instruction block.

Add a new agent to the office and it can call immediately; there is nothing to
fill in per agent.

## Disclosure

The agent identifies itself as an AI in its opening line and confirms it
whenever asked. Both the rule and the opening line are in the generated prompt
(`AI_DISCLOSURE_RULE` in `src/lib/telephony/agentPrompt.ts`), and because that
prompt is composed on the server there is no request that can remove them.

This is not a stylistic choice: the EU AI Act (Article 50) requires that a
person interacting with an AI system is told so, and the obligation follows the
deployer — self-hosting does not remove it.

## API

| Route | What it does |
| --- | --- |
| `POST /api/telephony/calls` | `{toNumber, agentId, agentName, agentRole?}` → places the call, returns the record. `toNumber` must be E.164, and the prompt is built server-side from the rest. |
| `GET /api/telephony/calls` | The live feed: every call with its transcript, live ones read fresh from the provider. |
| `GET /api/telephony/calls/[sid]` | One call, read fresh while it is live. |
| `GET /api/telephony/status` | Readiness plus a summary of calls, without transcripts. |

Errors keep the status they earned: `400` for a malformed number, `404` for an
unknown call, `503` naming the missing variables, and the provider's own status
(`401`, `422`, …) when it refuses, so a deployment is not sent looking in the
wrong place.

`GET /api/telephony/calls` reports a call it could not read under `syncErrors`
rather than failing the whole request — one unreadable conversation must not
blank the feed — and the panel marks that call as not updating instead of
showing a stale transcript as if it were live.

## Access

Every telephony route sits behind the server's access gate, and there is no
second check inside the routes. Any session that reaches the app can therefore
dial a number, which costs money and rings a stranger's phone. Deploy with
`STUDIO_ACCESS_TOKEN` set.

## Known limits

These are real limitations, not oversights:

- **The call store is in the server process.** A restart drops live calls, and
  running more than one instance means an operator may poll an instance that
  never saw the call. A shared store is needed before telephony survives
  horizontal scaling.
- **The feed polls; it does not stream.** Every three seconds while a call is
  live, thirty when nothing is. The server reads the provider on a timer either
  way, so a stream would only look more immediate than it is. Provider webhooks
  plus a shared store are the upgrade path.
- **Mid-call operator instructions are not wired.** The store carries a
  `pendingSay` field and nothing consumes it: ElevenLabs runs the conversation,
  and steering it mid-call is separate work.
- **Listening to live audio is not built.** ElevenLabs exposes signed-URL and
  WebRTC handles for it; neither is used yet.
