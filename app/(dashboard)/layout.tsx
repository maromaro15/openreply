import { I18nProvider } from "@/lib/i18n/provider";
import { getI18n } from "@/lib/i18n/server";
import { redirect } from "next/navigation";
import DashboardShell from "@/components/dashboard-shell";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { ensureWorkspaceForUser } from "@/lib/workspace";
import { findSelectedMembership } from "@/lib/agency/active-workspace";
import { CLIENT_HOME, isClientPagePath } from "@/lib/agency/client-paths";
import { headers } from "next/headers";
import { PATHNAME_HEADER } from "@/lib/pathname-header";

export async function generateMetadata() {
  const { t } = await getI18n();
  return { title: t("Amitec Reply - Open source Instagram comment-to-DM automation") };
}

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { locale } = await getI18n();
  const session = await auth();

  if (!session?.user?.id) {
    redirect("/login");
  }

  // Still runs first: it accepts pending invitations and creates the first
  // workspace on first sign-in. The brand picked in the switcher wins when
  // the user belongs to it.
  const firstWorkspace = await ensureWorkspaceForUser(
    session.user.id,
    session.user.email
  );
  const workspace =
    (await findSelectedMembership(session.user.id))?.workspace ?? firstWorkspace;
  const membership = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId: workspace.id, userId: session.user.id } },
    select: { role: true },
  });
  // A brand owner sees their inbox and statistics only: any other page sends them there.
  // No path (the proxy did not run) counts as another page.
  const client = membership?.role === "VIEWER";
  if (client && !isClientPagePath((await headers()).get(PATHNAME_HEADER) ?? "")) {
    redirect(CLIENT_HOME);
  }
  const accounts = await prisma.instagramAccount.findMany({
    where: { workspaceId: workspace.id },
    orderBy: { connectedAt: "desc" },
    select: { username: true },
  });

  return (
    <I18nProvider locale={locale}>
      <DashboardShell
        workspaceName={workspace.name}
        instagramUsername={accounts[0]?.username ?? null}
        instagramAccountCount={accounts.length}
        client={client}
      >
        {children}
      </DashboardShell>
    </I18nProvider>
  );
}
