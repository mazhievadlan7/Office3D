/**
 * ConnectStep — Gateway connection form within the onboarding wizard.
 *
 * Reuses the same fields as GatewayConnectScreen but in a more compact
 * layout suited for the wizard modal.
 */
import { useState } from "react";
import { CheckCircle2, Eye, EyeOff, Wifi, WifiOff } from "lucide-react";
import { RunningAvatarLoader } from "@/features/agents/components/RunningAvatarLoader";
import { t } from "@/lib/i18n";
import {
  HQ_BUTTON_PRIMARY,
  HQ_FIELD,
  HQ_ICON_BUTTON,
  HQ_INSET,
  HQ_LABEL,
} from "@/features/agents/components/hqFormClasses";

export type ConnectStepProps = {
  gatewayUrl: string;
  token: string;
  onGatewayUrlChange: (value: string) => void;
  onTokenChange: (value: string) => void;
  onConnect: () => void;
  connected: boolean;
  connecting: boolean;
  error: string | null;
};

export const ConnectStep = ({
  gatewayUrl,
  token,
  onGatewayUrlChange,
  onTokenChange,
  onConnect,
  connected,
  connecting,
  error,
}: ConnectStepProps) => {
  const [showToken, setShowToken] = useState(false);

  if (connected) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-8">
        <div className="flex h-12 w-12 items-center justify-center rounded-full border border-primary/40 bg-primary/15 shadow-[0_0_24px_rgba(255,26,26,0.3)]">
          <CheckCircle2 className="h-6 w-6 text-primary" />
        </div>
        <p className="text-sm font-semibold text-white">{t("onboarding.connected")}</p>
        <p className="text-xs text-white/65">
          {t("onboarding.connectedLead")}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className={`${HQ_INSET} flex items-center gap-2 px-3 py-2.5`}>
        <WifiOff className="h-4 w-4 text-primary/80" />
        <p className="text-xs text-white/65">{t("onboarding.notConnected")}</p>
      </div>

      <div className="space-y-3">
        <label className="flex flex-col gap-1.5">
          <span className={`${HQ_LABEL} text-[10px] font-semibold`}>
            {t("onboarding.gatewayUrl")}
          </span>
          <input
            className={`${HQ_FIELD} h-9 px-3 font-mono text-[13px]`}
            type="text"
            value={gatewayUrl}
            onChange={(e) => onGatewayUrlChange(e.target.value)}
            placeholder="ws://localhost:18789"
            spellCheck={false}
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className={`${HQ_LABEL} text-[10px] font-semibold`}>
            {t("onboarding.gatewayToken")}
          </span>
          <div className="relative">
            <input
              className={`${HQ_FIELD} h-9 w-full px-3 pr-9 font-mono text-[13px]`}
              type={showToken ? "text" : "password"}
              value={token}
              onChange={(e) => onTokenChange(e.target.value)}
              placeholder={t("onboarding.tokenPlaceholder")}
              spellCheck={false}
            />
            <button
              type="button"
              className={`${HQ_ICON_BUTTON} absolute inset-y-0 right-1 my-auto h-7 w-7`}
              onClick={() => setShowToken((prev) => !prev)}
              aria-label={showToken ? t("onboarding.hideToken") : t("onboarding.showToken")}
            >
              {showToken ? (
                <EyeOff className="h-3.5 w-3.5" />
              ) : (
                <Eye className="h-3.5 w-3.5" />
              )}
            </button>
          </div>
        </label>

        <button
          type="button"
          className={`${HQ_BUTTON_PRIMARY} h-9 w-full px-4 text-[10px]`}
          onClick={onConnect}
          disabled={connecting || !gatewayUrl.trim()}
        >
          {connecting ? (
            <>
              <RunningAvatarLoader size={16} trackWidth={32} inline />
              {t("onboarding.connecting")}
            </>
          ) : (
            <>
              <Wifi className="h-3.5 w-3.5" />
              {t("onboarding.connect")}
            </>
          )}
        </button>
      </div>

      {error ? (
        <p className="ui-alert-danger rounded-md px-3 py-2 text-xs">
          {error}
        </p>
      ) : null}

      <div className="space-y-1.5 text-[11px] text-white/45">
        <p>
          <strong className="text-white/70">{t("onboarding.hintLocal")}</strong> {t("onboarding.use")}{" "}
          <code className="text-white/65">ws://localhost:18789</code>
        </p>
        <p>
          <strong className="text-white/70">{t("onboarding.hintTailscale")}</strong> {t("onboarding.use")}{" "}
          <code className="text-white/65">wss://your-host.ts.net</code>
        </p>
        <p>
          <strong className="text-white/70">{t("onboarding.hintSsh")}</strong> {t("onboarding.hintSshLead")}
        </p>
      </div>
    </div>
  );
};
