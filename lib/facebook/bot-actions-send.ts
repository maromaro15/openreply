/**
 * The bot's optional actions (PLAN.md 6.14), sent after its text reply:
 * colour cards and product comparisons as Messenger generic templates, each
 * card with a «نحب هذا» button. lib/bot/actions.ts checked every item
 * against the catalog; this loads what it needs and sends.
 *
 * Messenger fetches the pictures itself, so they must be on the public,
 * https domain of the deployment: on localhost nothing is sent.
 */
import { prisma } from "@/lib/db/client";
import { getBaseUrl } from "@/lib/env";
import { isButtonUrl } from "@/lib/alerts/message";
import { planActions, type ActionPlan, type ActionProduct } from "@/lib/bot/actions";
import { cleanAttributeValues } from "@/lib/catalog/attributes";
import { publicImagePath } from "@/lib/catalog/images";
import type { FacebookConversation, FacebookPage } from "@/app/generated/prisma/client";
import { messageMetadata } from "./echoes";
import { FacebookApiError, sendMessage } from "./graph";
import { pageToken } from "./pages";
import { encodeLikePayload } from "./postbacks";
import { buildGenericTemplates, buildImageAttachment, sendTemplateMessage, type TemplateCard } from "./templates-send";

type Conversation = FacebookConversation & { page: FacebookPage };

export const LIKE_BUTTON = "نحب هذا";
export const DETAILS_BUTTON = "التفاصيل";
/** How a sent set of cards is stored: the inbox and the model's history read it. */
export const PICTURES = "template";
/** The first attributes a comparison card shows. */
const HIGHLIGHTS = 2;

/** The brand's active products as the planner needs them: pictures and highlights. */
export async function loadActionProducts(workspaceId: string): Promise<ActionProduct[]> {
  const [template, products] = await Promise.all([
    prisma.productAttribute.findMany({
      where: { workspaceId },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: { key: true, label: true, type: true, options: true, unit: true },
    }),
    prisma.product.findMany({
      where: { workspaceId, status: "ACTIVE" },
      take: 2000,
      select: {
        id: true,
        name: true,
        code: true,
        price: true,
        available: true,
        landingUrl: true,
        attributes: true,
        mainImage: { select: { publicId: true } },
        variants: {
          orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
          select: { code: true, name: true, available: true, image: { select: { publicId: true } } },
        },
      },
    }),
  ]);
  return products.map((product) => {
    const values = cleanAttributeValues(template, product.attributes).values;
    const highlights = template
      .filter((attribute) => values[attribute.key] !== undefined)
      .slice(0, HIGHLIGHTS)
      .map((attribute) => {
        const value = values[attribute.key];
        const text = typeof value === "boolean" ? (value ? "✓" : "✗") : String(value);
        return `${attribute.label}: ${text}${attribute.unit && typeof value === "number" ? ` ${attribute.unit}` : ""}`;
      });
    return {
      id: product.id,
      name: product.name,
      code: product.code,
      price: product.price,
      available: product.available,
      landingUrl: product.landingUrl,
      imagePath: product.mainImage ? publicImagePath(product.mainImage.publicId) : null,
      highlights,
      variants: product.variants.map((variant) => ({
        code: variant.code,
        name: variant.name,
        available: variant.available,
        imagePath: variant.image ? publicImagePath(variant.image.publicId) : null,
      })),
    };
  });
}

/** The public base URL Messenger can fetch from, or null (localhost, plain http). */
export function publicBaseUrl(): string | null {
  const base = getBaseUrl().trim().replace(/\/+$/, "");
  return isButtonUrl(base) ? base : null;
}

function cardsOf(plan: ActionPlan, base: string): TemplateCard[] {
  return plan.cards.map((card) => ({
    title: card.title,
    subtitle: card.subtitle,
    imageUrl: `${base}${card.imagePath}`,
    buttons: [
      { type: "postback" as const, title: LIKE_BUTTON, payload: encodeLikePayload(card.productId, card.variantCode) },
      ...(plan.type === "compare" && card.landingUrl
        ? [{ type: "web_url" as const, title: DETAILS_BUTTON, url: card.landingUrl }]
        : []),
    ],
  }));
}

type Row = { text: string | null; attachmentType: string | null; attachmentUrl?: string };

/**
 * One stored outbound row per Messenger message, so the inbox and the echoes
 * know it. These rows answer no message (no `replyToMid`): they belong to the
 * reply that asked for them, which alone counts towards the hourly cap.
 */
