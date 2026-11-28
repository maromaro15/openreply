import { NextResponse, type NextRequest } from "next/server";
import { jsonError, requireWorkspace } from "@/lib/agency/http";
import { getAlertsEmailFrom, isAlertEmailConfigured } from "@/lib/alerts/email";
import { getTelegramBot, removeTelegramBot, saveTelegramBot } from "@/lib/alerts/settings";
import { isTelegramToken, TelegramError, telegramGetMe } from "@/lib/alerts/telegram";

export const dynamic = "force-dynamic";

/** The brand's Telegram bot (its @username, never the token) and whether email alerts can go out. */
export async function GET(request: NextRequest) {
  const context = await requireWorkspace(request, "MEMBER");
  if (context instanceof Response) return context;
  const bot = await getTelegramBot(context.workspaceId);
  return NextResponse.json({
    success: true,
    data: {
      role: context.role,
      telegram: { connected: Boolean(bot), username: bot?.username ?? null },
      email: { configured: isAlertEmailConfigured(), from: getAlertsEmailFrom() },
    },
  });
}

/** `{ telegramBotToken }`: checked with Telegram (getMe) before it is stored, encrypted. */
export async function PUT(request: NextRequest) {
  const context = await requireWorkspace(request, "ADMIN");
  if (context instanceof Response) return context;
  const body = (await request.json().catch(() => null)) as { telegramBotToken?: unknown } | null;
  const token = typeof body?.telegramBotToken === "string" ? body.telegramBotToken.trim() : "";
  if (!isTelegramToken(token)) {
    return NextResponse.json({ success: false, code: "invalid_format", error: "That does not look like a Telegram bot token." }, { status: 400 });
  }
  try {
    const me = await telegramGetMe(token);
    await saveTelegramBot(context.workspaceId, token, me.username);
    return NextResponse.json({ success: true, data: { telegram: { connected: true, username: me.username } } });
  } catch (error) {
    if (error instanceof TelegramError && error.kind === "invalid_token") {
      return NextResponse.json({ success: false, code: "invalid_token", error: "Telegram refused this token." }, { status: 400 });
    }
    return jsonError(502, "Could not reach Telegram.");
  }
}

export async function DELETE(request: NextRequest) {
  const context = await requireWorkspace(request, "ADMIN");
  if (context instanceof Response) return context;
  await removeTelegramBot(context.workspaceId);
  return NextResponse.json({ success: true });
}
