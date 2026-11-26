"use client";

/**
 * Messenger inbox: the conversations of the active brand's Pages, who
 * answers each one (the bot or a person), and replies typed by the team.
 * Refreshed every 10 seconds while the tab is visible.
 */
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { HandoffCategory } from "@/app/generated/prisma/client";
import { selectWorkspace } from "@/lib/agency/actions";
import { translateReason, type FbI18n, type FbStaticKey } from "@/lib/facebook/i18n";
import { useFbI18n } from "@/lib/facebook/i18n/client";
import type {
  ConversationListItem,
  ConversationThread,
  ThreadEvent,
  ThreadMessage,
} from "@/lib/facebook/inbox";
import { HUMAN_REPLY_ERRORS, isHumanReplyError } from "@/lib/facebook/reply-errors";
import { HANDOFF_CATEGORIES, HANDOFF_CATEGORY_BADGE } from "@/lib/handoff/categories";
import { CUSTOMER_STATE_BADGE, CUSTOMER_STATE_LABELS, ORDER_LINE_LABELS } from "@/lib/bot/labels";
import type { CustomerStateValue } from "@/lib/bot/persona";
import { useI18n } from "@/lib/i18n/provider";

const POLL_MS = 10_000;
const PAGE_SIZE = 30;
const MAX_REPLY_LENGTH = 2000;

type Filter = "all" | "needs_human" | "bot" | "human";

const FILTERS: { value: Filter; label: FbStaticKey }[] = [
  { value: "all", label: "All" },
  { value: "needs_human", label: "Need a person" },
  { value: "bot", label: "With the bot" },
  { value: "human", label: "With a person" },
];

type ListData = {
  conversations: ConversationListItem[];
  hasMore: boolean;
  counts: { needsHuman: number; byCategory: Record<HandoffCategory, number> };
};

type PageOption = { id: string; name: string };

const ATTACHMENTS: Record<string, { mark: string; label: FbStaticKey }> = {
  audio: { mark: "🎤", label: "Voice message" },
  image: { mark: "📷", label: "Image" },
  video: { mark: "🎬", label: "Video" },
  file: { mark: "📎", label: "File" },
  sticker: { mark: "🙂", label: "Sticker" },
  location: { mark: "📍", label: "Location" },
  // The bot's colour cards or comparison (phase 13): their titles are the text.
  template: { mark: "🖼️", label: "Pictures" },
};

