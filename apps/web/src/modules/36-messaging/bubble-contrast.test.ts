// WCAG 1.4.3: the timestamp in an own (primary-coloured) bubble was white at 78% over #1a56eb = 4.2:1 (axe
// color-contrast). CSS is not rendered under jsdom, so compute the contrast from the rule and the light-theme tokens.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const PRIMARY = [0x1a, 0x56, 0xeb] as const;
const ON_PRIMARY = [0xff, 0xff, 0xff] as const;
const MIN_RATIO = 4.5;

const channel = (v: number): number => {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = (rgb: readonly number[]): number =>
  0.2126 * channel(rgb[0] ?? 0) + 0.7152 * channel(rgb[1] ?? 0) + 0.0722 * channel(rgb[2] ?? 0);

describe("own-bubble timestamp contrast", () => {
  const css = readFileSync("apps/web/src/modules/36-messaging/message-list.css", "utf8");

  it("is at least 4.5:1 against the primary bubble", () => {
    const rule =
      /\.wx-message-row\.is-mine \.wx-message-bubble time\s*\{[^}]*?on-primary\)\s*(\d+)%/.exec(
        css,
      );
    expect(rule).not.toBeNull();
    const alpha = Number(rule?.[1]) / 100;
    const blended = PRIMARY.map((p, i) => (ON_PRIMARY[i] ?? 0) * alpha + p * (1 - alpha));
    const [hi, lo] = [luminance(blended), luminance(PRIMARY)].sort((a, b) => b - a);
    expect(((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05)).toBeGreaterThanOrEqual(MIN_RATIO);
  });
});
