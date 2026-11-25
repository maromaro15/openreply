/**
 * The Messenger inbox: listing, reading, and who answers a conversation.
 *
 * A conversation is answered by the bot (mode BOT) or by people (mode
 * HUMAN). It moves to HUMAN when the bot hands it off (lib/bot), when someone
 * clicks "take over" or replies in the inbox, and when a person replies from
 * Meta Business Suite (seen as an echo). Only "return to bot" moves it back.
 *
 * Every change of hands is one row in the timeline. The updates are
 * conditional on the state that was read, so two people (or a person and an
 * echo) acting at the same moment record one event, not two.
 */
import {
  Prisma,
  type FacebookConversation,
  type FacebookConversationEvent,
  type FacebookMessage,
  type HandoffCategory,
} from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import { HANDOFF_CATEGORIES } from "@/lib/handoff/categories";
import { DEFAULT_ORDER_FIELDS, orderSummary, parseOrderDraft, type OrderFieldValue } from "@/lib/bot/order";
import { IMAGE, parseImageAnalysis } from "./image-recognition";
import { humanReplyPolicy, standardWindowEndsAt } from "./window";

// ─── Who answers ────────────────────────────────────────────────────────────

/** A person takes the conversation: the bot stays silent from now on. */
export async function takeOverConversation(
  conversationId: string,
  {
    reason,
    actorUserId = null,
  }: { reason: "INBOX_TAKEOVER" | "META_REPLY"; actorUserId?: string | null }
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const current = await tx.facebookConversation.findUnique({
      where: { id: conversationId },
      select: { workspaceId: true, mode: true, needsHuman: true },
    });
    // Already with a person who is on it: nothing changes hands.
    if (!current || (current.mode === "HUMAN" && !current.needsHuman)) return false;
    const updated = await tx.facebookConversation.updateMany({
      where: { id: conversationId, mode: current.mode, needsHuman: current.needsHuman },
      data: { mode: "HUMAN", modeReason: reason, modeChangedAt: new Date(), needsHuman: false },
    });
    if (updated.count !== 1) return false;
    await tx.facebookConversationEvent.create({
      data: {
        workspaceId: current.workspaceId,
        conversationId,
        type: "HUMAN_TAKEOVER",
        reason,
        actorUserId,
      },
    });
    return true;
  });
}

/** Back to the bot, which answers the next message. Clears the handoff. */
export async function returnConversationToBot(conversationId: string, actorUserId: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const current = await tx.facebookConversation.findUnique({
      where: { id: conversationId },
      select: { workspaceId: true, mode: true, needsHuman: true, handoffCategory: true },
    });
    if (!current || (current.mode === "BOT" && !current.needsHuman && !current.handoffCategory)) return false;
    const updated = await tx.facebookConversation.updateMany({
      where: { id: conversationId, mode: current.mode, needsHuman: current.needsHuman },
      data: {
        mode: "BOT",
        modeReason: "INBOX_RELEASE",
        modeChangedAt: new Date(),
        needsHuman: false,
        handoffCategory: null,
        handoffReason: null,
        handoffAt: null,
        // A new start: the next order is collected from scratch.
        orderDraft: Prisma.DbNull,
      },
    });
    if (updated.count !== 1) return false;
    await tx.facebookConversationEvent.create({
      data: { workspaceId: current.workspaceId, conversationId, type: "RETURNED_TO_BOT", actorUserId },
    });
    return true;
  });
}

export async function markConversationRead(workspaceId: string, conversationId: string): Promise<boolean> {
  const updated = await prisma.facebookConversation.updateMany({
    where: { id: conversationId, workspaceId },
    data: { unreadCount: 0 },
  });
  return updated.count === 1;
}

// ─── Listing ────────────────────────────────────────────────────────────────

export const CONVERSATION_FILTERS = ["needs_human", "all", "bot", "human"] as const;
export type ConversationFilter = (typeof CONVERSATION_FILTERS)[number];

export function isConversationFilter(value: unknown): value is ConversationFilter {
  return typeof value === "string" && (CONVERSATION_FILTERS as readonly string[]).includes(value);
}

export const CONVERSATION_PAGE_SIZE = 30;
export const MAX_CONVERSATIONS = 300;

type ListedConversation = FacebookConversation & { page: { id: string; name: string } };

