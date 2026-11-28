import { beforeEach, describe, expect, it, vi } from "vitest";

/** The inbox warns when new messages reach no bot. */
const db = vi.hoisted(() => ({
  settings: null as { enabled: boolean } | null,
  pages: [] as { botEnabled: boolean }[],
}));

vi.mock("@/lib/db/client", () => ({
  prisma: {
    botSettings: { findUnique: async () => db.settings },
    facebookPage: { findMany: async () => db.pages },
  },
}));

import { aiReplyOff } from "../../lib/facebook/ai-reply-status";

beforeEach(() => {
  db.settings = { enabled: true };
  db.pages = [{ botEnabled: true }];
});

describe("aiReplyOff", () => {
  it("is off for a new brand, which has no settings yet, and for a brand that turned it off", async () => {
    db.settings = null;
    expect(await aiReplyOff("ws")).toBe("brand");
    db.settings = { enabled: false };
    expect(await aiReplyOff("ws")).toBe("brand");
  });

  it("is off when every Page has the bot off, on while one has it on", async () => {
    db.pages = [{ botEnabled: false }, { botEnabled: false }];
    expect(await aiReplyOff("ws")).toBe("pages");
    db.pages = [{ botEnabled: false }, { botEnabled: true }];
    expect(await aiReplyOff("ws")).toBeNull();
  });

  it("says nothing about Pages before one is connected", async () => {
    db.pages = [];
    expect(await aiReplyOff("ws")).toBeNull();
  });
});
