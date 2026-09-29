"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  GatewayBrowserClient,
  clearGatewayBrowserSessionStorage,
  type GatewayHelloOk,
} from "./openclaw/GatewayBrowserClient";
import type {
  StudioGatewayProfilePublic,
  StudioGatewayAdapterType,
  StudioGatewaySettings,
  StudioSettings,
  StudioSettingsPatch,
  StudioSettingsPublic,
} from "@/lib/studio/settings";
import {
  resolveDefaultStudioGatewayProfile,
  resolveStudioGatewayProfiles,
} from "@/lib/studio/settings";
import type {
  StudioSettingsLoadOptions,
  StudioSettingsResponse,
} from "@/lib/studio/coordinator";
import { resolveStudioProxyGatewayUrl } from "@/lib/gateway/proxy-url";
import { ensureGatewayReloadModeHotForLocalStudio } from "@/lib/gateway/gatewayReloadMode";
import { isLocalGatewayUrl } from "@/lib/gateway/local-gateway";
import { GatewayResponseError } from "@/lib/gateway/errors";
import { matchesPhrase, t } from "@/lib/i18n";
import { ReconnectScheduler, classifyGatewayFailure } from "@/lib/gateway/reconnectPolicy";

const gatewayDebugEnabled = process.env.NODE_ENV !== "production";

const gatewayDebugLog = (message: string, details?: Record<string, unknown>) => {
  if (!gatewayDebugEnabled) return;
  if (details) {
    console.info("[gateway-client]", message, details);
    return;
  }
  console.info("[gateway-client]", message);
};
import { probeCustomRuntime } from "@/lib/runtime/custom/http";

export type ReqFrame = {
  type: "req";
  id: string;
  method: string;
  params: unknown;
};

export type ResFrame = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: {
    code: string;
    message: string;
    details?: unknown;
    retryable?: boolean;
    retryAfterMs?: number;
  };
};

export type GatewayStateVersion = {
  presence: number;
  health: number;
};

export type EventFrame = {
  type: "event";
  event: string;
  payload?: unknown;
  seq?: number;
  stateVersion?: GatewayStateVersion;
};

export type GatewayFrame = ReqFrame | ResFrame | EventFrame;

export const parseGatewayFrame = (raw: string): GatewayFrame | null => {
  try {
    return JSON.parse(raw) as GatewayFrame;
  } catch {
    return null;
  }
};

export const buildAgentMainSessionKey = (agentId: string, mainKey: string) => {
  const trimmedAgent = agentId.trim();
  const trimmedKey = mainKey.trim() || "main";
  return `agent:${trimmedAgent}:${trimmedKey}`;
};

export const parseAgentIdFromSessionKey = (sessionKey: string): string | null => {
  const match = sessionKey.match(/^agent:([^:]+):/);
  return match ? match[1] : null;
};

export const isSameSessionKey = (a: string, b: string) => {
  const left = a.trim();
  const right = b.trim();
  return left.length > 0 && left === right;
};

const CONNECT_FAILED_CLOSE_CODE = 4008;
const GATEWAY_CONNECT_TIMEOUT_MS = 13_000;

const parseConnectFailedCloseReason = (
  reason: string
): { code: string; message: string } | null => {
  const trimmed = reason.trim();
  if (!trimmed.toLowerCase().startsWith("connect failed:")) return null;
  const remainder = trimmed.slice("connect failed:".length).trim();
  if (!remainder) return null;
  const idx = remainder.indexOf(" ");
  const code = (idx === -1 ? remainder : remainder.slice(0, idx)).trim();
  if (!code) return null;
  const message = (idx === -1 ? "" : remainder.slice(idx + 1)).trim();
  return { code, message: message || "connect failed" };
};

const DEFAULT_UPSTREAM_GATEWAY_URL =
  process.env.NEXT_PUBLIC_GATEWAY_URL || "ws://localhost:18789";
const INITIAL_AUTO_CONNECT_DELAY_MS = 900;
const INITIAL_CONNECT_RETRY_DELAY_MS = 1_200;
const OPENCLAW_CONTROL_UI_CLIENT_ID = "openclaw-control-ui";
const OPENCLAW_WEBCHAT_UI_CLIENT_ID = "webchat-ui";

const isAutoManagedAdapter = (adapterType: StudioGatewayAdapterType) =>
  adapterType === "openclaw" || adapterType === "hermes" || adapterType === "demo";

export const resolveGatewayClientName = (
  adapterType: StudioGatewayAdapterType,
  gatewayUrl: string
) => {
  if (adapterType !== "openclaw") {
    return OPENCLAW_CONTROL_UI_CLIENT_ID;
  }
  return isLocalGatewayUrl(gatewayUrl)
    ? OPENCLAW_CONTROL_UI_CLIENT_ID
    : OPENCLAW_WEBCHAT_UI_CLIENT_ID;
};

export const resolveInitialGatewayAutoConnectDelayMs = (
  adapterType: StudioGatewayAdapterType
): number => {
  switch (adapterType) {
    case "hermes":
    case "demo":
      return INITIAL_AUTO_CONNECT_DELAY_MS;
    default:
      return 0;
  }
};

export const resolveInitialGatewayConnectAttemptCount = (
  adapterType: StudioGatewayAdapterType,
  hasConnectedOnce: boolean
): number => {
  switch (adapterType) {
    case "hermes":
    case "demo":
      return 2;
    default:
      if (hasConnectedOnce) return 1;
      return 1;
  }
};