/** What the browser sees of a conversation: never the PSID or any token. */
export function serializeConversation(conversation: ListedConversation) {
  return {
    id: conversation.id,
    page: { id: conversation.page.id, name: conversation.page.name },
    userName: conversation.userName,
    mode: conversation.mode,
    modeReason: conversation.modeReason,
    needsHuman: conversation.needsHuman,
    handoffCategory: conversation.handoffCategory,
    handoffReason: conversation.handoffReason,
    handoffAt: conversation.handoffAt?.toISOString() ?? null,
    lastMessageText: conversation.lastMessageText,
    lastMessageAt: conversation.lastMessageAt?.toISOString() ?? null,
    lastInboundAt: conversation.lastInboundAt?.toISOString() ?? null,
    windowEndsAt: standardWindowEndsAt(conversation.lastInboundAt)?.toISOString() ?? null,
    unreadCount: conversation.unreadCount,
    customerState: conversation.customerState,
  };
}

export type ConversationListItem = ReturnType<typeof serializeConversation>;

/**
 * The active brand's conversations, most recent first. The list is always
 * read from the top (`limit` grows with "load more"), so the 10-second
 * refresh never skips or repeats a conversation that moved up.
 */
export async function listConversations(
  workspaceId: string,
  {
    filter = "needs_human",
    category = null,
    facebookPageId = null,
    limit = CONVERSATION_PAGE_SIZE,
  }: {
    filter?: ConversationFilter;
    category?: HandoffCategory | null;
    facebookPageId?: string | null;
    limit?: number;
  } = {}
) {
  const take = Math.min(Math.max(1, Math.floor(limit) || CONVERSATION_PAGE_SIZE), MAX_CONVERSATIONS);
  const scope: Prisma.FacebookConversationWhereInput = { workspaceId };
  if (facebookPageId) scope.facebookPageId = facebookPageId;
  const tab: Prisma.FacebookConversationWhereInput = { ...scope };
  if (filter === "needs_human") tab.needsHuman = true;
  else if (filter === "bot") tab.mode = "BOT";
  else if (filter === "human") tab.mode = "HUMAN";

  const [rows, byCategory, needsHuman] = await Promise.all([
    prisma.facebookConversation.findMany({
      where: category ? { ...tab, handoffCategory: category } : tab,
      orderBy: [{ lastMessageAt: { sort: "desc", nulls: "last" } }, { id: "desc" }],
      take: take + 1,
      include: { page: { select: { id: true, name: true } } },
    }),
    // Counts beside each category chip, within the open tab.
    prisma.facebookConversation.groupBy({
      by: ["handoffCategory"],
      where: { ...tab, handoffCategory: { not: null } },
      _count: { _all: true },
    }),
    prisma.facebookConversation.count({ where: { ...scope, needsHuman: true } }),
  ]);

  const categoryCounts = Object.fromEntries(HANDOFF_CATEGORIES.map((value) => [value, 0])) as Record<
    HandoffCategory,
    number
  >;
  for (const group of byCategory) {
    if (group.handoffCategory) categoryCounts[group.handoffCategory] = group._count._all;
  }

  return {
    conversations: rows.slice(0, take).map(serializeConversation),
    hasMore: rows.length > take,
    counts: { needsHuman, byCategory: categoryCounts },
  };
}

// ─── One conversation ───────────────────────────────────────────────────────

export const THREAD_MESSAGE_LIMIT = 200;

type Person = { id: string; name: string | null; email: string | null };

function personLabel(person: Person | undefined): string | null {
  return person ? person.name || person.email : null;
}

/** What the bot read from a customer's photo, for the line under it. */
function photoView(message: FacebookMessage) {
  if (message.attachmentType !== IMAGE) return null;
  const analysis = parseImageAnalysis(message.imageAnalysis);
  if (!analysis) return null;
  if (analysis.status === "PENDING") return { status: "PENDING" as const, kind: null, names: [] as string[], error: null };
  if (analysis.status === "FAILED") return { status: "FAILED" as const, kind: null, names: [] as string[], error: analysis.error };
  const { recognition } = analysis;
  const names =
    recognition.kind === "match"
      ? [recognition.variant ? `${recognition.productName} · ${recognition.variant.code}` : recognition.productName]
      : recognition.kind === "unsure"
        ? [recognition.productName]
        : recognition.kind === "ambiguous"
          ? recognition.options.map((option) =>
              option.variantCode ? `${option.productName} · ${option.variantCode}` : option.productName
            )
          : [];
  return { status: "DONE" as const, kind: recognition.kind, names, error: null };
}

