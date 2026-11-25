import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerCustomer, rewriteRequest } from "../../lib/bot/answer";
import { readCustomer } from "../../lib/bot/classify";
import { GUARD_REASONS } from "../../lib/bot/guard";
import { BOT_RESPONSE_SCHEMA, buildSystemInstruction, guardSources, type PromptInput } from "../../lib/bot/prompt";
import { DEFAULT_PERSONA, DEFAULT_PLAYBOOK } from "../../lib/bot/persona";
import { isOrderReady } from "../../lib/bot/persona-store";
import type { OrderDraft } from "../../lib/bot/order";

/**
 * Phase 11 in the bot's answer: the customer's state and order details it
 * reports, one rewrite when the guard refuses a reply, the persona and the
 * order in the prompt, and when an order is ready for a person.
 */
const INPUT: PromptInput = {
  businessName: "Maison Lina",
  pageName: "Lina Outlet",
  instructions: null,
  knowledge: [{ kind: "PRODUCT", title: "Robe Kabyle", content: "S à XL", price: "4500 DA", isActive: true }],
  campaign: { name: "Promo", botContext: "Robe pour les fêtes", landingUrl: "https://shop.example/robe" },
  history: [
    { from: "page", by: "campaign", text: "Salam! Tous les détails ici 👇" },
    { from: "customer", text: "c'est 4000 DA ? mon numéro 0550123456" },
    { from: "page", by: "bot", text: "Le prix est 4500 DA." },
    { from: "page", by: "person", text: "Livraison 48h à Oran." },
  ],
};

const answer = (fields: Record<string, unknown>) => ({
  handoff: false,
  category: "NONE",
  reason: "",
  customer_state: "NEUTRAL",
  order: { product: "", colour: "", quantity: "", wilaya: "", name: "", phone: "", address: "" },
  reply: "",
  ...fields,
});

const generated = (data: unknown) => ({ data, result: { text: "", finishReason: "STOP", usage: null } });

