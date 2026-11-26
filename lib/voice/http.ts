/**
 * Brand voice routes: the brand's context, and whether this user may edit
 * the global set too.
 */
import { z } from "zod";
import type { WorkspaceRole } from "@/app/generated/prisma/client";
import { requireWorkspace } from "@/lib/agency/http";
import { prisma } from "@/lib/db/client";
import type { WorkspaceContext } from "@/lib/workspace-access";
import { voiceCorrectionSchema, voiceExampleSchema } from "./format";
import { isPlatformAdmin } from "./store";

export async function requireVoice(
  request: Request,
  minimumRole: WorkspaceRole
): Promise<(WorkspaceContext & { platformAdmin: boolean }) | Response> {
  const context = await requireWorkspace(request, minimumRole);
  if (context instanceof Response) return context;
  const user = await prisma.user.findUnique({ where: { id: context.userId }, select: { email: true } });
  return { ...context, platformAdmin: isPlatformAdmin(user?.email) };
}

export const VOICE_KINDS = { examples: "example", corrections: "correction" } as const;
export type VoiceKindSegment = keyof typeof VOICE_KINDS;

export function isVoiceKind(value: string): value is VoiceKindSegment {
  return value === "examples" || value === "corrections";
}

/** What the screen sends: one form per kind, `global` for the global set. */
const { customer, reply } = voiceExampleSchema.shape;
const { wrong, right } = voiceCorrectionSchema.shape;
export const voiceExampleInput = z.object({ customer, reply, global: z.boolean().optional() });
export const voiceCorrectionInput = z.object({ wrong, right, global: z.boolean().optional() });
// Spelled out: a schema default must not fill in a field the patch leaves alone.
export const voiceExamplePatch = z.object({ customer: customer.optional(), reply: reply.optional(), active: z.boolean().optional() });
export const voiceCorrectionPatch = z.object({ wrong: wrong.optional(), right: right.optional(), active: z.boolean().optional() });
