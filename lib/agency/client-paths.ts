/**
 * What a brand owner (VIEWER) may open: their inbox (conversations,
 * handoffs) and its statistics, read only. Everything else is refused on the
 * server, not only hidden: requireWorkspace (lib/agency/http.ts) for the
 * API, the dashboard layout for the pages. No imports: the browser uses it too.
 */
export const CLIENT_API_PATHS = ["/api/facebook/conversations", "/api/facebook/stats"];
export const CLIENT_PAGE_PATHS = ["/facebook/inbox", "/facebook/stats"];
export const CLIENT_HOME = "/facebook/inbox";

function under(paths: string[], pathname: string): boolean {
  return paths.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

export function isClientApiPath(pathname: string): boolean {
  return under(CLIENT_API_PATHS, pathname);
}

export function isClientPagePath(pathname: string): boolean {
  return under(CLIENT_PAGE_PATHS, pathname);
}
