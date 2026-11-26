/**
 * The Telegram voice interview: the state machine, the commands, the
 * questions, and the extraction with Gemini mocked.
 */
import { describe, expect, it, vi } from "vitest";
import { GeminiError, type generateJson } from "../../lib/ai/gemini";
import {
  advance,
  currentQuestion,
  extractAnswer,
  INTERVIEW_QUESTIONS,
  interviewMessages,
  MAX_INTERVIEW_PRODUCTS,
  parseCommand,
  skipProduct,
  startInterview,
  stopInterview,
  syncInterview,
  type InterviewState,
  type InterviewTarget,
} from "../../lib/knowledge/interview";

const PRODUCTS = [
  { id: "p1", name: "عسل السدر" },
  { id: "p2", name: "Crème hydratante" },
  { id: "p3", name: "زيت الأرغان" },
];
const QUESTIONS = INTERVIEW_QUESTIONS.length;

/** A generate mock answering with this data. */
function answering(data: unknown) {
  return vi.fn(async () => ({ data, result: { text: JSON.stringify(data), finishReason: "STOP", usage: null } })) as unknown as typeof generateJson & ReturnType<typeof vi.fn>;
}

const ask = (target: InterviewTarget, productName = "عسل السدر") => ({ productId: "p1", productName, target });

// ─── Questions ──────────────────────────────────────────────────────────────

describe("INTERVIEW_QUESTIONS", () => {
  it("has one question per target, in Arabic letters, without a digit", () => {
    const targets = INTERVIEW_QUESTIONS.map((q) => q.target);
    expect(new Set(targets)).toEqual(new Set(["strengths", "comparisons", "objections", "suitableFor", "faq"]));
    expect(targets).toHaveLength(5);
    for (const question of INTERVIEW_QUESTIONS) {
      const text = question.ask("X");
      expect(text).toMatch(/[؀-ۿ]/);
      expect(text).not.toMatch(/[0-9٠-٩۰-۹]/);
      expect(text).toContain("«X»");
      expect(text).toMatch(/؟/);
    }
  });

  it("puts the product name on one bounded line", () => {
    const text = INTERVIEW_QUESTIONS[0].ask(`Crème\n‮وجه ${"a".repeat(300)}`);
    expect(text).not.toMatch(/[\n‮]/);
    expect(text.length).toBeLessThan(220);
    expect(INTERVIEW_QUESTIONS[0].ask("   ")).toContain("«هاد المنتوج»");
  });
});

// ─── State machine ──────────────────────────────────────────────────────────

describe("startInterview", () => {
  it("drops blanks and repeats and keeps the order", () => {
    expect(startInterview(["p1", " p2 ", "", "p1", "p3"])).toEqual({
      status: "ACTIVE",
      productIds: ["p1", "p2", "p3"],
      position: 0,
      question: 0,
    });
  });

  it("takes at most fifty products", () => {
    const ids = Array.from({ length: 80 }, (_, i) => `p${i}`);
    expect(MAX_INTERVIEW_PRODUCTS).toBe(50);
    expect(startInterview(ids).productIds).toHaveLength(50);
    expect(startInterview(ids).productIds.at(-1)).toBe("p49");
  });

  it("is DONE at once with no product", () => {
    const state = startInterview([]);
    expect(state.status).toBe("DONE");
    expect(currentQuestion(state, PRODUCTS)).toBeNull();
  });
});

