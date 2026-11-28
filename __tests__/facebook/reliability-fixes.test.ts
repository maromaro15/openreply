import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  facebookPage: { findMany: vi.fn(), update: vi.fn() },
  facebookWebhookEvent: { deleteMany: vi.fn() },
  productImage: { deleteMany: vi.fn() },
}));
const redis = vi.hoisted(() => ({ set: vi.fn() }));

vi.mock("@/lib/db/client", () => ({ prisma: db }));
vi.mock("@/lib/queue/client", () => ({ getRedisConnection: () => redis }));
vi.mock("@/lib/facebook/pages", () => ({ pageToken: () => "PAGE_TOKEN" }));
vi.mock("@/lib/facebook/graph", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/facebook/graph")>()),
  debugToken: vi.fn(),
}));

import { runDailyMaintenance } from "../../lib/facebook/maintenance";

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  redis.set.mockResolvedValue("OK");
  db.facebookPage.findMany.mockResolvedValue([]);
  db.facebookWebhookEvent.deleteMany.mockResolvedValue({ count: 4 });
  db.productImage.deleteMany.mockResolvedValue({ count: 2 });
});

describe("the daily upkeep", () => {
  it("runs once a day: a second run finds the lock taken", async () => {
    redis.set.mockResolvedValue(null);
    await expect(runDailyMaintenance()).resolves.toBeNull();
    expect(db.facebookWebhookEvent.deleteMany).not.toHaveBeenCalled();
  });

  it("a failing step does not stop the others, and is reported", async () => {
    db.facebookPage.findMany.mockRejectedValue(new Error("database blip"));
    await expect(runDailyMaintenance()).resolves.toEqual({
      tokens: null,
      pruned: 4,
      orphanImages: 2,
      failed: ["tokens"],
    });
    expect(db.productImage.deleteMany).toHaveBeenCalled();

    db.facebookWebhookEvent.deleteMany.mockRejectedValue(new Error("lock timeout"));
    await expect(runDailyMaintenance()).resolves.toMatchObject({
      tokens: null,
      pruned: null,
      orphanImages: 2,
      failed: ["tokens", "pruned"],
    });
  });

  it("all steps pass: nothing failed", async () => {
    await expect(runDailyMaintenance()).resolves.toEqual({
      tokens: { checked: 0, invalid: 0 },
      pruned: 4,
      orphanImages: 2,
      failed: [],
    });
  });
});
