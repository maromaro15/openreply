import { describe, expect, it } from "vitest";
import { correctedOutput } from "../lib/bot/answer";
import { buildSystemInstruction, guardSources } from "../lib/bot/prompt";
import { GLOBAL_VOICE_SEED } from "../lib/voice/defaults";
import { splitPhrases, voicePackSchema } from "../lib/voice/format";
import { applyCorrections, maskFacts, pickExamples, voicePromptSection } from "../lib/voice/select";

const colours = { wrong: "انهي لون", right: ["واش من لون", "اما كولور حبيت"] };

describe("the correction dictionary", () => {
  it("fixes the phrase in any alef spelling, keeping a glued «و»", () => {
    expect(applyCorrections("وأنهي لون يعجبك؟", [colours])).toBe("وواش من لون يعجبك؟");
    expect(applyCorrections("انهي  لون حبيت؟", [colours])).toBe("واش من لون حبيت؟");
    expect(applyCorrections("إنهي لون", [colours])).toBe("واش من لون");
  });

  it("leaves a longer word alone", () => {
    expect(applyCorrections("انهي لونين", [colours])).toBe("انهي لونين");
    expect(applyCorrections("كانهي لون", [colours])).toBe("كانهي لون");
  });

  it("is applied to the model's reply before the guard reads it", () => {
    const voice = { examples: [], corrections: [colours] };
    expect(correctedOutput({ handoff: false, reply: "انهي لون؟" }, { voice })).toEqual({ handoff: false, reply: "واش من لون؟" });
    expect(correctedOutput("not json", { voice })).toBe("not json");
  });
});

describe("example selection", () => {
  const rows = [
    { customer: "السلام عليكم", reply: "مرحبا بيك", brand: false },
    { customer: "كاين ألوان أخرين؟", reply: "إيه كاين", brand: false },
    { customer: "واش من الوان عندكم", reply: "كاين الأبيض", brand: true },
  ];

  it("puts the closest first, the brand's on a tie", () => {
    const picked = pickExamples(rows, ["شحال", "كاين الوان؟"], 2);
    expect(picked.map((example) => example.reply)).toEqual(["إيه كاين", "كاين الأبيض"]);
  });

  it("still shows the voice when nothing is close", () => {
    expect(pickExamples(rows, ["ok"], 3)).toHaveLength(3);
  });
});

describe("the prompt", () => {
  const voice = { examples: [{ customer: "بشحال؟", reply: "السومة 6000 دج" }], corrections: [colours] };
  const input = {
    businessName: "Shop",
    pageName: "Shop",
    instructions: null,
    knowledge: [],
    campaign: null,
    history: [{ from: "customer" as const, text: "بشحال؟" }],
    voice,
  };

  it("shows the examples without their numbers, and the dictionary", () => {
    const section = voicePromptSection(voice);
    expect(section).toContain("## HOW THIS SHOP TALKS");
    expect(section).toContain("«السومة … دج»");
    expect(section).not.toContain("6000");
    expect(section).toContain("Never «انهي لون»; say «واش من لون» or «اما كولور حبيت».");
    expect(buildSystemInstruction(input)).toContain("## HOW THIS SHOP TALKS");
    expect(voicePromptSection(undefined)).toBe("");
  });

  it("trusts the dictionary's phrases, never the examples' facts", () => {
    const sources = guardSources(input, []);
    expect(sources.brand).toContain("واش من لون");
    expect(sources.brand.join(" ")).not.toContain("6000");
  });

  it("masks every kind of digit", () => {
    expect(maskFacts("0550 12 34 56 / ٦٠٠٠ DA / 6000دج")).toBe("… / … DA / …دج");
    expect(maskFacts("mar7ba, 3andek?")).toBe("mar7ba, 3andek?");
  });
});

describe("the voice pack", () => {
  it("reads the global seed as a pack, and the colour fix is in it", () => {
    const pack = voicePackSchema.parse(JSON.parse(JSON.stringify(GLOBAL_VOICE_SEED)));
    expect(pack.examples.length).toBeGreaterThan(5);
    expect(pack.corrections[0]).toMatchObject({ wrong: "انهي لون", right: expect.arrayContaining(["واش من لون", "اما كولور حبيت"]) });
    // A seed example carries no fact.
    for (const example of pack.examples) expect(maskFacts(example.reply)).toBe(example.reply);
  });

  it("refuses anything else", () => {
    expect(voicePackSchema.safeParse({ format: "other", version: 1 }).success).toBe(false);
    expect(voicePackSchema.safeParse({ format: "amitec.voice", version: 1, corrections: [{ wrong: "x", right: [] }] }).success).toBe(false);
  });

  it("splits right phrases by line, keeping commas inside a phrase", () => {
    expect(splitPhrases("إيه، كاين\n\nواش من لون | اما كولور")).toEqual(["إيه، كاين", "واش من لون", "اما كولور"]);
  });
});
