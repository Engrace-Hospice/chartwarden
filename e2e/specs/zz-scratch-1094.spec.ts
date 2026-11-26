import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { ADMIN_ACCOUNT } from "../fixtures/credentials";
import { signInAs } from "../fixtures/helpers";

const VIEWPORTS = [
  { width: 1280, height: 720 },
  { width: 1366, height: 650 },
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
  { width: 1024, height: 768 },
  { width: 768, height: 1024 },
  { width: 375, height: 667 },
];

async function createReferral(page: Page): Promise<string> {
  await page.goto("/referrals");
  await page
    .getByRole("navigation", { name: "Admissions pages" })
    .getByRole("link", { name: "New Referral" })
    .click();
  await page.waitForURL(/\/referrals\/new/);
  await page.getByLabel("Patient full name").fill(`E2E Referral ${Date.now()}`);
  await page.getByLabel("Source channel").selectOption({ label: "Fax" });
  await page.getByRole("button", { name: "Create referral" }).click();
  await page.waitForURL(/\/referrals\/(?!new)[^/]+$/, { timeout: 15_000 });
  return page.url().match(/\/referrals\/([^/?#]+)/)?.[1] as string;
}

test("probe: footer vs Create new patient across viewports", async ({ page }) => {
  test.setTimeout(180_000);
  await signInAs(page, ADMIN_ACCOUNT());
  const id = await createReferral(page);
  await page.goto(`/referrals/${id}/intake`);
  await page.getByRole("button", { name: "Start review & continue" }).click();
  await page.getByLabel("Date of birth").fill("1954-05-08");
  await page.getByRole("button", { name: "Save & continue to patient matching" }).click();
  await expect(page.getByRole("heading", { name: "Patient Resolution" })).toBeVisible();

  await page.setViewportSize({ width: 1280, height: 720 });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Patient Resolution" })).toBeVisible();
  console.log(
    "DIAG",
    JSON.stringify(
      await page.evaluate(() => {
        const pg = document.querySelector(".wx-intake-page") as HTMLElement;
        const cs = getComputedStyle(pg);
        const main = document.querySelector(".wx-main") as HTMLElement;
        const ws = document.querySelector(".wx-intake-workspace") as HTMLElement;
        return {
          cls: pg.className,
          display: cs.display,
          dir: cs.flexDirection,
          height: cs.height,
          minH: cs.minHeight,
          pad: cs.padding,
          mainH: main.clientHeight,
          pageH: pg.offsetHeight,
          wsH: ws.offsetHeight,
          wsFlex: getComputedStyle(ws).flex,
          parent: pg.parentElement?.className,
          parentDisplay: getComputedStyle(pg.parentElement as HTMLElement).display,
        };
      }),
    ),
  );
  const rows: string[] = [];
  for (const vp of VIEWPORTS) {
    await page.setViewportSize(vp);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Patient Resolution" })).toBeVisible();
    const m = await page.evaluate(() => {
      const btn = [...document.querySelectorAll("button")].find(
        (b) => b.textContent?.trim() === "Create new patient",
      ) as HTMLElement | undefined;
      const footer = document.querySelector(".wx-sticky-footer") as HTMLElement | null;
      if (!btn || !footer) return { err: "missing", btn: !!btn, footer: !!footer };
      const scrollers: string[] = [];
      for (let e: HTMLElement | null = btn.parentElement; e; e = e.parentElement) {
        const cs = getComputedStyle(e);
        if (/(auto|scroll)/.test(cs.overflowY) && e.scrollHeight > e.clientHeight + 1)
          scrollers.push(
            `${e.className.split(" ")[0] || e.tagName}[${e.scrollTop}/${e.scrollHeight - e.clientHeight}]`,
          );
      }
      const r = btn.getBoundingClientRect();
      const cy = r.top + r.height / 2;
      const hit = document.elementFromPoint(r.left + r.width / 2, cy);
      const before =
        cy < 0 || cy > innerHeight
          ? "offscreen"
          : hit && (hit === btn || btn.contains(hit))
            ? "clear"
            : `COVERED by ${hit?.className || hit?.tagName}`;
      const fr = footer.getBoundingClientRect();
      return {
        footerPos: getComputedStyle(footer).position,
        footerTop: Math.round(fr.top),
        btnTop: Math.round(r.top),
        btnBottom: Math.round(r.bottom),
        vh: innerHeight,
        before,
        scrollers: scrollers.join(" > "),
      };
    });
    let trial = "ok";
    try {
      await page
        .getByRole("button", { name: "Create new patient" })
        .click({ trial: true, timeout: 4000 });
    } catch (e) {
      trial = `FAIL ${
        (e as Error).message
          .split("\n")
          .find((l) => /intercepts|not visible|outside/.test(l))
          ?.trim()
          .slice(0, 90) ?? "timeout"
      }`;
    }
    const atEnd = await page.evaluate(() => {
      const btn = [...document.querySelectorAll("button")].find(
        (b) => b.textContent?.trim() === "Create new patient",
      ) as HTMLElement;
      for (let e: HTMLElement | null = btn.parentElement; e; e = e.parentElement) {
        if (e.scrollHeight > e.clientHeight + 1) e.scrollTop = e.scrollHeight;
      }
      const r = btn.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      const footer = document.querySelector(".wx-sticky-footer") as HTMLElement;
      const fr = footer.getBoundingClientRect();
      const state =
        r.top < 0 || r.top > innerHeight
          ? "offscreen"
          : hit && (hit === btn || btn.contains(hit))
            ? "clear"
            : `COVERED by ${hit?.className || hit?.tagName}`;
      return `${state} footerBottom=${Math.round(fr.bottom)} btnBottom=${Math.round(r.bottom)}`;
    });
    rows.push(`${vp.width}x${vp.height} ${JSON.stringify(m)} trial=${trial} atScrollEnd=${atEnd}`);
  }
  console.log(`\n=== PROBE ===\n${rows.join("\n")}\n=== END ===`);
});
