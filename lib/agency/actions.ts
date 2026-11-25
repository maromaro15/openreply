"use server";

import { cookies } from "next/headers";
import { getCurrentUserId } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import {
  ACTIVE_WORKSPACE_COOKIE,
  ACTIVE_WORKSPACE_COOKIE_OPTIONS,
  isWorkspaceId,
} from "./active-workspace";

export type SelectWorkspaceResult =
  | { ok: true }
  | { ok: false; error: "unauthorized" | "invalid" | "not_a_member" };

/**
 * Switch the brand the dashboard works in. The ID comes from the browser, so
 * it is checked against the user's memberships before it is stored; the
 * readers check again on every request.
 */
export async function selectWorkspace(workspaceId: string): Promise<SelectWorkspaceResult> {
  const userId = await getCurrentUserId();
  if (!userId) return { ok: false, error: "unauthorized" };
  if (!isWorkspaceId(workspaceId)) return { ok: false, error: "invalid" };

  const membership = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    select: { id: true },
  });
  if (!membership) return { ok: false, error: "not_a_member" };

  (await cookies()).set(ACTIVE_WORKSPACE_COOKIE, workspaceId, {
    ...ACTIVE_WORKSPACE_COOKIE_OPTIONS,
    secure: process.env.NODE_ENV === "production",
  });
  return { ok: true };
}
