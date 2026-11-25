import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  context: null as null | { userId: string; workspaceId: string; role: "OWNER" | "ADMIN" | "MEMBER" },
}));
const db = vi.hoisted(() => ({
  facebookConversation: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    groupBy: vi.fn(),
    count: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  facebookConversationEvent: { create: vi.fn() },
  facebookMessage: { create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  facebookPage: { update: vi.fn() },
  facebookCampaign: { findFirst: vi.fn() },
  user: { findMany: vi.fn() },
  workspaceMember: { findUnique: vi.fn() },
  $transaction: vi.fn(),
}));
const graph = vi.hoisted(() => ({ sendMessage: vi.fn() }));

vi.mock("@/lib/workspace-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/workspace-access")>()),
  getCurrentWorkspaceContext: async () => state.context,
}));
vi.mock("@/lib/db/client", () => ({ prisma: db }));
vi.mock("@/lib/facebook/graph", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/facebook/graph")>()),
  ...graph,
}));
vi.mock("@/lib/facebook/pages", () => ({ pageToken: () => "PAGE_TOKEN" }));
vi.mock("@/lib/auth", () => ({ getCurrentUserId: async () => state.context?.userId ?? null }));

import { GET as listRoute } from "../../app/api/facebook/conversations/route";
import { GET as threadRoute, PATCH as patchRoute } from "../../app/api/facebook/conversations/[id]/route";
import { POST as replyRoute } from "../../app/api/facebook/conversations/[id]/messages/route";
import { FacebookApiError } from "../../lib/facebook/graph";
import { resolveInboxLink } from "../../lib/facebook/inbox-link";

const NOW = new Date("2026-11-25T12:00:00Z");
const BASE = "http://localhost:3000/api/facebook/conversations";
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const PAGE = { id: "fp_1", pageId: "1001", name: "Maison Lina DZ", status: "ACTIVE", accessToken: "enc", botEnabled: true };

