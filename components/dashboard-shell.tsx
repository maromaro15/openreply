"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import Sidebar from "@/components/sidebar";
import TopBar from "@/components/top-bar";
import { useFbI18n } from "@/lib/facebook/i18n/client";
import { CLIENT_HOME, isClientPagePath } from "@/lib/agency/client-paths";

interface DashboardShellProps {
  children: React.ReactNode;
  workspaceName: string;
  instagramUsername: string | null;
  instagramAccountCount: number;
  /** A brand owner (VIEWER): their inbox and statistics only, read only (the server refuses the rest). */
  client?: boolean;
}

export default function DashboardShell({
  children,
  workspaceName,
  instagramUsername,
  instagramAccountCount,
  client = false,
}: DashboardShellProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { t } = useFbI18n();
  const pathname = usePathname();
  const router = useRouter();
  // The layout already redirects on load; this covers moving between pages in the app.
  const offLimits = client && !isClientPagePath(pathname);
  useEffect(() => {
    if (offLimits) router.replace(CLIENT_HOME);
  }, [offLimits, router]);

  return (
    // h-dvh, not h-screen: on mobile browsers the URL bar eats into 100vh, which
    // would push the composer and pagination controls below the fold.
    <div className="flex h-dvh overflow-hidden bg-background">
      <Sidebar
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        workspaceName={workspaceName}
        client={client}
      />

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <TopBar
          onMenuClick={() => setSidebarOpen(true)}
          instagramUsername={instagramUsername}
          instagramAccountCount={instagramAccountCount}
        />

        {/* overflow-x-hidden: enabling vertical scrolling makes the browser
            allow horizontal scrolling too, which lets a wide child drag the
            whole page sideways on a phone. */}
        <main className="flex-1 overflow-y-auto overflow-x-hidden">
          <div className="px-4 lg:px-8 py-5 sm:py-6 max-w-7xl mx-auto">
            {client && (
              <p
                role="status"
                className="mb-4 rounded border border-accent/30 bg-accent/5 px-3 py-2 text-sm text-foreground"
              >
                {t(
                  "Brand owner view: you see your conversations, the ones waiting for a person, and your statistics.",
                )}
              </p>
            )}
            {offLimits ? null : children}
          </div>
        </main>
      </div>
    </div>
  );
}
