// e2e/specs/messaging-responsive.spec.ts — M36 WP 5.4: responsive, touch and WCAG 2.2 AA behaviour of /messaging.
//
// What a jsdom test cannot show (layout), measured in a real browser: axe at phone / tablet / desktop widths,
// interactive-target size (>= 44 px), 200% zoom, 320 px reflow without horizontal scroll, and the offline -> online
// transition. The jsdom half (axe states, focus order, Escape) is phase5-a11y.gate.dom.test.tsx.
// Evidence and the manual screen-reader scripts: docs/messaging-hub/evidence/phase-5-accessibility.md.
//
// Needs the full local stack with seeded demo data (see playwright.config.ts). NOT part of the default `bun run test`.
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { RN_ACCOUNT } from "../fixtures/credentials";
import { expectNoAxeViolations, signInAs } from "../fixtures/helpers";

const MIN_TARGET_PX = 44;
// The 44 px target size is a touch rule: much of the workspace keeps its denser mouse sizes under (pointer: fine) and only
// grows under @media (pointer: coarse). Chromium reports a coarse pointer only for a mobile, touch context, so the size
// assertion runs there; the desktop case checks axe alone.
const TOUCH_VIEWPORTS = [
  { name: "phone", width: 360, height: 740 },
  { name: "tablet", width: 768, height: 1024 },
] as const;

interface TargetRow {
  readonly selector: string;
  readonly width: number;
  readonly height: number;
}

async function openMessaging(page: Page): Promise<void> {
  await signInAs(page, RN_ACCOUNT());
  await page.goto("/messaging");
  await expect(page.locator(".wx-messaging-page")).toBeVisible({ timeout: 15_000 });
}

/**
 * Opens the first seeded conversation; on a phone this swaps the list for the thread. The seed is a hard precondition: a
 * missing conversation fails the test loudly instead of skipping it, which would let the thread-level checks go green unrun.
 */
async function openFirstConversation(page: Page): Promise<void> {
  const row = page.locator(".wx-messaging-conversation-list li button").first();
  await expect(row, "the demo seed must provide at least one conversation").toBeVisible();
  await row.click();
  await expect(page.locator(".wx-messaging-thread")).toBeVisible();
}

/** Every visible interactive element under the page, as `selector, w x h`, with the ones under the minimum. */
async function targetTable(page: Page): Promise<TargetRow[]> {
  return page.evaluate(() => {
    const selector =
      "a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=tab], [role=menuitem], [tabindex='0']";
    const describe = (el: Element): string => {
      const label = el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 24) ?? "";
      return `${el.tagName.toLowerCase()}${el.className ? `.${String(el.className).split(" ")[0]}` : ""}[${label}]`;
    };
    const rows: { selector: string; width: number; height: number }[] = [];
    for (const el of document.querySelectorAll(
      `.wx-messaging-page ${selector.split(", ").join(", .wx-messaging-page ")}`,
    )) {
      // A link inside a message body is the author's text, not workspace chrome (WCAG 2.5.8 inline exception).
      if (el instanceof HTMLAnchorElement && el.closest(".wx-rich-body, .wx-message-bubble"))
        continue;
      // A checkbox/radio is operated through its label: measure the label when there is one.
      const box = el instanceof HTMLInputElement ? (el.closest("label") ?? el) : el;
      const rect = box.getBoundingClientRect();
      const style = getComputedStyle(box);
      const hidden =
        rect.width <= 1 ||
        rect.height <= 1 ||
        style.visibility === "hidden" ||
        style.display === "none";
      if (!hidden)
        rows.push({
          selector: describe(el),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        });
    }
    return rows;
  });
}

const tooSmall = (rows: readonly TargetRow[]): string[] =>
  rows
    .filter((r) => r.width < MIN_TARGET_PX || r.height < MIN_TARGET_PX)
    .map((r) => `${r.selector}: ${r.width}x${r.height}`);

