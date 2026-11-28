"use client";

/**
 * Handoff alerts of the active brand: its Telegram bot, who receives the
 * alerts, which category goes to whom, a test button and the recent log.
 * Owners and admins change it; members see it.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import type { HandoffCategory } from "@/app/generated/prisma/client";
import type { FbI18n } from "@/lib/facebook/i18n";
import { useFbI18n } from "@/lib/facebook/i18n/client";
import { HANDOFF_CATEGORIES, HANDOFF_CATEGORY_BADGE } from "@/lib/handoff/categories";
import { useI18n } from "@/lib/i18n/provider";

type Recipient = {
  id: string;
  channel: "TELEGRAM" | "EMAIL";
  label: string;
  telegramChatId: string | null;
  email: string | null;
  isDefault: boolean;
  isActive: boolean;
};

type Settings = {
  role: string;
  telegram: { connected: boolean; username: string | null };
  email: { configured: boolean; from: string | null };
};

type Delivery = {
  id: string;
  channel: "TELEGRAM" | "EMAIL";
  category: HandoffCategory | null;
  isTest: boolean;
  status: "PENDING" | "SENT" | "FAILED";
  error: string | null;
  conversationId: string | null;
  recipient: string | null;
  createdAt: string;
};

type Chat = { id: string; title: string | null; type: string; username: string | null };
type TestResult = { recipientId: string; label: string; ok: boolean; error: string | null; errorKind?: string | null };

/** The usual reasons a test fails, in words the brand understands. */
function explainFailure(result: TestResult, t: FbI18n["t"]): string {
  switch (result.errorKind) {
    case "chat_not_found":
      return t("Telegram cannot find this chat: send /start to the bot from it, or add the bot to the group.");
    case "forbidden":
      return t("The bot cannot write there: it was blocked or removed from the group.");
    case "invalid_token":
      return t("The Telegram bot token is not valid anymore: save it again.");
    case "not_configured":
      return t("Email alerts need RESEND_API_KEY (or EMAIL_SERVER) and EMAIL_FROM on the server.");
    case "invalid_recipient":
      return t("The email address was refused.");
    default:
      return result.error ?? t("Something went wrong. Please try again.");
  }
}

/** What kind of chat it is, so a person who named themselves "Owner" is not mistaken for the group. */
function chatTypeLabel(type: string, t: FbI18n["t"]): string {
  switch (type) {
    case "private":
      return t("Private chat");
    case "group":
    case "supergroup":
      return t("Group");
    case "channel":
      return t("Telegram channel");
    default:
      return type;
  }
}

const card = "space-y-3 rounded border border-border p-4";
const input = "block w-full rounded border border-border bg-surface px-3 py-2 text-sm text-foreground disabled:opacity-60";
const button =
  "rounded border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-surface-hover disabled:opacity-60";
const primary = "rounded bg-accent px-4 py-2 text-sm font-medium text-accent-foreground hover:bg-accent-hover disabled:opacity-60";

async function send(url: string, method: string, body?: unknown) {
  const response = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json().catch(() => null);
  return { ok: response.ok && payload?.success !== false, payload };
}

