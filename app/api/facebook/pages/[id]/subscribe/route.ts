import { NextResponse, type NextRequest } from "next/server";
import { jsonError, requireWorkspace } from "@/lib/agency/http";
import { resubscribePage } from "@/lib/facebook/pages";

type RouteProps = { params: Promise<{ id: string }> };

/** Subscribe the app to the Page's webhook fields again. */
export async function POST(request: NextRequest, { params }: RouteProps) {
  const context = await requireWorkspace(request, "ADMIN");
  if (context instanceof Response) return context;
  const { id } = await params;

  const subscription = await resubscribePage(context.workspaceId, id);
  if (!subscription) return jsonError(404, "Page not found.");
  return NextResponse.json({ success: subscription.ok, data: subscription, error: subscription.error ?? undefined });
}
