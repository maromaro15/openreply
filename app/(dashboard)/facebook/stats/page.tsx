"use client";

/** Basic Messenger statistics of the active brand, for the team and the brand owner. */
import { useEffect, useState } from "react";
import Link from "next/link";
import { useFbI18n } from "@/lib/facebook/i18n/client";
import { HANDOFF_CATEGORIES } from "@/lib/handoff/categories";
import type { MessengerStats } from "@/lib/facebook/stats";

const PERIODS = [7, 30] as const;

export default function StatsPage() {
  const fb = useFbI18n();
  const { t } = fb;
  const [days, setDays] = useState<(typeof PERIODS)[number]>(7);
  const [stats, setStats] = useState<MessengerStats | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/facebook/stats?days=${days}`, { cache: "no-store" })
      .then((response) => response.json())
      .then((payload) => {
        if (cancelled) return;
        if (payload?.success) {
          setStats(payload.data);
          setError(false);
        } else setError(true);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [days]);

  const tiles = stats
    ? [
        { label: t("Customers who wrote"), value: stats.conversations },
        { label: t("Customer messages"), value: stats.customerMessages },
        { label: t("Bot replies"), value: stats.botReplies },
        { label: t("Team replies"), value: stats.teamReplies },
        { label: t("Handed to a person"), value: stats.handoffs },
      ]
    : [];

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label={t("Period")}>
        {PERIODS.map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={days === value}
            onClick={() => setDays(value)}
            className={`rounded border px-3 py-1.5 text-xs font-medium ${
              days === value ? "border-accent bg-accent/10 text-foreground" : "border-border text-muted hover:text-foreground"
            }`}
          >
            {t("Last {days} days", { days: value })}
          </button>
        ))}
      </div>
      {error && (
        <p role="alert" className="text-sm text-error">
          {t("Could not load the statistics.")}
        </p>
      )}
      {!stats && !error && <p className="text-sm text-muted">{t("Loading…")}</p>}
      {stats && (
        <>
          <Link
            href="/facebook/inbox?filter=needs_human"
            className="block rounded border border-warning/40 bg-warning/5 p-4 hover:bg-warning/10"
          >
            <p className="text-2xl font-semibold text-foreground">{stats.waitingNow}</p>
            <p className="text-sm text-muted">{t("Conversations waiting for a person now")}</p>
          </Link>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {tiles.map((tile) => (
              <div key={tile.label} className="rounded border border-border p-4">
                <p className="text-2xl font-semibold text-foreground">{tile.value}</p>
                <p className="text-sm text-muted">{tile.label}</p>
              </div>
            ))}
          </div>
          <section className="space-y-2 rounded border border-border p-4">
            <h2 className="text-sm font-semibold text-foreground">{t("Handoffs by reason")}</h2>
            {stats.handoffs === 0 ? (
              <p className="text-sm text-muted">{t("No handoff in this period.")}</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {HANDOFF_CATEGORIES.filter((category) => stats.handoffsByCategory[category]).map((category) => (
                  <li key={category} className="flex justify-between gap-3">
                    <span className="text-foreground">{fb.category(category)}</span>
                    <span className="font-medium text-foreground">{stats.handoffsByCategory[category]}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
