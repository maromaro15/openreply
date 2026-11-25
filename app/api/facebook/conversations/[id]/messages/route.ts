import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { jsonError, requireWorkspace } from "@/lib/agency/http";
import { HUMAN_REPLY_MAX_LENGTH, sendHumanReply } from "@/lib/facebook/human-reply";
import { HUMAN_REPLY_ERRORS } from "@/lib/facebook/reply-errors";

type RouteProps = { params: Promise<{ id: string }> };

export const dynamic = "force-dynamic";

const bodySchema = z.object({ text: z.string().trim().min(1).max(HUMAN_REPLY_MAX_LENGTH) });

/**
 * A reply typed in the inbox, sent as the Page. `code` says why it did not
 * go out; `error` is the English text of it, which the inbox translates.
 */
export async function POST(request: NextRequest, { params }: RouteProps) {
  const context = await requireWorkspace(request, "MEMBER");
  if (context instanceof Response) return context;
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return jsonError(400, `Write a message of 1 to ${HUMAN_REPLY_MAX_LENGTH} characters.`);
  }

  const result = await sendHumanReply({
    workspaceId: context.workspaceId,
    userId: context.userId,
    conversationId: (await params).id,
    text: parsed.data.text,
  });
  if (!result.ok) {
    return NextResponse.json(
      {
        success: false,
        code: result.code,
        error: HUMAN_REPLY_ERRORS[result.code],
        detail: result.detail ?? null,
      },
      { status: result.status }
    );
  }
  return NextResponse.json({ success: true, data: { message: result.message } }, { status: 201 });
}
