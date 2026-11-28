"use client";

/**
 * Suggestions waiting for a person: what the past conversations, the Telegram
 * interview and the replies after a handoff propose for the product cards and
 * the knowledge base. Grouped by product, then the knowledge base. Owners and
 * admins edit, approve or reject; members read.
 *
 * Every text here came from a model reading customers' words: it is shown as
 * plain text and only written anywhere when a person approves it.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { translateReason, type FbStaticKey } from "@/lib/facebook/i18n";
import { useFbI18n } from "@/lib/facebook/i18n/client";
import type { SuggestionCounts, SuggestionView } from "@/lib/knowledge/review";

type Source = SuggestionView["source"];
type Target = SuggestionView["target"];
type Filter = "ALL" | Source;

type Loaded = {
  role: string;
  counts: SuggestionCounts;
  suggestions: SuggestionView[];
  nextCursor: string | null;
};

const SOURCES: Record<Source, FbStaticKey> = {
  POST: "From a post",
  CONVERSATION: "From conversations",
  INTERVIEW: "From a voice interview",
  HANDOFF_REPLY: "From a reply after a handoff",
};

const SOURCE_ORDER: Source[] = ["POST", "CONVERSATION", "INTERVIEW", "HANDOFF_REPLY"];

const TARGETS: Record<Target, FbStaticKey> = {
  faq: "Frequently asked question",
  delivery: "Delivery information",
  "product.strengths": "Strengths, one per line",
  "product.objections": "Question or worry",
  "product.comparisons": "Comparison with similar products or competitors",
  "product.suitableFor": "Suitable for",
};

/** The limits of the fields they are written to (the knowledge base entry, the product card). */
const LIMITS = { faqQuestion: 200, question: 300, answer: 1000, text: 2000, item: 300, items: 10 } as const;

const inputClass =
  "block w-full rounded border border-border bg-surface px-3 py-2 text-sm text-foreground disabled:opacity-60";

function listUrl(source: Filter, cursor: string | null): string {
  const params = new URLSearchParams();
  if (source !== "ALL") params.set("source", source);
  if (cursor) params.set("cursor", cursor);
  return `/api/knowledge/suggestions?${params.toString()}`;
}

/** The product's group first-come, then the knowledge base's; the list is newest first. */
function groupOf(suggestions: SuggestionView[]): { key: string; productId: string | null; name: string | null; items: SuggestionView[] }[] {
  const groups = new Map<string, { key: string; productId: string | null; name: string | null; items: SuggestionView[] }>();
  for (const item of suggestions) {
    const key = item.productId ?? "";
    const group = groups.get(key) ?? { key, productId: item.productId, name: item.productName, items: [] };
    group.items.push(item);
    groups.set(key, group);
  }
  const all = [...groups.values()];
  return [...all.filter((group) => group.productId), ...all.filter((group) => !group.productId)];
}

