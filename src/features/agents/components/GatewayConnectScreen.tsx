import { useId, useMemo, useState } from "react";
import { Check, Copy, Eye, EyeOff } from "lucide-react";
import type { GatewayStatus } from "@/lib/gateway/GatewayClient";
import { t } from "@/lib/i18n";
import { adapterLabel } from "@/lib/i18n/labels";
import { isLocalGatewayUrl } from "@/lib/gateway/local-gateway";
import type { StudioGatewayAdapterType, StudioGatewaySettings } from "@/lib/studio/settings";
import { HqAndroidLoader } from "@/features/agents/components/HqAndroidLoader";
import {
  HQ_BUTTON_PRIMARY,
  HQ_BUTTON_SECONDARY,
  HQ_CARD,
  HQ_DOT_OFF,
  HQ_DOT_ON,
  HQ_FIELD,
  HQ_ICON_BUTTON,
  HQ_INSET,
  HQ_LABEL,
  hqOptionClass,
} from "@/features/agents/components/hqFormClasses";

type GatewayConnectScreenProps = {
  gatewayUrl: string;
  token: string;
  selectedAdapterType: StudioGatewayAdapterType;
  activeAdapterType: StudioGatewayAdapterType;
  localGatewayDefaults: StudioGatewaySettings | null;
  status: GatewayStatus;
  error: string | null;
  showApprovalHint: boolean;
  onGatewayUrlChange: (value: string) => void;
  onTokenChange: (value: string) => void;
  onAdapterTypeChange: (value: StudioGatewayAdapterType) => void;
  onUseLocalDefaults: () => void;
  onConnect: () => void;
};

const resolveLocalGatewayPort = (gatewayUrl: string): number => {
  try {
    const parsed = new URL(gatewayUrl);
    const port = Number(parsed.port);
    if (Number.isFinite(port) && port > 0) return port;
  } catch {}
  return 18789;
};

