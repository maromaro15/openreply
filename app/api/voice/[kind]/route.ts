import { NextResponse, type NextRequest } from "next/server";
import { jsonError } from "@/lib/agency/http";
import { isVoiceKind, requireVoice, voiceCorrectionInput, voiceExampleInput } from "@/lib/voice/http";
import { addVoiceCorrection, addVoiceExample } from "@/lib/voice/store";

type RouteProps = { params: Promise<{ kind: string }> };

export const dynamic = "force-dynamic";

/** Adds an example or a correction to the brand, or to the global set (platform admins only). */
export async function POST(request: NextRequest, { params }: RouteProps) {
  const { kind } = await params;
  if (!isVoiceKind(kind)) return jsonError(404, "Not found");
  const context = await requireVoice(request, "ADMIN");
  if (context instanceof Response) return context;
  const body = await request.json().catch(() => null);
  const parsed = kind === "examples" ? voiceExampleInput.safeParse(body) : voiceCorrectionInput.safeParse(body);
  if (!parsed.success) return jsonError(400, parsed.error.issues[0]?.message ?? "Invalid request");
  if (parsed.data.global && !context.platformAdmin) return jsonError(403, "Only platform admins can change the global set.");
  const workspaceId = parsed.data.global ? null : context.workspaceId;
  const extra = { userId: context.userId };
  const result =
    "customer" in parsed.data
      ? await addVoiceExample(workspaceId, { customer: parsed.data.customer, reply: parsed.data.reply, source: "manual", active: true }, extra)
      : await addVoiceCorrection(workspaceId, { wrong: parsed.data.wrong, right: parsed.data.right, source: "manual", active: true }, extra);
  if (!result.ok) return NextResponse.json({ success: false, error: "The list is full.", code: "full" }, { status: 409 });
  return NextResponse.json({ success: true, data: { id: result.id, created: result.created } }, { status: result.created ? 201 : 200 });
}
