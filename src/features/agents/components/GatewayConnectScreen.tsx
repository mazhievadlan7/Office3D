import { useMemo, useState } from "react";
import { Check, Copy, Eye, EyeOff } from "lucide-react";
import type { GatewayStatus } from "@/lib/gateway/GatewayClient";
import { t } from "@/lib/i18n";
import { adapterLabel } from "@/lib/i18n/labels";
import { isLocalGatewayUrl } from "@/lib/gateway/local-gateway";
import type { StudioGatewayAdapterType, StudioGatewaySettings } from "@/lib/studio/settings";
import { RunningAvatarLoader } from "@/features/agents/components/RunningAvatarLoader";

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
  const useDemoPreset = () => {
    onAdapterTypeChange("demo");
  };
  const useHermesPreset = () => {
    onAdapterTypeChange("hermes");
  };
  const useOpenClawPreset = () => {
    onAdapterTypeChange("openclaw");
  };
  const useCustomPreset = () => {
    onAdapterTypeChange("custom");
  };
  const useLocalPreset = () => {
    onAdapterTypeChange("local");
  };
  const useOffice3dPreset = () => {
    onAdapterTypeChange("office3d");
  };
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
  const statusDotClass =
    status === "connected"
      ? "ui-dot-status-connected"
      : status === "connecting"
        ? "ui-dot-status-connecting"
        : "ui-dot-status-disconnected";

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
      <div className="ui-command-surface flex items-center gap-2 rounded-md px-3 py-2">
        <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-[12px] text-[var(--command-fg)]">
          {localGatewayCommand}
        </code>
        <button
          type="button"
          className="ui-btn-icon ui-command-copy h-7 w-7 shrink-0"
          onClick={copyLocalCommand}
          aria-label={t("gateway.copyCommandLabel")}
          title={t("gateway.copyCommand")}
        >
          {copyStatus === "copied" ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
      </div>
      {copyStatus === "copied" ? (
        <p className="text-xs text-muted-foreground">{t("common.copied")}</p>
      ) : copyStatus === "failed" ? (
        <p className="ui-text-danger text-xs">{t("gateway.copyFailed")}</p>
      ) : (
        <p className="text-xs leading-snug text-muted-foreground">
          {t("gateway.sourceCheckoutHint", { command: localGatewayCommandPnpm })}
        </p>
      )}
    </div>
  );

  const remoteForm = (
    <div className="mt-2.5 flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-[11px] font-medium text-foreground/90">
        {t("gateway.upstreamUrl")}
        <input
          className="ui-input h-10 rounded-md px-4 font-sans text-sm text-foreground outline-none"
          type="text"
          value={gatewayUrl}
          onChange={(event) => onGatewayUrlChange(event.target.value)}
          placeholder="wss://your-gateway.example.com"
          spellCheck={false}
        />
      </label>

      <div className="space-y-0.5 text-xs text-muted-foreground">
        <p className="font-medium text-foreground">{t("gateway.tailscaleTitle")}</p>
        <p>
          {t("gateway.tailscaleUrl")}{" "}
          <span className="font-mono">wss://&lt;хост-вашего-tailnet&gt;</span>
        </p>
      </div>

      <label className="flex flex-col gap-1 text-[11px] font-medium text-foreground/90">
        {tokenOptional ? t("gateway.upstreamTokenOptional") : t("gateway.upstreamToken")}
        <div className="relative">
          <input
            className="ui-input h-10 w-full rounded-md px-4 pr-10 font-sans text-sm text-foreground outline-none"
            type={showToken ? "text" : "password"}
            value={token}
            onChange={(event) => onTokenChange(event.target.value)}
            placeholder={tokenOptional ? t("gateway.tokenPlaceholderOptional") : t("gateway.tokenPlaceholder")}
            spellCheck={false}
          />
          <button
            type="button"
            className="ui-btn-icon absolute inset-y-0 right-1 my-auto h-8 w-8 border-transparent bg-transparent text-muted-foreground hover:bg-transparent hover:text-foreground"
            aria-label={showToken ? t("gateway.hideToken") : t("gateway.showToken")}
            onClick={() => setShowToken((prev) => !prev)}
          >
            {showToken ? (
              <EyeOff className="h-4 w-4 transition-transform duration-150" />
            ) : (
              <Eye className="h-4 w-4 transition-transform duration-150" />
            )}
          </button>
        </div>
      </label>

      <button
        type="button"
        className="ui-btn-primary mt-1 h-11 w-full px-4 text-xs font-semibold tracking-[0.05em] disabled:cursor-not-allowed disabled:opacity-60"
        onClick={onConnect}
        disabled={connectDisabled || !gatewayUrl.trim()}
      >
        {connectLabel}
      </button>

      {status === "connecting" ? (
        <div className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <RunningAvatarLoader size={16} trackWidth={32} inline />
          {t("gateway.connecting")}
        </div>
      ) : null}
      {error ? <p className="ui-text-danger text-xs leading-snug">{error}</p> : null}
      {showApprovalHint && selectedAdapterType === "openclaw" ? (
        <div className="rounded-md border border-border bg-muted/40 px-3 py-3 text-xs text-muted-foreground">
          <p className="leading-snug">
            {t("gateway.approveHint")}
          </p>
          <code className="mt-2 block overflow-x-auto whitespace-nowrap rounded-md bg-[var(--command-bg)] px-2.5 py-2 font-mono text-[11px] text-[var(--command-fg)]">
            openclaw devices approve --latest
          </code>
        </div>
      ) : null}
    </div>
  );

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-[820px] flex-1 flex-col gap-5">
      <div className="ui-card px-4 py-2">
        <div className="flex items-center gap-2">
          {status === "connecting" ? (
            <RunningAvatarLoader size={18} trackWidth={36} inline />
          ) : (
            <span
              className={`h-2.5 w-2.5 ${statusDotClass}`}
            />
          )}
          <p className="text-sm font-semibold text-foreground">{statusCopy}</p>
        </div>
      </div>

      <div className="ui-card px-4 py-5 sm:px-6">
        <div>
          <p className="font-mono text-[10px] font-medium tracking-[0.06em] text-muted-foreground">
            {t("gateway.remoteTitle")}
          </p>
          <p className="mt-2 text-sm text-foreground/90">
            {t("gateway.chooseBackend")}
          </p>
          <p className="mt-2 font-mono text-[11px] text-muted-foreground">
            {t("gateway.selectedBackend", {
              selected: adapterLabel(selectedAdapterType),
              active: adapterLabel(activeAdapterType),
            })}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("gateway.backendsKeepOwnSettings")}
          </p>
          <p className="mt-2 text-xs leading-snug text-muted-foreground">
            {selectedAdapterHint}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              className="ui-btn-secondary px-3 py-1.5 text-[11px] font-semibold tracking-[0.05em]"
              onClick={useDemoPreset}
            >
              {t("gateway.backendDemo")}
            </button>
            <button
              type="button"
              className="ui-btn-secondary px-3 py-1.5 text-[11px] font-semibold tracking-[0.05em]"
              onClick={useHermesPreset}
            >
              {t("gateway.backendHermes")}
            </button>
            <button
              type="button"
              className="ui-btn-secondary px-3 py-1.5 text-[11px] font-semibold tracking-[0.05em]"
              onClick={useLocalPreset}
            >
              {t("gateway.backendLocal")}
            </button>
            <button
              type="button"
              className="ui-btn-secondary px-3 py-1.5 text-[11px] font-semibold tracking-[0.05em]"
              onClick={useOffice3dPreset}
            >
              {t("gateway.backendOffice3d")}
            </button>
            <button
              type="button"
              className="ui-btn-secondary px-3 py-1.5 text-[11px] font-semibold tracking-[0.05em]"
              onClick={useCustomPreset}
            >
              {t("gateway.backendCustom")}
            </button>
            <button
              type="button"
              className="ui-btn-secondary px-3 py-1.5 text-[11px] font-semibold tracking-[0.05em]"
              onClick={useOpenClawPreset}
            >
              {t("gateway.backendOpenClaw")}
            </button>
          </div>
        </div>
        {remoteForm}
      </div>

      <div className="ui-card px-4 py-4 sm:px-6 sm:py-5">
        <div className="space-y-1.5">
          <p className="font-mono text-[10px] font-semibold tracking-[0.06em] text-muted-foreground">
            {t("gateway.runLocallyTitle")}
          </p>
          <p className="text-sm text-foreground/90">
            {t("gateway.runLocallyLead")}
          </p>
        </div>
        <div className="mt-3 space-y-3">
          {commandField}
          <div className="rounded-md border border-border bg-muted/30 px-3 py-3">
            <p className="text-xs font-medium text-foreground">{t("gateway.tipDemoTitle")}</p>
            <p className="mt-1 text-xs leading-snug text-muted-foreground">
              {t("gateway.tipDemoBody", { command: localDemoCommand })}
            </p>
          </div>
          <div className="rounded-md border border-border bg-muted/30 px-3 py-3">
            <p className="text-xs font-medium text-foreground">{t("gateway.tipHermesTitle")}</p>
            <p className="mt-1 text-xs leading-snug text-muted-foreground">
              {t("gateway.tipHermesBody", {
                command: "npm run hermes-adapter",
                url: "ws://localhost:18789",
              })}
            </p>
          </div>
          <div className="rounded-md border border-border bg-muted/30 px-3 py-3">
            <p className="text-xs font-medium text-foreground">{t("gateway.tipRuntimeTitle")}</p>
            <p className="mt-1 text-xs leading-snug text-muted-foreground">
              {t("gateway.tipRuntimeBody")}
            </p>
          </div>
          <div className="rounded-md border border-border bg-muted/30 px-3 py-3">
            <p className="text-xs font-medium text-foreground">{t("gateway.tipRemoteTitle")}</p>
            <p className="mt-1 text-xs leading-snug text-muted-foreground">
              {t("gateway.tipRemoteBody", {
                host: "HOST=0.0.0.0",
                token: "STUDIO_ACCESS_TOKEN",
              })}
            </p>
          </div>
          {localGatewayDefaults ? (
            <div className="ui-input rounded-md px-3 py-3">
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  {t("gateway.localDefaultsToken", { path: "~/.openclaw/openclaw.json" })}
                </p>
                <p className="font-mono text-[11px] text-foreground">
                  {localGatewayDefaults.url}
                </p>
                <button
                  type="button"
                  className="ui-btn-secondary h-9 w-full px-3 text-xs font-semibold tracking-[0.05em]"
                  onClick={onUseLocalDefaults}
                >
                  {t("gateway.localDefaultsUse")}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
};