describe("the interview, end to end", () => {
  it("asks every question for every product, then is DONE", () => {
    let state = startInterview(["p1", "p2"]);
    const asked: string[] = [];
    for (;;) {
      const question = currentQuestion(state, PRODUCTS);
      if (!question) break;
      asked.push(`${question.productId}:${question.target}`);
      state = advance(state);
    }
    expect(asked).toHaveLength(2 * QUESTIONS);
    expect(asked.slice(0, QUESTIONS)).toEqual(INTERVIEW_QUESTIONS.map((q) => `p1:${q.target}`));
    expect(asked.slice(QUESTIONS)).toEqual(INTERVIEW_QUESTIONS.map((q) => `p2:${q.target}`));
    expect(state).toEqual({ status: "DONE", productIds: ["p1", "p2"], position: 2, question: 0 });
    // Past the end nothing moves.
    expect(advance(state)).toEqual(state);
    expect(skipProduct(state)).toEqual(state);
  });

  it("writes each question with that product's name", () => {
    let state = startInterview(["p1", "p2"]);
    expect(currentQuestion(state, PRODUCTS)).toEqual({
      productId: "p1",
      target: INTERVIEW_QUESTIONS[0].target,
      text: INTERVIEW_QUESTIONS[0].ask("عسل السدر"),
    });
    state = skipProduct(state);
    expect(currentQuestion(state, PRODUCTS)?.text).toContain("«Crème hydratante»");
  });

  it("skips a question, then a product, then stops", () => {
    let state = startInterview(["p1", "p2", "p3"]);
    state = advance(state); // the question skipped (or answered)
    expect(state).toMatchObject({ position: 0, question: 1 });
    state = skipProduct(state);
    expect(state).toMatchObject({ status: "ACTIVE", position: 1, question: 0 });
    expect(currentQuestion(state, PRODUCTS)?.productId).toBe("p2");
    state = stopInterview(state);
    expect(state.status).toBe("STOPPED");
    expect(currentQuestion(state, PRODUCTS)).toBeNull();
    expect(advance(state)).toEqual(state);
    expect(skipProduct(state)).toEqual(state);
    expect(stopInterview(startInterview([])).status).toBe("DONE");
  });

  it("skipping the last product ends the interview", () => {
    const state = skipProduct({ status: "ACTIVE", productIds: ["p1", "p2"], position: 1, question: 3 });
    expect(state).toEqual({ status: "DONE", productIds: ["p1", "p2"], position: 2, question: 0 });
  });

  it("passes over products deleted while it ran, starting the next at its first question", () => {
    const remaining = PRODUCTS.filter((product) => product.id !== "p2");
    const state: InterviewState = { status: "ACTIVE", productIds: ["p1", "p2", "p3"], position: 1, question: 2 };
    expect(currentQuestion(state, remaining)).toEqual({
      productId: "p3",
      target: INTERVIEW_QUESTIONS[0].target,
      text: INTERVIEW_QUESTIONS[0].ask("زيت الأرغان"),
    });
    expect(syncInterview(state, remaining)).toMatchObject({ position: 2, question: 0 });
    // With products given, advance moves from the question actually asked.
    expect(advance(state, remaining)).toMatchObject({ position: 2, question: 1 });
    expect(skipProduct(state, remaining)).toMatchObject({ status: "DONE", position: 3 });
  });

  it("is DONE when every product left is gone", () => {
    const state = startInterview(["p1", "gone"]);
    const last = { ...state, position: 0, question: QUESTIONS - 1 };
    expect(advance(last, PRODUCTS)).toMatchObject({ status: "DONE", position: 2 });
    expect(currentQuestion(startInterview(["gone"]), PRODUCTS)).toBeNull();
  });

  it("does not mutate the state given", () => {
    const state = startInterview(["p1", "p2"]);
    const copy = structuredClone(state);
    advance(state);
    skipProduct(state);
    stopInterview(state);
    syncInterview(state, []);
    expect(state).toEqual(copy);
  });

  it("survives a state mangled in storage", () => {
    const broken = { status: "WEIRD", productIds: ["p1", 7, "p2"], position: -3, question: 99 } as unknown as InterviewState;
    expect(currentQuestion(broken, PRODUCTS)?.productId).toBe("p2");
    const fractional = { status: "ACTIVE", productIds: ["p1"], position: 0.5, question: Number.NaN } as InterviewState;
    expect(currentQuestion(fractional, PRODUCTS)?.target).toBe(INTERVIEW_QUESTIONS[0].target);
    expect(syncInterview({ status: "ACTIVE", productIds: ["p1"], position: 5, question: 0 }, PRODUCTS).status).toBe("DONE");
  });
});

// ─── Commands ───────────────────────────────────────────────────────────────

