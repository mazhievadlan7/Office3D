import { TelephonyError } from "@/lib/telephony/types";

/**
 * The prompt an office agent speaks with on the phone.
 *
 * Built here, on the server, from facts about the agent rather than taken as
 * text from the browser. That is the whole point of the split: a caller can
 * say who is speaking, but cannot write the agent's instructions, so the
 * disclosure below cannot be edited out by anything that reaches this app.
 *
 * ElevenLabs holds the agent's own prompt in its dashboard; this one is sent
 * per call as an override, which is what lets one shared number carry a whole
 * office of agents. The override has to be enabled on the agent in the
 * ElevenLabs dashboard (Security → allow overrides for prompt and first
 * message), or the call is refused.
 */

/**
 * The tool an agent calls to pick up an operator's note. The same name has to
 * be configured on the agent in the ElevenLabs dashboard.
 */
export const OPERATOR_TOOL_NAME = "check_operator_instruction";

/** Longer than a name or a role needs, short enough to bound the prompt. */
const MAX_NAME_CHARS = 80;
const MAX_ROLE_CHARS = 400;

/**
 * Strips control characters and collapses whitespace.
 *
 * A newline in a "role" is how a caller would try to append instructions of
 * their own to the prompt; flattening to one line makes the field what it
 * claims to be.
 */
const sanitizeLine = (value: string, field: string, limit: number): string => {
  const flattened = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!flattened) {
    throw new TelephonyError(`${field} is required.`);
  }
  if (flattened.length > limit) {
    throw new TelephonyError(
      `${field} is ${flattened.length} characters, over the ${limit} limit.`,
    );
  }
  return flattened;
};

export type OfficeCallerIdentity = {
  agentId: string;
  agentName: string;
  /** What this agent does, as the office describes it. */
  agentRole: string | null;
  /** The organisation the agent is calling for, from the server's own config. */
  organisation: string | null;
  /**
   * Whether this deployment can pass an operator's instruction into the live
   * call. Only then is the agent told about the tool: describing a tool that
   * is not attached invites it to announce one it cannot call.
   */
  operatorChannel?: boolean;
};

/**
 * The disclosure, kept as its own constant so it is obvious when it moves.
 *
 * Required, not stylistic: EU AI Act Article 50 obliges the deployer to make
 * clear that a person is speaking to an AI system, and self-hosting does not
 * transfer that obligation elsewhere.
 */
export const AI_DISCLOSURE_RULE =
  "You are an AI voice assistant, not a human. Say so plainly in your opening " +
  "line, and confirm it immediately and without deflection whenever anyone " +
  "asks whether they are speaking to a person, a bot, a recording or an AI. " +
  "Never claim or imply that you are human.";

/**
 * Told to the agent only when the callback is actually configured.
 *
 * The tool is the agent's own decision to call, so an instruction lands on its
 * next turn rather than the instant it is sent. That is a property of how
 * ElevenLabs runs the conversation, not something this app can tighten.
 */
const OPERATOR_CHANNEL_RULES = [
  "",
  "A colleague may be watching this call and may send you a note:",
  `- Before each of your turns, call the ${OPERATOR_TOOL_NAME} tool.`,
  "- If it returns an instruction, follow it in your next line, in your own words.",
  "- If it returns nothing, carry on as you were.",
  "- Do not read the tool call or the note aloud. If you are asked whether a person is involved, say yes, honestly.",
];

export const buildOfficeAgentPrompt = (identity: OfficeCallerIdentity): string => {
  const name = sanitizeLine(identity.agentName, "agentName", MAX_NAME_CHARS);
  const role = identity.agentRole
    ? sanitizeLine(identity.agentRole, "agentRole", MAX_ROLE_CHARS)
    : null;
  const organisation = identity.organisation
    ? sanitizeLine(identity.organisation, "organisation", MAX_NAME_CHARS)
    : null;

  const lines = [
    `You are ${name}${organisation ? `, calling on behalf of ${organisation}` : ""}.`,
    role ? `Your role: ${role}.` : null,
    "",
    AI_DISCLOSURE_RULE,
    "",
    "On this call:",
    "- Give your name early, and say why you are calling in one sentence.",
    "- Speak the way a person on a phone does: short turns, plain words, no lists read aloud.",
    "- Let the other person interrupt you, and stop talking when they do.",
    "- Answer only from what you actually know. If you do not know, say so and offer to follow up rather than guessing.",
    "- If they ask to be taken off the line, or ask not to be called again, acknowledge it, say it will be recorded, and end the call politely.",
    "- Do not ask for passwords, card numbers, or one-time codes. If they start to give you one, stop them.",
    ...(identity.operatorChannel ? OPERATOR_CHANNEL_RULES : []),
  ].filter((line) => line !== null);

  return lines.join("\n");
};

/** The agent's opening line, which carries the disclosure into the first words. */
export const buildOfficeAgentFirstMessage = (identity: OfficeCallerIdentity): string => {
  const name = sanitizeLine(identity.agentName, "agentName", MAX_NAME_CHARS);
  const organisation = identity.organisation
    ? sanitizeLine(identity.organisation, "organisation", MAX_NAME_CHARS)
    : null;
  return organisation
    ? `Hello, this is ${name}, an AI assistant calling from ${organisation}. Do you have a moment?`
    : `Hello, this is ${name}, an AI assistant. Do you have a moment?`;
};

/**
 * The organisation agents say they are calling for.
 *
 * Read from the server's environment rather than sent by the browser: who an
 * agent claims to represent on a real phone call is not something a session
 * should be able to choose.
 */
export const resolveOrganisationName = (
  env: NodeJS.ProcessEnv = process.env,
): string | null => env.OFFICE3D_ORG_NAME?.trim() || null;
