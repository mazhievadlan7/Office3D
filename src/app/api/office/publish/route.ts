import { NextResponse } from "next/server";

import { listOfficeVersions, publishOfficeVersion } from "@/lib/office/store";
import { t } from "@/lib/i18n";

export const runtime = "nodejs";

const asString = (value: unknown) => (typeof value === "string" ? value.trim() : "");

export async function PUT(request: Request) {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const workspaceId = asString(body.workspaceId) || "default";
    const officeId = asString(body.officeId);
    const officeVersionId = asString(body.officeVersionId);
    const publishedBy = asString(body.publishedBy) || "studio";
    if (!workspaceId || !officeId) {
      return NextResponse.json({ error: t("apiOffice.publishIdsRequired") }, { status: 400 });
    }
    let selectedVersionId = officeVersionId;
    if (!selectedVersionId) {
      const versions = listOfficeVersions(workspaceId, officeId);
      selectedVersionId = versions[0]?.id ?? "";
    }
    if (!selectedVersionId) {
      return NextResponse.json({ error: t("apiOffice.noVersionToPublish") }, { status: 400 });
    }
    const published = publishOfficeVersion({
      workspaceId,
      officeId,
      officeVersionId: selectedVersionId,
      publishedBy,
    });
    return NextResponse.json({ published });
  } catch (error) {
    const message = error instanceof Error ? error.message : t("apiOffice.publishFailed");
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
