"use client";

/**
 * A product card: the base fields, the brand's own attributes, the colours
 * or types with their codes and pictures, the pictures, and what helps a
 * customer choose (strengths, comparisons, who it suits, known worries with
 * their answers, alternatives). The bot answers from all of it, and from
 * nothing else, so the richer the card, the better it sells.
 */
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { normalizeCode } from "@/lib/catalog/codes";
import { translateReason, type FbI18n, type FbStaticKey } from "@/lib/facebook/i18n";
import { useFbI18n } from "@/lib/facebook/i18n/client";

export type AttributeType = "TEXT" | "NUMBER" | "CHOICE" | "BOOLEAN";
export type TemplateAttribute = {
  id: string;
  key: string;
  label: string;
  type: AttributeType;
  unit: string | null;
  options: string[];
};
export type ImageRef = {
  id: string;
  publicId: string;
  path: string;
  mimeType: string;
  size: number;
  fileName: string | null;
};
type Status = "ACTIVE" | "DRAFT" | "ARCHIVED";
type Source = "MANUAL" | "IMPORT" | "POST" | "CONVERSATION" | "INTERVIEW";

export type ProductDetail = {
  id: string;
  status: Status;
  source: Source;
  sourceRef: string | null;
  name: string;
  code: string | null;
  price: string | null;
  available: boolean;
  landingUrl: string | null;
  description: string | null;
  howToUse: string | null;
  attributes: Record<string, string | number | boolean>;
  strengths: string[];
  comparisons: string | null;
  suitableFor: string | null;
  objections: { question: string; answer: string }[];
  mainImage: ImageRef | null;
  images: ImageRef[];
  variants: {
    id: string;
    code: string;
    name: string | null;
    available: boolean;
    price: string | null;
    image: ImageRef | null;
    sortOrder: number;
  }[];
  related: { productId: string; name: string; code: string | null; note: string | null }[];
};

type VariantDraft = { key: string; code: string; name: string; available: boolean; price: string; image: ImageRef | null };
type ObjectionDraft = { key: string; question: string; answer: string };
type RelatedDraft = { productId: string; name: string; code: string | null; note: string };
type Draft = {
  status: Status;
  name: string;
  code: string;
  price: string;
  available: boolean;
  landingUrl: string;
  description: string;
  howToUse: string;
  /** A boolean attribute is true, false or "" (not said). */
  attributes: Record<string, string | boolean>;
  /** One per line. */
  strengths: string;
  comparisons: string;
  suitableFor: string;
  objections: ObjectionDraft[];
  mainImage: ImageRef | null;
  /** The product's pictures, and the ones uploaded for it before its first save. */
  images: ImageRef[];
  variants: VariantDraft[];
  related: RelatedDraft[];
};

// Limits of lib/catalog/products.ts, checked here first so the form says
// which field is wrong.
const LIMITS = { variants: 60, related: 20, strengths: 20, objections: 30 };

const SOURCES: Record<Exclude<Source, "MANUAL">, FbStaticKey> = {
  IMPORT: "From a file",
  POST: "From a post",
  CONVERSATION: "From conversations",
  INTERVIEW: "From a voice interview",
};

const IMAGE_ACCEPT = "image/jpeg,image/png,image/webp";

const inputClass =
  "block w-full rounded border border-border bg-surface px-3 py-2 text-sm text-foreground disabled:opacity-60";
const smallButton =
  "rounded border border-border px-3 py-1.5 text-xs text-foreground hover:bg-surface-hover disabled:opacity-60";

let lastKey = 0;
function newKey(): string {
  lastKey += 1;
  return `row${lastKey}`;
}

