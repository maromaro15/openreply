/**
 * Who the bot is, what it is for and how it sells (PLAN.md 6.16): the
 * sections of the system instruction built from a brand's persona settings,
 * the customer's state the model reports with every answer, and the default
 * sales playbook.
 *
 * The strict rules stay above all of this and are written elsewhere
 * (lib/bot/prompt.ts), as is the ORDER DETAILS section (lib/bot/order.ts):
 * here it is only named.
 *
 * The brand's values are data. A name, a style and a dialect stay on one
 * line, after their label; the lines of the goal notes and of a playbook
 * stay indented under theirs, without a leading "#". No value starts a line
 * of the prompt, so none can open a section or pass for a rule.
 *
 * Pure functions: no database, no network, no environment.
 */

export const BOT_GOALS = ["SELL", "COLLECT_ORDER", "COLLECT_INFO", "ANSWER_ONLY"] as const;
export type BotGoalValue = (typeof BOT_GOALS)[number];

export const CUSTOMER_STATES = [
  "NEUTRAL",
  "PRICE_ONLY",
  "HESITANT",
  "READY_TO_BUY",
  "ANGRY",
  "WHOLESALE",
  "CUSTOM_ORDER",
] as const;
export type CustomerStateValue = (typeof CUSTOMER_STATES)[number];

/** In UTF-16 units, as zod counts them (a database counts fewer or as many). */
export const PERSONA_LIMITS = { name: 80, style: 300, dialect: 80, goalNotes: 1000, playbook: 8000 } as const;

export interface PersonaSettings {
  /** How the bot introduces itself, e.g. "ليلى من فريق Maison Lina". */
  personaName: string | null;
  /** e.g. "chaleureuse, courte, tutoie". */
  personaStyle: string | null;
  /** null: the bot follows the customer's language, dialect and script. */
  dialect: string | null;
  goal: BotGoalValue;
  goalNotes: string | null;
  /** null: DEFAULT_PLAYBOOK. */
  playbook: string | null;
}

export const DEFAULT_PERSONA: PersonaSettings = Object.freeze({
  personaName: null,
  personaStyle: null,
  dialect: null,
  goal: "SELL",
  goalNotes: null,
  playbook: null,
});

// ─── The goal ───────────────────────────────────────────────────────────────

/** What each goal asks, and whether the bot collects the ORDER DETAILS for it. */
const GOALS: Record<BotGoalValue, { collectsOrder: boolean; text: string }> = {
  SELL: {
    collectsOrder: true,
    text: "Sell: help the customer choose what fits them and buy it. When they are ready to buy, collect the ORDER DETAILS.",
  },
  COLLECT_ORDER: {
    collectsOrder: true,
    text: "Take the order: move toward it early. As soon as the customer shows interest, start collecting the ORDER DETAILS.",
  },
  COLLECT_INFO: {
    collectsOrder: true,
    text: "Collect the customer's details: gather the ORDER DETAILS so the team can call them back, even before they decide.",
  },
  ANSWER_ONLY: {
    collectsOrder: false,
    text: "Answer questions only. When the customer wants to order, collect nothing: tell them that a person from the shop will confirm the order with them, without saying when, and set customer_state to READY_TO_BUY.",
  },
};

/** A goal as stored or sent, in any case; anything else is SELL. */
function toGoal(value: unknown): BotGoalValue {
  const goal = typeof value === "string" ? value.trim().toUpperCase() : "";
  return (BOT_GOALS as readonly string[]).includes(goal) ? (goal as BotGoalValue) : "SELL";
}

/** Whether the bot collects the ORDER DETAILS: every goal but ANSWER_ONLY. */
export function goalCollectsOrder(goal: BotGoalValue): boolean {
  return GOALS[toGoal(goal)].collectsOrder;
}

// ─── The customer's state ───────────────────────────────────────────────────
// No digit and no amount here either: the model must not pick one up.

export const CUSTOMER_STATE_GUIDE: Record<CustomerStateValue, string> = Object.freeze({
  NEUTRAL:
    "no sign yet of interest, doubt or a decision: a greeting, a general question or a question about the shop («السلام عليكم», «vous êtes où ?»)",
  PRICE_ONLY: "asks the price and nothing else, often in a word or two, without saying what they need («بشحال؟», «prix svp»)",
  HESITANT:
    "interested but not decided: compares, doubts the quality, the size or the price, or wants to think about it («نخمم ونرجعلك», «j'hésite»)",
  READY_TO_BUY:
    "has decided: asks how to order, or gives a colour, a quantity, a wilaya, a name or a phone number («نحب نكوموندي», «je le prends»)",
  ANGRY: "upset or complaining: a late or wrong order, the quality, no answer, harsh words («راني زعفان», «c'est inadmissible»)",
  WHOLESALE: "wants large quantities, or prices for resellers or a shop («بالجملة», «en gros»)",
  CUSTOM_ORDER:
    "wants something the knowledge base and the catalog do not have, or made to measure: another size, colour, design or print («على المقاس», «sur mesure»)",
});

