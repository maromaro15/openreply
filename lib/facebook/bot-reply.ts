/**
 * The bot's reply to a conversation, in the Facebook worker.
 *
 * Queued a few seconds after each message (BOT_DEBOUNCE_MS); only the job
 * of the latest message goes on, and answers everything the person wrote
 * since the Page last spoke. It answers only when:
 *   - the bot is on for the brand and for the Page, and the Page works;
 *   - the conversation is with the bot (a person never gets talked over);
 *   - the 24-hour window is open, with 5 minutes to spare;
 *   - fewer than 20 automatic replies went out in the last hour.
 *
 * The reply row is written before the send, unique on the message it
 * answers, so a retried or duplicated job can never reply twice. Anything
 * the bot cannot answer safely is handed to a person: the handoff message
 * goes out once and the team is alerted.
 */
import type { Job } from "bullmq";
import { Prisma, type FacebookConversation, type FacebookMessage, type FacebookPage } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import { getBotHistoryMessages, getBotMaxFullCards } from "@/lib/ai/env";
import { enqueueHandoffAlerts } from "@/lib/alerts/dispatch";
import { answerCustomer } from "@/lib/bot/answer";
import { SYSTEM_REASONS, type BotDecision } from "@/lib/bot/classify";
import { getBotSettings, listKnowledge, type BotSettingsView } from "@/lib/bot/knowledge";
import { mergeOrder, parseOrderDraft, type OrderDraft } from "@/lib/bot/order";
import { goalCollectsOrder, type CustomerStateValue } from "@/lib/bot/persona";
import { isOrderReady } from "@/lib/bot/persona-store";
import { recognitionPromptLine } from "@/lib/catalog/recognize";
import { IMAGE, parseImageAnalysis, recognizedProductIds } from "./image-recognition";
import { PICTURES, sendBotActions } from "./bot-actions-send";
import { loadCatalogForBot, rememberFocus } from "@/lib/catalog/bot";
import {
  buildCatalogSection,
  catalogReferenceTexts,
  mentionedProductIds,
  selectCardProducts,
} from "@/lib/catalog/prompt";
import type { PromptMessage } from "@/lib/bot/prompt";
import { landingUrlFor } from "./comments";
import { isUniqueViolation, messagePreview, touchLastMessage } from "./conversations";
import { messageMetadata } from "./echoes";
import { FacebookApiError, sendMessage } from "./graph";
import { handOffConversation } from "./handoff";
import { pageToken } from "./pages";
import { botReplyJobId, FB_BOT_REPLY_JOB, getFacebookQueue, type FacebookBotReplyJob } from "./queue";
import { isBotWindowOpen } from "./window";

export const MAX_BOT_REPLIES_PER_HOUR = 20;
/** A voice message being transcribed: wait for it, 5 s at a time, 3 minutes at most. */
export const TRANSCRIPT_WAIT_MS = 5_000;
export const MAX_TRANSCRIPT_WAITS = 36;
const HOUR_MS = 60 * 60 * 1000;
/** Attachments the bot cannot read: a person looks at them. */
const STICKER = "sticker";
const AUDIO = "audio";

export type BotReplyOutcome =
  | "ignored"
  | "disabled"
  | "not_bot"
  | "superseded"
  | "duplicate"
  | "window_closed"
  | "nothing_to_answer"
  | "sticker_only"
  | "waiting_transcript"
  | "replied"
  | "order_ready"
  | "handed_off"
  | "unconfirmed"
  | "failed";

type Conversation = FacebookConversation & { page: FacebookPage };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

/** The conversation as the model reads it. Failed sends never reached the person. */
export function toPromptMessages(messages: FacebookMessage[]): PromptMessage[] {
  const result: PromptMessage[] = [];
  for (const message of messages) {
    if (message.direction === "INBOUND") {
      if (message.attachmentType === AUDIO) {
        result.push(
          message.transcript
            ? { from: "customer", text: message.transcript, voice: true }
            : { from: "customer", text: "[sent a voice message that could not be transcribed]" }
        );
        if (message.text) result.push({ from: "customer", text: message.text });
        continue;
      }
      if (message.attachmentType === IMAGE) {
        // What the code read from the photo, in the line the model must act on.
        const analysis = parseImageAnalysis(message.imageAnalysis);
        const seen = analysis?.status === "DONE" ? ` ${recognitionPromptLine(analysis.recognition)}` : "";
        result.push({ from: "customer", text: `[sent a photo]${seen}` });
        if (message.text) result.push({ from: "customer", text: message.text });
        continue;
      }
      if (message.text) result.push({ from: "customer", text: message.text });
      else if (message.attachmentType === STICKER) result.push({ from: "customer", text: "[sent a sticker]" });
      else if (message.attachmentType) result.push({ from: "customer", text: `[sent a ${message.attachmentType}]` });
      continue;
    }
    if (message.sendStatus === "FAILED" || message.sendStatus === "PENDING") continue;
    const by = message.author === "BOT" ? "bot" : message.author === "CAMPAIGN" ? "campaign" : "person";
    // The pictures sent after a reply (phase 13), or a picture a person sent.
    if (message.attachmentType === PICTURES) {
      result.push({ from: "page", by, text: `[sent pictures: ${message.text ?? ""}]` });
      continue;
    }
    if (message.attachmentType === IMAGE && !message.text) {
      result.push({ from: "page", by, text: "[sent a picture]" });
      continue;
    }
    if (message.text) result.push({ from: "page", by, text: message.text });
  }
  return result;
}