function draftOf(product: ProductDetail | null): Draft {
  return {
    status: product?.status ?? "ACTIVE",
    name: product?.name ?? "",
    code: product?.code ?? "",
    price: product?.price ?? "",
    available: product?.available ?? true,
    landingUrl: product?.landingUrl ?? "",
    description: product?.description ?? "",
    howToUse: product?.howToUse ?? "",
    attributes: Object.fromEntries(
      Object.entries(product?.attributes ?? {}).map(([key, value]) => [key, typeof value === "number" ? String(value) : value])
    ),
    strengths: (product?.strengths ?? []).join("\n"),
    comparisons: product?.comparisons ?? "",
    suitableFor: product?.suitableFor ?? "",
    objections: (product?.objections ?? []).map((objection) => ({ key: newKey(), ...objection })),
    mainImage: product?.mainImage ?? null,
    images: product?.images ?? [],
    variants: (product?.variants ?? []).map((variant) => ({
      key: newKey(),
      code: variant.code,
      name: variant.name ?? "",
      available: variant.available,
      price: variant.price ?? "",
      image: variant.image,
    })),
    related: (product?.related ?? []).map((related) => ({ ...related, note: related.note ?? "" })),
  };
}

function lines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function isWebLink(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.hostname.includes(".");
  } catch {
    return false;
  }
}

/** As lib/catalog/attributes.ts reads a number: "12", "1.5", "1,5", "١٫٥". */
function isNumberText(value: string): boolean {
  const ascii = value
    .trim()
    .replace(/[\u0660-\u0669]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[\u06f0-\u06f9]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0))
    .replace("٫", ".")
    .replace("−", "-");
  return /^[-+]?(?:\d+(?:[.,]\d+)?|[.,]\d+)$/.test(ascii);
}

/** The first problem, in the order of the form's fields. */
function problemOf(draft: Draft, template: TemplateAttribute[], t: FbI18n["t"]): string | null {
  if (!draft.name.trim()) return t("Give the product a name.");
  if (draft.landingUrl.trim() && !isWebLink(draft.landingUrl.trim())) return t("Enter a valid link starting with https://");
  for (const attribute of template) {
    const value = draft.attributes[attribute.key];
    if (attribute.type === "NUMBER" && typeof value === "string" && value.trim() && !isNumberText(value)) {
      return t("{label}: write a number, like 12 or 1.5.", { label: attribute.label });
    }
  }
  const codes = new Set<string>();
  for (const variant of draft.variants) {
    const key = normalizeCode(variant.code);
    if (!key) return t("Each colour or type needs its code or number.");
    if (codes.has(key)) return t("Two colours or types have the same code: {code}.", { code: variant.code.trim() });
    codes.add(key);
  }
  if (draft.variants.length > LIMITS.variants) return t("A product has {count} colours or types at most.", { count: LIMITS.variants });
  const strengths = lines(draft.strengths);
  if (strengths.length > LIMITS.strengths) return t("{count} strengths at most.", { count: LIMITS.strengths });
  if (strengths.some((strength) => strength.length > 300)) return t("Each strength: 300 characters at most.");
  for (const objection of draft.objections) {
    if (Boolean(objection.question.trim()) !== Boolean(objection.answer.trim())) {
      return t("Write both the worry and its answer.");
    }
  }
  if (draft.objections.length > LIMITS.objections) return t("{count} worries at most.", { count: LIMITS.objections });
  return null;
}

function payloadOf(draft: Draft, template: TemplateAttribute[]) {
  const attributes: Record<string, string | boolean> = {};
  for (const attribute of template) {
    const value = draft.attributes[attribute.key];
    if (typeof value === "boolean") attributes[attribute.key] = value;
    else if (typeof value === "string" && value.trim()) attributes[attribute.key] = value.trim();
  }
  return {
    status: draft.status,
    name: draft.name.trim(),
    code: draft.code.trim() || null,
    price: draft.price.trim() || null,
    available: draft.available,
    landingUrl: draft.landingUrl.trim() || null,
    description: draft.description.trim() || null,
    howToUse: draft.howToUse.trim() || null,
    attributes,
    strengths: lines(draft.strengths),
    comparisons: draft.comparisons.trim() || null,
    suitableFor: draft.suitableFor.trim() || null,
    objections: draft.objections
      .filter((objection) => objection.question.trim() && objection.answer.trim())
      .map((objection) => ({ question: objection.question.trim(), answer: objection.answer.trim() })),
    variants: draft.variants.map((variant) => ({
      code: variant.code.trim(),
      name: variant.name.trim() || null,
      available: variant.available,
      price: variant.price.trim() || null,
      imageId: variant.image?.id ?? null,
    })),
    related: draft.related.map((related) => ({ productId: related.productId, note: related.note.trim() || null })),
    mainImageId: draft.mainImage?.id ?? null,
  };
}