function request(url: string, method = "GET", body?: unknown, origin = "http://localhost:3000") {
  return new NextRequest(url, {
    method,
    headers: { "Content-Type": "application/json", Origin: origin },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "conv_1",
    workspaceId: "ws_a",
    facebookPageId: "fp_1",
    psid: "psid_1",
    userName: "Amina B.",
    mode: "BOT",
    modeReason: null,
    modeChangedAt: null,
    needsHuman: false,
    handoffCategory: null,
    handoffReason: null,
    handoffAt: null,
    sourceCampaignId: null,
    sourceCommentId: null,
    lastInboundAt: new Date("2026-11-25T11:00:00Z"),
    lastOutboundAt: null,
    lastMessageText: "شحال؟",
    lastMessageAt: new Date("2026-11-25T11:00:00Z"),
    unreadCount: 2,
    createdAt: NOW,
    updatedAt: NOW,
    page: PAGE,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  state.context = { userId: "u_member", workspaceId: "ws_a", role: "MEMBER" };
  db.$transaction.mockImplementation(async (fn: (tx: typeof db) => unknown) => fn(db));
  db.facebookConversation.findMany.mockResolvedValue([row()]);
  db.facebookConversation.groupBy.mockResolvedValue([]);
  db.facebookConversation.count.mockResolvedValue(0);
  db.facebookConversation.findFirst.mockResolvedValue(row());
  db.facebookConversation.findUnique.mockResolvedValue({ workspaceId: "ws_a", mode: "BOT", needsHuman: false, handoffCategory: null });
  db.facebookConversation.update.mockResolvedValue({});
  db.facebookConversation.updateMany.mockResolvedValue({ count: 1 });
  db.facebookConversationEvent.create.mockResolvedValue({});
  db.facebookMessage.create.mockResolvedValue({ id: "msg_new" });
  db.facebookMessage.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "msg_new",
    direction: "OUTBOUND",
    author: "HUMAN",
    origin: "OPENREPLY",
    text: "متوفر بالمقاس M",
    attachmentType: null,
    attachmentUrl: null,
    transcript: null,
    transcriptStatus: null,
    error: null,
    sentByUserId: "u_member",
    sentAt: NOW,
    ...data,
  }));
  db.facebookMessage.updateMany.mockResolvedValue({ count: 1 });
  db.user.findMany.mockResolvedValue([]);
  graph.sendMessage.mockResolvedValue({ recipient_id: "psid_1", message_id: "m_sent_1" });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("GET /api/facebook/conversations", () => {
  it("lists only the active brand's conversations, for every member", async () => {
    const response = await listRoute(request(`${BASE}?filter=all`));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.workspaceId).toBe("ws_a");
    expect(body.data.conversations[0]).toMatchObject({
      id: "conv_1",
      userName: "Amina B.",
      page: { id: "fp_1", name: "Maison Lina DZ" },
      windowEndsAt: "2026-11-26T11:00:00.000Z",
    });
    // No Page token and no PSID leave the server.
    expect(JSON.stringify(body)).not.toContain("enc");
    expect(JSON.stringify(body)).not.toContain("psid_1");
    expect(db.facebookConversation.findMany.mock.calls[0][0].where).toEqual({ workspaceId: "ws_a" });
  });

  it("needs a signed-in member", async () => {
    state.context = null;
    expect((await listRoute(request(BASE))).status).toBe(401);
  });

  it.each([
    ["needs_human", { needsHuman: true }],
    ["bot", { mode: "BOT" }],
    ["human", { mode: "HUMAN" }],
    ["nonsense", { needsHuman: true }],
  ])("filter=%s", async (filter, expected) => {
    await listRoute(request(`${BASE}?filter=${filter}`));
    expect(db.facebookConversation.findMany.mock.calls[0][0].where).toEqual({ workspaceId: "ws_a", ...expected });
  });

  it("filters by category and Page, and counts each category within the tab", async () => {
    db.facebookConversation.groupBy.mockResolvedValue([
      { handoffCategory: "COMPLAINT", _count: { _all: 3 } },
      { handoffCategory: "WHOLESALE_ORDER", _count: { _all: 1 } },
    ]);
    db.facebookConversation.count.mockResolvedValue(4);
    const response = await listRoute(request(`${BASE}?filter=needs_human&category=COMPLAINT&page=fp_1`));
    const body = await response.json();
    expect(db.facebookConversation.findMany.mock.calls[0][0].where).toEqual({
      workspaceId: "ws_a",
      facebookPageId: "fp_1",
      needsHuman: true,
      handoffCategory: "COMPLAINT",
    });
    expect(db.facebookConversation.groupBy.mock.calls[0][0].where).toEqual({
      workspaceId: "ws_a",
      facebookPageId: "fp_1",
      needsHuman: true,
      handoffCategory: { not: null },
    });
    expect(body.data.counts).toEqual({
      needsHuman: 4,
      byCategory: {
        WHOLESALE_ORDER: 1,
        CUSTOM_ORDER: 0,
        COMPLAINT: 3,
        NOT_IN_KB: 0,
        AUDIO_FAILED: 0,
        OTHER: 0,
      },
    });
  });

  it("ignores an unknown category and caps the page size", async () => {
    await listRoute(request(`${BASE}?filter=all&category=DROP_TABLE&limit=100000`));
    const args = db.facebookConversation.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ workspaceId: "ws_a" });
    expect(args.take).toBe(301);
  });
});