describe("parseCommand", () => {
  it.each([
    ["/interview", "start"],
    ["/skip", "skip"],
    ["/next", "next_product"],
    ["/stop", "stop"],
    ["/status", "status"],
    ["/STOP", "stop"],
    ["/skip@OpenReplyAlertsBot", "skip"],
  ])("reads the slash command %s", (text, command) => {
    expect(parseCommand(text)).toBe(command);
  });

  it.each([
    ["ابدا", "start"],
    ["إبدأ", "start"],
    ["يلا نبداو!", "start"],
    ["فوت", "skip"],
    ["فوتها", "skip"],
    ["المنتج الجاي", "next_product"],
    ["المنتوج الجاي", "next_product"],
    ["حبس", "stop"],
    ["بركا", "stop"],
    ["وين وصلنا؟", "status"],
    ["  شحال بقا  ", "status"],
  ])("reads the Darija word %s", (text, command) => {
    expect(parseCommand(text)).toBe(command);
  });

  it.each([
    ["nebdaw", "start"],
    ["fout", "skip"],
    ["7bes", "stop"],
    ["baraka", "stop"],
    ["win wselna", "status"],
  ])("reads the Latin Darija word %s", (text, command) => {
    expect(parseCommand(text)).toBe(command);
  });

  it.each([
    ["Commencer", "start"],
    ["démarrer", "start"],
    ["passer", "skip"],
    ["Question suivante", "skip"],
    ["suivant", "next_product"],
    ["Produit suivant.", "next_product"],
    ["Stop", "stop"],
    ["Arrête", "stop"],
    ["Où on en est ?", "status"],
    ["statut", "status"],
    ["next product", "next_product"],
    ["skip", "skip"],
    ["status", "status"],
  ])("reads the French or English word %s", (text, command) => {
    expect(parseCommand(text)).toBe(command);
  });

  it.each([
    "",
    "   ",
    "/start",
    "/unknown",
    "stop, le produit ne fait pas mal",
    "حبس الشعر الطايح هذا هو اللي يميزو",
    "هو مليح بزاف",
    "x".repeat(80),
  ])("leaves %j as an answer", (text) => {
    expect(parseCommand(text)).toBeNull();
  });

  it("takes no non-string", () => {
    expect(parseCommand(undefined as unknown as string)).toBeNull();
  });
});

// ─── Extraction ─────────────────────────────────────────────────────────────

