"use client";

/**
 * Facebook campaigns of the active brand, and the log of every comment a
 * campaign matched with what happened to it.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { useFbI18n } from "@/lib/facebook/i18n/client";
import type { FbStaticKey } from "@/lib/facebook/i18n";
import { useI18n } from "@/lib/i18n/provider";

type Stats = { matched: number; sent: number; failed: number; skipped: number; pending: number };
type Campaign = {
  id: string;
  name: string;
  isActive: boolean;
  matchAnyPost: boolean;
  postPreview: string | null;
  postPermalink: string | null;
  keywords: string[];
  matchAnyWord: boolean;
  page: { id: string; name: string; status: string };
  stats: Stats;
};
type Log = {
  id: string;
  commentText: string;
  commenterName: string | null;
  matchedKeyword: string | null;
  status: string;
  errorMessage: string | null;
  publicReplySentAt: string | null;
  publicReplyError: string | null;
  createdAt: string;
  campaign: { id: string; name: string } | null;
  page: { id: string; name: string };
};

const STATUS_LABELS: Record<string, FbStaticKey> = {
  PENDING: "Pending",
  SENT: "Sent",
  FAILED: "Failed",
  UNCONFIRMED: "Unconfirmed",
  SKIPPED_EXPIRED: "Older than 7 days",
  SKIPPED_ALREADY_REPLIED: "Already replied",
  SKIPPED_NOT_ELIGIBLE: "Cannot receive messages",
  SKIPPED_RATE_LIMIT: "Rate limited",
};

const STATUS_STYLE: Record<string, string> = {
  SENT: "bg-success/10 text-success",
  FAILED: "bg-error/10 text-error",
  UNCONFIRMED: "bg-warning/10 text-warning",
  PENDING: "bg-accent-soft text-foreground",
};

export default function FacebookCampaignsPage() {
  const { locale } = useI18n();
  const { t } = useFbI18n();
  const [tab, setTab] = useState<"campaigns" | "log">("campaigns");
  const [campaigns, setCampaigns] = useState<Campaign[] | null>(null);
  const [role, setRole] = useState("MEMBER");
  const [logs, setLogs] = useState<Log[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/facebook/campaigns", { cache: "no-store" })
      .then((response) => response.json())
      .then((payload) => {
        if (cancelled || !payload?.success) return;
        setCampaigns(payload.data.campaigns);
        setRole(payload.data.role);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  useEffect(() => {
    if (tab !== "log") return;
    let cancelled = false;
    fetch(`/api/facebook/comment-logs${status ? `?status=${status}` : ""}`, { cache: "no-store" })
      .then((response) => response.json())
      .then((payload) => {
        if (cancelled || !payload?.success) return;
        setLogs(payload.data.logs);
        setNextCursor(payload.data.nextCursor);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [tab, status, reloadKey]);

  async function loadMore() {
    if (!nextCursor) return;
    const query = new URLSearchParams({ cursor: nextCursor, ...(status ? { status } : {}) });
    const payload = await (await fetch(`/api/facebook/comment-logs?${query}`, { cache: "no-store" })).json();
    if (payload?.success) {
      setLogs((current) => [...(current ?? []), ...payload.data.logs]);
      setNextCursor(payload.data.nextCursor);
    }
  }

  async function toggle(campaign: Campaign) {
    setError(null);
    const response = await fetch(`/api/facebook/campaigns/${campaign.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: !campaign.isActive }),
    });
    if (!response.ok) setError(t("Something went wrong. Please try again."));
    setReloadKey((key) => key + 1);
  }

  async function remove(campaign: Campaign) {
    if (!confirm(t("Delete the campaign {name}? Its comment log is kept.", { name: campaign.name }))) return;
    setError(null);
    const response = await fetch(`/api/facebook/campaigns/${campaign.id}`, { method: "DELETE" });
    if (!response.ok) setError(t("Something went wrong. Please try again."));
    setReloadKey((key) => key + 1);
  }

  const canManage = role === "OWNER" || role === "ADMIN";

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded border border-border p-0.5 text-sm">
          {(["campaigns", "log"] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setTab(value)}
              className={`rounded px-3 py-1.5 ${tab === value ? "bg-surface-hover font-medium text-foreground" : "text-muted hover:text-foreground"}`}
            >
              {value === "campaigns" ? t("Campaigns") : t("Comment log")}
            </button>
          ))}
        </div>
        {canManage && (
          <Link href="/facebook/campaigns/new" className="rounded bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground hover:bg-accent-hover">
            {t("New campaign")}
          </Link>
        )}
      </div>

      {error && <p role="alert" className="text-sm text-error">{error}</p>}

      {tab === "campaigns" && (
        <div className="space-y-3">
          {!campaigns && <div className="panel h-32 rounded" />}
          {campaigns?.length === 0 && <p className="text-sm text-muted">{t("No campaign yet.")}</p>}
          {campaigns?.map((campaign) => (
            <article key={campaign.id} className="panel flex flex-col gap-3 rounded p-4 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="truncate text-sm font-semibold text-foreground">{campaign.name}</h2>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${campaign.isActive ? "bg-success/10 text-success" : "bg-surface-hover text-muted"}`}
                  >
                    {campaign.isActive ? t("Active") : t("Paused")}
                  </span>
                </div>
                <p className="truncate text-xs text-muted" dir="auto">
                  {campaign.page.name} ·{" "}
                  {campaign.matchAnyPost ? t("Any post") : campaign.postPreview || t("One post")}
                </p>
                <p className="truncate text-xs text-muted" dir="auto">
                  {campaign.matchAnyWord ? t("Every comment") : campaign.keywords.join(" · ")}
                </p>
              </div>
              <dl className="grid grid-cols-4 gap-3 text-center text-xs">
                <div>
                  <dt className="text-muted">{t("Matched")}</dt>
                  <dd className="text-sm font-semibold text-foreground">{campaign.stats.matched}</dd>
                </div>
                <div>
                  <dt className="text-muted">{t("Sent")}</dt>
                  <dd className="text-sm font-semibold text-success">{campaign.stats.sent}</dd>
                </div>
                <div>
                  <dt className="text-muted">{t("Failed")}</dt>
                  <dd className="text-sm font-semibold text-error">{campaign.stats.failed}</dd>
                </div>
                <div>
                  <dt className="text-muted">{t("Skipped")}</dt>
                  <dd className="text-sm font-semibold text-muted">{campaign.stats.skipped}</dd>
                </div>
              </dl>
              {canManage && (
                <div className="flex gap-2">
                  <Link
                    href={`/facebook/campaigns/${campaign.id}`}
                    className="rounded border border-border px-3 py-1.5 text-xs font-medium text-muted hover:text-foreground"
                  >
                    {t("Edit")}
                  </Link>
                  <button
                    type="button"
                    onClick={() => void toggle(campaign)}
                    className="rounded border border-border px-3 py-1.5 text-xs font-medium text-muted hover:text-foreground"
                  >
                    {campaign.isActive ? t("Pause") : t("Resume")}
                  </button>
                  <button
                    type="button"
                    onClick={() => void remove(campaign)}
                    className="rounded border border-error/20 px-3 py-1.5 text-xs font-medium text-error hover:bg-error/10"
                  >
                    {t("Delete")}
                  </button>
                </div>
              )}
            </article>
          ))}
        </div>
      )}

      {tab === "log" && (
        <div className="space-y-3">
          <select
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              setLogs(null);
            }}
            aria-label={t("Status")}
            className="rounded border border-border bg-surface px-2 py-1.5 text-sm text-foreground"
          >
            <option value="">{t("All statuses")}</option>
            {Object.entries(STATUS_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {t(label)}
              </option>
            ))}
          </select>
          {!logs && <div className="panel h-32 rounded" />}
          {logs?.length === 0 && <p className="text-sm text-muted">{t("No matched comment yet.")}</p>}
          {logs?.map((log) => (
            <article key={log.id} className="panel space-y-1 rounded p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[log.status] ?? "bg-surface-hover text-muted"}`}>
                  {STATUS_LABELS[log.status] ? t(STATUS_LABELS[log.status]) : log.status}
                </span>
                <span className="text-xs text-muted">
                  {new Date(log.createdAt).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" })}
                </span>
                <span className="text-xs text-muted" dir="auto">
                  {log.page.name}
                  {log.campaign ? ` · ${log.campaign.name}` : ""}
                </span>
              </div>
              <p className="text-foreground" dir="auto">
                <span className="font-medium">{log.commenterName ?? t("Someone")}</span>: {log.commentText}
              </p>
              {log.matchedKeyword && (
                <p className="text-xs text-muted" dir="auto">
                  {t("Keyword")}: {log.matchedKeyword}
                </p>
              )}
              {log.publicReplySentAt && <p className="text-xs text-success">{t("Public reply posted")}</p>}
              {(log.errorMessage || log.publicReplyError) && (
                <p className="text-xs text-error" dir="auto">
                  {log.errorMessage ?? log.publicReplyError}
                </p>
              )}
            </article>
          ))}
          {nextCursor && (
            <button type="button" onClick={() => void loadMore()} className="rounded border border-border px-3 py-1.5 text-sm text-muted hover:text-foreground">
              {t("Load more")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