test.describe("Messaging — responsive, touch and accessibility (WP 5.4)", () => {
  for (const viewport of TOUCH_VIEWPORTS) {
    test.describe(`${viewport.name} ${viewport.width}px (touch)`, () => {
      test.use({
        viewport: { width: viewport.width, height: viewport.height },
        hasTouch: true,
        isMobile: true,
      });

      test(`axe clean and every target is at least ${MIN_TARGET_PX}px`, async ({ page }) => {
        await openMessaging(page);
        expect(
          await page.evaluate(() => matchMedia("(pointer: coarse)").matches),
          "the context must report a coarse pointer, or the 44px rules are not in force",
        ).toBe(true);
        await expectNoAxeViolations(page);
        const listTargets = await targetTable(page);
        test.info().annotations.push({ type: "targets", description: JSON.stringify(listTargets) });
        expect(listTargets.length, "the workspace must expose targets to measure").toBeGreaterThan(
          0,
        );
        expect(tooSmall(listTargets), "targets under 44px in the conversation list").toEqual([]);

        await openFirstConversation(page);
        await expectNoAxeViolations(page);
        const threadTargets = await targetTable(page);
        expect(
          threadTargets.some((t) => t.selector.startsWith("textarea")),
          "the open thread must expose its composer",
        ).toBe(true);
        expect(tooSmall(threadTargets), "targets under 44px in the open thread").toEqual([]);
      });
    });
  }

  test("desktop 1280px (mouse): axe clean in the list and in an open thread", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openMessaging(page);
    await expectNoAxeViolations(page);
    await openFirstConversation(page);
    await expectNoAxeViolations(page);
  });

  test("1024px: the patient-context slide-over opens, closes on Escape and returns focus", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1024, height: 800 }); // inside the 768-1279 slide-over band
    await openMessaging(page);
    await openFirstConversation(page);
    const toggle = page.getByRole("button", { name: /Patient context/ });
    // Deliberately a skip, not an expect: whether the FIRST seeded conversation is a patient-linked care-team channel is a
    // property of the demo seed's ordering, not of the feature under test. The conversation itself is a hard precondition.
    if ((await toggle.count()) === 0)
      test.skip(true, "first seeded conversation has no patient context");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expectNoAxeViolations(page);
    await page.keyboard.press("Escape");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(toggle).toBeFocused();
  });

  test("320px reflow: no horizontal scroll at 320 CSS px (WCAG 1.4.10)", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await openMessaging(page);
    const overflows = () =>
      page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      );
    expect(await overflows(), "conversation list").toBe(false);
    await openFirstConversation(page);
    expect(await overflows(), "open thread").toBe(false);
  });

  test("200% zoom: text scales and the layout still has no horizontal scroll (WCAG 1.4.4)", async ({
    page,
  }) => {
    // 200% browser zoom on a 1280px window is a 640 CSS px viewport; 200% text-only is a 2x root font size.
    await page.setViewportSize({ width: 640, height: 400 });
    await openMessaging(page);
    await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
    await expect(page.locator(".wx-messaging-page")).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflow, "horizontal scroll at 200% text").toBe(false);
    await openFirstConversation(page);
    const composer = page.getByRole("textbox", { name: "Message", exact: true });
    await composer.scrollIntoViewIfNeeded();
    await expect(composer).toBeVisible();
  });

  test("offline then online: the banner appears, then clears, with the composer still usable", async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await openMessaging(page);
    await openFirstConversation(page);
    await context.setOffline(true);
    // Axe must not run until the banner (a live region) has rendered, or it audits the pre-offline page.
    await expect(page.getByRole("status").filter({ hasText: /You're offline/ })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeEnabled();
    await expectNoAxeViolations(page);
    await context.setOffline(false);
    await expect(page.getByRole("status").filter({ hasText: /You're offline/ })).toBeHidden();
  });
});