describe("extractAnswer", () => {
  it("asks Gemini with the rules, the target's task and the answer as JSON data", async () => {
    const generate = answering({ items: ["يداوي الكحة"] });
    await extractAnswer("  هاد العسل يداوي الكحة  ", ask("strengths"), { generate });
    expect(generate).toHaveBeenCalledTimes(1);
    const request = generate.mock.calls[0][0];
    expect(request.model).toBeTruthy();
    expect(request.systemInstruction).toMatch(/Only what the owner said/);
    expect(request.systemInstruction).toMatch(/Task: List what makes the product stand out/);
    expect(request.responseSchema).toMatchObject({ type: "OBJECT", required: ["items"] });
    const text = request.contents[0].parts[0].text as string;
    const data = JSON.parse(text.slice(text.indexOf("{")));
    expect(data).toEqual({
      product: "عسل السدر",
      question: INTERVIEW_QUESTIONS.find((q) => q.target === "strengths")!.ask("عسل السدر"),
      answer: "هاد العسل يداوي الكحة",
    });
  });

  it.each([
    ["strengths", "items"],
    ["objections", "pairs"],
    ["faq", "pairs"],
    ["comparisons", "text"],
    ["suitableFor", "text"],
  ] as const)("asks for the %s shape as %s", async (target, field) => {
    const generate = answering({});
    await extractAnswer("كلام", ask(target), { generate });
    const request = generate.mock.calls[0][0];
    expect(request.responseSchema).toMatchObject({ required: [field] });
  });

  it("returns strengths as one cleaned, de-duplicated list", async () => {
    const generate = answering({
      items: ["- يداوي الكحة", "«طبيعي ميّة بالميّة»", "يداوي الكحة!", "", "   ", 42, null, "**ما فيهش السكر**"],
    });
    const suggestions = await extractAnswer("يداوي الكحة، طبيعي ميّة بالميّة، ما فيهش السكر", ask("strengths"), { generate });
    expect(suggestions).toEqual([
      { target: "strengths", productId: "p1", payload: { items: ["يداوي الكحة", "طبيعي ميّة بالميّة", "ما فيهش السكر"] } },
    ]);
  });

  it("returns objections and FAQ as one suggestion per complete pair", async () => {
    const generate = answering({
      pairs: [
        { question: "واش يجي مغشوش؟", answer: "لا، عندنا شهادة التحليل." },
        { question: "غالي؟", answer: "" },
        { question: "", answer: "جواب بلا سؤال" },
        "junk",
        { question: "واش يجي مغشوش؟", answer: "مرة أخرى" },
      ],
    });
    const objections = await extractAnswer("يخافو يجي مغشوش، نقولهم لا عندنا شهادة التحليل", ask("objections"), { generate });
    expect(objections).toEqual([
      { target: "objections", productId: "p1", payload: { question: "واش يجي مغشوش؟", answer: "لا، عندنا شهادة التحليل." } },
    ]);

    const faq = await extractAnswer("يسقسيو على التوصيل", ask("faq"), {
      generate: answering({ pairs: [{ question: "Livraison ?", answer: "Partout en Algérie." }] }),
    });
    expect(faq).toEqual([{ target: "faq", productId: "p1", payload: { question: "Livraison ?", answer: "Partout en Algérie." } }]);
  });

  it("returns comparisons and suitableFor as one text on one line", async () => {
    const comparisons = await extractAnswer("ماشي كيما العسل تاع السوق", ask("comparisons"), {
      generate: answering({ text: "  ماشي كيما العسل تاع السوق،\nهذا حر.  " }),
    });
    expect(comparisons).toEqual([{ target: "comparisons", productId: "p1", payload: { text: "ماشي كيما العسل تاع السوق، هذا حر." } }]);

    const suitable = await extractAnswer("pour les peaux sèches", ask("suitableFor"), {
      generate: answering({ text: "Pour les peaux sèches, en hiver." }),
    });
    expect(suitable[0]).toMatchObject({ target: "suitableFor", payload: { text: "Pour les peaux sèches, en hiver." } });
  });

  it("bounds the sizes", async () => {
    const long = "كلمة ".repeat(1000);
    const items = await extractAnswer("كلام", ask("strengths"), {
      generate: answering({ items: Array.from({ length: 30 }, (_, i) => `ميزة ${"ب".repeat(i + 1)} ${long}`) }),
    });
    expect(items[0].payload.items).toHaveLength(10);
    for (const item of items[0].payload.items!) expect(item.length).toBeLessThanOrEqual(300);

    const pairs = await extractAnswer("كلام", ask("faq"), {
      generate: answering({ pairs: Array.from({ length: 30 }, (_, i) => ({ question: `سؤال ${"س".repeat(i + 1)} ${long}`, answer: long })) }),
    });
    expect(pairs).toHaveLength(10);
    expect(pairs[0].payload.question!.length).toBeLessThanOrEqual(200);
    expect(pairs[0].payload.answer!.length).toBeLessThanOrEqual(1000);

    const objection = await extractAnswer("كلام", ask("objections"), {
      generate: answering({ pairs: [{ question: long, answer: long }] }),
    });
    expect(objection[0].payload.question!.length).toBeLessThanOrEqual(300);

    const text = await extractAnswer("كلام", ask("comparisons"), { generate: answering({ text: long }) });
    expect(text[0].payload.text!.length).toBeLessThanOrEqual(2000);
    expect(text[0].payload.text!.endsWith("…")).toBe(true);
  });

  it("cuts a long transcript before sending it", async () => {
    const generate = answering({ items: [] });
    await extractAnswer("ك".repeat(20_000), ask("strengths"), { generate });
    const text = generate.mock.calls[0][0].contents[0].parts[0].text as string;
    expect(JSON.parse(text.slice(text.indexOf("{"))).answer).toHaveLength(6000);
  });

  it("strips controls and bidi overrides from what it returns", async () => {
    const suggestions = await extractAnswer("طبيعي", ask("strengths"), { generate: answering({ items: ["طبيعي‮\u0007 مية بالمية"] }) });
    expect(suggestions[0].payload.items).toEqual(["طبيعي مية بالمية"]);
  });

  describe("the digit re-check", () => {
    it("keeps numbers the owner said and drops those the model made up", async () => {
      const suggestions = await extractAnswer("السعر 2500 دج والقرعة فيها 500 غرام", ask("strengths"), {
        generate: answering({ items: ["القرعة فيها 500 غرام", "السعر 2500 دج", "يدوم 3 سنين", "الثمن 2 500 دج", "خصم 50%"] }),
      });
      expect(suggestions[0].payload.items).toEqual(["القرعة فيها 500 غرام", "السعر 2500 دج", "الثمن 2 500 دج"]);
    });

    it("does not take part of a number for the number", async () => {
      const suggestions = await extractAnswer("يجي ب 2500", ask("strengths"), { generate: answering({ items: ["يجي ب 500", "يجي ب 25"] }) });
      expect(suggestions).toEqual([]);
    });

    it("reads Arabic-Indic digits and grouped thousands as the same number", async () => {
      const suggestions = await extractAnswer("السعر ٢٥٠٠ دج، والكبيرة 3 000", ask("strengths"), {
        generate: answering({ items: ["السعر 2500 دج", "الكبيرة ٣٠٠٠", "الكبيرة 3.000"] }),
      });
      expect(suggestions[0].payload.items).toEqual(["السعر 2500 دج", "الكبيرة ٣٠٠٠", "الكبيرة 3.000"]);
    });

    it("lets Arabizi letters through, but not as numbers", async () => {
      const suggestions = await extractAnswer("had l3sel 3ando ri7a mli7a", ask("strengths"), {
        generate: answering({ items: ["3ando ri7a mli7a", "garanti 3 ans", "fih 7 vitamines"] }),
      });
      expect(suggestions[0].payload.items).toEqual(["3ando ri7a mli7a"]);
    });

    it("drops a whole pair or text with an invented number", async () => {
      const pairs = await extractAnswer("يسقسيو على التوصيل، نوصلو لكامل الولايات", ask("faq"), {
        generate: answering({
          pairs: [
            { question: "التوصيل؟", answer: "نوصلو لكامل الولايات في 48 ساعة" },
            { question: "وين توصلو؟", answer: "لكامل الولايات" },
          ],
        }),
      });
      expect(pairs.map((pair) => pair.payload.question)).toEqual(["وين توصلو؟"]);

      const text = await extractAnswer("يصلح للصغار", ask("suitableFor"), { generate: answering({ text: "يصلح للصغار من 3 سنين" }) });
      expect(text).toEqual([]);
    });

    it("strips a list number instead of checking it", async () => {
      const suggestions = await extractAnswer("طبيعي وما فيهش السكر", ask("strengths"), {
        generate: answering({ items: ["1. طبيعي", "2) ما فيهش السكر"] }),
      });
      expect(suggestions[0].payload.items).toEqual(["طبيعي", "ما فيهش السكر"]);
    });
  });

  it("returns [] for an empty answer without asking Gemini", async () => {
    const generate = answering({ items: ["invented"] });
    expect(await extractAnswer("", ask("strengths"), { generate })).toEqual([]);
    expect(await extractAnswer("  ...  ؟ ", ask("strengths"), { generate })).toEqual([]);
    expect(await extractAnswer(null as unknown as string, ask("strengths"), { generate })).toEqual([]);
    expect(generate).not.toHaveBeenCalled();
  });

  it("returns [] when the model found nothing", async () => {
    expect(await extractAnswer("ما نعرفش", ask("strengths"), { generate: answering({ items: [] }) })).toEqual([]);
    expect(await extractAnswer("ما نعرفش", ask("faq"), { generate: answering({ pairs: [] }) })).toEqual([]);
    expect(await extractAnswer("ما نعرفش", ask("comparisons"), { generate: answering({ text: "" }) })).toEqual([]);
  });

  it.each([null, "a string", 42, [], ["x"], { items: "not a list" }, { pairs: { question: "q" } }, { text: 7 }, { other: 1 }])(
    "returns [] for junk model output %j",
    async (data) => {
      for (const target of ["strengths", "faq", "comparisons"] as const) {
        expect(await extractAnswer("كلام عادي", ask(target), { generate: answering(data) })).toEqual([]);
      }
    }
  );

  it("returns [] for an unknown target", async () => {
    const generate = answering({ items: ["x"] });
    expect(await extractAnswer("كلام", ask("price" as InterviewTarget), { generate })).toEqual([]);
    expect(generate).not.toHaveBeenCalled();
  });

  it("lets a Gemini failure through for the caller to retry", async () => {
    const generate = vi.fn(async () => {
      throw new GeminiError("busy", "rate_limited", 429);
    }) as unknown as typeof generateJson;
    await expect(extractAnswer("كلام", ask("strengths"), { generate })).rejects.toMatchObject({ kind: "rate_limited" });
  });
});

// ─── Messages ───────────────────────────────────────────────────────────────

describe("interviewMessages", () => {
  const messages = interviewMessages();

  it("is short Arabic text, with no digit but the ones passed", () => {
    for (const text of [messages.done, messages.stopped, messages.heard, messages.noProducts]) {
      expect(text).toMatch(/[؀-ۿ]/);
      expect(text).not.toMatch(/[0-9٠-٩]/);
      expect(text.length).toBeLessThan(200);
    }
    expect(messages.intro(7)).toContain("7");
    expect(messages.intro(7).replace("7", "")).not.toMatch(/[0-9]/);
    expect(messages.status(3, 12)).toContain("3");
    expect(messages.status(3, 12)).toContain("12");
    expect(messages.status(3, 12).replace("3", "").replace("12", "")).not.toMatch(/[0-9]/);
  });

  it("shows counts as whole numbers from zero up", () => {
    expect(messages.intro(-2)).toContain(" 0 ");
    expect(messages.status(1.7, Number.NaN)).toMatch(/1.*0/);
  });

  it("names the commands it reads", () => {
    for (const command of ["/skip", "/next", "/stop", "/status"]) expect(messages.intro(1)).toContain(command);
    expect(parseCommand("/interview")).toBe("start");
  });
});
