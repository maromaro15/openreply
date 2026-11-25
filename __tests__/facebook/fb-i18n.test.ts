import { describe, expect, it } from "vitest";
import ar from "../../lib/facebook/i18n/ar.json";
import { createFbI18n, moduleTitle } from "../../lib/facebook/i18n";
import { HANDOFF_CATEGORIES, HANDOFF_CATEGORY_LABELS } from "../../lib/handoff/categories";

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

describe("Facebook, agency and alerts copy", () => {
  it("has a complete, plain-text Arabic translation with the same placeholders", () => {
    for (const [source, translation] of Object.entries(ar)) {
      expect(translation.trim(), source).not.toBe("");
      expect(placeholders(translation), source).toEqual(placeholders(source));
      expect(translation, source).not.toMatch(/&(?:[a-z]+|#\d+);/i);
      expect(source, source).not.toMatch(/&(?:[a-z]+|#\d+);/i);
    }
  });

  it("shows Arabic for the ar locale and English elsewhere", () => {
    expect(createFbI18n("ar").t("Brands")).toBe("البراندات");
    for (const locale of ["en", "zh-TW", "pt-BR", "ru", "es", "fr"]) {
      expect(createFbI18n(locale).t("Brands")).toBe("Brands");
    }
  });

  it("is right-to-left in Arabic only", () => {
    expect(createFbI18n("ar").dir).toBe("rtl");
    expect(createFbI18n("en").dir).toBe("ltr");
  });

  it("labels every handoff category in both languages", () => {
    const arabic = createFbI18n("ar");
    const english = createFbI18n("en");
    for (const category of HANDOFF_CATEGORIES) {
      expect(english.category(category)).toBe(HANDOFF_CATEGORY_LABELS[category]);
      expect(arabic.category(category)).not.toBe(HANDOFF_CATEGORY_LABELS[category]);
    }
    expect(arabic.category("WHOLESALE_ORDER")).toBe("طلبية جملة");
    expect(arabic.category("COMPLAINT")).toBe("شكوى");
  });

  it("titles the agency screens", () => {
    expect(moduleTitle("/agency")).toBe("Brands");
    expect(moduleTitle("/agency/anything")).toBe("Brands");
    expect(moduleTitle("/agencyx")).toBeNull();
    expect(moduleTitle("/dashboard")).toBeNull();
  });

  it("titles the catalog screens", () => {
    expect(moduleTitle("/facebook/products")).toBe("Products");
    expect(moduleTitle("/facebook/products/new")).toBe("New product");
    expect(moduleTitle("/facebook/products/attributes")).toBe("Product attributes");
    expect(moduleTitle("/facebook/products/cm123")).toBe("Product card");
    expect(moduleTitle("/facebook/productsx")).toBeNull();
  });
});
