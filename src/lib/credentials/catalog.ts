/**
 * The credentials Office3D and its skills understand.
 *
 * This is a catalogue, not a vault: it declares which environment variable
 * carries each secret and what breaks without it. Values are never stored
 * here, never committed, and never returned to the browser — they live in
 * `.env` (already git-ignored) or in the deployment's own secret store.
 *
 * Per-skill API keys are a separate, existing mechanism and are deliberately
 * not duplicated here: OpenClaw skills declare a `primaryEnv`, and Studio
 * already saves a key per skill through `skills.update`, which the gateway
 * applies to that skill's environment when it runs. A skill's key belongs
 * there, scoped to the one skill that needs it, rather than in a process-wide
 * variable every skill can read.
 */

export type CredentialConsumer =
  /** Read by Office3D itself — the app stops doing something without it. */
  | "office3d"
  /**
   * Read by a skill or an agent, not by Office3D. Listed so a deployment can
   * see in one place what is configured on the host; nothing in this app calls
   * these APIs.
   */
  | "skills";

export type CredentialDefinition = {
  id: string;
  label: string;
  envVar: string;
  consumedBy: CredentialConsumer;
  /** What is lost when it is missing. */
  purpose: string;
  /** True when Office3D cannot run correctly without it in some mode. */
  requiredFor: string | null;
  docsUrl: string | null;
};

export const CREDENTIAL_CATALOG: CredentialDefinition[] = [
  {
    id: "studio-access-token",
    label: "Studio access token",
    envVar: "STUDIO_ACCESS_TOKEN",
    consumedBy: "office3d",
    purpose: "Gates access to the app.",
    requiredFor:
      "Any non-loopback deployment. The server refuses to bind a public host without it.",
    docsUrl: null,
  },
  {
    id: "gateway-token",
    label: "Gateway token",
    envVar: "OFFICE3D_GATEWAY_TOKEN",
    consumedBy: "office3d",
    purpose: "Authenticates the runtime gateway connection.",
    requiredFor: "Gateways that require a token.",
    docsUrl: null,
  },
  {
    id: "hermes-api-key",
    label: "Hermes API key",
    envVar: "HERMES_API_KEY",
    consumedBy: "office3d",
    purpose: "Bearer token the Hermes adapter sends to the Hermes HTTP API.",
    requiredFor: "The Hermes runtime, when its API requires a key.",
    docsUrl: null,
  },
  {
    id: "elevenlabs-api-key",
    label: "ElevenLabs API key",
    envVar: "ELEVENLABS_API_KEY",
    consumedBy: "office3d",
    purpose: "Speech synthesis for agent voice replies.",
    requiredFor: "Voice replies. Without it the office stays silent.",
    docsUrl: "https://elevenlabs.io/docs",
  },
  {
    id: "github-token",
    label: "GitHub token",
    envVar: "GITHUB_TOKEN",
    consumedBy: "office3d",
    purpose:
      "Raises GitHub's 60 requests/hour anonymous limit when browsing or installing skills, and is the only way to reach a private repository.",
    requiredFor: null,
    docsUrl: "https://docs.github.com/en/rest",
  },
  {
    id: "elevenlabs-agent-id",
    label: "ElevenLabs agent ID",
    envVar: "ELEVENLABS_AGENT_ID",
    consumedBy: "office3d",
    purpose:
      "The conversational agent, created in the ElevenLabs dashboard, that speaks on phone calls. Paired with ELEVENLABS_API_KEY.",
    requiredFor: "Voice agent phone calls.",
    docsUrl: "https://elevenlabs.io/docs/eleven-agents",
  },
  {
    id: "elevenlabs-phone-number-id",
    label: "ElevenLabs phone number ID",
    envVar: "ELEVENLABS_PHONE_NUMBER_ID",
    consumedBy: "office3d",
    purpose:
      "The number registered with ElevenLabs that agents call from. One number serves every office agent.",
    requiredFor: "Voice agent phone calls.",
    docsUrl: "https://elevenlabs.io/docs/eleven-agents/phone-numbers/sip-trunking",
  },
  {
    id: "office3d-org-name",
    label: "Organisation name",
    envVar: "OFFICE3D_ORG_NAME",
    consumedBy: "office3d",
    purpose:
      "The organisation agents say they are calling for. Read from the server so a browser session cannot choose who an agent claims to represent on a real call.",
    requiredFor: null,
    docsUrl: null,
  },
  // Below: keys a skill or agent may use. Office3D never calls these APIs
  // itself, so a missing one costs nothing here — it is listed so a
  // deployment can confirm at a glance what the host has.
  {
    id: "higgsfield-api-key",
    label: "Higgsfield API key",
    envVar: "HIGGSFIELD_API_KEY",
    consumedBy: "skills",
    purpose: "Image, video and audio generation for skills that use Higgsfield.",
    requiredFor: null,
    docsUrl: null,
  },
  {
    id: "youtube-api-key",
    label: "YouTube Data API key",
    envVar: "YOUTUBE_API_KEY",
    consumedBy: "skills",
    purpose: "YouTube search and metadata lookups for skills that use them.",
    requiredFor: null,
    docsUrl: "https://developers.google.com/youtube/v3",
  },
  {
    id: "qwen-api-key",
    label: "Qwen API key",
    envVar: "QWEN_API_KEY",
    consumedBy: "skills",
    purpose: "Qwen model access for skills that call it directly.",
    requiredFor: null,
    docsUrl: null,
  },
];

export type CredentialStatus = Omit<CredentialDefinition, never> & {
  /** Whether the variable is set. The value itself is never included. */
  configured: boolean;
};

export const describeCredentials = (
  env: NodeJS.ProcessEnv = process.env,
): CredentialStatus[] =>
  CREDENTIAL_CATALOG.map((definition) => ({
    ...definition,
    configured: Boolean(env[definition.envVar]?.trim()),
  }));

/**
 * Reads a credential's value. Server-side only — never return the result to a
 * client, and never log it.
 */
export const readCredential = (
  id: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null => {
  const definition = CREDENTIAL_CATALOG.find((entry) => entry.id === id);
  if (!definition) return null;
  return env[definition.envVar]?.trim() || null;
};