export default function SuggestionsReview() {
  const { t } = useFbI18n();
  const [source, setSource] = useState<Filter>("ALL");
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(listUrl(source, null), { cache: "no-store" })
      .then((response) => response.json())
      .then((payload) => {
        if (cancelled) return;
        if (payload?.success) {
          setData(payload.data);
          setError(null);
        } else setError(t("Could not load the suggestions."));
      })
      .catch(() => {
        if (!cancelled) setError(t("Could not reach the server. Please try again."));
      });
    return () => {
      cancelled = true;
    };
  }, [source, t]);

  async function loadMore() {
    if (!data?.nextCursor) return;
    setLoadingMore(true);
    try {
      const payload = await fetch(listUrl(source, data.nextCursor), { cache: "no-store" }).then((response) => response.json());
      if (payload?.success) {
        const more = payload.data as Loaded;
        setData((current) =>
          current
            ? {
                ...current,
                counts: more.counts,
                nextCursor: more.nextCursor,
                // A row decided meanwhile is not offered twice.
                suggestions: [
                  ...current.suggestions,
                  ...more.suggestions.filter((item) => !current.suggestions.some((known) => known.id === item.id)),
                ],
              }
            : current
        );
      } else setError(t("Could not load the suggestions."));
    } catch {
      setError(t("Could not reach the server. Please try again."));
    } finally {
      setLoadingMore(false);
    }
  }

  /** The suggestion is decided (by this click, or by someone else): it leaves the list. */
  function decided(item: SuggestionView, message: string | null) {
    setNotice(message);
    setData((current) =>
      current
        ? {
            ...current,
            suggestions: current.suggestions.filter((known) => known.id !== item.id),
            counts: {
              pending: Math.max(0, current.counts.pending - 1),
              bySource: { ...current.counts.bySource, [item.source]: Math.max(0, current.counts.bySource[item.source] - 1) },
            },
          }
        : current
    );
  }

  if (!data) {
    return error ? (
      <p role="alert" className="text-sm text-error" dir="auto">
        {error}
      </p>
    ) : (
      <p className="text-sm text-muted">{t("Loading…")}</p>
    );
  }

  const canEdit = data.role === "OWNER" || data.role === "ADMIN";
  const groups = groupOf(data.suggestions);

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <p className="text-sm text-muted">
        {t("Review each suggestion: edit the text if needed, then approve it to add it, or reject it. Nothing is added before you approve.")}
      </p>
      {!canEdit && <p className="text-sm text-muted">{t("Only owners and admins can review the suggestions.")}</p>}

      <div className="flex flex-wrap gap-1" role="tablist">
        <FilterChip active={source === "ALL"} onClick={() => setSource("ALL")} label={`${t("All")} (${data.counts.pending})`} />
        {SOURCE_ORDER.map((value) => (
          <FilterChip
            key={value}
            active={source === value}
            onClick={() => setSource(value)}
            label={`${t(SOURCES[value])} (${data.counts.bySource[value]})`}
          />
        ))}
      </div>

      {error && (
        <p role="alert" className="text-sm text-error" dir="auto">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm text-success" dir="auto">
          {notice}
        </p>
      )}

      {data.suggestions.length === 0 ? (
        <div className="space-y-2 rounded border border-border p-6 text-sm text-muted">
          <p className="font-medium text-foreground">{t("Nothing to review right now.")}</p>
          <p>
            {t(
              "Suggestions come from three places: your past Messenger conversations, the voice interview on Telegram, and your own replies to customers after the bot handed over. Nothing is applied until a person approves it."
            )}
          </p>
          <Link href="/facebook/knowledge" className="inline-block text-foreground underline underline-offset-2">
            {t("Knowledge base")}
          </Link>
        </div>
      ) : (
        <div className="space-y-6">
          {groups.map((group) => (
            <section key={group.key} className="space-y-3">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                {group.productId ? (
                  <Link href={`/facebook/products/${group.productId}`} className="min-w-0 truncate hover:underline" dir="auto">
                    {group.name ?? group.productId}
                  </Link>
                ) : (
                  <span>{t("Knowledge base")}</span>
                )}
                <span className="rounded-full bg-surface-hover px-2 py-0.5 text-xs font-normal text-muted">{group.items.length}</span>
              </h2>
              <ul className="space-y-3">
                {group.items.map((item) => (
                  <li key={item.id}>
                    <SuggestionCard item={item} canEdit={canEdit} onDecided={decided} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {data.nextCursor && (
            <button
              type="button"
              disabled={loadingMore}
              onClick={() => void loadMore()}
              className="w-full rounded border border-border px-3 py-2 text-sm text-foreground hover:bg-surface-hover disabled:opacity-60"
            >
              {loadingMore ? t("Loading…") : t("Load more")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function FilterChip({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`rounded-full border px-3 py-1 text-xs ${
        active ? "border-accent bg-accent/10 font-medium text-foreground" : "border-border text-muted hover:text-foreground"
      }`}
    >
      {label}
    </button>
  );
}

type Draft = { question: string; answer: string; text: string };

function draftOf(item: SuggestionView): Draft {
  const { payload } = item;
  return {
    question: payload.question ?? "",
    answer: payload.answer ?? "",
    // Strengths are edited as one per line.
    text: item.target === "product.strengths" ? (payload.items ?? []).join("\n") : (payload.text ?? ""),
  };
}

function payloadOf(target: Target, draft: Draft) {
  if (target === "faq" || target === "product.objections") return { question: draft.question, answer: draft.answer };
  if (target === "product.strengths") return { items: draft.text.split("\n") };
  return { text: draft.text };
}

function SuggestionCard({
  item,
  canEdit,
  onDecided,
}: {
  item: SuggestionView;
  canEdit: boolean;
  onDecided: (item: SuggestionView, message: string | null) => void;
}) {
  const { t } = useFbI18n();
  const [draft, setDraft] = useState<Draft>(() => draftOf(item));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isQa = item.target === "faq" || item.target === "product.objections";
  const questionMax = item.target === "faq" ? LIMITS.faqQuestion : LIMITS.question;
  const textMax = item.target === "product.strengths" ? LIMITS.item * LIMITS.items : LIMITS.text;
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });

  const tooLong = isQa ? Array.from(draft.question).length > questionMax : false;
  const complete = isQa ? draft.question.trim() !== "" && draft.answer.trim() !== "" : draft.text.trim() !== "";

  async function decide(action: "approve" | "reject") {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/knowledge/suggestions/${item.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(action === "approve" ? { action, payload: payloadOf(item.target, draft) } : { action }),
      });
      const payload = await response.json().catch(() => null);
      if (response.ok && payload?.success) {
        if (action === "reject") return onDecided(item, t("Rejected."));
        const applied = payload.data?.applied as { kind: string; changed?: boolean } | null;
        return onDecided(
          item,
          applied?.kind === "knowledge"
            ? t("Added to the knowledge base.")
            : applied?.changed === false
              ? t("The product card already has this: nothing to add.")
              : t("Added to the product card.")
        );
      }
      // Decided by someone else meanwhile, or gone: nothing left to review here.
      if (payload?.code === "already_decided" || payload?.code === "not_found") return onDecided(item, null);
      setError(payload?.error ? translateReason(t, payload.error) : t("Something went wrong. Please try again."));
    } catch {
      setError(t("Could not reach the server. Please try again."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="space-y-3 rounded border border-border bg-surface p-3">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
        <span className="rounded-full bg-surface-hover px-2 py-0.5">{t(SOURCES[item.source])}</span>
        <span>{item.target === "product.strengths" ? t("Strengths") : t(TARGETS[item.target])}</span>
        {item.conversationId && (
          <Link href={`/facebook/inbox?conversation=${encodeURIComponent(item.conversationId)}`} className="text-foreground underline underline-offset-2">
            {t("Open the conversation")}
          </Link>
        )}
      </p>

      {item.evidence && (
        <figure className="space-y-1">
          <figcaption className="text-xs text-muted">{t("What it was read from")}</figcaption>
          <blockquote
            dir="auto"
            className="max-h-32 overflow-y-auto whitespace-pre-line break-words border-s-2 border-border ps-3 text-xs text-muted"
          >
            {item.evidence}
          </blockquote>
        </figure>
      )}

      <fieldset disabled={!canEdit || busy} className="min-w-0 space-y-2">
        {isQa ? (
          <>
            <label className="block space-y-1 text-sm">
              <span className="text-muted">{t("Question")}</span>
              <input value={draft.question} onChange={(event) => set({ question: event.target.value })} dir="auto" className={inputClass} />
            </label>
            {tooLong && (
              <p className="text-xs text-warning">{t("The question is longer than {count} characters: shorten it.", { count: questionMax })}</p>
            )}
            <label className="block space-y-1 text-sm">
              <span className="text-muted">{t("Answer")}</span>
              <textarea
                value={draft.answer}
                onChange={(event) => set({ answer: event.target.value })}
                maxLength={LIMITS.answer}
                rows={3}
                dir="auto"
                className={inputClass}
              />
            </label>
          </>
        ) : (
          <label className="block space-y-1 text-sm">
            <span className="text-muted">{t(TARGETS[item.target])}</span>
            <textarea
              value={draft.text}
              onChange={(event) => set({ text: event.target.value })}
              maxLength={textMax}
              rows={item.target === "product.strengths" ? 4 : 3}
              dir="auto"
              className={inputClass}
            />
          </label>
        )}
      </fieldset>

      {error && (
        <p role="alert" className="text-sm text-error" dir="auto">
          {error}
        </p>
      )}

      {canEdit && (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy || tooLong || !complete}
            onClick={() => void decide("approve")}
            className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-accent-foreground hover:bg-accent-hover disabled:opacity-60"
          >
            {busy ? t("Saving…") : t("Approve")}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void decide("reject")}
            className="rounded border border-border px-3 py-1.5 text-xs text-foreground hover:bg-surface-hover disabled:opacity-60"
          >
            {t("Reject")}
          </button>
        </div>
      )}
    </article>
  );
}
