"use client";

/**
 * The brand's bot: its settings, its knowledge base (one tab per kind of
 * entry) and a box to try it. Owners and admins edit; members read.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import BotTester from "@/components/facebook/bot-tester";
import type { FbI18n, FbStaticKey } from "@/lib/facebook/i18n";
import { useFbI18n } from "@/lib/facebook/i18n/client";

type Kind = "PRODUCT" | "DELIVERY" | "FAQ" | "RULE" | "INFO";
type Tab = "settings" | Kind | "test";

type Entry = {
  id: string;
  kind: Kind;
  title: string;
  content: string;
  price: string | null;
  isActive: boolean;
};

type Settings = {
  enabled: boolean;
  businessName: string | null;
  instructions: string | null;
  handoffMessage: string;
};

type SettingsData = {
  role: string;
  settings: Settings;
  ai: { configured: boolean; model: string };
  pages: { id: string; name: string; status: string; botEnabled: boolean }[];
};

type Fields = {
  tab: FbStaticKey;
  help: FbStaticKey;
  title: FbStaticKey;
  price?: FbStaticKey;
  content: FbStaticKey;
  contentRequired?: boolean;
  active: FbStaticKey;
};

const KINDS: Kind[] = ["PRODUCT", "DELIVERY", "FAQ", "RULE", "INFO"];

const FIELDS: Record<Kind, Fields> = {
  PRODUCT: {
    tab: "Products",
    help: "The bot quotes prices exactly as written here. An unavailable product stays known, so the bot can say it is out of stock.",
    title: "Product name",
    price: "Price",
    content: "Description (sizes, colours, details)",
    active: "Available",
  },
  DELIVERY: {
    tab: "Delivery",
    help: "One entry per wilaya or area, with its fee and delivery time.",
    title: "Wilaya or area",
    price: "Delivery fee",
    content: "Delivery time and notes",
    active: "Used by the bot",
  },
  FAQ: {
    tab: "Questions",
    help: "Questions customers often ask, with the exact answer.",
    title: "Question",
    content: "Answer",
    contentRequired: true,
    active: "Used by the bot",
  },
  RULE: {
    tab: "Rules",
    help: "Rules the bot must follow, like «No exchange after 3 days».",
    title: "Rule",
    content: "Details (optional)",
    active: "Used by the bot",
  },
  INFO: {
    tab: "Information",
    help: "Address, opening hours, payment methods, phone number…",
    title: "Label (address, opening hours, payment…)",
    content: "Value",
    contentRequired: true,
    active: "Used by the bot",
  },
};

const inputClass =
  "block w-full rounded border border-border bg-surface px-3 py-2 text-sm text-foreground disabled:opacity-60";

type Draft = { title: string; content: string; price: string; isActive: boolean };
const EMPTY_DRAFT: Draft = { title: "", content: "", price: "", isActive: true };

function EntryForm({
  kind,
  initial,
  busy,
  submitLabel,
  onSubmit,
  onCancel,
  t,
}: {
  kind: Kind;
  initial: Draft;
  busy: boolean;
  submitLabel: string;
  onSubmit: (draft: Draft) => void;
  onCancel?: () => void;
  t: FbI18n["t"];
}) {
  const fields = FIELDS[kind];
  const [draft, setDraft] = useState(initial);
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!draft.title.trim()) return setProblem(t("Fill in {field}.", { field: t(fields.title) }));
        if (fields.contentRequired && !draft.content.trim()) {
          return setProblem(t("Fill in {field}.", { field: t(fields.content) }));
        }
        setProblem(null);
        onSubmit(draft);
      }}
    >
      <div className={`grid gap-3 ${fields.price ? "sm:grid-cols-[2fr_1fr]" : ""}`}>
        <label className="block space-y-1 text-sm">
          <span className="text-muted">{t(fields.title)}</span>
          <input
            value={draft.title}
            onChange={(event) => setDraft({ ...draft, title: event.target.value })}
            maxLength={200}
            dir="auto"
            className={inputClass}
          />
        </label>
        {fields.price && (
          <label className="block space-y-1 text-sm">
            <span className="text-muted">{t(fields.price)}</span>
            <input
              value={draft.price}
              onChange={(event) => setDraft({ ...draft, price: event.target.value })}
              maxLength={100}
              dir="auto"
              placeholder="2500 DA"
              className={inputClass}
            />
          </label>
        )}
      </div>
      <label className="block space-y-1 text-sm">
        <span className="text-muted">{t(fields.content)}</span>
        <textarea
          value={draft.content}
          onChange={(event) => setDraft({ ...draft, content: event.target.value })}
          maxLength={4000}
          rows={kind === "FAQ" ? 3 : 2}
          dir="auto"
          className={inputClass}
        />
      </label>
      <label className="flex items-center gap-2 text-sm text-foreground">
        <input
          type="checkbox"
          checked={draft.isActive}
          onChange={(event) => setDraft({ ...draft, isActive: event.target.checked })}
        />
        {t(fields.active)}
      </label>
      {problem && (
        <p role="alert" className="text-sm text-error">
          {problem}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={busy}
          className="rounded bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-60"
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

function SettingsForm({
  data,
  onSaved,
  t,
}: {
  data: SettingsData;
  onSaved: (settings: Settings) => void;
  t: FbI18n["t"];
}) {
  const canEdit = data.role === "OWNER" || data.role === "ADMIN";
  const [settings, setSettings] = useState<Settings>(data.settings);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function save() {
    if (!settings.handoffMessage.trim()) {
      setMessage({ ok: false, text: t("Write the message sent when the bot hands over.") });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/bot/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      const payload = await response.json().catch(() => null);
      if (response.ok && payload?.success) {
        setMessage({ ok: true, text: t("Saved.") });
        onSaved(payload.data.settings);
      } else {
        setMessage({ ok: false, text: t("Something went wrong. Please try again.") });
      }
    } catch {
      setMessage({ ok: false, text: t("Could not reach the server. Please try again.") });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
      <div className="space-y-4">
        {!canEdit && <p className="text-sm text-muted">{t("Only owners and admins can change the bot.")}</p>}
        <label className="flex items-center gap-2 text-sm font-medium text-foreground">
          <input
            type="checkbox"
            checked={settings.enabled}
            disabled={!canEdit}
            onChange={(event) => setSettings({ ...settings, enabled: event.target.checked })}
          />
          {t("The bot answers Messenger messages")}
        </label>
        <label className="block space-y-1 text-sm">
          <span className="text-muted">{t("Business name")}</span>
          <input
            value={settings.businessName ?? ""}
            disabled={!canEdit}
            maxLength={120}
            dir="auto"
            onChange={(event) => setSettings({ ...settings, businessName: event.target.value })}
            className={inputClass}
          />
        </label>
        <label className="block space-y-1 text-sm">
          <span className="text-muted">{t("Instructions for the bot (tone, dialect, habits)")}</span>
          <textarea
            value={settings.instructions ?? ""}
            disabled={!canEdit}
            maxLength={4000}
            rows={5}
            dir="auto"
            placeholder={t("Example: answer in Algerian Darija, warmly and briefly; say «خويا» or «ختي».")}
            onChange={(event) => setSettings({ ...settings, instructions: event.target.value })}
            className={inputClass}
          />
        </label>
        <label className="block space-y-1 text-sm">
          <span className="text-muted">{t("Message sent when the bot hands over to a person")}</span>
          <input
            value={settings.handoffMessage}
            disabled={!canEdit}
            maxLength={640}
            dir="auto"
            onChange={(event) => setSettings({ ...settings, handoffMessage: event.target.value })}
            className={inputClass}
          />
        </label>
        {message && (
          <p role={message.ok ? "status" : "alert"} className={`text-sm ${message.ok ? "text-success" : "text-error"}`}>
            {message.text}
          </p>
        )}
        {canEdit && (
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy}
            className="rounded bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-60"
          >
            {busy ? t("Saving…") : t("Save changes")}
          </button>
        )}
      </div>

      <aside className="space-y-3 rounded border border-border p-4 text-sm">
        <div>
          <p className="font-medium text-foreground">{t("AI")}</p>
          {data.ai.configured ? (
            <p className="text-success">{t("Configured ({model})", { model: data.ai.model })}</p>
          ) : (
            <p className="text-warning">{t("Not configured: set GOOGLE_API_KEY on the server.")}</p>
          )}
        </div>
        <div>
          <p className="font-medium text-foreground">{t("The bot on each Page")}</p>
          {data.pages.length === 0 ? (
            <p className="text-muted">{t("No Page connected yet.")}</p>
          ) : (
            <ul className="mt-1 space-y-1">
              {data.pages.map((page) => (
                <li key={page.id} className="flex items-center justify-between gap-2">
                  <span className="truncate">{page.name}</span>
                  <span className={page.botEnabled && page.status === "ACTIVE" ? "text-success" : "text-muted"}>
                    {page.botEnabled && page.status === "ACTIVE" ? t("On") : t("Off")}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <Link href="/facebook/pages" className="mt-2 inline-block text-accent hover:underline">
            {t("Manage Pages")}
          </Link>
        </div>
      </aside>
    </div>
  );
}

export default function KnowledgePage() {
  const fb = useFbI18n();
  const { t } = fb;
  const [tab, setTab] = useState<Tab>("settings");
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [size, setSize] = useState<{ chars: number; warnAt: number } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch("/api/bot/settings", { cache: "no-store" }).then((response) => response.json()),
      fetch("/api/bot/knowledge", { cache: "no-store" }).then((response) => response.json()),
    ])
      .then(([settingsPayload, knowledgePayload]) => {
        if (cancelled) return;
        if (settingsPayload?.success) setSettings(settingsPayload.data);
        if (knowledgePayload?.success) {
          setEntries(knowledgePayload.data.entries);
          setSize(knowledgePayload.data.size);
        }
        if (!settingsPayload?.success || !knowledgePayload?.success) setError(t("Could not load the knowledge base."));
      })
      .catch(() => {
        if (!cancelled) setError(t("Could not load the knowledge base."));
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey, t]);

  const canEdit = settings?.role === "OWNER" || settings?.role === "ADMIN";

  async function call(url: string, method: string, body?: unknown): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) setError(t("Something went wrong. Please try again."));
      return response.ok;
    } catch {
      setError(t("Could not reach the server. Please try again."));
      return false;
    } finally {
      setBusy(false);
      setReloadKey((key) => key + 1);
    }
  }

  const tabs: { value: Tab; label: string }[] = [
    { value: "settings", label: t("Settings") },
    ...KINDS.map((kind) => ({
      value: kind as Tab,
      label: `${t(FIELDS[kind].tab)} (${entries?.filter((entry) => entry.kind === kind).length ?? 0})`,
    })),
    { value: "test", label: t("Try the bot") },
  ];

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <div className="flex flex-wrap gap-1 border-b border-border" role="tablist">
        {tabs.map((option) => (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={tab === option.value}
            onClick={() => {
              setTab(option.value);
              setEditing(null);
            }}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${
              tab === option.value
                ? "border-accent font-medium text-foreground"
                : "border-transparent text-muted hover:text-foreground"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>

      {error && (
        <p role="alert" className="text-sm text-error">
          {error}
        </p>
      )}
      {size && size.chars > size.warnAt && (
        <p className="rounded border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-foreground">
          {t("The knowledge base is large ({count} characters): answers get slower and cost more.", {
            count: size.chars.toLocaleString(),
          })}
        </p>
      )}

      {!settings || !entries ? (
        !error && <p className="text-sm text-muted">{t("Loading…")}</p>
      ) : tab === "settings" ? (
        <SettingsForm
          data={settings}
          onSaved={(saved) => setSettings((current) => current && { ...current, settings: saved })}
          t={t}
        />
      ) : tab === "test" ? (
        <BotTester botEnabled={settings.settings.enabled} aiConfigured={settings.ai.configured} />
      ) : (
        <div className="space-y-5">
          <p className="text-sm text-muted">{t(FIELDS[tab].help)}</p>
          {canEdit && (
            <section className="rounded border border-border p-4">
              <h2 className="mb-3 text-sm font-semibold text-foreground">{t("Add")}</h2>
              <EntryForm
                key={`new-${tab}-${reloadKey}`}
                kind={tab}
                initial={EMPTY_DRAFT}
                busy={busy}
                submitLabel={t("Add")}
                t={t}
                onSubmit={(draft) =>
                  void call("/api/bot/knowledge", "POST", {
                    kind: tab,
                    title: draft.title,
                    content: draft.content,
                    price: draft.price || null,
                    isActive: draft.isActive,
                  })
                }
              />
            </section>
          )}
          {entries.filter((entry) => entry.kind === tab).length === 0 ? (
            <p className="text-sm text-muted">{t("Nothing here yet.")}</p>
          ) : (
            <ul className="space-y-2">
              {entries
                .filter((entry) => entry.kind === tab)
                .map((entry) => (
                  <li key={entry.id} className="rounded border border-border p-3">
                    {editing === entry.id ? (
                      <EntryForm
                        kind={entry.kind}
                        initial={{
                          title: entry.title,
                          content: entry.content,
                          price: entry.price ?? "",
                          isActive: entry.isActive,
                        }}
                        busy={busy}
                        submitLabel={t("Save changes")}
                        t={t}
                        onCancel={() => setEditing(null)}
                        onSubmit={(draft) =>
                          void call(`/api/bot/knowledge/${entry.id}`, "PATCH", {
                            title: draft.title,
                            content: draft.content,
                            price: draft.price || null,
                            isActive: draft.isActive,
                          }).then((ok) => ok && setEditing(null))
                        }
                      />
                    ) : (
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0 flex-1 space-y-1">
                          <p dir="auto" className="text-sm font-medium text-foreground">
                            {entry.title}
                            {entry.price && <span className="ms-2 text-accent">{entry.price}</span>}
                          </p>
                          {entry.content && (
                            <p dir="auto" className="whitespace-pre-wrap text-sm text-muted">
                              {entry.content}
                            </p>
                          )}
                          {!entry.isActive && (
                            <p className="text-xs text-warning">
                              {entry.kind === "PRODUCT" ? t("Not available") : t("Not used by the bot")}
                            </p>
                          )}
                        </div>
                        {canEdit && (
                          <div className="flex shrink-0 gap-2">
                            <button
                              type="button"
                              onClick={() => setEditing(entry.id)}
                              className="rounded border border-border px-3 py-1.5 text-xs text-foreground hover:bg-surface-hover"
                            >
                              {t("Edit")}
                            </button>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => {
                                if (confirm(t("Delete «{title}»?", { title: entry.title }))) {
                                  void call(`/api/bot/knowledge/${entry.id}`, "DELETE");
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
        </div>
      )}
    </div>
  );
}
