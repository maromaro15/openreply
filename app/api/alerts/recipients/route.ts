import { NextResponse, type NextRequest } from "next/server";
import { jsonError, requireWorkspace } from "@/lib/agency/http";
import {
  createRecipient,
  listRecipients,
  MAX_RECIPIENTS,
  recipientSchema,
  serializeRecipient,
} from "@/lib/alerts/settings";

export const dynamic = "force-dynamic";

/** Who gets the brand's alerts. Members see the list; admins change it. */
export async function GET(request: NextRequest) {
  const context = await requireWorkspace(request, "MEMBER");
  if (context instanceof Response) return context;
  const recipients = await listRecipients(context.workspaceId);
  return NextResponse.json({ success: true, data: { recipients: recipients.map(serializeRecipient) } });
}

export async function POST(request: NextRequest) {
  const context = await requireWorkspace(request, "ADMIN");
  if (context instanceof Response) return context;
  const parsed = recipientSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError(400, parsed.error.issues[0]?.message ?? "Invalid recipient");
  const recipient = await createRecipient(context.workspaceId, parsed.data);
  if (!recipient) return jsonError(400, `A brand has ${MAX_RECIPIENTS} recipients at most.`);
  return NextResponse.json({ success: true, data: { recipient: serializeRecipient(recipient) } }, { status: 201 });
}
