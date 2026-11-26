import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { jsonError } from "@/lib/agency/http";
import { prisma } from "@/lib/db/client";
import { voiceCorrectionSchema, voiceExampleSchema } from "@/lib/voice/format";
import { requireVoice } from "@/lib/voice/http";
import { addVoiceCorrection, addVoiceExample } from "@/lib/voice/store";
import { hasWorkspaceRole } from "@/lib/workspace-access";

export const dynamic = "force-dynamic";

const bodySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("example"),
    messageId: z.string().trim().min(1).max(100),
    customer: voiceExampleSchema.shape.customer,
    reply: voiceExampleSchema.shape.reply,
  }),
  z.object({
    kind: z.literal("correction"),
    messageId: z.string().trim().min(1).max(100),
    wrong: voiceCorrectionSchema.shape.wrong,
    right: voiceCorrectionSchema.shape.right,
  }),
]);

/**
 * From the inbox: a person's reply, or a bot reply as it should have been
 * written, saved as a voice example; or a wrong phrase in a bot reply saved
 * to the brand's dictionary (owners and admins: it changes every reply).
 */
export async function POST(request: NextRequest) {
  const context = await requireVoice(request, "MEMBER");
  if (context instanceof Response) return context;
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError(400, parsed.error.issues[0]?.message ?? "Invalid request");
  const message = await prisma.facebookMessage.findFirst({
    where: { id: parsed.data.messageId, workspaceId: context.workspaceId, direction: "OUTBOUND" },
    select: { id: true, author: true },
  });
  if (!message) return jsonError(404, "Message not found.");

  const data = parsed.data;
  let result;
  if (data.kind === "correction") {
    if (!hasWorkspaceRole(context.role, "ADMIN")) return jsonError(403, "Only workspace owners and admins can do this.");
    result = await addVoiceCorrection(
      context.workspaceId,
      { wrong: data.wrong, right: data.right, source: "inbox_correction", active: true },
      { userId: context.userId }
    );
  } else {
    // A person's own reply is learned once; a corrected bot reply is a new text, kept as many times as it differs.
    result = await addVoiceExample(
      context.workspaceId,
      {
        customer: data.customer,
        reply: data.reply,
        source: message.author === "HUMAN" ? "human_reply" : "inbox_correction",
        active: true,
      },
      { userId: context.userId, sourceMessageId: message.author === "HUMAN" ? message.id : null }
    );
  }
  if (!result.ok) return NextResponse.json({ success: false, error: "The list is full.", code: "full" }, { status: 409 });
  return NextResponse.json({ success: true, data: { created: result.created } }, { status: result.created ? 201 : 200 });
}
