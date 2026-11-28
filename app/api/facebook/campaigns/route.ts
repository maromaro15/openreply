import { NextResponse, type NextRequest } from "next/server";
import { jsonError, requireWorkspace } from "@/lib/agency/http";
import {
  campaignInputSchema,
  createCampaign,
  listCampaigns,
  workspaceOwnsPage,
  workspaceOwnsProduct,
} from "@/lib/facebook/campaigns";

export const dynamic = "force-dynamic";

/** The active brand's campaigns with their counts. */
export async function GET(request: NextRequest) {
  const context = await requireWorkspace(request, "MEMBER");
  if (context instanceof Response) return context;
  return NextResponse.json({
    success: true,
    data: { role: context.role, campaigns: await listCampaigns(context.workspaceId) },
  });
}

export async function POST(request: NextRequest) {
  const context = await requireWorkspace(request, "ADMIN");
  if (context instanceof Response) return context;

  const parsed = campaignInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0]?.message ?? "Invalid campaign", issues: parsed.error.issues },
      { status: 400 }
    );
  }
  if (!(await workspaceOwnsPage(context.workspaceId, parsed.data.facebookPageId))) {
    return jsonError(400, "Choose a connected Page of this brand.");
  }
  if (!(await workspaceOwnsProduct(context.workspaceId, parsed.data.productId))) {
    return jsonError(400, "Choose a product of this brand.");
  }
  const campaign = await createCampaign(context.workspaceId, parsed.data);
  return NextResponse.json({ success: true, data: { campaign } }, { status: 201 });
}
