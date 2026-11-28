"use client";

/**
 * The voice interview on Telegram: pick the chat and the products, start or
 * stop, and follow the progress. Answers become suggestions to review;
 * nothing reaches a product card before a person approves it.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import type { FbI18n, FbStaticKey } from "@/lib/facebook/i18n";
import { useFbI18n } from "@/lib/facebook/i18n/client";

type Target = "strengths" | "comparisons" | "objections" | "suitableFor" | "faq";

type Suggestion = {
  id: string;
  target: string;
  productId: string | null;
  productName: string | null;
  payload: unknown;
  createdAt: string;
};

type Interview = {
  id: string;
  status: "ACTIVE" | "DONE" | "STOPPED";
  chatId: string;
  chatLabel: string;
  createdAt: string;
  lastAskedAt: string | null;
  total: number;
  position: number;
  question: number;
  questionCount: number;
  current: { productId: string; productName: string; target: Target } | null;
  pending: number;
  suggestions: Suggestion[];
};

type Panel = {
  bot: { username: string | null } | null;
  chats: { id: string; label: string; source: "recipient" | "seen" }[];
  candidates: { id: string; name: string; filled: number }[];
  maxProducts: number;
  interview: Interview | null;
};

const QUESTION_LABELS: Record<Target, FbStaticKey> = {
  strengths: "What makes it stand out",
  comparisons: "How it differs from similar products",
  faq: "What customers usually ask",
  objections: "Customers' worries",
  suitableFor: "Who and where it suits",
};

const SUGGESTION_LABELS: Record<string, FbStaticKey> = {
  "product.strengths": "Strengths",
  "product.comparisons": "Comparison",
  "product.objections": "Question or worry",
  "product.suitableFor": "Who it suits",
  faq: "Question or worry",
};

const LIVE_REFRESH_MS = 5_000;
const inputClass =
  "block w-full rounded border border-border bg-surface px-3 py-2 text-sm text-foreground disabled:opacity-60";

/** One bounded line of what a suggestion says: model text, shown as text only. */
function summary(payload: unknown): string {
  const value = (payload ?? {}) as { items?: unknown; question?: unknown; answer?: unknown; text?: unknown };
  let text = "";
  if (Array.isArray(value.items)) text = value.items.filter((item) => typeof item === "string").join(" · ");
  else if (typeof value.question === "string") text = `${value.question} — ${typeof value.answer === "string" ? value.answer : ""}`;
  else if (typeof value.text === "string") text = value.text;
  text = text.replace(/\s+/g, " ").trim();
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}

