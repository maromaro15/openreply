import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";
import { Prisma } from "../../app/generated/prisma/client";

const db = vi.hoisted(() => ({
  facebookPage: { findUnique: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
  facebookConversation: {
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    upsert: vi.fn(),
  },
  facebookMessage: {
    create: vi.fn(),
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    count: vi.fn(),
  },
  facebookCommentLog: { findFirst: vi.fn(), updateMany: vi.fn() },
  facebookCampaign: { findUnique: vi.fn() },
  facebookConversationEvent: { create: vi.fn() },
  facebookWebhookEvent: { create: vi.fn(), updateMany: vi.fn() },
  $transaction: vi.fn(),
}));
const graph = vi.hoisted(() => ({ getMessengerProfileName: vi.fn() }));
const queue = vi.hoisted(() => ({ add: vi.fn() }));

vi.mock("@/lib/db/client", () => ({ prisma: db }));
vi.mock("@/lib/facebook/graph", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/facebook/graph")>()),
  ...graph,
}));
vi.mock("@/lib/facebook/pages", () => ({ pageToken: () => "PAGE_TOKEN" }));
vi.mock("@/lib/facebook/queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/facebook/queue")>()),
  getFacebookQueue: () => queue,
}));

import { processMessageJob, primaryAttachment } from "../../lib/facebook/messages";
import { ingestPageWebhook } from "../../lib/facebook/ingest";
import { dispatchFacebookJob } from "../../lib/facebook/worker";
import { messageJobId, type FacebookMessageJob } from "../../lib/facebook/queue";
import {
  BOT_WINDOW_MARGIN_MS,
  humanReplyPolicy,
  isBotWindowOpen,
  STANDARD_WINDOW_MS,
} from "../../lib/facebook/window";

const NOW = new Date("2026-11-25T12:00:00Z");
const APP_ID = "1517776481860111";
const PAGE = { id: "fp_1", pageId: "1001", workspaceId: "ws_a", status: "ACTIVE", accessToken: "enc" };

function conversation(overrides: Record<string, unknown> = {}) {
  return {
    id: "conv_1",
    workspaceId: "ws_a",
    facebookPageId: "fp_1",
    psid: "psid_1",
    userName: null,
    mode: "BOT",
    needsHuman: false,
    ...overrides,
  };
}

function job(overrides: Partial<FacebookMessageJob> = {}) {
  return {
    id: "fbm_1",
    name: "fb-message",
    data: {
      facebookPageId: "fp_1",
      pageId: "1001",
      kind: "message",
      psid: "psid_1",
      mid: "m_in_1",
      text: "شحال السعر؟",
      attachments: [],
      sentAt: "2026-11-25T11:59:00.000Z",
      ...overrides,
    },
  } as unknown as Job<FacebookMessageJob>;
}

function echo(overrides: Partial<FacebookMessageJob> = {}) {
  return job({ kind: "echo", mid: "m_out_1", text: "السعر 2500 دج", ...overrides });
}

function uniqueViolation() {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "7" });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("FACEBOOK_APP_ID", APP_ID);
  db.$transaction.mockImplementation(async (fn: (tx: typeof db) => unknown) => fn(db));
  db.facebookPage.findUnique.mockResolvedValue(PAGE);
  db.facebookConversation.findUnique.mockResolvedValue(conversation());
  db.facebookConversation.update.mockResolvedValue({});
  db.facebookConversation.updateMany.mockResolvedValue({ count: 1 });
  db.facebookMessage.create.mockResolvedValue({ id: "msg_1" });
  db.facebookMessage.findUnique.mockResolvedValue(null);
  db.facebookMessage.updateMany.mockResolvedValue({ count: 1 });
  db.facebookMessage.count.mockResolvedValue(1);
  db.facebookConversationEvent.create.mockResolvedValue({});
  graph.getMessengerProfileName.mockResolvedValue("Amina Benali");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

/** Calls of conversation.updateMany that set a given field. */
function conversationUpdatesOf(field: string) {
  return db.facebookConversation.updateMany.mock.calls
    .map(([args]) => args as { where: Record<string, unknown>; data: Record<string, unknown> })
    .filter((args) => field in args.data);
}

