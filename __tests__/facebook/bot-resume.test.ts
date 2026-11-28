import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";

/** The bot takes a conversation back when nobody from the team answers. */
const db = vi.hoisted(() => {
  const db = {
    facebookConversation: { findUnique: vi.fn(), updateMany: vi.fn() },
    facebookConversationEvent: { create: vi.fn() },
    facebookMessage: { findFirst: vi.fn(), findUnique: vi.fn(), count: vi.fn() },
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation((fn: (tx: typeof db) => unknown) => fn(db));
  return db;
});
const queue = vi.hoisted(() => ({ add: vi.fn() }));
const settings = vi.hoisted(() => ({ value: { enabled: true, resumeAfterMinutes: 20, resumeAfterMessages: 3 } }));
vi.mock("@/lib/db/client", () => ({ prisma: db }));
vi.mock("@/lib/bot/knowledge", () => ({ getBotSettings: async () => settings.value }));
vi.mock("@/lib/facebook/queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/facebook/queue")>()),
  getFacebookQueue: () => queue,
}));

import { processBotResumeJob, scheduleBotResume } from "../../lib/facebook/bot-resume";
import { botReplyJobId, botResumeJobId, FB_BOT_REPLY_JOB, FB_BOT_RESUME_JOB, type FacebookBotResumeJob } from "../../lib/facebook/queue";

const PAGE = { id: "fp_1", workspaceId: "ws_a", status: "ACTIVE", botEnabled: true };
const TOOK_OVER = new Date("2026-11-26T10:00:00Z");
const CONVERSATION = { id: "conv_1", mode: "HUMAN", needsHuman: false, modeChangedAt: TOOK_OVER };

function job(): Job<FacebookBotResumeJob> {
  return { data: { facebookPageId: "fp_1", conversationId: "conv_1", triggerMid: "m_in_5" } } as Job<FacebookBotResumeJob>;
}

beforeEach(() => {
  vi.clearAllMocks();
  settings.value = { enabled: true, resumeAfterMinutes: 20, resumeAfterMessages: 3 };
  db.facebookConversation.findUnique.mockImplementation(async (args: { include?: unknown }) =>
    args.include ? { ...CONVERSATION, workspaceId: "ws_a", facebookPageId: "fp_1", page: PAGE } : { workspaceId: "ws_a", ...CONVERSATION, handoffCategory: null }
  );
  db.facebookConversation.updateMany.mockResolvedValue({ count: 1 });
  // No reply from the team; the customer's latest message is m_in_5.
  db.facebookMessage.findFirst.mockImplementation(async (args: { where: { direction: string } }) =>
    args.where.direction === "OUTBOUND" ? null : { mid: "m_in_5" }
  );
  db.facebookMessage.findUnique.mockResolvedValue({ sentAt: new Date("2026-11-26T10:05:00Z") });
  db.facebookMessage.count.mockResolvedValue(1);
});

describe("a customer writes while the team has the conversation", () => {
  it("queues the return for the brand's delay", async () => {
    await scheduleBotResume(PAGE, CONVERSATION, "m_in_5");
    expect(db.facebookMessage.count.mock.calls[0][0].where).toEqual({
      conversationId: "conv_1",
      direction: "INBOUND",
      sentAt: { gt: TOOK_OVER },
    });
    expect(queue.add).toHaveBeenCalledWith(
      FB_BOT_RESUME_JOB,
      { facebookPageId: "fp_1", conversationId: "conv_1", triggerMid: "m_in_5" },
      { jobId: botResumeJobId("conv_1", "m_in_5"), delay: 20 * 60_000 }
    );
    expect(db.facebookConversation.updateMany).not.toHaveBeenCalled();
  });

  it("gives it back to the bot at once on the third message in a row, keeping the order so far", async () => {
    db.facebookMessage.count.mockResolvedValue(3);
    await scheduleBotResume(PAGE, CONVERSATION, "m_in_5");
    const update = db.facebookConversation.updateMany.mock.calls[0][0];
    expect(update.data).toMatchObject({ mode: "BOT", modeReason: "AUTO_RESUME", needsHuman: false, handoffCategory: null });
    expect(update.data).not.toHaveProperty("orderDraft");
    expect(db.facebookConversationEvent.create).toHaveBeenCalledWith({
      data: { workspaceId: "ws_a", conversationId: "conv_1", type: "RETURNED_TO_BOT", actorUserId: null, reason: "AUTO_RESUME" },
    });
    expect(queue.add).toHaveBeenCalledWith(
      FB_BOT_REPLY_JOB,
      { facebookPageId: "fp_1", conversationId: "conv_1", triggerMid: "m_in_5" },
      expect.objectContaining({ jobId: botReplyJobId("conv_1", "m_in_5") })
    );
  });

  it("counts from the team's last reply when it is newer than the takeover", async () => {
    const replied = new Date("2026-11-26T10:03:00Z");
    db.facebookMessage.findFirst.mockImplementation(async (args: { where: { direction: string } }) =>
      args.where.direction === "OUTBOUND" ? { sentAt: replied } : { mid: "m_in_5" }
    );
    await scheduleBotResume(PAGE, CONVERSATION, "m_in_5");
    expect(db.facebookMessage.count.mock.calls[0][0].where.sentAt).toEqual({ gt: replied });
  });

  it("does nothing when both rules are off (0)", async () => {
    settings.value = { enabled: true, resumeAfterMinutes: 0, resumeAfterMessages: 0 };
    await scheduleBotResume(PAGE, CONVERSATION, "m_in_5");
    expect(queue.add).not.toHaveBeenCalled();
    expect(db.facebookMessage.count).not.toHaveBeenCalled();
  });
});

describe("the delay passes", () => {
  it("gives it back to the bot when nobody answered", async () => {
    await expect(processBotResumeJob(job())).resolves.toBe("resumed");
    expect(queue.add).toHaveBeenCalledWith(FB_BOT_REPLY_JOB, expect.anything(), expect.anything());
  });

  it("stays with the team when someone answered after the message", async () => {
    db.facebookMessage.findFirst.mockImplementation(async (args: { where: { direction: string } }) =>
      args.where.direction === "OUTBOUND" ? { sentAt: new Date("2026-11-26T10:06:00Z") } : { mid: "m_in_5" }
    );
    await expect(processBotResumeJob(job())).resolves.toBe("answered");
    expect(db.facebookConversation.updateMany).not.toHaveBeenCalled();
  });

  it("does nothing when the bot already has it, or the brand turned the rule off", async () => {
    db.facebookConversation.findUnique.mockResolvedValue({ ...CONVERSATION, mode: "BOT", facebookPageId: "fp_1", workspaceId: "ws_a", page: PAGE });
    await expect(processBotResumeJob(job())).resolves.toBe("not_needed");
    settings.value = { enabled: true, resumeAfterMinutes: 0, resumeAfterMessages: 3 };
    await expect(processBotResumeJob(job())).resolves.toBe("disabled");
    expect(queue.add).not.toHaveBeenCalled();
  });
});
