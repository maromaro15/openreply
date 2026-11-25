import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { jsonError, requireWorkspace } from "@/lib/agency/http";
import { planActions } from "@/lib/bot/actions";
import { answerCustomer } from "@/lib/bot/answer";
import { SYSTEM_REASONS } from "@/lib/bot/classify";
import { getBotMaxFullCards } from "@/lib/ai/env";
import { getBotSettings, listKnowledge } from "@/lib/bot/knowledge";
import { mergeOrder, orderSummary, parseOrderDraft } from "@/lib/bot/order";
import { goalCollectsOrder } from "@/lib/bot/persona";
import { isOrderReady } from "@/lib/bot/persona-store";
import { loadCatalogForBot } from "@/lib/catalog/bot";
import { LIKE_BUTTON, loadActionProducts, publicBaseUrl } from "@/lib/facebook/bot-actions-send";
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
  /** The order details collected so far in this test, as this route returned them. */
  order: z.unknown().optional(),
});

/**
 * "Try the bot": the answer the bot would give with the saved settings,
 * persona and knowledge base, the customer's state it reads, the order
 * details it collects, and the pictures it would send. Nothing is sent on
 * Messenger, nothing is stored, and no alert goes out.
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
  // Whatever the browser sends back is checked again, like a stored draft.
  const previousDraft = parseOrderDraft(parsed.data.order ?? null);
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
    persona: settings.persona,
    order: { fields: settings.orderFields, draft: previousDraft },
  });

  const collects = goalCollectsOrder(settings.persona.goal);
  const order =
    collects && answer.order
      ? parseOrderDraft(mergeOrder(previousDraft, answer.order, { products: catalog.products, focusIds: mentioned }))
      : previousDraft;
  const orderReady = isOrderReady(settings, answer.customerState, order);
  const readyReason =
    collects && settings.orderFields.length > 0 ? SYSTEM_REASONS.orderReady : SYSTEM_REASONS.readyToBuy;
  // As in a conversation: a complete order outranks a refused reply.
  const decision =
    orderReady && answer.decision.kind === "handoff" && answer.decision.source !== "model"
      ? { kind: "handoff" as const, category: "ORDER_READY" as const, reason: readyReason, source: "system" as const }
      : answer.decision;
  // The pictures it would send after its words, checked against the catalog as on Messenger.
  const plans =
    decision.kind === "reply" && answer.actions.length > 0
      ? planActions(answer.actions, await loadActionProducts(context.workspaceId)).plans
      : [];
  const pictures =
    plans.length > 0
      ? {
          /** Messenger fetches them itself: only from a public https address. */
          onMessenger: publicBaseUrl() !== null,
          button: LIKE_BUTTON,
          sets: plans.map((plan) => ({
            type: plan.type,
            cards: plan.cards.map(({ title, subtitle, imagePath }) => ({ title, subtitle, imagePath })),
          })),
        }
      : null;

  return NextResponse.json({
    success: true,
    data: {
      decision,
      handoffMessage: settings.handoffMessage,
      error: answer.error,
      customerState: answer.customerState,
      /** Kept by the browser and sent back with the next message. */
      order,
      orderLines: order ? orderSummary(order, settings.orderFields).map(({ field, value }) => ({ field, value })) : [],
      orderReady: orderReady ? { reason: readyReason } : null,
      pictures,
      attempts: answer.attempts,
    },
  });
}
