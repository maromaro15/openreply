import { NextResponse, type NextRequest } from "next/server";
import { jsonError, requireWorkspace } from "@/lib/agency/http";
import { getGeminiChatModel, getGoogleApiKey } from "@/lib/ai/env";
import { botSettingsSchema, getBotSettings, saveBotSettings } from "@/lib/bot/knowledge";
import { prisma } from "@/lib/db/client";

export const dynamic = "force-dynamic";

/** The brand's bot settings, whether the AI is configured, and its Pages. */
export async function GET(request: NextRequest) {
  const context = await requireWorkspace(request, "MEMBER");
  if (context instanceof Response) return context;
  const [settings, pages] = await Promise.all([
    getBotSettings(context.workspaceId),
    prisma.facebookPage.findMany({
      where: { workspaceId: context.workspaceId, status: { not: "DISCONNECTED" } },
      orderBy: { connectedAt: "asc" },
      select: { id: true, name: true, status: true, botEnabled: true },
    }),
  ]);
  return NextResponse.json({
    success: true,
    data: {
      role: context.role,
      settings,
      ai: { configured: Boolean(getGoogleApiKey()), model: getGeminiChatModel() },
      pages,
    },
  });
}

export async function PUT(request: NextRequest) {
  const context = await requireWorkspace(request, "ADMIN");
  if (context instanceof Response) return context;
  const parsed = botSettingsSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError(400, parsed.error.issues[0]?.message ?? "Invalid settings");
  const settings = await saveBotSettings(context.workspaceId, parsed.data);
  return NextResponse.json({ success: true, data: { settings } });
}
