/**
 * Final-review security fixes: what a MEMBER sees of the worker, capped
 * webhook bodies, per-brand limits on the costly test routes, the brand cap,
 * the media route's revalidation and the Telegram chat picker.
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Role = "OWNER" | "ADMIN" | "MEMBER";

const state = vi.hoisted(() => ({
  context: null as null | { userId: string; workspaceId: string; role: Role; workspace: { id: string; name: string } },
  session: null as null | { user: { id: string; email: string } },
  quota: vi.fn(),
  cookieSet: vi.fn(),
}));
const db = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  workspaceMember: { count: vi.fn() },
  workspace: { create: vi.fn() },
  productImage: { findUnique: vi.fn() },
}));
const health = vi.hoisted(() => ({ getFacebookWorkerHealth: vi.fn(), getFacebookWorkerAlerts: vi.fn() }));
const queue = vi.hoisted(() => ({ getJobCounts: vi.fn() }));
const ingest = vi.hoisted(() => ({ ingestPageWebhook: vi.fn() }));
const dispatch = vi.hoisted(() => ({ sendTestAlerts: vi.fn() }));
const bot = vi.hoisted(() => ({ getBotSettings: vi.fn() }));
const redis = vi.hoisted(() => ({ exec: vi.fn(), incr: vi.fn(), expire: vi.fn(), get: vi.fn() }));

vi.mock("@/lib/workspace-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/workspace-access")>()),
  getCurrentWorkspaceContext: async () => state.context,
}));
vi.mock("@/lib/auth", () => ({
  auth: async () => state.session,
  getCurrentUserId: async () => state.context?.userId ?? null,
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ set: state.cookieSet, get: () => undefined }) }));
vi.mock("@/lib/agency/active-workspace", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/agency/active-workspace")>()),
  findSelectedMembership: async () => null,
}));
vi.mock("@/lib/db/client", () => ({ prisma: db }));
vi.mock("@/lib/facebook/health", () => health);
vi.mock("@/lib/facebook/queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/facebook/queue")>()),
  getFacebookQueue: () => queue,
}));
vi.mock("@/lib/facebook/ingest", () => ingest);
vi.mock("@/lib/alerts/dispatch", () => dispatch);
vi.mock("@/lib/bot/knowledge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/bot/knowledge")>()),
  ...bot,
}));
vi.mock("@/lib/queue/client", () => ({
  getRedisConnection: () => ({
    multi: () => ({ incr: redis.incr.mockReturnThis(), expire: redis.expire.mockReturnThis(), exec: redis.exec }),
  }),
}));
// The routes use the mocked counter; the helper itself is imported for real below.
vi.mock("@/lib/limits/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/limits/rate-limit")>()),
  takeWorkspaceQuota: (...args: unknown[]) => state.quota(...args),
}));

import { GET as getHealth } from "../../app/api/facebook/health/route";
import { POST as postWebhook } from "../../app/api/facebook/webhook/route";
import { DELETE as removePage } from "../../app/api/facebook/pages/[id]/route";
import { POST as tryBot } from "../../app/api/bot/test/route";
import { POST as testAlerts } from "../../app/api/alerts/test/route";
import { POST as createBrand } from "../../app/api/agency/workspaces/route";
import { GET as getMedia } from "../../app/api/public/media/[publicId]/route";
import { BrandLimitError, createBrandWorkspace, MAX_OWNED_BRANDS } from "../../lib/agency/workspaces";
import { newPublicId } from "../../lib/catalog/images";
import { FACEBOOK_WEBHOOK_MAX_BYTES, readCappedBody } from "../../lib/limits/capped-body";

const actualLimit = await vi.importActual<typeof import("../../lib/limits/rate-limit")>("../../lib/limits/rate-limit");

const ORIGIN = "http://localhost:3000";
const as = (role: Role, userId = "u1") => {
  state.context = { userId, workspaceId: "ws_a", role, workspace: { id: "ws_a", name: "Lina" } };
};

beforeEach(() => {
  vi.clearAllMocks();
  as("OWNER");
  state.session = { user: { id: "u1", email: "owner@agency.test" } };
  state.quota.mockResolvedValue({ allowed: true, retryAfter: 0 });
  vi.stubEnv("AGENCY_OWNER_EMAILS", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

// ─── 1. Health ──────────────────────────────────────────────────────────────

describe("GET /api/facebook/health", () => {
  const heartbeat = { pid: 4242, hostname: "worker-7", startedAt: "2026-11-01T00:00:00Z", checkedAt: "2026-11-26T10:00:00Z" };
  const alerts = [{ message: "ECONNREFUSED 10.0.0.9:5432 job of brand B", jobId: "job_other_brand", createdAt: "2026-11-26T09:00:00Z" }];

  beforeEach(() => {
    health.getFacebookWorkerHealth.mockResolvedValue({ healthy: true, heartbeat, ageMs: 5000 });
    health.getFacebookWorkerAlerts.mockResolvedValue(alerts);
    queue.getJobCounts.mockResolvedValue({ waiting: 1, active: 0, delayed: 0, failed: 2 });
  });

  const get = async () => {
    const response = await getHealth(new NextRequest("http://localhost:3000/api/facebook/health"));
    return { status: response.status, body: await response.json() };
  };

  it("gives a MEMBER the health and the queue counts, and nothing else", async () => {
    as("MEMBER");
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body.data.worker.healthy).toBe(true);
    expect(body.data.worker.ageMs).toBe(5000);
    expect(body.data.queue).toEqual({ waiting: 1, active: 0, delayed: 0, failed: 2 });
    expect(body.data).not.toHaveProperty("alerts");
    expect(body.data.worker.heartbeat.pid).toBeUndefined();
    expect(body.data.worker.heartbeat.hostname).toBeUndefined();
    expect(health.getFacebookWorkerAlerts).not.toHaveBeenCalled();
    expect(JSON.stringify(body)).not.toMatch(/worker-7|4242|job_other_brand|ECONNREFUSED/);
  });

  it("without AGENCY_OWNER_EMAILS, shows the alerts and host to the OWNER only", async () => {
    as("OWNER");
    const owner = await get();
    expect(owner.body.data.alerts).toEqual(alerts);
    expect(owner.body.data.worker.heartbeat).toMatchObject({ pid: 4242, hostname: "worker-7" });

    as("ADMIN");
    const admin = await get();
    expect(admin.body.data).not.toHaveProperty("alerts");
    expect(admin.body.data.worker.heartbeat.hostname).toBeUndefined();
  });

  it("with AGENCY_OWNER_EMAILS, only a listed address is the operator, whatever its role", async () => {
    vi.stubEnv("AGENCY_OWNER_EMAILS", "Ops@Agency.test, other@agency.test");
    as("MEMBER", "u_ops");
    db.user.findUnique.mockResolvedValue({ email: "ops@agency.test" });
    expect((await get()).body.data.alerts).toEqual(alerts);

    as("OWNER", "u_brand_owner");
    db.user.findUnique.mockResolvedValue({ email: "brand@client.test" });
    const brandOwner = await get();
    expect(brandOwner.body.data).not.toHaveProperty("alerts");
    expect(brandOwner.body.data.worker.heartbeat.pid).toBeUndefined();
  });

  it("keeps a Redis connection error for the operator", async () => {
    queue.getJobCounts.mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.3:6379"));
    as("MEMBER");
    const member = await get();
    expect(member.status).toBe(503);
    expect(member.body.error).toBe("Redis is not reachable");
    expect(member.body.data.worker.healthy).toBe(false);

    as("OWNER");
    expect((await get()).body.error).toContain("10.0.0.3");
  });

  it("is what the Pages screen reads: worker.healthy, present for everyone", async () => {
    const source = readFileSync("app/(dashboard)/facebook/pages/page.tsx", "utf8");
    expect(source).toContain("payload?.data?.worker?.healthy");
    expect(source).not.toMatch(/data\??\.alerts|hostname|\.pid/);
  });
});

// ─── 2. Webhook body cap, DELETE order ──────────────────────────────────────

describe("POST /api/facebook/webhook body cap", () => {
  const SECRET = "app_secret_for_tests";
  const URL_BASE = "http://localhost:3000/api/facebook/webhook";
  const sign = (bytes: Uint8Array) => `sha256=${createHmac("sha256", SECRET).update(bytes).digest("hex")}`;

  beforeEach(() => {
    vi.stubEnv("FACEBOOK_APP_SECRET", SECRET);
    ingest.ingestPageWebhook.mockResolvedValue(undefined);
  });

  it("refuses a declared content-length above the cap with 413, without reading the body", async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(1024));
      },
    });
    const request = new NextRequest(URL_BASE, {
      method: "POST",
      headers: { "content-length": String(FACEBOOK_WEBHOOK_MAX_BYTES + 1) },
      body: stream,
      duplex: "half",
    } as ConstructorParameters<typeof NextRequest>[1]);
    expect((await postWebhook(request)).status).toBe(413);
    expect(ingest.ingestPageWebhook).not.toHaveBeenCalled();
    expect(pulled).toBeLessThanOrEqual(1);
  });

  it("cuts a chunked body that has no content-length once it crosses the cap", async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(256 * 1024));
      },
    });
    const request = new NextRequest(URL_BASE, {
      method: "POST",
      headers: { "x-hub-signature-256": "sha256=" + "0".repeat(64) },
      body: stream,
      duplex: "half",
    } as ConstructorParameters<typeof NextRequest>[1]);
    expect(request.headers.get("content-length")).toBeNull();
    const response = await postWebhook(request);
    expect(response.status).toBe(413);
    // 1 MiB is 4 chunks: it stops right after the fifth, never reading on.
    expect(pulled).toBeLessThan(12);
    expect(ingest.ingestPageWebhook).not.toHaveBeenCalled();
  });

  it("still checks the signature on the exact raw bytes of a body at the cap", async () => {
    const padding = "é".repeat(100);
    const bytes = new TextEncoder().encode(JSON.stringify({ object: "page", entry: [], note: padding }));
    const ok = await postWebhook(new NextRequest(URL_BASE, { method: "POST", headers: { "x-hub-signature-256": sign(bytes) }, body: bytes }));
    expect(ok.status).toBe(200);
    expect(ingest.ingestPageWebhook).toHaveBeenCalledTimes(1);

    const forged = await postWebhook(
      new NextRequest(URL_BASE, { method: "POST", headers: { "x-hub-signature-256": sign(new TextEncoder().encode("{}")) }, body: bytes })
    );
    expect(forged.status).toBe(401);
  });

  it("readCappedBody returns the bytes within the cap and null beyond", async () => {
    const within = new Request(URL_BASE, { method: "POST", body: new Uint8Array(10).fill(7) });
    expect(Array.from((await readCappedBody(within, 10)) ?? [])).toEqual(new Array(10).fill(7));
    const beyond = new Request(URL_BASE, { method: "POST", body: new Uint8Array(11) });
    expect(await readCappedBody(beyond, 10)).toBeNull();
    expect(await readCappedBody(new Request(URL_BASE), 10)).toEqual(new Uint8Array());
  });
});

describe("DELETE /api/facebook/pages/[id] authenticates before reading the body", () => {
  const params = { params: Promise.resolve({ id: "fp_1" }) };
  const delRequest = (body: unknown) =>
    new NextRequest("http://localhost:3000/api/facebook/pages/fp_1", {
      method: "DELETE",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify(body),
    });

  it("answers 401 to a signed-out caller without parsing the JSON", async () => {
    state.context = null;
    const request = delRequest({ purge: true });
    const json = vi.spyOn(request, "json");
    expect((await removePage(request, params)).status).toBe(401);
    expect(json).not.toHaveBeenCalled();
  });

  it("answers 403 to a MEMBER without parsing the JSON", async () => {
    as("MEMBER");
    const request = delRequest({});
    const json = vi.spyOn(request, "json");
    expect((await removePage(request, params)).status).toBe(403);
    expect(json).not.toHaveBeenCalled();
  });

  it("still keeps the purge for owners", async () => {
    as("ADMIN");
    expect((await removePage(delRequest({ purge: true }), params)).status).toBe(403);
  });
});

// ─── 3. Per-brand limits ────────────────────────────────────────────────────

describe("rate limit on the test routes", () => {
  const post = (path: string, body: unknown) =>
    new NextRequest(`http://localhost:3000${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify(body),
    });

  it("answers 429 to a bot test above the limit and does nothing", async () => {
    as("MEMBER");
    state.quota.mockResolvedValue({ allowed: false, retryAfter: 1800 });
    const response = await tryBot(post("/api/bot/test", { message: "salam" }));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("1800");
    expect(await response.json()).toMatchObject({ code: "rate_limited", error: "Too many bot tests this hour. Try again later." });
    expect(state.quota).toHaveBeenCalledWith("bot-test", "ws_a", 60);
    expect(bot.getBotSettings).not.toHaveBeenCalled();
  });

  it("does not count a bot test that is invalid anyway", async () => {
    as("MEMBER");
    expect((await tryBot(post("/api/bot/test", { message: "" }))).status).toBe(400);
    expect(state.quota).not.toHaveBeenCalled();
  });

  it("answers 429 to a test alert above the limit and sends nothing", async () => {
    as("ADMIN");
    state.quota.mockResolvedValue({ allowed: false, retryAfter: 60 });
    const response = await testAlerts(post("/api/alerts/test", {}));
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ code: "rate_limited", error: "Too many test alerts this hour. Try again later." });
    expect(state.quota).toHaveBeenCalledWith("alert-test", "ws_a", 10);
    expect(dispatch.sendTestAlerts).not.toHaveBeenCalled();
  });

  it("sends the test alert within the limit", async () => {
    as("ADMIN");
    dispatch.sendTestAlerts.mockResolvedValue([]);
    expect((await testAlerts(post("/api/alerts/test", {}))).status).toBe(200);
    expect(dispatch.sendTestAlerts).toHaveBeenCalledWith("ws_a", null);
  });

  it("the counter allows up to the limit, counts per window and brand, and says when to retry", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 10, 26, 10, 30, 0));
    redis.exec.mockResolvedValue([[null, 10], [null, 1]]);
    await expect(actualLimit.takeWorkspaceQuota("alert-test", "ws_a", 10)).resolves.toEqual({ allowed: true, retryAfter: 1800 });
    expect(redis.incr).toHaveBeenCalledWith(expect.stringMatching(/^limit:alert-test:ws_a:\d+$/));
    expect(redis.expire).toHaveBeenCalledWith(expect.any(String), 3600);
    redis.exec.mockResolvedValue([[null, 11], [null, 1]]);
    await expect(actualLimit.takeWorkspaceQuota("alert-test", "ws_a", 10)).resolves.toMatchObject({ allowed: false });
    vi.restoreAllMocks();
  });

  it("lets the call through, and logs, when Redis fails or does not answer", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    redis.exec.mockRejectedValue(new Error("connection closed"));
    await expect(actualLimit.takeWorkspaceQuota("bot-test", "ws_a", 60)).resolves.toMatchObject({ allowed: true });
    expect(log).toHaveBeenCalledTimes(1);

    vi.useFakeTimers();
    redis.exec.mockReturnValue(new Promise(() => undefined));
    const pending = actualLimit.takeWorkspaceQuota("bot-test", "ws_a", 60);
    await vi.advanceTimersByTimeAsync(2000);
    await expect(pending).resolves.toMatchObject({ allowed: true });
    expect(log).toHaveBeenCalledTimes(2);

    redis.exec.mockResolvedValue([[new Error("WRONGTYPE"), null]]);
    await expect(actualLimit.takeWorkspaceQuota("bot-test", "ws_a", 60)).resolves.toMatchObject({ allowed: true });
    log.mockRestore();
  });
});

// ─── 4. Brand cap ───────────────────────────────────────────────────────────

describe("brand cap", () => {
  it("is 100", () => {
    expect(MAX_OWNED_BRANDS).toBe(100);
  });

  it("creates the 100th brand and refuses the 101st, without creating it", async () => {
    db.workspace.create.mockResolvedValue({ id: "ws_new", name: "Maison", createdAt: new Date() });
    db.workspaceMember.count.mockResolvedValue(MAX_OWNED_BRANDS - 1);
    await expect(createBrandWorkspace("u1", "Maison")).resolves.toMatchObject({ id: "ws_new" });
    expect(db.workspaceMember.count).toHaveBeenCalledWith({ where: { userId: "u1", role: "OWNER" } });

    db.workspace.create.mockClear();
    db.workspaceMember.count.mockResolvedValue(MAX_OWNED_BRANDS);
    await expect(createBrandWorkspace("u1", "Maison")).rejects.toBeInstanceOf(BrandLimitError);
    expect(db.workspace.create).not.toHaveBeenCalled();
  });

  it("answers 403 with a catalog message from the route, and sets no cookie", async () => {
    db.workspaceMember.count.mockResolvedValue(MAX_OWNED_BRANDS);
    const response = await createBrand(
      new NextRequest("http://localhost:3000/api/agency/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: ORIGIN },
        body: JSON.stringify({ name: "One more" }),
      })
    );
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("You have reached the maximum number of brands.");
    expect(db.workspace.create).not.toHaveBeenCalled();
    expect(state.cookieSet).not.toHaveBeenCalled();
  });
});

// ─── 5. Public media revalidation ───────────────────────────────────────────

describe("GET /api/public/media/[publicId]", () => {
  const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64"
  );
  const SHA = "a".repeat(64);
  const publicId = newPublicId();
  const get = (headers: Record<string, string> = {}) =>
    getMedia(new NextRequest(`http://localhost:3000/api/public/media/${publicId}`, { headers }), {
      params: Promise.resolve({ publicId }),
    });

  beforeEach(() => {
    db.productImage.findUnique.mockImplementation(async ({ select }: { select: Record<string, boolean> }) => ({
      mimeType: "image/png",
      size: PNG.length,
      sha256: SHA,
      ...(select.data ? { data: new Uint8Array(PNG) } : {}),
    }));
  });

  it("answers 304 to a matching If-None-Match without loading the bytes", async () => {
    const response = await get({ "if-none-match": `"${SHA}"` });
    expect(response.status).toBe(304);
    expect(response.headers.get("etag")).toBe(`"${SHA}"`);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(db.productImage.findUnique).toHaveBeenCalledTimes(1);
    expect(db.productImage.findUnique.mock.calls[0][0].select).not.toHaveProperty("data");
  });

  it("loads the bytes only for a 200", async () => {
    const response = await get({ "if-none-match": '"stale"' });
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).equals(PNG)).toBe(true);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-length")).toBe(String(PNG.length));
    expect(db.productImage.findUnique).toHaveBeenCalledTimes(2);
    expect(db.productImage.findUnique.mock.calls[1][0].select).toMatchObject({ data: true });
  });

  it("answers 404 for an unknown id, a malformed one, or a row whose type is not an image", async () => {
    db.productImage.findUnique.mockResolvedValue(null);
    expect((await get()).status).toBe(404);

    db.productImage.findUnique.mockResolvedValue({ mimeType: "text/html", size: 5, sha256: SHA });
    expect((await get({ "if-none-match": `"${SHA}"` })).status).toBe(404);

    db.productImage.findUnique.mockClear();
    const bad = await getMedia(new NextRequest("http://localhost:3000/api/public/media/x"), { params: Promise.resolve({ publicId: "x" }) });
    expect(bad.status).toBe(404);
    expect(db.productImage.findUnique).not.toHaveBeenCalled();
  });

  it("still serves only what the bytes are", async () => {
    db.productImage.findUnique.mockImplementation(async ({ select }: { select: Record<string, boolean> }) => ({
      mimeType: "image/png",
      size: 40,
      sha256: SHA,
      ...(select.data ? { data: new TextEncoder().encode("<!doctype html><script>alert(1)</script>") } : {}),
    }));
    expect((await get()).status).toBe(404);
  });
});

// ─── 6. Telegram chat picker ────────────────────────────────────────────────

describe("alerts page chat picker", () => {
  const source = readFileSync("app/(dashboard)/facebook/alerts/page.tsx", "utf8");

  it("shows the type, the @username and the id next to the self-chosen title", () => {
    expect(source).toContain("chatTypeLabel(chat.type, t)");
    expect(source).toContain("chat.username ? `@${chat.username}` : null");
    expect(source).toMatch(/chat\.id\s*\]/);
    expect(source).toContain('t("Private chat")');
    expect(source).toContain('t("Group")');
    expect(source).toContain('t("Telegram channel")');
  });
});
