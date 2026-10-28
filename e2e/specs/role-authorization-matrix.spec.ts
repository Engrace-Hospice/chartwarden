// e2e/specs/role-authorization-matrix.spec.ts — #852 (CW-QA-0008): cross-role authorization, browser side.
//
// A lower-privilege seeded role is DENIED on admin / billing routes while an authorized role is
// ALLOWED. These screens do not all redirect — most render and then fail their first data read — so the
// observable is the one every denial shares: the SPA's own `/api/` call answers 403 (or the app leaves
// the route). Seeded roles (scripts/db/seed.ts): the Clinician holds only `clinical` permissions, the
// Compliance Auditor only `compliance`, the Administrator everything; `billing.*` and `org.manage` are
// `billing`/`admin` category, `audit.read` is `compliance`.
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import {
  ADMIN_ACCOUNT,
  AUDITOR_ACCOUNT,
  CLINICIAN_ACCOUNT,
  type DemoAccount,
} from "../fixtures/credentials";
import { signInAs } from "../fixtures/helpers";

interface Case {
  readonly route: string;
  readonly permission: string;
}

const BILLING_QUEUE: Case = { route: "/billing/queue", permission: "billing.claim.read" };
const RATE_TABLES: Case = { route: "/billing/rate-tables", permission: "billing.rate_table.read" };
const AGENCY_SETUP: Case = { route: "/admin/setup", permission: "org.manage" };
const AUDIT_LOG: Case = { route: "/audit", permission: "audit.read" };
const STAFF: Case = { route: "/admin/staff", permission: "member.manage" };

/** Collects every `/api/` 403 the page receives, for the lifetime of the page. */
function watchForbidden(page: Page): () => number {
  let forbidden = 0;
  page.on("response", (res) => {
    if (res.status() === 403 && new URL(res.url()).pathname.startsWith("/api/")) forbidden += 1;
  });
  return () => forbidden;
}

async function visit(page: Page, route: string): Promise<void> {
  await page.goto(route, { waitUntil: "domcontentloaded" });
  // Capped: polling pages never go idle.
  await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => {});
}

function expectDenied(account: () => DemoAccount, cases: readonly Case[]): void {
  for (const { route, permission } of cases) {
    test(`${route} is denied without ${permission}`, async ({ page }) => {
      await signInAs(page, account());
      const forbiddenCount = watchForbidden(page);
      await visit(page, route);
      await expect
        // ponytail: any /api/ 403 counts, not just the route's own endpoint (unknown per screen without a
        // live stack); tighten to the screen's primary read once it has been observed. A bounce to
        // /login (dropped session) is NOT a denial.
        .poll(
          () =>
            forbiddenCount() > 0 ||
            !["/login", route].some((p) => new URL(page.url()).pathname.startsWith(p)),
          {
            message: `${route}: expected an API 403 or a redirect away for a role lacking ${permission}`,
          },
        )
        .toBe(true);
    });
  }
}

function expectAllowed(account: () => DemoAccount, cases: readonly Case[]): void {
  for (const { route, permission } of cases) {
    test(`${route} is allowed with ${permission}`, async ({ page }) => {
      await signInAs(page, account());
      const forbiddenCount = watchForbidden(page);
      await visit(page, route);
      await expect(page.locator("#root > *").first()).toBeVisible();
      expect(new URL(page.url()).pathname, "stayed on the route").toBe(route);
      expect(forbiddenCount(), `no API 403 for a role holding ${permission}`).toBe(0);
    });
  }
}

test.describe("Authorization matrix (#852) — Clinician (clinical permissions only)", () => {
  expectDenied(CLINICIAN_ACCOUNT, [BILLING_QUEUE, RATE_TABLES, AGENCY_SETUP, AUDIT_LOG, STAFF]);
});

test.describe("Authorization matrix (#852) — Compliance Auditor (compliance permissions only)", () => {
  expectDenied(AUDITOR_ACCOUNT, [BILLING_QUEUE, AGENCY_SETUP]);
  expectAllowed(AUDITOR_ACCOUNT, [AUDIT_LOG]);
});

test.describe("Authorization matrix (#852) — Administrator (full catalog)", () => {
  expectAllowed(ADMIN_ACCOUNT, [BILLING_QUEUE, RATE_TABLES, AGENCY_SETUP, AUDIT_LOG, STAFF]);
});
