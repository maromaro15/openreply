import type { NextRequest } from "next/server";
import { readSource, startSource } from "../shared";
import { rejectViewer } from "@/lib/agency/http";

export const dynamic = "force-dynamic";

/** `?facebookPageId=`: the state of this Page's last posts run (idle, running, done or failed) and what it did. */
export async function GET(request: NextRequest) {
  return readSource(request, "posts");
}

/** `{ facebookPageId, limit? }`: start a run reading the Page's posts into drafts; an active run is joined. */
export async function POST(request: NextRequest) {
  const viewOnly = await rejectViewer();
  if (viewOnly) return viewOnly;
  return startSource(request, "posts");
}
