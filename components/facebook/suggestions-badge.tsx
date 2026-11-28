"use client";

/**
 * «N suggestions to review», linking to the review screen. Renders nothing
 * when there are none (or while it is not known), so it can sit on a page
 * without leaving a gap.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { useFbI18n } from "@/lib/facebook/i18n/client";

export default function SuggestionsBadge() {
  const { t } = useFbI18n();
  const [pending, setPending] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/knowledge/suggestions?countOnly=true", { cache: "no-store" })
      .then((response) => response.json())
      .then((payload) => {
        const count = payload?.success ? Number(payload.data?.counts?.pending) : 0;
        if (!cancelled) setPending(Number.isFinite(count) && count > 0 ? count : 0);
      })
      .catch(() => {
        // A badge that cannot count shows nothing.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (pending === 0) return null;
  return (
    <Link
      href="/facebook/knowledge/suggestions"
      className="inline-flex items-center rounded-full border border-warning px-3 py-1 text-xs font-medium text-foreground hover:bg-surface-hover"
    >
      {pending === 1 ? t("1 suggestion to review") : t("{count} suggestions to review", { count: pending })}
    </Link>
  );
}
