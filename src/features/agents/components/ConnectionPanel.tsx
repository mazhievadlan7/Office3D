import type { GatewayStatus } from "@/lib/gateway/GatewayClient";
import type { StudioGatewayAdapterType } from "@/lib/studio/settings";
import { X } from "lucide-react";
import { resolveGatewayStatusBadgeClass, resolveGatewayStatusLabel } from "./colorSemantics";
import {
  HQ_BUTTON_DANGER,
  HQ_BUTTON_PRIMARY,
  HQ_FIELD,
  HQ_ICON_BUTTON,
  HQ_LABEL,
  hqOptionClass,
} from "./hqFormClasses";
import { t } from "@/lib/i18n";
import { adapterLabel } from "@/lib/i18n/labels";

type ConnectionPanelProps = {
  gatewayUrl: string;
  token: string;
  selectedAdapterType: StudioGatewayAdapterType;
  activeAdapterType: StudioGatewayAdapterType;
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
  const backendOptions: ReadonlyArray<readonly [StudioGatewayAdapterType, string]> = [
    ["demo", t("connection.backendDemo")],
    ["hermes", t("connection.backendHermes")],
    ["local", t("connection.backendLocal")],
    ["office3d", t("connection.backendOffice3d")],
    ["custom", t("connection.backendCustom")],
    ["openclaw", t("connection.backendOpenclaw")],
  ];
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
            className={`ui-chip inline-flex items-center px-3 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] ${resolveGatewayStatusBadgeClass(status)}`}
            data-status={status}
          >
            {resolveGatewayStatusLabel(status)}
          </span>
          <button
            className={`${isConnected ? HQ_BUTTON_DANGER : HQ_BUTTON_PRIMARY} px-4 py-2 text-[10px]`}
            type="button"
            onClick={isConnected ? onDisconnect : onConnect}
            disabled={isConnecting || !gatewayUrl.trim()}
          >
            {isConnected ? t("connection.disconnect") : t("connection.connect")}
          </button>
        </div>
        {onClose ? (
          <button
            className={`${HQ_ICON_BUTTON} gap-1 px-3 py-2 font-mono text-[10px] font-semibold uppercase tracking-[0.16em]`}
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
        <label className="flex flex-col gap-1.5">
          <span className={`${HQ_LABEL} text-[10px] font-semibold`}>{t("connection.upstreamUrl")}</span>
          <input
            className={`${HQ_FIELD} h-10 px-3.5 font-mono text-[13px]`}
            type="text"
            value={gatewayUrl}
            onChange={(event) => onGatewayUrlChange(event.target.value)}
            placeholder="ws://localhost:18789"
            spellCheck={false}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className={`${HQ_LABEL} text-[10px] font-semibold`}>
            {tokenOptional ? t("connection.upstreamTokenOptional") : t("connection.upstreamToken")}
          </span>
          <input
            className={`${HQ_FIELD} h-10 px-3.5 font-mono text-[13px]`}
            type="password"
            value={token}
            onChange={(event) => onTokenChange(event.target.value)}
            placeholder={tokenOptional ? t("settings.tokenOptional") : t("settings.gatewayToken")}
            spellCheck={false}
          />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-white/45">
        <span className="font-mono">{t("settings.selectedBackend", { name: adapterLabel(selectedAdapterType) })}</span>
        <span className="font-mono">{t("settings.activeBackend", { name: adapterLabel(activeAdapterType) })}</span>
        <span>{t("gateway.backendsKeepOwnSettings")}</span>
      </div>
      <p className="border-l-2 border-primary/70 bg-black/40 py-2 pl-3 pr-2 text-[11px] leading-snug text-white/70">
        {selectedAdapterHint}
      </p>
      <div className="flex flex-wrap gap-2">
        {backendOptions.map(([adapterType, label]) => {
          const selected = selectedAdapterType === adapterType;
          return (
            <button
              key={adapterType}
              className={`rounded-md border px-3 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] transition-colors ${hqOptionClass(selected)}`}
              type="button"
              aria-pressed={selected}
              onClick={() => onAdapterTypeChange(adapterType)}
            >
              {label}
            </button>
          );
        })}
      </div>
      {error ? (
        <p className="ui-alert-danger rounded-md px-4 py-2 text-sm">
          {error}
        </p>
      ) : null}
    </div>
  );
};
