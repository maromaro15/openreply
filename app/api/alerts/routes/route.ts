import { NextResponse, type NextRequest } from "next/server";
import { jsonError, requireWorkspace } from "@/lib/agency/http";
import { getRoutingTable, routingTableSchema, saveRoutingTable } from "@/lib/alerts/settings";

export const dynamic = "force-dynamic";

/** The routing table: for each handoff category, the recipients that get its alerts. */
export async function GET(request: NextRequest) {
  const context = await requireWorkspace(request, "MEMBER");
  if (context instanceof Response) return context;
  return NextResponse.json({ success: true, data: { routes: await getRoutingTable(context.workspaceId) } });
}

/** Replaces the whole table: `{ routes: { COMPLAINT: [recipientId, ...], ... } }`. */
export async function PUT(request: NextRequest) {
  const context = await requireWorkspace(request, "ADMIN");
  if (context instanceof Response) return context;
  const body = (await request.json().catch(() => null)) as { routes?: unknown } | null;
  const parsed = routingTableSchema.safeParse(body?.routes);
  if (!parsed.success) return jsonError(400, "Send the routing table as { routes: { CATEGORY: [recipientId] } }.");
  return NextResponse.json({ success: true, data: { routes: await saveRoutingTable(context.workspaceId, parsed.data) } });
}