function formatTime(iso: string | null, locale: string, now: number): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const sameDay = now > 0 && date.toDateString() === new Date(now).toDateString();
  return sameDay
    ? date.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" })
    : date.toLocaleString(locale, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function windowLabel(thread: ConversationThread["conversation"], now: number, t: FbI18n["t"]): string | null {
  if (!now) return null;
  const reply = thread.reply;
  if (!reply.canReply) return t("Reply window closed");
  const left = Math.max(0, new Date(reply.endsAt).getTime() - now);
  if (reply.humanAgentTag) {
    return t("{days} days left to reply (human agent tag)", { days: Math.ceil(left / 86_400_000) });
  }
  return t("{hours} h {minutes} min left to reply", {
    hours: Math.floor(left / 3_600_000),
    minutes: Math.floor((left % 3_600_000) / 60_000),
  });
}

function CategoryBadge({ category, label }: { category: HandoffCategory; label: string }) {
  return (
    <span className={`inline-flex shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${HANDOFF_CATEGORY_BADGE[category]}`}>
      {label}
    </span>
  );
}

/** The customer's state at the bot's last answer; nothing when neutral or unknown. */
function StateBadge({ state, t }: { state: CustomerStateValue | null; t: FbI18n["t"] }) {
  const label = state ? CUSTOMER_STATE_LABELS[state] : null;
  if (!state || !label) return null;
  return (
    <span className={`inline-flex shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${CUSTOMER_STATE_BADGE[state]}`}>
      {t(label)}
    </span>
  );
}

function ModeBadge({ mode, t }: { mode: "BOT" | "HUMAN"; t: FbI18n["t"] }) {
  return (
    <span
      className={`inline-flex shrink-0 rounded-full border px-2 py-0.5 text-[11px] ${
        mode === "BOT" ? "border-accent/40 text-accent" : "border-border text-muted"
      }`}
    >
      {mode === "BOT" ? t("Bot") : t("Person")}
    </span>
  );
}

function eventText(event: ThreadEvent, fb: FbI18n): string {
  const { t } = fb;
  switch (event.type) {
    case "HANDOFF":
      return event.category
        ? t("Handed to a person: {category}", { category: fb.category(event.category) })
        : t("Handed to a person");
    case "HUMAN_TAKEOVER":
      if (event.reason === "META_REPLY") return t("A person replied from Meta Business Suite");
      return event.actor ? t("{name} took over", { name: event.actor }) : t("Taken over by a person");
    case "RETURNED_TO_BOT":
      return event.actor ? t("{name} returned it to the bot", { name: event.actor }) : t("Returned to the bot");
  }
}

function authorLabel(message: ThreadMessage, t: FbI18n["t"]): string | null {
  if (message.direction === "INBOUND") return null;
  if (message.author === "BOT") return t("Bot");
  if (message.author === "CAMPAIGN") return t("Private reply");
  if (message.origin === "EXTERNAL") return t("From Meta");
  return message.sentBy ?? t("Team");
}

function statusLabel(message: ThreadMessage, t: FbI18n["t"]): string | null {
  if (message.sendStatus === "PENDING") return t("Pending");
  if (message.sendStatus === "FAILED") return t("Failed");
  if (message.sendStatus === "UNCONFIRMED") return t("Unconfirmed");
  return null;
}

function MessageBubble({ message, fb, locale, now }: { message: ThreadMessage; fb: FbI18n; locale: string; now: number }) {
  const { t } = fb;
  const outbound = message.direction === "OUTBOUND";
  const attachment = message.attachmentType ? ATTACHMENTS[message.attachmentType] ?? ATTACHMENTS.file : null;
  const author = authorLabel(message, t);
  const status = statusLabel(message, t);
  const problem = message.sendStatus === "FAILED" || message.sendStatus === "UNCONFIRMED";
  return (
    <div className={`flex ${outbound ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
          outbound
            ? message.origin === "EXTERNAL"
              ? "border border-border bg-surface-hover text-foreground"
              : "bg-accent text-white"
            : "border border-border bg-surface text-foreground"
        } ${problem ? "ring-2 ring-error/60" : ""}`}
      >
        {attachment && (
          <p className="flex flex-wrap items-center gap-1.5">
            <span aria-hidden="true">{attachment.mark}</span>
            <span>{t(attachment.label)}</span>
            {message.attachmentUrl && message.attachmentType !== "sticker" && (
              <a
                href={message.attachmentUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={`underline ${outbound && message.origin !== "EXTERNAL" ? "text-white" : "text-accent"}`}
              >
                {t("Open")}
              </a>
            )}
          </p>
        )}
        {message.attachmentType === "audio" && (
          <p className={`mt-1 whitespace-pre-wrap break-words ${message.transcript ? "" : "text-xs opacity-80"}`}>
            {message.transcript ??
              (message.transcriptStatus === "PENDING"
                ? t("Transcribing…")
                : message.transcriptStatus === "FAILED"
                  ? t("Transcription failed")
                  : t("Not transcribed"))}
          </p>
        )}
        {message.attachmentType === "audio" && message.transcriptStatus === "FAILED" && message.error && (
          <p className="mt-0.5 break-words text-[10px] opacity-70">{message.error}</p>
        )}
        {message.photo && (
          <p className="mt-1 break-words text-xs opacity-90" dir="auto">
            {message.photo.status === "PENDING"
              ? t("Reading the photo…")
              : message.photo.status === "FAILED"
                ? t("Could not read the photo")
                : message.photo.kind === "match"
                  ? t("Recognised by the bot: {name}", { name: message.photo.names[0] ?? "" })
                  : message.photo.kind === "ambiguous"
                    ? t("Could be: {names}", { names: message.photo.names.join(" / ") })
                    : message.photo.kind === "unsure"
                      ? t("Maybe: {name}, to confirm", { name: message.photo.names[0] ?? "" })
                      : t("Not recognised")}
          </p>
        )}
        {message.photo?.status === "FAILED" && message.photo.error && (
          <p className="mt-0.5 break-words text-[10px] opacity-70">{message.photo.error}</p>
        )}
        {message.text && <p className="whitespace-pre-wrap break-words">{message.text}</p>}
        <p
          className={`mt-1 flex flex-wrap gap-x-2 text-[10px] ${
            outbound && message.origin !== "EXTERNAL" ? "text-white/75" : "text-zinc-500"
          }`}
        >
          {author && <span>{author}</span>}
          <span>{formatTime(message.sentAt, locale, now)}</span>
          {status && <span className="font-semibold">{status}</span>}
        </p>
        {problem && message.error && (
          <p className={`mt-1 text-[11px] ${outbound && message.origin !== "EXTERNAL" ? "text-white/90" : "text-error"}`}>
            {message.error}
          </p>
        )}
      </div>
    </div>
  );
}

/** A reply written by a person (inbox or Meta Business Suite), already sent. */
function isPersonReply(message: ThreadMessage): boolean {
  return (
    message.direction === "OUTBOUND" &&
    message.author === "HUMAN" &&
    Boolean(message.text?.trim()) &&
    (message.sendStatus === "SENT" || message.sendStatus === null)
  );
}

const LEARN_QUESTION_MAX = 200;
const LEARN_ANSWER_MAX = 1000;

/**
 * «Add to the knowledge base» under a person's reply: a small inline form,
 * question and answer both editable. An admin's text becomes a FAQ entry at
 * once; a member's waits for an admin (the server decides which).
 */
function LearnFromReply({ message, question, t }: { message: ThreadMessage; question: string; t: FbI18n["t"] }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [a, setA] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  function start() {
    setQ(Array.from(question).slice(0, LEARN_QUESTION_MAX).join(""));
    setA(Array.from(message.text ?? "").slice(0, LEARN_ANSWER_MAX).join(""));
    setError(null);
    setOpen(true);
  }

  async function save() {
    if (saving || !q.trim() || !a.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/knowledge/from-reply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageId: message.id, question: q, answer: a }),
      });
      const payload = await response.json().catch(() => null);
      if (response.ok && payload?.success) {
        const { mode, created } = payload.data as { mode: "entry" | "suggestion"; created: boolean };
        setDone(
          mode === "entry"
            ? created
              ? t("Added to the knowledge base.")
              : t("Already in the knowledge base.")
            : created
              ? t("Sent to an admin for review.")
              : t("Already waiting for review.")
        );
        setOpen(false);
      } else {
        setError(payload?.code === "full" ? t("The knowledge base is full.") : t("Something went wrong. Please try again."));
      }
    } catch {
      setError(t("Could not reach the server. Please try again."));
    } finally {
      setSaving(false);
    }
  }

  if (done) {
    return (
      <p role="status" className="text-end text-[11px] text-success">
        {done}
      </p>
    );
  }
  if (!open) {
    return (
      <div className="flex justify-end">
        <button
          type="button"
          onClick={start}
          className="text-[11px] text-muted underline-offset-2 hover:text-foreground hover:underline"
        >
          {t("Add to the knowledge base")}
        </button>
      </div>
    );
  }
  return (
    <div className="ms-auto w-full max-w-md space-y-2 rounded border border-border bg-surface p-3 text-xs">
      <p className="text-muted">{t("Keep this answer so the bot can use it next time. An admin approves it first if you are not one.")}</p>
      <label className="block">
        <span className="text-muted">{t("Question")}</span>
        <textarea
          value={q}
          onChange={(event) => setQ(event.target.value)}
          maxLength={LEARN_QUESTION_MAX}
          rows={2}
          dir="auto"
          className="mt-1 block w-full resize-y rounded border border-border bg-surface px-2 py-1.5 text-sm text-foreground"
        />
      </label>
      <label className="block">
        <span className="text-muted">{t("Answer")}</span>
        <textarea
          value={a}
          onChange={(event) => setA(event.target.value)}
          maxLength={LEARN_ANSWER_MAX}
          rows={4}
          dir="auto"
          className="mt-1 block w-full resize-y rounded border border-border bg-surface px-2 py-1.5 text-sm text-foreground"
        />
      </label>
      {error && (
        <p role="alert" className="text-error">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          disabled={saving}
          onClick={() => setOpen(false)}
          className="rounded border border-border px-3 py-1.5 font-medium text-foreground hover:bg-surface-hover disabled:opacity-60"
        >
          {t("Cancel")}
        </button>
        <button
          type="button"
          disabled={saving || !q.trim() || !a.trim()}
          onClick={() => void save()}
          className="rounded bg-accent px-3 py-1.5 font-medium text-white hover:bg-accent-hover disabled:opacity-60"
        >
          {saving ? t("Saving…") : t("Save")}
        </button>
      </div>
    </div>
  );
}

export default function MessengerInbox({
  initialConversationId,
  switchToWorkspaceId,
  linkForeign,
}: {
  initialConversationId: string | null;
  switchToWorkspaceId: string | null;
  linkForeign: boolean;
}) {
  const { locale } = useI18n();
  const fb = useFbI18n();
  const { t } = fb;

  const [switching, setSwitching] = useState(Boolean(switchToWorkspaceId));
  const [switchFailed, setSwitchFailed] = useState(false);

  const [filter, setFilter] = useState<Filter>("all");
  const [category, setCategory] = useState<HandoffCategory | "">("");
  const [pageId, setPageId] = useState("");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [pages, setPages] = useState<PageOption[] | null>(null);
  const [list, setList] = useState<ListData | null>(null);
  const [listError, setListError] = useState(false);

  const [activeId, setActiveId] = useState<string | null>(initialConversationId);
  const [thread, setThread] = useState<ConversationThread | null>(null);
  const [threadMissing, setThreadMissing] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [now, setNow] = useState(0);

  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [acting, setActing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);

  // An alert link for another brand: switch to it, then open the
  // conversation there with a full reload, so nothing of this brand stays.
  useEffect(() => {
    if (!switchToWorkspaceId) return;
    let cancelled = false;
    selectWorkspace(switchToWorkspaceId)
      .then((result) => {
        if (cancelled) return;
        if (result.ok) {
          const target = initialConversationId
            ? `/facebook/inbox?conversation=${encodeURIComponent(initialConversationId)}`
            : "/facebook/inbox";
          window.location.replace(target);
        } else {
          setSwitchFailed(true);
          setSwitching(false);
        }
      })
      .catch(() => {
        if (cancelled) return;
        setSwitchFailed(true);
        setSwitching(false);
      });
    return () => {
      cancelled = true;
    };
  }, [switchToWorkspaceId, initialConversationId]);

  // The clock for the reply window countdown.
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const first = window.setTimeout(tick, 0);
    const timer = window.setInterval(tick, 30_000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (switching) return;
    let cancelled = false;
    fetch("/api/facebook/pages", { cache: "no-store" })
      .then((response) => response.json())
      .then((payload) => {
        if (cancelled || !payload?.success) return;
        setPages(
          (payload.data.pages as (PageOption & { status: string })[])
            .filter((page) => page.status !== "DISCONNECTED")
            .map((page) => ({ id: page.id, name: page.name }))
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [switching]);

  useEffect(() => {
    if (switching) return;
    let cancelled = false;
    const load = () => {
      if (document.hidden) return;
      const query = new URLSearchParams({ filter, limit: String(limit) });
      if (category) query.set("category", category);
      if (pageId) query.set("page", pageId);
      fetch(`/api/facebook/conversations?${query}`, { cache: "no-store" })
        .then((response) => response.json())
        .then((payload) => {
          if (cancelled) return;
          if (payload?.success) {
            setList(payload.data);
            setListError(false);
          } else {
            setListError(true);
          }
        })
        .catch(() => {
          if (!cancelled) setListError(true);
        });
    };
    load();
    const timer = window.setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [switching, filter, category, pageId, limit, reloadKey]);

  useEffect(() => {
    if (switching || !activeId) return;
    let cancelled = false;
    const load = () => {
      if (document.hidden) return;
      fetch(`/api/facebook/conversations/${encodeURIComponent(activeId)}`, { cache: "no-store" })
        .then((response) => response.json().then((payload) => ({ status: response.status, payload })))
        .then(({ status, payload }) => {
          if (cancelled) return;
          if (payload?.success) {
            const next = payload.data as ConversationThread;
            setThread(next);
            setThreadMissing(false);
            if (next.conversation.unreadCount > 0) {
              // Open means read. Fire and forget: the next refresh shows it.
              void fetch(`/api/facebook/conversations/${encodeURIComponent(activeId)}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "read" }),
              }).catch(() => {});
              setList((current) =>
                current && {
                  ...current,
                  conversations: current.conversations.map((item) =>
                    item.id === activeId ? { ...item, unreadCount: 0 } : item
                  ),
                }
              );
            }
          } else if (status === 404) {
            setThreadMissing(true);
          }
        })
        .catch(() => {});
    };
    load();
    const timer = window.setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [switching, activeId, reloadKey]);

  // Keep the thread pinned to its latest message.
  const messageCount = thread?.messages.length ?? 0;
  useEffect(() => {
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [activeId, messageCount]);

  function open(id: string) {
    if (id === activeId) return;
    setActiveId(id);
    setThread(null);
    setThreadMissing(false);
    setDraft("");
    setSendError(null);
    setActionError(null);
  }

  async function act(action: "take_over" | "return_to_bot") {
    if (!activeId || acting) return;
    if (action === "return_to_bot" && !confirm(t("Return this conversation to the bot? It will answer the next message."))) {
      return;
    }
    setActing(true);
    setActionError(null);
    try {
      const response = await fetch(`/api/facebook/conversations/${encodeURIComponent(activeId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!response.ok) setActionError(t("Something went wrong. Please try again."));
    } catch {
      setActionError(t("Could not reach the server. Please try again."));
    } finally {
      setActing(false);
      setReloadKey((key) => key + 1);
    }
  }

  async function send() {
    const text = draft.trim();
    if (!text || !activeId || sending) return;
    setSending(true);
    setSendError(null);
    try {
      const response = await fetch(`/api/facebook/conversations/${encodeURIComponent(activeId)}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const payload = await response.json().catch(() => null);
      if (response.ok && payload?.success) {
        setDraft("");
      } else {
        const code = payload?.code;
        if (isHumanReplyError(code)) {
          const message = t(HUMAN_REPLY_ERRORS[code]);
          setSendError(code === "failed" && payload?.detail ? `${message} ${payload.detail}` : message);
          // It may have been delivered: keeping the text would invite a
          // second copy.
          if (code === "unconfirmed") setDraft("");
        } else {
          setSendError(t("Something went wrong. Please try again."));
        }
      }
    } catch {
      setSendError(t("Could not reach the server. Please try again."));
    } finally {
      setSending(false);
      setReloadKey((key) => key + 1);
    }
  }

  if (switching) {
    return (
      <p role="status" className="py-10 text-center text-sm text-muted">
        {t("Opening the conversation…")}
      </p>
    );
  }

  const conversation = thread && thread.conversation.id === activeId ? thread.conversation : null;
  const replyBlocked: string | null = conversation
    ? conversation.pageStatus !== "ACTIVE"
      ? t(HUMAN_REPLY_ERRORS.page_unavailable)
      : !conversation.reply.canReply
        ? t(conversation.reply.reason === "no_inbound" ? HUMAN_REPLY_ERRORS.no_inbound : HUMAN_REPLY_ERRORS.window_closed)
        : null
    : null;

  type TimelineItem = { at: string; key: string; message?: ThreadMessage; event?: ThreadEvent };
  const timeline: TimelineItem[] = conversation
    ? [
        ...thread!.messages.map((message) => ({ at: message.sentAt, key: `m-${message.id}`, message })),
        ...thread!.events.map((event) => ({ at: event.createdAt, key: `e-${event.id}`, event })),
      ].sort((a, b) => a.at.localeCompare(b.at))
    : [];

  // For each person's reply, the customer's last message before it.
  const questionFor = new Map<string, string>();
  let lastCustomer = "";
  for (const item of timeline) {
    const message = item.message;
    if (!message) continue;
    if (message.direction === "INBOUND") {
      const spoken = (message.text ?? message.transcript ?? "").trim();
      if (spoken) lastCustomer = spoken;
    } else if (isPersonReply(message)) {
      questionFor.set(message.id, lastCustomer);
    }
  }

  const counts = list?.counts;

  return (
    <div className="space-y-3">
      {(linkForeign || switchFailed) && (
        <p role="alert" className="rounded border border-error/30 bg-error/5 px-3 py-2 text-sm text-error">
          {linkForeign ? t("This link is for a brand you are not a member of.") : t("Could not switch brand. Please try again.")}
        </p>
      )}

      <div className="grid h-[calc(100dvh-10rem)] grid-cols-1 overflow-hidden rounded border border-border md:grid-cols-[320px_1fr] lg:grid-cols-[380px_1fr]">
        {/* The list: full width on mobile until a conversation is open. */}
        <div className={`min-h-0 flex-col border-border md:flex md:border-e ${activeId ? "hidden" : "flex"}`}>
          <div className="shrink-0 space-y-2 border-b border-border p-3">
            <div className="flex flex-wrap gap-1" role="tablist" aria-label={t("Conversations")}>
              {FILTERS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="tab"
                  aria-selected={filter === option.value}
                  onClick={() => {
                    setFilter(option.value);
                    setLimit(PAGE_SIZE);
                  }}
                  className={`rounded px-2 py-1 text-xs font-medium ${
                    filter === option.value
                      ? "bg-surface-hover text-foreground"
                      : "text-muted hover:bg-surface-hover hover:text-foreground"
                  }`}
                >
                  {t(option.label)}
                  {option.value === "needs_human" && counts && counts.needsHuman > 0 && (
                    <span className="ms-1 rounded-full bg-error px-1.5 text-[10px] text-white">{counts.needsHuman}</span>
                  )}
                </button>
              ))}
            </div>
            <div className="flex gap-2">
              <label className="min-w-0 flex-1">
                <span className="sr-only">{t("Category")}</span>
                <select
                  value={category}
                  onChange={(event) => {
                    setCategory(event.target.value as HandoffCategory | "");
                    setLimit(PAGE_SIZE);
                  }}
                  className="min-h-8 w-full rounded border border-border bg-surface px-2 text-xs text-foreground"
                >
                  <option value="">{t("All categories")}</option>
                  {HANDOFF_CATEGORIES.map((value) => (
                    <option key={value} value={value}>
                      {fb.category(value)} ({counts?.byCategory[value] ?? 0})
                    </option>
                  ))}
                </select>
              </label>
              {pages && pages.length > 1 && (
                <label className="min-w-0 flex-1">
                  <span className="sr-only">{t("Facebook Page")}</span>
                  <select
                    value={pageId}
                    onChange={(event) => {
                      setPageId(event.target.value);
                      setLimit(PAGE_SIZE);
                    }}
                    className="min-h-8 w-full rounded border border-border bg-surface px-2 text-xs text-foreground"
                  >
                    <option value="">{t("All Pages")}</option>
                    {pages.map((page) => (
                      <option key={page.id} value={page.id}>
                        {page.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {!list && !listError ? (
              <p className="px-4 py-6 text-sm text-muted">{t("Loading…")}</p>
            ) : listError && !list ? (
              <p className="px-4 py-6 text-sm text-error">{t("Could not load the conversations.")}</p>
            ) : pages && pages.length === 0 && list!.conversations.length === 0 ? (
              <div className="space-y-2 px-4 py-6 text-sm text-muted">
                <p>{t("Connect a Facebook Page to receive its Messenger conversations here.")}</p>
                <Link href="/facebook/pages" className="font-medium text-accent hover:underline">
                  {t("Connect a Page")}
                </Link>
              </div>
            ) : list!.conversations.length === 0 ? (
              <p className="px-4 py-6 text-sm text-muted">{t("No conversation here yet.")}</p>
            ) : (
              <>
                {list!.conversations.map((item) => {
                  const isActive = item.id === activeId;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => open(item.id)}
                      aria-current={isActive ? "true" : undefined}
                      className={`block w-full border-b border-border px-4 py-3 text-start ${
                        isActive ? "bg-surface-hover" : "hover:bg-surface-hover"
                      }`}
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <span className={`truncate text-sm text-foreground ${item.unreadCount > 0 ? "font-semibold" : "font-medium"}`}>
                          {item.userName || t("Customer")}
                        </span>
                        <span className="shrink-0 text-[11px] text-zinc-500">
                          {formatTime(item.lastMessageAt, locale, now)}
                        </span>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-1">
                        {item.handoffCategory && (
                          <CategoryBadge category={item.handoffCategory} label={fb.category(item.handoffCategory)} />
                        )}
                        <StateBadge state={item.customerState} t={t} />
                        {item.needsHuman && (
                          <span className="inline-flex rounded-full bg-error px-2 py-0.5 text-[11px] font-medium text-white">
                            {t("Need a person")}
                          </span>
                        )}
                        <ModeBadge mode={item.mode} t={t} />
                        {pages && pages.length > 1 && (
                          <span className="truncate text-[11px] text-zinc-500">{item.page.name}</span>
                        )}
                        {item.unreadCount > 0 && (
                          <span
                            className="ms-auto rounded-full bg-accent px-1.5 text-[10px] font-semibold text-white"
                            aria-label={t("Unread messages: {count}", { count: item.unreadCount })}
                          >
                            {item.unreadCount}
                          </span>
                        )}
                      </div>
                      {item.lastMessageText && (
                        <p className="mt-1 truncate text-xs text-muted">{item.lastMessageText}</p>
                      )}
                    </button>
                  );
                })}
                {list!.hasMore && (
                  <button
                    type="button"
                    onClick={() => setLimit((current) => current + PAGE_SIZE)}
                    className="block w-full px-4 py-3 text-center text-sm font-medium text-accent hover:bg-surface-hover"
                  >
                    {t("Load more")}
                  </button>
                )}
              </>
            )}
          </div>
        </div>

        {/* The conversation: beside the list on wide screens, alone on mobile. */}
        <div className={`min-h-0 flex-col ${activeId ? "flex" : "hidden md:flex"}`}>
          {!activeId ? (
            <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted">
              {t("Select a conversation to read and reply.")}
            </div>
          ) : threadMissing ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-sm text-muted">
              <p>{t("Conversation not found.")}</p>
              <button type="button" onClick={() => setActiveId(null)} className="text-accent hover:underline">
                {t("Back")}
              </button>
            </div>
          ) : !conversation ? (
            <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted">{t("Loading…")}</div>
          ) : (
            <>
              <div className="shrink-0 space-y-2 border-b border-border px-4 py-3">
                <div className="flex items-start gap-2">
                  <button
                    type="button"
                    onClick={() => setActiveId(null)}
                    className="-ms-1 shrink-0 rounded px-2 py-1 text-sm text-muted hover:text-foreground md:hidden"
                  >
                    {t("Back")}
                  </button>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-foreground">
                      {conversation.userName || t("Customer")}
                    </p>
                    <p className="truncate text-xs text-muted">
                      {conversation.page.name}
                      {conversation.sourceCampaign &&
                        ` · ${t("From the campaign {name}", { name: conversation.sourceCampaign.name })}`}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap justify-end gap-2">
                    {(conversation.mode === "BOT" || conversation.needsHuman) && (
                      <button
                        type="button"
                        disabled={acting}
                        onClick={() => void act("take_over")}
                        className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-60"
                      >
                        {t("Take over")}
                      </button>
                    )}
                    {conversation.mode === "HUMAN" && (
                      <button
                        type="button"
                        disabled={acting}
                        onClick={() => void act("return_to_bot")}
                        className="rounded border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-surface-hover disabled:opacity-60"
                      >
                        {t("Return to bot")}
                      </button>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-1.5 text-xs">
                  {conversation.handoffCategory && (
                    <CategoryBadge
                      category={conversation.handoffCategory}
                      label={fb.category(conversation.handoffCategory)}
                    />
                  )}
                  <StateBadge state={conversation.customerState} t={t} />
                  {conversation.needsHuman && (
                    <span className="inline-flex rounded-full bg-error px-2 py-0.5 text-[11px] font-medium text-white">
                      {t("Need a person")}
                    </span>
                  )}
                  <ModeBadge mode={conversation.mode} t={t} />
                  {!conversation.pageBotEnabled && (
                    <span className="text-[11px] text-zinc-500">{t("The bot is off on this Page")}</span>
                  )}
                  <span className={`ms-auto text-[11px] ${conversation.reply.canReply ? "text-muted" : "text-warning"}`}>
                    {windowLabel(conversation, now, t)}
                  </span>
                </div>
                {conversation.handoffReason && (
                  <p className="rounded bg-warning/10 px-2 py-1 text-xs text-foreground">
                    {t("Reason: {reason}", { reason: translateReason(t, conversation.handoffReason) })}
                  </p>
                )}
                {conversation.order && conversation.order.length > 0 && (
                  <div className="rounded border border-success/30 bg-success/5 px-2 py-1.5 text-xs">
                    <p className="font-medium text-foreground">{t("Order details collected by the bot")}</p>
                    <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
                      {conversation.order.map((line) => (
                        <div key={line.field} className="contents">
                          <dt className="text-muted">{t(ORDER_LINE_LABELS[line.field])}</dt>
                          <dd className="min-w-0 break-words text-foreground" dir="auto">
                            {line.value}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                )}
                {actionError && (
                  <p role="alert" className="text-xs text-error">
                    {actionError}
                  </p>
                )}
              </div>

              <div ref={scrollRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto p-4">
                {timeline.length === 0 ? (
                  <p className="text-sm text-muted">{t("No conversation here yet.")}</p>
                ) : (
                  timeline.map((item) =>
                    item.message ? (
                      <div key={item.key} className="space-y-1">
                        <MessageBubble message={item.message} fb={fb} locale={locale} now={now} />
                        {questionFor.has(item.message.id) && (
                          <LearnFromReply message={item.message} question={questionFor.get(item.message.id) ?? ""} t={t} />
                        )}
                      </div>
                    ) : (
                      <p key={item.key} className="py-1 text-center text-[11px] text-zinc-500">
                        {eventText(item.event!, fb)} · {formatTime(item.event!.createdAt, locale, now)}
                      </p>
                    )
                  )
                )}
              </div>

              <div className="shrink-0 border-t border-border p-3">
                {sendError && (
                  <p role="alert" className="mb-2 text-xs text-error">
                    {sendError}
                  </p>
                )}
                {replyBlocked ? (
                  <p className="text-xs text-muted">{replyBlocked}</p>
                ) : (
                  <>
                    <div className="flex items-end gap-2">
                      <label className="min-w-0 flex-1">
                        <span className="sr-only">{t("Write a reply…")}</span>
                        <textarea
                          value={draft}
                          onChange={(event) => setDraft(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                              event.preventDefault();
                              void send();
                            }
                          }}
                          maxLength={MAX_REPLY_LENGTH}
                          rows={2}
                          dir="auto"
                          placeholder={t("Write a reply…")}
                          className="block max-h-40 min-h-10 w-full resize-y rounded border border-border bg-surface px-3 py-2 text-sm text-foreground"
                        />
                      </label>
                      <button
                        type="button"
                        disabled={sending || !draft.trim()}
                        onClick={() => void send()}
                        className="shrink-0 rounded bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-60"
                      >
                        {sending ? t("Sending…") : t("Send")}
                      </button>
                    </div>
                    {conversation.mode === "BOT" && (
                      <p className="mt-1.5 text-[11px] text-zinc-500">
                        {t("Sending a reply takes the conversation from the bot.")}
                      </p>
                    )}
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