describe("a message from a person", () => {
  it("is stored once, refreshes the 24-hour window and counts as unread", async () => {
    await expect(processMessageJob(job())).resolves.toBe("stored");
    expect(db.facebookMessage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "ws_a",
        conversationId: "conv_1",
        direction: "INBOUND",
        author: "CUSTOMER",
        mid: "m_in_1",
        text: "شحال السعر؟",
        sentAt: new Date("2026-11-25T11:59:00.000Z"),
      }),
    });
    expect(db.facebookConversation.update).toHaveBeenCalledWith({
      where: { id: "conv_1" },
      data: { unreadCount: { increment: 1 } },
    });
    // The window moves forward only: an older message finishing late never
    // shortens it.
    expect(conversationUpdatesOf("lastInboundAt")).toEqual([
      {
        where: {
          id: "conv_1",
          OR: [{ lastInboundAt: null }, { lastInboundAt: { lt: new Date("2026-11-25T11:59:00.000Z") } }],
        },
        data: { lastInboundAt: new Date("2026-11-25T11:59:00.000Z") },
      },
    ]);
    expect(conversationUpdatesOf("lastMessageText")[0].data).toEqual({
      lastMessageAt: new Date("2026-11-25T11:59:00.000Z"),
      lastMessageText: "شحال السعر؟",
    });
  });

  it("does nothing more when a webhook retry brings it again", async () => {
    db.facebookMessage.create.mockRejectedValue(uniqueViolation());
    await expect(processMessageJob(job())).resolves.toBe("duplicate");
    expect(db.facebookConversation.update).not.toHaveBeenCalled();
    expect(db.facebookConversation.updateMany).not.toHaveBeenCalled();
    expect(graph.getMessengerProfileName).not.toHaveBeenCalled();
  });

  it("opens the conversation on first contact, even when two jobs race to create it", async () => {
    db.facebookConversation.findUnique.mockResolvedValue(null);
    db.facebookConversation.create.mockRejectedValue(uniqueViolation());
    db.facebookConversation.findUniqueOrThrow.mockResolvedValue(conversation());
    await expect(processMessageJob(job())).resolves.toBe("stored");
    expect(db.facebookConversation.create).toHaveBeenCalledWith({
      data: { workspaceId: "ws_a", facebookPageId: "fp_1", psid: "psid_1" },
    });
    expect(db.facebookMessage.create).toHaveBeenCalledTimes(1);
  });

  it("looks the name up once, on the person's first message", async () => {
    await processMessageJob(job());
    expect(graph.getMessengerProfileName).toHaveBeenCalledWith("psid_1", "PAGE_TOKEN");
    expect(db.facebookConversation.updateMany).toHaveBeenCalledWith({
      where: { id: "conv_1", userName: null },
      data: { userName: "Amina Benali" },
    });

    vi.clearAllMocks();
    db.facebookConversation.updateMany.mockResolvedValue({ count: 1 });
    db.facebookMessage.count.mockResolvedValue(2);
    await processMessageJob(job({ mid: "m_in_2" }));
    expect(graph.getMessengerProfileName).not.toHaveBeenCalled();
  });

  it("keeps the commenter's name when the thread started from a comment", async () => {
    db.facebookConversation.findUnique.mockResolvedValue(conversation({ userName: "Amina B." }));
    await processMessageJob(job());
    expect(db.facebookMessage.count).not.toHaveBeenCalled();
    expect(graph.getMessengerProfileName).not.toHaveBeenCalled();
  });

  it("still stores messages while the Page token waits to be renewed, without calling Meta", async () => {
    db.facebookPage.findUnique.mockResolvedValue({ ...PAGE, status: "TOKEN_INVALID" });
    await expect(processMessageJob(job())).resolves.toBe("stored");
    expect(graph.getMessengerProfileName).not.toHaveBeenCalled();
  });

  it("ignores a disconnected Page and a job whose Page ID does not match", async () => {
    db.facebookPage.findUnique.mockResolvedValue({ ...PAGE, status: "DISCONNECTED" });
    await expect(processMessageJob(job())).resolves.toBe("ignored");
    db.facebookPage.findUnique.mockResolvedValue({ ...PAGE, pageId: "2002" });
    await expect(processMessageJob(job())).resolves.toBe("ignored");
    expect(db.facebookMessage.create).not.toHaveBeenCalled();
  });

  it("keeps stickers, images and voice messages with their kind and a neutral preview", async () => {
    await processMessageJob(
      job({ text: undefined, isSticker: true, attachments: [{ type: "image", url: "https://cdn/x.png", stickerId: "369239263222822" }] })
    );
    expect(db.facebookMessage.create.mock.calls[0][0].data).toMatchObject({
      text: null,
      attachmentType: "sticker",
      attachmentUrl: "https://cdn/x.png",
    });
    expect(conversationUpdatesOf("lastMessageText")[0].data.lastMessageText).toBe("🙂");

    vi.clearAllMocks();
    db.facebookConversation.updateMany.mockResolvedValue({ count: 1 });
    await processMessageJob(job({ mid: "m_audio", text: undefined, attachments: [{ type: "audio", url: "https://cdn/a.mp4" }] }));
    expect(db.facebookMessage.create.mock.calls[0][0].data).toMatchObject({
      attachmentType: "audio",
      attachmentUrl: "https://cdn/a.mp4",
    });
    expect(conversationUpdatesOf("lastMessageText")[0].data.lastMessageText).toBe("🎤");
  });

  it("names the first attachment for the inbox", () => {
    expect(primaryAttachment({ attachments: [], isSticker: false })).toBeNull();
    expect(primaryAttachment({ attachments: [{ type: "video", url: "https://cdn/v" }] })).toEqual({
      type: "video",
      url: "https://cdn/v",
    });
  });
});

