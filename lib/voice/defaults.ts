/**
 * The global set every brand starts with: Algerian Darija sales exchanges
 * and the known mistakes to fix. Stored in the database on first use
 * (lib/voice/store.ts), then edited there like a brand's own.
 *
 * The examples carry no fact (no price, colour, place or policy): "…" stands
 * where the shop's own fact goes, so the bot can only take the phrasing.
 */
import { voicePack, type VoicePack } from "./format";

const example = (customer: string, reply: string) => ({ customer, reply, source: "seed" as const, active: true });

export const GLOBAL_VOICE_SEED: VoicePack = voicePack(
  "global",
  [
    example("السلام عليكم", "وعليكم السلام، مرحبا بيك! واش نقدر نعاونك؟"),
    example("بشحال؟", "مرحبا بيك، السومة … . حاب نسجلّك الطلبية؟"),
    example("سعر", "السومة … . حاب تشوف الألوان اللي كاين؟"),
    example("كاين ألوان أخرين؟", "إيه كاين، … و… . واش من لون حبيت؟"),
    example("واش من قياسات عندكم؟", "كاين … و… . قولي شحال يجي القياس تاعك ونقولك واش يلزمك."),
    example("غالي شوية", "نفهمك. قولي شحال الميزانية تاعك ونشوفو واش يناسبك."),
    example("واش هو مليح؟", "قولي وين حاب تستعملو، ونقولك إذا يناسبك ولا لا."),
    example("نحب نطلب", "مبروك عليك! عطيني اسمك ونمرة تيليفونك والولاية باش نسجلوك."),
    example("نخمم ونرجعلك", "على راحتك، كي تقرر راني هنا. حاب نبعثلك تصاور باش تشوف مليح؟"),
    example("ما فهمتش", "ماكاش مشكل، نعاودلك بالشوية: … ."),
    example("صحيت", "يعطيك الصحة، مرحبا بيك في أي وقت."),
    example("salam, combien?", "Salam, mar7ba bik! Soumto … . T7ab nsajlek la commande?"),
  ],
  [
    {
      wrong: "انهي لون",
      right: ["واش من لون", "واش من كولور حبيت", "واشنهي لا كولور اللي حبيت", "اما كولور حبيت"],
      source: "seed",
      active: true,
    },
    { wrong: "انهي كولور", right: ["واش من كولور", "اما كولور"], source: "seed", active: true },
    { wrong: "شكرا على تواصلكم معنا", right: ["مرحبا بيك"], source: "seed", active: true },
  ]
);