const normalizeLocalGatewayDefaults = (value: unknown): StudioGatewaySettings | null => {
  if (!value || typeof value !== "object") return null;
  const raw = value as {
    url?: unknown;
    token?: unknown;
    tokenConfigured?: unknown;
    adapterType?: unknown;
    profiles?: unknown;
  };
  const url = typeof raw.url === "string" ? raw.url.trim() : "";
  if (!url) return null;
  // Accept both full settings ({ url, token }) and the sanitized public
  // form ({ url, tokenConfigured }) returned by /api/studio.  When only
  // tokenConfigured is present the actual token isn't available on the
  // client — leave it empty so the connection dialog can prompt if needed.
  const token = typeof raw.token === "string" ? raw.token.trim() : "";
  const adapterType =
    raw.adapterType === "demo" ||
    raw.adapterType === "hermes" ||
    raw.adapterType === "openclaw" ||
    raw.adapterType === "local" ||
    raw.adapterType === "office3d" ||
    raw.adapterType === "custom"
      ? raw.adapterType
      : "openclaw";
  const profiles = normalizeGatewayProfilesPublic(raw.profiles);
  return { url, token, adapterType, ...(profiles ? { profiles } : {}) };
};

const normalizeGatewayProfilePublic = (
  value: unknown
): { url: string; token: string } | null => {
  if (!value || typeof value !== "object") return null;
  const raw = value as { url?: unknown };
  const url = typeof raw.url === "string" ? raw.url.trim() : "";
  if (!url) return null;
  return { url, token: "" };
};

const normalizeGatewayProfilesPublic = (
  value: unknown
): Partial<Record<StudioGatewayAdapterType, { url: string; token: string }>> | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Partial<Record<StudioGatewayAdapterType, StudioGatewayProfilePublic>>;
  const profiles: Partial<Record<StudioGatewayAdapterType, { url: string; token: string }>> = {};
  for (const adapterType of ["openclaw", "hermes", "demo", "local", "office3d", "custom"] as const) {
    const profile = normalizeGatewayProfilePublic(raw[adapterType]);
    if (profile) {
      profiles[adapterType] = profile;
    }
  }
  return Object.keys(profiles).length > 0 ? profiles : undefined;
};

type StatusHandler = (status: GatewayStatus) => void;

type EventHandler = (event: EventFrame) => void;

export type GatewayGapInfo = { expected: number; received: number };

type GapHandler = (info: GatewayGapInfo) => void;

export type GatewayStatus = "disconnected" | "connecting" | "connected";

export type GatewayConnectOptions = {
  gatewayUrl: string;
  token?: string;
  authScopeKey?: string;
  clientName?: string;
  disableDeviceAuth?: boolean;
};

export { GatewayResponseError } from "@/lib/gateway/errors";
export type { GatewayErrorPayload } from "@/lib/gateway/errors";

export class GatewayClient {
  private client: GatewayBrowserClient | null = null;
  private statusHandlers = new Set<StatusHandler>();
  private eventHandlers = new Set<EventHandler>();
  private gapHandlers = new Set<GapHandler>();
  private status: GatewayStatus = "disconnected";
  private pendingConnect: Promise<void> | null = null;
  private resolveConnect: (() => void) | null = null;
  private rejectConnect: ((error: Error) => void) | null = null;
  private manualDisconnect = false;
  private lastHello: GatewayHelloOk | null = null;
  private _lastDisconnectCode: number | null = null;

  onStatus(handler: StatusHandler) {
    this.statusHandlers.add(handler);
    handler(this.status);
    return () => {
      this.statusHandlers.delete(handler);
    };
  }

  onEvent(handler: EventHandler) {
    this.eventHandlers.add(handler);
    return () => {
      this.eventHandlers.delete(handler);
    };
  }

  onGap(handler: GapHandler) {
    this.gapHandlers.add(handler);
    return () => {
      this.gapHandlers.delete(handler);
    };
  }

  async connect(options: GatewayConnectOptions) {
    if (!options.gatewayUrl.trim()) {
      throw new Error(t("libGateway.urlRequired"));
    }
    if (this.client) {
      throw new Error(t("libGateway.alreadyConnecting"));
    }

    this.manualDisconnect = false;
    this.updateStatus("connecting");

    this.pendingConnect = new Promise<void>((resolve, reject) => {
      this.resolveConnect = resolve;
      this.rejectConnect = reject;
    });

    const nextClient = new GatewayBrowserClient({
      url: options.gatewayUrl,
      token: options.token,
      authScopeKey: options.authScopeKey,
      clientName: options.clientName,
      disableDeviceAuth: options.disableDeviceAuth,
      onHello: (hello) => {
        if (this.client !== nextClient) return;
        this.lastHello = hello;
        this.updateStatus("connected");
        this.resolveConnect?.();
        this.clearConnectPromise();
      },
      onEvent: (event) => {
        if (this.client !== nextClient) return;
        this.eventHandlers.forEach((handler) => handler(event));
      },
      onClose: ({ code, reason }) => {
        if (this.client !== nextClient) return;
        this._lastDisconnectCode = code;
        const connectFailed =
          code === CONNECT_FAILED_CLOSE_CODE ? parseConnectFailedCloseReason(reason) : null;
        const err = connectFailed
          ? new GatewayResponseError({
              code: connectFailed.code,
              message: connectFailed.message,
            })
          : new Error(t("libGateway.closed", { code, reason }));
        if (this.rejectConnect) {
          this.rejectConnect(err);
          this.clearConnectPromise();
        }
        if (!this.manualDisconnect) {
          nextClient.stop();
        }
        if (this.client === nextClient) {
          this.client = null;
        }
        this.updateStatus("disconnected");
        if (this.manualDisconnect) {
          console.info("Gateway disconnected.");
        }
      },
      onGap: ({ expected, received }) => {
        if (this.client !== nextClient) return;
        this.gapHandlers.forEach((handler) => handler({ expected, received }));
      },
    });

    this.client = nextClient;
    nextClient.start();

    let connectTimeoutId: number | null = null;
    try {
      await Promise.race([
        this.pendingConnect,
        new Promise<never>((_, reject) => {
          connectTimeoutId = window.setTimeout(() => {
            reject(
              new Error(
                t("libGateway.connectTimedOut")
              )
            );
          }, GATEWAY_CONNECT_TIMEOUT_MS);
        }),
      ]);
    } catch (err) {
      const activeClient = this.client;
      this.clearConnectPromise();
      activeClient?.stop();
      if (this.client === activeClient) {
        this.client = null;
      }
      this.updateStatus("disconnected");
      throw err;
    } finally {
      if (connectTimeoutId !== null) {
        window.clearTimeout(connectTimeoutId);
      }
    }
  }

