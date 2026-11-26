import { NextResponse, type NextRequest } from "next/server";
import { jsonError, requireWorkspace } from "@/lib/agency/http";
import { sendTestAlerts } from "@/lib/alerts/dispatch";
import { ALERT_TEST_LIMIT_PER_HOUR, rateLimitedResponse, takeWorkspaceQuota } from "@/lib/limits/rate-limit";

export const dynamic = "force-dynamic";

/**
 * Send a test alert now: `{ recipientId }` for one recipient, `{}` for every
 * active one. Answers with what happened on each channel.
 */
export async function POST(request: NextRequest) {
  const context = await requireWorkspace(request, "ADMIN");
  if (context instanceof Response) return context;
  // Each call writes to every active recipient: bounded per brand.
  const quota = await takeWorkspaceQuota("alert-test", context.workspaceId, ALERT_TEST_LIMIT_PER_HOUR);
  if (!quota.allowed) {
    return rateLimitedResponse("Too many test alerts this hour. Try again later.", quota.retryAfter);
  }
  const body = (await request.json().catch(() => ({}))) as { recipientId?: unknown } | null;
  const recipientId = typeof body?.recipientId === "string" && body.recipientId ? body.recipientId : null;
  const results = await sendTestAlerts(context.workspaceId, recipientId);
  if (!results) return jsonError(404, "Recipient not found.");
  return NextResponse.json({ success: true, data: { results } });
}
