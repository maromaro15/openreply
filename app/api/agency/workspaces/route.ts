import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import {
  ACTIVE_WORKSPACE_COOKIE,
  ACTIVE_WORKSPACE_COOKIE_OPTIONS,
  findSelectedMembership,
} from "@/lib/agency/active-workspace";
import { isSameOrigin, jsonError } from "@/lib/agency/http";
import {
  BrandLimitError,
  canCreateBrandWorkspace,
  createBrandWorkspace,
  getWorkspaceSummaries,
  listUserWorkspaces,
  normalizeBrandName,
} from "@/lib/agency/workspaces";

// The list changes as brands are added and switched: never cache it.
export const dynamic = "force-dynamic";

/**
 * The brands the signed-in user belongs to. `?view=stats` adds the agency
 * overview counts; without it the answer stays light for the switcher.
 */
export async function GET(request: NextRequest) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return jsonError(401, "Unauthorized");

  const [workspaces, canCreate, selected] = await Promise.all([
    listUserWorkspaces(userId),
    canCreateBrandWorkspace(userId, session.user?.email),
    findSelectedMembership(userId),
  ]);
  const withStats = request.nextUrl.searchParams.get("view") === "stats";
  const summaries = withStats ? await getWorkspaceSummaries(workspaces.map((w) => w.id)) : null;

  return NextResponse.json({
    success: true,
    data: {
      // Same resolution as the rest of the app: the selection, else the first.
      activeWorkspaceId: selected?.workspaceId ?? workspaces[0]?.id ?? null,
      canCreate,
      workspaces: workspaces.map((workspace) => ({
        ...workspace,
        summary: summaries?.[workspace.id] ?? null,
      })),
    },
  });
}

/** Add a brand: a new workspace owned by the user, then switch to it. */
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return jsonError(403, "Invalid request origin.");

  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return jsonError(401, "Unauthorized");
  if (!(await canCreateBrandWorkspace(userId, session.user?.email))) {
    return jsonError(403, "Only someone who owns a workspace can add brands.");
  }

  const body = (await request.json().catch(() => null)) as { name?: unknown } | null;
  const name = normalizeBrandName(body?.name);
  if (!name) return jsonError(400, "A brand name of 1 to 80 characters is required.");

  let workspace: Awaited<ReturnType<typeof createBrandWorkspace>>;
  try {
    workspace = await createBrandWorkspace(userId, name);
  } catch (error) {
    if (error instanceof BrandLimitError) return jsonError(403, "You have reached the maximum number of brands.");
    throw error;
  }
  (await cookies()).set(ACTIVE_WORKSPACE_COOKIE, workspace.id, {
    ...ACTIVE_WORKSPACE_COOKIE_OPTIONS,
    secure: process.env.NODE_ENV === "production",
  });
  return NextResponse.json({ success: true, data: { workspace } }, { status: 201 });
}
