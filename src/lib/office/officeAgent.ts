/**
 * An agent as the office shows it: the HQ hall and the chat roster read this
 * instead of the full agent state. Agents of a remote office (seen through its
 * presence feed) carry ids with the `remote:` prefix, so they never collide
 * with local ones.
 */
export type OfficeAgent = {
  id: string;
  name: string;
  subtitle?: string | null;
  status: "working" | "idle" | "error";
};

export const REMOTE_OFFICE_AGENT_ID_PREFIX = "remote:";

export const isRemoteOfficeAgentId = (agentId: string) =>
  agentId.startsWith(REMOTE_OFFICE_AGENT_ID_PREFIX);
