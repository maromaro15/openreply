import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "../../app/generated/prisma/client";

const db = vi.hoisted(() => ({
  productAttribute: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    deleteMany: vi.fn(),
  },
}));

vi.mock("@/lib/db/client", () => ({ prisma: db }));

import {
  attributeInputSchema,
  attributeKeyFor,
  attributePatchSchema,
  cleanAttributeValues,
  createAttribute,
  deleteAttribute,
  listAttributes,
  MAX_ATTRIBUTES,
  updateAttribute,
  type TemplateAttribute,
} from "../../lib/catalog/attributes";

type Data = Record<string, unknown>;

function knownError(code: "P2002" | "P2025") {
  return new Prisma.PrismaClientKnownRequestError("Request failed", { code, clientVersion: "7" });
}

const MATERIAL = {
  id: "attr_1",
  workspaceId: "ws_a",
  key: "matière",
  label: "Matière",
  type: "CHOICE" as const,
  unit: null,
  options: ["PVC", "Bois"],
  sortOrder: 0,
  createdAt: new Date("2026-11-01T10:00:00Z"),
  updatedAt: new Date("2026-11-01T10:00:00Z"),
};
const THICKNESS = { ...MATERIAL, id: "attr_2", key: "épaisseur", label: "Épaisseur", type: "NUMBER" as const, unit: "mm", options: [] };

const input = (value: Data) => attributeInputSchema.parse(value);

beforeEach(() => {
  vi.clearAllMocks();
  db.productAttribute.findMany.mockResolvedValue([]);
  db.productAttribute.findFirst.mockImplementation(async ({ where }: { where: { id: string; workspaceId: string } }) =>
    where.workspaceId === "ws_a" ? ([MATERIAL, THICKNESS].find((row) => row.id === where.id) ?? null) : null
  );
  db.productAttribute.create.mockImplementation(async ({ data }: { data: Data }) => ({
    id: "attr_new",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...data,
  }));
  db.productAttribute.update.mockImplementation(async ({ where, data }: { where: { id: string }; data: Data }) => ({
    ...[MATERIAL, THICKNESS].find((row) => row.id === where.id),
    ...data,
  }));
  db.productAttribute.deleteMany.mockResolvedValue({ count: 1 });
});

describe("attributeInputSchema", () => {
  it("trims, and defaults to no unit and no options", () => {
    expect(input({ label: "  Épaisseur ", type: "NUMBER", unit: " mm " })).toEqual({
      label: "Épaisseur",
      type: "NUMBER",
      unit: "mm",
      options: [],
    });
    expect(input({ label: "Finition", type: "TEXT", unit: "  " })).toEqual({
      label: "Finition",
      type: "TEXT",
      unit: null,
      options: [],
    });
  });

  it("needs at least two different options for a list", () => {
    for (const options of [undefined, [], ["PVC"]]) {
      const result = attributeInputSchema.safeParse({ label: "Matière", type: "CHOICE", options });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]).toMatchObject({ path: ["options"], message: "A list needs at least two options." });
    }
    expect(input({ label: "Matière", type: "CHOICE", options: [" PVC ", "Bois"] }).options).toEqual(["PVC", "Bois"]);
    // Compared without case, like the values matched against them.
    expect(attributeInputSchema.safeParse({ label: "Matière", type: "CHOICE", options: ["PVC", " pvc "] }).success).toBe(false);
  });

  it.each([
    [{ label: "", type: "TEXT" }],
    [{ label: "   ", type: "TEXT" }],
    [{ label: "x".repeat(61), type: "TEXT" }],
    [{ label: "Date", type: "DATE" }],
    [{ label: "Poids", type: "NUMBER", unit: "x".repeat(21) }],
    [{ label: "Taille", type: "CHOICE", options: Array.from({ length: 31 }, (_, index) => `T${index}`) }],
    [{ label: "Taille", type: "CHOICE", options: ["S", "x".repeat(61)] }],
    [{ label: "Taille", type: "CHOICE", options: ["S", " "] }],
  ])("refuses an attribute out of bounds (%#)", (value) => {
    expect(attributeInputSchema.safeParse(value).success).toBe(false);
  });

  it("accepts every field at its limit", () => {
    const result = attributeInputSchema.safeParse({
      label: "x".repeat(60),
      type: "CHOICE",
      unit: "u".repeat(20),
      options: Array.from({ length: 30 }, (_, index) => `${index}`.padEnd(60, "o")),
    });
    expect(result.success).toBe(true);
  });
});

