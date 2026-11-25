/**
 * Message templates for Facebook campaigns.
 */

/** The first name of a commenter, for {name}. Empty when unknown. */
export function firstName(fullName: string | null | undefined): string {
  return fullName?.trim().split(/\s+/)[0] ?? "";
}

/**
 * Fill {name}. Without a name the placeholder is removed along with the
 * space or comma it leaves dangling ("Salam {name}, ..." → "Salam, ...").
 */
export function renderTemplate(template: string, { name }: { name?: string | null }): string {
  const value = name?.trim() ?? "";
  if (value) return template.replace(/\{name\}/g, value);
  return template
    .replace(/[ \t]*\{name\}/g, "")
    .replace(/[ \t]+([,.!?،؟])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** A readable, ASCII campaign tag for utm_campaign. */
export function utmCampaign(name: string, fallback: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || fallback;
}

/**
 * Add UTM parameters to a landing URL, keeping any the URL already has.
 * An invalid URL comes back unchanged.
 */
export function withUtm(
  url: string,
  params: { source: string; medium: string; campaign: string }
): string {
  try {
    const parsed = new URL(url);
    const pairs: [string, string][] = [
      ["utm_source", params.source],
      ["utm_medium", params.medium],
      ["utm_campaign", params.campaign],
    ];
    for (const [key, value] of pairs) {
      if (!parsed.searchParams.has(key)) parsed.searchParams.set(key, value);
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

/** A random element: one of the public reply variants. */
export function pickOne<T>(items: readonly T[], random: () => number = Math.random): T | undefined {
  if (items.length === 0) return undefined;
  return items[Math.min(items.length - 1, Math.floor(random() * items.length))];
}
