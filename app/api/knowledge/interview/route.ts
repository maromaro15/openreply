import { NextResponse, type NextRequest } from "next/server";
import { jsonError, requireWorkspace } from "@/lib/agency/http";
import { getInterviewPanel, interviewStartSchema, startInterviewRun, stopInterviewRun } from "@/lib/knowledge/interview-run";

export const dynamic = "force-dynamic";

/** The brand's latest interview, its progress and pending suggestions, with the chats and products to start one. */
export async function GET(request: NextRequest) {
  const context = await requireWorkspace(request, "ADMIN");
  if (context instanceof Response) return context;
  return NextResponse.json({ success: true, data: await getInterviewPanel(context.workspaceId) });
}

/** `{ chatId, productIds? }`: starts an interview (stopping the running one) and sends the first question. */
export async function POST(request: NextRequest) {
  const context = await requireWorkspace(request, "ADMIN");
  if (context instanceof Response) return context;
  const parsed = interviewStartSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError(400, parsed.error.issues[0]?.message ?? "Invalid request");
  const result = await startInterviewRun({
    workspaceId: context.workspaceId,
    chatId: parsed.data.chatId,
    productIds: parsed.data.productIds ?? null,
    userId: context.userId,
  });
  if (!result.ok) {
    const telegram = result.error === "telegram";
    return NextResponse.json(
      { success: false, code: telegram ? (result.kind ?? "unavailable") : result.error, error: result.message },
      { status: telegram ? 502 : 400 }
    );
  }
  return NextResponse.json(
    { success: true, data: { ...(await getInterviewPanel(context.workspaceId)), asked: result.asked } },
    { status: 201 }
  );
}

/** Stops the running interview; what was answered stays in the suggestions. */
export async function DELETE(request: NextRequest) {
  const context = await requireWorkspace(request, "ADMIN");
  if (context instanceof Response) return context;
  const stopped = await stopInterviewRun(context.workspaceId);
  return NextResponse.json({ success: true, data: { stopped } });
}
