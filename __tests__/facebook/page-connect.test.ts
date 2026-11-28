import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const graph = vi.hoisted(() => ({
  debugToken: vi.fn(),
  exchangeForLongLivedUserToken: vi.fn(),
  getUserPages: vi.fn(),
  getPage: vi.fn(),
  subscribePageWebhooks: vi.fn(),
  getPageSubscribedApps: vi.fn(),
  unsubscribePageWebhooks: vi.fn(),
}));

const prisma = vi.hoisted(() => ({
  facebookPage: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    deleteMany: vi.fn(),
  },
}));

vi.mock("@/lib/facebook/graph", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/facebook/graph")>()),
  ...graph,
}));
vi.mock("@/lib/db/client", () => ({ prisma }));

import { Prisma } from "../../app/generated/prisma/client";
import { FacebookApiError } from "../../lib/facebook/graph";
import { decryptToken } from "../../lib/meta/oauth";
import {
  connectWithToken,
  disconnectPage,
  ensurePageSubscription,
  webhookSetup,
} from "../../lib/facebook/pages";

const APP_ID = "1517776481860111";
const PAGE_TOKEN = "EAAGpageTokenLongLived0123456789abcd";
const USER_TOKEN = "EAAGuserTokenShortLived0123456789wxyz";
const ALL_SCOPES = [
  "pages_messaging",
  "pages_read_engagement",
  "pages_manage_metadata",
  "pages_show_list",
  "pages_manage_engagement",
  "public_profile",
];
const pageInfo = (overrides = {}) => ({
  is_valid: true,
  type: "PAGE",
  app_id: APP_ID,
  profile_id: "1001",
  expires_at: 0,
  scopes: ALL_SCOPES,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("FACEBOOK_APP_ID", APP_ID);
  vi.stubEnv("FACEBOOK_APP_SECRET", "secret");
  vi.stubEnv("ENCRYPTION_KEY", "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
  vi.stubEnv("NEXTAUTH_URL", "https://bot.example.com");
  graph.debugToken.mockResolvedValue(pageInfo());
  graph.getPage.mockResolvedValue({ id: "1001", name: "Maison Lina DZ", pictureUrl: "https://cdn/p.jpg" });
  graph.subscribePageWebhooks.mockResolvedValue(true);
  graph.getPageSubscribedApps.mockResolvedValue([
    { id: "999", subscribed_fields: ["feed"] },
    { id: APP_ID, subscribed_fields: ["feed", "messages", "message_echoes", "messaging_postbacks"] },
  ]);
  prisma.facebookPage.findUnique.mockResolvedValue(null);
  prisma.facebookPage.create.mockResolvedValue({ id: "fp_1" });
  prisma.facebookPage.update.mockResolvedValue({ id: "fp_1" });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("connecting a Page token", () => {
  it("stores the Page with an encrypted token and subscribes the four fields", async () => {
    const outcome = await connectWithToken({ workspaceId: "ws_a", token: `  ${PAGE_TOKEN}\n` });

    expect(outcome).toEqual({
      kind: "connected",
      failures: [],
      pages: [
        {
          id: "fp_1",
          pageId: "1001",
          name: "Maison Lina DZ",
          webhookSubscribed: true,
          subscribedFields: ["feed", "messages", "message_echoes", "messaging_postbacks"],
          tokenExpiresAt: null,
          subscriptionError: null,
        },
      ],
    });

    const created = prisma.facebookPage.create.mock.calls[0][0].data;
    expect(created).toMatchObject({
      workspaceId: "ws_a",
      pageId: "1001",
      name: "Maison Lina DZ",
      tokenLast4: PAGE_TOKEN.slice(-4),
      tokenExpiresAt: null,
      grantedScopes: ALL_SCOPES,
      status: "ACTIVE",
    });
    expect(created.accessToken).not.toContain(PAGE_TOKEN);
    expect(decryptToken(created.accessToken)).toBe(PAGE_TOKEN);
    expect(graph.subscribePageWebhooks).toHaveBeenCalledWith("1001", PAGE_TOKEN, [
      "feed",
      "messages",
      "message_echoes",
      "messaging_postbacks",
    ]);
    expect(prisma.facebookPage.update).toHaveBeenLastCalledWith({
      where: { id: "fp_1" },
      data: {
        webhookSubscribed: true,
        subscribedFields: ["feed", "messages", "message_echoes", "messaging_postbacks"],
        lastError: null,
      },
    });
  });

  it("reconnects a Page the brand already has instead of creating it again", async () => {
    prisma.facebookPage.findUnique.mockResolvedValue({ id: "fp_old", workspaceId: "ws_a" });
    prisma.facebookPage.update.mockResolvedValue({ id: "fp_old" });
    const outcome = await connectWithToken({ workspaceId: "ws_a", token: PAGE_TOKEN });
    expect(outcome.kind).toBe("connected");
    expect(prisma.facebookPage.create).not.toHaveBeenCalled();
    expect(prisma.facebookPage.update.mock.calls[0][0]).toMatchObject({
      where: { id: "fp_old" },
      data: { status: "ACTIVE", lastError: null },
    });
  });

  it.each([
    ["too short", "abc"],
    ["containing spaces", "EAAG token with spaces 0123456789"],
    ["with a newline inside", "EAAGabcdefghij\nklmnopqrstuvwxyz"],
  ])("rejects a token %s before calling Facebook", async (_label, token) => {
    const outcome = await connectWithToken({ workspaceId: "ws_a", token });
    expect(outcome).toMatchObject({ kind: "error", error: { code: "invalid_token_format" } });
    expect(graph.debugToken).not.toHaveBeenCalled();
  });

  it("names the missing environment variables", async () => {
    vi.stubEnv("FACEBOOK_APP_ID", "");
    vi.stubEnv("META_APP_ID", "");
    vi.stubEnv("ENCRYPTION_KEY", "short");
    const outcome = await connectWithToken({ workspaceId: "ws_a", token: PAGE_TOKEN });
    expect(outcome).toMatchObject({
      kind: "error",
      error: { code: "env_missing", missing: ["FACEBOOK_APP_ID", "ENCRYPTION_KEY"] },
    });
  });

  it("rejects an invalid token", async () => {
    graph.debugToken.mockResolvedValue({ is_valid: false, error: { message: "Session has expired" } });
    expect(await connectWithToken({ workspaceId: "ws_a", token: PAGE_TOKEN })).toMatchObject({
      kind: "error",
      error: { code: "invalid_token", message: "Session has expired" },
    });
    graph.debugToken.mockRejectedValue(new FacebookApiError("bad", "token_invalid", 190));
    expect(await connectWithToken({ workspaceId: "ws_a", token: PAGE_TOKEN })).toMatchObject({
      error: { code: "invalid_token" },
    });
  });

  it("rejects a token issued for another Meta app", async () => {
    graph.debugToken.mockResolvedValue(pageInfo({ app_id: "222" }));
    expect(await connectWithToken({ workspaceId: "ws_a", token: PAGE_TOKEN })).toMatchObject({
      error: { code: "wrong_app" },
    });
    expect(prisma.facebookPage.create).not.toHaveBeenCalled();
  });

  it("lists the missing permissions", async () => {
    graph.debugToken.mockResolvedValue(pageInfo({ scopes: ["pages_messaging", "pages_show_list"] }));
    expect(await connectWithToken({ workspaceId: "ws_a", token: PAGE_TOKEN })).toMatchObject({
      error: {
        code: "missing_permissions",
        missing: ["pages_read_engagement", "pages_manage_metadata"],
      },
    });
  });

  it("connects a token without pages_manage_engagement (public replies stay off)", async () => {
    const scopes = ALL_SCOPES.filter((scope) => scope !== "pages_manage_engagement");
    graph.debugToken.mockResolvedValue(pageInfo({ scopes }));
    expect(await connectWithToken({ workspaceId: "ws_a", token: PAGE_TOKEN })).toMatchObject({ kind: "connected" });
  });

  it("refuses a token that expires within a week, accepts a longer one", async () => {
    const inTwoDays = Math.floor(Date.now() / 1000) + 2 * 86_400;
    graph.debugToken.mockResolvedValue(pageInfo({ expires_at: inTwoDays }));
    expect(await connectWithToken({ workspaceId: "ws_a", token: PAGE_TOKEN })).toMatchObject({
      error: { code: "short_lived_token", expiresAt: new Date(inTwoDays * 1000).toISOString() },
    });

    const inSixtyDays = Math.floor(Date.now() / 1000) + 60 * 86_400;
    graph.debugToken.mockResolvedValue(pageInfo({ expires_at: inSixtyDays }));
    const outcome = await connectWithToken({ workspaceId: "ws_a", token: PAGE_TOKEN });
    expect(outcome).toMatchObject({
      kind: "connected",
      pages: [{ tokenExpiresAt: new Date(inSixtyDays * 1000).toISOString() }],
    });
  });

  it("never moves a Page that belongs to another brand", async () => {
    prisma.facebookPage.findUnique.mockResolvedValue({ id: "fp_b", workspaceId: "ws_b" });
    expect(await connectWithToken({ workspaceId: "ws_a", token: PAGE_TOKEN })).toMatchObject({
      error: { code: "page_in_other_workspace", pageId: "1001" },
    });
    expect(prisma.facebookPage.update).not.toHaveBeenCalled();
    expect(prisma.facebookPage.create).not.toHaveBeenCalled();
  });

  it("loses a connect race to another brand cleanly", async () => {
    prisma.facebookPage.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "7" })
    );
    expect(await connectWithToken({ workspaceId: "ws_a", token: PAGE_TOKEN })).toMatchObject({
      error: { code: "page_in_other_workspace" },
    });
  });

  it("keeps the Page connected but flags a webhook subscription that did not take", async () => {
    graph.getPageSubscribedApps.mockResolvedValue([{ id: APP_ID, subscribed_fields: ["feed", "messages"] }]);
    const outcome = await connectWithToken({ workspaceId: "ws_a", token: PAGE_TOKEN });
    expect(outcome).toMatchObject({
      kind: "connected",
      pages: [{ webhookSubscribed: false, subscriptionError: expect.stringContaining("message_echoes") }],
    });
    expect(prisma.facebookPage.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ webhookSubscribed: false }) })
    );
  });
});

