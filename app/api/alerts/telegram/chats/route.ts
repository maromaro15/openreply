import { NextResponse, type NextRequest } from "next/server";
import { jsonError, requireWorkspace } from "@/lib/agency/http";
import { telegramBotToken } from "@/lib/alerts/settings";
import { chatsFromUpdates, TelegramError, telegramGetUpdates } from "@/lib/alerts/telegram";

export const dynamic = "force-dynamic";

/**
 * People and groups that recently wrote to the brand's bot, so a chat ID is
 * picked instead of copied by hand. Reading without an offset leaves the
 * updates for anyone else reading them.
 */
export async function GET(request: NextRequest) {
  const context = await requireWorkspace(request, "ADMIN");
  if (context instanceof Response) return context;
  const token = await telegramBotToken(context.workspaceId);
  if (!token) return jsonError(400, "Save the Telegram bot first.");
  try {
    const updates = await telegramGetUpdates(token, { limit: 100 });
    return NextResponse.json({ success: true, data: { chats: chatsFromUpdates(updates) } });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        // 409: the bot has a webhook at another service, so its updates cannot be read here.
        code: error instanceof TelegramError ? (error.httpStatus === 409 ? "webhook_active" : error.kind) : "unavailable",
        error: error instanceof Error ? error.message : "Could not reach Telegram.",
      },
      { status: 502 }
    );
  }
}
