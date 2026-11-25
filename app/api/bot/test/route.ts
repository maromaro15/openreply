import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { jsonError, requireWorkspace } from "@/lib/agency/http";
import { answerCustomer } from "@/lib/bot/answer";
import { getBotMaxFullCards } from "@/lib/ai/env";
import { getBotSettings, listKnowledge } from "@/lib/bot/knowledge";
import { loadCatalogForBot } from "@/lib/catalog/bot";
import {
  buildCatalogSection,
  catalogReferenceTexts,
  mentionedProductIds,
  selectCardProducts,
} from "@/lib/catalog/prompt";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  message: z.string().trim().min(1).max(1000),
  /** The test conversation so far, kept by the browser. */
  history: z
    .array(z.object({ from: z.enum(["customer", "page"]), text: z.string().trim().min(1).max(2000) }))
    .max(20)
    .default([]),
});

/**
 * "Try the bot": the answer the bot would give with the saved settings and
 * knowledge base. Nothing is sent on Messenger, nothing is stored, and no
 * alert goes out.
 */
export async function POST(request: NextRequest) {
  const context = await requireWorkspace(request, "MEMBER");
  if (context instanceof Response) return context;
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError(400, "Write a message of 1 to 1000 characters.");

  const [settings, knowledge, catalog] = await Promise.all([
    getBotSettings(context.workspaceId),
    listKnowledge(context.workspaceId),
    loadCatalogForBot(context.workspaceId),
  ]);
  // As in a conversation: what the customer and the Page said, oldest first.
  const texts = [...parsed.data.history.map((message) => message.text), parsed.data.message];
  const mentioned = mentionedProductIds(catalog.products, texts);
  const cards = selectCardProducts(catalog.products, { mentionedIds: mentioned }, getBotMaxFullCards());
  const answer = await answerCustomer({
    businessName: settings.businessName,
    pageName: context.workspace.name,
    instructions: settings.instructions,
    knowledge,
    campaign: null,
    history: [
      ...parsed.data.history.map((message) => ({ from: message.from, by: "bot" as const, text: message.text })),
      { from: "customer" as const, text: parsed.data.message },
    ],
    catalogSection: buildCatalogSection(catalog.products, cards, catalog.attributes),
    catalogReference: catalogReferenceTexts(catalog.products, cards, catalog.attributes),
  });

  return NextResponse.json({
    success: true,
    data: {
      decision: answer.decision,
      handoffMessage: settings.handoffMessage,
      error: answer.error,
    },
  });
}
