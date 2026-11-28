import { describe, expect, it } from "vitest";
import { decide, handoffText, MODEL_CATEGORIES, SYSTEM_REASONS } from "../../lib/bot/classify";
import { GUARD_REASONS } from "../../lib/bot/guard";

const REFERENCE = ["Robe Kabyle", "4500 DA"];

describe("the model's decision", () => {
  it.each(["WHOLESALE_ORDER", "CUSTOM_ORDER", "COMPLAINT", "NOT_IN_KB", "OTHER"])("hands off as %s", (category) => {
    expect(decide({ handoff: true, category, reason: "طلب 50 حبة", reply: "" }, REFERENCE)).toEqual({
      kind: "handoff",
      category,
      reason: "طلب 50 حبة",
      source: "model",
    });
  });

  it("files a handoff without a usable category under OTHER", () => {
    expect(decide({ handoff: true, category: "NONE", reason: "", reply: "" }, REFERENCE)).toMatchObject({
      category: "OTHER",
      reason: SYSTEM_REASONS.noReason,
    });
    expect(decide({ handoff: true, category: "REFUND", reason: "x", reply: "" }, REFERENCE)).toMatchObject({
      category: "OTHER",
    });
  });

  it("never lets the model pick AUDIO_FAILED: that one is the code's", () => {
    expect(MODEL_CATEGORIES).not.toContain("AUDIO_FAILED");
    expect(decide({ handoff: true, category: "AUDIO_FAILED", reason: "x", reply: "" }, REFERENCE)).toMatchObject({
      category: "OTHER",
    });
  });

  it("reads a category without handoff as a handoff: the safe reading", () => {
    expect(
      decide({ handoff: false, category: "COMPLAINT", reason: "زبون غاضب", reply: "سامحنا" }, REFERENCE)
    ).toMatchObject({ kind: "handoff", category: "COMPLAINT" });
  });

  it("answers when the reply passes the guard", () => {
    expect(decide({ handoff: false, category: "NONE", reason: "", reply: " السعر 4500 DA " }, REFERENCE)).toEqual({
      kind: "reply",
      text: "السعر 4500 DA",
    });
  });

  it("hands off as NOT_IN_KB when the guard stops the reply", () => {
    expect(decide({ handoff: false, category: "NONE", reason: "", reply: "السعر 3900 DA" }, REFERENCE)).toEqual({
      kind: "handoff",
      category: "NOT_IN_KB",
      reason: GUARD_REASONS.number,
      source: "guard",
      detail: "3900",
    });
  });

  it.each([null, "text", { reply: "hi" }, { handoff: "no", category: "NONE" }])(
    "hands off as OTHER when the output is not the expected JSON (%#)",
    (output) => {
      expect(decide(output, REFERENCE)).toEqual({
        kind: "handoff",
        category: "OTHER",
        reason: SYSTEM_REASONS.invalidAnswer,
        source: "system",
      });
    }
  );

  it("keeps a model's reason short", () => {
    const decision = decide({ handoff: true, category: "OTHER", reason: "x".repeat(1000), reply: "" }, REFERENCE);
    expect(decision.kind === "handoff" && decision.reason.length).toBe(300);
  });
});

describe("a partial answer before handing off", () => {
  it("keeps what the model could answer when the guard passes it", () => {
    expect(
      decide({ handoff: true, category: "NOT_IN_KB", reason: "التوصيل لسطيف", reply: "Robe Kabyle بـ 4500 DA" }, REFERENCE)
    ).toMatchObject({ kind: "handoff", category: "NOT_IN_KB", partial: "Robe Kabyle بـ 4500 DA" });
  });

  it("drops it when the guard refuses it: an invented price never goes out", () => {
    expect(decide({ handoff: true, category: "NOT_IN_KB", reason: "x", reply: "التوصيل بـ 600 DA" }, REFERENCE)).not.toHaveProperty(
      "partial"
    );
  });

  it("ends with the shop's message, once", () => {
    expect(handoffText(undefined, "نرجعولك")).toBe("نرجعولك");
    expect(handoffText("كاين بالأبيض والرمادي.", "نرجعولك")).toBe("كاين بالأبيض والرمادي.\nنرجعولك");
    expect(handoffText("كاين بالأبيض، وعلى التوصيل لسطيف نرجعولك!", "نرجعولك")).toBe("كاين بالأبيض، وعلى التوصيل لسطيف نرجعولك!");
  });
});
