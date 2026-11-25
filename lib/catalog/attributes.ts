/**
 * A brand's own product attributes, and the values a product card holds for
 * them.
 *
 * There is no fixed template: each brand adds the attributes its customers
 * ask about (thickness, material, water resistance, size...), named the way
 * they say them. A product keeps its values in Product.attributes under each
 * attribute's key. The key is made once, from the first label, and never
 * changes, so renaming an attribute keeps every product's value. Deleting an
 * attribute leaves its values in the products' JSON: they are ignored from
 * then on (reads go through cleanAttributeValues) and dropped the next time
 * a product is saved.
 */
import { z } from "zod";
import { Prisma, type ProductAttribute, type ProductAttributeType } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";

export const MAX_ATTRIBUTES = 40;
export const MAX_ATTRIBUTE_OPTIONS = 30;
/** A list with a single option is not a choice. */
export const MIN_CHOICE_OPTIONS = 2;
export const ATTRIBUTE_TYPES = ["TEXT", "NUMBER", "CHOICE", "BOOLEAN"] as const satisfies readonly ProductAttributeType[];

const MAX_KEY_LENGTH = 40;
const MAX_TEXT_VALUE = 500;
const MAX_SORT_ORDER = 100_000;

/** Case-insensitive, and blind to full-width and other compatibility forms. */
function foldCase(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

// ─── Input ──────────────────────────────────────────────────────────────────

const label = z.string().trim().min(1, "Give the attribute a name.").max(60);
const unit = z
  .string()
  .trim()
  .max(20)
  .nullable()
  .transform((value) => value || null);
// Compared without case, like the values matched against them.
const options = z
  .array(z.string().trim().min(1, "An option can't be empty.").max(60))
  .max(MAX_ATTRIBUTE_OPTIONS)
  .refine((values) => new Set(values.map(foldCase)).size === values.length, "Each option must be different.");

export const attributeInputSchema = z
  .object({
    label,
    type: z.enum(ATTRIBUTE_TYPES),
    unit: unit.default(null),
    options: options.default([]),
  })
  .superRefine((value, ctx) => {
    if (value.type === "CHOICE" && value.options.length < MIN_CHOICE_OPTIONS) {
      ctx.addIssue({ code: "custom", path: ["options"], message: "A list needs at least two options." });
    }
  });

export type AttributeInput = z.infer<typeof attributeInputSchema>;

/**
 * No defaults: a field left out of a PATCH stays as it is. There is no type:
 * it never changes, since the products' values were checked against it.
 */
export const attributePatchSchema = z
  .object({ label, unit, options, sortOrder: z.number().int().min(0).max(MAX_SORT_ORDER) })
  .partial();

export type AttributePatch = z.infer<typeof attributePatchSchema>;

// ─── Keys ───────────────────────────────────────────────────────────────────

/** By code points, so a letter outside the BMP is never cut in half. */
function firstChars(value: string, count: number): string {
  return Array.from(value).slice(0, count).join("");
}

function trimUnderscores(value: string): string {
  return value.replace(/^_+|_+$/g, "");
}

/**
 * The internal key of a new attribute, from its label: lower case, letters of
 * any script and digits kept, anything else "_". Combining marks stay with
 * their letters (Arabic harakat, Devanagari vowel signs), so a word is never
 * split in the middle. Made unique among `taken` with "_2", "_3"...
 */
export function attributeKeyFor(label: string, taken: Iterable<string>): string {
  const words = label.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{M}\p{Nd}]+/gu, "_");
  const base = trimUnderscores(firstChars(trimUnderscores(words), MAX_KEY_LENGTH)) || "attribute";
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `_${n}`;
    const key = `${trimUnderscores(firstChars(base, MAX_KEY_LENGTH - suffix.length))}${suffix}`;
    if (!used.has(key)) return key;
  }
}

// ─── The template ───────────────────────────────────────────────────────────

export async function listAttributes(workspaceId: string): Promise<ProductAttribute[]> {
  return prisma.productAttribute.findMany({
    where: { workspaceId },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });
}

/** null when the brand already has MAX_ATTRIBUTES attributes. */
export async function createAttribute(workspaceId: string, input: AttributeInput): Promise<ProductAttribute | null> {
  for (let attempt = 1; ; attempt++) {
    const existing = await prisma.productAttribute.findMany({
      where: { workspaceId },
      select: { key: true, sortOrder: true },
    });
    if (existing.length >= MAX_ATTRIBUTES) return null;
    try {
      return await prisma.productAttribute.create({
        data: {
          workspaceId,
          key: attributeKeyFor(input.label, existing.map((attribute) => attribute.key)),
          label: input.label,
          type: input.type,
          unit: input.unit || null,
          options: input.type === "CHOICE" ? input.options : [],
          // After the last one, even once the brand has reordered them.
          sortOrder: existing.reduce((last, attribute) => Math.max(last, attribute.sortOrder + 1), 0),
        },
      });
    } catch (error) {
      // Two people adding the same label at once get the same key: the unique
      // index lets one in, and the other takes the next free key.
      if (attempt >= 3 || !isUniqueViolation(error)) throw error;
    }
  }
}

/**
 * Only within the brand: another brand's attribute is simply not found
 * (null). Also null, with nothing written, when the change would leave a list
 * (CHOICE) with fewer than MIN_CHOICE_OPTIONS options. The key stays as it
 * is, so products keep their values when an attribute is renamed.
 */
