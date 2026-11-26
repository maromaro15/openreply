/**
 * Interface copy for the Facebook, agency and alerts screens.
 *
 * English is the source and the key, as in lib/i18n. Arabic is the only
 * translation: these screens fall back to English in the other interface
 * languages, so the existing catalogs need no new keys. A key missing from
 * ar.json is a type error, which keeps the Arabic complete.
 */
import ar from "./ar.json";
import { HANDOFF_CATEGORY_LABELS } from "@/lib/handoff/categories";
import type { HandoffCategory } from "@/app/generated/prisma/client";

export type FbMessageKey = keyof typeof ar;

type Placeholders<S extends string> = S extends `${string}{${infer Name}}${infer Rest}`
  ? Name | Placeholders<Rest>
  : never;
type MessageArgs<K extends FbMessageKey> = [Placeholders<K>] extends [never]
  ? []
  : [values: Record<Placeholders<K>, string | number>];
/** Keys without placeholders: safe to store in tables (menus, titles). */
export type FbStaticKey = {
  [K in FbMessageKey]: [Placeholders<K>] extends [never] ? K : never;
}[FbMessageKey];

const arabic: Record<FbMessageKey, string> = ar;

export function isArabicLocale(locale: string): boolean {
  return locale === "ar";
}

export function createFbI18n(locale: string) {
  const useArabic = isArabicLocale(locale);

  function t<K extends FbMessageKey>(key: K, ...args: MessageArgs<K>): string {
    const message = useArabic ? arabic[key] : key;
    const values = args[0] as Record<string, string | number> | undefined;
    return message.replace(/\{(\w+)\}/g, (placeholder, name: string) =>
      values?.[name] === undefined ? placeholder : String(values[name])
    );
  }

  return {
    locale,
    dir: useArabic ? ("rtl" as const) : ("ltr" as const),
    t,
    category: (category: HandoffCategory) => t(HANDOFF_CATEGORY_LABELS[category]),
  };
}

export type FbI18n = ReturnType<typeof createFbI18n>;

function isStaticKey(value: string): value is FbStaticKey {
  return Object.prototype.hasOwnProperty.call(arabic, value) && !/\{\w+\}/.test(value);
}

/**
 * A stored handoff reason: the system's own reasons are English sentences
 * of this catalog and get translated; a reason the model wrote stays as is.
 */
export function translateReason(t: FbI18n["t"], reason: string): string {
  return isStaticKey(reason) ? t(reason) : reason;
}

/** Top bar titles for the screens of these modules. */
export function moduleTitle(pathname: string): FbStaticKey | null {
  const under = (prefix: string) => pathname === prefix || pathname.startsWith(`${prefix}/`);
  if (under("/agency")) return "Brands";
  if (under("/facebook/pages")) return "Facebook Pages";
  if (under("/facebook/inbox")) return "Messenger inbox";
  if (under("/facebook/knowledge/suggestions")) return "Suggestions to review";
  if (under("/facebook/knowledge")) return "Knowledge base";
  if (under("/facebook/products/attributes")) return "Product attributes";
  if (under("/facebook/products/import")) return "Import products";
  if (pathname === "/facebook/products/new") return "New product";
  if (pathname.startsWith("/facebook/products/")) return "Product card";
  if (pathname === "/facebook/products") return "Products";
  if (under("/facebook/alerts")) return "Handoff alerts";
  if (pathname === "/facebook/campaigns/new") return "New campaign";
  if (pathname.startsWith("/facebook/campaigns/")) return "Edit campaign";
  if (pathname === "/facebook/campaigns") return "Facebook campaigns";
  return null;
}
