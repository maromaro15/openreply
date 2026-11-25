/**
 * Messenger inbox of the active brand. Alert links open it on one
 * conversation, switching brand first when needed (lib/facebook/inbox-link).
 */
import MessengerInbox from "@/components/facebook/messenger-inbox";
import { resolveInboxLink } from "@/lib/facebook/inbox-link";
import { getCurrentWorkspaceContext } from "@/lib/workspace-access";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function FacebookInboxPage({ searchParams }: { searchParams: SearchParams }) {
  const link = await resolveInboxLink(await searchParams, await getCurrentWorkspaceContext());
  return <MessengerInbox {...link} />;
}
