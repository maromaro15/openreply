/**
 * A brand's bot persona, goal, order details and sales playbook, stored on
 * its BotSettings row (phase 11). The texts the model reads are built in
 * ./persona.ts and ./order.ts; this is only what a brand chose.
 *
 * Saved apart from the other bot settings, so neither form can reset the
 * other's fields.
 */
import { z } from "zod";
import type { BotSettings } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import {
  BOT_GOALS,
  DEFAULT_PERSONA,
  goalCollectsOrder,
  parsePersonaSettings,
  PERSONA_LIMITS,
  type CustomerStateValue,
  type PersonaSettings,
} from "./persona";
import { DEFAULT_ORDER_FIELDS, isOrderComplete, ORDER_FIELDS, type OrderDraft, type OrderFieldValue } from "./order";

export interface BotPersonaView {
  persona: PersonaSettings;
  /** In ORDER_FIELDS order, without repeats. */
  orderFields: OrderFieldValue[];
}

type PersonaRow = Pick<
  BotSettings,
  "personaName" | "personaStyle" | "dialect" | "goal" | "goalNotes" | "playbook" | "orderFields"
>;

/** Known fields only, in their fixed order, once each. */
function orderedFields(fields: readonly string[]): OrderFieldValue[] {
  return ORDER_FIELDS.filter((field) => fields.includes(field));
}

export function personaOf(row: PersonaRow | null): BotPersonaView {
  if (!row) return { persona: { ...DEFAULT_PERSONA }, orderFields: [...DEFAULT_ORDER_FIELDS] };
  return {
    persona: {
      personaName: row.personaName,
      personaStyle: row.personaStyle,
      dialect: row.dialect,
      goal: row.goal,
      goalNotes: row.goalNotes,
      playbook: row.playbook,
    },
    orderFields: orderedFields(row.orderFields),
  };
}

/** The form's limits, with room for spaces that cleaning removes. */
const text = (max: number) => z.string().max(max * 2).nullable();

/**
 * The whole persona, as the form sends it. The texts are cleaned by
 * parsePersonaSettings when saved: control characters dropped, names on one
 * line, cut to PERSONA_LIMITS, the default playbook stored as "the default".
 */
export const personaInputSchema = z.object({
  personaName: text(PERSONA_LIMITS.name),
  personaStyle: text(PERSONA_LIMITS.style),
  dialect: text(PERSONA_LIMITS.dialect),
  goal: z.enum(BOT_GOALS),
  goalNotes: text(PERSONA_LIMITS.goalNotes),
  orderFields: z.array(z.enum(ORDER_FIELDS)).max(ORDER_FIELDS.length * 2),
  playbook: z.string().max(PERSONA_LIMITS.playbook).nullable(),
});

export type PersonaInput = z.infer<typeof personaInputSchema>;

const PERSONA_SELECT = {
  personaName: true,
  personaStyle: true,
  dialect: true,
  goal: true,
  goalNotes: true,
  playbook: true,
  orderFields: true,
} as const;

export async function savePersona(workspaceId: string, input: PersonaInput): Promise<BotPersonaView> {
  // The default text, saved unchanged, stays "the default" (null): a brand
  // that never edited it gets the improvements of later versions.
  const persona = parsePersonaSettings(input);
  const data = { ...persona, orderFields: orderedFields(input.orderFields) };
  const row = await prisma.botSettings.upsert({
    where: { workspaceId },
    create: { workspaceId, ...data },
    update: data,
    select: PERSONA_SELECT,
  });
  return personaOf(row);
}

/**
 * Whether a person must now confirm an order: every detail the brand asks
 * for is there and valid. A brand whose bot collects nothing (ANSWER_ONLY,
 * or no detail chosen) hands over as soon as the customer is ready to buy.
 */
export function isOrderReady(
  settings: BotPersonaView,
  state: CustomerStateValue | null,
  draft: OrderDraft | null
): boolean {
  if (goalCollectsOrder(settings.persona.goal) && settings.orderFields.length > 0) {
    return isOrderComplete(draft, settings.orderFields);
  }
  return state === "READY_TO_BUY";
}
