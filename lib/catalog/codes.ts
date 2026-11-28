/**
 * Product and colour codes, compared the way people write them: "WP-12",
 * "wp 12", "WP_12" and "ＷＰ１２" are one code, and Arabic-Indic digits are
 * digits. The normalized key is what the database keeps unique and what the
 * bot and the image recognition look codes up by.
 */

const DIGIT_BLOCKS = [0x0660, 0x06f0, 0x07c0, 0x0966, 0x09e6, 0xff10];

function asciiDigits(text: string): string {
  return text.replace(/\p{Nd}/gu, (digit) => {
    const code = digit.codePointAt(0)!;
    for (const base of DIGIT_BLOCKS) {
      if (code >= base && code <= base + 9) return String(code - base);
    }
    return digit;
  });
}

/** Upper case, ASCII digits, without spaces and separators (- _ . / # :). */
export function normalizeCode(value: string): string {
  return asciiDigits(value.normalize("NFKC"))
    .toUpperCase()
    .replace(/[\s\-_./#:‐-―]+/g, "");
}

/** The key stored next to a code, or null for an empty one. */
export function codeKeyOf(value: string | null | undefined): string | null {
  if (!value) return null;
  const key = normalizeCode(value);
  return key ? key : null;
}

/** Codes are short: longer is a sentence, not a code. */
export const MAX_CODE_LENGTH = 60;
