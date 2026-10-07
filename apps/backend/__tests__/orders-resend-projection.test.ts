// apps/backend/__tests__/orders-resend-projection.test.ts — the order DETAIL's transmission-failure projection (the
// resend-transmission UI). `buildOrderWorkflowProjection` now also says (a) WHY a lab order's transmission failed —
// the fixed producer token in `transmission_failure_reason`, shown only to a reader holding a transmission-authority
// key (a `orm_refused:sud_restricted` token discloses a 42 CFR Part 2 flag, so it is not for every order reader) —
// and (b) whether `POST /orders/:id/resend-transmission` would act on it (`allowedActions.resend_transmission`): the
// SAME `classifyOrmResend` rule the route applies, AND the route's own `orders.transmission.recover` permission.
// The server still decides on the POST; this only stops the UI offering a button the route would refuse.
import { describe, expect, it } from "vitest";
import {
  EMPTY_ORDER_DETAIL_ACTOR,
  type OrderDetailActor,
  buildOrderWorkflowProjection,
} from "../src/modules/11-orders/routes/service";

const actorWith = (...permissions: string[]): OrderDetailActor => ({
  membershipId: "m-1",
  roles: [],
  disciplines: [],
  permissions: new Set(permissions),
});

const RECOVERER = actorWith("orders.transmission.recover");

const labOrder = (
  over: { status?: string; transmissionStatus?: string; reason?: string | null } = {},
) => ({
  kind: "lab" as const,
  kindVersion: "1",
  data: {},
  status: (over.status ?? "active") as "active",
  cosignRequired: false,
  cosignStatus: null,
  verbalDeadlineAt: null,
  drafterMembershipId: "m-2",
  signedAt: "2026-10-01T00:00:00.000Z",
  transmissionStatus: over.transmissionStatus ?? "failed",
  transmissionFailureReason:
    over.reason === undefined ? "orm_refused:patient_sex_unrecorded" : over.reason,
});

describe("order detail — transmission failure reason + resend_transmission", () => {
  it("offers resend for an active lab order refused at the ORM step to a holder of orders.transmission.recover", () => {
    const p = buildOrderWorkflowProjection(labOrder(), RECOVERER, null);
    expect(p.allowedActions.resend_transmission).toBe(true);
    expect(p.transmissionFailureReason).toBe("orm_refused:patient_sex_unrecorded");
  });

  it("offers resend for a dispatch_refused:* failure (no outbound row was ever written)", () => {
    const p = buildOrderWorkflowProjection(
      labOrder({ reason: "dispatch_refused:no_active_feed" }),
      RECOVERER,
      null,
    );
    expect(p.allowedActions.resend_transmission).toBe(true);
  });

  it("does NOT offer resend without orders.transmission.recover (the route's permission), even when resendable", () => {
    const p = buildOrderWorkflowProjection(labOrder(), actorWith("orders.amend"), null);
    expect(p.allowedActions.resend_transmission).toBe(false);
  });

  it("does NOT offer resend for failures the route refuses: SUD gate, immutable-order facts, M29 terminal failures", () => {
    for (const reason of [
      "orm_refused:sud_restricted",
      "orm_refused:lab_test_codes_missing",
      "dlq_exhausted",
      "application_reject",
      "recovery_blocked:row_owns_order",
      null,
    ]) {
      const p = buildOrderWorkflowProjection(labOrder({ reason }), RECOVERER, null);
      expect(p.allowedActions.resend_transmission, String(reason)).toBe(false);
    }
  });

  it("does NOT offer resend for a pending/transmitted transmission or an order that is no longer active", () => {
    expect(
      buildOrderWorkflowProjection(
        labOrder({ transmissionStatus: "pending", reason: null }),
        RECOVERER,
        null,
      ).allowedActions.resend_transmission,
    ).toBe(false);
    expect(
      buildOrderWorkflowProjection(labOrder({ status: "completed" }), RECOVERER, null)
        .allowedActions.resend_transmission,
    ).toBe(false);
  });

  it("redacts the failure reason for a reader without a transmission-authority key", () => {
    expect(
      buildOrderWorkflowProjection(labOrder(), EMPTY_ORDER_DETAIL_ACTOR, null)
        .transmissionFailureReason,
    ).toBeNull();
    expect(
      buildOrderWorkflowProjection(labOrder(), actorWith("orders.amend", "orders.read"), null)
        .transmissionFailureReason,
    ).toBeNull();
  });

  it("shows the failure reason to the held-list viewer and the escalated co-signer too", () => {
    for (const key of ["orders.transmission.view_held", "orders.transmission.cosign_escalated"]) {
      const p = buildOrderWorkflowProjection(labOrder(), actorWith(key), null);
      expect(p.transmissionFailureReason, key).toBe("orm_refused:patient_sex_unrecorded");
      expect(p.allowedActions.resend_transmission, key).toBe(false);
    }
  });

  it("carries no failure reason once the transmission is no longer failed", () => {
    const p = buildOrderWorkflowProjection(
      labOrder({ transmissionStatus: "transmitted", reason: "orm_refused:patient_sex_unrecorded" }),
      RECOVERER,
      null,
    );
    expect(p.transmissionFailureReason).toBeNull();
  });

  it("a caller that does not supply the reason (the in-memory slice) never offers a resend", () => {
    const { transmissionFailureReason: _r, ...noReason } = labOrder();
    const p = buildOrderWorkflowProjection(noReason, RECOVERER, null);
    expect(p.allowedActions.resend_transmission).toBe(false);
    expect(p.transmissionFailureReason).toBeNull();
  });
});