/** When several states fit, the first of these: the one the team most needs to see. */
const STATE_PRIORITY: readonly CustomerStateValue[] = [
  "ANGRY",
  "WHOLESALE",
  "CUSTOM_ORDER",
  "READY_TO_BUY",
  "HESITANT",
  "PRICE_ONLY",
  "NEUTRAL",
];

/** The description of the `customer_state` field of the model's JSON answer. */
export function customerStateDescription(): string {
  return `the customer's state now, judged from their latest messages in the light of the whole conversation (see THE CUSTOMER'S STATE); set it in every answer, a handoff included; when several fit, the first of ${STATE_PRIORITY.join(", ")}`;
}

// ─── The default playbook ───────────────────────────────────────────────────
// Instructions in English, examples in Algerian Darija and in French. No
// digit, no price, no promise and no pressure in any example: the guard reads
// the replies, and nothing here may tempt the model to write a number. One
// line per step, no blank line and no "#", so the prompt shows it unchanged.

export const DEFAULT_PLAYBOOK = [
  "Chat like a good shop assistant: listen first, ask, then advise with the true facts of the knowledge base and the catalog. YOUR GOAL says how far to go. One technique per message, never a script, never pressure.",
  "NEUTRAL: answer, then ask at most one useful question about what they need: «واش راك تحوس بالضبط؟» / «Vous cherchez quoi exactement ?»",
  "PRICE_ONLY: give the price first, exactly as the knowledge base or the catalog writes it; never hide it, delay it or hold it back for an answer. Then ask one light question about their need or project (NEPQ): «للصالون ولا لبيت الرقاد؟» / «C'est pour quelle pièce ?»",
  "NEUTRAL or HESITANT, and they do not know what to choose: Jobs To Be Done. Find why they buy: nobody wants wallpaper for its own sake, they want to hide damp or renew a room cheaply. Ask about that job («تحب تخبي الرطوبة ولا تجدد الصالون؟», «للعرس ولا للخدمة؟» / «C'est pour cacher l'humidité ou pour changer de déco ?»), then suggest the product of the catalog that does it best, with its real strengths, and compare honestly with the card's comparisons and alternatives.",
  "HESITANT: find what holds them back, then let them convince themselves.",
  "- Chris Voss, tactical empathy: label the feeling («يبانلي راك شاك في الجودة»), mirror their last words as a question (they write «غالية شوية», you answer «غالية شوية؟»), or ask a calibrated question that starts with «كيفاش» or «واش», «comment» or «qu'est-ce que»: «واش اللي شاغلك فيها؟» / «Qu'est-ce qui vous fait hésiter ?»",
  "- NEPQ (Jeremy Miner): questions that let them convince themselves, one per message: their situation now («واش راك تستعمل درك؟»), what bothers them in it («واش اللي ما عجبكش فيه؟»), what they want instead («كيفاش تحبها تكون؟») and what would change once it is solved («وكي تتهنى منها، واش يتبدل؟» / «Qu'est-ce que ça changerait pour vous ?»). Their answers, not your arguments, do the selling.",
  "- If they found it cheaper elsewhere, never lower the price or run down other shops: label it («يبانلي السومة هي اللي حابستك») and give the real differences written on the card.",
  "- If they want to think about it («نخمم ونرجعلك»), respect it and do not chase: «على راحتك» / «Prenez votre temps.»",
  "READY_TO_BUY: follow YOUR GOAL. When it collects the ORDER DETAILS, do it in as few messages as possible: two or three details in one question («شحال من حبة، وأنهي لون؟» / «Combien de pièces, et quelle couleur ?»), with the obvious answer suggested, such as the colour they asked about («نحطلك الأزرق اللي سقسيت عليه؟» / «Je vous mets le bleu que vous avez demandé ?»). Never ask again for a detail they gave. Once everything is there, confirm the summary once: «كلش صحيح؟» / «C'est bien ça ?»",
  "ANGRY: follow HEARD.",
  "- Hear: let them say everything, without arguing or defending the shop. If it is unclear, ask what happened: «واش صرا بالضبط؟» / «Qu'est-ce qui s'est passé ?»",
  "- Empathize: label the feeling (Chris Voss): «يبانلي راك مقلق على التوصيل».",
  "- Apologize, short and sincere, without admitting what you do not know: «سمحلنا على هذا، نفهمك» / «Désolé pour ce désagrément, je vous comprends.»",
  "- Resolve only with what the knowledge base says (delivery times, exchange policy), exactly as written.",
  "- Diagnose: if the knowledge base does not resolve it, or they stay angry, hand off with COMPLAINT and say in reason what went wrong, so the team can fix the cause.",
  "WHOLESALE and CUSTOM_ORDER: hand off as the strict rules say, with the category WHOLESALE_ORDER or CUSTOM_ORDER.",
  "Cialdini (social proof, authority, scarcity, reciprocity, commitment, liking): only with a true fact written in the knowledge base or the catalog; otherwise never. Social proof: reviews or best sellers written there. Authority: a certification, an origin or a guarantee written there. Scarcity: a stock or a deadline written there. Reciprocity: a useful tip from the card, before they ask. Commitment: recall what they told you they need. Liking: be warm, and praise a choice only for a reason on its card.",
].join("\n");

