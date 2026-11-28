import { beforeEach, describe, expect, it, vi } from "vitest";

/** Learning from a person's reply: saved only when the brand turned auto-save on. */
const db = vi.hoisted(() => ({
  autoSave: true,
  created: [] as Record<string, unknown>[],
  message: {
    id: "m2",
    workspaceId: "ws",
    conversationId: "c",
    direction: "OUTBOUND",
    author: "HUMAN",
    text: "إيه كاين، واش من لون حبيت؟",
    sentAt: new Date("2026-11-26T10:00:00Z"),
    sentByUserId: "u",
  } as Record<string, unknown>,
}));

vi.mock("@/lib/db/client", () => ({
  prisma: {
    facebookMessage: {
      findUnique: async () => db.message,
      // Newest first, as the code asks.
      findMany: async () => [
        { direction: "OUTBOUND", text: "إيه كاين، واش من لون حبيت؟", transcript: null },
        { direction: "INBOUND", text: "كاين ألوان؟", transcript: null },
        { direction: "INBOUND", text: "السلام", transcript: null },
        { direction: "OUTBOUND", text: "مرحبا", transcript: null },
        { direction: "INBOUND", text: "قديم", transcript: null },
      ],
    },
    botSettings: { findUnique: async () => ({ voiceAutoSave: db.autoSave }) },
    voiceExample: {
      findFirst: async () => null,
      count: async () => 0,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        db.created.push(data);
        return { id: "v1" };
      },
    },
  },
}));

import { learnVoiceFromReply } from "../lib/voice/store";

beforeEach(() => {
  db.autoSave = true;
  db.created = [];
});

describe("learnVoiceFromReply", () => {
  it("saves the customer's messages since the Page last wrote, and the reply", async () => {
    await learnVoiceFromReply("m2");
    expect(db.created).toEqual([
      expect.objectContaining({
        workspaceId: "ws",
        customerText: "السلام / كاين ألوان؟",
        replyText: "إيه كاين، واش من لون حبيت؟",
        source: "HUMAN_REPLY",
        sourceMessageId: "m2",
      }),
    ]);
  });

  it("only offers, saving nothing, when auto-save is off", async () => {
    db.autoSave = false;
    await learnVoiceFromReply("m2");
    expect(db.created).toEqual([]);
  });

  it("never learns from the bot", async () => {
    db.message = { ...db.message, author: "BOT" };
    await learnVoiceFromReply("m2");
    expect(db.created).toEqual([]);
    db.message = { ...db.message, author: "HUMAN" };
  });
});
