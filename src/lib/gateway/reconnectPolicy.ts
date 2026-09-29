// How the office gets its gateway connection back by itself.
//
// The browser talks to the same-origin proxy (server/gateway-proxy.js), which
// talks to the upstream gateway (OpenClaw, the demo gateway, or the in-process
// Hermes adapter). When the upstream goes away the proxy closes the browser
// socket (1012 after connect, 4008 "connect failed: studio.upstream_error …"
// before it); when the office's own server restarts the socket just drops
// (1006). All of those are transient: the office keeps retrying, forever, with
// exponential backoff and jitter, until the gateway answers again. Only a
// failure that retrying cannot fix — a wrong token, a refused pairing, a
// missing or blocked address — stops the loop and is shown to the person.

export const RECONNECT_BASE_DELAY_MS = 1_000;
export const RECONNECT_MAX_DELAY_MS = 15_000;
/** A close for rate limiting (1008) waits at least this long before the next try. */
export const RECONNECT_RATE_LIMIT_DELAY_MS = 15_000;

const WS_CLOSE_POLICY_VIOLATION = 1008;

/**
 * The delay before retry number `attempt` (0-based): 1 s, 2 s, 4 s, 8 s, then
 * 15 s, each with "equal jitter" (half fixed, half random) so many open tabs
 * do not all knock on a restarted gateway in the same instant.
 */
export const computeReconnectDelayMs = (
  attempt: number,
  options: {
    baseMs?: number;
    maxMs?: number;
    random?: () => number;
    lastCloseCode?: number | null;
  } = {},
): number => {
  const baseMs = options.baseMs ?? RECONNECT_BASE_DELAY_MS;
  const maxMs = options.maxMs ?? RECONNECT_MAX_DELAY_MS;
  const random = options.random ?? Math.random;
  const safeAttempt = Math.max(0, Math.min(30, Math.floor(attempt)));
  const ceiling = Math.min(maxMs, baseMs * 2 ** safeAttempt);
  const jitter = Math.min(1, Math.max(0, random()));
  const delay = Math.round(ceiling / 2 + (ceiling / 2) * jitter);
  if (options.lastCloseCode === WS_CLOSE_POLICY_VIOLATION) {
    return Math.max(delay, RECONNECT_RATE_LIMIT_DELAY_MS);
  }
  return delay;
};

export type GatewayFailureKind = "auth" | "config" | "transient";

// Retrying these cannot help: the person has to change a setting.
const CONFIG_ERROR_CODES = new Set([
  "studio.gateway_url_missing",
  "studio.gateway_url_invalid",
  "studio.gateway_url_blocked",
  "studio.settings_load_failed",
]);

const AUTH_ERROR_CODES = new Set([
  "studio.gateway_token_missing",
  "studio.upstream_rejected",
  "unauthorized",
  "forbidden",
  "auth_failed",
  "invalid_token",
  "not_paired",
  "pairing_required",
]);

const AUTH_MESSAGE_RE =
  /unauthori[sz]ed|forbidden|invalid token|token mismatch|token required|auth(entication)? failed|pairing required|device identity|нет доступа|токен/i;

/**
 * Whether a failed connect is worth retrying. `code` is the gateway error code
 * (GatewayResponseError.code) when there is one.
 */
export const classifyGatewayFailure = (params: {
  code: string | null;
  message: string | null;
}): GatewayFailureKind => {
  const code = params.code?.trim().toLowerCase() ?? "";
  if (code) {
    if (CONFIG_ERROR_CODES.has(code)) return "config";
    if (AUTH_ERROR_CODES.has(code)) return "auth";
    // The proxy could not reach the upstream, it timed out, or it closed:
    // the gateway is down or restarting.
    if (code.startsWith("studio.upstream_")) return "transient";
  }
  const message = params.message ?? "";
  if (message && AUTH_MESSAGE_RE.test(message)) return "auth";
  return "transient";
};

export type ReconnectSchedulerOptions = {
  /** Runs one reconnect attempt; it reports its outcome through schedule() / reset(). */
  run: () => void;
  baseMs?: number;
  maxMs?: number;
  random?: () => number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (id: unknown) => void;
  onScheduled?: (info: { attempt: number; delayMs: number }) => void;
};

/**
 * Owns the retry timer. The caller calls schedule() after every failure and
 * reset() on success; kick() skips the wait (the network came back, the tab
 * became visible) when a retry is pending.
 */
export class ReconnectScheduler {
  private attempt = 0;
  private timer: unknown = null;
  private readonly opts: ReconnectSchedulerOptions;

  constructor(opts: ReconnectSchedulerOptions) {
    this.opts = opts;
  }

  get attempts() {
    return this.attempt;
  }

  get pending() {
    return this.timer !== null;
  }

  /** Waits for the next backoff step, then runs one attempt. Returns the delay. */
  schedule(lastCloseCode: number | null = null): number {
    this.clearTimer();
    const delayMs = computeReconnectDelayMs(this.attempt, {
      baseMs: this.opts.baseMs,
      maxMs: this.opts.maxMs,
      random: this.opts.random,
      lastCloseCode,
    });
    this.attempt += 1;
    this.opts.onScheduled?.({ attempt: this.attempt, delayMs });
    const set = this.opts.setTimeout ?? ((fn: () => void, ms: number) => globalThis.setTimeout(fn, ms));
    this.timer = set(() => {
      this.timer = null;
      this.opts.run();
    }, delayMs);
    return delayMs;
  }

  /** Runs the pending attempt now. False when nothing was waiting. */
  kick(): boolean {
    if (this.timer === null) return false;
    this.clearTimer();
    this.opts.run();
    return true;
  }

  /** Connected, or the person took over: forget the backoff. */
  reset() {
    this.clearTimer();
    this.attempt = 0;
  }

  /** Stops waiting but keeps the backoff step. */
  cancel() {
    this.clearTimer();
  }

  private clearTimer() {
    if (this.timer === null) return;
    const clear =
      this.opts.clearTimeout ??
      ((id: unknown) => globalThis.clearTimeout(id as ReturnType<typeof globalThis.setTimeout>));
    clear(this.timer);
    this.timer = null;
  }
}