async function sendTracked(conversation: Conversation, row: Row, send: (metadata: string) => Promise<string | null>) {
  const { id } = await prisma.facebookMessage.create({
    data: {
      workspaceId: conversation.workspaceId,
      conversationId: conversation.id,
      direction: "OUTBOUND",
      author: "BOT",
      origin: "OPENREPLY",
      text: row.text?.slice(0, 500) ?? null,
      attachmentType: row.attachmentType,
      attachmentUrl: row.attachmentUrl ?? null,
      sendStatus: "PENDING",
    },
    select: { id: true },
  });
  try {
    const messageId = await send(messageMetadata(id));
    // An echo may have marked it SENT with this mid already: never downgraded.
    await prisma.facebookMessage.updateMany({
      where: { id, sendStatus: { not: "SENT" } },
      data: { sendStatus: "SENT", sentAt: new Date(), error: null },
    });
    if (messageId) {
      await prisma.facebookMessage.updateMany({ where: { id, mid: null }, data: { mid: messageId } }).catch(() => undefined);
    }
  } catch (error) {
    await prisma.facebookMessage.updateMany({
      where: { id, sendStatus: "PENDING" },
      data: { sendStatus: "FAILED", error: error instanceof Error ? error.message.slice(0, 500) : "Send failed" },
    });
    throw error;
  }
}

/**
 * Plan the model's actions against the catalog and send them. Never throws:
 * the text reply already went out, and a picture that fails is only logged.
 */
export async function sendBotActions(conversation: Conversation, rawActions: unknown): Promise<{ sent: number; dropped: number }> {
  if (!Array.isArray(rawActions) || rawActions.length === 0) return { sent: 0, dropped: 0 };
  const base = publicBaseUrl();
  if (!base) {
    console.log(`[Facebook bot] ${conversation.id}: actions skipped, the app has no public https address`);
    return { sent: 0, dropped: rawActions.length };
  }
  let planned: ReturnType<typeof planActions>;
  let token: string;
  try {
    token = pageToken(conversation.page);
    planned = planActions(rawActions, await loadActionProducts(conversation.workspaceId));
  } catch (error) {
    // The reply is out and the job must go on (an order may be ready): no pictures this time.
    console.warn(`[Facebook bot] ${conversation.id}: actions skipped:`, error instanceof Error ? error.message : error);
    return { sent: 0, dropped: rawActions.length };
  }
  const { plans, dropped } = planned;
  if (dropped.length) console.log(`[Facebook bot] ${conversation.id}: actions dropped`, dropped);

  const { pageId } = conversation.page;
  const psid = conversation.psid;
  const sendCards = (message: Parameters<typeof sendTemplateMessage>[2]["message"]) => (metadata: string) =>
    sendTemplateMessage(pageId, token, { psid, message, metadata }).then((result) => result.messageId);

  let sent = 0;
  const stop = (error: unknown) => {
    console.warn(`[Facebook bot] ${conversation.id}: actions stopped:`, error instanceof Error ? error.message : error);
    return { sent, dropped: dropped.length };
  };
  for (const plan of plans) {
    const cards = cardsOf(plan, base);
    const messages = buildGenericTemplates(cards);
    let index = 0;
    for (; index < messages.length; index++) {
      const titles = messages[index].attachment.payload.elements
        .map((element) => (element as { title?: string }).title ?? "")
        .join(" · ");
      try {
        await sendTracked(conversation, { text: titles, attachmentType: PICTURES }, sendCards(messages[index]));
        sent += 1;
      } catch (error) {
        if (!(error instanceof FacebookApiError) || error.kind !== "invalid_request") return stop(error);
        break;
      }
    }
    if (index === messages.length) continue;
    // Meta refused a template: the remaining pictures one by one, each after its number and name.
    for (const card of cards.slice(index * 10)) {
      try {
        await sendTracked(conversation, { text: card.title, attachmentType: null }, (metadata) =>
          sendMessage(pageId, token, { psid, text: card.title, metadata }).then((result) => result.message_id ?? null)
        );
        await sendTracked(
          conversation,
          { text: null, attachmentType: "image", attachmentUrl: card.imageUrl },
          sendCards(buildImageAttachment(card.imageUrl))
        );
        sent += 1;
      } catch (error) {
        return stop(error);
      }
    }
  }
  return { sent, dropped: dropped.length };
}
