import { Value } from "@sinclair/typebox/value";
/**
 * M35A-T03 — §5.2 backend gap-closure.
 *
 * Pins the four gaps this task closed so the §5.2 admin console is renderable:
 *   (1) the NEW `dunning.admin.read` read key — registered in M35's catalog fragment, bound to the
 *       read-tier platform-ops roles (else the dunning screen is 403-for-all);
 *   (2) the `GET /api/admin/dunning` list route + the `GET /api/admin/{plans,refunds,promos}/:id` detail
 *       GETs are actually registered (the screens hydrate from these);
 *   (3) the admin list DTOs carry an org DISPLAY NAME (`organizationName`), not just a raw UUID;
 *   (4) the M2 `OrganizationReader` seam resolves those names — batched, dedup'd, graceful when unbound.
 */
import {
  M35_BILLING_ADMIN_READ_KEYS,
  M35_CONTRIBUTED_PERMISSIONS,
  rolesForPermission,
} from "@wardenx/auth";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { organizationReaderDenyStub } from "../../../bootstrap/seams/providers";
import { registerAdminRoutes } from "../routes/admin.routes";
import type { M35RouteService } from "../routes/service";
import {
  DunningListItemDto,
  DunningListResponseDto,
  RefundDto,
  SubscriptionAdminResponseDto,
} from "../routes/subscription-typebox";

const UUID = "00000000-0000-0000-0000-000000000001";

describe("M35A-T03 — `dunning.admin.read` read key (§4.7)", () => {
  it("registers `dunning.admin.read` as a billing_admin read key gated by platform_billing_scope", () => {
    const def = M35_CONTRIBUTED_PERMISSIONS["dunning.admin.read"];
    expect(def).toBeDefined();
    expect(def.category).toBe("billing_admin");
    expect(def.abac).toBe("platform_billing_scope");
    expect(def.action).toBe("admin_read");
  });

  it("is a READ key (support/billing/admin/owner), not the write-tier `dunning.admin.override`", () => {
    expect(M35_BILLING_ADMIN_READ_KEYS).toContain("dunning.admin.read");
    expect([...rolesForPermission("dunning.admin.read")].sort()).toEqual(
      ["platform_admin", "platform_billing_admin", "platform_owner", "platform_support_t2"].sort(),
    );
    // The override (mutating) key stays disjoint — support may READ the queue but not skip/reset stages.
    expect(rolesForPermission("dunning.admin.override")).not.toContain("platform_support_t2");
  });
});

describe("M35A-T03 — org display name on the admin DTOs (§5.2)", () => {
  const base = {
    id: UUID,
    organizationId: UUID,
    planSlug: "pro",
    planName: "Professional",
    status: "past_due" as const,
    trialEndsAt: null,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    canceledAt: null,
    defaultPaymentMethodLast4: null,
    defaultPaymentMethodBrand: null,
    defaultPaymentMethodExpiresAt: null,
    dunningStage: "day_7" as const,
    planTier: "professional" as const,
    stripeSubscriptionId: null,
    startedAt: "2026-01-01T00:00:00.000Z",
  };

  it("SubscriptionAdminResponseDto REQUIRES organizationName", () => {
    expect(
      Value.Check(SubscriptionAdminResponseDto, { ...base, organizationName: "Acme Hospice" }),
    ).toBe(true);
    expect(Value.Check(SubscriptionAdminResponseDto, base)).toBe(false); // missing organizationName → rejected
  });

  it("RefundDto REQUIRES organizationName", () => {
    const refund = {
      id: UUID,
      organizationId: UUID,
      organizationName: "Acme Hospice",
      invoiceId: UUID,
      amountCents: 100,
      kind: "partial" as const,
      reasonCode: "requested_by_customer",
      status: "requested" as const,
      requestedByMembershipId: UUID,
      requestedAt: "2026-01-01T00:00:00.000Z",
      approvedByMembershipId: null,
      approvedAt: null,
      deniedReason: null,
      executedAt: null,
      stripeRefundId: null,
    };
    expect(Value.Check(RefundDto, refund)).toBe(true);
    const { organizationName: _omit, ...withoutName } = refund;
    expect(Value.Check(RefundDto, withoutName)).toBe(false);
  });

  it("DunningListResponseDto is a cursor page of dunning rows carrying org name + plan", () => {
    const item = {
      subscriptionId: UUID,
      organizationId: UUID,
      organizationName: "Acme Hospice",
      planName: "Professional",
      subscriptionStatus: "past_due" as const,
      stage: "day_14" as const,
      enteredAt: "2026-01-01T00:00:00.000Z",
      nextAttemptAt: null,
    };
    expect(Value.Check(DunningListItemDto, item)).toBe(true);
    expect(
      Value.Check(DunningListResponseDto, { items: [item], nextCursor: null, hasMore: false }),
    ).toBe(true);
  });
});

describe("M35A-T03 — M2 OrganizationReader seam (deny-stub graceful default)", () => {
  it("the deny-stub resolves NO names (graceful — a display enrichment never fails a list)", async () => {
    expect(await organizationReaderDenyStub.readByIds([UUID])).toEqual([]);
  });
});

describe("M35A-T03 — new admin routes are registered", () => {
  it("registers the dunning list + the three detail GETs", async () => {
    const app = Fastify();
    // The route handlers dispatch to the service; guard construction is pure (no registry needed at
    // registration), so a bare Fastify is enough to assert the routing table.
    registerAdminRoutes(app, { service: {} as unknown as M35RouteService });
    await app.ready();
    for (const url of [
      "/api/admin/dunning",
      "/api/admin/plans/:id",
      "/api/admin/refunds/:id",
      "/api/admin/promos/:id",
    ]) {
      expect(app.hasRoute({ method: "GET", url })).toBe(true);
    }
  });
});