describe("GET /api/facebook/conversations/[id]", () => {
  it("returns the thread with its timeline and reply window", async () => {
    db.facebookConversation.findFirst.mockResolvedValue({
      ...row({ mode: "HUMAN", needsHuman: true, handoffCategory: "COMPLAINT", handoffReason: "Colis abîmé" }),
      messages: [
        { id: "m2", direction: "OUTBOUND", author: "HUMAN", origin: "EXTERNAL", text: "نشوفو", sentAt: new Date("2026-11-25T11:30:00Z"), sentByUserId: null },
        { id: "m1", direction: "INBOUND", author: "CUSTOMER", origin: null, text: "الكولي وصل مكسور", sentAt: new Date("2026-11-25T11:00:00Z"), sentByUserId: null },
      ],
      events: [{ id: "e1", type: "HUMAN_TAKEOVER", reason: "META_REPLY", category: null, actorUserId: null, createdAt: new Date("2026-11-25T11:30:00Z") }],
    });
    const response = await threadRoute(request(`${BASE}/conv_1`), params("conv_1"));
    const body = await response.json();
    expect(db.facebookConversation.findFirst.mock.calls[0][0].where).toEqual({ id: "conv_1", workspaceId: "ws_a" });
    expect(body.data.messages.map((message: { id: string }) => message.id)).toEqual(["m1", "m2"]);
    expect(body.data.events[0]).toMatchObject({ type: "HUMAN_TAKEOVER", reason: "META_REPLY" });
    expect(body.data.conversation).toMatchObject({
      handoffCategory: "COMPLAINT",
      reply: { canReply: true, humanAgentTag: false, endsAt: "2026-11-26T11:00:00.000Z" },
    });
  });

  it("answers 404 for a conversation of another brand", async () => {
    db.facebookConversation.findFirst.mockResolvedValue(null);
    expect((await threadRoute(request(`${BASE}/conv_b`), params("conv_b"))).status).toBe(404);
  });
});

describe("PATCH /api/facebook/conversations/[id]", () => {
  it("take over: HUMAN, the bot goes silent, and the timeline names who", async () => {
    const response = await patchRoute(request(`${BASE}/conv_1`, "PATCH", { action: "take_over" }), params("conv_1"));
    expect(response.status).toBe(200);
    expect(db.facebookConversation.updateMany).toHaveBeenCalledWith({
      where: { id: "conv_1", mode: "BOT", needsHuman: false },
      data: expect.objectContaining({ mode: "HUMAN", modeReason: "INBOX_TAKEOVER", needsHuman: false }),
    });
    expect(db.facebookConversationEvent.create).toHaveBeenCalledWith({
      data: { workspaceId: "ws_a", conversationId: "conv_1", type: "HUMAN_TAKEOVER", reason: "INBOX_TAKEOVER", actorUserId: "u_member" },
    });
  });

  it("return to bot: clears the handoff and its category", async () => {
    db.facebookConversation.findUnique.mockResolvedValue({
      workspaceId: "ws_a",
      mode: "HUMAN",
      needsHuman: true,
      handoffCategory: "COMPLAINT",
    });
    await patchRoute(request(`${BASE}/conv_1`, "PATCH", { action: "return_to_bot" }), params("conv_1"));
    expect(db.facebookConversation.updateMany).toHaveBeenCalledWith({
      where: { id: "conv_1", mode: "HUMAN", needsHuman: true },
      data: expect.objectContaining({
        mode: "BOT",
        modeReason: "INBOX_RELEASE",
        needsHuman: false,
        handoffCategory: null,
        handoffReason: null,
        handoffAt: null,
      }),
    });
    expect(db.facebookConversationEvent.create).toHaveBeenCalledWith({
      data: { workspaceId: "ws_a", conversationId: "conv_1", type: "RETURNED_TO_BOT", actorUserId: "u_member" },
    });
  });

  it("taking over a conversation people already handle records nothing", async () => {
    db.facebookConversation.findUnique.mockResolvedValue({ workspaceId: "ws_a", mode: "HUMAN", needsHuman: false });
    const response = await patchRoute(request(`${BASE}/conv_1`, "PATCH", { action: "take_over" }), params("conv_1"));
    expect((await response.json()).data.changed).toBe(false);
    expect(db.facebookConversationEvent.create).not.toHaveBeenCalled();
  });

  it("read: clears the unread count within the brand", async () => {
    await patchRoute(request(`${BASE}/conv_1`, "PATCH", { action: "read" }), params("conv_1"));
    expect(db.facebookConversation.updateMany).toHaveBeenCalledWith({
      where: { id: "conv_1", workspaceId: "ws_a" },
      data: { unreadCount: 0 },
    });
  });

  it("refuses another brand's conversation, unknown actions and cross-site requests", async () => {
    db.facebookConversation.findFirst.mockResolvedValue(null);
    expect((await patchRoute(request(`${BASE}/conv_b`, "PATCH", { action: "take_over" }), params("conv_b"))).status).toBe(404);
    expect(db.facebookConversation.updateMany).not.toHaveBeenCalled();
    expect((await patchRoute(request(`${BASE}/conv_1`, "PATCH", { action: "delete" }), params("conv_1"))).status).toBe(400);
    expect(
      (await patchRoute(request(`${BASE}/conv_1`, "PATCH", { action: "take_over" }, "https://evil.example"), params("conv_1"))).status
    ).toBe(403);
  });
});

