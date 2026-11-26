import { NextResponse, type NextRequest } from "next/server";
import { requireWorkspace } from "@/lib/agency/http";
import { messengerStats, STATS_PERIODS, type StatsPeriod } from "@/lib/facebook/stats";

export const dynamic = "force-dynamic";

/** ?days=7|30 (7 by default). Brand owners read it too. */
export async function GET(request: NextRequest) {
  const context = await requireWorkspace(request, "MEMBER");
  if (context instanceof Response) return context;
  const asked = Number(request.nextUrl.searchParams.get("days"));
  const days: StatsPeriod = (STATS_PERIODS as readonly number[]).includes(asked) ? (asked as StatsPeriod) : 7;
  return NextResponse.json({ success: true, data: await messengerStats(context.workspaceId, days) });
}