describe("attributePatchSchema", () => {
  it("has no defaults: a field left out stays as it is", () => {
    expect(attributePatchSchema.parse({})).toEqual({});
    expect(attributePatchSchema.parse({ label: " Matériau " })).toEqual({ label: "Matériau" });
    expect(attributePatchSchema.parse({ unit: "" })).toEqual({ unit: null });
    expect(attributePatchSchema.parse({ sortOrder: 3 })).toEqual({ sortOrder: 3 });
  });

  it("never changes the type or the key", () => {
    expect(attributePatchSchema.parse({ type: "NUMBER", key: "other" })).toEqual({});
  });

  it.each([[{ label: "" }], [{ sortOrder: 1.5 }], [{ sortOrder: -1 }], [{ options: ["A", "a"] }], [{ unit: "x".repeat(21) }]])(
    "validates what it changes (%#)",
    (value) => {
      expect(attributePatchSchema.safeParse(value).success).toBe(false);
    }
  );
});

describe("attributeKeyFor", () => {
  it.each([
    ["السمك", "السمك"],
    ["مقاومة الماء", "مقاومة_الماء"],
    ["السُّمك", "السُّمك"],
    ["Épaisseur (mm)", "épaisseur_mm"],
    ["Résistance à l’eau", "résistance_à_l_eau"],
    ["  Taille / Size ", "taille_size"],
    ["Longueur 2", "longueur_2"],
    ["ＡＢＣ", "abc"],
    ["طول ٢", "طول_٢"],
  ])("makes %j into %j", (label, key) => {
    expect(attributeKeyFor(label, [])).toBe(key);
  });

  it("falls back to «attribute» when no letter or digit is left", () => {
    expect(attributeKeyFor("???", [])).toBe("attribute");
    expect(attributeKeyFor(" — ", [])).toBe("attribute");
    expect(attributeKeyFor("!!", ["attribute"])).toBe("attribute_2");
  });

  it("is made unique among the brand's keys with _2, _3...", () => {
    expect(attributeKeyFor("Matière", ["matière"])).toBe("matière_2");
    expect(attributeKeyFor("MATIÈRE", new Set(["matière", "matière_2"]))).toBe("matière_3");
    expect(attributeKeyFor("السمك", ["السمك"])).toBe("السمك_2");
    // "Longueur 2" already holds longueur_2.
    expect(attributeKeyFor("Longueur", ["longueur", "longueur_2"])).toBe("longueur_3");
    function* taken() {
      yield "taille";
    }
    expect(attributeKeyFor("Taille", taken())).toBe("taille_2");
  });

  it("stays within 40 characters, the suffix included", () => {
    const label = "Résistance aux rayures et aux chocs du revêtement";
    const key = attributeKeyFor(label, []);
    expect(key).toBe("résistance_aux_rayures_et_aux_chocs_du_r");
    expect(Array.from(key)).toHaveLength(40);
    const next = attributeKeyFor(label, [key]);
    expect(next).toBe("résistance_aux_rayures_et_aux_chocs_du_2");
    expect(Array.from(next)).toHaveLength(40);
    // Cut before a "_": the suffix never follows a second one.
    const arabic = "مقاومة الخدوش والصدمات والرطوبة وأشعة الشمس";
    expect(attributeKeyFor(arabic, [])).toBe("مقاومة_الخدوش_والصدمات_والرطوبة_وأشعة_ال");
    expect(attributeKeyFor(arabic, [attributeKeyFor(arabic, [])])).toBe("مقاومة_الخدوش_والصدمات_والرطوبة_وأشعة_2");
  });
});