describe("POST /api/facebook/conversations/[id]/messages", () => {
  const reply = (text: unknown = "متوفر بالمقاس M", origin?: string) =>
    replyRoute(request(`${BASE}/conv_1/messages`, "POST", { text }, origin), params("conv_1"));

  it("sends as the Page with our metadata, saves the mid and takes the conversation from the bot", async () => {
    const response = await reply();
    expect(response.status).toBe(201);
    expect(db.facebookMessage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        conversationId: "conv_1",
        direction: "OUTBOUND",
        author: "HUMAN",
        origin: "OPENREPLY",
        sendStatus: "PENDING",
        sentByUserId: "u_member",
      }),
    });
    expect(graph.sendMessage).toHaveBeenCalledWith("1001", "PAGE_TOKEN", {
      psid: "psid_1",
      text: "متوفر بالمقاس M",
      metadata: "openreply:msg_new",
      humanAgentTag: false,
    });
    expect(db.facebookMessage.update).toHaveBeenCalledWith({
      where: { id: "msg_new" },
      data: expect.objectContaining({ sendStatus: "SENT", mid: "m_sent_1" }),
    });
    expect(db.facebookConversationEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: "HUMAN_TAKEOVER", reason: "INBOX_TAKEOVER", actorUserId: "u_member" }),
    });
    const body = await response.json();
    expect(body.data.message).toMatchObject({ id: "msg_new", sendStatus: "SENT" });
  });

  it("refuses after the 24-hour window, without calling Meta", async () => {
    db.facebookConversation.findFirst.mockResolvedValue(row({ lastInboundAt: new Date("2026-11-24T11:00:00Z") }));
    const response = await reply();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "window_closed" });
    expect(graph.sendMessage).not.toHaveBeenCalled();
    expect(db.facebookMessage.create).not.toHaveBeenCalled();
  });

  it("refuses when the person never wrote (a private reply does not open the window)", async () => {
    db.facebookConversation.findFirst.mockResolvedValue(row({ lastInboundAt: null }));
    expect(await (await reply()).json()).toMatchObject({ code: "no_inbound" });
    expect(graph.sendMessage).not.toHaveBeenCalled();
  });

  it("uses the HUMAN_AGENT tag after 24 hours only when it is enabled", async () => {
    vi.stubEnv("FACEBOOK_HUMAN_AGENT_TAG", "true");
    db.facebookConversation.findFirst.mockResolvedValue(row({ lastInboundAt: new Date("2026-11-23T12:00:00Z") }));
    expect((await reply()).status).toBe(201);
    expect(graph.sendMessage.mock.calls[0][2]).toMatchObject({ humanAgentTag: true });
  });

  it("refuses for a Page whose token died", async () => {
    db.facebookConversation.findFirst.mockResolvedValue(row({ page: { ...PAGE, status: "TOKEN_INVALID" } }));
    expect(await (await reply()).json()).toMatchObject({ code: "page_unavailable" });
    expect(graph.sendMessage).not.toHaveBeenCalled();
  });

  it("keeps an outcome Meta did not confirm as UNCONFIRMED, never over a SENT from its echo", async () => {
    graph.sendMessage.mockRejectedValue(new FacebookApiError("socket hang up", "ambiguous"));
    const response = await reply();
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ code: "unconfirmed" });
    expect(db.facebookMessage.updateMany).toHaveBeenCalledWith({
      where: { id: "msg_new", sendStatus: "PENDING" },
      data: { sendStatus: "UNCONFIRMED", error: "socket hang up" },
    });
    expect(db.facebookConversationEvent.create).not.toHaveBeenCalled();
  });

  it.each([
    ["outside_window", 409, "window_closed"],
    ["not_eligible", 409, "not_eligible"],
    ["rate_limit", 429, "rate_limited"],
    ["unreachable", 502, "unreachable"],
    ["permission", 502, "failed"],
  ] as const)("a %s refusal is FAILED and answers %i %s", async (kind, status, code) => {
    graph.sendMessage.mockRejectedValue(new FacebookApiError("refused", kind));
    const response = await reply();
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ code });
    expect(db.facebookMessage.updateMany).toHaveBeenCalledWith({
      where: { id: "msg_new", sendStatus: "PENDING" },
      data: { sendStatus: "FAILED", error: "refused" },
    });
  });

  it("marks the Page when Meta says its token is invalid", async () => {
    graph.sendMessage.mockRejectedValue(new FacebookApiError("Session expired", "token_invalid", 190));
    expect(await (await reply()).json()).toMatchObject({ code: "page_unavailable" });
    expect(db.facebookPage.update).toHaveBeenCalledWith({
      where: { id: "fp_1" },
      data: { status: "TOKEN_INVALID", lastError: "Session expired" },
    });
  });

  it("validates the text, scopes to the brand and checks the origin", async () => {
    expect((await reply("   ")).status).toBe(400);
    expect((await reply("x".repeat(2001))).status).toBe(400);
    expect((await reply("hi", "https://evil.example")).status).toBe(403);
    db.facebookConversation.findFirst.mockResolvedValue(null);
    expect((await reply()).status).toBe(404);
    expect(db.facebookConversation.findFirst.mock.calls.at(-1)?.[0].where).toEqual({ id: "conv_1", workspaceId: "ws_a" });
    expect(graph.sendMessage).not.toHaveBeenCalled();
  });
});

