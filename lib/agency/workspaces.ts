/**
 * Brands for an agency: one workspace per client.
 *
 * Everything here starts from the user's own memberships, so a brand team
 * member only ever sees the workspaces they were invited to, and the agency
 * owner sees every brand they created (they are its OWNER).
 */
import type { HandoffCategory, WorkspaceRole } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import { HANDOFF_CATEGORIES } from "@/lib/handoff/categories";

export const BRAND_NAME_MAX = 80;

/** Brands one user may own: a bound on what a single account can fill the database with. */
export const MAX_OWNED_BRANDS = 100;

export class BrandLimitError extends Error {
  constructor() {
    super("Brand limit reached");
    this.name = "BrandLimitError";
  }
}

export interface UserWorkspace {
  id: string;
  name: string;
  role: WorkspaceRole;
  createdAt: Date;
}

/** The workspaces the user belongs to, oldest membership first. */
export async function listUserWorkspaces(userId: string): Promise<UserWorkspace[]> {
  const memberships = await prisma.workspaceMember.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
    select: { role: true, workspace: { select: { id: true, name: true, createdAt: true } } },
  });
  return memberships.map(({ role, workspace }) => ({ ...workspace, role }));
}

function agencyOwnerEmails(): string[] {
  return (process.env.AGENCY_OWNER_EMAILS ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Who may add a brand: someone who owns at least one workspace. An invited
 * brand team member owns none, so they cannot. AGENCY_OWNER_EMAILS, when
 * set, narrows it further to those addresses.
 */
export async function canCreateBrandWorkspace(
  userId: string,
  email: string | null | undefined
): Promise<boolean> {
  const allowed = agencyOwnerEmails();
  if (allowed.length > 0 && !(email && allowed.includes(email.trim().toLowerCase()))) {
    return false;
  }
  const owned = await prisma.workspaceMember.count({ where: { userId, role: "OWNER" } });
  return owned > 0;
}

/**
 * Who runs the whole installation, and so may see what belongs to no single
 * brand (the worker's failures, its host). AGENCY_OWNER_EMAILS when set;
 * otherwise the OWNER of the active workspace, as on a single-operator install.
 */
export async function isInstanceOperator(userId: string, role: WorkspaceRole): Promise<boolean> {
  const allowed = agencyOwnerEmails();
  if (allowed.length === 0) return role === "OWNER";
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
  return Boolean(user?.email && allowed.includes(user.email.trim().toLowerCase()));
}

export function normalizeBrandName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const trimmed = name.replace(/\s+/g, " ").trim();
  if (!trimmed || Array.from(trimmed).length > BRAND_NAME_MAX) return null;
  return trimmed;
}

/** Create a brand workspace with the user as its OWNER. */
export async function createBrandWorkspace(userId: string, name: string) {
  const normalized = normalizeBrandName(name);
  if (!normalized) throw new Error("Invalid brand name");
  // Counted before the insert, like the other caps: a rare tie may pass.
  const owned = await prisma.workspaceMember.count({ where: { userId, role: "OWNER" } });
  if (owned >= MAX_OWNED_BRANDS) throw new BrandLimitError();
  return prisma.workspace.create({
    data: {
      name: normalized,
      ownerId: userId,
      members: { create: { userId, role: "OWNER" } },
    },
    select: { id: true, name: true, createdAt: true },
  });
}

export interface WorkspaceSummary {
  facebookPages: number;
  instagramAccounts: number;
  activeCampaigns: number;
  members: number;
  needsHuman: number;
  needsHumanByCategory: Partial<Record<HandoffCategory, number>>;
  lastActivityAt: Date | null;
}

function emptySummary(): WorkspaceSummary {
  return {
    facebookPages: 0,
    instagramAccounts: 0,
    activeCampaigns: 0,
    members: 0,
    needsHuman: 0,
    needsHumanByCategory: {},
    lastActivityAt: null,
  };
}

/**
 * Counts for the agency overview. Callers pass only workspace IDs the user
 * belongs to (from listUserWorkspaces); nothing here checks membership.
 */
export async function getWorkspaceSummaries(
  workspaceIds: string[]
): Promise<Record<string, WorkspaceSummary>> {
  const summaries: Record<string, WorkspaceSummary> = {};
  for (const id of workspaceIds) summaries[id] = emptySummary();
  if (workspaceIds.length === 0) return summaries;

  const inWorkspaces = { workspaceId: { in: workspaceIds } };
  const [pages, instagram, campaigns, members, handoffs, activity] = await Promise.all([
    prisma.facebookPage.groupBy({
      by: ["workspaceId"],
      where: { ...inWorkspaces, status: { not: "DISCONNECTED" } },
      _count: { _all: true },
    }),
    prisma.instagramAccount.groupBy({
      by: ["workspaceId"],
      where: inWorkspaces,
      _count: { _all: true },
    }),
    prisma.facebookCampaign.groupBy({
      by: ["workspaceId"],
      where: { ...inWorkspaces, isActive: true },
      _count: { _all: true },
    }),
    prisma.workspaceMember.groupBy({
      by: ["workspaceId"],
      where: inWorkspaces,
      _count: { _all: true },
    }),
    prisma.facebookConversation.groupBy({
      by: ["workspaceId", "handoffCategory"],
      where: { ...inWorkspaces, needsHuman: true },
      _count: { _all: true },
    }),
    prisma.facebookConversation.groupBy({
      by: ["workspaceId"],
      where: inWorkspaces,
      _max: { lastMessageAt: true },
    }),
  ]);

  for (const row of pages) summaries[row.workspaceId].facebookPages = row._count._all;
  for (const row of instagram) summaries[row.workspaceId].instagramAccounts = row._count._all;
  for (const row of campaigns) summaries[row.workspaceId].activeCampaigns = row._count._all;
  for (const row of members) summaries[row.workspaceId].members = row._count._all;
  for (const row of handoffs) {
    const summary = summaries[row.workspaceId];
    summary.needsHuman += row._count._all;
    const category = row.handoffCategory ?? "OTHER";
    summary.needsHumanByCategory[category] =
      (summary.needsHumanByCategory[category] ?? 0) + row._count._all;
  }
  for (const row of activity) summaries[row.workspaceId].lastActivityAt = row._max.lastMessageAt;

  // A stable order for the UI: the categories as declared, then nothing else.
  for (const summary of Object.values(summaries)) {
    const ordered: Partial<Record<HandoffCategory, number>> = {};
    for (const category of HANDOFF_CATEGORIES) {
      if (summary.needsHumanByCategory[category]) {
        ordered[category] = summary.needsHumanByCategory[category];
      }
    }
    summary.needsHumanByCategory = ordered;
  }
  return summaries;
}
