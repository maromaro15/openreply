import { NextResponse, type NextRequest } from "next/server";
import { jsonError, requireWorkspace } from "@/lib/agency/http";
import { deleteDisconnectedPage, disconnectPage, setPageBotEnabled } from "@/lib/facebook/pages";

type RouteProps = { params: Promise<{ id: string }> };

/** Turn the bot on or off for one Page. */
export async function PATCH(request: NextRequest, { params }: RouteProps) {
  const context = await requireWorkspace(request, "ADMIN");
  if (context instanceof Response) return context;
  const { id } = await params;

  const body = (await request.json().catch(() => null)) as { botEnabled?: unknown } | null;
  if (typeof body?.botEnabled !== "boolean") return jsonError(400, "botEnabled must be true or false.");

  const updated = await setPageBotEnabled(context.workspaceId, id, body.botEnabled);
  if (!updated) return jsonError(404, "Page not found.");
  return NextResponse.json({ success: true });
}

/**
 * Disconnect a Page. With `{ "purge": true }`, an already disconnected Page
 * is deleted with all its campaigns and conversations, so another brand can
 * connect it. Deleting is for owners only.
 */
export async function DELETE(request: NextRequest, { params }: RouteProps) {
  const body = (await request.json().catch(() => ({}))) as { purge?: unknown };
  const purge = body?.purge === true;
  const context = await requireWorkspace(request, purge ? "OWNER" : "ADMIN");
  if (context instanceof Response) return context;
  const { id } = await params;

  const done = purge
    ? await deleteDisconnectedPage(context.workspaceId, id)
    : await disconnectPage(context.workspaceId, id);
  if (!done) {
    return jsonError(404, purge ? "Only a disconnected Page of this brand can be deleted." : "Page not found.");
  }
  return NextResponse.json({ success: true });
}
