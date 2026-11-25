import { NextResponse, type NextRequest } from "next/server";
import { jsonError, requireWorkspace } from "@/lib/agency/http";
import { connectWithToken, listWorkspacePages, webhookSetup } from "@/lib/facebook/pages";

// Read-your-writes: a Page appears as soon as it is connected.
export const dynamic = "force-dynamic";

/** The active brand's Pages (never their tokens) and the webhook setup. */
export async function GET(request: NextRequest) {
  const context = await requireWorkspace(request, "MEMBER");
  if (context instanceof Response) return context;

  return NextResponse.json({
    success: true,
    data: {
      role: context.role,
      pages: await listWorkspacePages(context.workspaceId),
      setup: webhookSetup(),
    },
  });
}

/**
 * Connect with a token. A Page token connects its Page. A user token first
 * returns the user's Pages to choose from; sending it again with `pageIds`
 * connects the chosen ones.
 */
export async function POST(request: NextRequest) {
  const context = await requireWorkspace(request, "ADMIN");
  if (context instanceof Response) return context;

  const body = (await request.json().catch(() => null)) as {
    token?: unknown;
    pageIds?: unknown;
  } | null;
  if (typeof body?.token !== "string" || !body.token.trim()) {
    return jsonError(400, "Paste a Page access token.");
  }
  const pageIds = Array.isArray(body.pageIds)
    ? body.pageIds.filter((id): id is string => typeof id === "string" && /^\d{1,32}$/.test(id))
    : undefined;

  const outcome = await connectWithToken({
    workspaceId: context.workspaceId,
    token: body.token,
    pageIds,
  });

  if (outcome.kind === "error") {
    return NextResponse.json({ success: false, error: outcome.error.message, details: outcome.error }, { status: 422 });
  }
  return NextResponse.json({ success: true, data: outcome });
}
