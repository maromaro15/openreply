"use client";

/**
 * "Try the bot": ask what a customer would ask and see the answer, or the
 * handoff with its category and reason. Nothing is sent on Messenger and no
 * alert goes out; the conversation lives in this box only.
 */
import { useState } from "react";
import type { HandoffCategory } from "@/app/generated/prisma/client";
import { CUSTOMER_STATE_BADGE, CUSTOMER_STATE_LABELS, ORDER_LINE_LABELS } from "@/lib/bot/labels";
import type { OrderFieldValue } from "@/lib/bot/order";
import type { CustomerStateValue } from "@/lib/bot/persona";
import { translateReason } from "@/lib/facebook/i18n";
import { useFbI18n } from "@/lib/facebook/i18n/client";
import { HANDOFF_CATEGORY_BADGE } from "@/lib/handoff/categories";

type Decision =
  | { kind: "reply"; text: string }
  | { kind: "handoff"; category: HandoffCategory; reason: string; source: string };

type OrderLine = { field: OrderFieldValue | "PRODUCT"; value: string };

type Pictures = {
  onMessenger: boolean;
  button: string;
  sets: { type: "colours" | "compare"; cards: { title: string; subtitle: string | null; imagePath: string }[] }[];
};

type Turn =
  | { id: number; from: "customer"; text: string }
  | {
      id: number;
      from: "bot";
      decision: Decision;
      handoffMessage: string;
      error: string | null;
      customerState: CustomerStateValue | null;
      orderLines: OrderLine[];
      orderReady: { reason: string } | null;
      pictures: Pictures | null;
      attempts: number;
    };

/** What the bot read of the customer under its answer: their state, and the order so far. */
function CustomerNote({ turn }: { turn: Extract<Turn, { from: "bot" }> }) {
  const { t } = useFbI18n();
  const label = turn.customerState ? CUSTOMER_STATE_LABELS[turn.customerState] : null;
  if (!label && turn.orderLines.length === 0 && turn.attempts < 2) return null;
  return (
    <div className="space-y-1 text-[11px] text-muted">
      {label && turn.customerState && (
        <span className={`inline-flex rounded-full px-2 py-0.5 font-medium ${CUSTOMER_STATE_BADGE[turn.customerState]}`}>
          {t("Customer: {state}", { state: t(label) })}
        </span>
      )}
      {turn.attempts >= 2 && <p>{t("The guard refused the first reply; the bot was asked to rewrite it once.")}</p>}
      {turn.orderLines.length > 0 && (
        <p dir="auto">
          {t("Order so far:")}{" "}
          {turn.orderLines.map((line) => `${t(ORDER_LINE_LABELS[line.field])}: ${line.value}`).join(" · ")}
        </p>
      )}
    </div>
  );
}

