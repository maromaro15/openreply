"use client";

/**
 * The brand's own product attributes: the fields every product card of this
 * brand gets (thickness, material, size…), named the way its customers say
 * them. Owners and admins edit; members read.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { translateReason, type FbI18n, type FbStaticKey } from "@/lib/facebook/i18n";
import { useFbI18n } from "@/lib/facebook/i18n/client";

type AttributeType = "TEXT" | "NUMBER" | "CHOICE" | "BOOLEAN";
type Attribute = {
  id: string;
  key: string;
  label: string;
  type: AttributeType;
  unit: string | null;
  options: string[];
  sortOrder: number;
};

const TYPES: { value: AttributeType; label: FbStaticKey }[] = [
  { value: "TEXT", label: "Text" },
  { value: "NUMBER", label: "Number" },
  { value: "CHOICE", label: "Choice from a list" },
  { value: "BOOLEAN", label: "Yes or no" },
];

const inputClass =
  "block w-full rounded border border-border bg-surface px-3 py-2 text-sm text-foreground disabled:opacity-60";

type Draft = { label: string; type: AttributeType; unit: string; options: string };
const EMPTY: Draft = { label: "", type: "TEXT", unit: "", options: "" };

/** One option per line (or separated by commas). */
function parseOptions(text: string): string[] {
  const seen = new Set<string>();
  const options: string[] = [];
  for (const part of text.split(/[\n,،]/)) {
    const option = part.trim();
    if (option && !seen.has(option.toLowerCase())) {
      seen.add(option.toLowerCase());
      options.push(option);
    }
  }
  return options;
}

function problemWith(draft: Draft, t: FbI18n["t"]): string | null {
  const label = draft.label.trim();
  if (!label || label.length > 60) return t("Name: 1 to 60 characters.");
  if (draft.unit.trim().length > 20) return t("Unit: 20 characters at most.");
  if (draft.type === "CHOICE") {
    const options = parseOptions(draft.options);
    if (options.length < 2) return t("A list needs at least 2 choices.");
    if (options.length > 30) return t("A list has 30 choices at most.");
    if (options.some((option) => option.length > 60)) return t("Each choice: 60 characters at most.");
  }
  return null;
}

function AttributeForm({
  initial,
  typeLocked,
  busy,
  submitLabel,
  onSubmit,
  onCancel,
  t,
}: {
  initial: Draft;
  typeLocked: boolean;
  busy: boolean;
  submitLabel: string;
  onSubmit: (draft: Draft) => void;
  onCancel?: () => void;
  t: FbI18n["t"];
}) {
  const [draft, setDraft] = useState(initial);
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        const found = problemWith(draft, t);
        setProblem(found);
        if (!found) onSubmit(draft);
      }}
    >
      <div className="grid gap-3 sm:grid-cols-[2fr_1fr_1fr]">
        <label className="block space-y-1 text-sm">
          <span className="text-muted">{t("Name, as your customers say it")}</span>
          <input
            value={draft.label}
            onChange={(event) => setDraft({ ...draft, label: event.target.value })}
            maxLength={60}
            dir="auto"
            placeholder={t("Thickness, material, size…")}
            className={inputClass}
          />
        </label>
        <label className="block space-y-1 text-sm">
          <span className="text-muted">{t("Type")}</span>
          <select
            value={draft.type}
            disabled={typeLocked}
            onChange={(event) => setDraft({ ...draft, type: event.target.value as AttributeType })}
            className={inputClass}
          >
            {TYPES.map((type) => (
              <option key={type.value} value={type.value}>
                {t(type.label)}
              </option>
            ))}
          </select>
        </label>
        <label className="block space-y-1 text-sm">
          <span className="text-muted">{t("Unit (optional)")}</span>
          <input
            value={draft.unit}
            onChange={(event) => setDraft({ ...draft, unit: event.target.value })}
            maxLength={20}
            dir="auto"
            placeholder="mm, cm, m²…"
            className={inputClass}
          />
        </label>
      </div>
      {draft.type === "CHOICE" && (
        <label className="block space-y-1 text-sm">
          <span className="text-muted">{t("Choices, one per line")}</span>
          <textarea
            value={draft.options}
            onChange={(event) => setDraft({ ...draft, options: event.target.value })}
            rows={3}
            dir="auto"
            className={inputClass}
          />
        </label>
      )}
      {problem && (
        <p role="alert" className="text-sm text-error">
          {problem}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={busy}
          className="rounded bg-accent px-4 py-2 text-sm font-medium text-accent-foreground hover:bg-accent-hover disabled:opacity-60"
        >
          {busy ? t("Saving…") : submitLabel}
        </button>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-border px-4 py-2 text-sm text-foreground hover:bg-surface-hover"
          >
            {t("Cancel")}
          </button>
        )}
      </div>
    </form>
  );
}

function payloadOf(draft: Draft) {
  return {
    label: draft.label.trim(),
    unit: draft.unit.trim() || null,
    options: draft.type === "CHOICE" ? parseOptions(draft.options) : [],
  };
}

