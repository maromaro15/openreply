import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { jsonError } from "@/lib/agency/http";
import { requireVoice } from "@/lib/voice/http";
import { listVoice, setVoiceAutoSave } from "@/lib/voice/store";

export const dynamic = "force-dynamic";

/** The brand's voice screen: its examples and corrections, the global set, and the auto-save setting. */
export async function GET(request: NextRequest) {
  const context = await requireVoice(request, "MEMBER");
  if (context instanceof Response) return context;
  return NextResponse.json({
    success: true,
    data: { ...(await listVoice(context.workspaceId)), canEditGlobal: context.platformAdmin },
  });
}

const settingsSchema = z.object({ autoSave: z.boolean() });

export async function PUT(request: NextRequest) {
  const context = await requireVoice(request, "ADMIN");
  if (context instanceof Response) return context;
  const parsed = settingsSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError(400, "Invalid settings");
  await setVoiceAutoSave(context.workspaceId, parsed.data.autoSave);
  return NextResponse.json({ success: true });
}
