/**
 * Shared guards for the API routes of the new modules (agency, Facebook,
 * bot, alerts).
 */
import { NextResponse } from "next/server";
import type { WorkspaceRole } from "@/app/generated/prisma/client";
import {
  getCurrentWorkspaceContext,
  hasWorkspaceRole,
  type WorkspaceContext,
} from "@/lib/workspace-access";

export function jsonError(status: number, error: string) {
  return NextResponse.json({ success: false, error }, { status });
}

/**
 * Cross-site request check for state-changing requests. Browsers send
 * Origin on every POST, PATCH and DELETE; it must be this app. Behind a
 * TLS-terminating proxy request.url is http://, so the public NEXTAUTH_URL
 * and the forwarded host are accepted too (same rule as the Zernio routes).
 * A request without Origin is not from a browser form and is allowed.
 */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  const allowed = new Set<string>([new URL(request.url).origin]);
  if (process.env.NEXTAUTH_URL) {
    try {
      allowed.add(new URL(process.env.NEXTAUTH_URL).origin);
    } catch {
      // A malformed NEXTAUTH_URL adds nothing.
    }
  }
  const forwardedHost = request.headers.get("x-forwarded-host");
  if (forwardedHost) {
    allowed.add(`${request.headers.get("x-forwarded-proto") ?? "https"}://${forwardedHost}`);
  }
  return allowed.has(origin);
}

/**
 * The signed-in user's active workspace, with a role check. Returns a
 * Response to send back when the request is not allowed.
 */
export async function requireWorkspace(
  request: Request,
  minimumRole: WorkspaceRole = "MEMBER"
): Promise<WorkspaceContext | Response> {
  if (request.method !== "GET" && request.method !== "HEAD" && !isSameOrigin(request)) {
    return jsonError(403, "Invalid request origin.");
  }
  const context = await getCurrentWorkspaceContext();
  if (!context) return jsonError(401, "Unauthorized");
  if (!hasWorkspaceRole(context.role, minimumRole)) {
    return jsonError(403, "Only workspace owners and admins can do this.");
  }
  return context;
}
