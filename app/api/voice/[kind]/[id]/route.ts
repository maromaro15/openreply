import { NextResponse, type NextRequest } from "next/server";
import { jsonError } from "@/lib/agency/http";
import { isVoiceKind, requireVoice, voiceCorrectionPatch, voiceExamplePatch } from "@/lib/voice/http";
import { deleteVoiceRow, updateVoiceCorrection, updateVoiceExample } from "@/lib/voice/store";

type RouteProps = { params: Promise<{ kind: string; id: string }> };

export const dynamic = "force-dynamic";

/** Edits, switches on or off: the brand's own rows, and the global ones for platform admins. */
export async function PATCH(request: NextRequest, { params }: RouteProps) {
  const { kind, id } = await params;
  if (!isVoiceKind(kind)) return jsonError(404, "Not found");
  const context = await requireVoice(request, "ADMIN");
  if (context instanceof Response) return context;
  const body = await request.json().catch(() => null);
  const parsed = kind === "examples" ? voiceExamplePatch.safeParse(body) : voiceCorrectionPatch.safeParse(body);
  if (!parsed.success) return jsonError(400, parsed.error.issues[0]?.message ?? "Invalid request");
  if (Object.values(parsed.data).every((value) => value === undefined)) return jsonError(400, "Nothing to change.");
  const updated =
    kind === "examples"
      ? await updateVoiceExample(id, context.workspaceId, context.platformAdmin, parsed.data)
      : await updateVoiceCorrection(id, context.workspaceId, context.platformAdmin, parsed.data);
  if (!updated) return jsonError(404, "Not found");
  return NextResponse.json({ success: true });
}

export async function DELETE(request: NextRequest, { params }: RouteProps) {
  const { kind, id } = await params;
  if (!isVoiceKind(kind)) return jsonError(404, "Not found");
  const context = await requireVoice(request, "ADMIN");
  if (context instanceof Response) return context;
  const deleted = await deleteVoiceRow(kind === "examples" ? "example" : "correction", id, context.workspaceId, context.platformAdmin);
  if (!deleted) return jsonError(404, "Not found");
  return NextResponse.json({ success: true });
}
