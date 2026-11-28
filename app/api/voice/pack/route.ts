import { NextResponse, type NextRequest } from "next/server";
import { jsonError } from "@/lib/agency/http";
import { voicePackSchema } from "@/lib/voice/format";
import { requireVoice } from "@/lib/voice/http";
import { exportVoicePack, importVoicePack } from "@/lib/voice/store";

export const dynamic = "force-dynamic";

/** The brand's voice (or ?scope=global) as a portable JSON pack (lib/voice/format.ts). */
export async function GET(request: NextRequest) {
  const context = await requireVoice(request, "ADMIN");
  if (context instanceof Response) return context;
  const global = request.nextUrl.searchParams.get("scope") === "global";
  const pack = await exportVoicePack(global ? null : context.workspaceId);
  return new NextResponse(JSON.stringify(pack, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="voice-${global ? "global" : "brand"}.json"`,
    },
  });
}

/** Adds a pack's examples and corrections that are not there yet. Its scope "global" needs a platform admin. */
export async function POST(request: NextRequest) {
  const context = await requireVoice(request, "ADMIN");
  if (context instanceof Response) return context;
  const parsed = voicePackSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError(400, "This file is not a voice pack.");
  const global = request.nextUrl.searchParams.get("scope") === "global";
  if (global && !context.platformAdmin) return jsonError(403, "Only platform admins can change the global set.");
  const result = await importVoicePack(global ? null : context.workspaceId, parsed.data, context.userId);
  return NextResponse.json({ success: true, data: result });
}
