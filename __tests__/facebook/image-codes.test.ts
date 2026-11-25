/**
 * Codes read on a customer's photo: the Gemini request (mocked), the cleaning
 * of its answer, and the exact lookup in the catalogue (an injected fake).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GeminiError, type generateJson } from "../../lib/ai/gemini";
import {
  cleanReading,
  getGeminiVisionModel,
  getImageMatchMaxCandidates,
  IMAGE_READING_SCHEMA,
  readImageCodes,
} from "../../lib/ai/vision";
import { normalizeCode } from "../../lib/catalog/codes";
import type { CodeMatch } from "../../lib/catalog/products";
import { recognizeFromCodes, type CodeLookup } from "../../lib/catalog/recognize";

type Generate = typeof generateJson;

function generator(data: unknown) {
  return vi.fn<Generate>(async () => ({ data, result: { text: JSON.stringify(data), finishReason: "STOP", usage: null } }));
}

const PHOTO = { bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), mimeType: "image/jpeg" };

beforeEach(() => {
  vi.stubEnv("GEMINI_CHAT_MODEL", "");
  vi.stubEnv("GEMINI_VISION_MODEL", "");
  vi.stubEnv("IMAGE_MATCH_MAX_CANDIDATES", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─── Settings ───────────────────────────────────────────────────────────────

describe("vision settings", () => {
  it("uses the chat model unless a vision model is set", () => {
    expect(getGeminiVisionModel()).toBe("gemini-flash-latest");
    vi.stubEnv("GEMINI_CHAT_MODEL", "gemini-chat-x");
    expect(getGeminiVisionModel()).toBe("gemini-chat-x");
    vi.stubEnv("GEMINI_VISION_MODEL", " models/gemini-vision-y ");
    expect(getGeminiVisionModel()).toBe("gemini-vision-y");
  });

  it("sends 6 candidates by default, between 1 and 10", () => {
    expect(getImageMatchMaxCandidates()).toBe(6);
    vi.stubEnv("IMAGE_MATCH_MAX_CANDIDATES", "3");
    expect(getImageMatchMaxCandidates()).toBe(3);
    vi.stubEnv("IMAGE_MATCH_MAX_CANDIDATES", "0");
    expect(getImageMatchMaxCandidates()).toBe(1);
    vi.stubEnv("IMAGE_MATCH_MAX_CANDIDATES", "50");
    expect(getImageMatchMaxCandidates()).toBe(10);
    vi.stubEnv("IMAGE_MATCH_MAX_CANDIDATES", "lots");
    expect(getImageMatchMaxCandidates()).toBe(6);
  });
});

// ─── The request ────────────────────────────────────────────────────────────

describe("readImageCodes", () => {
  it("sends the instruction and the image inline, with the schema and the vision model", async () => {
    vi.stubEnv("GEMINI_VISION_MODEL", "gemini-vision-y");
    const generate = generator({ codes: ["WP-12"], description: "beige linen curtain" });
    const reading = await readImageCodes({ ...PHOTO, mimeType: "Image/JPEG; charset=binary" }, { generate });

    expect(reading).toEqual({ codes: ["WP-12"], description: "beige linen curtain" });
    expect(generate).toHaveBeenCalledTimes(1);
    const options = generate.mock.calls[0][0];
    expect(options.model).toBe("gemini-vision-y");
    expect(options.responseSchema).toEqual(IMAGE_READING_SCHEMA);
    expect(options.responseSchema).toMatchObject({
      type: "OBJECT",
      properties: { codes: { type: "ARRAY", items: { type: "STRING" } }, description: { type: "STRING" } },
      required: ["codes", "description"],
    });
    expect(options.contents).toHaveLength(1);
    const [instruction, image] = options.contents[0].parts;
    expect(options.contents[0].role).toBe("user");
    expect(instruction.text).toMatch(/exactly as written/);
    expect(instruction.text).toMatch(/Never guess a character/);
    expect(instruction.text).toMatch(/English words/);
    expect(image.inlineData).toEqual({ mimeType: "image/jpeg", data: PHOTO.bytes.toString("base64") });
  });

  it("does not call Gemini for an empty image", async () => {
    const generate = generator({ codes: ["X1"], description: "x" });
    expect(await readImageCodes({ bytes: Buffer.alloc(0), mimeType: "image/png" }, { generate })).toEqual({
      codes: [],
      description: "",
    });
    expect(generate).not.toHaveBeenCalled();
  });

  it("lets Gemini errors through, for the caller to hand off", async () => {
    const generate = vi.fn<Generate>(async () => {
      throw new GeminiError("down", "unavailable");
    });
    await expect(readImageCodes(PHOTO, { generate })).rejects.toMatchObject({ kind: "unavailable" });
  });
});

// ─── The answer ─────────────────────────────────────────────────────────────

describe("cleanReading", () => {
  it("keeps codes trimmed and on one line, without duplicates by normalised key", () => {
    expect(
      cleanReading({
        codes: ["  WP-12 ", "wp 12", "WP\n17", "", "   ", "-", "Réf 4501", "١٧"],
        description: "  grey\nvelvet   sofa ",
      })
    ).toEqual({ codes: ["WP-12", "WP 17", "Réf 4501", "١٧"], description: "grey velvet sofa" });
  });

  it("drops wrong types and answers that are not objects", () => {
    expect(cleanReading({ codes: [12, null, { code: "A1" }, ["B2"], "C3"], description: 42 })).toEqual({
      codes: ["C3"],
      description: "",
    });
    expect(cleanReading({ codes: "WP-12", description: null })).toEqual({ codes: [], description: "" });
    expect(cleanReading(null)).toEqual({ codes: [], description: "" });
    expect(cleanReading("WP-12")).toEqual({ codes: [], description: "" });
    expect(cleanReading([{ codes: ["A1"] }])).toEqual({ codes: [], description: "" });
  });

  it("drops a code too long to be one instead of cutting it", () => {
    const long = `REF-${"9".repeat(60)}`;
    expect(cleanReading({ codes: [long, "A".repeat(60)], description: "" }).codes).toEqual(["A".repeat(60)]);
  });

  it("keeps at most 20 codes and a 300-character description", () => {
    const codes = Array.from({ length: 30 }, (_, index) => `C${index}`);
    const reading = cleanReading({ codes, description: "word ".repeat(200) });
    expect(reading.codes).toEqual(codes.slice(0, 20));
    expect(reading.description.length).toBeLessThanOrEqual(300);
    expect(reading.description).not.toMatch(/\s$/);
  });

  it("removes control and bidi characters", () => {
    expect(cleanReading({ codes: ["WP\u202e-12\u0000"], description: "red\u2028rug\u0007" })).toEqual({
      codes: ["WP -12"],
      description: "red rug",
    });
  });
});

// ─── The catalogue ──────────────────────────────────────────────────────────

const VOILAGE = "p_voilage";
const RIDEAU = "p_rideau";

const V12 = { id: "v_12", code: "WP-12", name: "Gris" };
const V17 = { id: "v_17", code: "WP-17", name: "Beige" };
const R12 = { id: "r_12", code: "12", name: "Blanc" };
const S12 = { id: "s_12", code: "12", name: "Noir" };

/** A fake findByCodeKey: product codes and colour codes, by normalised key. */
function catalogue(): { lookup: CodeLookup; keys: string[] } {
  const products: Record<string, { id: string; name: string }> = {
    WP: { id: VOILAGE, name: "Voilage lin" },
    RD100: { id: RIDEAU, name: "Rideau occultant" },
  };
  const variants: { productId: string; name: string; variant: CodeMatch["variant"] }[] = [
    { productId: VOILAGE, name: "Voilage lin", variant: V12 },
    { productId: VOILAGE, name: "Voilage lin", variant: V17 },
    { productId: RIDEAU, name: "Rideau occultant", variant: R12 },
    { productId: "p_store", name: "Store enrouleur", variant: S12 },
  ];
  const keys: string[] = [];
  const lookup: CodeLookup = async (key) => {
    keys.push(key);
    const product = products[key];
    const byVariant = variants.filter((entry) => normalizeCode(entry.variant!.code) === key);
    return [
      ...(product && !byVariant.some((entry) => entry.productId === product.id)
        ? [{ productId: product.id, name: product.name, variant: null }]
        : []),
      ...byVariant,
    ];
  };
  return { lookup, keys };
}

