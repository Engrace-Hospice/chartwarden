// apps/backend/__tests__/m27-permission-grant-arm.test.ts — F-030.
//
// THE DEFECT. M27's §4.7 editor/approver predicates widen an actor's scope when they hold the
// encompassing-org `cost_report.edit_any_provider` grant. That check read
// `context.attributes.permissions` — a key nothing in production has ever written — so it returned
// false for every caller and every key, and the org-scope override arm never once fired.
//
// It failed CLOSED, so it was never exposure. What it was instead: a documented §4.7 control that
// has never run, in a module whose editor surface is otherwise scoped strictly per ProviderEntity —
// so a multi-PE agency's org-level cost-report editor could not edit anything outside their own PE,
// no matter what they were granted.
//
// WHY NOTHING SAW IT. The one existing case that touches this grant is in a LIVE suite, and it
// asserts the override is REFUSED (it satisfies the scope conjunct but is not a signatory). With the
// grant unresolvable, that assertion still passes — by proving nothing. This file covers the
// direction that had no test at all: the arm GRANTING.
//
// The fix resolves through `resolveActorPermissions`, the same registered resolver
// `requirePermission` gates on, whose own doc comment names this exact case ("consumers that must
// *check* a permission rather than gate on it") and states an assembled `AbacContext` is a valid
// argument. Nothing needed stamping on the request: the resolver is TTL-cached per (org, user) and
// the route's own `requirePermission` preHandler has already resolved the same set.
import { type AbacContext, resetRbacEngine, setEffectivePermissionResolver } from "@wardenx/auth";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ReadingM27AbacResolver,
  buildM27AbacPredicates,
} from "../src/modules/27-cost-report/abac-predicates";

const ORG = "org-27";
const EDIT_ANY_PROVIDER = "cost_report.edit_any_provider";
const REPORT = "cr-1";
const PE_OTHER = "pe-other";

/** The actor's membership is scoped to a DIFFERENT ProviderEntity than the report's, so the only
 *  way `cost_report_editor_for_provider` can allow is the org-scope override. */
const resolver: ReadingM27AbacResolver = {
  async loadCostReport(_ctx, id) {
    return id === REPORT
      ? ({
          costReportId: REPORT,
          organizationId: ORG,
          providerEntityId: "pe-report",
          state: "draft",
        } as Awaited<ReturnType<ReadingM27AbacResolver["loadCostReport"]>>)
      : null;
  },
  async loadMembershipProviderScope() {
    return { providerEntityIds: [PE_OTHER] } as Awaited<
      ReturnType<ReadingM27AbacResolver["loadMembershipProviderScope"]>
    >;
  },
  async hasElevatedApproval() {
    return false;
  },
};

const GRANTS = new Map<string, ReadonlySet<string>>();

function ctx(userId: string, permissions: readonly string[]): AbacContext {
  GRANTS.set(userId, new Set(permissions));
  return {
    organizationId: ORG,
    userId,
    roles: [],
    providerEntityIds: [],
    locationIds: [],
    attributes: { membershipId: "mem-1" },
  };
}

describe("F-030 — M27's org-scope override arm resolves a real grant", () => {
  beforeEach(() => {
    GRANTS.clear();
    setEffectivePermissionResolver((c) => GRANTS.get(c.userId) ?? new Set<string>());
  });
  afterEach(() => {
    resetRbacEngine();
  });

  it("GRANTS an out-of-PE editor who holds `cost_report.edit_any_provider`", async () => {
    const p = buildM27AbacPredicates({ resolver });
    expect(
      await p.cost_report_editor_for_provider!(ctx("u-override", [EDIT_ANY_PROVIDER]), {
        costReportId: REPORT,
      }),
    ).toBe(true);
  });

  it("DENIES the same actor without the grant — the override is what did the work", async () => {
    const p = buildM27AbacPredicates({ resolver });
    expect(
      await p.cost_report_editor_for_provider!(ctx("u-plain", []), { costReportId: REPORT }),
    ).toBe(false);
  });

  it("DENIES when no resolver is registered at all (fail-closed default)", async () => {
    resetRbacEngine(); // restores the deny-all resolver
    const p = buildM27AbacPredicates({ resolver });
    expect(
      await p.cost_report_editor_for_provider!(ctx("u-override", [EDIT_ANY_PROVIDER]), {
        costReportId: REPORT,
      }),
    ).toBe(false);
  });

  it("the grant does NOT make the actor a signatory — approver still needs the designation", async () => {
    // The conjunct the live suite covers, asserted here without a database: the override widens WHICH
    // providers you may act on; it does not substitute for `membership_elevated_approval`.
    const p = buildM27AbacPredicates({ resolver });
    expect(
      await p.cost_report_approver_for_provider!(ctx("u-override", [EDIT_ANY_PROVIDER]), {
        costReportId: REPORT,
      }),
    ).toBe(false);
  });
});