describe("an echo of a message the Page sent", () => {
  it("of our inbox or bot message: saves its mid and proves delivery, and nothing changes hands", async () => {
    db.facebookMessage.findFirst.mockResolvedValue({ id: "msg_7", mid: null });
    await expect(processMessageJob(echo({ metadata: "openreply:msg_7", appId: APP_ID }))).resolves.toBe("reconciled");
    expect(db.facebookMessage.findFirst).toHaveBeenCalledWith({
      where: { id: "msg_7", conversation: { facebookPageId: "fp_1" } },
      select: { id: true, mid: true },
    });
    expect(db.facebookMessage.update).toHaveBeenCalledWith({ where: { id: "msg_7" }, data: { mid: "m_out_1" } });
    expect(db.facebookMessage.updateMany).toHaveBeenCalledWith({
      where: { id: "msg_7", sendStatus: { in: ["PENDING", "UNCONFIRMED", "FAILED"] } },
      data: { sendStatus: "SENT", error: null },
    });
    expect(db.facebookMessage.create).not.toHaveBeenCalled();
    expect(db.facebookConversationEvent.create).not.toHaveBeenCalled();
  });

  it("is recognised by its metadata even before the sender saved the mid (the race)", async () => {
    db.facebookMessage.findUnique.mockResolvedValue(null);
    db.facebookMessage.findFirst.mockResolvedValue({ id: "msg_7", mid: null });
    await expect(processMessageJob(echo({ metadata: "openreply:msg_7" }))).resolves.toBe("reconciled");
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("of a private reply left UNCONFIRMED: confirms it and opens the conversation with the PSID", async () => {
    db.facebookCommentLog.findFirst.mockResolvedValue({
      id: "log_1",
      campaignId: "camp_1",
      commentId: "1001_c1",
      commenterName: "Amina B.",
      status: "UNCONFIRMED",
      privateReplyMessageId: null,
    });
    db.facebookCommentLog.updateMany.mockResolvedValue({ count: 1 });
    db.facebookCampaign.findUnique.mockResolvedValue({
      id: "camp_1",
      name: "Robe",
      landingUrl: "https://shop.example/robe",
      addUtm: false,
      privateReplyMessage: "مرحبا {name}",
    });
    db.facebookConversation.upsert.mockResolvedValue(conversation({ userName: "Amina B." }));

    await expect(processMessageJob(echo({ metadata: "openreply:c:log_1", appId: APP_ID }))).resolves.toBe("reconciled");
    expect(db.facebookCommentLog.updateMany).toHaveBeenCalledWith({
      where: { id: "log_1", status: { not: "SENT" } },
      data: expect.objectContaining({
        status: "SENT",
        deliveryUnconfirmed: false,
        privateReplyMessageId: "m_out_1",
        recipientPsid: "psid_1",
      }),
    });
    expect(db.facebookConversation.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { facebookPageId_psid: { facebookPageId: "fp_1", psid: "psid_1" } },
        create: expect.objectContaining({ sourceCampaignId: "camp_1", sourceCommentId: "1001_c1" }),
      })
    );
    expect(db.facebookMessage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        author: "CAMPAIGN",
        mid: "m_out_1",
        text: "مرحبا Amina\nhttps://shop.example/robe",
      }),
    });
  });

  it("of a private reply already SENT: only fills in its mid", async () => {
    db.facebookCommentLog.findFirst.mockResolvedValue({ id: "log_1", status: "SENT", privateReplyMessageId: null });
    db.facebookCommentLog.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    await processMessageJob(echo({ metadata: "openreply:c:log_1" }));
    expect(db.facebookCommentLog.updateMany).toHaveBeenLastCalledWith({
      where: { id: "log_1", privateReplyMessageId: null },
      data: { privateReplyMessageId: "m_out_1" },
    });
    expect(db.facebookConversation.upsert).not.toHaveBeenCalled();
  });

  it("never touches another Page's rows, whatever the metadata says", async () => {
    db.facebookCommentLog.findFirst.mockResolvedValue(null);
    await expect(processMessageJob(echo({ metadata: "openreply:c:log_of_other_brand" }))).resolves.toBe(
      "unknown_reference"
    );
    expect(db.facebookCommentLog.findFirst).toHaveBeenCalledWith({
      where: { id: "log_of_other_brand", facebookPageId: "fp_1" },
    });
    expect(db.facebookCommentLog.updateMany).not.toHaveBeenCalled();
  });

  it("sent by this app without metadata, or with a mid we saved: ours, nothing is recorded", async () => {
    await expect(processMessageJob(echo({ appId: APP_ID }))).resolves.toBe("reconciled");
    db.facebookMessage.findUnique.mockResolvedValue({ id: "msg_9" });
    await expect(processMessageJob(echo({ appId: "263902037430900" }))).resolves.toBe("reconciled");
    expect(db.facebookMessage.create).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("typed by a person in Meta Business Suite: stored as HUMAN and the conversation goes to HUMAN", async () => {
    await expect(processMessageJob(echo({ appId: "263902037430900" }))).resolves.toBe("human_reply");
    expect(db.facebookMessage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        direction: "OUTBOUND",
        author: "HUMAN",
        origin: "EXTERNAL",
        echoAppId: "263902037430900",
        mid: "m_out_1",
        text: "السعر 2500 دج",
        sendStatus: "SENT",
      }),
    });
    expect(db.facebookConversation.updateMany).toHaveBeenCalledWith({
      where: { id: "conv_1", mode: "BOT", needsHuman: false },
      data: expect.objectContaining({ mode: "HUMAN", modeReason: "META_REPLY", needsHuman: false }),
    });
    expect(db.facebookConversationEvent.create).toHaveBeenCalledWith({
      data: {
        workspaceId: "ws_a",
        conversationId: "conv_1",
        type: "HUMAN_TAKEOVER",
        reason: "META_REPLY",
        actorUserId: null,
      },
    });
    // The window is the customer's: a reply from the Page never extends it.
    expect(conversationUpdatesOf("lastInboundAt")).toEqual([]);
    expect(conversationUpdatesOf("lastOutboundAt")).toHaveLength(1);
  });

  it("from a person answering a handed-off conversation: clears 'needs a person' with one event", async () => {
    const handedOff = { workspaceId: "ws_a", mode: "HUMAN", needsHuman: true };
    db.facebookConversation.findUnique
      .mockResolvedValueOnce(conversation(handedOff))
      .mockResolvedValueOnce(handedOff);
    await processMessageJob(echo());
    expect(db.facebookConversation.updateMany).toHaveBeenCalledWith({
      where: { id: "conv_1", mode: "HUMAN", needsHuman: true },
      data: expect.objectContaining({ mode: "HUMAN", needsHuman: false }),
    });
    expect(db.facebookConversationEvent.create).toHaveBeenCalledTimes(1);
  });

  it("from a person, in a conversation people already handle: no new event", async () => {
    const withPerson = { workspaceId: "ws_a", mode: "HUMAN", needsHuman: false };
    db.facebookConversation.findUnique
      .mockResolvedValueOnce(conversation(withPerson))
      .mockResolvedValueOnce(withPerson);
    await expect(processMessageJob(echo())).resolves.toBe("human_reply");
    expect(db.facebookConversationEvent.create).not.toHaveBeenCalled();
  });

  it("from a person, delivered twice: stored once and taken over once", async () => {
    db.facebookMessage.create.mockRejectedValue(uniqueViolation());
    await expect(processMessageJob(echo())).resolves.toBe("duplicate");
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("when two takeovers race, only the one that changed the row records an event", async () => {
    db.facebookConversation.updateMany.mockImplementation(async (args: { where: Record<string, unknown> }) =>
      "mode" in args.where ? { count: 0 } : { count: 1 }
    );
    await processMessageJob(echo());
    expect(db.facebookConversationEvent.create).not.toHaveBeenCalled();
  });
});