  disconnect() {
    if (!this.client) {
      return;
    }

    this.manualDisconnect = true;
    this.client.stop();
    this.client = null;
    this.clearConnectPromise();
    this.updateStatus("disconnected");
    console.info("Gateway disconnected.");
  }

  async call<T = unknown>(method: string, params: unknown): Promise<T> {
    if (!method.trim()) {
      throw new Error(t("libGateway.methodRequired"));
    }
    if (!this.client || !this.client.connected) {
      throw new Error(t("libGateway.notConnected"));
    }

    const payload = await this.client.request<T>(method, params);
    return payload as T;
  }

  getLastHello() {
    return this.lastHello;
  }

  get lastDisconnectCode() {
    return this._lastDisconnectCode;
  }

  private updateStatus(status: GatewayStatus) {
    this.status = status;
    this.statusHandlers.forEach((handler) => handler(status));
  }

  private clearConnectPromise() {
    this.pendingConnect = null;
    this.resolveConnect = null;
    this.rejectConnect = null;
  }
}

export const isGatewayDisconnectLikeError = (err: unknown): boolean => {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  if (!msg) return false;
  // Our own messages are matched by phrase; the English ones come from
  // OpenClaw's own gateway client.
  if (
    matchesPhrase(err.message, "libGateway.notConnected") ||
    matchesPhrase(err.message, "libGateway.remoteNotConnected") ||
    msg.includes("gateway not connected") ||
    msg.includes("gateway is not connected") ||
    msg.includes("gateway client stopped")
  ) {
    return true;
  }

  const match =
    msg.match(/gateway closed \((\d+)\)/) ?? msg.match(/шлюз закрыл соединение \((\d+)\)/);
  if (!match) return false;
  const code = Number(match[1]);
  return Number.isFinite(code) && code === 1012;
};

const WEBCHAT_SESSION_MUTATION_BLOCKED_RE = /webchat clients cannot (patch|delete) sessions/i;
const WEBCHAT_SESSION_MUTATION_HINT_RE = /use chat\.send for session-scoped updates/i;

export const isWebchatSessionMutationBlockedError = (error: unknown): boolean => {
  if (!(error instanceof GatewayResponseError)) return false;
  if (error.code.trim().toUpperCase() !== "INVALID_REQUEST") return false;
  const message = error.message.trim();
  if (!message) return false;
  return (
    WEBCHAT_SESSION_MUTATION_BLOCKED_RE.test(message) &&
    WEBCHAT_SESSION_MUTATION_HINT_RE.test(message)
  );
};

type SessionSettingsPatchPayload = {
  key: string;
  model?: string | null;
  thinkingLevel?: string | null;
  execHost?: "sandbox" | "gateway" | "node" | null;
  execSecurity?: "deny" | "allowlist" | "full" | null;
  execAsk?: "off" | "on-miss" | "always" | null;
};

export type GatewaySessionsPatchResult = {
  ok: true;
  key: string;
  entry?: {
    thinkingLevel?: string;
  };
  resolved?: {
    modelProvider?: string;
    model?: string;
  };
};

export type SyncGatewaySessionSettingsParams = {
  client: GatewayClient;
  sessionKey: string;
  model?: string | null;
  thinkingLevel?: string | null;
  execHost?: "sandbox" | "gateway" | "node" | null;
  execSecurity?: "deny" | "allowlist" | "full" | null;
  execAsk?: "off" | "on-miss" | "always" | null;
};

export const syncGatewaySessionSettings = async ({
  client,
  sessionKey,
  model,
  thinkingLevel,
  execHost,
  execSecurity,
  execAsk,
}: SyncGatewaySessionSettingsParams) => {
  const key = sessionKey.trim();
  if (!key) {
    throw new Error(t("libGateway.sessionKeyRequired"));
  }
  const includeModel = model !== undefined;
  const includeThinkingLevel = thinkingLevel !== undefined;
  const includeExecHost = execHost !== undefined;
  const includeExecSecurity = execSecurity !== undefined;
  const includeExecAsk = execAsk !== undefined;
  if (
    !includeModel &&
    !includeThinkingLevel &&
    !includeExecHost &&
    !includeExecSecurity &&
    !includeExecAsk
  ) {
    throw new Error(t("libGateway.sessionSettingRequired"));
  }
  const payload: SessionSettingsPatchPayload = { key };
  if (includeModel) {
    payload.model = model ?? null;
  }
  if (includeThinkingLevel) {
    payload.thinkingLevel = thinkingLevel ?? null;
  }
  if (includeExecHost) {
    payload.execHost = execHost ?? null;
  }
  if (includeExecSecurity) {
    payload.execSecurity = execSecurity ?? null;
  }
  if (includeExecAsk) {
    payload.execAsk = execAsk ?? null;
  }
  return await client.call<GatewaySessionsPatchResult>("sessions.patch", payload);
};

