// e2e/specs/role-authorization-matrix.spec.ts — #852 (CW-QA-0008): cross-role authorization, browser side.
//
// A lower-privilege seeded role is DENIED on admin / billing routes while an authorized role is
// ALLOWED. These screens do not all redirect — most render and then fail their first data read — so the
// observable is the one every denial shares: the screen's authoritative `/api/` read answers 403.
// Seeded roles (scripts/db/seed.ts): the Clinician holds only `clinical` permissions, the
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
  readonly apiPath: string | ((organizationId: string) => string);
}

const BILLING_QUEUE: Case = {
  route: "/billing/queue",
  permission: "billing.claim.read",
  apiPath: "/api/v1/billing/claims?limit=1",
};
const RATE_TABLES: Case = {
  route: "/billing/rate-tables",
  permission: "billing.rate_table.read",
  apiPath: "/api/v1/billing/rate-tables",
};
const AGENCY_SETUP: Case = {
  route: "/admin/setup",
  permission: "org.manage",
  apiPath: "/api/v1/orgs?limit=1",
};
const AUDIT_LOG: Case = {
  route: "/audit",
  permission: "audit.read",
  apiPath: "/api/v1/audit/events?limit=1",
};
const STAFF: Case = {
  route: "/admin/staff",
  permission: "member.manage",
  apiPath: (organizationId) => `/api/v1/orgs/${organizationId}/members`,
};

async function probePrimaryRead(page: Page, testCase: Case): Promise<number> {
  const organizationId = await page.evaluate(async () => {
    const response = await fetch("/api/v1/auth/context", { credentials: "include" });
    if (!response.ok) throw new Error(`auth context returned ${response.status}`);
    const context = (await response.json()) as { organizationId: string | null };
    if (!context.organizationId) throw new Error("authenticated session has no organization");
    return context.organizationId;
  });
  let path =
    typeof testCase.apiPath === "function" ? testCase.apiPath(organizationId) : testCase.apiPath;
  if (testCase === RATE_TABLES) {
    const providerEntityId = await page.evaluate(async () => {
      const response = await fetch("/api/v1/provider-entities?limit=1", {
        credentials: "include",
      });
      if (!response.ok) return null;
      const providerEntities = (await response.json()) as {
        items?: Array<{ id?: string }>;
      };
      return providerEntities.items?.[0]?.id ?? null;
    });
    if (providerEntityId) {
      path = `/api/v1/billing/rate-tables?providerEntityId=${encodeURIComponent(providerEntityId)}`;
    }
  }
  return page.evaluate(
    async (apiPath) => (await fetch(apiPath, { credentials: "include" })).status,
    path,
  );
}

async function visit(page: Page, route: string): Promise<void> {
  await page.goto(route, { waitUntil: "domcontentloaded" });
  // Capped: polling pages never go idle.
  await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => {});
}

function expectDenied(account: () => DemoAccount, cases: readonly Case[]): void {
  for (const testCase of cases) {
    const { route, permission } = testCase;
    test(`${route} is denied without ${permission}`, async ({ page }) => {
      await signInAs(page, account());
      expect(
        await probePrimaryRead(page, testCase),
        `${route}: authoritative read is forbidden without ${permission}`,
      ).toBe(403);
      await expect(page.locator(`a[href="${route}"]`)).toHaveCount(0);
    });
  }
}

function expectAllowed(account: () => DemoAccount, cases: readonly Case[]): void {
  for (const testCase of cases) {
    const { route, permission } = testCase;
    test(`${route} is allowed with ${permission}`, async ({ page }) => {
      await signInAs(page, account());
      expect(
        await probePrimaryRead(page, testCase),
        `${route}: authoritative read succeeds with ${permission}`,
      ).toBe(200);
      await visit(page, route);
      await expect(page.locator("#root > *").first()).toBeVisible();
      expect(new URL(page.url()).pathname, "stayed on the route").toBe(route);
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
