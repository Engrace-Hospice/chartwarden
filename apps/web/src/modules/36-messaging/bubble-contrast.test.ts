// WCAG 1.4.3: the timestamp in an own (primary-coloured) bubble was white at 78% over #1a56eb = 4.2:1 (axe
// color-contrast). CSS is not rendered under jsdom, so compute the contrast from the rule and the real theme tokens.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const MIN_RATIO = 4.5;
const tokens = readFileSync("apps/web/src/index.css", "utf8");
const css = readFileSync("apps/web/src/modules/36-messaging/message-list.css", "utf8");

const hex = (value: string): number[] =>
  [1, 3, 5].map((i) => Number.parseInt(value.slice(i, i + 2), 16));
const channel = (v: number): number => {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = (rgb: readonly number[]): number =>
  0.2126 * channel(rgb[0] ?? 0) + 0.7152 * channel(rgb[1] ?? 0) + 0.0722 * channel(rgb[2] ?? 0);

/** First `--name: #hex` at or after `from` in the token sheet. */
function token(name: string, from = 0): string {
  const match = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`).exec(tokens.slice(from));
  if (!match?.[1]) throw new Error(`token ${name} not found after ${from}`);
  return match[1];
}
const darkStart = tokens.indexOf(".dark {");

const THEMES = [
  { name: "light", from: 0 },
  { name: "dark", from: darkStart },
];

describe("own-bubble timestamp contrast", () => {
  it("finds the dark theme block", () => {
    expect(darkStart).toBeGreaterThan(0);
  });

  it.each(THEMES)("is at least 4.5:1 against the primary bubble ($name theme)", ({ from }) => {
    const rule =
      /\.wx-message-row\.is-mine \.wx-message-bubble time\s*\{[^}]*?on-primary\)\s*(\d+)%/.exec(
        css,
      );
    expect(rule).not.toBeNull();
    const alpha = Number(rule?.[1]) / 100;
    const bubble = hex(token("--color-primary", from));
    const text = hex(token("--color-on-primary", from));
    const blended = bubble.map((p, i) => (text[i] ?? 0) * alpha + p * (1 - alpha));
    const [hi, lo] = [luminance(blended), luminance(bubble)].sort((a, b) => b - a);
    expect(((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05)).toBeGreaterThanOrEqual(MIN_RATIO);
  });
});

describe("edited label contrast", () => {
  // The "Edited" marker lives in `.wx-message-meta` beside the timestamp, which owns its colour and size. The label
  // itself must not override either, and the wrapper must keep the timestamp's muted colour and size.
  const ruleBody = (selector: string): string => {
    const escaped = selector.replace(/\./g, "\\.");
    const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
    if (!match?.[1]) throw new Error(`rule ${selector} not found in message-list.css`);
    return match[1];
  };
  const contrast = (a: readonly number[], b: readonly number[]): number => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
  };

  it("sets the muted colour and the timestamp size on the wrapper", () => {
    const body = ruleBody(".wx-message-meta");
    expect(body).toMatch(/color:\s*var\(--color-muted\)/);
    expect(body).toMatch(/font-size:\s*0\.625rem/);
  });

  it("does not let a dedicated label rule override colour, opacity or size", () => {
    expect(css).not.toMatch(/\.wx-message-edited[^{]*\{[^}]*\b(color|opacity|font-size)\s*:/);
  });

  it.each(THEMES)(
    "muted token is at least 4.5:1 on the incoming bubble ($name theme)",
    ({ from }) => {
      const bubble = hex(token("--color-surface-lowest", from));
      expect(contrast(hex(token("--color-muted", from)), bubble)).toBeGreaterThanOrEqual(MIN_RATIO);
    },
  );

  it.each(THEMES)("own-bubble wrapper colour is at least 4.5:1 ($name theme)", ({ from }) => {
    const rule = /\.wx-message-row\.is-mine \.wx-message-meta\s*\{[^}]*?on-primary\)\s*(\d+)%/.exec(
      css,
    );
    expect(rule).not.toBeNull();
    const alpha = Number(rule?.[1]) / 100;
    const bubble = hex(token("--color-primary", from));
    const text = hex(token("--color-on-primary", from));
    const blended = bubble.map((p, i) => (text[i] ?? 0) * alpha + p * (1 - alpha));
    expect(contrast(blended, bubble)).toBeGreaterThanOrEqual(MIN_RATIO);
  });

  it("keeps the wrapper a div outside `.wx-message-bubble > span`, wrapping by item", () => {
    const row = readFileSync("apps/web/src/modules/36-messaging/message-row.tsx", "utf8");
    expect(row).toMatch(/<div className="wx-message-meta">/);
    expect(row).not.toMatch(/<span className="wx-message-meta"/);
    const body = ruleBody(".wx-message-meta");
    expect(body).toMatch(/flex-wrap:\s*wrap/);
    expect(body).toMatch(/justify-content:\s*flex-end/);
    // the rule this guards against still exists (otherwise the div requirement is moot)
    expect(css).toMatch(/\.wx-message-bubble > span\s*\{[^}]*overflow-wrap:\s*anywhere/);
  });
});
