/**
 * The inbox link carried by alerts: `/facebook/inbox?workspace=<id>&conversation=<id>`.
 *
 * Opened by someone working in another brand, it first switches to the
 * link's brand, but only when they belong to it. The switch itself happens
 * in the browser (only the server action may set the cookie); this decides
 * whether to ask for it.
 */
import { isWorkspaceId } from "@/lib/agency/active-workspace";
import { prisma } from "@/lib/db/client";

export interface InboxLinkState {
  initialConversationId: string | null;
  switchToWorkspaceId: string | null;
  /** The link is for a brand the user is not a member of. */
  linkForeign: boolean;
}

function first(value: string | string[] | undefined): string | null {
  const one = Array.isArray(value) ? value[0] : value;
  return one && one.length <= 64 ? one : null;
}

export async function resolveInboxLink(
  params: Record<string, string | string[] | undefined>,
  context: { userId: string; workspaceId: string } | null
): Promise<InboxLinkState> {
  const conversationId = first(params.conversation);
  const linkWorkspaceId = first(params.workspace);
  if (!context || !linkWorkspaceId || linkWorkspaceId === context.workspaceId) {
    return { initialConversationId: conversationId, switchToWorkspaceId: null, linkForeign: false };
  }

  const member =
    isWorkspaceId(linkWorkspaceId) &&
    (await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: linkWorkspaceId, userId: context.userId } },
      select: { id: true },
    }));
  if (!member) {
    // Nothing of that brand is opened, not even by ID.
    return { initialConversationId: null, switchToWorkspaceId: null, linkForeign: true };
  }
  return { initialConversationId: conversationId, switchToWorkspaceId: linkWorkspaceId, linkForeign: false };
}
