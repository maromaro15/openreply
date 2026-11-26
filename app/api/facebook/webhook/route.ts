import { NextResponse, type NextRequest } from "next/server";
import { getFacebookWebhookVerifyToken } from "@/lib/facebook/env";
import { ingestPageWebhook } from "@/lib/facebook/ingest";
import { verifyPageSignature } from "@/lib/facebook/webhook";
import { FACEBOOK_WEBHOOK_MAX_BYTES, readCappedBody } from "@/lib/limits/capped-body";

// Webhooks are never cached, and the HMAC needs Node's crypto.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Meta's verification handshake when the callback URL is saved. */
export function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const expected = getFacebookWebhookVerifyToken();
  if (
    params.get("hub.mode") === "subscribe" &&
    expected &&
    params.get("hub.verify_token") === expected
  ) {
    return new NextResponse(params.get("hub.challenge") ?? "", {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }
  return NextResponse.json({ success: false, error: "Verification failed" }, { status: 403 });
}

/** A Page event. Verified over the raw bytes, then queued. */
export async function POST(request: NextRequest) {
  // Capped before the signature is checked: anyone can reach this route.
  const raw = await readCappedBody(request, FACEBOOK_WEBHOOK_MAX_BYTES);
  if (!raw) {
    console.warn("[Facebook webhook] Rejected delivery: body too large");
    return NextResponse.json({ success: false, error: "Payload too large" }, { status: 413 });
  }
  const check = verifyPageSignature(raw, request.headers.get("x-hub-signature-256"));
  if (!check.ok) {
    // Logged, not stored: an unsigned request can come from anyone.
    console.warn(`[Facebook webhook] Rejected delivery: ${check.reason} (${raw.length} bytes)`);
    return NextResponse.json({ success: false, error: "Invalid signature" }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(raw).toString("utf8"));
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON" }, { status: 400 });
  }

  try {
    await ingestPageWebhook(payload);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[Facebook webhook] Processing failed:", error instanceof Error ? error.message : error);
    // A 5xx makes Meta deliver it again; job IDs keep that from doubling work.
    return NextResponse.json({ success: false, error: "Webhook processing failed" }, { status: 500 });
  }
}