/** Uploads one image; the product's own when it exists already. */
async function uploadImage(file: File, productId: string | null, t: FbI18n["t"]): Promise<ImageRef | string> {
  const form = new FormData();
  form.append("file", file);
  if (productId) form.append("productId", productId);
  try {
    const response = await fetch("/api/catalog/images", { method: "POST", body: form });
    const payload = await response.json().catch(() => null);
    if (response.ok && payload?.success) return payload.data.image as ImageRef;
    return payload?.error ? translateReason(t, payload.error) : t("Something went wrong. Please try again.");
  } catch {
    return t("Could not reach the server. Please try again.");
  }
}

function Thumb({ image, size = "h-16 w-16" }: { image: ImageRef | null; size?: string }) {
  if (!image) return <span className={`${size} block shrink-0 rounded border border-dashed border-border`} aria-hidden />;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- served by this app, any size
    <img src={image.path} alt={image.fileName ?? ""} className={`${size} block shrink-0 rounded object-cover`} />
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="panel space-y-4 rounded p-4 sm:p-6">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        {hint && <p className="text-xs text-muted">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1 text-sm">
      <span className="text-muted">{label}</span>
      {children}
    </label>
  );
}

/** A picture for one colour: upload one, or take one of the product's. */
function VariantImage({
  image,
  images,
  disabled,
  onUpload,
  onChange,
  t,
}: {
  image: ImageRef | null;
  images: ImageRef[];
  disabled: boolean;
  onUpload: (file: File) => void;
  onChange: (image: ImageRef | null) => void;
  t: FbI18n["t"];
}) {
  return (
    <div className="flex items-center gap-2">
      <Thumb image={image} size="h-10 w-10" />
      <div className="flex flex-wrap gap-1">
        <label className={`${smallButton} cursor-pointer`}>
          {t("Upload")}
          <input
            type="file"
            accept={IMAGE_ACCEPT}
            disabled={disabled}
            className="sr-only"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) onUpload(file);
            }}
          />
        </label>
        {images.length > 0 && (
          <select
            value={image?.id ?? ""}
            disabled={disabled}
            aria-label={t("Choose one of the product's pictures")}
            onChange={(event) => onChange(images.find((candidate) => candidate.id === event.target.value) ?? null)}
            className="max-w-36 rounded border border-border bg-surface px-1 py-1 text-xs text-foreground"
          >
            <option value="">{t("No picture")}</option>
            {images.map((candidate, index) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.fileName ?? t("Picture {number}", { number: index + 1 })}
              </option>
            ))}
          </select>
        )}
      </div>
    </div>
  );
}

