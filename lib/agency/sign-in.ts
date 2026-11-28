/**
 * Sign-in for invited brand teams when ALLOWED_EMAILS is set.
 *
 * ALLOWED_EMAILS closes a public instance to everyone else. An agency would
 * otherwise have to add every brand team member to .env, so an address is
 * also let in when an owner or admin invited it:
 *
 *   - a pending invitation for it that has not expired, or
 *   - an ADMIN or MEMBER membership, which only an invitation creates.
 *
 * Owning a workspace does not count. Everyone who ever signed in owns one,
 * so counting it would let back in every account that existed before
 * ALLOWED_EMAILS was set, which is exactly what the variable is for.
 */
import { prisma } from "@/lib/db/client";

export async function isInvitedToAWorkspace(email: string | null | undefined): Promise<boolean> {
  const normalized = email?.trim().toLowerCase();
  if (!normalized) return false;

  const invitation = await prisma.workspaceInvitation.findFirst({
    where: { email: normalized, status: "PENDING", expiresAt: { gt: new Date() } },
    select: { id: true },
  });
  if (invitation) return true;

  const membership = await prisma.workspaceMember.findFirst({
    where: {
      role: { in: ["ADMIN", "MEMBER"] },
      user: { email: { equals: normalized, mode: "insensitive" } },
    },
    select: { id: true },
  });
  return Boolean(membership);
}