describe("connecting through a user token", () => {
  beforeEach(() => {
    graph.debugToken.mockImplementation(async (token: string) =>
      token === USER_TOKEN
        ? { is_valid: true, type: "USER", app_id: APP_ID, expires_at: 1, scopes: ALL_SCOPES }
        : pageInfo({ profile_id: token === "EAAGpageTokenTwo0123456789" ? "1002" : "1001" })
    );
    graph.exchangeForLongLivedUserToken.mockResolvedValue({ accessToken: "EAAGlongLivedUser0123456789" });
    graph.getUserPages.mockResolvedValue([
      { id: "1001", name: "Maison Lina DZ", access_token: PAGE_TOKEN, picture: { data: { url: "https://cdn/1" } } },
      { id: "1002", name: "Lina Outlet", access_token: "EAAGpageTokenTwo0123456789" },
      { id: "1003", name: "No access", tasks: [] },
    ]);
  });

  it("swaps it for a long-lived token and lists the Pages, without their tokens", async () => {
    const outcome = await connectWithToken({ workspaceId: "ws_a", token: USER_TOKEN });
    expect(graph.exchangeForLongLivedUserToken).toHaveBeenCalledWith(USER_TOKEN);
    expect(graph.getUserPages).toHaveBeenCalledWith("EAAGlongLivedUser0123456789");
    expect(outcome).toEqual({
      kind: "choose_pages",
      pages: [
        { id: "1001", name: "Maison Lina DZ", pictureUrl: "https://cdn/1" },
        { id: "1002", name: "Lina Outlet", pictureUrl: null },
      ],
    });
    expect(JSON.stringify(outcome)).not.toContain("EAAG");
    expect(prisma.facebookPage.create).not.toHaveBeenCalled();
  });

  it("connects only the chosen Pages, each with its own token", async () => {
    graph.getPage.mockImplementation(async (pageId: string) => ({ id: pageId, name: `Page ${pageId}` }));
    prisma.facebookPage.create.mockImplementation(async ({ data }: { data: { pageId: string } }) => ({
      id: `fp_${data.pageId}`,
    }));
    const outcome = await connectWithToken({ workspaceId: "ws_a", token: USER_TOKEN, pageIds: ["1002"] });
    expect(outcome).toMatchObject({ kind: "connected", pages: [{ id: "fp_1002", pageId: "1002" }], failures: [] });
    const created = prisma.facebookPage.create.mock.calls[0][0].data;
    expect(decryptToken(created.accessToken)).toBe("EAAGpageTokenTwo0123456789");
  });

  it("refuses a Page the account does not manage", async () => {
    expect(await connectWithToken({ workspaceId: "ws_a", token: USER_TOKEN, pageIds: ["7777"] })).toMatchObject({
      error: { code: "page_not_found_for_user" },
    });
  });

  it("says so when the account manages no usable Page", async () => {
    graph.getUserPages.mockResolvedValue([{ id: "1003", name: "No access" }]);
    expect(await connectWithToken({ workspaceId: "ws_a", token: USER_TOKEN })).toMatchObject({
      error: { code: "no_pages" },
    });
  });
});