/** The cards it would send after its words, as Messenger would show them. */
function PicturesNote({ pictures }: { pictures: Pictures }) {
  const { t } = useFbI18n();
  return (
    <div className="w-full max-w-[80%] space-y-2">
      {pictures.sets.map((set, index) => (
        <div key={index} className="space-y-1">
          <p className="text-[11px] text-muted">
            {set.type === "compare" ? t("Then a comparison, {count} cards:", { count: set.cards.length }) : t("Then the colours, {count} pictures:", { count: set.cards.length })}
          </p>
          <ul className="flex gap-2 overflow-x-auto pb-1">
            {set.cards.map((card, position) => (
              <li key={position} className="w-28 shrink-0 overflow-hidden rounded border border-border bg-surface">
                {/* eslint-disable-next-line @next/next/no-img-element -- a product picture served by this app */}
                <img src={card.imagePath} alt="" loading="lazy" className="block aspect-square w-full object-cover" />
                <p dir="auto" className="truncate px-1.5 pt-1 text-[11px] font-medium text-foreground">{card.title}</p>
                {card.subtitle && <p dir="auto" className="truncate px-1.5 text-[10px] text-muted">{card.subtitle}</p>}
                <p dir="auto" className="mt-1 border-t border-border px-1.5 py-0.5 text-center text-[10px] text-accent">{pictures.button}</p>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {!pictures.onMessenger && (
        <p className="text-[11px] text-warning">{t("On Messenger, pictures go out only once the app runs on a public https address.")}</p>
      )}
    </div>
  );
}

export default function BotTester({ botEnabled, aiConfigured }: { botEnabled: boolean; aiConfigured: boolean }) {
  const fb = useFbI18n();
  const { t } = fb;
  const [turns, setTurns] = useState<Turn[]>([]);
  // The order details collected in this test, as the server returned them.
  const [order, setOrder] = useState<unknown>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [afterTeam, setAfterTeam] = useState(false);

  async function ask() {
    const message = draft.trim();
    if (!message || busy) return;
    // The bot's earlier answers, as the test conversation so far.
    const history = turns.flatMap((turn): { from: "customer" | "page"; text: string }[] =>
      turn.from === "customer"
        ? [{ from: "customer", text: turn.text }]
        : turn.decision.kind === "reply"
          ? [{ from: "page", text: turn.decision.text }]
          : []
    );
    setBusy(true);
    setError(null);
    setTurns((current) => [...current, { id: Date.now(), from: "customer", text: message }]);
    setDraft("");
    try {
      const response = await fetch("/api/bot/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, history: history.slice(-20), order, afterTeam }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.success) {
        setError(
          payload?.code === "rate_limited"
            ? t("Too many bot tests this hour. Try again later.")
            : t("Something went wrong. Please try again.")
        );
        return;
      }
      setOrder(payload.data.order ?? null);
      setTurns((current) => [
        ...current,
        {
          id: Date.now() + 1,
          from: "bot",
          decision: payload.data.decision,
          handoffMessage: payload.data.handoffMessage,
          error: payload.data.error,
          customerState: payload.data.customerState ?? null,
          orderLines: payload.data.orderLines ?? [],
          orderReady: payload.data.orderReady ?? null,
          pictures: payload.data.pictures ?? null,
          attempts: payload.data.attempts ?? 1,
        },
      ]);
    } catch {
      setError(t("Could not reach the server. Please try again."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="rounded border border-border bg-surface px-3 py-2 text-sm text-muted">
        {t("Nothing is sent on Messenger and no alert goes out. The bot uses the saved settings and knowledge base.")}
      </p>
      {!aiConfigured && (
        <p role="alert" className="rounded border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-foreground">
          {t("The AI is not configured: set GOOGLE_API_KEY on the server. Until then, every message is handed to a person.")}
        </p>
      )}
      {!botEnabled && (
        <p className="text-sm text-muted">
          {t("The bot is off: it will not answer real messages until you turn it on in Settings.")}
        </p>
      )}

      <div className="min-h-48 space-y-3 rounded border border-border p-4">
        {turns.length === 0 ? (
          <p className="text-sm text-muted">{t("Write a question as a customer would, in Darija, French or Arabic.")}</p>
        ) : (
          turns.map((turn) =>
            turn.from === "customer" ? (
              <div key={turn.id} className="flex justify-start">
                <p dir="auto" className="max-w-[80%] whitespace-pre-wrap rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground">
                  {turn.text}
                </p>
              </div>
            ) : turn.decision.kind === "reply" ? (
              <div key={turn.id} className="flex flex-col items-end gap-1">
                <div className="max-w-[80%] rounded-lg bg-accent px-3 py-2 text-sm text-white">
                  <p dir="auto" className="whitespace-pre-wrap">{turn.decision.text}</p>
                  <p className="mt-1 text-[10px] text-white/75">{t("Bot")}</p>
                </div>
                {turn.pictures && <PicturesNote pictures={turn.pictures} />}
                <CustomerNote turn={turn} />
                {turn.orderReady && (
                  <p className="flex flex-wrap items-center gap-2 rounded border border-success/30 bg-success/5 px-2 py-1 text-xs text-foreground">
                    {t("Then hands over to a person:")}
                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${HANDOFF_CATEGORY_BADGE.ORDER_READY}`}>
                      {fb.category("ORDER_READY")}
                    </span>
                  </p>
                )}
              </div>
            ) : (
              <div key={turn.id} className="space-y-1.5 rounded border border-warning/40 bg-warning/5 p-3 text-sm">
                <p className="flex flex-wrap items-center gap-2 font-medium text-foreground">
                  {t("Would hand over to a person")}
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${HANDOFF_CATEGORY_BADGE[turn.decision.category]}`}>
                    {fb.category(turn.decision.category)}
                  </span>
                </p>
                <p className="text-muted">{t("Reason: {reason}", { reason: translateReason(t, turn.decision.reason) })}</p>
                <p dir="auto" className="whitespace-pre-wrap text-muted">
                  {t("The customer would get: {message}", { message: turn.handoffMessage })}
                </p>
                {turn.error && <p className="break-words text-[11px] text-zinc-500">{turn.error}</p>}
                <CustomerNote turn={turn} />
              </div>
            )
          )
        )}
        {busy && <p className="text-sm text-muted">{t("The bot is thinking…")}</p>}
      </div>

      {error && (
        <p role="alert" className="text-sm text-error">
          {error}
        </p>
      )}
      <div className="flex items-end gap-2">
        <label className="min-w-0 flex-1">
          <span className="sr-only">{t("Customer message")}</span>
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void ask();
              }
            }}
            rows={2}
            maxLength={1000}
            dir="auto"
            placeholder={t("Customer message")}
            className="block w-full resize-y rounded border border-border bg-surface px-3 py-2 text-sm text-foreground"
          />
        </label>
        <button
          type="button"
          onClick={() => void ask()}
          disabled={busy || !draft.trim()}
          className="shrink-0 rounded bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-60"
        >
          {t("Send")}
        </button>
        <button
          type="button"
          onClick={() => {
            setTurns([]);
            setOrder(null);
            setError(null);
          }}
          disabled={busy || turns.length === 0}
          className="shrink-0 rounded border border-border px-3 py-2 text-sm text-foreground hover:bg-surface-hover disabled:opacity-60"
        >
          {t("Start over")}
        </button>
      </div>
      <label className="flex items-center gap-2 text-sm text-muted">
        <input type="checkbox" checked={afterTeam} onChange={(event) => setAfterTeam(event.target.checked)} />
        {t("As if the bot came back after nobody from the team answered (busy message)")}
      </label>
    </div>
  );
}