/** Search the brand's other products to add as alternatives. */
function RelatedSearch({
  excludeIds,
  disabled,
  onPick,
  t,
}: {
  excludeIds: string[];
  disabled: boolean;
  onPick: (product: { id: string; name: string; code: string | null }) => void;
  t: FbI18n["t"];
}) {
  const [text, setText] = useState("");
  const [results, setResults] = useState<{ id: string; name: string; code: string | null }[] | null>(null);
  const [searching, setSearching] = useState(false);

  async function search() {
    setSearching(true);
    try {
      const params = new URLSearchParams({ take: "20" });
      if (text.trim()) params.set("search", text.trim());
      const payload = await fetch(`/api/catalog/products?${params.toString()}`, { cache: "no-store" }).then((response) =>
        response.json()
      );
      setResults(payload?.success ? payload.data.products : []);
    } catch {
      setResults([]);
    } finally {
      setSearching(false);
    }
  }

  const shown = (results ?? []).filter((product) => !excludeIds.includes(product.id));
  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <input
          type="search"
          value={text}
          disabled={disabled}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void search();
            }
          }}
          placeholder={t("Search by name or code")}
          aria-label={t("Search by name or code")}
          dir="auto"
          className={inputClass}
        />
        <button type="button" disabled={disabled || searching} onClick={() => void search()} className={smallButton}>
          {searching ? t("Searching…") : t("Search")}
        </button>
      </div>
      {results && shown.length === 0 && <p className="text-xs text-muted">{t("No product matches.")}</p>}
      {shown.length > 0 && (
        <ul className="max-h-48 space-y-1 overflow-y-auto rounded border border-border p-1">
          {shown.map((product) => (
            <li key={product.id}>
              <button
                type="button"
                disabled={disabled}
                onClick={() => onPick(product)}
                className="w-full rounded px-2 py-1.5 text-start text-sm text-foreground hover:bg-surface-hover"
              >
                <span dir="auto">{product.name}</span>
                {product.code && (
                  <span className="ms-2 font-mono text-xs text-muted" dir="ltr">
                    {product.code}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function ProductEditor({
  product,
  template,
  canEdit,
}: {
  product: ProductDetail | null;
  template: TemplateAttribute[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const { t } = useFbI18n();
  const [saved, setSaved] = useState<ProductDetail | null>(product);
  const [draft, setDraft] = useState<Draft>(() => draftOf(product));
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const productId = saved?.id ?? null;
  const readOnly = !canEdit;
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const setVariant = (key: string, patch: Partial<VariantDraft>) =>
    setDraft((current) => ({
      ...current,
      variants: current.variants.map((variant) => (variant.key === key ? { ...variant, ...patch } : variant)),
    }));
  const setObjection = (key: string, patch: Partial<ObjectionDraft>) =>
    setDraft((current) => ({
      ...current,
      objections: current.objections.map((objection) => (objection.key === key ? { ...objection, ...patch } : objection)),
    }));

  /** Uploads, then hands each picture to `onStored` (main picture, a colour), or only adds it to the pictures. */
  async function upload(files: File[], onStored?: (image: ImageRef) => void) {
    setUploading((count) => count + files.length);
    setMessage(null);
    for (const file of files) {
      const result = await uploadImage(file, productId, t);
      setUploading((count) => count - 1);
      if (typeof result === "string") {
        setMessage({ ok: false, text: `${file.name}: ${result}` });
        continue;
      }
      setDraft((current) => ({ ...current, images: [...current.images, result] }));
      onStored?.(result);
    }
  }

  async function deleteImage(image: ImageRef) {
    if (!confirm(t("Delete this picture? Its link stops working, also in conversations."))) return;
    setMessage(null);
    try {
      const response = await fetch(`/api/catalog/images/${image.id}`, { method: "DELETE" });
      if (!response.ok && response.status !== 404) {
        setMessage({ ok: false, text: t("Something went wrong. Please try again.") });
        return;
      }
      setDraft((current) => ({
        ...current,
        images: current.images.filter((candidate) => candidate.id !== image.id),
        mainImage: current.mainImage?.id === image.id ? null : current.mainImage,
        variants: current.variants.map((variant) => (variant.image?.id === image.id ? { ...variant, image: null } : variant)),
      }));
    } catch {
      setMessage({ ok: false, text: t("Could not reach the server. Please try again.") });
    }
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    const problem = problemOf(draft, template, t);
    if (problem) {
      setMessage({ ok: false, text: problem });
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      const response = await fetch(productId ? `/api/catalog/products/${productId}` : "/api/catalog/products", {
        method: productId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payloadOf(draft, template)),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.success) {
        const text = payload?.error ? translateReason(t, payload.error) : t("Something went wrong. Please try again.");
        setMessage({ ok: false, text: payload?.detail ? `${text} ${payload.detail}` : text });
        return;
      }
      const stored = payload.data.product as ProductDetail;
      if (!productId) {
        router.replace(`/facebook/products/${stored.id}`);
        return;
      }
      setSaved(stored);
      setDraft(draftOf(stored));
      setMessage({ ok: true, text: t("Saved.") });
    } catch {
      setMessage({ ok: false, text: t("Could not reach the server. Please try again.") });
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!productId || !confirm(t("Delete «{title}»? Its colours and pictures are deleted with it.", { title: draft.name }))) {
      return;
    }
    setSaving(true);
    try {
      const response = await fetch(`/api/catalog/products/${productId}`, { method: "DELETE" });
      if (response.ok || response.status === 404) {
        router.push("/facebook/products");
        return;
      }
      setMessage({ ok: false, text: t("Something went wrong. Please try again.") });
    } catch {
      setMessage({ ok: false, text: t("Could not reach the server. Please try again.") });
    } finally {
      setSaving(false);
    }
  }

  const busy = saving || uploading > 0;
  const relatedIds = [productId ?? "", ...draft.related.map((related) => related.productId)];

  return (
    <form onSubmit={save} className="mx-auto grid max-w-6xl gap-6 lg:grid-cols-[1fr_300px]">
      <fieldset disabled={readOnly} className="min-w-0 space-y-6">
        <Section title={t("Basics")}>
          <div className="grid items-end gap-3 sm:grid-cols-[2fr_1fr]">
            <Field label={t("Product name")}>
              <input
                value={draft.name}
                onChange={(event) => set("name", event.target.value)}
                maxLength={200}
                dir="auto"
                className={inputClass}
              />
            </Field>
            <Field label={t("Code or number")}>
              <input
                value={draft.code}
                onChange={(event) => set("code", event.target.value)}
                maxLength={60}
                dir="ltr"
                placeholder="WP-12"
                className={`${inputClass} font-mono`}
              />
            </Field>
          </div>
          <div className="grid items-end gap-3 sm:grid-cols-[1fr_2fr]">
            <Field label={t("Price, exactly as the bot must say it")}>
              <input
                value={draft.price}
                onChange={(event) => set("price", event.target.value)}
                maxLength={100}
                dir="auto"
                placeholder="2500 DA"
                className={inputClass}
              />
            </Field>
            <Field label={t("Landing page link")}>
              <input
                value={draft.landingUrl}
                onChange={(event) => set("landingUrl", event.target.value)}
                maxLength={2000}
                dir="ltr"
                placeholder="https://"
                className={inputClass}
              />
            </Field>
          </div>
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input type="checkbox" checked={draft.available} onChange={(event) => set("available", event.target.checked)} />
            {t("Available")}
          </label>
          <Field label={t("Description")}>
            <textarea
              value={draft.description}
              onChange={(event) => set("description", event.target.value)}
              maxLength={4000}
              rows={3}
              dir="auto"
              className={inputClass}
            />
          </Field>
          <Field label={t("How to install or use it")}>
            <textarea
              value={draft.howToUse}
              onChange={(event) => set("howToUse", event.target.value)}
              maxLength={4000}
              rows={3}
              dir="auto"
              className={inputClass}
            />
          </Field>
        </Section>

        <Section title={t("Attributes")} hint={t("The fields of this brand's template.")}>
          {template.length === 0 ? (
            <p className="text-sm text-muted">
              {t("No attributes yet. Add the ones your customers ask about (thickness, material, size…).")}{" "}
              <Link href="/facebook/products/attributes" className="text-accent hover:underline">
                {t("Product attributes")}
              </Link>
            </p>
          ) : (
            <div className="grid items-end gap-3 sm:grid-cols-2">
              {template.map((attribute) => {
                const value = draft.attributes[attribute.key];
                const label = attribute.unit ? `${attribute.label} (${attribute.unit})` : attribute.label;
                const setValue = (next: string | boolean) =>
                  setDraft((current) => ({ ...current, attributes: { ...current.attributes, [attribute.key]: next } }));
                return (
                  <Field key={attribute.id} label={label}>
                    {attribute.type === "BOOLEAN" ? (
                      <select
                        value={value === true ? "true" : value === false ? "false" : ""}
                        onChange={(event) => setValue(event.target.value === "" ? "" : event.target.value === "true")}
                        className={inputClass}
                      >
                        <option value="">—</option>
                        <option value="true">{t("Yes")}</option>
                        <option value="false">{t("No")}</option>
                      </select>
                    ) : attribute.type === "CHOICE" ? (
                      <select
                        value={typeof value === "string" ? value : ""}
                        onChange={(event) => setValue(event.target.value)}
                        className={inputClass}
                      >
                        <option value="">—</option>
                        {/* A value no longer among the choices stays visible until it is changed. */}
                        {typeof value === "string" && value && !attribute.options.includes(value) && (
                          <option value={value}>{value}</option>
                        )}
                        {attribute.options.map((option) => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        value={typeof value === "string" ? value : ""}
                        onChange={(event) => setValue(event.target.value)}
                        maxLength={500}
                        inputMode={attribute.type === "NUMBER" ? "decimal" : undefined}
                        dir="auto"
                        className={inputClass}
                      />
                    )}
                  </Field>
                );
              })}
            </div>
          )}
        </Section>

        <Section
          title={t("Colours or types")}
          hint={t("Each with its code or number, as written on the product: the bot recognises it in messages and pictures.")}
        >
          {draft.variants.length > 0 && (
            <ul className="space-y-3">
              {draft.variants.map((variant, index) => (
                <li key={variant.key} className="space-y-2 rounded border border-border p-3">
                  <div className="grid gap-2 sm:grid-cols-[1fr_1.5fr_1fr]">
                    <input
                      value={variant.code}
                      onChange={(event) => setVariant(variant.key, { code: event.target.value })}
                      maxLength={60}
                      dir="ltr"
                      placeholder={t("Code")}
                      aria-label={t("Code")}
                      className={`${inputClass} font-mono`}
                    />
                    <input
                      value={variant.name}
                      onChange={(event) => setVariant(variant.key, { name: event.target.value })}
                      maxLength={80}
                      dir="auto"
                      placeholder={t("Name (optional)")}
                      aria-label={t("Name (optional)")}
                      className={inputClass}
                    />
                    <input
                      value={variant.price}
                      onChange={(event) => setVariant(variant.key, { price: event.target.value })}
                      maxLength={100}
                      dir="auto"
                      placeholder={t("Price if different")}
                      aria-label={t("Price if different")}
                      className={inputClass}
                    />
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <VariantImage
                      image={variant.image}
                      images={draft.images}
                      disabled={readOnly || busy}
                      t={t}
                      onChange={(image) => setVariant(variant.key, { image })}
                      onUpload={(file) => void upload([file], (image) => setVariant(variant.key, { image }))}
                    />
                    <div className="flex items-center gap-3">
                      <label className="flex items-center gap-2 text-xs text-foreground">
                        <input
                          type="checkbox"
                          checked={variant.available}
                          onChange={(event) => setVariant(variant.key, { available: event.target.checked })}
                        />
                        {t("Available")}
                      </label>
                      <button
                        type="button"
                        aria-label={t("Remove colour {number}", { number: index + 1 })}
                        onClick={() => set("variants", draft.variants.filter((candidate) => candidate.key !== variant.key))}
                        className="rounded border border-error/40 px-2 py-1 text-xs text-error hover:bg-error/10"
                      >
                        {t("Remove")}
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {draft.variants.length < LIMITS.variants && (
            <button
              type="button"
              onClick={() =>
                set("variants", [
                  ...draft.variants,
                  { key: newKey(), code: "", name: "", available: true, price: "", image: null },
                ])
              }
              className={smallButton}
            >
              {t("Add a colour or type")}
            </button>
          )}
        </Section>

        {productId && (
          <Section title={t("Pictures")} hint={t("JPEG, PNG or WebP. The bot can send them to customers.")}>
            {draft.images.length === 0 ? (
              <p className="text-sm text-muted">{t("No pictures yet.")}</p>
            ) : (
              <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {draft.images.map((image) => {
                  const variant = draft.variants.find((candidate) => candidate.image?.id === image.id);
                  return (
                    <li key={image.id} className="space-y-1 rounded border border-border p-2">
                      <Thumb image={image} size="aspect-square w-full" />
                      <p className="truncate text-xs text-muted" dir="auto">
                        {draft.mainImage?.id === image.id
                          ? t("Main picture")
                          : variant
                            ? t("Colour {code}", { code: variant.code })
                            : (image.fileName ?? "")}
                      </p>
                      {canEdit && (
                        <div className="flex flex-wrap gap-1">
                          {draft.mainImage?.id !== image.id && (
                            <button type="button" disabled={busy} onClick={() => set("mainImage", image)} className={smallButton}>
                              {t("Main")}
                            </button>
                          )}
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void deleteImage(image)}
                            className="rounded border border-error/40 px-2 py-1.5 text-xs text-error hover:bg-error/10 disabled:opacity-60"
                          >
                            {t("Delete")}
                          </button>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            {canEdit && (
              <label className={`${smallButton} inline-block cursor-pointer`}>
                {t("Add pictures")}
                <input
                  type="file"
                  accept={IMAGE_ACCEPT}
                  multiple
                  disabled={busy}
                  className="sr-only"
                  onChange={(event) => {
                    const files = Array.from(event.target.files ?? []);
                    event.target.value = "";
                    if (files.length) void upload(files);
                  }}
                />
              </label>
            )}
          </Section>
        )}

        <Section
          title={t("Help the customer choose")}
          hint={t("Only true facts: the bot uses them to answer and persuade, and never adds any of its own.")}
        >
          <Field label={t("Strengths, one per line")}>
            <textarea
              value={draft.strengths}
              onChange={(event) => set("strengths", event.target.value)}
              rows={4}
              dir="auto"
              className={inputClass}
            />
          </Field>
          <Field label={t("Comparison with similar products or competitors")}>
            <textarea
              value={draft.comparisons}
              onChange={(event) => set("comparisons", event.target.value)}
              maxLength={4000}
              rows={3}
              dir="auto"
              className={inputClass}
            />
          </Field>
          <Field label={t("Who and where it suits (uses, rooms, places)")}>
            <textarea
              value={draft.suitableFor}
              onChange={(event) => set("suitableFor", event.target.value)}
              maxLength={2000}
              rows={2}
              dir="auto"
              className={inputClass}
            />
          </Field>

          <div className="space-y-2">
            <p className="text-sm text-muted">{t("Known questions and worries, with their answers")}</p>
            {draft.objections.map((objection, index) => (
              <div key={objection.key} className="grid gap-2 rounded border border-border p-2 sm:grid-cols-[1fr_1.5fr_auto]">
                <input
                  value={objection.question}
                  onChange={(event) => setObjection(objection.key, { question: event.target.value })}
                  maxLength={300}
                  dir="auto"
                  placeholder={t("The worry, e.g. «does it hold in a bathroom?»")}
                  aria-label={t("Worry {number}", { number: index + 1 })}
                  className={inputClass}
                />
                <textarea
                  value={objection.answer}
                  onChange={(event) => setObjection(objection.key, { answer: event.target.value })}
                  maxLength={1000}
                  rows={1}
                  dir="auto"
                  placeholder={t("The true answer")}
                  aria-label={t("Answer {number}", { number: index + 1 })}
                  className={inputClass}
                />
                <button
                  type="button"
                  onClick={() => set("objections", draft.objections.filter((candidate) => candidate.key !== objection.key))}
                  className="self-start rounded border border-error/40 px-2 py-2 text-xs text-error hover:bg-error/10"
                >
                  {t("Remove")}
                </button>
              </div>
            ))}
            {draft.objections.length < LIMITS.objections && (
              <button
                type="button"
                onClick={() => set("objections", [...draft.objections, { key: newKey(), question: "", answer: "" }])}
                className={smallButton}
              >
                {t("Add a worry and its answer")}
              </button>
            )}
          </div>

          <div className="space-y-2">
            <p className="text-sm text-muted">{t("Alternatives or close products")}</p>
            {draft.related.map((related) => (
              <div key={related.productId} className="flex flex-wrap items-center gap-2 rounded border border-border p-2">
                <span className="min-w-0 flex-1 text-sm text-foreground" dir="auto">
                  {related.name}
                  {related.code && (
                    <span className="ms-2 font-mono text-xs text-muted" dir="ltr">
                      {related.code}
                    </span>
                  )}
                </span>
                <input
                  value={related.note}
                  onChange={(event) =>
                    set(
                      "related",
                      draft.related.map((candidate) =>
                        candidate.productId === related.productId ? { ...candidate, note: event.target.value } : candidate
                      )
                    )
                  }
                  maxLength={100}
                  dir="auto"
                  placeholder={t("When to offer it (optional)")}
                  aria-label={t("When to offer it (optional)")}
                  className="w-full rounded border border-border bg-surface px-2 py-1 text-xs text-foreground sm:w-56"
                />
                <button
                  type="button"
                  onClick={() => set("related", draft.related.filter((candidate) => candidate.productId !== related.productId))}
                  className="rounded border border-error/40 px-2 py-1 text-xs text-error hover:bg-error/10"
                >
                  {t("Remove")}
                </button>
              </div>
            ))}
            {draft.related.length < LIMITS.related && (
              <RelatedSearch
                excludeIds={relatedIds}
                disabled={readOnly}
                t={t}
                onPick={(picked) =>
                  set("related", [...draft.related, { productId: picked.id, name: picked.name, code: picked.code, note: "" }])
                }
              />
            )}
          </div>
        </Section>
      </fieldset>

      <aside className="space-y-4 lg:sticky lg:top-4 lg:self-start">
        <div className="panel space-y-3 rounded p-4">
          <p className="text-sm font-semibold text-foreground">{t("Main picture")}</p>
          <Thumb image={draft.mainImage} size="aspect-square w-full" />
          {canEdit && (
            <div className="flex flex-wrap gap-2">
              <label className={`${smallButton} cursor-pointer`}>
                {draft.mainImage ? t("Replace") : t("Upload")}
                <input
                  type="file"
                  accept={IMAGE_ACCEPT}
                  disabled={busy}
                  className="sr-only"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (file) void upload([file], (image) => set("mainImage", image));
                  }}
                />
              </label>
              {draft.mainImage && (
                <button type="button" disabled={busy} onClick={() => set("mainImage", null)} className={smallButton}>
                  {t("No main picture")}
                </button>
              )}
            </div>
          )}
          {uploading > 0 && <p className="text-xs text-muted">{t("Uploading…")}</p>}
        </div>

        <div className="panel space-y-3 rounded p-4">
          <label className="block space-y-1 text-sm">
            <span className="font-semibold text-foreground">{t("Status")}</span>
            <select
              value={draft.status}
              disabled={readOnly}
              onChange={(event) => set("status", event.target.value as Status)}
              className={inputClass}
            >
              <option value="ACTIVE">{t("Active: the bot uses it")}</option>
              <option value="DRAFT">{t("Draft: waiting for approval")}</option>
              <option value="ARCHIVED">{t("In the archive")}</option>
            </select>
          </label>
          {saved && saved.source !== "MANUAL" && (
            <p className="text-xs text-muted">
              {t(SOURCES[saved.source])}
              {saved.sourceRef && (
                <span className="block truncate" dir="auto">
                  {saved.sourceRef}
                </span>
              )}
            </p>
          )}
          {readOnly && <p className="text-xs text-muted">{t("Only owners and admins can change the products.")}</p>}
          {message && (
            <p
              role={message.ok ? "status" : "alert"}
              className={`rounded p-2 text-xs ${message.ok ? "bg-success/10 text-success" : "border border-error/20 bg-error/10 text-error"}`}
              dir="auto"
            >
              {message.text}
            </p>
          )}
          {canEdit && (
            <button
              type="submit"
              disabled={busy}
              className="w-full rounded bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent-hover disabled:opacity-50"
            >
              {saving ? t("Saving…") : productId ? t("Save changes") : t("Create the product")}
            </button>
          )}
          {canEdit && productId && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void remove()}
              className="w-full rounded border border-error/40 px-4 py-2 text-sm text-error hover:bg-error/10 disabled:opacity-60"
            >
              {t("Delete the product")}
            </button>
          )}
          <Link href="/facebook/products" className="block text-center text-sm text-accent hover:underline">
            {t("Back to the products")}
          </Link>
        </div>
      </aside>
    </form>
  );
}