export default function InterviewPanel() {
  const { t } = useFbI18n();
  const [panel, setPanel] = useState<Panel | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [chatId, setChatId] = useState("");
  const [mode, setMode] = useState<"all" | "some">("all");
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/knowledge/interview", { cache: "no-store" })
      .then(async (response) => {
        if (cancelled) return;
        if (response.status === 403) {
          setForbidden(true);
          return;
        }
        const payload = await response.json().catch(() => null);
        if (cancelled) return;
        if (response.ok && payload?.success) setPanel(payload.data);
        else setError(t("Could not load the interview."));
      })
      .catch(() => {
        if (!cancelled) setError(t("Could not reach the server. Please try again."));
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey, t]);

  const active = panel?.interview?.status === "ACTIVE";
  useEffect(() => {
    if (!active) return;
    // Live progress while the owner answers on Telegram.
    const timer = setInterval(() => setReloadKey((key) => key + 1), LIVE_REFRESH_MS);
    return () => clearInterval(timer);
  }, [active]);

  const chosenChat = chatId || panel?.chats[0]?.id || "";

  function telegramProblem(code: unknown): string {
    if (code === "chat_not_found" || code === "forbidden") {
      return t("Telegram cannot find this chat: send /start to the bot from it, or add the bot to the group.");
    }
    if (code === "invalid_token") return t("The Telegram bot token is not valid anymore: save it again.");
    if (code === "webhook_active") {
      return t("This bot has a webhook at another service, so its recent chats cannot be read here. Enter the chat ID by hand.");
    }
    if (code === "unknown_chat") return t("Pick a chat that wrote to the bot, or an alert recipient.");
    if (code === "no_products") return t("There is no active product to ask about yet.");
    if (code === "no_bot") return t("Save the Telegram bot first.");
    return t("Could not reach Telegram. Please try again.");
  }

  async function call(method: "POST" | "DELETE", body?: unknown): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/knowledge/interview", {
        method,
        headers: { "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.success) {
        setError(payload?.code ? telegramProblem(payload.code) : t("Something went wrong. Please try again."));
      } else if (method === "POST") {
        setPanel(payload.data);
        setNotice(
          payload.data.asked
            ? t("The first question is on its way to Telegram.")
            : t("The interview started, but the first question did not reach Telegram. Send /status to the bot to get it.")
        );
      }
    } catch {
      setError(t("Could not reach the server. Please try again."));
    } finally {
      setBusy(false);
      setReloadKey((key) => key + 1);
    }
  }

  async function findChats() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/alerts/telegram/chats", { cache: "no-store" });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.success) setError(telegramProblem(payload?.code));
      else if (!payload.data.chats.length) setError(t("No chat found yet."));
    } catch {
      setError(t("Could not reach the server. Please try again."));
    } finally {
      setBusy(false);
      setReloadKey((key) => key + 1);
    }
  }

  function toggle(id: string) {
    setSelected((current) => {
      if (current.includes(id)) return current.filter((value) => value !== id);
      return panel && current.length >= panel.maxProducts ? current : [...current, id];
    });
  }

  const interview = panel?.interview ?? null;

  return (
    <section className="space-y-4 rounded border border-border p-4">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold text-foreground">{t("Voice interview on Telegram")}</h2>
        <p className="text-sm text-muted">
          {t("The alerts bot asks you about each product in Darija; answer by voice or in writing. Each answer becomes suggestions to review: nothing changes on the cards until you approve it.")}
        </p>
      </div>

      {forbidden ? (
        <p className="text-sm text-muted">{t("Only owners and admins can run the interview.")}</p>
      ) : !panel ? (
        !error && <p className="text-sm text-muted">{t("Loading…")}</p>
      ) : !panel.bot ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded border border-warning/30 bg-warning/10 p-3 text-sm">
          <p className="text-foreground">{t("The interview uses the brand's Telegram alerts bot. Save the bot first.")}</p>
          <Link href="/facebook/alerts" className="shrink-0 rounded bg-accent px-3 py-2 font-medium text-accent-foreground hover:bg-accent-hover">
            {t("Alerts")}
          </Link>
        </div>
      ) : interview && interview.status === "ACTIVE" ? (
        <div className="space-y-3 text-sm">
          <p className="text-foreground">
            {t("Running in «{chat}».", { chat: interview.chatLabel })}
          </p>
          {interview.current && (
            <div className="space-y-1 rounded border border-border bg-surface p-3">
              <p className="text-muted">
                {t("Product {index} of {total}", { index: interview.position + 1, total: interview.total })}
              </p>
              <p dir="auto" className="break-words font-medium text-foreground">
                {interview.current.productName}
              </p>
              <p className="text-muted">
                {t("Question {index} of {total}: {question}", {
                  index: interview.question + 1,
                  total: interview.questionCount,
                  question: t(QUESTION_LABELS[interview.current.target]),
                })}
              </p>
            </div>
          )}
          <div
            className="h-2 w-full overflow-hidden rounded bg-surface"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={interview.total}
            aria-valuenow={interview.position}
          >
            <div
              className="h-full bg-accent"
              style={{ width: `${interview.total ? Math.round((interview.position / interview.total) * 100) : 0}%` }}
            />
          </div>
          <p className="text-xs text-muted">{t("In the chat: /skip passes a question, /next goes to the next product, /status, /stop.")}</p>
          <Pending interview={interview} t={t} />
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (confirm(t("Stop the interview? What was answered stays in the suggestions."))) void call("DELETE");
            }}
            className="rounded border border-error/40 px-4 py-2 text-sm text-error hover:bg-error/10 disabled:opacity-60"
          >
            {t("Stop the interview")}
          </button>
        </div>
      ) : (
        <div className="space-y-4 text-sm">
          {interview && (
            <div className="space-y-2 rounded border border-border bg-surface p-3">
              <p className="text-foreground">
                {interview.status === "DONE"
                  ? t("The last interview is finished.")
                  : t("The last interview was stopped. Send /interview to the bot within a day to go on where it stopped.")}
              </p>
              <Pending interview={interview} t={t} />
            </div>
          )}

          <div className="space-y-1">
            <span className="text-muted">{t("Chat that answers")}</span>
            {panel.chats.length === 0 ? (
              <p className="text-muted">
                {t("No chat yet: send /start to the bot from your Telegram (or add it to a group), then find the chats.")}
              </p>
            ) : (
              <select
                value={chosenChat}
                onChange={(event) => setChatId(event.target.value)}
                disabled={busy}
                className={inputClass}
              >
                {panel.chats.map((chat) => (
                  <option key={chat.id} value={chat.id}>
                    {chat.label === chat.id ? chat.id : `${chat.label} (${chat.id})`}
                  </option>
                ))}
              </select>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={() => void findChats()}
              className="text-foreground underline underline-offset-2 disabled:opacity-60"
            >
              {t("Find recent chats")}
            </button>
          </div>

          <fieldset className="space-y-2">
            <legend className="text-muted">{t("Products")}</legend>
            {panel.candidates.length === 0 ? (
              <p className="text-muted">{t("There is no active product to ask about yet.")}</p>
            ) : (
              <>
                <label className="flex items-start gap-2 text-foreground">
                  <input type="radio" checked={mode === "all"} onChange={() => setMode("all")} className="mt-1" />
                  <span>
                    {t("All active products, the least filled first ({count} at most)", { count: panel.maxProducts })}
                  </span>
                </label>
                <label className="flex items-start gap-2 text-foreground">
                  <input type="radio" checked={mode === "some"} onChange={() => setMode("some")} className="mt-1" />
                  <span>{t("Only the products I choose")}</span>
                </label>
                {mode === "some" && (
                  <div className="space-y-1">
                    <p className="text-xs text-muted">
                      {t("{count} chosen, {max} at most", { count: selected.length, max: panel.maxProducts })}
                    </p>
                    <ul className="max-h-64 space-y-1 overflow-y-auto rounded border border-border p-2">
                      {panel.candidates.map((product) => (
                        <li key={product.id}>
                          <label className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={selected.includes(product.id)}
                              onChange={() => toggle(product.id)}
                            />
                            <span dir="auto" className="min-w-0 flex-1 truncate text-foreground">
                              {product.name}
                            </span>
                            <span className="shrink-0 text-xs text-muted">
                              {t("{count} of 4 filled", { count: product.filled })}
                            </span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}
          </fieldset>

          <button
            type="button"
            disabled={busy || !chosenChat || panel.candidates.length === 0 || (mode === "some" && selected.length === 0)}
            onClick={() =>
              void call("POST", { chatId: chosenChat, ...(mode === "some" ? { productIds: selected } : {}) })
            }
            className="rounded bg-accent px-4 py-2 text-sm font-medium text-accent-foreground hover:bg-accent-hover disabled:opacity-60"
          >
            {busy ? t("Starting…") : t("Start the interview")}
          </button>
        </div>
      )}

      {notice && (
        <p role="status" className="text-sm text-success">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-error">
          {error}
        </p>
      )}
    </section>
  );
}

function Pending({ interview, t }: { interview: Interview; t: FbI18n["t"] }) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-foreground">
          {t("{count} suggestions from this interview wait for review.", { count: interview.pending })}
        </p>
        {interview.pending > 0 && (
          <Link href="/facebook/knowledge/suggestions" className="text-foreground underline underline-offset-2">
            {t("Suggestions to review")}
          </Link>
        )}
      </div>
      {interview.suggestions.length > 0 && (
        <ul className="space-y-1">
          {interview.suggestions.map((suggestion) => (
            <li key={suggestion.id} className="min-w-0 rounded border border-border p-2 text-xs">
              <p className="text-muted">
                {t(SUGGESTION_LABELS[suggestion.target] ?? "Suggestion")}
                {suggestion.productName && (
                  <span dir="auto" className="ms-1">
                    · {suggestion.productName}
                  </span>
                )}
              </p>
              <p dir="auto" className="break-words text-foreground">
                {summary(suggestion.payload)}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
