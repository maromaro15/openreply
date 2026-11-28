/**
 * The workspace (brand) a user is working in.
 *
 * Each brand is its own workspace. A user who belongs to several, typically
 * the agency owner, picks one with the switcher, and the choice is kept in a
 * cookie. The cookie is only a preference: it is honoured only when the user
 * is a member of that workspace, so a stale or forged value grants nothing
 * and the caller falls back to the user's first workspace, which is how the
 * app chose before brands could be switched.
 *
 * Only Prisma and next/headers are imported here, so lib/auth.ts and
 * lib/workspace-access.ts can use it without an import cycle.
 */
import { cookies } from "next/headers";
import { prisma } from "@/lib/db/client";

export const ACTIVE_WORKSPACE_COOKIE = "openreply-workspace";

/** Workspace IDs are cuids; anything else in the cookie is ignored unread. */
const WORKSPACE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function isWorkspaceId(value: unknown): value is string {
  return typeof value === "string" && WORKSPACE_ID.test(value);
}

/** The workspace ID the cookie asks for, or null. Never throws. */
export async function readSelectedWorkspaceId(): Promise<string | null> {
  try {
    const value = (await cookies()).get(ACTIVE_WORKSPACE_COOKIE)?.value;
    return isWorkspaceId(value) ? value : null;
  } catch {
    // Outside a request (the worker, scripts, tests) there is no selection.
    return null;
  }
}

/**
 * The user's membership in the selected workspace, with the workspace, or
 * null when nothing is selected or the user is not a member of it.
 */
export async function findSelectedMembership(userId: string) {
  const workspaceId = await readSelectedWorkspaceId();
  if (!workspaceId) return null;
  return prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    include: { workspace: true },
  });
}

export const ACTIVE_WORKSPACE_COOKIE_OPTIONS = {
  path: "/",
  maxAge: 60 * 60 * 24 * 365,
  sameSite: "lax" as const,
  httpOnly: true,
};
