import { NextResponse, type NextRequest } from "next/server";
import { jsonError, requireWorkspace } from "@/lib/agency/http";
import {
  campaignInputSchema,
  deleteCampaign,
  getCampaign,
  setCampaignActive,
  updateCampaign,
  workspaceOwnsPage,
  workspaceOwnsProduct,
} from "@/lib/facebook/campaigns";

type RouteProps = { params: Promise<{ id: string }> };

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, { params }: RouteProps) {
  const context = await requireWorkspace(request, "MEMBER");
  if (context instanceof Response) return context;
  const campaign = await getCampaign(context.workspaceId, (await params).id);
  if (!campaign) return jsonError(404, "Campaign not found.");
  return NextResponse.json({ success: true, data: { campaign } });
}

/** `{ isActive }` alone pauses or resumes; anything else replaces the campaign. */
export async function PATCH(request: NextRequest, { params }: RouteProps) {
  const context = await requireWorkspace(request, "ADMIN");
  if (context instanceof Response) return context;
  const { id } = await params;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return jsonError(400, "Send a JSON body.");

  if (Object.keys(body).length === 1 && typeof body.isActive === "boolean") {
    if (!(await setCampaignActive(context.workspaceId, id, body.isActive))) {
      return jsonError(404, "Campaign not found.");
    }
    return NextResponse.json({ success: true });
  }

  const parsed = campaignInputSchema.safeParse(body);
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
  if (!(await updateCampaign(context.workspaceId, id, parsed.data))) {
    return jsonError(404, "Campaign not found.");
  }
  return NextResponse.json({ success: true });
}

export async function DELETE(request: NextRequest, { params }: RouteProps) {
  const context = await requireWorkspace(request, "ADMIN");
  if (context instanceof Response) return context;
  if (!(await deleteCampaign(context.workspaceId, (await params).id))) {
    return jsonError(404, "Campaign not found.");
  }
  return NextResponse.json({ success: true });
}