/** The brand's playbook when it has one, else DEFAULT_PLAYBOOK. */
export function effectivePlaybook(settings: Pick<PersonaSettings, "playbook">): string {
  const playbook = settings?.playbook;
  return typeof playbook === "string" && playbook.trim() ? playbook : DEFAULT_PLAYBOOK;
}

// ─── Cleaning the brand's values ────────────────────────────────────────────

const LINE_BREAK = /\r\n|[\n\r\v\f\u0085\u2028\u2029]/;
/** Control characters but tab and line breaks: NUL alone makes Postgres refuse a text. */
const CONTROL = /[\u0000-\u0008\u000e-\u001f\u007f-\u0084\u0086-\u009f]/g;

const graphemes = new Intl.Segmenter("ar", { granularity: "grapheme" });

/** At most `max` UTF-16 units, in whole graphemes: an emoji or a letter with its harakat is never split. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  let kept = "";
  for (const { segment } of graphemes.segment(text)) {
    if (kept.length + segment.length > max) break;
    kept += segment;
  }
  return kept;
}

/** One line: the lines trimmed and joined with " / ", spaces collapsed. */
function oneLine(value: string): string {
  return value
    .replace(CONTROL, "")
    .split(LINE_BREAK)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" / ");
}

function lineField(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const line = oneLine(value);
  // A cut can end on the separator of two lines: "Lina /".
  const text = line.length > max ? cut(line, max).replace(/[\s/]+$/, "") : line;
  return text || null;
}

/** A text of several lines as stored: "\n" between lines, no trailing spaces. */
function textField(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value
    .replace(CONTROL, "")
    .split(LINE_BREAK)
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
  return cut(text, max).trimEnd() || null;
}

/**
 * The settings as stored, from anything (a request body, a database row):
 * strings trimmed and cut to PERSONA_LIMITS, the name, the style and the
 * dialect on one line, an unknown goal read as SELL, empty values and wrong
 * types as null. A playbook saved unchanged from DEFAULT_PLAYBOOK is stored
 * as null, so it keeps following the default.
 */
export function parsePersonaSettings(value: unknown): PersonaSettings {
  const input: Record<string, unknown> =
    value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const playbook = textField(input.playbook, PERSONA_LIMITS.playbook);
  return {
    personaName: lineField(input.personaName, PERSONA_LIMITS.name),
    personaStyle: lineField(input.personaStyle, PERSONA_LIMITS.style),
    dialect: lineField(input.dialect, PERSONA_LIMITS.dialect),
    goal: toGoal(input.goal),
    goalNotes: textField(input.goalNotes, PERSONA_LIMITS.goalNotes),
    playbook: playbook === DEFAULT_PLAYBOOK ? null : playbook,
  };
}

// ─── The sections ───────────────────────────────────────────────────────────

const INDENT = "  ";

/**
 * A brand's text of several lines as the prompt shows it: each line trimmed
 * and indented, without the "#" that would make it a heading; empty lines
 * dropped, so a section stays one block.
 */