describe("cleanAttributeValues", () => {
  const TEMPLATE: TemplateAttribute[] = [
    { key: "matiere", label: "Matière", type: "CHOICE", options: ["PVC", "Bois massif", "12"] },
    { key: "epaisseur", label: "Épaisseur", type: "NUMBER", options: [] },
    { key: "etanche", label: "Étanche", type: "BOOLEAN", options: [] },
    { key: "finition", label: "Finition", type: "TEXT", options: [] },
  ];
  const clean = (values: unknown) => cleanAttributeValues(TEMPLATE, values);
  const one = (key: string, value: unknown) => clean({ [key]: value });

  it("keeps the template's keys only, and drops empty values", () => {
    expect(clean({ matiere: "pvc", inconnu: "x", epaisseur: "", etanche: null, finition: "   " })).toEqual({
      values: { matiere: "PVC" },
      errors: [],
    });
  });

  it("keeps false and 0, which are answers", () => {
    expect(clean({ etanche: false, epaisseur: 0 })).toEqual({ values: { epaisseur: 0, etanche: false }, errors: [] });
  });

  it("trims a text, up to 500 characters", () => {
    expect(one("finition", "  Mate  ").values).toEqual({ finition: "Mate" });
    expect(one("finition", "x".repeat(500)).errors).toEqual([]);
    expect(one("finition", "x".repeat(501)).errors).toEqual([
      { key: "finition", message: "Finition: 500 characters at most." },
    ]);
    expect(one("finition", 12).values).toEqual({ finition: "12" });
    expect(one("finition", true).errors).toHaveLength(1);
    expect(one("finition", { text: "Mate" }).errors).toHaveLength(1);
  });

  it.each([
    [12, 12],
    [1.5, 1.5],
    ["12", 12],
    ["1,5", 1.5],
    ["1.5", 1.5],
    ["١٫٥", 1.5],
    ["١٢", 12],
    ["۱۲", 12],
    ["１２", 12],
    [" -3 ", -3],
    ["0,75", 0.75],
  ])("reads the number %j as %j", (value, number) => {
    expect(one("epaisseur", value)).toEqual({ values: { epaisseur: number }, errors: [] });
  });

  it.each([["12 cm"], ["1.000,5"], ["1,5,2"], ["1e3"], ["douze"], ["12-"], [Number.NaN], [Infinity], [true], [["12"]]])(
    "refuses %j as a number",
    (value) => {
      expect(one("epaisseur", value)).toEqual({
        values: {},
        errors: [{ key: "epaisseur", message: "Épaisseur: write a number, like 12 or 1.5." }],
      });
    }
  );

  it("matches a choice without case, and keeps the option as written", () => {
    expect(one("matiere", "pvc").values).toEqual({ matiere: "PVC" });
    expect(one("matiere", "  BOIS MASSIF ").values).toEqual({ matiere: "Bois massif" });
    expect(one("matiere", 12).values).toEqual({ matiere: "12" });
    expect(one("matiere", "Métal")).toEqual({
      values: {},
      errors: [{ key: "matiere", message: "Matière: pick one of its options." }],
    });
    expect(one("matiere", true).errors).toHaveLength(1);
  });

  it.each([
    [true, true],
    [false, false],
    ["true", true],
    ["FALSE", false],
    ["yes", true],
    ["No", false],
    ["oui", true],
    [" NON ", false],
    ["نعم", true],
    ["لا", false],
  ])("reads %j as the answer %j", (value, answer) => {
    expect(one("etanche", value)).toEqual({ values: { etanche: answer }, errors: [] });
  });

  it.each([["maybe"], ["vrai"], [1], [0]])("refuses %j as a yes or no", (value) => {
    expect(one("etanche", value).errors).toEqual([{ key: "etanche", message: "Étanche: answer yes or no." }]);
  });

  it("reports every value that doesn't fit, in the template's order", () => {
    expect(clean({ epaisseur: "épais", matiere: "Métal", finition: "Mate" })).toEqual({
      values: { finition: "Mate" },
      errors: [
        { key: "matiere", message: "Matière: pick one of its options." },
        { key: "epaisseur", message: "Épaisseur: write a number, like 12 or 1.5." },
      ],
    });
  });

  it("reads own keys only, never the prototype's", () => {
    const template: TemplateAttribute[] = [
      { key: "constructor", label: "Constructeur", type: "TEXT", options: [] },
      { key: "toString", label: "Texte", type: "TEXT", options: [] },
    ];
    expect(cleanAttributeValues(template, {})).toEqual({ values: {}, errors: [] });
    expect(cleanAttributeValues(template, JSON.parse('{"constructor":"Atlas"}'))).toEqual({
      values: { constructor: "Atlas" },
      errors: [],
    });
  });

  it.each([[null], [undefined], [[]], ["PVC"], [12]])("holds no values in %j", (values) => {
    expect(clean(values)).toEqual({ values: {}, errors: [] });
  });

  it("never reads an array's own keys as values", () => {
    // attributeKeyFor("Length") is "length", which every array has.
    const template: TemplateAttribute[] = [
      { key: "length", label: "Length", type: "NUMBER", options: [] },
      { key: "0", label: "Zero", type: "TEXT", options: [] },
    ];
    expect(attributeKeyFor("Length", [])).toBe("length");
    expect(cleanAttributeValues(template, ["first", "second"])).toEqual({ values: {}, errors: [] });
  });
});

