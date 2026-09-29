
import { t } from "@/lib/i18n";
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
    label: t("libCredentials.studioAccessTokenLabel"),
    envVar: "STUDIO_ACCESS_TOKEN",
    consumedBy: "office3d",
    purpose: t("libCredentials.studioAccessTokenPurpose"),
    requiredFor:
      t("libCredentials.studioAccessTokenRequiredFor"),
    docsUrl: null,
  },
  {
    id: "gateway-token",
    label: t("libCredentials.gatewayTokenLabel"),
    envVar: "OFFICE3D_GATEWAY_TOKEN",
    consumedBy: "office3d",
    purpose: t("libCredentials.gatewayTokenPurpose"),
    requiredFor: t("libCredentials.gatewayTokenRequiredFor"),
    docsUrl: null,
  },
  {
    id: "hermes-api-key",
    label: t("libCredentials.hermesApiKeyLabel"),
    envVar: "HERMES_API_KEY",
    consumedBy: "office3d",
    purpose: t("libCredentials.hermesApiKeyPurpose"),
    requiredFor: t("libCredentials.hermesApiKeyRequiredFor"),
    docsUrl: null,
  },
  {
    id: "voice-api-key",
    label: t("libCredentials.voiceApiKeyLabel"),
    envVar: "OFFICE3D_VOICE_API_KEY",
    consumedBy: "office3d",
    purpose: t("libCredentials.voiceApiKeyPurpose"),
    requiredFor: t("libCredentials.voiceApiKeyRequiredFor"),
    docsUrl: null,
  },
  {
    id: "github-token",
    label: t("libCredentials.githubTokenLabel"),
    envVar: "GITHUB_TOKEN",
    consumedBy: "office3d",
    purpose:
      t("libCredentials.githubTokenPurpose"),
    requiredFor: null,
    docsUrl: "https://docs.github.com/en/rest",
  },
  {
    id: "office3d-public-url",
    label: t("libCredentials.publicUrlLabel"),
    envVar: "OFFICE3D_PUBLIC_URL",
    consumedBy: "office3d",
    purpose:
      t("libCredentials.publicUrlPurpose"),
    requiredFor: null,
    docsUrl: null,
  },
  // Below: keys a skill or agent may use. Office3D never calls these APIs
  // itself, so a missing one costs nothing here — it is listed so a
  // deployment can confirm at a glance what the host has.
  {
    id: "higgsfield-api-key",
    label: t("libCredentials.higgsfieldApiKeyLabel"),
    envVar: "HIGGSFIELD_API_KEY",
    consumedBy: "skills",
    purpose: t("libCredentials.higgsfieldApiKeyPurpose"),
    requiredFor: null,
    docsUrl: null,
  },
  {
    id: "youtube-api-key",
    label: t("libCredentials.youtubeApiKeyLabel"),
    envVar: "YOUTUBE_API_KEY",
    consumedBy: "skills",
    purpose: t("libCredentials.youtubeApiKeyPurpose"),
    requiredFor: null,
    docsUrl: "https://developers.google.com/youtube/v3",
  },
  {
    id: "qwen-api-key",
    label: t("libCredentials.qwenApiKeyLabel"),
    envVar: "QWEN_API_KEY",
    consumedBy: "skills",
    purpose: t("libCredentials.qwenApiKeyPurpose"),
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