describe("webhook → queue", () => {
  const ACTIVE = { id: "fp_1", pageId: "1001", workspaceId: "ws_a", status: "ACTIVE" };

  beforeEach(() => {
    db.facebookPage.findMany.mockResolvedValue([ACTIVE]);
    db.facebookPage.updateMany.mockResolvedValue({ count: 1 });
    db.facebookWebhookEvent.create.mockResolvedValue({ id: "evt_1" });
    db.facebookWebhookEvent.updateMany.mockResolvedValue({ count: 1 });
    queue.add.mockResolvedValue({});
  });

  const payload = {
    object: "page",
    entry: [
      {
        id: "1001",
        time: 1764072000000,
        messaging: [
          {
            sender: { id: "psid_1" },
            recipient: { id: "1001" },
            timestamp: 1764072000000,
            message: { mid: "m_in_1", text: "salam, prix?" },
          },
          {
            sender: { id: "1001" },
            recipient: { id: "psid_1" },
            timestamp: 1764072005000,
            message: { mid: "m_out_1", is_echo: true, app_id: 263902037430900, text: "مرحبا" },
          },
          { sender: { id: "psid_1" }, recipient: { id: "1001" }, timestamp: 1764072006000, read: { watermark: 1 } },
        ],
      },
    ],
  };

  it("queues each message and echo once, with job IDs that a retry cannot duplicate", async () => {
    await expect(ingestPageWebhook(payload)).resolves.toEqual({ pages: 1, comments: 0, messages: 1, echoes: 1 });
    expect(queue.add).toHaveBeenCalledWith(
      "fb-message",
      {
        facebookPageId: "fp_1",
        pageId: "1001",
        kind: "message",
        psid: "psid_1",
        mid: "m_in_1",
        text: "salam, prix?",
        attachments: [],
        sentAt: new Date(1764072000000).toISOString(),
      },
      { jobId: messageJobId("1001", "m_in_1", "message") }
    );
    expect(queue.add).toHaveBeenCalledWith(
      "fb-message",
      expect.objectContaining({ kind: "echo", psid: "psid_1", mid: "m_out_1", appId: "263902037430900" }),
      { jobId: messageJobId("1001", "m_out_1", "echo") }
    );
    expect(messageJobId("1001", "m_in_1")).not.toBe(messageJobId("1001", "m_in_1", "echo"));
    expect(messageJobId("1001", "m_a:b")).not.toContain(":");
  });

  it("keeps messages for a Page whose token died, where comments wait", async () => {
    db.facebookPage.findMany.mockResolvedValue([{ ...ACTIVE, status: "TOKEN_INVALID" }]);
    await expect(ingestPageWebhook(payload)).resolves.toMatchObject({ messages: 1, echoes: 1 });
  });

  it("runs message jobs in the Facebook worker", async () => {
    db.facebookPage.findUnique.mockResolvedValue(null);
    await expect(dispatchFacebookJob(job())).resolves.toBe("ignored");
  });
});