describe("listAttributes", () => {
  it("reads the brand's template in its order", async () => {
    db.productAttribute.findMany.mockResolvedValue([MATERIAL]);
    expect(await listAttributes("ws_a")).toEqual([MATERIAL]);
    expect(db.productAttribute.findMany).toHaveBeenCalledWith({
      where: { workspaceId: "ws_a" },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    });
  });
});

describe("createAttribute", () => {
  it("makes the key from the label, beside the brand's own keys, at the end of the template", async () => {
    db.productAttribute.findMany.mockResolvedValue([
      { key: "matière", sortOrder: 0 },
      { key: "taille", sortOrder: 4 },
    ]);
    const created = await createAttribute(
      "ws_a",
      input({ label: "Matière", type: "TEXT", unit: "", options: ["ignored", "too"] })
    );
    expect(db.productAttribute.findMany).toHaveBeenCalledWith({
      where: { workspaceId: "ws_a" },
      select: { key: true, sortOrder: true },
    });
    expect(db.productAttribute.create).toHaveBeenCalledWith({
      data: {
        workspaceId: "ws_a",
        key: "matière_2",
        label: "Matière",
        type: "TEXT",
        unit: null,
        options: [],
        sortOrder: 5,
      },
    });
    expect(created).toMatchObject({ id: "attr_new", key: "matière_2" });
  });

  it("keeps the options of a list", async () => {
    await createAttribute("ws_a", input({ label: "Matière", type: "CHOICE", options: ["PVC", "Bois"] }));
    expect(db.productAttribute.create.mock.calls[0][0].data).toMatchObject({
      key: "matière",
      type: "CHOICE",
      options: ["PVC", "Bois"],
      sortOrder: 0,
    });
  });

  it("stops at MAX_ATTRIBUTES without writing", async () => {
    db.productAttribute.findMany.mockResolvedValue(
      Array.from({ length: MAX_ATTRIBUTES }, (_, index) => ({ key: `a${index}`, sortOrder: index }))
    );
    expect(await createAttribute("ws_a", input({ label: "Encore", type: "TEXT" }))).toBeNull();
    expect(db.productAttribute.create).not.toHaveBeenCalled();
  });

  it("takes the next free key when someone else took it at the same moment", async () => {
    db.productAttribute.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([{ key: "taille", sortOrder: 0 }]);
    db.productAttribute.create.mockRejectedValueOnce(knownError("P2002"));
    const created = await createAttribute("ws_a", input({ label: "Taille", type: "TEXT" }));
    expect(db.productAttribute.create).toHaveBeenCalledTimes(2);
    expect(db.productAttribute.create.mock.calls[0][0].data.key).toBe("taille");
    expect(db.productAttribute.create.mock.calls[1][0].data).toMatchObject({ key: "taille_2", sortOrder: 1 });
    expect(created).toMatchObject({ key: "taille_2" });
  });

  it("gives up after three collisions, and never hides another error", async () => {
    db.productAttribute.create.mockRejectedValue(knownError("P2002"));
    await expect(createAttribute("ws_a", input({ label: "Taille", type: "TEXT" }))).rejects.toMatchObject({ code: "P2002" });
    expect(db.productAttribute.create).toHaveBeenCalledTimes(3);

    db.productAttribute.create.mockReset();
    db.productAttribute.create.mockRejectedValue(new Error("connection lost"));
    await expect(createAttribute("ws_a", input({ label: "Taille", type: "TEXT" }))).rejects.toThrow("connection lost");
    expect(db.productAttribute.create).toHaveBeenCalledTimes(1);
  });
});