const doctorFixHint =
  t("libGateway.hintDoctorFix");

const protocolMismatchHint =
  t("libGateway.hintProtocolMismatch");

const tailscaleGatewayHint =
  t("libGateway.hintTailscale");

const pairingRequiredHint =
  t("libGateway.hintPairingRequired");

const requiresDeviceIdentityHint =
  t("libGateway.hintDeviceIdentity");

const isGatewayProtocolMismatchError = (error: GatewayResponseError) => {
  if (error.code.trim().toUpperCase() !== "INVALID_REQUEST") return false;
  // The gateway may provide a structured details.code alongside the
  // generic INVALID_REQUEST. Known non-protocol rejection codes must
  // not surface the "possible protocol mismatch" hint, since it
  // misleads operators whose real problem is origin allowlist, missing
  // device identity, or upstream policy.
  const details = error.details;
  if (details && typeof details === "object") {
    const code = (details as { code?: unknown }).code;
    if (typeof code === "string") {
      const NON_PROTOCOL_DETAIL_CODES = new Set([
        "CONTROL_UI_ORIGIN_NOT_ALLOWED",
        "CONTROL_UI_DEVICE_IDENTITY_REQUIRED",
        "UPSTREAM_NOT_ALLOWED",
      ]);
      if (NON_PROTOCOL_DETAIL_CODES.has(code)) return false;
    }
  }
  const message = error.message.trim();
  if (!message) return false;
  return /minProtocol|maxProtocol/i.test(message);
};

const formatGatewayError = (error: unknown) => {
  if (error instanceof GatewayResponseError) {
    if (isGatewayProtocolMismatchError(error)) {
      return t("libGateway.errorWithHint", { code: error.code, message: error.message, hint: protocolMismatchHint });
    }
    if (error.code === "INVALID_REQUEST" && /invalid config/i.test(error.message)) {
      return t("libGateway.errorWithHint", { code: error.code, message: error.message, hint: doctorFixHint });
    }
    if (error.code === "studio.upstream_timeout") {
      return t("libGateway.errorWithHintNoPeriod", { code: error.code, message: error.message, hint: tailscaleGatewayHint });
    }
    if (error.code === "studio.upstream_rejected") {
      const lower = error.message.toLowerCase();
      if (lower.includes("pairing required")) {
        return t("libGateway.errorWithHint", { code: error.code, message: error.message, hint: pairingRequiredHint });
      }
      if (lower.includes("device identity")) {
        return t("libGateway.errorWithHint", { code: error.code, message: error.message, hint: requiresDeviceIdentityHint });
      }
    }
    return t("libGateway.error", { code: error.code, message: error.message });
  }
  if (error instanceof Error) {
    if (
      matchesPhrase(error.message, "libGateway.connectTimedOut") ||
      /timed out connecting to the gateway/i.test(error.message)
    ) {
      // A local timeout carries no information about why the upstream did
      // not respond. Suggest the directions the operator can actually check,
      // without biasing toward a protocol mismatch — that is only one of
      // several possible root causes (network, origin allowlist, upstream
      // policy, credentials, nginx idle timeout, ...).
      return t("libGateway.connectTimeoutHint", { message: error.message });
    }
    return error.message;
  }
  return t("libGateway.unknownError");
};

export type GatewayConnectionState = {
  client: GatewayClient;
  status: GatewayStatus;
  gatewayUrl: string;
  token: string;
  selectedAdapterType: StudioGatewayAdapterType;
  detectedAdapterType: StudioGatewayAdapterType | null;
  activeAdapterType: StudioGatewayAdapterType;
  adapterProfiles: Partial<Record<StudioGatewayAdapterType, { url: string; token: string }>>;
  localGatewayDefaults: StudioGatewaySettings | null;
  error: string | null;
  /** The connection dropped and the office is retrying on its own. */
  reconnecting: boolean;
  /**
   * A retry failed for a reason retrying cannot fix (wrong token, refused
   * pairing, missing address): the loop stopped and the person must act.
   */
  reconnectBlocked: boolean;
  connectPromptReady: boolean;
  shouldPromptForConnect: boolean;
  connect: () => Promise<void>;
  disconnect: () => void;
  useLocalGatewayDefaults: () => void;
  setGatewayUrl: (value: string) => void;
  setToken: (value: string) => void;
  setSelectedAdapterType: (value: StudioGatewayAdapterType) => void;
  clearError: () => void;
};

type StudioSettingsCoordinatorLike = {
  loadSettings: (
    options?: StudioSettingsLoadOptions,
  ) => Promise<StudioSettings | StudioSettingsPublic | null>;
  loadSettingsEnvelope?: (
    options?: StudioSettingsLoadOptions,
  ) => Promise<StudioSettingsResponse>;
  schedulePatch: (patch: StudioSettingsPatch, debounceMs?: number) => void;
  flushPending: () => Promise<void>;
};

