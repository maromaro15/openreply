/**
 * The page path, set by proxy.ts for the dashboard layout, which limits a
 * brand owner to their inbox and statistics. The proxy always overwrites
 * it, so a client cannot set it.
 */
export const PATHNAME_HEADER = "x-amitec-pathname";