beforeEach(() => {
  vi.stubEnv("GOOGLE_API_KEY", "AIza-test");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("what the model reads of the customer", () => {
  it("takes a known state and an order object, whatever it decided", () => {
    expect(readCustomer(answer({ customer_state: "READY_TO_BUY", order: { wilaya: "Oran" } }))).toEqual({
      customerState: "READY_TO_BUY",
      order: { wilaya: "Oran" },
    });
    expect(readCustomer(answer({ handoff: true, category: "COMPLAINT", customer_state: "ANGRY" })).customerState).toBe("ANGRY");
  });

  it("ignores an unknown state or a malformed order, without costing the answer", () => {
    expect(readCustomer(answer({ customer_state: "EXCITED", order: ["Oran"] }))).toEqual({ customerState: null, order: null });
    expect(readCustomer(null)).toEqual({ customerState: null, order: null });
    expect(readCustomer("text")).toEqual({ customerState: null, order: null });
  });
});

describe("the guard's two sources", () => {
  it("counts the shop's words (knowledge, campaign, the team) apart from the customer and the bot", () => {
    const sources = guardSources(INPUT, ["Robe Kabyle | 4500 DA"]);
    expect(sources.brand).toEqual(
      expect.arrayContaining([
        "Robe Kabyle | 4500 DA",
        "Maison Lina",
        "Robe pour les fêtes",
        "https://shop.example/robe",
        "Salam! Tous les détails ici 👇",
        "Livraison 48h à Oran.",
      ])
    );
    expect(sources.brand).not.toContain("c'est 4000 DA ? mon numéro 0550123456");
    expect(sources.brand).not.toContain("Le prix est 4500 DA.");
    expect(sources.conversation).toEqual(["c'est 4000 DA ? mon numéro 0550123456", "Le prix est 4500 DA."]);
  });
});

describe("one rewrite when the guard refuses a reply", () => {
  it("asks once, with the reason, and sends the rewritten reply", async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce(generated(answer({ reply: "Oui, 4000 DA." })))
      .mockResolvedValueOnce(generated(answer({ reply: "Le prix est 4500 DA.", customer_state: "PRICE_ONLY" })));
    const result = await answerCustomer(INPUT, { generate });
    expect(result.decision).toEqual({ kind: "reply", text: "Le prix est 4500 DA." });
    expect(result.attempts).toBe(2);
    expect(result.customerState).toBe("PRICE_ONLY");
    const retry = generate.mock.calls[1][0];
    expect(retry.contents).toHaveLength(3);
    expect(retry.contents[1]).toEqual({ role: "model", parts: [{ text: expect.stringContaining("4000 DA") }] });
    expect(retry.contents[2].role).toBe("user");
    expect(retry.contents[2].parts[0].text).toContain(GUARD_REASONS.price);
    expect(retry.contents[2].parts[0].text).toContain("4000");
    expect(retry.systemInstruction).toBe(generate.mock.calls[0][0].systemInstruction);
  });

  it("hands off when the rewrite is refused too", async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce(generated(answer({ reply: "Oui, 4000 DA." })))
      .mockResolvedValueOnce(generated(answer({ reply: "Pour vous, 3900 DA." })));
    const result = await answerCustomer(INPUT, { generate });
    expect(result.decision).toMatchObject({ kind: "handoff", category: "NOT_IN_KB", source: "guard" });
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("keeps the guard's handoff when the rewrite cannot be had", async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce(generated(answer({ reply: "Oui, 4000 DA.", customer_state: "PRICE_ONLY" })))
      .mockRejectedValueOnce(new Error("network"));
    const result = await answerCustomer(INPUT, { generate });
    expect(result.decision).toMatchObject({ kind: "handoff", source: "guard" });
    expect(result.customerState).toBe("PRICE_ONLY");
  });

  it("never asks again for the model's own handoff, or for a good reply", async () => {
    const generate = vi.fn().mockResolvedValue(generated(answer({ handoff: true, category: "COMPLAINT", reason: "زعفان" })));
    expect((await answerCustomer(INPUT, { generate })).decision).toMatchObject({ category: "COMPLAINT", source: "model" });
    generate.mockResolvedValue(generated(answer({ reply: "Le prix est 4500 DA, livraison 48h à Oran." })));
    expect((await answerCustomer(INPUT, { generate })).attempts).toBe(1);
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("tells the model the detail it must drop", () => {
    expect(rewriteRequest({ kind: "handoff", category: "NOT_IN_KB", reason: GUARD_REASONS.link, source: "guard", detail: "evil.example" })).toContain(
      "evil.example"
    );
  });
});

describe("the persona and the order in the prompt", () => {
  it("puts the persona sections under the strict rules, with the default playbook", () => {
    const text = buildSystemInstruction(INPUT);
    expect(text.indexOf("STRICT RULES")).toBeLessThan(text.indexOf("## WHO YOU ARE"));
    expect(text.indexOf("## WHO YOU ARE")).toBeLessThan(text.indexOf("## KNOWLEDGE BASE"));
    expect(text).toContain(DEFAULT_PLAYBOOK.slice(0, 80));
  });

  it("shows the order details only when the goal collects them", () => {
    const order = { fields: ["WILAYA", "PHONE"] as ("WILAYA" | "PHONE")[], draft: null };
    expect(buildSystemInstruction({ ...INPUT, order })).toContain("## ORDER DETAILS");
    expect(buildSystemInstruction({ ...INPUT, order, persona: { ...DEFAULT_PERSONA, goal: "ANSWER_ONLY" } })).not.toContain(
      "## ORDER DETAILS"
    );
    expect(buildSystemInstruction({ ...INPUT, order: { fields: [], draft: null } })).not.toContain("## ORDER DETAILS");
  });

  it("asks for the customer's state, then the decision, the order and the reply", () => {
    expect(BOT_RESPONSE_SCHEMA.propertyOrdering).toEqual(["customer_state", "handoff", "category", "reason", "order", "reply"]);
    expect(BOT_RESPONSE_SCHEMA.properties.customer_state.enum).toContain("READY_TO_BUY");
    expect(BOT_RESPONSE_SCHEMA.required).toEqual(expect.arrayContaining(["customer_state", "order"]));
  });
});

describe("when an order is ready for a person", () => {
  const complete: OrderDraft = {
    productId: "p1",
    productName: "Papier peint",
    variantCode: null,
    values: { WILAYA: "31 - Oran", PHONE: "0550123456" },
    problems: {},
  };
  const settings = (goal: "SELL" | "ANSWER_ONLY", orderFields: ("WILAYA" | "PHONE")[]) => ({
    persona: { ...DEFAULT_PERSONA, goal },
    orderFields,
  });

  it("when every detail the brand asks for is there", () => {
    expect(isOrderReady(settings("SELL", ["WILAYA", "PHONE"]), "READY_TO_BUY", complete)).toBe(true);
    expect(isOrderReady(settings("SELL", ["WILAYA", "PHONE"]), "READY_TO_BUY", { ...complete, values: { WILAYA: "31 - Oran" } })).toBe(
      false
    );
    expect(isOrderReady(settings("SELL", ["WILAYA", "PHONE"]), "READY_TO_BUY", null)).toBe(false);
  });

  it("as soon as the customer is ready to buy, when the bot collects nothing", () => {
    expect(isOrderReady(settings("ANSWER_ONLY", ["WILAYA"]), "READY_TO_BUY", null)).toBe(true);
    expect(isOrderReady(settings("ANSWER_ONLY", ["WILAYA"]), "HESITANT", complete)).toBe(false);
    expect(isOrderReady(settings("SELL", []), "READY_TO_BUY", null)).toBe(true);
  });
});