describe("the alert link ?workspace=&conversation=", () => {
  const context = { userId: "u_owner", workspaceId: "cmabc000000000000000000aa" };

  it("opens the conversation directly in the current brand", async () => {
    await expect(resolveInboxLink({ workspace: context.workspaceId, conversation: "conv_1" }, context)).resolves.toEqual({
      initialConversationId: "conv_1",
      switchToWorkspaceId: null,
      linkForeign: false,
    });
    expect(db.workspaceMember.findUnique).not.toHaveBeenCalled();
  });

  it("switches to another brand the user belongs to", async () => {
    db.workspaceMember.findUnique.mockResolvedValue({ id: "wm_1" });
    await expect(
      resolveInboxLink({ workspace: "cmabc000000000000000000bb", conversation: "conv_9" }, context)
    ).resolves.toEqual({ initialConversationId: "conv_9", switchToWorkspaceId: "cmabc000000000000000000bb", linkForeign: false });
    expect(db.workspaceMember.findUnique).toHaveBeenCalledWith({
      where: { workspaceId_userId: { workspaceId: "cmabc000000000000000000bb", userId: "u_owner" } },
      select: { id: true },
    });
  });

  it("opens nothing from a brand the user is not in, nor from a malformed link", async () => {
    db.workspaceMember.findUnique.mockResolvedValue(null);
    const foreign = { initialConversationId: null, switchToWorkspaceId: null, linkForeign: true };
    await expect(resolveInboxLink({ workspace: "cmabc000000000000000000cc", conversation: "conv_x" }, context)).resolves.toEqual(foreign);
    await expect(resolveInboxLink({ workspace: "../../etc", conversation: "conv_x" }, context)).resolves.toEqual(foreign);
  });

  it("without a workspace in the link, simply opens the conversation", async () => {
    await expect(resolveInboxLink({ conversation: ["conv_1", "conv_2"] }, context)).resolves.toMatchObject({
      initialConversationId: "conv_1",
      switchToWorkspaceId: null,
    });
  });
});
