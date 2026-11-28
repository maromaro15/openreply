"use client";

/**
 * Sidebar Navigation
 *
 * Text-only nav with active state and workspace section.
 */

import LanguageSwitcher from "@/components/language-switcher";
import WorkspaceSwitcher from "@/components/agency/workspace-switcher";
import { useFbI18n } from "@/lib/facebook/i18n/client";
import { useI18n } from "@/lib/i18n/provider";
import Link from "next/link";
import Image from "next/image";
import { zernioLink } from "@/lib/zernio-links";
import { usePathname } from "next/navigation";
import { clientNavSections, moduleNavSections, navItems } from "@/lib/navigation";

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
  workspaceName: string;
  client?: boolean;
}

export default function Sidebar({
  isOpen,
  onClose,
  workspaceName,
  client = false,
}: SidebarProps) {
  const { t } = useI18n();
  const { t: tf } = useFbI18n();
  const pathname = usePathname();

  return (
    <>
      {/* Mobile overlay */}
      {isOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/60 lg:hidden"
          onClick={onClose}
        />
      )}

      <aside
        className={`
          fixed top-0 start-0 z-50 h-dvh w-64 max-w-[85vw] shrink-0 bg-surface border-e border-border flex flex-col
          transition-transform duration-200 ease-out
          lg:h-full lg:translate-x-0 lg:rtl:translate-x-0 lg:static lg:z-auto
          ${isOpen ? "translate-x-0" : "-translate-x-full rtl:translate-x-full"}
        `}
      >
        {/* Same reason as the top bar: the drawer is full height, so the
            wordmark would otherwise land under the status bar. */}
        <div
          className="px-6 py-5 border-b border-border"
          style={{ paddingTop: "calc(1.25rem + env(safe-area-inset-top))" }}
        >
          <Link
            href={client ? "/facebook/inbox" : "/dashboard"}
            className="text-base font-semibold"
          >
            Amitec Reply
          </Link>
        </div>

        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
          {!client &&
            navItems.map((item) => {
              const isActive =
                pathname === item.href || pathname.startsWith(item.href + "/");
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={onClose}
                  aria-current={isActive ? "page" : undefined}
                  className={`
                  block px-3 py-2.5 rounded text-sm
                  ${
                    isActive
                      ? "bg-surface-hover text-foreground font-medium"
                      : "text-muted hover:text-foreground hover:bg-surface-hover"
                  }
                `}
                >
                  {t(item.label)}
                </Link>
              );
            })}

          {(client ? clientNavSections : moduleNavSections).map((section) => (
            <div
              key={section.title}
              className={
                client
                  ? "space-y-1"
                  : "mt-4 space-y-1 border-t border-border pt-4"
              }
            >
              <p className="px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">
                {tf(section.title)}
              </p>
              {section.items.map((item) => {
                const isActive =
                  pathname === item.href ||
                  pathname.startsWith(item.href + "/");
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={onClose}
                    aria-current={isActive ? "page" : undefined}
                    className={`
                      block px-3 py-2.5 rounded text-sm
                      ${
                        isActive
                          ? "bg-surface-hover text-foreground font-medium"
                          : "text-muted hover:text-foreground hover:bg-surface-hover"
                      }
                    `}
                  >
                    {tf(item.label)}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="px-5 py-4 border-t border-border">
          <div className="mb-4">
            <LanguageSwitcher />
          </div>
          <WorkspaceSwitcher currentName={workspaceName} />
          {/* Auth.js asks to confirm, then signs out. */}
          <button
            type="button"
            onClick={() => window.location.assign("/api/auth/signout")}
            className="mb-3 block text-xs text-muted hover:text-foreground"
          >
            {tf("Sign out")}
          </button>
          {!client && (
            <>
              <p className="text-xs text-muted">{t("Self-hosted")}</p>
              <a
                href={zernioLink({ placement: "sidebar" })}
                target="_blank"
                rel="sponsored noopener noreferrer"
                className="mt-4 flex items-center gap-3 text-xs text-muted hover:text-foreground"
              >
                <span>{t("Supported by")}</span>
                <Image
                  src="/brand/zernio-primary.svg"
                  alt="Zernio"
                  width={64}
                  height={20}
                  className="m-2"
                />
              </a>
            </>
          )}
        </div>
      </aside>
    </>
  );
}
