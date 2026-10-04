/**
 * Entering the HQ. Every time the page opens (a sign-in, a refresh, a new
 * tab) the HQ system greets the operator out loud as the camera flies in
 * (lib/office/greeting.ts, OfficeScreen). Browsers keep a page silent until
 * the person has interacted with it, and after a reload nothing has been
 * clicked yet: the page first tries to start its audio on its own, and only
 * when the browser refuses does it show the entry screen (HqEntryGate), whose
 * click or key press unlocks the sound and starts the fly-through and the
 * greeting together.
 */

/** How long a resume() without a gesture may take before the browser counts as refusing (ms). */
export const AUDIO_START_WAIT_MS = 400;

type ResumableContext = Pick<AudioContext, "state" | "resume">;

/**
 * Tries to start `ctx` without a gesture. True when sound can play now: the
 * context already runs, or the browser lets it start (the page was clicked
 * already, or the site may play sound). A browser that refuses keeps
 * resume() pending, so the answer is false after `waitMs`.
 */
export async function tryStartAudio(ctx: ResumableContext | null, waitMs: number = AUDIO_START_WAIT_MS): Promise<boolean> {
  if (!ctx) return false;
  if (ctx.state === "running") return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      ctx.resume().catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, waitMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  return (ctx.state as AudioContextState) === "running";
}

/** The entry step: deciding whether sound may play, waiting for the click, or in. */
export type HqEntryState = "checking" | "gate" | "entered";

const GREETED = Symbol.for("office3d.hq.greeted");

type GreetedFlag = { [GREETED]?: boolean };

/**
 * True once per page load: the first caller greets, everyone after it (a
 * component remounted by hot reload or React's double-mount in development)
 * does not, so the greeting never plays over itself. A reload starts a new page.
 */
export function claimHqGreeting(scope: object = globalThis): boolean {
  const flags = scope as GreetedFlag;
  if (flags[GREETED]) return false;
  flags[GREETED] = true;
  return true;
}

/** Whether this page has greeted already (see claimHqGreeting). */
export function hqGreetingClaimed(scope: object = globalThis): boolean {
  return Boolean((scope as GreetedFlag)[GREETED]);
}
