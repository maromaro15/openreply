/**
 * The menu's pages, and where the header's back arrow goes from any other
 * page. No imports but types: the browser and the tests use it.
 */
import type { FbStaticKey } from "@/lib/facebook/i18n";

export const navItems = [
  { label: "Dashboard", href: "/dashboard" },
  { label: "Overview", href: "/overview" },
  { label: "Inbox", href: "/inbox" },
  { label: "Campaigns", href: "/campaigns" },
  { label: "DM Logs", href: "/logs" },
  { label: "Settings", href: "/settings" },
  { label: "API & MCP", href: "/integrations" },
  { label: "Diagnostics", href: "/diagnostics" },
] as const;

// Screens of the agency and Facebook modules. Their copy lives in
// lib/facebook/i18n, so the existing catalogs need no new keys.
export const moduleNavSections: {
  title: FbStaticKey;
  items: { label: FbStaticKey; href: string }[];
}[] = [
  {
    title: "Facebook",
    items: [
      { label: "Inbox", href: "/facebook/inbox" },
      { label: "Campaigns", href: "/facebook/campaigns" },
      { label: "Products", href: "/facebook/products" },
      { label: "Statistics", href: "/facebook/stats" },
      { label: "Knowledge base", href: "/facebook/knowledge" },
      { label: "Brand voice", href: "/facebook/voice" },
      { label: "Alerts", href: "/facebook/alerts" },
      { label: "Pages", href: "/facebook/pages" },
    ],
  },
  { title: "Agency", items: [{ label: "Brands", href: "/agency" }] },
];

// A brand owner (VIEWER): their inbox and statistics, nothing of the agency's.
export const clientNavSections: typeof moduleNavSections = [
  {
    title: "Facebook",
    items: [
      { label: "Inbox", href: "/facebook/inbox" },
      { label: "Statistics", href: "/facebook/stats" },
    ],
  },
];

/** The Messenger inbox, where the unread badge goes. */
export const MESSENGER_INBOX_PATH = "/facebook/inbox";

const MENU_PATHS = new Set<string>([
  ...navItems.map((item) => item.href),
  ...moduleNavSections.flatMap((section) => section.items.map((item) => item.href)),
]);

/**
 * Where the back arrow leads: null on a menu page (no arrow), the parent
 * page otherwise (one segment up: /campaigns/x/edit goes to /campaigns/x),
 * "" when there is no parent page and only the browser history can tell.
 */
export function backTarget(pathname: string): string | null {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (MENU_PATHS.has(path)) return null;
  return path.replace(/\/[^/]+$/, "");
}
