import type { GatewayStatus } from "@/lib/gateway/GatewayClient";
import type { StudioGatewayAdapterType } from "@/lib/studio/settings";
import { X } from "lucide-react";
import { resolveGatewayStatusBadgeClass, resolveGatewayStatusLabel } from "./colorSemantics";
import { t } from "@/lib/i18n";
import { adapterLabel } from "@/lib/i18n/labels";

type ConnectionPanelProps = {
  gatewayUrl: string;
  token: string;
  selectedAdapterType: StudioGatewayAdapterType;
  activeAdapterType: StudioGatewayAdapterType;
  localGatewayUrl?: string | null;
  localGatewayToken?: string | null;
  status: GatewayStatus;
  error: string | null;
  onGatewayUrlChange: (value: string) => void;
  onTokenChange: (value: string) => void;
  onAdapterTypeChange: (value: StudioGatewayAdapterType) => void;
  onConnect: () => void;
  onDisconnect: () => void;
  onClose?: () => void;
};

export const ConnectionPanel = ({
  gatewayUrl,
  token,
  selectedAdapterType,
  activeAdapterType,
  localGatewayUrl = null,
  localGatewayToken = null,
  status,
  error,
  onGatewayUrlChange,
  onTokenChange,
  onAdapterTypeChange,
  onConnect,
  onDisconnect,
  onClose,
}: ConnectionPanelProps) => {
  const isConnected = status === "connected";
  const isConnecting = status === "connecting";
  const tokenOptional =
    selectedAdapterType === "hermes" ||
    selectedAdapterType === "demo" ||
    selectedAdapterType === "local" ||
    selectedAdapterType === "office3d" ||
    selectedAdapterType === "custom";
  const applyDemoPreset = () => {
    onAdapterTypeChange("demo");
  };
  const applyHermesPreset = () => {
    onAdapterTypeChange("hermes");
  };
  const applyCustomPreset = () => {
    onAdapterTypeChange("custom");
  };
  const applyLocalPreset = () => {
    onAdapterTypeChange("local");
  };
  const applyOffice3dPreset = () => {
    onAdapterTypeChange("office3d");
  };
  const applyOpenClawPreset = () => {
    onAdapterTypeChange("openclaw");
  };
  const selectedAdapterHint =
    selectedAdapterType === "openclaw"
      ? t("connection.hintOpenclaw")
      : selectedAdapterType === "hermes"
        ? t("connection.hintHermes")
        : selectedAdapterType === "demo"
          ? t("connection.hintDemo")
          : selectedAdapterType === "office3d"
            ? t("connection.hintOffice3d")
            : selectedAdapterType === "local"
              ? t("connection.hintLocal")
              : t("connection.hintCustom");

  return (
    <div className="fade-up-delay flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <span
            className={`ui-chip inline-flex items-center px-3 py-1 font-mono text-[10px] font-semibold tracking-[0.08em] ${resolveGatewayStatusBadgeClass(status)}`}
            data-status={status}
          >
            {resolveGatewayStatusLabel(status)}
          </span>
          <button
            className="ui-btn-secondary px-4 py-2 text-xs font-semibold tracking-[0.05em] text-foreground disabled:cursor-not-allowed disabled:opacity-60"
            type="button"
            onClick={isConnected ? onDisconnect : onConnect}
            disabled={isConnecting || !gatewayUrl.trim()}
          >
            {isConnected ? t("connection.disconnect") : t("connection.connect")}
          </button>
        </div>
        {onClose ? (
          <button
            className="ui-btn-ghost inline-flex items-center gap-1 px-3 py-2 text-xs font-semibold tracking-[0.05em] text-foreground"
            type="button"
            onClick={onClose}
            data-testid="gateway-connection-close"
            aria-label={t("connection.closePanel")}
          >
            <X className="h-3.5 w-3.5" />
            {t("common.close")}
          </button>
        ) : null}
      </div>
      <div className="grid gap-3 lg:grid-cols-[1.4fr_1fr]">
        <label className="flex flex-col gap-1 font-mono text-[10px] font-semibold tracking-[0.06em] text-muted-foreground">
          {t("connection.upstreamUrl")}
          <input
            className="ui-input h-10 rounded-md px-4 font-sans text-sm text-foreground outline-none"
            type="text"
            value={gatewayUrl}
            onChange={(event) => onGatewayUrlChange(event.target.value)}
            placeholder="ws://localhost:18789"
            spellCheck={false}
          />
        </label>
        <label className="flex flex-col gap-1 font-mono text-[10px] font-semibold tracking-[0.06em] text-muted-foreground">
          {tokenOptional ? t("connection.upstreamTokenOptional") : t("connection.upstreamToken")}
          <input
            className="ui-input h-10 rounded-md px-4 font-sans text-sm text-foreground outline-none"
            type="password"
            value={token}
            onChange={(event) => onTokenChange(event.target.value)}
            placeholder={tokenOptional ? t("settings.tokenOptional") : t("settings.gatewayToken")}
            spellCheck={false}
          />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        <span className="font-mono">{t("settings.selectedBackend", { name: adapterLabel(selectedAdapterType) })}</span>
        <span className="font-mono">{t("settings.activeBackend", { name: adapterLabel(activeAdapterType) })}</span>
        <span>{t("gateway.backendsKeepOwnSettings")}</span>
      </div>
      <div className="text-[11px] leading-snug text-muted-foreground">
        {selectedAdapterHint}
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          className="ui-btn-secondary px-3 py-1.5 text-[11px] font-semibold tracking-[0.05em]"
          type="button"
          onClick={applyDemoPreset}
        >
          {t("connection.backendDemo")}
        </button>
        <button
          className="ui-btn-secondary px-3 py-1.5 text-[11px] font-semibold tracking-[0.05em]"
          type="button"
          onClick={applyHermesPreset}
        >
          {t("connection.backendHermes")}
        </button>
        <button
          className="ui-btn-secondary px-3 py-1.5 text-[11px] font-semibold tracking-[0.05em]"
          type="button"
          onClick={applyLocalPreset}
        >
          {t("connection.backendLocal")}
        </button>
        <button
          className="ui-btn-secondary px-3 py-1.5 text-[11px] font-semibold tracking-[0.05em]"
          type="button"
          onClick={applyOffice3dPreset}
        >
          {t("connection.backendOffice3d")}
        </button>
        <button
          className="ui-btn-secondary px-3 py-1.5 text-[11px] font-semibold tracking-[0.05em]"
          type="button"
          onClick={applyCustomPreset}
        >
          {t("connection.backendCustom")}
        </button>
        <button
          className="ui-btn-secondary px-3 py-1.5 text-[11px] font-semibold tracking-[0.05em]"
          type="button"
          onClick={applyOpenClawPreset}
        >
          {t("connection.backendOpenclaw")}
        </button>
      </div>
      {error ? (
        <p className="ui-alert-danger rounded-md px-4 py-2 text-sm">
          {error}
        </p>
      ) : null}
    </div>
  );
};