export const GatewayConnectScreen = ({
  gatewayUrl,
  token,
  selectedAdapterType,
  activeAdapterType,
  localGatewayDefaults,
  status,
  error,
  showApprovalHint,
  onGatewayUrlChange,
  onTokenChange,
  onAdapterTypeChange,
  onUseLocalDefaults,
  onConnect,
}: GatewayConnectScreenProps) => {
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");
  const [showToken, setShowToken] = useState(false);
  const chooseBackendId = useId();
  const tokenOptional =
    selectedAdapterType === "hermes" ||
    selectedAdapterType === "demo" ||
    selectedAdapterType === "local" ||
    selectedAdapterType === "office3d" ||
    selectedAdapterType === "custom";
  const isLocal = useMemo(() => isLocalGatewayUrl(gatewayUrl), [gatewayUrl]);
  const localPort = useMemo(() => resolveLocalGatewayPort(gatewayUrl), [gatewayUrl]);
  const localGatewayCommand = useMemo(
    () => `npx openclaw gateway run --bind loopback --port ${localPort} --verbose`,
    [localPort]
  );
  const localGatewayCommandPnpm = useMemo(
    () => `pnpm openclaw gateway run --bind loopback --port ${localPort} --verbose`,
    [localPort]
  );
  const localDemoCommand = useMemo(
    () => `npm run demo-gateway`,
    []
  );
  // In the order the office recommends them: look around first, then the
  // default backend, then the direct runtimes, OpenClaw last.
  const backendOptions: ReadonlyArray<readonly [StudioGatewayAdapterType, string]> = [
    ["demo", t("gateway.backendDemo")],
    ["hermes", t("gateway.backendHermes")],
    ["local", t("gateway.backendLocal")],
    ["office3d", t("gateway.backendOffice3d")],
    ["custom", t("gateway.backendCustom")],
    ["openclaw", t("gateway.backendOpenClaw")],
  ];
  const statusCopy = useMemo(() => {
    if (status === "connecting" && isLocal) {
      return t("gateway.detectedLocal", { port: localPort });
    }
    if (status === "connecting") {
      return t("gateway.connectingRemote");
    }
    if (isLocal) {
      return t("gateway.noLocalFound");
    }
    return t("gateway.notConnected");
  }, [isLocal, localPort, status]);
  const selectedAdapterHint = useMemo(() => {
    switch (selectedAdapterType) {
      case "openclaw":
        return t("gateway.hintOpenClaw");
      case "hermes":
        return t("gateway.hintHermes");
      case "demo":
        return t("gateway.hintDemo");
      case "local":
        return t("gateway.hintLocal");
      case "office3d":
        return t("gateway.hintOffice3d");
      case "custom":
      default:
        return t("gateway.hintCustom");
    }
  }, [selectedAdapterType]);
  const connectDisabled = status === "connecting";
  const connectLabel = connectDisabled ? t("gateway.connecting") : t("gateway.connect");
  const statusDotClass = status === "connected" ? HQ_DOT_ON : HQ_DOT_OFF;

  const copyLocalCommand = async () => {
    try {
      await navigator.clipboard.writeText(localGatewayCommand);
      setCopyStatus("copied");
      window.setTimeout(() => setCopyStatus("idle"), 1200);
    } catch {
      setCopyStatus("failed");
      window.setTimeout(() => setCopyStatus("idle"), 1800);
    }
  };

  const commandField = (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 rounded-md border border-primary/30 bg-black/70 px-3 py-2">
        <span aria-hidden className="font-mono text-[12px] text-primary">
          $
        </span>
        <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-[12px] text-white">
          {localGatewayCommand}
        </code>
        <button
          type="button"
          className={`${HQ_BUTTON_SECONDARY} h-7 w-7 shrink-0`}
          onClick={copyLocalCommand}
          aria-label={t("gateway.copyCommandLabel")}
          title={t("gateway.copyCommand")}
        >
          {copyStatus === "copied" ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
      </div>
      {copyStatus === "copied" ? (
        <p className="text-xs text-white/65">{t("common.copied")}</p>
      ) : copyStatus === "failed" ? (
        <p className="ui-text-danger text-xs">{t("gateway.copyFailed")}</p>
      ) : (
        <p className="text-[11px] leading-snug text-white/45">
          {t("gateway.sourceCheckoutHint", { command: localGatewayCommandPnpm })}
        </p>
      )}
    </div>
  );

  const remoteForm = (
    <div className="mt-4 flex flex-col gap-3">
      <label className="flex flex-col gap-1.5">
        <span className={`${HQ_LABEL} text-[10px]`}>{t("gateway.upstreamUrl")}</span>
        <input
          className={`${HQ_FIELD} h-10 w-full px-3.5 font-mono text-[13px]`}
          type="text"
          value={gatewayUrl}
          onChange={(event) => onGatewayUrlChange(event.target.value)}
          placeholder="wss://your-gateway.example.com"
          spellCheck={false}
        />
      </label>

      <div className="space-y-0.5 text-[11px] leading-snug text-white/45">
        <p className="font-semibold text-white/80">{t("gateway.tailscaleTitle")}</p>
        <p>
          {t("gateway.tailscaleUrl")}{" "}
          <span className="font-mono text-white/70">wss://&lt;хост-вашего-tailnet&gt;</span>
        </p>
      </div>

      <label className="flex flex-col gap-1.5">
        <span className={`${HQ_LABEL} text-[10px]`}>
          {tokenOptional ? t("gateway.upstreamTokenOptional") : t("gateway.upstreamToken")}
        </span>
        <div className="relative">
          <input
            className={`${HQ_FIELD} h-10 w-full px-3.5 pr-11 font-mono text-[13px]`}
            type={showToken ? "text" : "password"}
            value={token}
            onChange={(event) => onTokenChange(event.target.value)}
            placeholder={tokenOptional ? t("gateway.tokenPlaceholderOptional") : t("gateway.tokenPlaceholder")}
            spellCheck={false}
          />
          <button
            type="button"
            className={`${HQ_ICON_BUTTON} absolute inset-y-0 right-1 my-auto h-8 w-8`}
            aria-label={showToken ? t("gateway.hideToken") : t("gateway.showToken")}
            onClick={() => setShowToken((prev) => !prev)}
          >
            {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
      </label>

      <button
        type="button"
        className={`${HQ_BUTTON_PRIMARY} mt-1 h-11 w-full px-4 text-[11px]`}
        onClick={onConnect}
        disabled={connectDisabled || !gatewayUrl.trim()}
      >
        {connectLabel}
      </button>

      {status === "connecting" ? (
        <div className="inline-flex items-center gap-1.5 text-xs text-white/65">
          <HqAndroidLoader size={16} inline />
          {t("gateway.connecting")}
        </div>
      ) : null}
      {error ? <p className="ui-alert-danger rounded-md px-3 py-2 text-xs leading-snug">{error}</p> : null}
      {showApprovalHint && selectedAdapterType === "openclaw" ? (
        <div className={`${HQ_INSET} px-3 py-3 text-xs text-white/65`}>
          <p className="leading-snug">{t("gateway.approveHint")}</p>
          <code className="mt-2 block overflow-x-auto whitespace-nowrap rounded-md border border-primary/30 bg-black/70 px-2.5 py-2 font-mono text-[11px] text-white">
            openclaw devices approve --latest
          </code>
        </div>
      ) : null}
    </div>
  );

  const tip = (title: string, body: string) => (
    <div className={`${HQ_INSET} px-3 py-3`}>
      <p className="flex items-center gap-2 text-xs font-semibold text-white">
        <span aria-hidden className="h-3 w-0.5 shrink-0 rounded-full bg-primary" />
        {title}
      </p>
      <p className="mt-1 text-[11px] leading-snug text-white/55">{body}</p>
    </div>
  );

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-[820px] flex-1 flex-col gap-3">
      <div className={`${HQ_CARD} flex items-center gap-2.5 px-4 py-2.5`}>
        {status === "connecting" ? (
          <HqAndroidLoader size={18} inline />
        ) : (
          <span className={`h-2 w-2 shrink-0 rounded-full ${statusDotClass}`} />
        )}
        <p className="text-sm font-semibold text-white">{statusCopy}</p>
      </div>

      <div className={`${HQ_CARD} px-4 py-5 sm:px-6`}>
        <p className={`${HQ_LABEL} text-[10px] font-semibold`}>{t("gateway.remoteTitle")}</p>
        <p id={chooseBackendId} className="mt-2 text-sm text-white">
          {t("gateway.chooseBackend")}
        </p>
        <div role="group" aria-labelledby={chooseBackendId} className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {backendOptions.map(([adapterType, label]) => {
            const selected = selectedAdapterType === adapterType;
            return (
              <button
                key={adapterType}
                type="button"
                aria-pressed={selected}
                className={`rounded-md border px-3 py-2 text-left font-mono text-[10px] font-semibold uppercase tracking-[0.14em] transition-colors ${hqOptionClass(selected)}`}
                onClick={() => onAdapterTypeChange(adapterType)}
              >
                {label}
              </button>
            );
          })}
        </div>
        <p className="mt-3 border-l-2 border-primary/70 bg-black/40 py-2 pl-3 pr-2 text-xs leading-snug text-white/70">
          {selectedAdapterHint}
        </p>
        <p className="mt-2 font-mono text-[10px] tracking-[0.04em] text-white/45">
          {t("gateway.selectedBackend", {
            selected: adapterLabel(selectedAdapterType),
            active: adapterLabel(activeAdapterType),
          })}
        </p>
        <p className="mt-0.5 text-[11px] text-white/45">{t("gateway.backendsKeepOwnSettings")}</p>
        {remoteForm}
      </div>

      <div className={`${HQ_CARD} px-4 py-4 sm:px-6 sm:py-5`}>
        <div className="space-y-1.5">
          <p className={`${HQ_LABEL} text-[10px] font-semibold`}>{t("gateway.runLocallyTitle")}</p>
          <p className="text-sm text-white">{t("gateway.runLocallyLead")}</p>
        </div>
        <div className="mt-3 space-y-3">
          {commandField}
          <div className="grid gap-2 sm:grid-cols-2">
            {tip(t("gateway.tipDemoTitle"), t("gateway.tipDemoBody", { command: localDemoCommand }))}
            {tip(
              t("gateway.tipHermesTitle"),
              t("gateway.tipHermesBody", {
                command: "docker compose up -d",
                local: "npm run hermes-local",
              })
            )}
            {tip(t("gateway.tipRuntimeTitle"), t("gateway.tipRuntimeBody"))}
            {tip(
              t("gateway.tipRemoteTitle"),
              t("gateway.tipRemoteBody", {
                host: "HOST=0.0.0.0",
                token: "STUDIO_ACCESS_TOKEN",
              })
            )}
          </div>
          {localGatewayDefaults ? (
            <div className={`${HQ_INSET} space-y-2 px-3 py-3`}>
              <p className="text-xs text-white/65">
                {t("gateway.localDefaultsToken", { path: "~/.openclaw/openclaw.json" })}
              </p>
              <p className="font-mono text-[11px] text-white">{localGatewayDefaults.url}</p>
              <button
                type="button"
                className={`${HQ_BUTTON_SECONDARY} h-9 w-full px-3 text-[10px]`}
                onClick={onUseLocalDefaults}
              >
                {t("gateway.localDefaultsUse")}
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
};
