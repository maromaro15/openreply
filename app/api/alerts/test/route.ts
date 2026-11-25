import { NextResponse, type NextRequest } from "next/server";
import { jsonError, requireWorkspace } from "@/lib/agency/http";
import { sendTestAlerts } from "@/lib/alerts/dispatch";

export const dynamic = "force-dynamic";

/**
 * Send a test alert now: `{ recipientId }` for one recipient, `{}` for every
 * active one. Answers with what happened on each channel.
 */
export async function POST(request: NextRequest) {
  const context = await requireWorkspace(request, "ADMIN");
  if (context instanceof Response) return context;
  const body = (await request.json().catch(() => ({}))) as { recipientId?: unknown } | null;
  const recipientId = typeof body?.recipientId === "string" && body.recipientId ? body.recipientId : null;
  const results = await sendTestAlerts(context.workspaceId, recipientId);
  if (!results) return jsonError(404, "Recipient not found.");
  return NextResponse.json({ success: true, data: { results } });
}
