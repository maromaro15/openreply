import { NextResponse, type NextRequest } from "next/server";
import { requireWorkspace } from "@/lib/agency/http";
import { isInstanceOperator } from "@/lib/agency/workspaces";
import { getFacebookWorkerAlerts, getFacebookWorkerHealth } from "@/lib/facebook/health";
import { getFacebookQueue } from "@/lib/facebook/queue";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Is the Facebook worker running, and is its queue moving? Everyone sees
 * that; the failures (other brands' job ids and errors) and the worker's
 * host and process id are for the operator of the installation.
 */
export async function GET(request: NextRequest) {
  const context = await requireWorkspace(request, "MEMBER");
  if (context instanceof Response) return context;
  const operator = await isInstanceOperator(context.userId, context.role);

  try {
    const [worker, counts, alerts] = await Promise.all([
      getFacebookWorkerHealth(),
      getFacebookQueue().getJobCounts("waiting", "active", "delayed", "failed"),
      operator ? getFacebookWorkerAlerts(5) : null,
    ]);
    if (operator) return NextResponse.json({ success: true, data: { worker, queue: counts, alerts } });
    // Without the host and the process id.
    const heartbeat = worker.heartbeat && {
      checkedAt: worker.heartbeat.checkedAt,
      ...(worker.heartbeat.startedAt ? { startedAt: worker.heartbeat.startedAt } : {}),
    };
    return NextResponse.json({ success: true, data: { worker: { ...worker, heartbeat }, queue: counts } });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        // A connection error names the Redis host: for the operator only.
        error: operator && error instanceof Error ? error.message : "Redis is not reachable",
        data: { worker: { healthy: false, heartbeat: null, ageMs: null } },
      },
      { status: 503 }
    );
  }
}
