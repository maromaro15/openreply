import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  context: null as null | { userId: string; workspaceId: string; role: "OWNER" | "ADMIN" | "MEMBER" },
}));
const db = vi.hoisted(() => ({
  alertSettings: { findUnique: vi.fn(), upsert: vi.fn(), updateMany: vi.fn() },
  alertRecipient: { findMany: vi.fn(), count: vi.fn(), create: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() },
  alertRoute: { findMany: vi.fn(), deleteMany: vi.fn(), createMany: vi.fn() },
  alertDelivery: { findMany: vi.fn() },
  $transaction: vi.fn(),
}));
const telegram = vi.hoisted(() => ({ telegramGetMe: vi.fn(), telegramGetUpdates: vi.fn() }));
const dispatch = vi.hoisted(() => ({ sendTestAlerts: vi.fn() }));

vi.mock("@/lib/workspace-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/workspace-access")>()),
  getCurrentWorkspaceContext: async () => state.context,
}));
vi.mock("@/lib/db/client", () => ({ prisma: db }));
vi.mock("@/lib/auth", () => ({ getCurrentUserId: async () => state.context?.userId ?? null }));
vi.mock("@/lib/meta/oauth", () => ({ encryptToken: (value: string) => `enc(${value})`, decryptToken: (value: string) => value.slice(4, -1) }));
vi.mock("@/lib/alerts/telegram", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/alerts/telegram")>()),
  ...telegram,
}));
vi.mock("@/lib/alerts/dispatch", () => dispatch);
// No Redis here: the limit itself is pinned in security-fixes.test.ts.
vi.mock("@/lib/limits/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/limits/rate-limit")>()),
  takeWorkspaceQuota: async () => ({ allowed: true, retryAfter: 0 }),
}));

import { DELETE as removeBot, GET as getSettings, PUT as saveBot } from "../../app/api/alerts/settings/route";
import { GET as listRecipients, POST as addRecipient } from "../../app/api/alerts/recipients/route";
import { DELETE as deleteRecipient, PATCH as patchRecipient } from "../../app/api/alerts/recipients/[id]/route";
import { GET as getRoutes, PUT as putRoutes } from "../../app/api/alerts/routes/route";
import { POST as sendTest } from "../../app/api/alerts/test/route";
import { GET as findChats } from "../../app/api/alerts/telegram/chats/route";
import { GET as listDeliveries } from "../../app/api/alerts/deliveries/route";
import { TelegramError } from "../../lib/alerts/telegram";

const BASE = "http://localhost:3000/api/alerts";
const TOKEN = "123456789:AAH_valid-looking-token-0123456789abcdef";
const params = (id: string) => ({ params: Promise.resolve({ id }) });