describe("recognizeFromCodes", () => {
  it("finds the colour however the code is written", async () => {
    for (const written of ["WP-12", "wp 12", "WP_12", "ＷＰ１２", "WP-١٢", "wp.۱۲"]) {
      const { lookup } = catalogue();
      expect(await recognizeFromCodes([written], lookup)).toEqual({
        kind: "match",
        via: "code",
        productId: VOILAGE,
        productName: "Voilage lin",
        variant: V12,
        codes: [written],
      });
    }
  });

  it("finds a product by its own code, without a colour", async () => {
    const { lookup } = catalogue();
    expect(await recognizeFromCodes(["RD-100"], lookup)).toMatchObject({
      kind: "match",
      productId: RIDEAU,
      variant: null,
    });
  });

  it("asks between 12 and 17 when both were read", async () => {
    const { lookup } = catalogue();
    expect(await recognizeFromCodes(["WP-12", "WP-17"], lookup)).toEqual({
      kind: "ambiguous",
      options: [
        { productId: VOILAGE, productName: "Voilage lin", variantCode: "WP-12", variantName: "Gris" },
        { productId: VOILAGE, productName: "Voilage lin", variantCode: "WP-17", variantName: "Beige" },
      ],
      codes: ["WP-12", "WP-17"],
    });
  });

  it("only takes exact matches: WP-1 is not WP-12, WP-121 is not WP-12", async () => {
    const { lookup } = catalogue();
    expect(await recognizeFromCodes(["WP-1"], lookup)).toBeNull();
    expect(await recognizeFromCodes(["WP-121"], lookup)).toBeNull();
    expect(await recognizeFromCodes(["WP-7"], lookup)).toBeNull();
  });

  it("resolves a product code and one of its colours to that colour", async () => {
    const { lookup } = catalogue();
    expect(await recognizeFromCodes(["WP", "WP-17"], lookup)).toMatchObject({
      kind: "match",
      productId: VOILAGE,
      variant: V17,
      codes: ["WP", "WP-17"],
    });
  });

  it("takes a colour number shared by products as the colour of the product whose code is on the photo", async () => {
    // "12" is a colour of the rideau and of the store; the rideau's own code is on the photo.
    const { lookup } = catalogue();
    expect(await recognizeFromCodes(["RD100", "12"], lookup)).toMatchObject({
      kind: "match",
      productId: RIDEAU,
      variant: R12,
    });
  });

  it("asks when the codes name different products", async () => {
    const { lookup } = catalogue();
    expect(await recognizeFromCodes(["WP-17", "12"], lookup)).toEqual({
      kind: "ambiguous",
      options: [
        { productId: VOILAGE, productName: "Voilage lin", variantCode: "WP-17", variantName: "Beige" },
        { productId: RIDEAU, productName: "Rideau occultant", variantCode: "12", variantName: "Blanc" },
        { productId: "p_store", productName: "Store enrouleur", variantCode: "12", variantName: "Noir" },
      ],
      codes: ["WP-17", "12"],
    });
  });

  it("asks when one code names several products, and offers at most 5 in a stable order", async () => {
    const lookup: CodeLookup = async () =>
      Array.from({ length: 8 }, (_, index) => ({
        productId: `p${index}`,
        name: `Product ${index}`,
        variant: { id: `v${index}`, code: "12", name: null },
      }));
    const result = await recognizeFromCodes(["12"], lookup);
    expect(result?.kind).toBe("ambiguous");
    if (result?.kind !== "ambiguous") return;
    expect(result.options.map((option) => option.productId)).toEqual(["p0", "p1", "p2", "p3", "p4"]);
  });

  it("skips empty and one-character keys, and looks each key up once", async () => {
    const { lookup, keys } = catalogue();
    expect(await recognizeFromCodes(["", " - ", "7", "١", "WP-12", "wp12"], lookup)).toMatchObject({
      kind: "match",
      variant: V12,
    });
    expect(keys).toEqual(["WP12"]);
  });

  it("is null when nothing matches or nothing can be looked up", async () => {
    const { lookup, keys } = catalogue();
    expect(await recognizeFromCodes([], lookup)).toBeNull();
    expect(await recognizeFromCodes(["1", "-"], lookup)).toBeNull();
    expect(keys).toEqual([]);
    expect(await recognizeFromCodes(["ZZ-99"], lookup)).toBeNull();
  });
});
