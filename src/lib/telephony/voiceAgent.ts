import { TelephonyError } from "@/lib/telephony/types";

/**
 * Voice agent provider: the platform that actually holds the conversation.
 *
 * Office3D does not run the audio pipeline for phone calls. Duplex audio,
 * streaming speech recognition, barge-in and sub-second latency are weeks of
 * work to build and a commodity to buy, so a platform does it and this app
 * drives it, shows the conversation and lets an operator intervene.
 *
 * The provider is behind an interface because the choice has consequences
 * worth being able to revisit — above all where the audio goes. A phone call
 * always transits a carrier, and a hosted voice platform is a second processor
 * on top of that; a deployment that cannot accept either needs a self-hosted
 * provider instead, which this seam leaves room for.
 */

export type VoiceAgentProviderId = "elevenlabs";

export type VoiceAgentConfig = {
  provider: VoiceAgentProviderId;
  apiKey: string;
  /** The agent created in the provider's dashboard that speaks on calls. */
  agentId: string;
};

export const resolveVoiceAgentConfig = (
  env: NodeJS.ProcessEnv = process.env,
): VoiceAgentConfig => {
  const apiKey = env.ELEVENLABS_API_KEY?.trim() ?? "";
  const agentId = env.ELEVENLABS_AGENT_ID?.trim() ?? "";

  const missing = [
    !apiKey && "ELEVENLABS_API_KEY",
    !agentId && "ELEVENLABS_AGENT_ID",
  ].filter(Boolean);

  if (missing.length > 0) {
    throw new TelephonyError(
      `The voice agent is not configured. Missing: ${missing.join(", ")}.`,
      503,
    );
  }

  return { provider: "elevenlabs", apiKey, agentId };
};

export const isVoiceAgentConfigured = (
  env: NodeJS.ProcessEnv = process.env,
): boolean => {
  try {
    resolveVoiceAgentConfig(env);
    return true;
  } catch {
    return false;
  }
};

export type VoiceAgentReadiness = {
  provider: VoiceAgentProviderId;
  configured: boolean;
  /** Environment variables still needed, by name. Never their values. */
  missing: string[];
};

export const describeVoiceAgentReadiness = (
  env: NodeJS.ProcessEnv = process.env,
): VoiceAgentReadiness => {
  const missing = [
    !env.ELEVENLABS_API_KEY?.trim() && "ELEVENLABS_API_KEY",
    !env.ELEVENLABS_AGENT_ID?.trim() && "ELEVENLABS_AGENT_ID",
  ].filter((entry): entry is string => typeof entry === "string");

  return { provider: "elevenlabs", configured: missing.length === 0, missing };
};
