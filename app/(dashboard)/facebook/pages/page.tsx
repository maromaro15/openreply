"use client";

/**
 * Facebook Pages of the active brand: connect with a long-lived token, see
 * whether each Page's webhooks are wired, and manage the connection.
 */
import { useEffect, useState } from "react";
import { useFbI18n } from "@/lib/facebook/i18n/client";
import { useI18n } from "@/lib/i18n/provider";
import type { FbI18n } from "@/lib/facebook/i18n";

type PageRow = {
  id: string;
  pageId: string;
  name: string;
  pictureUrl: string | null;
  status: "ACTIVE" | "TOKEN_INVALID" | "DISCONNECTED";
  tokenLast4: string | null;
  tokenExpiresAt: string | null;
  grantedScopes: string[];
  subscribedFields: string[];
  webhookSubscribed: boolean;
  botEnabled: boolean;
  lastError: string | null;
  lastWebhookAt: string | null;
};

type Setup = {
  callbackUrl: string;
  verifyTokenConfigured: boolean;
  fields: string[];
  permissions: string[];
  optionalPermissions: string[];
  missingEnv: string[];
};

type ConnectErrorDetails = {
  code: string;
  message: string;
  missing?: string[];
  expiresAt?: string;
};

type Choice = { id: string; name: string; pictureUrl: string | null };

function explain(t: FbI18n["t"], error: ConnectErrorDetails, formatDate: (iso: string) => string): string {
  switch (error.code) {
    case "env_missing":
      return t("Set {vars} in the server environment first.", { vars: (error.missing ?? []).join(", ") });
    case "invalid_token_format":
      return t("That does not look like a Facebook access token.");
    case "invalid_token":
      return t("The token is not valid. Generate a new one and try again.");
    case "wrong_app":
      return t("This token belongs to another Meta app. Generate it with this app, or webhooks will never arrive.");
    case "unsupported_token_type":
      return t("Use a Page access token, or a user token of a Page admin.");
    case "missing_permissions":
      return t("The token is missing permissions: {list}", { list: (error.missing ?? []).join(", ") });
    case "short_lived_token":
      return t("This token expires on {date}. Use a long-lived Page token.", {
        date: error.expiresAt ? formatDate(error.expiresAt) : "?",
      });
    case "page_in_other_workspace":
      return t("This Page is already connected to another brand.");
    case "no_pages":
      return t("This account manages no Page this app can use.");
    case "page_not_found_for_user":
      return t("One of the chosen Pages is not managed by this account.");
    default:
      return t("Facebook answered: {message}", { message: error.message });
  }
}

