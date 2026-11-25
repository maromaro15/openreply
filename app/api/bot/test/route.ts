import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { jsonError, requireWorkspace } from "@/lib/agency/http";
import { answerCustomer } from "@/lib/bot/answer";
import { getBotSettings, listKnowledge } from "@/lib/bot/knowledge";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  message: z.string().trim().min(1).max(1000),
  /** The test conversation so far, kept by the browser. */
  history: z
    .array(z.object({ from: z.enum(["customer", "page"]), text: z.string().trim().min(1).max(2000) }))
    .max(20)
    .default([]),
});

/**
 * "Try the bot": the answer the bot would give with the saved settings and
 * knowledge base. Nothing is sent on Messenger, nothing is stored, and no
 * alert goes out.
 */
export async function POST(request: NextRequest) {
  const context = await requireWorkspace(request, "MEMBER");
  if (context instanceof Response) return context;
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError(400, "Write a message of 1 to 1000 characters.");

  const [settings, knowledge] = await Promise.all([
    getBotSettings(context.workspaceId),
    listKnowledge(context.workspaceId),
  ]);
  const answer = await answerCustomer({
    businessName: settings.businessName,
    pageName: context.workspace.name,
    instructions: settings.instructions,
    knowledge,
    campaign: null,
    history: [
      ...parsed.data.history.map((message) => ({ from: message.from, by: "bot" as const, text: message.text })),
      { from: "customer" as const, text: parsed.data.message },
    ],
  });

  return NextResponse.json({
    success: true,
    data: {
      decision: answer.decision,
      handoffMessage: settings.handoffMessage,
      error: answer.error,
    },
  });
}
