import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  updateMany: vi.fn(),
  eventCreate: vi.fn(),
  eventUpdateMany: vi.fn(),
  queueAdd: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  prisma: {
    facebookPage: { findMany: mocks.findMany, updateMany: mocks.updateMany },
    facebookWebhookEvent: { create: mocks.eventCreate, updateMany: mocks.eventUpdateMany },
  },
}));
vi.mock("@/lib/facebook/queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/facebook/queue")>()),
  getFacebookQueue: () => ({ add: mocks.queueAdd }),
}));

import { GET, POST } from "../../app/api/facebook/webhook/route";

const SECRET = "app_secret_for_tests";
const URL_BASE = "http://localhost:3000/api/facebook/webhook";

function signed(body: string, signature?: string) {
  return new NextRequest(URL_BASE, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Hub-Signature-256":
        signature ?? `sha256=${createHmac("sha256", SECRET).update(Buffer.from(body, "utf8")).digest("hex")}`,
    },
    body,
  });
}

function comment(pageId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: pageId,
    time: 1764000000,
    changes: [
      {
        field: "feed",
        value: {
          item: "comment",
          verb: "add",
          comment_id: `${pageId}_c1`,
          post_id: `${pageId}_p1`,
          parent_id: `${pageId}_p1`,
          from: { id: "999", name: "Amina B." },
          message: "شحال السعر؟",
          created_time: 1764000000,
          ...overrides,
        },
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("FACEBOOK_APP_SECRET", SECRET);
  vi.stubEnv("FACEBOOK_WEBHOOK_VERIFY_TOKEN", "verify_me");
  mocks.findMany.mockResolvedValue([{ id: "fp_1", pageId: "1001", workspaceId: "ws_a", status: "ACTIVE" }]);
  mocks.eventCreate.mockImplementation(async ({ data }: { data: { pageId: string } }) => ({ id: `ev_${data.pageId}` }));
  mocks.queueAdd.mockResolvedValue({});
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /api/facebook/webhook (verification)", () => {
  const verify = (params: Record<string, string>) =>
    GET(new NextRequest(`${URL_BASE}?${new URLSearchParams(params)}`));

  it("echoes the challenge for the right token", async () => {
    const response = await verify({ "hub.mode": "subscribe", "hub.verify_token": "verify_me", "hub.challenge": "1158201444" });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("1158201444");
  });

  it("refuses a wrong token or mode", async () => {
    expect((await verify({ "hub.mode": "subscribe", "hub.verify_token": "nope", "hub.challenge": "x" })).status).toBe(403);
    expect((await verify({ "hub.mode": "unsubscribe", "hub.verify_token": "verify_me", "hub.challenge": "x" })).status).toBe(403);
  });

  it("falls back to WEBHOOK_VERIFY_TOKEN, and refuses when no token is configured", async () => {
    vi.stubEnv("FACEBOOK_WEBHOOK_VERIFY_TOKEN", "");
    vi.stubEnv("WEBHOOK_VERIFY_TOKEN", "shared");
    expect((await verify({ "hub.mode": "subscribe", "hub.verify_token": "shared", "hub.challenge": "ok" })).status).toBe(200);
    vi.stubEnv("WEBHOOK_VERIFY_TOKEN", "");
    expect((await verify({ "hub.mode": "subscribe", "hub.verify_token": "", "hub.challenge": "x" })).status).toBe(403);
  });
});

describe("POST /api/facebook/webhook", () => {
  it("rejects an unsigned or badly signed delivery without touching anything", async () => {
    const body = JSON.stringify({ object: "page", entry: [comment("1001")] });
    expect((await POST(signed(body, "sha256=" + "0".repeat(64)))).status).toBe(401);
    const unsigned = new NextRequest(URL_BASE, { method: "POST", body });
    expect((await POST(unsigned)).status).toBe(401);
    expect(mocks.findMany).not.toHaveBeenCalled();
    expect(mocks.eventCreate).not.toHaveBeenCalled();
    expect(mocks.queueAdd).not.toHaveBeenCalled();
  });

  it("rejects signed garbage as bad JSON", async () => {
    expect((await POST(signed("not json"))).status).toBe(400);
  });

  it("stores the event, marks the Page as receiving, and queues the comment", async () => {
    const body = JSON.stringify({ object: "page", entry: [comment("1001")] });
    const response = await POST(signed(body));
    expect(response.status).toBe(200);

    expect(mocks.findMany).toHaveBeenCalledWith({
      where: { pageId: { in: ["1001"] }, status: { not: "DISCONNECTED" } },
      select: { id: true, pageId: true, workspaceId: true, status: true },
    });
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["fp_1"] } },
      data: { lastWebhookAt: expect.any(Date) },
    });
    expect(mocks.eventCreate).toHaveBeenCalledWith({
      data: {
        workspaceId: "ws_a",
        pageId: "1001",
        payload: { object: "page", entry: [comment("1001")] },
      },
      select: { id: true },
    });
    expect(mocks.queueAdd).toHaveBeenCalledWith(
      "fb-comment",
      {
        facebookPageId: "fp_1",
        pageId: "1001",
        commentId: "1001_c1",
        postId: "1001_p1",
        commenterId: "999",
        commenterName: "Amina B.",
        text: "شحال السعر؟",
        createdAt: new Date(1764000000 * 1000).toISOString(),
      },
      { jobId: "fbc_1001_1001_c1" }
    );
    expect(mocks.eventUpdateMany).toHaveBeenLastCalledWith({
      where: { id: { in: ["ev_1001"] } },
      data: { status: "PROCESSED", processedAt: expect.any(Date) },
    });
  });

  it("stores nothing for a Page nobody connected", async () => {
    mocks.findMany.mockResolvedValue([]);
    const body = JSON.stringify({ object: "page", entry: [comment("7777")] });
    expect((await POST(signed(body))).status).toBe(200);
    expect(mocks.eventCreate).not.toHaveBeenCalled();
    expect(mocks.queueAdd).not.toHaveBeenCalled();
  });

  it("keeps each brand's entries apart when one delivery carries two Pages", async () => {
    mocks.findMany.mockResolvedValue([
      { id: "fp_1", pageId: "1001", workspaceId: "ws_a", status: "ACTIVE" },
      { id: "fp_2", pageId: "2002", workspaceId: "ws_b", status: "ACTIVE" },
    ]);
    const body = JSON.stringify({ object: "page", entry: [comment("1001"), comment("2002")] });
    await POST(signed(body));
    const stored = mocks.eventCreate.mock.calls.map(([arg]) => arg.data);
    expect(stored).toEqual([
      { workspaceId: "ws_a", pageId: "1001", payload: { object: "page", entry: [comment("1001")] } },
      { workspaceId: "ws_b", pageId: "2002", payload: { object: "page", entry: [comment("2002")] } },
    ]);
    expect(mocks.queueAdd).toHaveBeenCalledTimes(2);
  });

  it("does not queue comments of a Page whose token died, nor the Page's own comments", async () => {
    mocks.findMany.mockResolvedValue([{ id: "fp_1", pageId: "1001", workspaceId: "ws_a", status: "TOKEN_INVALID" }]);
    await POST(signed(JSON.stringify({ object: "page", entry: [comment("1001")] })));
    expect(mocks.eventCreate).toHaveBeenCalled();
    expect(mocks.queueAdd).not.toHaveBeenCalled();

    mocks.findMany.mockResolvedValue([{ id: "fp_1", pageId: "1001", workspaceId: "ws_a", status: "ACTIVE" }]);
    await POST(signed(JSON.stringify({ object: "page", entry: [comment("1001", { from: { id: "1001", name: "Shop" } })] })));
    expect(mocks.queueAdd).not.toHaveBeenCalled();
  });

  it("answers 500 and marks the event failed when queueing fails, so Meta retries", async () => {
    mocks.queueAdd.mockRejectedValue(new Error("Redis down"));
    const response = await POST(signed(JSON.stringify({ object: "page", entry: [comment("1001")] })));
    expect(response.status).toBe(500);
    expect(mocks.eventUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: ["ev_1001"] } },
      data: { status: "FAILED", errorMessage: "Redis down", processedAt: expect.any(Date) },
    });
  });
});