function request(url: string, method = "GET", body?: unknown, origin = "http://localhost:3000") {
  return new NextRequest(url, {
    method,
    headers: { "Content-Type": "application/json", Origin: origin },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function as(role: "OWNER" | "ADMIN" | "MEMBER") {
  state.context = { userId: "u", workspaceId: "ws_a", role };
}

beforeEach(() => {
  vi.clearAllMocks();
  as("ADMIN");
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("EMAIL_FROM", "Amitec Reply <alerts@shop.dz>");
  vi.stubEnv("EMAIL_SERVER", "");
  vi.stubEnv("ALERTS_EMAIL_FROM", "");
  db.$transaction.mockImplementation(async (operations: unknown[]) => Promise.all(operations));
  db.alertSettings.findUnique.mockResolvedValue({ telegramBotToken: `enc(${TOKEN})`, telegramBotUsername: "lina_alerts_bot" });
  db.alertRecipient.findMany.mockResolvedValue([{ id: "rc_1" }, { id: "rc_2" }]);
  db.alertRecipient.count.mockResolvedValue(0);
  db.alertRecipient.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "rc_new", ...data }));
  db.alertRecipient.updateMany.mockResolvedValue({ count: 1 });
  db.alertRecipient.deleteMany.mockResolvedValue({ count: 1 });
  db.alertRoute.findMany.mockResolvedValue([]);
  db.alertRoute.deleteMany.mockResolvedValue({ count: 0 });
  db.alertRoute.createMany.mockResolvedValue({ count: 0 });
  db.alertDelivery.findMany.mockResolvedValue([]);
  telegram.telegramGetMe.mockResolvedValue({ id: 42, username: "lina_alerts_bot", firstName: "Lina alerts" });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("/api/alerts/settings", () => {
  it("shows the bot's @username and the email sender, never the token", async () => {
    as("MEMBER");
    const body = await (await getSettings(request(`${BASE}/settings`))).json();
    expect(body.data).toEqual({
      role: "MEMBER",
      telegram: { connected: true, username: "lina_alerts_bot" },
      email: { configured: true, from: "Amitec Reply <alerts@shop.dz>" },
    });
    expect(JSON.stringify(body)).not.toContain("AAH_valid");
  });

  it("checks a token with Telegram, then stores it encrypted", async () => {
    const response = await saveBot(request(`${BASE}/settings`, "PUT", { telegramBotToken: ` ${TOKEN} ` }));
    expect(response.status).toBe(200);
    expect(telegram.telegramGetMe).toHaveBeenCalledWith(TOKEN);
    expect(db.alertSettings.upsert).toHaveBeenCalledWith({
      where: { workspaceId: "ws_a" },
      create: { workspaceId: "ws_a", telegramBotToken: `enc(${TOKEN})`, telegramBotUsername: "lina_alerts_bot" },
      update: { telegramBotToken: `enc(${TOKEN})`, telegramBotUsername: "lina_alerts_bot" },
    });
    expect(JSON.stringify(await response.json())).not.toContain("AAH_valid");
  });

  it("refuses a malformed token, a token Telegram rejects, and says when Telegram is out of reach", async () => {
    expect(await (await saveBot(request(`${BASE}/settings`, "PUT", { telegramBotToken: "not-a-token" }))).json()).toMatchObject({
      code: "invalid_format",
    });
    telegram.telegramGetMe.mockRejectedValueOnce(new TelegramError("Unauthorized", "invalid_token", 401));
    expect(await (await saveBot(request(`${BASE}/settings`, "PUT", { telegramBotToken: TOKEN }))).json()).toMatchObject({
      code: "invalid_token",
    });
    telegram.telegramGetMe.mockRejectedValueOnce(new TelegramError("fetch failed", "network"));
    expect((await saveBot(request(`${BASE}/settings`, "PUT", { telegramBotToken: TOKEN }))).status).toBe(502);
    expect(db.alertSettings.upsert).not.toHaveBeenCalled();
  });

  it("removes the bot; admins only, same site only", async () => {
    expect((await removeBot(request(`${BASE}/settings`, "DELETE"))).status).toBe(200);
    expect(db.alertSettings.updateMany).toHaveBeenCalledWith({
      where: { workspaceId: "ws_a" },
      data: { telegramBotToken: null, telegramBotUsername: null },
    });
    as("MEMBER");
    expect((await saveBot(request(`${BASE}/settings`, "PUT", { telegramBotToken: TOKEN }))).status).toBe(403);
    as("ADMIN");
    expect((await removeBot(request(`${BASE}/settings`, "DELETE", undefined, "https://evil.example"))).status).toBe(403);
  });
});

describe("/api/alerts/recipients", () => {
  it("adds a Telegram group or an email address to the active brand", async () => {
    expect(
      (await addRecipient(request(`${BASE}/recipients`, "POST", { channel: "TELEGRAM", label: "Sales", telegramChatId: "-1001234567890", isDefault: true }))).status
    ).toBe(201);
    expect(db.alertRecipient.create.mock.calls[0][0].data).toEqual({
      workspaceId: "ws_a",
      channel: "TELEGRAM",
      label: "Sales",
      telegramChatId: "-1001234567890",
      email: null,
      isDefault: true,
      isActive: true,
    });
    await addRecipient(request(`${BASE}/recipients`, "POST", { channel: "EMAIL", label: "Owner", email: "Owner@Shop.dz" }));
    expect(db.alertRecipient.create.mock.calls[1][0].data).toMatchObject({ email: "owner@shop.dz", telegramChatId: null });
  });

  it.each([
    [{ channel: "TELEGRAM", label: "x", telegramChatId: "abc" }],
    [{ channel: "TELEGRAM", label: "", telegramChatId: "123" }],
    [{ channel: "EMAIL", label: "x", email: "a@b" }],
    [{ channel: "EMAIL", label: "x", email: "a@b.dz\r\nBcc: spy@evil.example" }],
    [{ channel: "SMS", label: "x" }],
  ])("refuses an invalid recipient (%#)", async (body) => {
    expect((await addRecipient(request(`${BASE}/recipients`, "POST", body))).status).toBe(400);
    expect(db.alertRecipient.create).not.toHaveBeenCalled();
  });

  it("changes and deletes within the brand only, admins only", async () => {
    await patchRecipient(request(`${BASE}/recipients/rc_1`, "PATCH", { isActive: false }), params("rc_1"));
    expect(db.alertRecipient.updateMany).toHaveBeenCalledWith({ where: { id: "rc_1", workspaceId: "ws_a" }, data: { isActive: false } });
    db.alertRecipient.deleteMany.mockResolvedValue({ count: 0 });
    expect((await deleteRecipient(request(`${BASE}/recipients/rc_b`, "DELETE"), params("rc_b"))).status).toBe(404);
    as("MEMBER");
    expect((await listRecipients(request(`${BASE}/recipients`))).status).toBe(200);
    expect((await addRecipient(request(`${BASE}/recipients`, "POST", { channel: "EMAIL", label: "x", email: "a@b.dz" }))).status).toBe(403);
    expect((await patchRecipient(request(`${BASE}/recipients/rc_1`, "PATCH", { isActive: true }), params("rc_1"))).status).toBe(403);
  });
});

describe("/api/alerts/routes", () => {
  it("replaces the table, keeping only this brand's recipients and real categories", async () => {
    const response = await putRoutes(
      request(`${BASE}/routes`, "PUT", { routes: { COMPLAINT: ["rc_1", "rc_foreign", "rc_1"], WHOLESALE_ORDER: ["rc_2"], NOPE: ["rc_1"] } })
    );
    expect(response.status).toBe(200);
    expect(db.alertRoute.deleteMany).toHaveBeenCalledWith({ where: { workspaceId: "ws_a" } });
    expect(db.alertRoute.createMany).toHaveBeenCalledWith({
      data: [
        { workspaceId: "ws_a", category: "COMPLAINT", recipientId: "rc_1" },
        { workspaceId: "ws_a", category: "WHOLESALE_ORDER", recipientId: "rc_2" },
      ],
    });
  });

  it("is read by members and changed by admins", async () => {
    as("MEMBER");
    expect((await getRoutes(request(`${BASE}/routes`))).status).toBe(200);
    expect((await putRoutes(request(`${BASE}/routes`, "PUT", { routes: {} }))).status).toBe(403);
    as("ADMIN");
    expect((await putRoutes(request(`${BASE}/routes`, "PUT", { routes: "all" }))).status).toBe(400);
  });
});

describe("test alerts, chat discovery and the log", () => {
  it("sends a test to one recipient of the brand, or to all", async () => {
    dispatch.sendTestAlerts.mockResolvedValue([{ recipientId: "rc_1", label: "Sales", ok: true, error: null, errorKind: null }]);
    const body = await (await sendTest(request(`${BASE}/test`, "POST", { recipientId: "rc_1" }))).json();
    expect(dispatch.sendTestAlerts).toHaveBeenCalledWith("ws_a", "rc_1");
    expect(body.data.results[0].ok).toBe(true);
    await sendTest(request(`${BASE}/test`, "POST", {}));
    expect(dispatch.sendTestAlerts).toHaveBeenLastCalledWith("ws_a", null);
    dispatch.sendTestAlerts.mockResolvedValue(null);
    expect((await sendTest(request(`${BASE}/test`, "POST", { recipientId: "rc_b" }))).status).toBe(404);
    as("MEMBER");
    expect((await sendTest(request(`${BASE}/test`, "POST", {}))).status).toBe(403);
  });

  it("lists the chats that wrote to the bot, for admins", async () => {
    telegram.telegramGetUpdates.mockResolvedValue([
      { updateId: 1, chat: { id: "-1001", title: "Equipe Lina", type: "supergroup", username: null }, message: null },
    ]);
    const body = await (await findChats(request(`${BASE}/telegram/chats`))).json();
    expect(telegram.telegramGetUpdates).toHaveBeenCalledWith(TOKEN, { limit: 100 });
    expect(body.data.chats).toEqual([{ id: "-1001", title: "Equipe Lina", type: "supergroup", username: null }]);

    db.alertSettings.findUnique.mockResolvedValue(null);
    expect((await findChats(request(`${BASE}/telegram/chats`))).status).toBe(400);
    as("MEMBER");
    expect((await findChats(request(`${BASE}/telegram/chats`))).status).toBe(403);
  });

  it("shows the brand's recent alerts only", async () => {
    as("MEMBER");
    await listDeliveries(request(`${BASE}/deliveries`));
    expect(db.alertDelivery.findMany).toHaveBeenCalledWith({
      where: { workspaceId: "ws_a" },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
  });
});
