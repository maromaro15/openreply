import { NextResponse, type NextRequest } from "next/server";
import { jsonError, requireWorkspace } from "@/lib/agency/http";
import {
  createKnowledgeEntry,
  formatKnowledgeBase,
  knowledgeEntrySchema,
  KNOWLEDGE_WARN_CHARS,
  listKnowledge,
  MAX_KNOWLEDGE_ENTRIES,
} from "@/lib/bot/knowledge";

export const dynamic = "force-dynamic";

/** The brand's knowledge base, and how big it is as the bot reads it. */
export async function GET(request: NextRequest) {
  const context = await requireWorkspace(request, "MEMBER");
  if (context instanceof Response) return context;
  const entries = await listKnowledge(context.workspaceId);
  return NextResponse.json({
    success: true,
    data: {
      role: context.role,
      entries,
      size: { chars: formatKnowledgeBase(entries).length, warnAt: KNOWLEDGE_WARN_CHARS },
    },
  });
}

export async function POST(request: NextRequest) {
  const context = await requireWorkspace(request, "ADMIN");
  if (context instanceof Response) return context;
  const parsed = knowledgeEntrySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError(400, parsed.error.issues[0]?.message ?? "Invalid entry");
  const entry = await createKnowledgeEntry(context.workspaceId, parsed.data);
  if (!entry) return jsonError(400, `A knowledge base holds ${MAX_KNOWLEDGE_ENTRIES} entries at most.`);
  return NextResponse.json({ success: true, data: { entry } }, { status: 201 });
}
