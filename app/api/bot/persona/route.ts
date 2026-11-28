import { NextResponse, type NextRequest } from "next/server";
import { jsonError, requireWorkspace } from "@/lib/agency/http";
import { getBotSettings } from "@/lib/bot/knowledge";
import { DEFAULT_PLAYBOOK, PERSONA_LIMITS } from "@/lib/bot/persona";
import { personaInputSchema, savePersona } from "@/lib/bot/persona-store";

export const dynamic = "force-dynamic";

/** The bot's persona, goal, order details and playbook, with the default playbook to start from. */
export async function GET(request: NextRequest) {
  const context = await requireWorkspace(request, "MEMBER");
  if (context instanceof Response) return context;
  const settings = await getBotSettings(context.workspaceId);
  return NextResponse.json({
    success: true,
    data: {
      role: context.role,
      persona: settings.persona,
      orderFields: settings.orderFields,
      defaultPlaybook: DEFAULT_PLAYBOOK,
      limits: PERSONA_LIMITS,
    },
  });
}

/** The whole persona: every field, as the form sends it. */
export async function PUT(request: NextRequest) {
  const context = await requireWorkspace(request, "ADMIN");
  if (context instanceof Response) return context;
  const parsed = personaInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError(400, parsed.error.issues[0]?.message ?? "Invalid persona");
  const saved = await savePersona(context.workspaceId, parsed.data);
  return NextResponse.json({ success: true, data: saved });
}
