import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";

/** A «نحب هذا» click, from the webhook to the stored message (PLAN.md 6.14). */
const db = vi.hoisted(() => ({
  facebookPage: { findUnique: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
  facebookConversation: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  facebookMessage: { create: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn(), count: vi.fn() },
  facebookWebhookEvent: { create: vi.fn(), updateMany: vi.fn() },
  product: { findFirst: vi.fn() },
  botSettings: { findUnique: vi.fn() },
}));
const queue = vi.hoisted(() => ({ add: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ prisma: db }));
vi.mock("@/lib/facebook/pages", () => ({ pageToken: () => "PAGE_TOKEN" }));
vi.mock("@/lib/facebook/graph", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/facebook/graph")>()),
  getMessengerProfileName: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/facebook/queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/facebook/queue")>()),
  getFacebookQueue: () => queue,
}));

import { ingestPageWebhook } from "../../lib/facebook/ingest";
import { processMessageJob } from "../../lib/facebook/messages";
import { encodeLikePayload } from "../../lib/facebook/postbacks";
import { FB_BOT_REPLY_JOB, FB_MESSAGE_JOB, messageJobId, type FacebookMessageJob } from "../../lib/facebook/queue";
import { PAGE_WEBHOOK_FIELDS } from "../../lib/facebook/env";

const PAGE = { id: "fp_1", pageId: "1001", workspaceId: "ws_a", status: "ACTIVE", accessToken: "enc", botEnabled: true };
const LIKE = encodeLikePayload("prod_wp", "12-04");

function click(postback: Record<string, unknown>, timestamp: number | undefined = 1764072000000) {
  return {
    object: "page",
    entry: [{ id: "1001", time: 1764072000000, messaging: [{ sender: { id: "psid_1" }, recipient: { id: "1001" }, timestamp, postback }] }],
  };
}

function job(overrides: Partial<FacebookMessageJob> = {}) {
  return {
    id: "fbm_1",
    name: FB_MESSAGE_JOB,
    data: {
      facebookPageId: "fp_1", pageId: "1001", kind: "message", psid: "psid_1", mid: "m_pb_1",
      text: "نحب هذا", attachments: [], postback: { payload: LIKE }, sentAt: "2026-11-25T11:59:00.000Z",
      ...overrides,
    },
  } as unknown as Job<FacebookMessageJob>;
}

beforeEach(() => {
  vi.clearAllMocks();
  db.facebookPage.findMany.mockResolvedValue([PAGE]);
  db.facebookPage.findUnique.mockResolvedValue(PAGE);
  db.facebookPage.updateMany.mockResolvedValue({ count: 1 });
  db.facebookWebhookEvent.create.mockResolvedValue({ id: "evt_1" });
  db.facebookWebhookEvent.updateMany.mockResolvedValue({ count: 1 });
  db.facebookConversation.findUnique.mockResolvedValue({
    id: "conv_1", workspaceId: "ws_a", facebookPageId: "fp_1", psid: "psid_1", userName: "Amina",
    mode: "BOT", needsHuman: false, focusProductIds: ["prod_old"],
  });
  db.facebookConversation.update.mockResolvedValue({});
  db.facebookConversation.updateMany.mockResolvedValue({ count: 1 });
  db.facebookMessage.create.mockResolvedValue({ id: "msg_1" });
  db.facebookMessage.count.mockResolvedValue(2);
  db.product.findFirst.mockResolvedValue({ id: "prod_wp", name: "Papier peint 3D", variants: [{ code: "12-04", name: "Gris" }] });
  db.botSettings.findUnique.mockResolvedValue({ enabled: true });
  queue.add.mockResolvedValue({});
});
afterEach(() => vi.unstubAllEnvs());

describe("the webhook", () => {
  it("subscribes every Page to the button's clicks", () => {
    expect(PAGE_WEBHOOK_FIELDS).toContain("messaging_postbacks");
  });

  it("queues a click as the customer's message, once per click", async () => {
    await expect(ingestPageWebhook(click({ title: "نحب هذا", payload: LIKE, mid: "m_pb_1" }))).resolves.toMatchObject({ messages: 1 });
    expect(queue.add).toHaveBeenCalledWith(
      FB_MESSAGE_JOB,
      expect.objectContaining({ kind: "message", psid: "psid_1", mid: "m_pb_1", text: "نحب هذا", attachments: [], postback: { payload: LIKE } }),
      { jobId: messageJobId("1001", "m_pb_1", "message") }
    );
  });

  it("gives a click without a mid the same job ID when Meta delivers it again", async () => {
    await ingestPageWebhook(click({ title: "نحب هذا", payload: LIKE }));
    await ingestPageWebhook(click({ title: "نحب هذا", payload: LIKE }));
    const [first, second] = queue.add.mock.calls.map((call) => call[2].jobId);
    expect(first).toBe(second);
    expect(queue.add.mock.calls[0][1].mid).toMatch(/^pb_[0-9a-f]{32}$/);
  });

  it("skips a click for a Page nobody connected", async () => {
    db.facebookPage.findMany.mockResolvedValue([]);
    await ingestPageWebhook(click({ title: "نحب هذا", payload: LIKE, mid: "m_pb_1" }));
    expect(queue.add).not.toHaveBeenCalled();
  });
});

describe("the stored click", () => {
  it("names the product and colour, puts it first in the conversation, and gives the bot its turn", async () => {
    await expect(processMessageJob(job())).resolves.toBe("stored");
    expect(db.product.findFirst.mock.calls[0][0].where).toEqual({ id: "prod_wp", workspaceId: "ws_a" });
    expect(db.facebookMessage.create.mock.calls[0][0].data).toMatchObject({
      direction: "INBOUND", author: "CUSTOMER", mid: "m_pb_1", text: "👍 نحب هذا: Papier peint 3D · 12-04 Gris",
    });
    expect(db.facebookConversation.update).toHaveBeenCalledWith({ where: { id: "conv_1" }, data: { focusProductIds: ["prod_wp", "prod_old"] } });
    expect(queue.add).toHaveBeenCalledWith(FB_BOT_REPLY_JOB, expect.anything(), expect.anything());
  });

  it("keeps only the button's title for a product of another brand or a payload we did not write", async () => {
    db.product.findFirst.mockResolvedValue(null);
    await processMessageJob(job());
    expect(db.facebookMessage.create.mock.calls[0][0].data.text).toBe("نحب هذا");

    vi.clearAllMocks();
    db.facebookMessage.create.mockResolvedValue({ id: "msg_2" });
    await processMessageJob(job({ mid: "m_pb_2", postback: { payload: "anything|else" } }));
    expect(db.product.findFirst).not.toHaveBeenCalled();
    expect(db.facebookMessage.create.mock.calls[0][0].data.text).toBe("نحب هذا");
    const focusWrites = db.facebookConversation.update.mock.calls.filter(([args]) => "focusProductIds" in args.data);
    expect(focusWrites).toEqual([]);
  });

  it("names the product alone when the card had no colour", async () => {
    db.product.findFirst.mockResolvedValue({ id: "prod_wp", name: "Papier peint 3D", variants: [] });
    await processMessageJob(job({ postback: { payload: encodeLikePayload("prod_wp", null) } }));
    expect(db.facebookMessage.create.mock.calls[0][0].data.text).toBe("👍 نحب هذا: Papier peint 3D");
  });
});
