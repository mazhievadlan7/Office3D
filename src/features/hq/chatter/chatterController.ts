import { buildDemoScript, DEMO_CALLSIGNS } from "./demoScript";
import type { ChatterController, ChatterInput, ChatterListener, ChatterMessage } from "./types";

/**
 * The one framework-free chatter controller the боевой пульт reads. It holds a
 * rolling log of human-language operations traffic, notifies subscribers on
 * change, and can run a scripted DEMO driver until the real agent runtime takes
 * over through post().
 *
 * Vanilla on purpose (like osintController / geoController): the demo fills it
 * now, the scope-enforced Execution Plane will call post() later. Display only —
 * nothing here ever transmits a message. See TZ §0, §3.5.
 */

/** How many lines the channel keeps; older ones scroll off. */
const MAX_MESSAGES = 60;
/** How often the demo driver emits a new line. */
const DEMO_INTERVAL_MS = 3500;
/** How many lines to backfill when the demo first starts, so the panel is alive. */
const DEMO_SEED = 5;

let seq = 0;
const nextId = (): string => `chat-${(seq += 1).toString(36)}`;

class HqChatterController implements ChatterController {
  private messages: ChatterMessage[] = [];
  private readonly listeners = new Set<ChatterListener>();
  private demoTimer: ReturnType<typeof setInterval> | null = null;
  private demoRefs = 0;

  getMessages(): readonly ChatterMessage[] {
    return this.messages;
  }

  subscribe(listener: ChatterListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  post(input: ChatterInput): ChatterMessage {
    const message: ChatterMessage = {
      ...input,
      id: input.id ?? nextId(),
      at: input.at ?? Date.now(),
    };
    this.messages = [...this.messages, message].slice(-MAX_MESSAGES);
    this.emit();
    return message;
  }

  clear(): void {
    this.messages = [];
    this.emit();
  }

  startDemo(callsigns: readonly string[] = DEMO_CALLSIGNS): () => void {
    this.demoRefs += 1;
    if (this.demoTimer === null) {
      const script = buildDemoScript(callsigns);
      let cursor = 0;
      const emitNext = () => {
        const line = script[cursor % script.length];
        cursor += 1;
        this.post({ ...line });
      };
      // Backfill a few with receding timestamps so the channel opens populated,
      // but only when it is empty (a re-open keeps the existing history).
      if (this.messages.length === 0) {
        const seed = Math.min(DEMO_SEED, script.length);
        const base = Date.now();
        for (let k = 0; k < seed; k += 1) {
          const line = script[cursor % script.length];
          cursor += 1;
          this.post({ ...line, at: base - (seed - k) * DEMO_INTERVAL_MS });
        }
      }
      this.demoTimer = setInterval(emitNext, DEMO_INTERVAL_MS);
    }
    return () => this.releaseDemo();
  }

  private releaseDemo(): void {
    this.demoRefs = Math.max(0, this.demoRefs - 1);
    if (this.demoRefs === 0 && this.demoTimer !== null) {
      clearInterval(this.demoTimer);
      this.demoTimer = null;
    }
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.messages);
  }
}

/** The one chatter controller shared by the pult (and, later, the backend). */
export const chatterController: ChatterController = new HqChatterController();
