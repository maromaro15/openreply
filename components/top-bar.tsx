"use client";

/**
 * Top Bar
 *
 * Page title, mobile hamburger, back arrow on pages outside the menu, and
 * connection status.
 */

import type { StaticMessageKey } from "@/lib/i18n";
import { moduleTitle } from "@/lib/facebook/i18n";
import { useFbI18n } from "@/lib/facebook/i18n/client";
import { useI18n } from "@/lib/i18n/provider";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import BackArrow from "@/components/back-arrow";
import { backTarget } from "@/lib/navigation";

const pageTitles: Record<string, StaticMessageKey> = {
  "/dashboard": "Dashboard",
  "/overview": "Overview",
  "/inbox": "Inbox",
  "/campaigns/import": "Import campaigns",
  "/campaigns": "Campaigns",
  "/campaigns/new": "New Campaign",
  "/automations": "Campaigns",
  "/automations/new": "New Campaign",
  "/logs": "DM Logs",
  "/settings": "Settings",
  "/diagnostics": "Diagnostics",
};

interface TopBarProps {
  onMenuClick: () => void;
  /** Conversations with unread messages: shown on the Menu button, the inbox is behind it on phones. */
  unread?: number;
  instagramUsername: string | null;
  instagramAccountCount: number;
}

export default function TopBar({
  onMenuClick,
  unread = 0,
  instagramUsername,
  instagramAccountCount,
}: TopBarProps) {
  const { t } = useI18n();
  const { t: tf } = useFbI18n();
  const pathname = usePathname();
  const router = useRouter();
  const back = backTarget(pathname);
  const backClass =
    "-ms-1 inline-flex h-10 w-10 shrink-0 items-center justify-center rounded text-foreground hover:bg-surface-hover";
  // Agency and Facebook screens carry their own titles (lib/facebook/i18n).
  const moduleKey = moduleTitle(pathname);
  const title: StaticMessageKey = pageTitles[pathname] ?? (
    pathname.endsWith("/edit") ? "Edit campaign"
      : pathname.startsWith("/campaigns/") ? "Campaign details" : "Dashboard"
  );

  return (
    <header
      className="sticky top-0 z-30 flex items-center justify-between gap-3 px-4 lg:px-8 border-b border-border bg-background"
      // Installed to the home screen the app starts at the very top of the
      // display, so without this the title sits under the clock and battery.
      // The inset is 0 in a browser tab and on desktop.
      style={{
        height: "calc(4rem + env(safe-area-inset-top))",
        paddingTop: "env(safe-area-inset-top)",
      }}
    >
      <div className="flex min-w-0 items-center gap-3 sm:gap-4">
        <button
          onClick={onMenuClick}
          className="relative lg:hidden shrink-0 px-2.5 py-1.5 rounded border border-border bg-surface text-sm text-foreground hover:bg-surface-hover"
          aria-label={
            unread > 0
              ? `${t("Toggle sidebar")} (${tf("Unread messages: {count}", { count: unread })})`
              : t("Toggle sidebar")
          }
        >
          {t("Menu")}
          {unread > 0 && (
            <span
              aria-hidden="true"
              className="absolute -end-2 -top-2 min-w-5 rounded-full bg-accent px-1 text-center text-[11px] font-semibold leading-5 text-accent-foreground"
            >
              {unread}
            </span>
          )}
        </button>
        {back === null ? null : back ? (
          <Link href={back} aria-label={tf("Back")} className={backClass}>
            <BackArrow />
          </Link>
        ) : (
          // No parent page: back to wherever the user came from.
          <button
            type="button"
            onClick={() => (window.history.length > 1 ? router.back() : router.push("/dashboard"))}
            aria-label={tf("Back")}
            className={backClass}
          >
            <BackArrow />
          </button>
        )}
        <h1 className="truncate text-base font-semibold sm:text-lg">
          {moduleKey ? tf(moduleKey) : t(title)}
        </h1>
      </div>

      {instagramAccountCount > 0 ? (
        <p className="shrink-0 truncate text-sm text-muted">
          {instagramAccountCount > 1
            ? t("{count} accounts", { count: instagramAccountCount })
            : `@${instagramUsername}`}
        </p>
      ) : moduleKey ? null : (
        // Not on the Facebook and agency screens: a brand there may have no
        // Instagram account at all, and the button would only mislead.
        <a
          href="/api/instagram/connect"
          className="shrink-0 whitespace-nowrap text-sm font-medium px-3 py-1.5 rounded bg-accent text-accent-foreground hover:bg-accent-hover"
        >
          {/* Full label needs more room than a 360px header has to spare. */}
          <span className="sm:hidden">{t("Connect")}</span>
          <span className="hidden sm:inline">{t("Connect Instagram")}</span>
        </a>
      )}
    </header>
  );
}
