// e2e/fixtures/helpers.ts — shared sign-in + accessibility helpers for the WX-PR-018 critical-
// workflow suite. Plain functions (not custom Playwright fixtures) so each spec stays explicit
// about which account it signs in as, matching the "deterministic users" implementation step.
import AxeBuilder from "@axe-core/playwright";
import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { DEMO_ORG_NAME, type DemoAccount } from "./credentials";

/** Signs in as `account`, binds the shared demo org, and waits for the shell to land on Home. */
export async function signInAs(page: Page, account: DemoAccount): Promise<void> {
  await page.goto("/login");
  await page.getByPlaceholder("you@agency.org").fill(account.email);
  await page.getByPlaceholder("••••••••••").fill(account.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/login/organization");
  await page.getByRole("button", { name: new RegExp(DEMO_ORG_NAME) }).click();
  // organization-select does a hard `window.location.assign("/")` — wait for the real navigation.
  await page.waitForURL((url) => url.pathname === "/", { timeout: 15_000 });
}

/**
 * Signs out by calling Better Auth's own `/api/auth/sign-out` endpoint via `page.evaluate` + the
 * real page `fetch` — NOT `page.request.post`, which is Playwright's separate APIRequestContext and
 * does not send a real `Origin` header the way a page-context request does. Better Auth's own
 * origin check (packages/auth/src/identity/auth.ts `trustedOrigins`) rejects an Origin-less request
 * with 403 `MISSING_OR_NULL_ORIGIN`, so `page.request.post` silently never actually signed the
 * session out — this is the same call the app's own `authClient.signOut()` makes under the hood, run
 * from inside the real page so it looks like a genuine browser request. There is no persistent
 * sign-out menu in the shell chrome to click (per apps/web/src/shell/layout.tsx; the only in-app
 * affordance is the idle screen-lock overlay's "Sign out instead" button).
 */
export async function signOut(page: Page): Promise<void> {
  await page.evaluate(() =>
    fetch("/api/auth/sign-out", { method: "POST", credentials: "include" }),
  );
  await page.goto("/login");
}

/**
 * Runs an axe scan restricted to WCAG 2.1 A/AA and fails with the violated rule ids + targets.
 * `excludeSelectors` is for a REVIEWED, TRACKED, already-known gap only (mirrors
 * scripts/check-audit-exceptions.ts's exception style) — never a blanket way to silence a page;
 * everything else on the page is still fully scanned.
 */
export async function expectNoAxeViolations(
  page: Page,
  excludeSelectors: readonly string[] = [],
): Promise<void> {
  let builder = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]);
  for (const selector of excludeSelectors) builder = builder.exclude(selector);
  const results = await builder.analyze();
  const summary = results.violations.map(
    (v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
  );
  expect(summary, `axe violations:\n${summary.join("\n")}`).toEqual([]);
}