describe("the messaging windows", () => {
  const last = new Date("2026-11-25T00:00:00Z");

  it("lets the bot answer until 5 minutes before the 24 hours run out", () => {
    const end = last.getTime() + STANDARD_WINDOW_MS;
    expect(isBotWindowOpen(null, end - 60 * 60_000)).toBe(false);
    expect(isBotWindowOpen(last, end - BOT_WINDOW_MARGIN_MS - 1)).toBe(true);
    expect(isBotWindowOpen(last, end - BOT_WINDOW_MARGIN_MS)).toBe(false);
  });

  it("lets a person reply within 24 hours, never before the person wrote", () => {
    expect(humanReplyPolicy(null, { now: last.getTime(), humanAgentTag: false })).toEqual({
      canReply: false,
      reason: "no_inbound",
      endsAt: null,
    });
    expect(humanReplyPolicy(last, { now: last.getTime() + 23 * 3_600_000, humanAgentTag: false })).toEqual({
      canReply: true,
      humanAgentTag: false,
      endsAt: new Date(last.getTime() + STANDARD_WINDOW_MS),
    });
    expect(humanReplyPolicy(last, { now: last.getTime() + 24 * 3_600_000, humanAgentTag: false })).toMatchObject({
      canReply: false,
      reason: "closed",
    });
  });

  it("stretches to 7 days with the HUMAN_AGENT tag, only when it is enabled", () => {
    const day3 = last.getTime() + 3 * 86_400_000;
    expect(humanReplyPolicy(last, { now: day3, humanAgentTag: true })).toMatchObject({
      canReply: true,
      humanAgentTag: true,
    });
    expect(humanReplyPolicy(last, { now: last.getTime() + 7 * 86_400_000, humanAgentTag: true })).toMatchObject({
      canReply: false,
    });
    vi.stubEnv("FACEBOOK_HUMAN_AGENT_TAG", "true");
    expect(humanReplyPolicy(last, { now: day3 })).toMatchObject({ canReply: true, humanAgentTag: true });
    vi.stubEnv("FACEBOOK_HUMAN_AGENT_TAG", "");
    expect(humanReplyPolicy(last, { now: day3 })).toMatchObject({ canReply: false });
  });
});
