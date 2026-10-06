/**
 * The live-chatter model for the боевой пульт (§3.5): agents talking and
 * delegating in PLAIN RUSSIAN as they work — "как люди", no technical mush.
 *
 * This is a DISPLAY layer only. Nothing here sends a message anywhere; it holds
 * the human-language operations traffic the pult shows. The demo script
 * (demoScript.ts) fills it now; the real agent runtime will call post() later
 * through the very same controller — one seam, swap the source.
 *
 * LAWFUL FRAMING (load-bearing). Every line is authorized-recon flavour against
 * clearly FICTIONAL reserved targets (example.com, 203.0.113.0/24 / TEST-NET-3).
 * No real person or org, no external delivery. See TZ §0, §3.5.
 */

/** What a line is about, for its small coloured tag. */
export type ChatterKind =
  /** Discovery / passive recon result. */
  | "recon"
  /** Handing a lead to another operative. */
  | "delegate"
  /** Taking a delegated lead. */
  | "accept"
  /** A reported finding (carries a severity). */
  | "finding"
  /** A confirmation / reproduction of someone's finding. */
  | "verify"
  /** An orchestration / scope / health note. */
  | "status"
  /** A guardrail reminder (scope, no external action). */
  | "escalate";

/** A line's weight when it is a finding. Mirrors the pult's severities. */
export type ChatterSeverity = "info" | "low" | "medium" | "high" | "critical";

/** A geolocation a line can be flown to on the shared globe. */
export type ChatterGeo = { lat: number; lon: number };

/** One human-language message in the operations channel. */
export type ChatterMessage = {
  /** Stable id for React keys. */
  id: string;
  /** The speaker's callsign (operational handle). */
  callsign: string;
  /** Plain Russian, readable, no tool dumps. */
  text: string;
  kind: ChatterKind;
  /** Epoch ms when it was said. */
  at: number;
  /** Set when the line reports a finding. */
  severity?: ChatterSeverity;
  /** Optional point this line refers to, so the pult can fly the globe to it. */
  geo?: ChatterGeo;
};

/** What a caller posts; id and timestamp are filled in when omitted. */
export type ChatterInput = Omit<ChatterMessage, "id" | "at"> & { id?: string; at?: number };

export type ChatterListener = (messages: readonly ChatterMessage[]) => void;

/**
 * The one chatter API the pult reads. The demo driver populates it today; the
 * scope-enforced agent runtime will call post() later. Display only — it never
 * transmits anything.
 */
export type ChatterController = {
  /** The current rolling log, oldest first. */
  getMessages(): readonly ChatterMessage[];
  /** Subscribe to changes; returns an unsubscribe. */
  subscribe(listener: ChatterListener): () => void;
  /** Append a message (the backend seam). Returns the stored message. */
  post(input: ChatterInput): ChatterMessage;
  /** Drop every message. */
  clear(): void;
  /**
   * Start the DEMO driver (scripted ops traffic). Ref-counted and idempotent:
   * several open pults share one timer, and it stops when the last one closes —
   * so a closed pult costs nothing. Returns a stop function. Demo only; the real
   * runtime uses post().
   */
  startDemo(callsigns?: readonly string[]): () => void;
};