describe("subscription, disconnection and setup", () => {
  it("reports a subscription failure without throwing", async () => {
    graph.subscribePageWebhooks.mockRejectedValue(new FacebookApiError("(#200) Permissions error", "permission", 200));
    await expect(ensurePageSubscription("1001", PAGE_TOKEN)).resolves.toEqual({
      ok: false,
      fields: [],
      error: "(#200) Permissions error",
    });
  });

  it("disconnects even when the token is already dead, and wipes it", async () => {
    const { encryptToken } = await import("../../lib/meta/oauth");
    prisma.facebookPage.findFirst.mockResolvedValue({ id: "fp_1", pageId: "1001", accessToken: encryptToken(PAGE_TOKEN) });
    graph.unsubscribePageWebhooks.mockRejectedValue(new FacebookApiError("expired", "token_invalid", 190));
    await expect(disconnectPage("ws_a", "fp_1")).resolves.toBe(true);
    expect(prisma.facebookPage.findFirst).toHaveBeenCalledWith({ where: { id: "fp_1", workspaceId: "ws_a" } });
    expect(prisma.facebookPage.update).toHaveBeenCalledWith({
      where: { id: "fp_1" },
      data: {
        status: "DISCONNECTED",
        accessToken: "",
        tokenLast4: null,
        webhookSubscribed: false,
        subscribedFields: [],
      },
    });
  });

  it("does not disconnect another brand's Page", async () => {
    prisma.facebookPage.findFirst.mockResolvedValue(null);
    await expect(disconnectPage("ws_b", "fp_1")).resolves.toBe(false);
    expect(prisma.facebookPage.update).not.toHaveBeenCalled();
  });

  it("describes the webhook to configure in the Meta app", () => {
    vi.stubEnv("FACEBOOK_WEBHOOK_VERIFY_TOKEN", "verify");
    expect(webhookSetup()).toEqual({
      callbackUrl: "https://bot.example.com/api/facebook/webhook",
      verifyTokenConfigured: true,
      fields: ["feed", "messages", "message_echoes", "messaging_postbacks"],
      permissions: [
        "pages_messaging",
        "pages_read_engagement",
        "pages_manage_metadata",
        "pages_show_list",
      ],
      optionalPermissions: ["pages_manage_engagement"],
      missingEnv: [],
    });
  });
});