/**
 * What the person sent that nobody answered yet. The bot's last answer covers
 * the messages up to the one it was claimed on, by Meta's clock, not by when
 * the answer left: a message written while the bot was thinking still waits.
 * A person's or a campaign's message covers everything before it. The bot's
 * pictures answer nothing by themselves.
 */
async function pendingMessages(conversationId: string): Promise<FacebookMessage[]> {
  const [lastClaim, lastOther] = await Promise.all([
    prisma.facebookMessage.findFirst({
      where: { conversationId, direction: "OUTBOUND", author: "BOT", replyToMid: { not: null }, sendStatus: { not: "FAILED" } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { replyToMid: true },
    }),
    prisma.facebookMessage.findFirst({
      where: { conversationId, direction: "OUTBOUND", author: { not: "BOT" }, sendStatus: { not: "FAILED" } },
      orderBy: [{ sentAt: "desc" }, { createdAt: "desc" }],
      select: { sentAt: true },
    }),
  ]);
  const answered = lastClaim?.replyToMid
    ? await prisma.facebookMessage.findFirst({
        where: { conversationId, direction: "INBOUND", mid: lastClaim.replyToMid },
        select: { sentAt: true },
      })
    : null;
  const cutoffs = [answered?.sentAt, lastOther?.sentAt].filter((date): date is Date => date instanceof Date);
  const cutoff = cutoffs.length ? new Date(Math.max(...cutoffs.map((date) => date.getTime()))) : null;
  return prisma.facebookMessage.findMany({
    where: {
      conversationId,
      direction: "INBOUND",
      ...(cutoff ? { sentAt: { gt: cutoff } } : {}),
    },
    orderBy: [{ sentAt: "asc" }, { createdAt: "asc" }],
    take: 50,
  });
}

/** The newest message the person sent: the one whose job answers everything before it. */
async function latestInboundMid(conversationId: string): Promise<string | null> {
  const latest = await prisma.facebookMessage.findFirst({
    where: { conversationId, direction: "INBOUND" },
    orderBy: [{ sentAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
    select: { mid: true },
  });
  return latest?.mid ?? null;
}

/** A complete order goes to a person, told apart by the brand's goal. */
function orderReadyHandoffOf(settings: BotSettingsView) {
  const reason =
    goalCollectsOrder(settings.persona.goal) && settings.orderFields.length > 0
      ? SYSTEM_REASONS.orderReady
      : SYSTEM_REASONS.readyToBuy;
  return { kind: "handoff", category: "ORDER_READY", reason, source: "system" } as const;
}

/** Send one bot message, claimed on the trigger. Outcome of the send only. */
async function sendClaimed(
  conversation: Conversation,
  triggerMid: string,
  text: string
): Promise<{ status: "sent" } | { status: "duplicate" } | { status: "error"; error: FacebookApiError; rowId: string }> {
  let row: FacebookMessage;
  try {
    row = await prisma.facebookMessage.create({
      data: {
        workspaceId: conversation.workspaceId,
        conversationId: conversation.id,
        direction: "OUTBOUND",
        author: "BOT",
        origin: "OPENREPLY",
        replyToMid: triggerMid,
        text,
        sendStatus: "PENDING",
      },
    });
  } catch (error) {
    if (isUniqueViolation(error)) return { status: "duplicate" };
    throw error;
  }

  try {
    const result = await sendMessage(conversation.page.pageId, pageToken(conversation.page), {
      psid: conversation.psid,
      text,
      metadata: messageMetadata(row.id),
    });
    const sentAt = new Date();
    try {
      await prisma.facebookMessage.update({
        where: { id: row.id },
        data: { sendStatus: "SENT", mid: result.message_id ?? undefined, sentAt, error: null },
      });
    } catch (error) {
      // Its echo got there first with the same mid.
      if (!isUniqueViolation(error)) throw error;
      await prisma.facebookMessage.update({ where: { id: row.id }, data: { sendStatus: "SENT", sentAt, error: null } });
    }
    await touchLastMessage(conversation.id, sentAt, messagePreview(text), "OUTBOUND");
    return { status: "sent" };
  } catch (error) {
    const fbError =
      error instanceof FacebookApiError ? error : new FacebookApiError(errorText(error), "ambiguous");
    return { status: "error", error: fbError, rowId: row.id };
  }
}

/** Record a send that did not go through. SENT, set by an echo, stays. */
async function settle(rowId: string, error: FacebookApiError) {
  await prisma.facebookMessage.updateMany({
    where: { id: rowId, sendStatus: "PENDING" },
    data: { sendStatus: error.kind === "ambiguous" ? "UNCONFIRMED" : "FAILED", error: error.message },
  });
}

async function markTokenInvalid(page: FacebookPage, error: FacebookApiError) {
  await prisma.facebookPage.update({
    where: { id: page.id },
    data: { status: "TOKEN_INVALID", lastError: error.message },
  });
}

/** Hand the conversation to a person, then tell the customer once. */
async function handOff(
  conversation: Conversation,
  triggerMid: string,
  decision: Extract<BotDecision, { kind: "handoff" }>,
  settings: BotSettingsView,
  { tellCustomer = true }: { tellCustomer?: boolean } = {}
): Promise<BotReplyOutcome> {
  const handoff = await handOffConversation(conversation.id, {
    category: decision.category,
    reason: decision.reason,
  });
  if (!handoff) return "not_bot";
  if (decision.detail) {
    console.log(`[Facebook bot] ${conversation.id} handed off (${decision.source}): ${decision.detail}`);
  }
  // The team is called first. A failure here must not undo the handoff: the
  // worker's hourly sweep queues alerts that were missed.
  await enqueueHandoffAlerts(handoff.eventId).catch((error) => {
    console.error(`[Facebook bot] Alerts for ${handoff.eventId} not queued:`, error instanceof Error ? error.message : error);
  });

  const fresh = await prisma.facebookPage.findUnique({ where: { id: conversation.page.id }, select: { status: true } });
  if (!tellCustomer || fresh?.status !== "ACTIVE" || !isBotWindowOpen(conversation.lastInboundAt)) {
    return "handed_off";
  }
  const sent = await sendClaimed(conversation, triggerMid, settings.handoffMessage);
  if (sent.status === "error") {
    // The conversation is with a person and they are alerted: no retry.
    await settle(sent.rowId, sent.error);
    if (sent.error.kind === "token_invalid") await markTokenInvalid(conversation.page, sent.error);
  }
  return "handed_off";
}

/**
 * What the model read of the customer, kept whatever happens next: their
 * state on the message it answered and on the conversation (the inbox
 * badge), and the order details collected so far.
 */
async function recordCustomer(
  conversation: Conversation,
  triggerMid: string,
  state: CustomerStateValue | null,
  draft: OrderDraft | null,
  previousDraft: OrderDraft | null
): Promise<void> {
  const data: Prisma.FacebookConversationUpdateInput = {};
  if (state && state !== conversation.customerState) data.customerState = state;
  if (JSON.stringify(draft) !== JSON.stringify(previousDraft)) {
    data.orderDraft = draft ? (draft as unknown as Prisma.InputJsonValue) : Prisma.DbNull;
  }
  if (Object.keys(data).length > 0) await prisma.facebookConversation.update({ where: { id: conversation.id }, data });
  if (state) {
    await prisma.facebookMessage.updateMany({
      where: { conversationId: conversation.id, mid: triggerMid, direction: "INBOUND" },
      data: { customerState: state },
    });
  }
}

export async function processBotReplyJob(job: Job<FacebookBotReplyJob>): Promise<BotReplyOutcome> {
  const { conversationId, triggerMid, facebookPageId } = job.data;
  const conversation = await prisma.facebookConversation.findUnique({
    where: { id: conversationId },
    include: { page: true },
  });
  if (!conversation || conversation.facebookPageId !== facebookPageId) return "ignored";
  const page = conversation.page;
  if (page.status !== "ACTIVE" || !page.accessToken || !page.botEnabled) return "disabled";
  const settings = await getBotSettings(conversation.workspaceId);
  if (!settings.enabled) return "disabled";
  if (conversation.mode !== "BOT" || conversation.needsHuman) return "not_bot";

  // The debounce: a newer message has its own job, which answers both.
  if ((await latestInboundMid(conversationId)) !== triggerMid) return "superseded";

  // A retry, or a stalled job run again, after the reply was claimed.
  const claimed = await prisma.facebookMessage.findFirst({
    where: { conversationId, replyToMid: triggerMid },
    select: { id: true },
  });
  if (claimed) {
    // The reply went out and the job stopped before a complete order reached
    // a person: it still does, without a second message to the customer.
    if (isOrderReady(settings, conversation.customerState, parseOrderDraft(conversation.orderDraft))) {
      const outcome = await handOff(conversation, triggerMid, orderReadyHandoffOf(settings), settings, { tellCustomer: false });
      return outcome === "not_bot" ? "duplicate" : "order_ready";
    }
    return "duplicate";
  }

  if (!isBotWindowOpen(conversation.lastInboundAt)) return "window_closed";

  const pending = await pendingMessages(conversationId);
  if (pending.length === 0) return "nothing_to_answer";
  if (pending.every((message) => !message.text && message.attachmentType === STICKER)) return "sticker_only";

  // A voice message still being transcribed: come back once it is, rather
  // than answer without it. After the last wait it counts as not transcribed.
  const waits = job.data.waits ?? 0;
  const stillReading = (message: FacebookMessage) =>
    (message.attachmentType === AUDIO && message.transcriptStatus === "PENDING") ||
    (message.attachmentType === IMAGE && parseImageAnalysis(message.imageAnalysis)?.status === "PENDING");
  if (waits < MAX_TRANSCRIPT_WAITS && pending.some(stillReading)) {
    await getFacebookQueue().add(
      FB_BOT_REPLY_JOB,
      { ...job.data, waits: waits + 1 },
      { jobId: `${botReplyJobId(conversationId, triggerMid)}_w${waits + 1}`, delay: TRANSCRIPT_WAIT_MS }
    );
    return "waiting_transcript";
  }

  const handoffBy = (category: "OTHER" | "AUDIO_FAILED", reason: string) =>
    handOff(conversation, triggerMid, { kind: "handoff", category, reason, source: "system" }, settings);

  // A photo the code could read goes to the model; a video, a file, or a
  // photo that could not be read goes to a person.
  if (
    pending.some(
      (message) =>
        (message.attachmentType && ![STICKER, AUDIO, IMAGE].includes(message.attachmentType)) ||
        (message.attachmentType === IMAGE && parseImageAnalysis(message.imageAnalysis)?.status !== "DONE")
    )
  ) {
    return handoffBy("OTHER", SYSTEM_REASONS.attachment);
  }
  if (pending.some((message) => message.attachmentType === AUDIO && message.transcriptStatus !== "DONE")) {
    return handoffBy("AUDIO_FAILED", SYSTEM_REASONS.audio);
  }
  const lastHour = await prisma.facebookMessage.count({
    // One per turn: the reply or handoff it claimed (`replyToMid`), with any pictures it sent.
    where: { conversationId, author: "BOT", direction: "OUTBOUND", replyToMid: { not: null }, sentAt: { gte: new Date(Date.now() - HOUR_MS) } },
  });
  if (lastHour >= MAX_BOT_REPLIES_PER_HOUR) return handoffBy("OTHER", SYSTEM_REASONS.tooManyReplies);

  const [knowledge, history, campaign, catalog] = await Promise.all([
    listKnowledge(conversation.workspaceId),
    prisma.facebookMessage.findMany({
      where: { conversationId },
      orderBy: [{ sentAt: "desc" }, { createdAt: "desc" }],
      take: getBotHistoryMessages(),
    }),
    conversation.sourceCampaignId
      ? prisma.facebookCampaign.findFirst({
          where: { id: conversation.sourceCampaignId, workspaceId: conversation.workspaceId },
        })
      : Promise.resolve(null),
    loadCatalogForBot(conversation.workspaceId),
  ]);

  // The products this conversation is about: the campaign's, the ones named
  // so far, the ones named now, by the customer or by the Page (an
  // alternative the bot suggested gets its card on the next answer). Their
  // full cards go to the model.
  const messages = toPromptMessages(history.reverse());
  // The products of the customer's photos first: the most recent signals.
  const fromPhotos = history.flatMap((message) => recognizedProductIds(parseImageAnalysis(message.imageAnalysis)));
  const mentioned = [
    ...new Set([
      ...fromPhotos.reverse(),
      ...mentionedProductIds(catalog.products, messages.map((message) => message.text)),
    ]),
  ].filter((id) => catalog.products.some((product) => product.id === id));
  const focus = await rememberFocus(conversation.id, mentioned, conversation.focusProductIds);
  const cards = selectCardProducts(
    catalog.products,
    { campaignProductId: campaign?.productId ?? null, focusIds: focus, mentionedIds: mentioned },
    getBotMaxFullCards()
  );

  const previousDraft = parseOrderDraft(conversation.orderDraft);
  const answer = await answerCustomer({
    businessName: settings.businessName,
    pageName: page.name,
    instructions: settings.instructions,
    knowledge,
    campaign: campaign
      ? { name: campaign.name, botContext: campaign.botContext, landingUrl: landingUrlFor(campaign) }
      : null,
    history: messages,
    catalogSection: buildCatalogSection(catalog.products, cards, catalog.attributes),
    catalogReference: catalogReferenceTexts(catalog.products, cards, catalog.attributes),
    persona: settings.persona,
    order: { fields: settings.orderFields, draft: previousDraft },
  });
  if (answer.error) console.warn(`[Facebook bot] ${conversationId}: ${answer.error}`);
  // The customer wrote again while the model was thinking: that message's own
  // job answers both, so this answer is dropped before anything is stored or sent.
  if ((await latestInboundMid(conversationId)) !== triggerMid) return "superseded";

  // The order details the customer gave, merged and checked by the code:
  // the model only reports them.
  const draft =
    goalCollectsOrder(settings.persona.goal) && answer.order
      ? // An order with nothing in it yet is no order: nothing is stored.
        parseOrderDraft(mergeOrder(previousDraft, answer.order, { products: catalog.products, focusIds: focus }))
      : previousDraft;
  await recordCustomer(conversation, triggerMid, answer.customerState, draft, previousDraft);
  const orderReady = isOrderReady(settings, answer.customerState, draft);
  const orderReadyHandoff = orderReadyHandoffOf(settings);

  if (answer.decision.kind === "handoff") {
    // A complete order outranks a refused reply or a failure: a person
    // confirms it. The model's own reasons (a complaint, wholesale...) stay.
    const decision = orderReady && answer.decision.source !== "model" ? orderReadyHandoff : answer.decision;
    return handOff(conversation, triggerMid, decision, settings);
  }

  // The model took a few seconds: is the conversation still the bot's?
  const fresh = await prisma.facebookConversation.findUnique({
    where: { id: conversationId },
    select: { mode: true, needsHuman: true, lastInboundAt: true },
  });
  if (!fresh || fresh.mode !== "BOT" || fresh.needsHuman) return "not_bot";
  if (!isBotWindowOpen(fresh.lastInboundAt)) return "window_closed";

  const sent = await sendClaimed(conversation, triggerMid, answer.decision.text);
  if (sent.status === "sent") {
    // The pictures or the comparison it asked for, after its words.
    if (answer.actions.length) await sendBotActions(conversation, answer.actions);
    if (!orderReady) return "replied";
    // The reply thanked the customer: the team is told, the customer is not again.
    await handOff(conversation, triggerMid, orderReadyHandoff, settings, { tellCustomer: false });
    return "order_ready";
  }
  if (sent.status === "duplicate") return "duplicate";

  const error = sent.error;
  if (error.kind === "ambiguous") {
    // It may have been delivered: never sent a second time.
    await settle(sent.rowId, error);
    if (orderReady) await handOff(conversation, triggerMid, orderReadyHandoff, settings, { tellCustomer: false });
    return "unconfirmed";
  }
  if (error.kind === "unreachable" || error.kind === "rate_limit") {
    // Nothing went out: free the claim and let BullMQ try again later.
    await prisma.facebookMessage.deleteMany({ where: { id: sent.rowId, sendStatus: "PENDING" } });
    if (job.attemptsMade + 1 < (job.opts.attempts ?? 1)) throw error;
    return handOff(
      conversation,
      triggerMid,
      orderReady
        ? orderReadyHandoff
        : { kind: "handoff", category: "OTHER", reason: SYSTEM_REASONS.facebookUnreachable, source: "system" },
      settings,
      { tellCustomer: false }
    );
  }
  await settle(sent.rowId, error);
  if (error.kind === "token_invalid") await markTokenInvalid(page, error);
  // Refused for good (the window, the person's settings, a dead token...): a
  // person takes over, and a complete order still reaches the team. Telling
  // the customer would be refused the same way.
  await handOff(
    conversation,
    triggerMid,
    orderReady
      ? orderReadyHandoff
      : {
          kind: "handoff",
          category: "OTHER",
          reason: error.kind === "token_invalid" ? SYSTEM_REASONS.tokenInvalid : SYSTEM_REASONS.replyRefused,
          source: "system",
        },
    settings,
    { tellCustomer: false }
  );
  return "failed";
}
