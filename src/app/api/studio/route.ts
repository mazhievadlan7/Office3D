import { NextResponse } from "next/server";

import {
  sanitizeStudioGatewaySettings,
  sanitizeStudioSettings,
  type StudioSettingsPatch,
} from "@/lib/studio/settings";
import {
  applyStudioSettingsPatch,
  loadLocalGatewayDefaults,
  loadStudioSettings,
} from "@/lib/studio/settings-store";
import { t } from "@/lib/i18n";

export const runtime = "nodejs";

const isPatch = (value: unknown): value is StudioSettingsPatch =>
  Boolean(value && typeof value === "object");

export async function GET() {
  try {
    const settings = loadStudioSettings();
    const localGatewayDefaults = loadLocalGatewayDefaults();
    return NextResponse.json(
      {
        settings: sanitizeStudioSettings(settings),
        localGatewayDefaults: sanitizeStudioGatewaySettings(localGatewayDefaults),
        // gatewayPrivate and localGatewayDefaultsPrivate are intentionally omitted.
        // Upstream tokens must not cross the browser API boundary — the Studio proxy
        // (server/gateway-proxy.js) injects the server-side token into connect frames.
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : t("apiStudio.settingsLoadFailed");
    console.error(message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

const invalidSettingsResponse = () =>
  NextResponse.json({ error: t("apiStudio.invalidSettings") }, { status: 400 });

// A page reload / HMR that aborts the (large) PUT mid-flight leaves a truncated
// body. That is a client-side condition: answer 400 and log one short line.
const logUnreadableBody = (reason: string) => {
  console.warn(`[studio] ignoring settings save with an unreadable request body: ${reason}`);
};

export async function PUT(request: Request) {
  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch (err) {
    logUnreadableBody(err instanceof Error ? err.message : String(err));
    return invalidSettingsResponse();
  }
  if (!rawBody.trim()) {
    return invalidSettingsResponse();
  }
  let body: unknown;
  try {
    body = JSON.parse(rawBody) as unknown;
  } catch (err) {
    logUnreadableBody(err instanceof Error ? err.message : String(err));
    return invalidSettingsResponse();
  }
  try {
    if (!isPatch(body)) {
      return NextResponse.json({ error: t("apiStudio.invalidSettings") }, { status: 400 });
    }
    const settings = applyStudioSettingsPatch(body);
    return NextResponse.json(
      {
        settings: sanitizeStudioSettings(settings),
        localGatewayDefaults: sanitizeStudioGatewaySettings(loadLocalGatewayDefaults()),
        // gatewayPrivate intentionally omitted — see GET handler comment.
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : t("apiStudio.settingsSaveFailed");
    console.error(message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