export async function updateAttribute(
  workspaceId: string,
  id: string,
  patch: AttributePatch
): Promise<ProductAttribute | null> {
  const current = await prisma.productAttribute.findFirst({ where: { id, workspaceId } });
  if (!current) return null;
  const data: Prisma.ProductAttributeUpdateInput = {};
  if (patch.label !== undefined) data.label = patch.label;
  if (patch.unit !== undefined) data.unit = patch.unit || null;
  if (patch.sortOrder !== undefined) data.sortOrder = patch.sortOrder;
  if (patch.options !== undefined) {
    if (current.type !== "CHOICE") data.options = [];
    else if (patch.options.length < MIN_CHOICE_OPTIONS) return null;
    else data.options = patch.options;
  }
  if (Object.keys(data).length === 0) return current;
  try {
    return await prisma.productAttribute.update({ where: { id, workspaceId }, data });
  } catch (error) {
    // Deleted between the read and the write.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") return null;
    throw error;
  }
}

/** The values stay in the products' JSON and are ignored from then on. */
export async function deleteAttribute(workspaceId: string, id: string): Promise<boolean> {
  const deleted = await prisma.productAttribute.deleteMany({ where: { id, workspaceId } });
  return deleted.count === 1;
}

// ─── Values ─────────────────────────────────────────────────────────────────

export type AttributeValue = string | number | boolean;
export type TemplateAttribute = Pick<ProductAttribute, "key" | "label" | "type" | "options">;

type Checked = { ok: true; value: AttributeValue } | { ok: false; message: string };

const accept = (value: AttributeValue): Checked => ({ ok: true, value });
const refuse = (message: string): Checked => ({ ok: false, message });

/** Arabic-Indic and the other decimal digits, as ASCII (as in ./codes). */
const DIGIT_BLOCKS = [0x0660, 0x06f0, 0x07c0, 0x0966, 0x09e6, 0xff10];

function asciiDigits(text: string): string {
  return text.replace(/\p{Nd}/gu, (digit) => {
    const code = digit.codePointAt(0)!;
    for (const base of DIGIT_BLOCKS) {
      if (code >= base && code <= base + 9) return String(code - base);
    }
    return digit;
  });
}

/** A point or a comma before the decimals ("1.5", "1,5"), and no thousands separators. */
const DECIMAL = /^[-+]?(?:\d+(?:[.,]\d+)?|[.,]\d+)$/;

function toNumber(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string") return null;
  const text = asciiDigits(raw.normalize("NFKC").trim())
    .replace("٫", ".") // the Arabic decimal separator
    .replace("−", "-"); // the minus sign
  if (!DECIMAL.test(text)) return null;
  const number = Number(text.replace(",", "."));
  return Number.isFinite(number) ? number : null;
}

const YES = new Set(["true", "yes", "oui", "نعم"]);
const NO = new Set(["false", "no", "non", "لا"]);

function toBoolean(raw: unknown): boolean | null {
  if (typeof raw === "boolean") return raw;
  if (typeof raw !== "string") return null;
  const word = foldCase(raw.trim());
  if (YES.has(word)) return true;
  if (NO.has(word)) return false;
  return null;
}

/** A number written in a text or list field reads as its digits. */
function asText(raw: unknown): string | null {
  if (typeof raw === "string") return raw.trim();
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  return null;
}

const CHECKS: Record<ProductAttributeType, (attribute: TemplateAttribute, raw: unknown) => Checked> = {
  TEXT: (_attribute, raw) => {
    const text = asText(raw);
    if (text === null) return refuse("write it as text.");
    return text.length <= MAX_TEXT_VALUE ? accept(text) : refuse(`${MAX_TEXT_VALUE} characters at most.`);
  },
  NUMBER: (_attribute, raw) => {
    const number = toNumber(raw);
    return number === null ? refuse("write a number, like 12 or 1.5.") : accept(number);
  },
  CHOICE: (attribute, raw) => {
    const text = asText(raw);
    const wanted = text === null ? null : foldCase(text);
    const option = wanted === null ? undefined : attribute.options.find((choice) => foldCase(choice) === wanted);
    return option === undefined ? refuse("pick one of its options.") : accept(option);
  },
  BOOLEAN: (_attribute, raw) => {
    const answer = toBoolean(raw);
    return answer === null ? refuse("answer yes or no.") : accept(answer);
  },
};

function isEmpty(raw: unknown): boolean {
  return raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "");
}

/**
 * A product's values as the template allows them: keys outside the template
 * are dropped, and so are empty values. Each value is checked and coerced
 * for its type; one error per attribute that doesn't fit, in template
 * order, its message starting with the attribute's label.
 */
export function cleanAttributeValues(
  template: TemplateAttribute[],
  values: unknown
): { values: Record<string, AttributeValue>; errors: { key: string; message: string }[] } {
  const source = values !== null && typeof values === "object" && !Array.isArray(values) ? values : {};
  const kept: [string, AttributeValue][] = [];
  const errors: { key: string; message: string }[] = [];
  for (const attribute of template) {
    // Own keys only: "constructor" or "toString" must not come from the prototype.
    const raw: unknown = Object.hasOwn(source, attribute.key)
      ? (source as Record<string, unknown>)[attribute.key]
      : undefined;
    if (isEmpty(raw)) continue;
    const checked = CHECKS[attribute.type](attribute, raw);
    if (checked.ok) kept.push([attribute.key, checked.value]);
    else errors.push({ key: attribute.key, message: `${attribute.label}: ${checked.message}` });
  }
  return { values: Object.fromEntries(kept), errors };
}