export function serializeMessage(message: FacebookMessage, people: Map<string, Person> = new Map()) {
  return {
    photo: photoView(message),
    id: message.id,
    direction: message.direction,
    author: message.author,
    origin: message.origin,
    text: message.text,
    attachmentType: message.attachmentType,
    attachmentUrl: message.attachmentUrl,
    transcript: message.transcript,
    transcriptStatus: message.transcriptStatus,
    sendStatus: message.sendStatus,
    error: message.error,
    sentAt: message.sentAt.toISOString(),
    sentBy: message.sentByUserId ? personLabel(people.get(message.sentByUserId)) : null,
  };
}

export type ThreadMessage = ReturnType<typeof serializeMessage>;

function serializeEvent(event: FacebookConversationEvent, people: Map<string, Person>) {
  return {
    id: event.id,
    type: event.type,
    category: event.category,
    reason: event.reason,
    actor: event.actorUserId ? personLabel(people.get(event.actorUserId)) : null,
    createdAt: event.createdAt.toISOString(),
  };
}

export type ThreadEvent = ReturnType<typeof serializeEvent>;

export async function getConversationThread(workspaceId: string, conversationId: string) {
  const conversation = await prisma.facebookConversation.findFirst({
    where: { id: conversationId, workspaceId },
    include: {
      page: { select: { id: true, name: true, status: true, botEnabled: true } },
      // The latest ones, shown oldest first.
      messages: { orderBy: [{ sentAt: "desc" }, { createdAt: "desc" }], take: THREAD_MESSAGE_LIMIT },
      events: { orderBy: { createdAt: "desc" }, take: THREAD_MESSAGE_LIMIT },
    },
  });
  if (!conversation) return null;

  const userIds = new Set<string>();
  for (const message of conversation.messages) if (message.sentByUserId) userIds.add(message.sentByUserId);
  for (const event of conversation.events) if (event.actorUserId) userIds.add(event.actorUserId);
  const draft = parseOrderDraft(conversation.orderDraft);
  const [users, campaign, settings] = await Promise.all([
    userIds.size
      ? prisma.user.findMany({ where: { id: { in: [...userIds] } }, select: { id: true, name: true, email: true } })
      : Promise.resolve([] as Person[]),
    conversation.sourceCampaignId
      ? prisma.facebookCampaign.findFirst({
          where: { id: conversation.sourceCampaignId, workspaceId },
          select: { id: true, name: true },
        })
      : Promise.resolve(null),
    draft ? prisma.botSettings.findUnique({ where: { workspaceId }, select: { orderFields: true } }) : Promise.resolve(null),
  ]);
  const orderFields: OrderFieldValue[] = settings?.orderFields ?? [...DEFAULT_ORDER_FIELDS];
  const people = new Map(users.map((user) => [user.id, user]));
  const policy = humanReplyPolicy(conversation.lastInboundAt);

  return {
    conversation: {
      ...serializeConversation(conversation),
      page: { id: conversation.page.id, name: conversation.page.name },
      pageStatus: conversation.page.status,
      pageBotEnabled: conversation.page.botEnabled,
      modeChangedAt: conversation.modeChangedAt?.toISOString() ?? null,
      sourceCampaign: campaign,
      // The order details the bot collected, for the person who confirms it.
      order: draft
        ? orderSummary(draft, orderFields).map(({ field, value }) => ({ field, value }))
        : null,
      reply: policy.canReply
        ? { canReply: true as const, humanAgentTag: policy.humanAgentTag, endsAt: policy.endsAt.toISOString() }
        : { canReply: false as const, reason: policy.reason, endsAt: policy.endsAt?.toISOString() ?? null },
    },
    messages: [...conversation.messages].reverse().map((message) => serializeMessage(message, people)),
    events: [...conversation.events].reverse().map((event) => serializeEvent(event, people)),
  };
}

export type ConversationThread = NonNullable<Awaited<ReturnType<typeof getConversationThread>>>;
