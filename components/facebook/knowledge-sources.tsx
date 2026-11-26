"use client";

/**
 * Fill the catalog and the knowledge base from a Page: read its recent posts
 * into draft products, or its past Messenger answers into suggestions. Both
 * are jobs on the worker; this shows the state of the last run of each and
 * where the result went. Nothing is applied: a person reviews it all.
 * Owners and admins only (the routes check it too).
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import type { SourceRun } from "@/app/api/knowledge/sources/shared";
import { translateReason } from "@/lib/facebook/i18n";
import { useFbI18n } from "@/lib/facebook/i18n/client";

type Kind = "posts" | "conversations";
type RunView = { run: SourceRun | null; error: string | null };
type Runs = { pageId: string; posts: RunView | null; conversations: RunView | null };
type PageRow = { id: string; name: string; status: string };

const KINDS: Kind[] = ["posts", "conversations"];
const POLL_MS = 3000;
const JSON_HEADERS = { "Content-Type": "application/json" };

function emptyRuns(pageId: string): Runs {
  return { pageId, posts: null, conversations: null };
}

async function loadRun(kind: Kind, pageId: string): Promise<RunView> {
  try {
    const response = await fetch(`/api/knowledge/sources/${kind}?facebookPageId=${encodeURIComponent(pageId)}`, {
      cache: "no-store",
    });
    const payload = await response.json().catch(() => null);
    if (response.ok && payload?.success) return { run: payload.data as SourceRun, error: null };
    return { run: null, error: typeof payload?.error === "string" ? payload.error : "Something went wrong. Please try again." };
  } catch {
    return { run: null, error: "Could not reach the server. Please try again." };
  }
}

async function loadRuns(pageId: string): Promise<Runs> {
  const [posts, conversations] = await Promise.all(KINDS.map((kind) => loadRun(kind, pageId)));
  return { pageId, posts, conversations };
}

export default function KnowledgeSources() {
  const { t, locale } = useFbI18n();
  const [pages, setPages] = useState<PageRow[] | null>(null);
  const [role, setRole] = useState("");
  const [loadFailed, setLoadFailed] = useState(false);
  const [pageId, setPageId] = useState("");
  const [runs, setRuns] = useState<Runs>(emptyRuns(""));
  const [starting, setStarting] = useState<Kind | null>(null);

  const canRun = role === "OWNER" || role === "ADMIN";
  // Runs belong to the Page they were read for: switching Pages shows nothing stale.
  const current = runs.pageId === pageId ? runs : emptyRuns(pageId);
  const active = KINDS.some((kind) => current[kind]?.run?.state === "running");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/facebook/pages", { cache: "no-store" })
      .then((response) => response.json())
      .then((payload) => {
        if (cancelled) return;
        if (!payload?.success) {
          setLoadFailed(true);
          return;
        }
        const connected = (payload.data.pages as PageRow[]).filter((page) => page.status === "ACTIVE");
        setPages(connected);
        setRole(String(payload.data.role ?? ""));
        setPageId((previous) => previous || connected[0]?.id || "");
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!pageId || !canRun) return;
    let cancelled = false;
    void loadRuns(pageId).then((next) => {
      if (!cancelled) setRuns(next);
    });
    return () => {
      cancelled = true;
    };
  }, [pageId, canRun]);

  // Live state: look again every few seconds while a run is active.
  useEffect(() => {
    if (!pageId || !active) return;
    let stopped = false;
    const timer = setInterval(() => {
      void loadRuns(pageId).then((next) => {
        if (stopped) return;
        // A failed poll keeps what is shown: the run itself is not affected.
        setRuns((previous) => {
          const before = previous.pageId === pageId ? previous : emptyRuns(pageId);
          return {
            pageId,
            posts: next.posts?.error ? before.posts : next.posts,
            conversations: next.conversations?.error ? before.conversations : next.conversations,
          };
        });
      });
    }, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [pageId, active]);

  async function start(kind: Kind) {
    setStarting(kind);
    let view: RunView;
    try {
      const response = await fetch(`/api/knowledge/sources/${kind}`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ facebookPageId: pageId }),
      });
      const payload = await response.json().catch(() => null);
      view =
        response.ok && payload?.success
          ? { run: payload.data as SourceRun, error: null }
          : { run: current[kind]?.run ?? null, error: payload?.error ?? "Something went wrong. Please try again." };
    } catch {
      view = { run: current[kind]?.run ?? null, error: "Could not reach the server. Please try again." };
    } finally {
      setStarting(null);
    }
    setRuns((previous) => ({ ...(previous.pageId === pageId ? previous : emptyRuns(pageId)), [kind]: view }));
  }

  if (loadFailed) {
    return (
      <p role="alert" className="text-sm text-error">
        {t("Could not reach the server. Please try again.")}
      </p>
    );
  }
  if (!pages) return <p className="text-sm text-muted">{t("Loading…")}</p>;

  if (!canRun) {
    return <p className="text-sm text-muted">{t("Only owners and admins can fill the knowledge base from a Page.")}</p>;
  }

  if (pages.length === 0) {
    return (
      <p className="text-sm text-muted">
        {t("No Page connected yet.")}{" "}
        <Link href="/facebook/pages" className="text-accent underline">
          {t("Facebook Pages")}
        </Link>
      </p>
    );
  }

  const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(locale) : "");

  function resultOf(run: SourceRun) {
    const summary = run.summary;
    if (!summary) return null;
    const line = (text: string) => <li key={text}>{text}</li>;
    if (summary.kind === "posts") {
      return (
        <>
          <ul className="list-disc space-y-0.5 ps-5">
            {line(t("Posts read: {count}", { count: summary.postsRead }))}
            {summary.postsSkipped > 0 && line(t("Already read in an earlier run: {count}", { count: summary.postsSkipped }))}
            {line(t("Drafts created: {count}", { count: summary.draftsCreated }))}
            {summary.alreadyThere > 0 && line(t("Already there: {count}", { count: summary.alreadyThere }))}
            {summary.withoutPicture > 0 && line(t("Without a picture: {count}", { count: summary.withoutPicture }))}
            {summary.codeClashes > 0 &&
              line(t("Code already used by another product: {count}", { count: summary.codeClashes }))}
            {summary.failed > 0 && line(t("Could not be saved: {count}", { count: summary.failed }))}
          </ul>
          {summary.stoppedAtLimit && <p className="text-warning">{t("Stopped: the product limit was reached.")}</p>}
          {summary.draftsCreated === 0 && summary.alreadyThere === 0 && (
            <p className="text-muted">{t("No product found in these posts.")}</p>
          )}
          {summary.draftsCreated > 0 && (
            <Link href="/facebook/products?status=DRAFT" className="inline-block text-accent underline">
              {t("Review the drafts")}
            </Link>
          )}
        </>
      );
    }
    return (
      <>
        <ul className="list-disc space-y-0.5 ps-5">
          {line(t("Conversations read: {count}", { count: summary.threadsRead }))}
          {line(t("Suggestions added: {count}", { count: summary.suggestionsAdded }))}
          {summary.suggestionsFound > summary.suggestionsAdded &&
            line(t("Already known: {count}", { count: summary.suggestionsFound - summary.suggestionsAdded }))}
        </ul>
        {summary.suggestionsFound === 0 && <p className="text-muted">{t("Nothing useful found in these conversations.")}</p>}
        {summary.suggestionsAdded > 0 && (
          <Link href="/facebook/knowledge/suggestions" className="inline-block text-accent underline">
            {t("Review the suggestions")}
          </Link>
        )}
      </>
    );
  }

  const cards: { kind: Kind; title: string; help: string; start: string }[] = [
    {
      kind: "posts",
      title: t("Products from recent posts"),
      help: t(
        "Reads the Page's latest posts and makes a draft product for each product it finds: name, code, price, colours and the first picture. Drafts wait for your approval."
      ),
      start: t("Read the posts"),
    },
    {
      kind: "conversations",
      title: t("Suggestions from past conversations"),
      help: t(
        "Reads how the Page answered customers on Messenger and suggests prices, comparisons and answers to worries. Customers' names and phone numbers are never kept."
      ),
      start: t("Read the conversations"),
    },
  ];

  return (
    <section className="min-w-0 space-y-4">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold text-foreground">{t("Fill the knowledge base from your Page")}</h2>
        <p className="text-sm text-muted">{t("Nothing is applied by itself: you review everything first.")}</p>
      </div>

      {pages.length > 1 && (
        <label className="block space-y-1">
          <span className="text-sm font-semibold text-foreground">{t("Facebook Page")}</span>
          <select
            value={pageId}
            onChange={(event) => setPageId(event.target.value)}
            className="block w-full rounded border border-border bg-surface px-3 py-2 text-sm text-foreground sm:max-w-sm"
          >
            {pages.map((page) => (
              <option key={page.id} value={page.id}>
                {page.name}
              </option>
            ))}
          </select>
        </label>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        {cards.map((card) => {
          const view = current[card.kind];
          const run = view?.run ?? null;
          const running = run?.state === "running";
          const error = view?.error ?? (run?.state === "failed" ? run.error : null);
          return (
            <div key={card.kind} className="min-w-0 space-y-3 rounded border border-border bg-surface p-4">
              <h3 className="text-sm font-semibold text-foreground">{card.title}</h3>
              <p className="text-sm text-muted">{card.help}</p>
              <button
                type="button"
                onClick={() => void start(card.kind)}
                disabled={running || starting === card.kind}
                className="w-full rounded bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-60 sm:w-auto"
              >
                {running || starting === card.kind ? t("Running…") : run && run.state !== "idle" ? t("Run again") : card.start}
              </button>

              <div aria-live="polite" className="space-y-2 text-sm text-foreground">
                {running && <p className="text-muted">{t("Running: this can take a few minutes. You can leave this page.")}</p>}
                {error && (
                  <p role="alert" className="break-words text-error">
                    {translateReason(t, error)}
                  </p>
                )}
                {run && run.state === "done" && (
                  <>
                    <p className="text-muted">{t("Finished {date}", { date: when(run.finishedAt) })}</p>
                    {resultOf(run)}
                  </>
                )}
                {run && run.state === "failed" && run.finishedAt && (
                  <p className="text-muted">{t("Failed {date}", { date: when(run.finishedAt) })}</p>
                )}
                {(!run || run.state === "idle") && !error && <p className="text-muted">{t("Not run yet.")}</p>}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
