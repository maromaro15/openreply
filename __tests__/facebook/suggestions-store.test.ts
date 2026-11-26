import { beforeEach, describe, expect, it, vi } from "vitest";

/** Where every source of phase 14 leaves its suggestions (PLAN.md 6.15). */
const db = vi.hoisted(() => ({
  product: { findMany: vi.fn() },
  knowledgeSuggestion: { createMany: vi.fn(), count: vi.fn() },
}));
vi.mock("@/lib/db/client", () => ({ prisma: db }));

import {
  cleanSuggestionPayload,
  countPendingSuggestions,
  saveSuggestions,
  suggestionDedupeKey,
  SUGGESTION_LIMITS,
} from "../../lib/knowledge/suggestions";

beforeEach(() => {
  vi.clearAllMocks();
  db.product.findMany.mockResolvedValue([{ id: "prod_wp" }]);
  db.knowledgeSuggestion.createMany.mockImplementation(async ({ data }: { data: unknown[] }) => ({ count: data.length }));
  db.knowledgeSuggestion.count.mockResolvedValue(3);
});

const saved = () => db.knowledgeSuggestion.createMany.mock.calls[0][0].data as Record<string, unknown>[];

describe("the payload a target keeps", () => {
  it("a question and its answer for questions and worries, both required", () => {
    expect(cleanSuggestionPayload("faq", { question: "  واش  كاين التوصيل؟ ", answer: "إيه، 58 ولاية\n\n\n\nفي 48 ساعة", text: "x" })).toEqual({
      question: "واش كاين التوصيل؟",
      answer: "إيه، 58 ولاية\n\nفي 48 ساعة",
    });
    expect(cleanSuggestionPayload("product.objections", { question: "يتقلع؟" })).toBeNull();
  });

  it("a list for strengths, a one-line statement becoming its only item", () => {
    expect(cleanSuggestionPayload("product.strengths", { items: ["يتغسل بالماء", "يتغسل بالماء", " ", 5] })).toEqual({ items: ["يتغسل بالماء"] });
    expect(cleanSuggestionPayload("product.strengths", { text: "ما يتقلعش\nمع الرطوبة" })).toEqual({ items: ["ما يتقلعش مع الرطوبة"] });
    const many = Array.from({ length: 30 }, (_, index) => `item ${index}`);
    expect(cleanSuggestionPayload("product.strengths", { items: many })?.items).toHaveLength(SUGGESTION_LIMITS.items);
  });

  it("one statement for the others, bounded without cutting a character in half", () => {
    expect(cleanSuggestionPayload("delivery", { text: "Oran: 400 DA" })).toEqual({ text: "Oran: 400 DA" });
    const long = cleanSuggestionPayload("product.comparisons", { text: "😀".repeat(SUGGESTION_LIMITS.text + 50) })?.text ?? "";
    expect(Array.from(long)).toHaveLength(SUGGESTION_LIMITS.text);
    expect(cleanSuggestionPayload("product.suitableFor", { text: "   " })).toBeNull();
    expect(cleanSuggestionPayload("faq", ["not", "an", "object"])).toBeNull();
  });
});

describe("saving suggestions", () => {
  it("keeps them PENDING-by-default for one brand, with their source, evidence and key", async () => {
    const key = suggestionDedupeKey("thread_1", "faq", "واش كاين التوصيل؟");
    await expect(
      saveSuggestions("ws_a", "CONVERSATION", [
        { target: "faq", payload: { question: "واش كاين التوصيل؟", answer: "إيه" }, evidence: "«إيه، كاين»", sourceRef: "thread_1", dedupeKey: key },
        { target: "product.strengths", productId: "prod_wp", payload: { items: ["يتغسل"] } },
      ])
    ).resolves.toBe(2);
    expect(saved()).toEqual([
      { workspaceId: "ws_a", source: "CONVERSATION", target: "faq", productId: null, payload: { question: "واش كاين التوصيل؟", answer: "إيه" }, evidence: "«إيه، كاين»", sourceRef: "thread_1", dedupeKey: key },
      { workspaceId: "ws_a", source: "CONVERSATION", target: "product.strengths", productId: "prod_wp", payload: { items: ["يتغسل"] }, evidence: null, sourceRef: null, dedupeKey: null },
    ]);
    expect(db.knowledgeSuggestion.createMany.mock.calls[0][0].skipDuplicates).toBe(true);
    expect(db.product.findMany).toHaveBeenCalledWith({ where: { workspaceId: "ws_a", id: { in: ["prod_wp"] } }, select: { id: true } });
  });

  it("drops a product suggestion for another brand's or no product, an unknown target and an empty payload", async () => {
    await saveSuggestions("ws_a", "INTERVIEW", [
      { target: "product.strengths", productId: "prod_of_ws_b", payload: { items: ["x"] } },
      { target: "product.comparisons", payload: { text: "x" } },
      { target: "price" as never, payload: { text: "1200 DA" } },
      { target: "faq", payload: { question: "?" } },
      // A knowledge entry never points at a product.
      { target: "delivery", productId: "prod_wp", payload: { text: "Oran: 400 DA" } },
    ]);
    expect(saved()).toEqual([expect.objectContaining({ target: "delivery", productId: null })]);
  });

  it("writes nothing when nothing is left", async () => {
    await expect(saveSuggestions("ws_a", "HANDOFF_REPLY", [{ target: "faq", payload: {} }])).resolves.toBe(0);
    expect(db.knowledgeSuggestion.createMany).not.toHaveBeenCalled();
    expect(db.product.findMany).not.toHaveBeenCalled();
  });

  it("gives the same key for the same source, and counts what waits", async () => {
    expect(suggestionDedupeKey("a", null, "b")).toBe(suggestionDedupeKey("a", undefined, "b"));
    expect(suggestionDedupeKey("a", "b")).not.toBe(suggestionDedupeKey("ab"));
    await expect(countPendingSuggestions("ws_a")).resolves.toBe(3);
    expect(db.knowledgeSuggestion.count).toHaveBeenCalledWith({ where: { workspaceId: "ws_a", status: "PENDING" } });
  });
});
