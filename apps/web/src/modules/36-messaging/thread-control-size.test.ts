// WCAG 2.5.8 (target size, minimum): the thread controls rendered 52x20, 30x20 and 170x17 (axe target-size). They are
// native buttons styled only by thread-panel.css, so the 24px floor is asserted on the rule (jsdom has no layout).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync("apps/web/src/modules/36-messaging/thread-panel.css", "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);
const MIN_TARGET_REM = 1.5; // 24px

function minHeightRem(selector: string): number | null {
  const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter(([, selectors]) =>
    (selectors ?? "").split(",").some((s) => s.trim() === selector),
  );
  for (const [, , body] of rules.reverse()) {
    const match = /min-height:\s*([\d.]+)rem/.exec(body ?? "");
    if (match) return Number(match[1]);
  }
  return null;
}

describe("thread control target sizes", () => {
  it.each([".wx-thread-count", ".wx-thread-reply", ".wx-reply-context"])(
    "%s is at least 24px tall",
    (selector) => {
      expect(minHeightRem(selector)).toBeGreaterThanOrEqual(MIN_TARGET_REM);
    },
  );
});
