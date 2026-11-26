import { NextResponse, type NextRequest } from "next/server";
import { jsonError, requireWorkspace } from "@/lib/agency/http";
import { telegramBotToken } from "@/lib/alerts/settings";
import { chatsFromUpdates, TelegramError, telegramGetUpdates, type TelegramChat } from "@/lib/alerts/telegram";
import { listSeenChats, recordSeenChats } from "@/lib/knowledge/interview-run";

export const dynamic = "force-dynamic";

/**
 * People and groups that recently wrote to the brand's bot, so a chat ID is
 * picked instead of copied by hand: the live updates, then the chats the
 * worker saw while reading the bot for the voice interview (it confirms the
 * updates it reads, so they are no longer live). Reading without an offset
 * leaves the updates for anyone else reading them.
 */
export async function GET(request: NextRequest) {
  const context = await requireWorkspace(request, "ADMIN");
  if (context instanceof Response) return context;
  const token = await telegramBotToken(context.workspaceId);
  if (!token) return jsonError(400, "Save the Telegram bot first.");

  let live: TelegramChat[];
  try {
    live = chatsFromUpdates(await telegramGetUpdates(token, { limit: 100 }));
  } catch (error) {
    const conflict = error instanceof TelegramError && error.httpStatus === 409;
    // 409 without a webhook: our worker is reading the bot right now, and has recorded what it saw.
    if (conflict && !/webhook/i.test(error.message)) {
      return NextResponse.json({ success: true, data: { chats: await listSeenChats(context.workspaceId) } });
    }
    return NextResponse.json(
      {
        success: false,
        // 409: the bot has a webhook at another service, so its updates cannot be read here.
        code: error instanceof TelegramError ? (conflict ? "webhook_active" : error.kind) : "unavailable",
        error: error instanceof Error ? error.message : "Could not reach Telegram.",
      },
      { status: 502 }
    );
  }

  // Kept, so a chat found here can be chosen for the interview after its updates are gone.
  await recordSeenChats(context.workspaceId, live);
  const seen = await listSeenChats(context.workspaceId);
  const liveIds = new Set(live.map((chat) => chat.id));
  return NextResponse.json({
    success: true,
    data: { chats: [...live, ...seen.filter((chat) => !liveIds.has(chat.id))] },
  });
}
