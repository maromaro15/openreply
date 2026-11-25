import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { jsonError, requireWorkspace } from "@/lib/agency/http";
import { FacebookApiError, getPagePosts } from "@/lib/facebook/graph";
import { pageToken } from "@/lib/facebook/pages";

type RouteProps = { params: Promise<{ id: string }> };

export const dynamic = "force-dynamic";

/** Recent posts of a connected Page, for the campaign post picker. */
export async function GET(request: NextRequest, { params }: RouteProps) {
  const context = await requireWorkspace(request, "MEMBER");
  if (context instanceof Response) return context;
  const { id } = await params;

  const page = await prisma.facebookPage.findFirst({
    where: { id, workspaceId: context.workspaceId, status: { not: "DISCONNECTED" } },
    select: { pageId: true, accessToken: true },
  });
  if (!page) return jsonError(404, "Page not found.");

  try {
    const posts = await getPagePosts(page.pageId, pageToken(page), 25);
    return NextResponse.json({
      success: true,
      data: {
        posts: posts.map((post) => ({
          id: post.id,
          message: post.message ?? "",
          createdTime: post.created_time ?? null,
          permalink: post.permalink_url ?? null,
          picture: post.full_picture ?? null,
        })),
      },
    });
  } catch (error) {
    const message = error instanceof FacebookApiError ? error.message : "Could not load posts.";
    return jsonError(502, message);
  }
}