export default function ProductAttributesPage() {
  const { t } = useFbI18n();
  const [data, setData] = useState<{ role: string; limit: number; attributes: Attribute[] } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/catalog/attributes", { cache: "no-store" })
      .then((response) => response.json())
      .then((payload) => {
        if (cancelled) return;
        if (payload?.success) setData(payload.data);
        else setError(t("Could not load the attributes."));
      })
      .catch(() => {
        if (!cancelled) setError(t("Could not load the attributes."));
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey, t]);

  const canEdit = data?.role === "OWNER" || data?.role === "ADMIN";

  async function call(url: string, method: string, body?: unknown): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.success) {
        setError(payload?.error ? translateReason(t, payload.error) : t("Something went wrong. Please try again."));
        return false;
      }
      return true;
    } catch {
      setError(t("Could not reach the server. Please try again."));
      return false;
    } finally {
      setBusy(false);
      setReloadKey((key) => key + 1);
    }
  }

  /** Moves an attribute one place up or down: every position is saved again. */
  async function move(index: number, by: -1 | 1) {
    if (!data) return;
    const order = [...data.attributes];
    const [moved] = order.splice(index, 1);
    order.splice(index + by, 0, moved);
    setBusy(true);
    setError(null);
    try {
      const changed = order.filter((attribute, position) => attribute.sortOrder !== position);
      const responses = await Promise.all(
        changed.map((attribute) =>
          fetch(`/api/catalog/attributes/${attribute.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sortOrder: order.indexOf(attribute) }),
          })
        )
      );
      if (responses.some((response) => !response.ok)) setError(t("Something went wrong. Please try again."));
    } catch {
      setError(t("Could not reach the server. Please try again."));
    } finally {
      setBusy(false);
      setReloadKey((key) => key + 1);
    }
  }

  const typeLabel = (type: AttributeType) => t(TYPES.find((option) => option.value === type)?.label ?? "Text");

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted">
          {t("The fields every product card of this brand has, besides the name, code and price. The bot uses them to answer and compare.")}
        </p>
        <Link href="/facebook/products" className="text-sm text-foreground underline underline-offset-2">
          {t("Back to the products")}
        </Link>
      </div>

      {error && (
        <p role="alert" className="text-sm text-error" dir="auto">
          {error}
        </p>
      )}

      {!data ? (
        !error && <p className="text-sm text-muted">{t("Loading…")}</p>
      ) : (
        <>
          {!canEdit && <p className="text-sm text-muted">{t("Only owners and admins can change the products.")}</p>}
          {canEdit && data.attributes.length < data.limit && (
            <section className="rounded border border-border p-4">
              <h2 className="mb-3 text-sm font-semibold text-foreground">{t("Add an attribute")}</h2>
              <AttributeForm
                key={`new-${reloadKey}`}
                initial={EMPTY}
                typeLocked={false}
                busy={busy}
                submitLabel={t("Add")}
                t={t}
                onSubmit={(draft) => void call("/api/catalog/attributes", "POST", { ...payloadOf(draft), type: draft.type })}
              />
            </section>
          )}

          {data.attributes.length === 0 ? (
            <p className="text-sm text-muted">{t("No attributes yet: product cards have the base fields only.")}</p>
          ) : (
            <ul className="space-y-2">
              {data.attributes.map((attribute, index) => (
                <li key={attribute.id} className="rounded border border-border p-3">
                  {editing === attribute.id ? (
                    <AttributeForm
                      initial={{
                        label: attribute.label,
                        type: attribute.type,
                        unit: attribute.unit ?? "",
                        options: attribute.options.join("\n"),
                      }}
                      typeLocked
                      busy={busy}
                      submitLabel={t("Save changes")}
                      t={t}
                      onCancel={() => setEditing(null)}
                      onSubmit={(draft) =>
                        void call(`/api/catalog/attributes/${attribute.id}`, "PATCH", payloadOf(draft)).then(
                          (ok) => ok && setEditing(null)
                        )
                      }
                    />
                  ) : (
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 flex-1 space-y-1">
                        <p className="text-sm font-medium text-foreground" dir="auto">
                          {attribute.label}
                          {attribute.unit && <span className="ms-1 text-muted">({attribute.unit})</span>}
                        </p>
                        <p className="text-xs text-muted">
                          {typeLabel(attribute.type)}
                          {attribute.type === "CHOICE" && <span dir="auto">: {attribute.options.join(" · ")}</span>}
                        </p>
                      </div>
                      {canEdit && (
                        <div className="flex shrink-0 flex-wrap gap-2">
                          <button
                            type="button"
                            disabled={busy || index === 0}
                            onClick={() => void move(index, -1)}
                            aria-label={t("Move up")}
                            className="rounded border border-border px-2 py-1.5 text-xs text-foreground hover:bg-surface-hover disabled:opacity-40"
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            disabled={busy || index === data.attributes.length - 1}
                            onClick={() => void move(index, 1)}
                            aria-label={t("Move down")}
                            className="rounded border border-border px-2 py-1.5 text-xs text-foreground hover:bg-surface-hover disabled:opacity-40"
                          >
                            ↓
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditing(attribute.id)}
                            className="rounded border border-border px-3 py-1.5 text-xs text-foreground hover:bg-surface-hover"
                          >
                            {t("Edit")}
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => {
                              if (
                                confirm(
                                  t("Delete «{title}»? The values already on product cards are no longer used.", {
                                    title: attribute.label,
                                  })
                                )
                              ) {
                                void call(`/api/catalog/attributes/${attribute.id}`, "DELETE");
                              }
                            }}
                            className="rounded border border-error/40 px-3 py-1.5 text-xs text-error hover:bg-error/10 disabled:opacity-60"
                          >
                            {t("Delete")}
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