describe("updateAttribute", () => {
  it("changes only the fields sent, and never the key", async () => {
    const updated = await updateAttribute("ws_a", "attr_1", attributePatchSchema.parse({ label: "Matériau" }));
    expect(db.productAttribute.findFirst).toHaveBeenCalledWith({ where: { id: "attr_1", workspaceId: "ws_a" } });
    expect(db.productAttribute.update).toHaveBeenCalledWith({
      where: { id: "attr_1", workspaceId: "ws_a" },
      data: { label: "Matériau" },
    });
    expect(updated).toMatchObject({ label: "Matériau", key: "matière", options: ["PVC", "Bois"] });
  });

  it("never reaches another brand's attribute", async () => {
    expect(await updateAttribute("ws_b", "attr_1", { label: "Pirate" })).toBeNull();
    expect(db.productAttribute.findFirst).toHaveBeenCalledWith({ where: { id: "attr_1", workspaceId: "ws_b" } });
    expect(db.productAttribute.update).not.toHaveBeenCalled();
  });

  it("keeps at least two options on a list", async () => {
    expect(await updateAttribute("ws_a", "attr_1", { options: ["PVC"] })).toBeNull();
    expect(db.productAttribute.update).not.toHaveBeenCalled();
    await updateAttribute("ws_a", "attr_1", { options: ["PVC", "Alu", "Bois"], sortOrder: 2 });
    expect(db.productAttribute.update.mock.calls[0][0].data).toEqual({ options: ["PVC", "Alu", "Bois"], sortOrder: 2 });
  });

  it("stores no options for the other types, and an empty unit as none", async () => {
    await updateAttribute("ws_a", "attr_2", attributePatchSchema.parse({ options: ["a", "b"], unit: "" }));
    expect(db.productAttribute.update.mock.calls[0][0].data).toEqual({ unit: null, options: [] });
  });

  it("returns the attribute as it is when there is nothing to change", async () => {
    expect(await updateAttribute("ws_a", "attr_1", {})).toEqual(MATERIAL);
    expect(db.productAttribute.update).not.toHaveBeenCalled();
  });

  it("is not found once deleted in the meantime", async () => {
    db.productAttribute.update.mockRejectedValueOnce(knownError("P2025"));
    expect(await updateAttribute("ws_a", "attr_1", { label: "Matériau" })).toBeNull();
    db.productAttribute.update.mockRejectedValueOnce(new Error("connection lost"));
    await expect(updateAttribute("ws_a", "attr_1", { label: "Matériau" })).rejects.toThrow("connection lost");
  });
});

describe("deleteAttribute", () => {
  it("deletes within the brand only", async () => {
    expect(await deleteAttribute("ws_a", "attr_1")).toBe(true);
    expect(db.productAttribute.deleteMany).toHaveBeenCalledWith({ where: { id: "attr_1", workspaceId: "ws_a" } });
    db.productAttribute.deleteMany.mockResolvedValue({ count: 0 });
    expect(await deleteAttribute("ws_b", "attr_1")).toBe(false);
    expect(db.productAttribute.deleteMany).toHaveBeenLastCalledWith({ where: { id: "attr_1", workspaceId: "ws_b" } });
  });
});