export default function FacebookPagesPage() {
  const { locale } = useI18n();
  const { t } = useFbI18n();
  const [pages, setPages] = useState<PageRow[] | null>(null);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [role, setRole] = useState<"OWNER" | "ADMIN" | "MEMBER">("MEMBER");
  const [loadFailed, setLoadFailed] = useState(false);
  const [token, setToken] = useState("");
  const [choices, setChoices] = useState<Choice[] | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [workerHealthy, setWorkerHealthy] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/facebook/health", { cache: "no-store" })
      .then((response) => response.json())
      .then((payload) => {
        if (!cancelled) setWorkerHealthy(Boolean(payload?.data?.worker?.healthy));
      })
      .catch(() => {
        if (!cancelled) setWorkerHealthy(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
        setPages(payload.data.pages);
        setSetup(payload.data.setup);
        setRole(payload.data.role);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const canManage = role === "OWNER" || role === "ADMIN";
  const formatDate = (iso: string) =>
    new Date(iso).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });

  async function connect(pageIds?: string[]) {
    setBusy("connect");
    setNotice(null);
    try {
      const response = await fetch("/api/facebook/pages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, ...(pageIds ? { pageIds } : {}) }),
      });
      const payload = await response.json();
      if (!payload.success) {
        setNotice({
          kind: "error",
          text: payload.details ? explain(t, payload.details, formatDate) : payload.error,
        });
        return;
      }
      if (payload.data.kind === "choose_pages") {
        setChoices(payload.data.pages);
        setSelected([]);
        return;
      }
      const connected = payload.data.pages as { name: string; subscriptionError: string | null }[];
      const failures = payload.data.failures as ConnectErrorDetails[];
      const lines = [
        ...connected.map((page) =>
          page.subscriptionError
            ? t("{name} connected, but its webhooks are not set up yet.", { name: page.name })
            : t("{name} connected.", { name: page.name })
        ),
        ...failures.map((failure) => explain(t, failure, formatDate)),
      ];
      setNotice({ kind: failures.length ? "error" : "ok", text: lines.join(" ") });
      setToken("");
      setChoices(null);
      setReloadKey((key) => key + 1);
    } catch {
      setNotice({ kind: "error", text: t("Could not reach the server. Please try again.") });
    } finally {
      setBusy(null);
    }
  }

  async function act(page: PageRow, action: "subscribe" | "disconnect" | "delete" | "bot") {
    if (action === "disconnect" && !confirm(t("Disconnect {name}? Its campaigns and conversations are kept.", { name: page.name }))) {
      return;
    }
    if (
      action === "delete" &&
      !confirm(t("Delete {name} with all its campaigns and conversations? This cannot be undone.", { name: page.name }))
    ) {
      return;
    }
    setBusy(`${action}:${page.id}`);
    setNotice(null);
    try {
      const request =
        action === "subscribe"
          ? fetch(`/api/facebook/pages/${page.id}/subscribe`, { method: "POST" })
          : action === "bot"
            ? fetch(`/api/facebook/pages/${page.id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ botEnabled: !page.botEnabled }),
              })
            : fetch(`/api/facebook/pages/${page.id}`, {
                method: "DELETE",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ purge: action === "delete" }),
              });
      const payload = await (await request).json();
      if (!payload.success) {
        setNotice({ kind: "error", text: payload.error ?? t("Something went wrong. Please try again.") });
      }
    } catch {
      setNotice({ kind: "error", text: t("Could not reach the server. Please try again.") });
    } finally {
      setBusy(null);
      setReloadKey((key) => key + 1);
    }
  }

  if (loadFailed) return <p className="text-sm text-error">{t("Could not load the Pages.")}</p>;
  if (!pages || !setup) return <div className="panel h-48 rounded" />;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      {canManage && (
        <section className="panel space-y-4 rounded p-4 sm:p-6">
          <div className="space-y-1">
            <h2 className="text-base font-semibold text-foreground">{t("Connect a Page")}</h2>
            <p className="text-sm text-muted">
              {t("Paste a long-lived Page access token. A user token of a Page admin works too: you then pick the Pages to connect.")}
            </p>
          </div>

          {setup.missingEnv.length > 0 && (
            <p className="rounded border border-warning/30 bg-warning/10 p-3 text-sm text-warning">
              {t("Set {vars} in the server environment first.", { vars: setup.missingEnv.join(", ") })}
            </p>
          )}

          <form
            onSubmit={(event) => {
              event.preventDefault();
              void connect();
            }}
            className="space-y-3"
          >
            <textarea
              value={token}
              onChange={(event) => {
                setToken(event.target.value);
                setChoices(null);
              }}
              rows={3}
              dir="ltr"
              spellCheck={false}
              autoComplete="off"
              placeholder="EAAG…"
              aria-label={t("Access token")}
              className="w-full rounded border border-border bg-background px-3 py-2 font-mono text-xs text-foreground outline-none focus:border-accent/40"
            />
            <button
              type="submit"
              disabled={busy === "connect" || !token.trim()}
              className="rounded bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground hover:bg-accent-hover disabled:opacity-50"
            >
              {busy === "connect" ? t("Checking…") : t("Connect")}
            </button>
          </form>

          {choices && (
            <div className="space-y-3 rounded border border-border p-3">
              <p className="text-sm font-medium text-foreground">{t("Choose the Pages to connect")}</p>
              <div className="space-y-2">
                {choices.map((choice) => (
                  <label key={choice.id} className="flex items-center gap-3 text-sm">
                    <input
                      type="checkbox"
                      checked={selected.includes(choice.id)}
                      onChange={(event) =>
                        setSelected((current) =>
                          event.target.checked ? [...current, choice.id] : current.filter((id) => id !== choice.id)
                        )
                      }
                    />
                    {choice.pictureUrl && (
                      // eslint-disable-next-line @next/next/no-img-element -- Facebook CDN avatar, no optimisation needed
                      <img src={choice.pictureUrl} alt="" className="h-6 w-6 rounded-full" />
                    )}
                    <span className="text-foreground">{choice.name}</span>
                    <span className="text-xs text-muted" dir="ltr">
                      {choice.id}
                    </span>
                  </label>
                ))}
              </div>
              <button
                type="button"
                disabled={busy === "connect" || selected.length === 0}
                onClick={() => void connect(selected)}
                className="rounded bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground hover:bg-accent-hover disabled:opacity-50"
              >
                {t("Connect the selected Pages")}
              </button>
            </div>
          )}
        </section>
      )}

      {notice && (
        <p
          role={notice.kind === "error" ? "alert" : "status"}
          className={`rounded border p-3 text-sm ${
            notice.kind === "error" ? "border-error/20 bg-error/10 text-error" : "border-success/20 bg-success/10 text-success"
          }`}
        >
          {notice.text}
        </p>
      )}

      <section className="panel space-y-3 rounded p-4 sm:p-6">
        <h2 className="text-base font-semibold text-foreground">{t("Meta app webhook")}</h2>
        <p className="text-sm text-muted">{t("In the Meta app, subscribe the Page object to this callback with these fields.")}</p>
        <dl className="space-y-3 text-sm">
          <div>
            <dt className="text-xs text-muted">{t("Callback URL")}</dt>
            <dd className="flex flex-wrap items-center gap-2">
              <code dir="ltr" className="rounded bg-surface-hover px-2 py-1 text-xs text-foreground">
                {setup.callbackUrl}
              </code>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard?.writeText(setup.callbackUrl);
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1500);
                }}
                className="rounded border border-border px-2 py-1 text-xs text-muted hover:text-foreground"
              >
                {copied ? t("Copied") : t("Copy")}
              </button>
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted">{t("Verify token")}</dt>
            <dd className={setup.verifyTokenConfigured ? "text-success" : "text-warning"}>
              {setup.verifyTokenConfigured
                ? t("Set on the server (FACEBOOK_WEBHOOK_VERIFY_TOKEN)")
                : t("Missing: set FACEBOOK_WEBHOOK_VERIFY_TOKEN")}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted">{t("Webhook fields")}</dt>
            <dd dir="ltr" className="text-start font-mono text-xs text-foreground">
              {setup.fields.join(", ")}
            </dd>
          </div>
          {workerHealthy !== null && (
            <div>
              <dt className="text-xs text-muted">{t("Facebook worker")}</dt>
              <dd className={workerHealthy ? "text-success" : "text-warning"}>
                {workerHealthy ? t("Running") : t("Not running: start the Facebook worker (npm run worker:facebook, or the facebook-worker service).")}
              </dd>
            </div>
          )}
          <div>
            <dt className="text-xs text-muted">{t("Permissions")}</dt>
            <dd dir="ltr" className="text-start font-mono text-xs text-foreground">
              {setup.permissions.join(", ")}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted">{t("Optional, for public replies under comments")}</dt>
            <dd dir="ltr" className="text-start font-mono text-xs text-foreground">
              {setup.optionalPermissions.join(", ")}
            </dd>
          </div>
        </dl>
      </section>

      <section className="space-y-3">
        <h2 className="text-base font-semibold text-foreground">{t("Connected Pages")}</h2>
        {pages.length === 0 && <p className="text-sm text-muted">{t("No Page connected yet.")}</p>}
        {pages.map((page) => (
          <article key={page.id} className="panel space-y-3 rounded p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                {page.pictureUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- Facebook CDN avatar, no optimisation needed
                  <img src={page.pictureUrl} alt="" className="h-10 w-10 shrink-0 rounded-full" />
                ) : (
                  <div className="h-10 w-10 shrink-0 rounded-full bg-surface-hover" />
                )}
                <div className="min-w-0">
                  <h3 className="truncate text-sm font-semibold text-foreground">{page.name}</h3>
                  <p className="text-xs text-muted" dir="ltr">
                    ID {page.pageId}
                    {page.tokenLast4 ? ` · …${page.tokenLast4}` : ""}
                  </p>
                </div>
              </div>
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
                  page.status === "ACTIVE"
                    ? "bg-success/10 text-success"
                    : page.status === "TOKEN_INVALID"
                      ? "bg-error/10 text-error"
                      : "bg-surface-hover text-muted"
                }`}
              >
                {page.status === "ACTIVE"
                  ? t("Active")
                  : page.status === "TOKEN_INVALID"
                    ? t("Token invalid")
                    : t("Disconnected")}
              </span>
            </div>

            {page.status !== "DISCONNECTED" && (
              <dl className="grid gap-2 text-xs sm:grid-cols-3">
                <div>
                  <dt className="text-muted">{t("Webhook fields")}</dt>
                  <dd className="flex flex-wrap gap-1 pt-0.5" dir="ltr">
                    {setup.fields.map((field) => {
                      const on = page.subscribedFields.includes(field);
                      return (
                        <span
                          key={field}
                          className={`rounded px-1.5 py-0.5 font-mono ${on ? "bg-success/10 text-success" : "bg-error/10 text-error"}`}
                        >
                          {on ? "✓" : "✗"} {field}
                        </span>
                      );
                    })}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted">{t("Token")}</dt>
                  <dd className="text-foreground">
                    {page.tokenExpiresAt
                      ? t("Expires {date}", { date: formatDate(page.tokenExpiresAt) })
                      : t("Does not expire")}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted">{t("Last webhook")}</dt>
                  <dd className="text-foreground">
                    {page.lastWebhookAt ? formatDate(page.lastWebhookAt) : t("None received yet")}
                  </dd>
                </div>
              </dl>
            )}

            {page.status !== "DISCONNECTED" &&
              setup.optionalPermissions.some((scope) => !page.grantedScopes.includes(scope)) && (
                <p className="rounded border border-warning/20 bg-warning/10 p-2 text-xs text-warning" dir="auto">
                  {t("Public replies under comments are off: the token lacks {list}. Private replies and the bot work.", {
                    list: setup.optionalPermissions.filter((scope) => !page.grantedScopes.includes(scope)).join(", "),
                  })}
                </p>
              )}

            {page.lastError && (
              <p className="rounded border border-error/20 bg-error/10 p-2 text-xs text-error" dir="auto">
                {page.lastError}
              </p>
            )}

            {canManage && (
              <div className="flex flex-wrap items-center gap-2">
                {page.status !== "DISCONNECTED" && (
                  <>
                    <label className="me-2 inline-flex items-center gap-2 text-sm text-foreground">
                      <input
                        type="checkbox"
                        checked={page.botEnabled}
                        disabled={busy !== null}
                        onChange={() => void act(page, "bot")}
                      />
                      {t("Bot replies on this Page")}
                    </label>
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void act(page, "subscribe")}
                      className="rounded border border-border px-3 py-1.5 text-xs font-medium text-muted hover:text-foreground disabled:opacity-50"
                    >
                      {t("Subscribe again")}
                    </button>
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void act(page, "disconnect")}
                      className="rounded border border-error/20 px-3 py-1.5 text-xs font-medium text-error hover:bg-error/10 disabled:opacity-50"
                    >
                      {t("Disconnect")}
                    </button>
                  </>
                )}
                {page.status === "DISCONNECTED" && role === "OWNER" && (
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void act(page, "delete")}
                    className="rounded border border-error/20 px-3 py-1.5 text-xs font-medium text-error hover:bg-error/10 disabled:opacity-50"
                  >
                    {t("Delete")}
                  </button>
                )}
              </div>
            )}
          </article>
        ))}
      </section>
    </div>
  );
}
