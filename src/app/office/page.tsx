import { Suspense } from "react";
import { HqAndroidLoader } from "@/features/agents/components/HqAndroidLoader";
import { AgentStoreProvider } from "@/features/agents/state/store";
import { OfficeScreen } from "@/features/office/screens/OfficeScreen";
import { t } from "@/lib/i18n";

const ENABLED_RE = /^(1|true|yes|on)$/i;

const readDebugFlag = (value: string | undefined): boolean => {
  const normalized = (value ?? "").trim();
  if (!normalized) return true;
  return ENABLED_RE.test(normalized);
};

function OfficeLoadingFallback() {
  return (
    <div
      className="flex h-full w-full items-center justify-center bg-background"
      aria-label={t("office.loading")}
      role="status"
    >
      <div className="flex flex-col items-center gap-3">
        <HqAndroidLoader
          size={168}
          label={t("office.loadingShort")}
          labelClassName="text-muted-foreground"
        />
      </div>
    </div>
  );
}

export default function OfficePage() {
  const showOpenClawConsole = readDebugFlag(process.env.DEBUG);

  return (
    <AgentStoreProvider>
      <Suspense fallback={<OfficeLoadingFallback />}>
        <OfficeScreen showOpenClawConsole={showOpenClawConsole} />
      </Suspense>
    </AgentStoreProvider>
  );
}
