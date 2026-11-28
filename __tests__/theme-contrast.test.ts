import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The theme's colour tokens (app/globals.css) against WCAG 2.2 AA:
 * 4.5:1 for text, 3:1 for the orange dot and badges and the focus ring.
 */
const css = readFileSync(join(__dirname, "../app/globals.css"), "utf8");

function token(name: string): string {
  const match = css.match(new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!match) throw new Error(`no --color-${name} hex in globals.css`);
  return match[1];
}

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const mix = (hex: string, over: string, alpha: number) =>
  rgb(hex).map((value, i) => value * alpha + rgb(over)[i] * (1 - alpha));
function luminance(channels: number[]): number {
  const [r, g, b] = channels.map((value) => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: number[], b: number[]): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

const ink = token("ink");
const bone = token("bone");
const white = token("surface");
const backgrounds = { bone, white, hover: token("surface-hover"), soft: token("accent-soft") };

describe("theme contrast (WCAG AA)", () => {
  it("keeps ink and grey text readable on every background", () => {
    for (const [name, background] of Object.entries(backgrounds)) {
      expect(contrast(rgb(ink), rgb(background)), `ink on ${name}`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(rgb(token("muted")), rgb(background)), `muted on ${name}`).toBeGreaterThanOrEqual(4.5);
    }
    expect(token("zinc-500")).toBe(token("muted"));
  });

  it("puts ink, never white, on orange", () => {
    expect(css).toMatch(/--color-accent-foreground:\s*var\(--color-ink\)/);
    expect(contrast(rgb(ink), rgb(token("accent")))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(rgb(ink), rgb(token("accent-hover")))).toBeGreaterThanOrEqual(4.5);
    // Why orange is never text: under AA on white.
    expect(contrast(rgb(token("accent")), rgb(white))).toBeLessThan(4.5);
  });

  it("shows the orange dot and badges, and the focus ring, at 3:1", () => {
    expect(contrast(rgb(token("accent")), rgb(white))).toBeGreaterThanOrEqual(3);
    expect(contrast(rgb(token("focus")), rgb(bone))).toBeGreaterThanOrEqual(3);
    expect(contrast(rgb(token("focus")), rgb(white))).toBeGreaterThanOrEqual(3);
  });

  it("keeps status text readable on bone, white and its own tinted chip", () => {
    for (const status of ["success", "error", "warning"]) {
      const color = token(status);
      expect(contrast(rgb(color), rgb(bone)), `${status} on bone`).toBeGreaterThanOrEqual(4.5);
      for (const alpha of [0.05, 0.1, 0.15]) {
        expect(contrast(rgb(color), mix(color, white, alpha)), `${status} on its ${alpha} chip`).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrast(rgb(white), rgb(color)), `white on ${status}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});