export const useGatewayConnection = (
  settingsCoordinator: StudioSettingsCoordinatorLike
): GatewayConnectionState => {
  const [client] = useState(() => new GatewayClient());
  const didAutoConnect = useRef(false);
  const hasConnectedOnceRef = useRef(false);
  const loadedGatewaySettings = useRef<{
    gatewayUrl: string;
    token: string;
    adapterType: StudioGatewayAdapterType;
    profiles?: Partial<Record<StudioGatewayAdapterType, { url: string; token: string }>>;
    hasLastKnownGood: boolean;
  } | null>(null);
  // Retries after a lost connection, forever while the page is open, with
  // backoff and jitter (reconnectPolicy.ts).
  const runReconnectRef = useRef<() => void>(() => {});
  const [reconnectScheduler] = useState(
    () =>
      new ReconnectScheduler({
        run: () => runReconnectRef.current(),
        onScheduled: ({ attempt, delayMs }) =>
          gatewayDebugLog("reconnect-scheduled", { attempt, delayMs }),
      })
  );
  const connectInFlightRef = useRef(false);
  const previousStatusRef = useRef<GatewayStatus>("disconnected");
  const selectedAdapterTypeRef = useRef<StudioGatewayAdapterType>("openclaw");
  const [reconnecting, setReconnecting] = useState(false);
  const [reconnectBlocked, setReconnectBlocked] = useState(false);
  const autoConnectTimerRef = useRef<number | null>(null);
  const wasManualDisconnectRef = useRef(false);

  const [gatewayUrl, setGatewayUrl] = useState(DEFAULT_UPSTREAM_GATEWAY_URL);
  const [token, setToken] = useState("");
  const [selectedAdapterType, setSelectedAdapterTypeState] =
    useState<StudioGatewayAdapterType>("openclaw");
  const [adapterProfiles, setAdapterProfiles] = useState<
    Partial<Record<StudioGatewayAdapterType, { url: string; token: string }>>
  >({});
  const [detectedAdapterType, setDetectedAdapterType] =
    useState<StudioGatewayAdapterType | null>(null);
  const [localGatewayDefaults, setLocalGatewayDefaults] = useState<StudioGatewaySettings | null>(
    null
  );
  const [status, setStatus] = useState<GatewayStatus>("disconnected");
  const [error, setError] = useState<string | null>(null);
  // The code of the last failed connect; kept for debugging in React devtools.
  const [, setConnectErrorCode] = useState<string | null>(null);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [hasLastKnownGoodState, setHasLastKnownGoodState] = useState(false);
  const lastScheduledGatewaySnapshotRef = useRef<string | null>(null);
  // The connect form is on screen while the saved settings are still loading.
  // Whatever the person types there in the meantime is newer than what the
  // load brings back, so the load must not put the saved value over it.
  const settingsLoadedRef = useRef(false);
  const editedBeforeLoadRef = useRef({ gatewayUrl: false, token: false });
  const setGatewayUrlFromUser = useCallback((value: string) => {
    if (!settingsLoadedRef.current) editedBeforeLoadRef.current.gatewayUrl = true;
    setGatewayUrl(value);
  }, []);
  const setTokenFromUser = useCallback((value: string) => {
    if (!settingsLoadedRef.current) editedBeforeLoadRef.current.token = true;
    setToken(value);
  }, []);
  const setSelectedAdapterType = useCallback(
    (value: StudioGatewayAdapterType) => {
      setSelectedAdapterTypeState(value);
      const profile =
        adapterProfiles[value] ?? resolveDefaultStudioGatewayProfile(value, localGatewayDefaults);
      setGatewayUrl(profile.url ?? "");
      // Prefer the token from the initial private settings load when the in-memory
      // profile has an empty token (e.g. the profile was populated from the sanitized
      // public API response which strips real token values).
      const loadedToken = loadedGatewaySettings.current?.profiles?.[value]?.token ?? "";
      setToken(profile.token || loadedToken);
      const loaded = loadedGatewaySettings.current;
      const nextHasLastKnownGood = Boolean(
        (loaded?.adapterType === value && loaded.hasLastKnownGood) ||
          loaded?.profiles?.[value]?.url?.trim()
      );
      setHasLastKnownGoodState(nextHasLastKnownGood);
      setError(null);
      setConnectErrorCode(null);
    },
    [adapterProfiles, localGatewayDefaults]
  );

  useEffect(() => {
    let cancelled = false;
    const loadSettings = async () => {
      try {
        const envelope =
          typeof settingsCoordinator.loadSettingsEnvelope === "function"
            ? await settingsCoordinator.loadSettingsEnvelope({ force: true })
            : {
                settings: await settingsCoordinator.loadSettings({ force: true }),
                localGatewayDefaults: null,
                gatewayPrivate: null,
                localGatewayDefaultsPrivate: null,
              };
        const settings = envelope.settings ?? null;
        // gatewayPrivate is no longer sent by the server — upstream tokens must not
        // cross the browser API boundary. The Studio proxy injects tokens server-side.
        // We derive profiles from the sanitized public settings only.
        if (cancelled) return;
        const normalizedDefaults = normalizeLocalGatewayDefaults(
          envelope.localGatewayDefaults,
        );
        setLocalGatewayDefaults(normalizedDefaults);
        const gatewaySettings = settings?.gateway ?? null;
        const resolvedGatewayProfiles = resolveStudioGatewayProfiles({
          gateway: gatewaySettings as StudioGatewaySettings | null,
          localDefaults: normalizedDefaults,
        });
        const nextAdapterType = resolvedGatewayProfiles.selectedAdapterType;
        const selectedProfile =
          resolvedGatewayProfiles.activeProfile ??
          resolveDefaultStudioGatewayProfile(nextAdapterType, normalizedDefaults);
        const nextGatewayUrl = selectedProfile.url ?? "";
        const nextToken = selectedProfile.token ?? "";
        // Patch Hermes Phase 2: allow auto-connect for auto-managed adapters
        // (hermes/openclaw/demo) when a persisted URL exists, even if
        // gateway.lastKnownGood.adapterType doesn't match the currently
        // selected adapter. Without this, switching to Hermes never
        // auto-connects because lastKnownGood is still "openclaw".
        const hasPersistedProfileForSelected =
          Boolean(resolvedGatewayProfiles.lastKnownGoodForSelected?.url) ||
          (isAutoManagedAdapter(nextAdapterType) && nextGatewayUrl.trim().length > 0);
        loadedGatewaySettings.current = {
          gatewayUrl: nextGatewayUrl.trim(),
          token: nextToken,
          adapterType: nextAdapterType,
          profiles: resolvedGatewayProfiles.profiles,
          hasLastKnownGood: hasPersistedProfileForSelected,
        };
        if (!editedBeforeLoadRef.current.gatewayUrl) setGatewayUrl(nextGatewayUrl);
        if (!editedBeforeLoadRef.current.token) setToken(nextToken);
        setSelectedAdapterTypeState(nextAdapterType);
        setAdapterProfiles(resolvedGatewayProfiles.profiles);
        setHasLastKnownGoodState(hasPersistedProfileForSelected);
      } catch (err) {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : t("libGateway.settingsLoadFailed");
          setError(message);
        }
      } finally {
        if (!cancelled) {
          if (!loadedGatewaySettings.current) {
            loadedGatewaySettings.current = {
              gatewayUrl: DEFAULT_UPSTREAM_GATEWAY_URL.trim(),
              token: "",
              adapterType: "openclaw",
              profiles: undefined,
              hasLastKnownGood: false,
            };
          }
          settingsLoadedRef.current = true;
          setSettingsLoaded(true);
        }
      }
    };
    void loadSettings();
    return () => {
      cancelled = true;
    };
  }, [settingsCoordinator]);

  useEffect(() => {
    selectedAdapterTypeRef.current = selectedAdapterType;
  }, [selectedAdapterType]);

  // Retrying makes sense only for the backends the office manages itself, and
  // only once there is a known-good target: a connection that worked, or the
  // saved one the office connected to on its own.
  const canAutoReconnect = useCallback(
    () =>
      isAutoManagedAdapter(selectedAdapterTypeRef.current) &&
      !wasManualDisconnectRef.current &&
      (hasConnectedOnceRef.current || didAutoConnect.current),
    []
  );

  useEffect(() => {
    return client.onStatus((nextStatus) => {
      gatewayDebugLog("status", { nextStatus });
      const previousStatus = previousStatusRef.current;
      previousStatusRef.current = nextStatus;
      setStatus(nextStatus);
      // A live connection dropped (the gateway stopped, the proxy closed us,
      // the heartbeat found the socket dead): start the retry loop.
      if (
        previousStatus === "connected" &&
        nextStatus === "disconnected" &&
        !wasManualDisconnectRef.current &&
        canAutoReconnect()
      ) {
        setReconnecting(true);
        reconnectScheduler.schedule(client.lastDisconnectCode);
      }
      if (nextStatus !== "connecting") {
        setError(null);
        if (nextStatus === "connected") {
          setConnectErrorCode(null);
        } else {
          setDetectedAdapterType(null);
        }
      }
    });
  }, [canAutoReconnect, client, reconnectScheduler]);

  useEffect(() => {
    return () => {
      if (autoConnectTimerRef.current) {
        clearTimeout(autoConnectTimerRef.current);
        autoConnectTimerRef.current = null;
      }
      reconnectScheduler.cancel();
      client.disconnect();
    };
  }, [client, reconnectScheduler]);

  // "user": the connect button or the first automatic connect.
  // "auto": one retry of the reconnect loop.
  const runConnect = useCallback(async (mode: "user" | "auto") => {
    if (autoConnectTimerRef.current) {
      clearTimeout(autoConnectTimerRef.current);
      autoConnectTimerRef.current = null;
    }
    if (mode === "auto") {
      reconnectScheduler.cancel();
      // An attempt is already on its way; it reschedules if it fails.
      if (connectInFlightRef.current) return;
    } else {
      reconnectScheduler.reset();
      setReconnecting(false);
      // A retry keeps the reason on screen until it succeeds, so the connect
      // form does not blink with every attempt.
      setError(null);
      setConnectErrorCode(null);
      wasManualDisconnectRef.current = false;
    }
    setReconnectBlocked(false);
    gatewayDebugLog("connect:start", {
      mode,
      selectedAdapterType,
      gatewayUrl,
      hasToken: Boolean(token),
    });
    if (
      selectedAdapterType === "custom" ||
      selectedAdapterType === "local" ||
      selectedAdapterType === "office3d"
    ) {
      setStatus("connecting");
      try {
        await settingsCoordinator.flushPending();
        await probeCustomRuntime(gatewayUrl);
        setDetectedAdapterType(selectedAdapterType);
        setStatus("connected");
        setConnectErrorCode(null);
        gatewayDebugLog("connect:runtime-success", {
          selectedAdapterType,
          gatewayUrl,
        });
      } catch (err) {
        setStatus("disconnected");
        setDetectedAdapterType(null);
        setConnectErrorCode("studio.custom_runtime_probe_failed");
        setError(formatGatewayError(err));
        gatewayDebugLog("connect:runtime-failed", {
          selectedAdapterType,
          message: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }
    connectInFlightRef.current = true;
    try {
      await settingsCoordinator.flushPending();
      const maxAttempts =
        mode === "auto"
          ? 1
          : resolveInitialGatewayConnectAttemptCount(
              selectedAdapterType,
              hasConnectedOnceRef.current
            );
      let lastError: unknown = null;
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        try {
          await client.connect({
            gatewayUrl: resolveStudioProxyGatewayUrl(),
            token,
            authScopeKey: gatewayUrl,
            clientName: resolveGatewayClientName(selectedAdapterType, gatewayUrl),
            disableDeviceAuth: selectedAdapterType !== "openclaw",
          });
          lastError = null;
          break;
        } catch (err) {
          lastError = err;
          gatewayDebugLog("connect:attempt-failed", {
            selectedAdapterType,
            attempt: attempt + 1,
            maxAttempts,
            message: err instanceof Error ? err.message : String(err),
          });
          if (attempt + 1 >= maxAttempts) {
            throw err;
          }
          client.disconnect();
          await new Promise<void>((resolve) => {
            window.setTimeout(resolve, INITIAL_CONNECT_RETRY_DELAY_MS);
          });
        }
      }
      if (lastError) {
        throw lastError;
      }
      await ensureGatewayReloadModeHotForLocalStudio({
        client,
        upstreamGatewayUrl: gatewayUrl,
      });
      const hello = client.getLastHello();
      const nextDetectedAdapterType =
        hello?.adapterType === "demo" ||
        hello?.adapterType === "hermes" ||
        hello?.adapterType === "openclaw" ||
        hello?.adapterType === "custom"
          ? hello.adapterType
          : "openclaw";
      setDetectedAdapterType(nextDetectedAdapterType);
      setHasLastKnownGoodState(nextDetectedAdapterType === selectedAdapterType);
      // Flush immediately (debounce=0) so lastKnownGood survives a quick refresh.
      settingsCoordinator.schedulePatch({
        gateway: {
          lastKnownGood: {
            url: gatewayUrl.trim(),
            token: token || undefined,
            adapterType: nextDetectedAdapterType,
          },
        },
      }, 0);
      // Connected. The backoff step itself is forgotten only once the
      // connection has held for a while (see below), so a gateway that
      // accepts and drops at once is not hammered.
      reconnectScheduler.cancel();
      setReconnecting(false);
      gatewayDebugLog("connect:success", {
        mode,
        selectedAdapterType,
        detectedAdapterType: nextDetectedAdapterType,
      });
    } catch (err) {
      const code = err instanceof GatewayResponseError ? err.code : null;
      const message = err instanceof Error ? err.message : String(err);
      const kind = classifyGatewayFailure({ code, message });
      gatewayDebugLog("connect:failed", { mode, selectedAdapterType, code, kind, message });
      if (kind === "transient" && canAutoReconnect()) {
        // The gateway is down or restarting: keep trying. While the office is
        // on screen the HUD says «Переподключение…»; before it ever connected
        // the connect form shows the reason meanwhile.
        if (!hasConnectedOnceRef.current) {
          setConnectErrorCode(code);
          setError(formatGatewayError(err));
        }
        setReconnecting(true);
        reconnectScheduler.schedule(client.lastDisconnectCode);
        return;
      }
      // A wrong token, a refused pairing, a missing address: retrying cannot
      // help, so stop and show it.
      reconnectScheduler.reset();
      setReconnecting(false);
      setReconnectBlocked(hasConnectedOnceRef.current);
      setConnectErrorCode(code);
      setError(formatGatewayError(err));
    } finally {
      connectInFlightRef.current = false;
    }
  }, [
    canAutoReconnect,
    client,
    gatewayUrl,
    reconnectScheduler,
    selectedAdapterType,
    settingsCoordinator,
    token,
  ]);

  const connect = useCallback(() => runConnect("user"), [runConnect]);

  useEffect(() => {
    runReconnectRef.current = () => {
      void runConnect("auto");
    };
  }, [runConnect]);

  // The network came back, or the tab is visible again: retry now rather than
  // waiting out the backoff.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const retryNow = () => {
      if (reconnectScheduler.kick()) gatewayDebugLog("reconnect-now");
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") retryNow();
    };
    window.addEventListener("online", retryNow);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("online", retryNow);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [reconnectScheduler]);

  useEffect(() => {
    if (didAutoConnect.current) return;
    if (!settingsLoaded) return;
    if (!hasLastKnownGoodState) return;
    if (!gatewayUrl.trim()) return;
    if (!isAutoManagedAdapter(selectedAdapterType)) return;
    didAutoConnect.current = true;
    const delayMs = resolveInitialGatewayAutoConnectDelayMs(selectedAdapterType);
    gatewayDebugLog("auto-connect", {
      selectedAdapterType,
      gatewayUrl,
      delayMs,
    });
    autoConnectTimerRef.current = window.setTimeout(() => {
      autoConnectTimerRef.current = null;
      void connect();
    }, delayMs);
    return () => {
      if (autoConnectTimerRef.current) {
        window.clearTimeout(autoConnectTimerRef.current);
        autoConnectTimerRef.current = null;
      }
    };
  }, [connect, gatewayUrl, hasLastKnownGoodState, selectedAdapterType, settingsLoaded]);

  // Reset retry count after the connection has been stable for a minimum
  // duration.  If the upstream drops the connection quickly (e.g. within a
  // few seconds), keeping the current attempt count lets exponential backoff
  // work properly instead of hammering the gateway every 2 seconds.
  useEffect(() => {
    if (status === "connected") {
      hasConnectedOnceRef.current = true;
      const stableTimer = setTimeout(() => {
        reconnectScheduler.reset();
      }, 10_000);
      return () => clearTimeout(stableTimer);
    }
  }, [reconnectScheduler, status]);

  useEffect(() => {
    if (!settingsLoaded) return;
    setAdapterProfiles((current) => {
      const existing = current[selectedAdapterType];
      // Never overwrite a stored token with an empty string — the Studio proxy
      // injects the real token server-side; an empty token in UI state means
      // "let the proxy handle it", not "clear the saved token".
      const nextToken = token || existing?.token || "";
      const nextProfile = { url: gatewayUrl.trim(), token: nextToken };
      if (
        existing &&
        existing.url === nextProfile.url &&
        existing.token === nextProfile.token
      ) {
        return current;
      }
      return {
        ...current,
        [selectedAdapterType]: nextProfile,
      };
    });
  }, [gatewayUrl, selectedAdapterType, settingsLoaded, token]);

  useEffect(() => {
    if (!settingsLoaded) return;
    const baseline = loadedGatewaySettings.current;
    if (!baseline) return;
    const nextGatewayUrl = gatewayUrl.trim();
    // Use undefined for the token in the patch when the in-memory token is empty so
    // that mergeGatewaySettings / mergeGatewayProfiles treats it as "leave unchanged"
    // rather than overwriting the persisted token with an empty string.
    const persistToken = token || undefined;
    const nextProfiles = {
      ...adapterProfiles,
      [selectedAdapterType]: {
        url: nextGatewayUrl,
        token: persistToken,
      },
    };
    const nextSnapshot = JSON.stringify({
      gatewayUrl: nextGatewayUrl,
      token,
      selectedAdapterType,
      profiles: nextProfiles,
    });
    if (lastScheduledGatewaySnapshotRef.current === nextSnapshot) {
      return;
    }
    if (
      nextGatewayUrl === baseline.gatewayUrl &&
      token === baseline.token &&
      selectedAdapterType === baseline.adapterType &&
      JSON.stringify(nextProfiles) === JSON.stringify(baseline.profiles ?? {})
    ) {
      lastScheduledGatewaySnapshotRef.current = nextSnapshot;
      return;
    }
    lastScheduledGatewaySnapshotRef.current = nextSnapshot;
    settingsCoordinator.schedulePatch(
      {
        gateway: {
          url: nextGatewayUrl,
          token: persistToken,
          adapterType: selectedAdapterType,
          profiles: nextProfiles,
        },
      },
      400
    );
    loadedGatewaySettings.current = {
      gatewayUrl: nextGatewayUrl,
      token,
      adapterType: selectedAdapterType,
      profiles: nextProfiles,
      hasLastKnownGood: baseline.hasLastKnownGood,
    };
  }, [adapterProfiles, gatewayUrl, selectedAdapterType, settingsCoordinator, settingsLoaded, token]);

  const useLocalGatewayDefaults = useCallback(() => {
    if (!localGatewayDefaults) {
      return;
    }
    setGatewayUrl(localGatewayDefaults.url ?? "");
    setToken(localGatewayDefaults.token ?? "");
    setAdapterProfiles((current) => ({
      ...current,
      [localGatewayDefaults.adapterType]: {
        url: localGatewayDefaults.url ?? "",
        token: localGatewayDefaults.token ?? "",
      },
    }));
    setSelectedAdapterTypeState(localGatewayDefaults.adapterType);
    setError(null);
    setConnectErrorCode(null);
  }, [localGatewayDefaults]);

  const disconnect = useCallback(() => {
    gatewayDebugLog("disconnect", { selectedAdapterType, status });
    setError(null);
    setConnectErrorCode(null);
    wasManualDisconnectRef.current = true;
    reconnectScheduler.reset();
    setReconnecting(false);
    setReconnectBlocked(false);
    setDetectedAdapterType(null);
    // Always close an active WebSocket connection regardless of selectedAdapterType.
    // selectedAdapterType may already reflect the *target* adapter when this runs
    // (e.g. switching from openclaw → local sets selectedAdapterType before disconnect
    // is called), so we guard on actual connection state instead.
    if (status === "connected" || status === "connecting") {
      client.disconnect();
      clearGatewayBrowserSessionStorage();
      return;
    }
    if (
      selectedAdapterType === "custom" ||
      selectedAdapterType === "local" ||
      selectedAdapterType === "office3d"
    ) {
      setStatus("disconnected");
      return;
    }
    client.disconnect();
    clearGatewayBrowserSessionStorage();
  }, [client, reconnectScheduler, selectedAdapterType, status]);

  const clearError = useCallback(() => {
    setError(null);
    setConnectErrorCode(null);
  }, []);

  const connectPromptReady = settingsLoaded;
  const activeAdapterType =
    status === "connected" ? detectedAdapterType ?? selectedAdapterType : selectedAdapterType;
  const shouldPromptForConnect =
    settingsLoaded &&
    status !== "connected" &&
    (selectedAdapterType === "custom" ||
      selectedAdapterType === "local" ||
      selectedAdapterType === "office3d" ||
      !hasLastKnownGoodState ||
      !(gatewayUrl ?? "").trim() ||
      (selectedAdapterType === "openclaw" && !(token ?? "").trim()) ||
      wasManualDisconnectRef.current ||
      Boolean(error));

  return {
    client,
    status,
    gatewayUrl,
    token,
    selectedAdapterType,
    detectedAdapterType,
    activeAdapterType,
    adapterProfiles,
    localGatewayDefaults,
    error,
    reconnecting: reconnecting && status !== "connected",
    reconnectBlocked: reconnectBlocked && status !== "connected",
    connectPromptReady,
    shouldPromptForConnect,
    connect,
    disconnect,
    useLocalGatewayDefaults,
    setGatewayUrl: setGatewayUrlFromUser,
    setToken: setTokenFromUser,
    setSelectedAdapterType,
    clearError,
  };
};
