/**
 * Messenger inbox of the active brand. Alert links open it on one
 * conversation, switching brand first when needed (lib/facebook/inbox-link).
 */
import MessengerInbox from "@/components/facebook/messenger-inbox";
import { aiReplyOff } from "@/lib/facebook/ai-reply-status";
import { resolveInboxLink } from "@/lib/facebook/inbox-link";
import { getCurrentWorkspaceContext, hasWorkspaceRole } from "@/lib/workspace-access";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function FacebookInboxPage({ searchParams }: { searchParams: SearchParams }) {
  const context = await getCurrentWorkspaceContext();
  const link = await resolveInboxLink(await searchParams, context);
  return (
    <MessengerInbox
      {...link}
      viewOnly={context?.role === "VIEWER"}
      canManage={context ? hasWorkspaceRole(context.role, "ADMIN") : false}
      // While a link switches brand, this brand's state would be the wrong one.
      aiReplyOff={context && !link.switchToWorkspaceId ? await aiReplyOff(context.workspaceId) : null}
    />
  );
}
