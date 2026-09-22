import { CustomRuntimeProvider } from "@/lib/runtime/custom/provider";
import type { GatewayClient } from "@/lib/gateway/GatewayClient";
import { DemoRuntimeProvider } from "@/lib/runtime/demo/provider";
import { HermesRuntimeProvider } from "@/lib/runtime/hermes/provider";
import { OpenClawRuntimeProvider } from "@/lib/runtime/openclaw/provider";
import type { RuntimeProvider } from "@/lib/runtime/types";
import type { StudioGatewayAdapterType } from "@/lib/studio/settings";
import { t } from "@/lib/i18n";

export const createRuntimeProvider = (
  providerId: RuntimeProvider["id"] | StudioGatewayAdapterType,
  client: GatewayClient,
  runtimeUrl: string
): RuntimeProvider => {
  switch (providerId) {
    case "local":
      return new CustomRuntimeProvider(client, runtimeUrl, {
        id: "local",
        label: t("libRuntime.localRuntimeName"),
        runtimeName: t("libRuntime.localRuntimeName"),
        routeProfile: "local",
      });
    case "office3d":
      return new CustomRuntimeProvider(client, runtimeUrl, {
        id: "office3d",
        label: t("libRuntime.office3dRuntimeName"),
        runtimeName: t("libRuntime.office3dRuntimeName"),
        routeProfile: "office3d",
      });
    case "custom":
      return new CustomRuntimeProvider(client, runtimeUrl, {
        id: "custom",
        label: t("libRuntime.customRuntimeName"),
        runtimeName: t("libRuntime.customRuntimeName"),
        routeProfile: "custom",
      });
    case "demo":
      return new DemoRuntimeProvider(client);
    case "hermes":
      return new HermesRuntimeProvider(client);
    case "openclaw":
    default:
      return new OpenClawRuntimeProvider(client);
  }
};
