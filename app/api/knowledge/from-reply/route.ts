import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { jsonError, requireWorkspace } from "@/lib/agency/http";
import { FROM_REPLY_LIMITS, saveReplyAsKnowledge } from "@/lib/knowledge/jobs/learn";
import { hasWorkspaceRole } from "@/lib/workspace-access";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  messageId: z.string().trim().min(1).max(100),
  question: z.string().trim().min(1, "Write the question.").max(FROM_REPLY_LIMITS.question, "The question is too long."),
  answer: z.string().trim().min(1, "Write the answer.").max(FROM_REPLY_LIMITS.answer, "The answer is too long."),
});

/**
 * «Add to the knowledge base» under a person's reply in the inbox. An owner or
 * admin adds a FAQ entry directly; a member's text waits as a suggestion for
 * an admin to approve.
 */
export async function POST(request: NextRequest) {
  const context = await requireWorkspace(request, "MEMBER");
  if (context instanceof Response) return context;
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError(400, parsed.error.issues[0]?.message ?? "Invalid request");

  const result = await saveReplyAsKnowledge({
    workspaceId: context.workspaceId,
    canEditKnowledge: hasWorkspaceRole(context.role, "ADMIN"),
    ...parsed.data,
  });
  if (!result.ok) {
    return NextResponse.json({ success: false, error: result.error, code: result.code }, { status: result.status });
  }
  return NextResponse.json(
    { success: true, data: { mode: result.mode, created: result.created } },
    { status: result.created ? 201 : 200 }
  );
}
