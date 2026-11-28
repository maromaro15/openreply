"use client";

/**
 * Brands: one workspace per client of the agency.
 *
 * Lists the workspaces the user belongs to with their activity, opens one,
 * and adds new ones. A brand's team is managed in Settings → Team once the
 * brand is open, with the existing invitations.
 */
import { useEffect, useState, useTransition } from "react";
import type { HandoffCategory } from "@/app/generated/prisma/client";
import { selectWorkspace } from "@/lib/agency/actions";
import { HANDOFF_CATEGORY_BADGE } from "@/lib/handoff/categories";
import { useFbI18n } from "@/lib/facebook/i18n/client";
import { useI18n } from "@/lib/i18n/provider";

type Summary = {
  facebookPages: number;
  instagramAccounts: number;
  activeCampaigns: number;
  members: number;
  needsHuman: number;
  needsHumanByCategory: Partial<Record<HandoffCategory, number>>;
  lastActivityAt: string | null;
};

type Brand = {
  id: string;
  name: string;
  role: "OWNER" | "ADMIN" | "MEMBER";
  createdAt: string;
  summary: Summary | null;
};

type Overview = { activeWorkspaceId: string | null; canCreate: boolean; workspaces: Brand[] };

export default function AgencyPage() {
  const { locale, label } = useI18n();
  const { t, category } = useFbI18n();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [switching, startSwitch] = useTransition();

  useEffect(() => {
    let cancelled = false;
    fetch("/api/agency/workspaces?view=stats", { cache: "no-store" })
      .then((response) => response.json())
      .then((payload) => {
        if (cancelled) return;
        if (payload?.success) setOverview(payload.data);
        else setLoadFailed(true);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function open(workspaceId: string, path: string) {
    setError(null);
    startSwitch(async () => {
      const result = await selectWorkspace(workspaceId).catch(() => null);
      if (result?.ok) {
        // A full load, so every screen and client cache starts in the new brand.
        window.location.assign(path);
      } else {
        setError(t("Could not switch brand. Please try again."));
      }
    });
  }

  async function createBrand(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim() || creating) return;
    setCreating(true);
    setError(null);
    try {
      const response = await fetch("/api/agency/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const payload = await response.json();
      if (response.status === 403 && payload?.error === "You have reached the maximum number of brands.") {
        setError(t("You have reached the maximum number of brands."));
        setCreating(false);
        return;
      }
      if (!payload.success) throw new Error(payload.error);
      // The new brand is now the active one.
      window.location.assign("/agency");
    } catch {
      setError(t("Could not create the brand. Please try again."));
      setCreating(false);
    }
  }

  if (loadFailed) {
    return <p className="text-sm text-error">{t("Could not load brands.")}</p>;
  }
  if (!overview) {
    return <div className="panel h-48 rounded" />;
  }

  const formatDate = (iso: string) =>
    new Date(iso).toLocaleDateString(locale, { month: "short", day: "numeric", year: "numeric" });

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <p className="max-w-3xl text-sm text-muted">
        {t(
          "Each brand is its own workspace, with its own Pages, campaigns, knowledge base, inbox and alerts. A brand's team only sees that brand."
        )}
      </p>

      {overview.canCreate && (
        <form onSubmit={createBrand} className="panel flex flex-col gap-3 rounded p-4 sm:flex-row sm:items-end">
          <label className="flex-1 space-y-1">
            <span className="text-sm font-semibold text-foreground">{t("Add a brand")}</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={80}
              placeholder={t("Brand name")}
              className="w-full rounded border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-accent/40"
              required
            />
          </label>
          <button
            type="submit"
            disabled={creating || !name.trim()}
            className="rounded bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground hover:bg-accent-hover disabled:opacity-50"
          >
            {creating ? t("Creating…") : t("Create")}
          </button>
        </form>
      )}

      {error && (
        <p role="alert" className="rounded border border-error/20 bg-error/10 p-3 text-sm text-error">
          {error}
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {overview.workspaces.map((brand) => {
          const isActive = brand.id === overview.activeWorkspaceId;
          const summary = brand.summary;
          const canManage = brand.role === "OWNER" || brand.role === "ADMIN";
          return (
            <section
              key={brand.id}
              className={`panel space-y-4 rounded p-4 ${isActive ? "border-accent/50" : ""}`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h2 className="truncate text-base font-semibold text-foreground">{brand.name}</h2>
                  <p className="text-xs text-muted">
                    {t("Your role")}: {label(brand.role)}
                  </p>
                </div>
                {isActive && (
                  <span className="shrink-0 rounded-full bg-accent-soft px-2 py-0.5 text-xs font-medium text-foreground">
                    {t("Current")}
                  </span>
                )}
              </div>

              {summary && (
                <>
                  <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
                    <Stat label={t("Facebook Pages")} value={summary.facebookPages} />
                    <Stat label={t("Instagram accounts")} value={summary.instagramAccounts} />
                    <Stat label={t("Active campaigns")} value={summary.activeCampaigns} />
                    <Stat label={t("Members")} value={summary.members} />
                  </dl>

                  <div className="space-y-2">
                    <p className="text-sm">
                      <span className="text-muted">{t("Need a person")}: </span>
                      <span className={summary.needsHuman > 0 ? "font-semibold text-error" : "text-foreground"}>
                        {summary.needsHuman}
                      </span>
                    </p>
                    {summary.needsHuman > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {(Object.entries(summary.needsHumanByCategory) as [HandoffCategory, number][]).map(
                          ([key, count]) => (
                            <span
                              key={key}
                              className={`rounded-full px-2 py-0.5 text-xs font-medium ${HANDOFF_CATEGORY_BADGE[key]}`}
                            >
                              {category(key)} · {count}
                            </span>
                          )
                        )}
                      </div>
                    )}
                  </div>

                  <p className="text-xs text-muted">
                    {t("Last activity")}:{" "}
                    {summary.lastActivityAt ? formatDate(summary.lastActivityAt) : t("No activity yet")}
                  </p>
                </>
              )}

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={switching}
                  onClick={() => open(brand.id, "/dashboard")}
                  className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground hover:bg-accent-hover disabled:opacity-50"
                >
                  {t("Open")}
                </button>
                {canManage && (
                  <button
                    type="button"
                    disabled={switching}
                    onClick={() => open(brand.id, "/settings")}
                    className="rounded border border-border px-3 py-1.5 text-sm font-medium text-muted hover:text-foreground disabled:opacity-50"
                  >
                    {t("Team")}
                  </button>
                )}
              </div>
            </section>
          );
        })}
      </div>

      {!overview.canCreate && (
        <p className="text-xs text-muted">{t("Only someone who owns a workspace can add brands.")}</p>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="font-semibold text-foreground">{value}</dd>
    </div>
  );
}
