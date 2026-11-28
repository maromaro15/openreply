import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { jsonError, requireWorkspace } from "@/lib/agency/http";
import {
  getConversationThread,
  markConversationRead,
  returnConversationToBot,
  takeOverConversation,
} from "@/lib/facebook/inbox";

type RouteProps = { params: Promise<{ id: string }> };

export const dynamic = "force-dynamic";

/** One conversation of the active brand: its messages and its timeline. */
export async function GET(request: NextRequest, { params }: RouteProps) {
  const context = await requireWorkspace(request, "MEMBER");
  if (context instanceof Response) return context;
  const thread = await getConversationThread(context.workspaceId, (await params).id);
  if (!thread) return jsonError(404, "Conversation not found.");
  return NextResponse.json({ success: true, data: thread });
}

const ACTIONS = ["take_over", "return_to_bot", "read"] as const;
type Action = (typeof ACTIONS)[number];

/** `{ action: "take_over" | "return_to_bot" | "read" }` */
export async function PATCH(request: NextRequest, { params }: RouteProps) {
  const context = await requireWorkspace(request, "MEMBER");
  if (context instanceof Response) return context;
  const { id } = await params;
  const body = (await request.json().catch(() => null)) as { action?: unknown } | null;
  const action = body?.action;
  if (typeof action !== "string" || !(ACTIONS as readonly string[]).includes(action)) {
    return jsonError(400, "Unknown action.");
  }

  // Scoped to the brand first: an ID from another brand is simply not found.
  const conversation = await prisma.facebookConversation.findFirst({
    where: { id, workspaceId: context.workspaceId },
    select: { id: true },
  });
  if (!conversation) return jsonError(404, "Conversation not found.");

  let changed = false;
  switch (action as Action) {
    case "take_over":
      changed = await takeOverConversation(conversation.id, {
        reason: "INBOX_TAKEOVER",
        actorUserId: context.userId,
      });
      break;
    case "return_to_bot":
      changed = await returnConversationToBot(conversation.id, context.userId);
      break;
    case "read":
      changed = await markConversationRead(context.workspaceId, conversation.id);
      break;
  }
  return NextResponse.json({ success: true, data: { changed } });
}