function TelegramCard({ settings, canEdit, onChange, t }: { settings: Settings; canEdit: boolean; onChange: () => void; t: FbI18n["t"] }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const { ok, payload } = await send("/api/alerts/settings", "PUT", { telegramBotToken: token.trim() });
      if (ok) {
        setToken("");
        onChange();
      } else {
        setError(
          payload?.code === "invalid_format"
            ? t("That does not look like a Telegram bot token.")
            : payload?.code === "invalid_token"
              ? t("Telegram refused this token. Copy it again from @BotFather.")
              : t("Could not reach Telegram. Please try again.")
        );
      }
    } catch {
      setError(t("Could not reach the server. Please try again."));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirm(t("Remove the Telegram bot? Telegram recipients will stop receiving alerts."))) return;
    setBusy(true);
    await send("/api/alerts/settings", "DELETE").catch(() => null);
    setBusy(false);
    onChange();
  }

  return (
    <section className={card}>
      <h2 className="text-sm font-semibold text-foreground">{t("Telegram bot")}</h2>
      {settings.telegram.connected ? (
        <p className="text-sm text-success">
          {settings.telegram.username
            ? t("Connected: @{username}", { username: settings.telegram.username })
            : t("Connected")}
        </p>
      ) : (
        <p className="text-sm text-muted">{t("Create a bot with @BotFather (/newbot), then paste its token here.")}</p>
      )}
      {canEdit && (
        <div className="flex flex-wrap items-end gap-2">
          <label className="min-w-0 flex-1 space-y-1 text-sm">
            <span className="text-muted">{t("Bot token")}</span>
            <input
              type="password"
              autoComplete="off"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder="123456789:AA…"
              className={input}
            />
          </label>
          <button type="button" disabled={busy || !token.trim()} onClick={() => void save()} className={primary}>
            {busy ? t("Checking…") : t("Save")}
          </button>
          {settings.telegram.connected && (
            <button type="button" disabled={busy} onClick={() => void remove()} className={button}>
              {t("Remove the bot")}
            </button>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-error">
          {error}
        </p>
      )}
    </section>
  );
}

function AddRecipient({ telegramConnected, onAdded, t }: { telegramConnected: boolean; onAdded: () => void; t: FbI18n["t"] }) {
  const [channel, setChannel] = useState<"TELEGRAM" | "EMAIL">(telegramConnected ? "TELEGRAM" : "EMAIL");
  const [label, setLabel] = useState("");
  const [chatId, setChatId] = useState("");
  const [email, setEmail] = useState("");
  const [isDefault, setIsDefault] = useState(false);
  const [chats, setChats] = useState<Chat[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function findChats() {
    setBusy(true);
    setError(null);
    try {
      const { ok, payload } = await send("/api/alerts/telegram/chats", "GET");
      if (ok) setChats(payload.data.chats);
      else if (payload?.code === "webhook_active") {
        setError(t("This bot has a webhook at another service, so its recent chats cannot be read here. Enter the chat ID by hand."));
      } else setError(t("Could not reach Telegram. Please try again."));
    } catch {
      setError(t("Could not reach the server. Please try again."));
    } finally {
      setBusy(false);
    }
  }

  async function add() {
    if (!label.trim()) return setError(t("Give the recipient a name."));
    if (channel === "TELEGRAM" && !/^(-?\d{1,20}|@[A-Za-z0-9_]{5,32})$/.test(chatId.trim())) {
      return setError(t("Enter a Telegram chat ID."));
    }
    if (channel === "EMAIL" && !/^[^\s@<>,]+@[^\s@<>,]+\.[^\s@<>,]+$/.test(email.trim())) {
      return setError(t("Enter a valid email address."));
    }
    setBusy(true);
    setError(null);
    try {
      const { ok } = await send("/api/alerts/recipients", "POST", {
        channel,
        label: label.trim(),
        isDefault,
        ...(channel === "TELEGRAM" ? { telegramChatId: chatId.trim() } : { email: email.trim() }),
      });
      if (ok) {
        setLabel("");
        setChatId("");
        setEmail("");
        setIsDefault(false);
        setChats(null);
        onAdded();
      } else {
        setError(t("Something went wrong. Please try again."));
      }
    } catch {
      setError(t("Could not reach the server. Please try again."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 rounded border border-dashed border-border p-3">
      <p className="text-sm font-medium text-foreground">{t("Add a recipient")}</p>
      <div className="grid gap-3 sm:grid-cols-[160px_1fr]">
        <label className="space-y-1 text-sm">
          <span className="text-muted">{t("Channel")}</span>
          <select value={channel} onChange={(event) => setChannel(event.target.value as "TELEGRAM" | "EMAIL")} className={input}>
            <option value="TELEGRAM">{t("Telegram")}</option>
            <option value="EMAIL">{t("Email")}</option>
          </select>
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-muted">{t("Name")}</span>
          <input value={label} maxLength={80} dir="auto" onChange={(event) => setLabel(event.target.value)} className={input} />
        </label>
      </div>
      {channel === "TELEGRAM" ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-end gap-2">
            <label className="min-w-0 flex-1 space-y-1 text-sm">
              <span className="text-muted">{t("Chat ID")}</span>
              <input value={chatId} onChange={(event) => setChatId(event.target.value)} placeholder="-1001234567890" className={input} />
            </label>
            <button type="button" disabled={busy || !telegramConnected} onClick={() => void findChats()} className={button}>
              {t("Find recent chats")}
            </button>
          </div>
          {!telegramConnected && <p className="text-xs text-muted">{t("Save the Telegram bot first.")}</p>}
          {chats &&
            (chats.length === 0 ? (
              <p className="text-xs text-muted">
                {t("No chat found yet.")} {t("Send /start to your bot, or add it to a group and write a message there, then look again.")}
              </p>
            ) : (
              <ul className="divide-y divide-border rounded border border-border text-sm">
                {chats.map((chat) => (
                  <li key={chat.id} className="flex items-center justify-between gap-2 px-3 py-2">
                    <span className="min-w-0">
                      {/* The title is whatever the sender chose: the type, @username and id say who it is. */}
                      <span className="block truncate" dir="auto">
                        {chat.title ?? t("Unnamed chat")}
                      </span>
                      <span className="block truncate text-xs text-muted" dir="auto">
                        {[chatTypeLabel(chat.type, t), chat.username ? `@${chat.username}` : null, chat.id]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setChatId(chat.id);
                        if (!label.trim()) setLabel(chat.title ?? chat.username ?? "");
                      }}
                      className={button}
                    >
                      {t("Choose")}
                    </button>
                  </li>
                ))}
              </ul>
            ))}
        </div>
      ) : (
        <label className="block space-y-1 text-sm">
          <span className="text-muted">{t("Email address")}</span>
          <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} className={input} />
        </label>
      )}
      <label className="flex items-center gap-2 text-sm text-foreground">
        <input type="checkbox" checked={isDefault} onChange={(event) => setIsDefault(event.target.checked)} />
        {t("Default (receives the categories nobody is assigned to)")}
      </label>
      {error && (
        <p role="alert" className="text-sm text-error">
          {error}
        </p>
      )}
      <button type="button" disabled={busy} onClick={() => void add()} className={primary}>
        {t("Add")}
      </button>
    </div>
  );
}

export default function AlertsPage() {
  const fb = useFbI18n();
  const { t } = fb;
  const { locale } = useI18n();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [recipients, setRecipients] = useState<Recipient[] | null>(null);
  const [routes, setRoutes] = useState<Record<HandoffCategory, string[]> | null>(null);
  const [deliveries, setDeliveries] = useState<Delivery[] | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [routingMessage, setRoutingMessage] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<TestResult[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all(
      ["/api/alerts/settings", "/api/alerts/recipients", "/api/alerts/routes", "/api/alerts/deliveries"].map((url) =>
        fetch(url, { cache: "no-store" }).then((response) => response.json())
      )
    )
      .then(([settingsPayload, recipientsPayload, routesPayload, deliveriesPayload]) => {
        if (cancelled) return;
        if (![settingsPayload, recipientsPayload, routesPayload, deliveriesPayload].every((payload) => payload?.success)) {
          setError(t("Could not load the alerts."));
          return;
        }
        setSettings(settingsPayload.data);
        setRecipients(recipientsPayload.data.recipients);
        setRoutes(routesPayload.data.routes);
        setDeliveries(deliveriesPayload.data.deliveries);
      })
      .catch(() => {
        if (!cancelled) setError(t("Could not load the alerts."));
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey, t]);

  const reload = () => setReloadKey((key) => key + 1);
  const canEdit = settings?.role === "OWNER" || settings?.role === "ADMIN";

  async function patchRecipient(recipient: Recipient, patch: Partial<Recipient>) {
    await send(`/api/alerts/recipients/${recipient.id}`, "PATCH", patch).catch(() => null);
    reload();
  }

  async function removeRecipient(recipient: Recipient) {
    if (!confirm(t("Delete the recipient {name}?", { name: recipient.label }))) return;
    await send(`/api/alerts/recipients/${recipient.id}`, "DELETE").catch(() => null);
    reload();
  }

  async function saveRouting() {
    if (!routes) return;
    setBusy(true);
    setRoutingMessage(null);
    const { ok } = await send("/api/alerts/routes", "PUT", { routes }).catch(() => ({ ok: false, payload: null }));
    setRoutingMessage(ok ? t("Saved.") : t("Something went wrong. Please try again."));
    setBusy(false);
  }

  async function test(recipientId: string | null) {
    setBusy(true);
    setTestResults(null);
    try {
      const { ok, payload } = await send("/api/alerts/test", "POST", recipientId ? { recipientId } : {});
      const failure =
        payload?.code === "rate_limited"
          ? t("Too many test alerts this hour. Try again later.")
          : t("Something went wrong. Please try again.");
      setTestResults(ok ? payload.data.results : [{ recipientId: "-", label: "-", ok: false, error: failure }]);
    } catch {
      setTestResults([{ recipientId: "-", label: "-", ok: false, error: t("Could not reach the server. Please try again.") }]);
    } finally {
      setBusy(false);
      reload();
    }
  }

  if (error) {
    return (
      <p role="alert" className="text-sm text-error">
        {error}
      </p>
    );
  }
  if (!settings || !recipients || !routes || !deliveries) return <p className="text-sm text-muted">{t("Loading…")}</p>;

  const hasDefault = recipients.some((recipient) => recipient.isDefault && recipient.isActive);

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <p className="text-sm text-muted">
        {t("Every time the bot hands a conversation to a person, the right people get a message with the customer, the reason and a link to the conversation.")}
      </p>
      {!canEdit && <p className="text-sm text-muted">{t("Only owners and admins can change the alerts.")}</p>}

      <div className="grid gap-5 lg:grid-cols-2">
        <TelegramCard settings={settings} canEdit={canEdit} onChange={reload} t={t} />
        <section className={card}>
          <h2 className="text-sm font-semibold text-foreground">{t("Email")}</h2>
          {settings.email.configured ? (
            <p className="text-sm text-success">{t("Alerts are emailed from {from}.", { from: settings.email.from ?? "" })}</p>
          ) : (
            <p className="text-sm text-warning">{t("Email alerts need RESEND_API_KEY (or EMAIL_SERVER) and EMAIL_FROM on the server.")}</p>
          )}
        </section>
      </div>

      <section className={card}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-foreground">{t("Recipients")}</h2>
          {canEdit && recipients.length > 0 && (
            <button type="button" disabled={busy} onClick={() => void test(null)} className={button}>
              {t("Send a test alert to every active recipient")}
            </button>
          )}
        </div>
        {testResults && (
          <ul className="space-y-1 text-sm" role="status">
            {testResults.map((result) => (
              <li key={result.recipientId} className={result.ok ? "text-success" : "text-error"}>
                {result.ok
                  ? t("{name}: test alert sent.", { name: result.label })
                  : t("{name}: {error}", { name: result.label, error: explainFailure(result, t) })}
              </li>
            ))}
          </ul>
        )}
        {recipients.length === 0 ? (
          <p className="text-sm text-muted">{t("No recipient yet.")}</p>
        ) : (
          <ul className="divide-y divide-border">
            {recipients.map((recipient) => (
              <li key={recipient.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground" dir="auto">
                    {recipient.label}
                    {recipient.isDefault && (
                      <span className="ms-2 rounded-full bg-accent-soft px-2 py-0.5 text-[11px] text-foreground">{t("Default")}</span>
                    )}
                    {!recipient.isActive && (
                      <span className="ms-2 rounded-full bg-surface-hover px-2 py-0.5 text-[11px] text-muted">{t("Inactive")}</span>
                    )}
                  </p>
                  <p className="truncate text-xs text-muted">
                    {recipient.channel === "TELEGRAM" ? `${t("Telegram")} · ${recipient.telegramChatId}` : `${t("Email")} · ${recipient.email}`}
                  </p>
                </div>
                {canEdit && (
                  <div className="flex flex-wrap gap-2">
                    <button type="button" disabled={busy || !recipient.isActive} onClick={() => void test(recipient.id)} className={button}>
                      {t("Send a test")}
                    </button>
                    <button type="button" onClick={() => void patchRecipient(recipient, { isDefault: !recipient.isDefault })} className={button}>
                      {recipient.isDefault ? t("Not default") : t("Set as default")}
                    </button>
                    <button type="button" onClick={() => void patchRecipient(recipient, { isActive: !recipient.isActive })} className={button}>
                      {recipient.isActive ? t("Deactivate") : t("Activate")}
                    </button>
                    <button
                      type="button"
                      onClick={() => void removeRecipient(recipient)}
                      className="rounded border border-error/40 px-3 py-1.5 text-xs text-error hover:bg-error/10"
                    >
                      {t("Delete")}
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {canEdit && <AddRecipient telegramConnected={settings.telegram.connected} onAdded={reload} t={t} />}
      </section>

      <section className={card}>
        <h2 className="text-sm font-semibold text-foreground">{t("Routing")}</h2>
        <p className="text-sm text-muted">
          {t("Choose who receives each category. A category with nobody goes to the default recipients.")}
        </p>
        {!hasDefault && (
          <p role="alert" className="rounded border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-foreground">
            {t("No default recipient: alerts of categories nobody is assigned to are not sent.")}
          </p>
        )}
        {recipients.length === 0 ? (
          <p className="text-sm text-muted">{t("No recipient yet.")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[480px] text-sm">
              <thead>
                <tr>
                  <th className="px-2 py-2 text-start font-medium text-muted">{t("Category")}</th>
                  {recipients.map((recipient) => (
                    <th key={recipient.id} className="px-2 py-2 text-center font-medium text-muted" dir="auto">
                      {recipient.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {HANDOFF_CATEGORIES.map((category) => (
                  <tr key={category} className="border-t border-border">
                    <td className="px-2 py-2">
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${HANDOFF_CATEGORY_BADGE[category]}`}>
                        {fb.category(category)}
                      </span>
                    </td>
                    {recipients.map((recipient) => (
                      <td key={recipient.id} className="px-2 py-2 text-center">
                        <input
                          type="checkbox"
                          aria-label={`${fb.category(category)} → ${recipient.label}`}
                          disabled={!canEdit}
                          checked={routes[category]?.includes(recipient.id) ?? false}
                          onChange={(event) =>
                            setRoutes((current) => {
                              if (!current) return current;
                              const ids = new Set(current[category] ?? []);
                              if (event.target.checked) ids.add(recipient.id);
                              else ids.delete(recipient.id);
                              return { ...current, [category]: [...ids] };
                            })
                          }
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {canEdit && recipients.length > 0 && (
          <div className="flex items-center gap-3">
            <button type="button" disabled={busy} onClick={() => void saveRouting()} className={primary}>
              {t("Save routing")}
            </button>
            {routingMessage && <span className="text-sm text-muted">{routingMessage}</span>}
          </div>
        )}
      </section>

      <section className={card}>
        <h2 className="text-sm font-semibold text-foreground">{t("Recent alerts")}</h2>
        {deliveries.length === 0 ? (
          <p className="text-sm text-muted">{t("No alert sent yet.")}</p>
        ) : (
          <ul className="divide-y divide-border text-sm">
            {deliveries.map((delivery) => (
              <li key={delivery.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div className="min-w-0 space-y-0.5">
                  <p className="flex flex-wrap items-center gap-2">
                    {delivery.isTest ? (
                      <span className="rounded-full bg-surface-hover px-2 py-0.5 text-[11px]">{t("Test")}</span>
                    ) : delivery.category ? (
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${HANDOFF_CATEGORY_BADGE[delivery.category]}`}>
                        {fb.category(delivery.category)}
                      </span>
                    ) : null}
                    <span dir="auto">{delivery.recipient ?? "—"}</span>
                    <span className="text-xs text-zinc-500">
                      {delivery.channel === "TELEGRAM" ? t("Telegram") : t("Email")} ·{" "}
                      {new Date(delivery.createdAt).toLocaleString(locale, { dateStyle: "short", timeStyle: "short" })}
                    </span>
                  </p>
                  {delivery.error && <p className="break-words text-xs text-error">{delivery.error}</p>}
                </div>
                <div className="flex items-center gap-3">
                  <span
                    className={`text-xs font-medium ${
                      delivery.status === "SENT" ? "text-success" : delivery.status === "FAILED" ? "text-error" : "text-muted"
                    }`}
                  >
                    {delivery.status === "SENT" ? t("Sent") : delivery.status === "FAILED" ? t("Failed") : t("Pending")}
                  </span>
                  {delivery.conversationId && (
                    <Link href={`/facebook/inbox?conversation=${delivery.conversationId}`} className="text-xs text-foreground underline underline-offset-2">
                      {t("Open the conversation")}
                    </Link>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