function indentedLines(text: string): string[] {
  return text
    .split(LINE_BREAK)
    .map((line) => line.trim().replace(/^[#＃\s]+/u, ""))
    .filter(Boolean)
    .map((line) => INDENT + line);
}

function section(title: string, lines: string[]): string {
  return [`## ${title}`, ...lines].join("\n");
}

function whoYouAre(persona: PersonaSettings): string[] {
  const lines = [
    "You are the shop's assistant on Messenger, not a person: never claim or suggest that you are a human. If the customer asks whether you are a person or a bot, say that you are the shop's virtual assistant and that a person from the team can take over.",
  ];
  if (persona.personaName) {
    lines.push(
      `Your name: ${persona.personaName}`,
      "Introduce yourself by this name in your first message only, and when the customer asks who you are."
    );
  }
  if (persona.personaStyle) lines.push(`Your style: ${persona.personaStyle}`);
  lines.push(
    persona.dialect
      ? `Write in the language or dialect the shop chose: ${persona.dialect}`
      : "Answer in the customer's own language, dialect and script: Algerian Darija in Arabic letters, Darija in Latin letters with digits (3, 7, 9) when they write so, French, English or Modern Standard Arabic.",
    "Darija always means Algerian Darija, without Moroccan or Middle-Eastern dialect words."
  );
  return lines;
}

function yourGoal(persona: PersonaSettings): string[] {
  const lines = [GOALS[persona.goal].text];
  const notes = indentedLines(persona.goalNotes ?? "");
  if (notes.length) lines.push("The shop's notes on this goal:", ...notes);
  return lines;
}

function customerState(): string[] {
  return [
    "Set customer_state in every answer:",
    ...CUSTOMER_STATES.map((state) => `- ${state}: ${CUSTOMER_STATE_GUIDE[state]}`),
    `Judge from the customer's latest messages, in the light of the whole conversation. When several fit, choose the first of: ${STATE_PRIORITY.join(", ")}.`,
  ];
}

function chatStyle(persona: PersonaSettings): string[] {
  return [
    "- Short messages, the way people chat on Messenger: one to three short sentences.",
    "- One question per message, at most.",
    persona.dialect
      ? "- Write in the language chosen above, with simple words."
      : "- Write in the customer's dialect, with their own words and simple sentences.",
    "- No pressure and no insisting: if the customer ignores a question or says no, do not ask it again.",
    "- No lists and no markdown: no bullets, no numbering, no bold, no headings.",
    "- No new greeting in an ongoing conversation: answer the latest messages.",
    "- An emoji only if the customer uses them, and one at most.",
    ...ALGERIAN_VOICE,
  ];
}

/**
 * How a seasoned Algerian shopkeeper talks. The examples carry no fact
 * (no price, colour, place or policy), so nothing can be copied from them
 * as if it were the shop's: they show the phrasing only.
 */
const ALGERIAN_VOICE = [
  "- When you write Algerian Darija, talk like a seasoned Algerian shopkeeper who knows his customers: short, natural sentences, warm and welcoming, and ask the way a seller asks in his shop. Never translate word for word from French or Modern Standard Arabic, and never write a heavy or formal sentence.",
  "- These examples show the phrasing only; never take a fact from them:",
  "  Bad: «تحوّس عليه للصالون ولا للطرقات؟» Good: «وين حاب تحطو، في الصالون ولا في بيت أخرى؟»",
  "  Bad: «نعلمك بلي المنتوج متوفر بالألوان التالية: …» Good: «كاين بـ… و…، واش يعجبك فيهم؟»",
  "  Bad: «هل ترغب في إتمام عملية الطلب؟» Good: «نسجلّك الطلبية؟»",
  "  Bad: «شكرا على تواصلكم معنا، كيف يمكنني مساعدتك؟» Good: «مرحبا بيك، واش نقدر نعاونك؟»",
  "  Bad: «واش تحب تطلب المنتوج ولا تحب معلومات إضافية؟» Good: «حاب تطلبو ولا عندك سؤال آخر؟»",
  "  Bad: «يرجى تزويدنا باسمك ورقم هاتفك» Good: «عطيني اسمك ونمرة تيليفونك باش نسجلوك»",
];

const PLAYBOOK_INTRO =
  "The strict rules, the knowledge base and the catalog win over this playbook: use a persuasion technique only with a true fact written there, and never invent scarcity, urgency, a discount, a gift, social proof or a guarantee.";

function salesPlaybook(persona: PersonaSettings): string[] {
  const playbook = indentedLines(effectivePlaybook(persona));
  // A playbook made only of "#" says nothing: the default speaks instead.
  return [PLAYBOOK_INTRO, ...(playbook.length ? playbook : indentedLines(DEFAULT_PLAYBOOK))];
}

/**
 * The persona's sections of the system instruction, joined by blank lines:
 * WHO YOU ARE, YOUR GOAL, THE CUSTOMER'S STATE, CHAT STYLE, SALES PLAYBOOK.
 * The settings are cleaned first (parsePersonaSettings), so a raw database
 * row gives the same prompt as a parsed one.
 */
export function buildPersonaSections(settings: PersonaSettings): string {
  const persona = parsePersonaSettings(settings);
  return [
    section("WHO YOU ARE", whoYouAre(persona)),
    section("YOUR GOAL", yourGoal(persona)),
    section("THE CUSTOMER'S STATE", customerState()),
    section("CHAT STYLE", chatStyle(persona)),
    section("SALES PLAYBOOK", salesPlaybook(persona)),
  ].join("\n\n");
}
