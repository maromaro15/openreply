import { NextResponse, type NextRequest } from "next/server";
import { requireWorkspace } from "@/lib/agency/http";
import { getFacebookWorkerAlerts, getFacebookWorkerHealth } from "@/lib/facebook/health";
import { getFacebookQueue } from "@/lib/facebook/queue";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Is the Facebook worker running, and is its queue moving? */
export async function GET(request: NextRequest) {
  const context = await requireWorkspace(request, "MEMBER");
  if (context instanceof Response) return context;

  try {
    const [worker, counts, alerts] = await Promise.all([
      getFacebookWorkerHealth(),
      getFacebookQueue().getJobCounts("waiting", "active", "delayed", "failed"),
      getFacebookWorkerAlerts(5),
    ]);
    return NextResponse.json({ success: true, data: { worker, queue: counts, alerts } });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Redis is not reachable",
        data: { worker: { healthy: false, heartbeat: null, ageMs: null } },
      },
      { status: 503 }
    );
  }
}
