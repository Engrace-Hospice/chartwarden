// apps/backend/src/modules/12-dosespot/tenant-config/onboarding-port.ts — M12's side of the platform onboarding seam
// (bootstrap/onboarding-dosespot-port.ts): a platform operator registers a tenant's DoseSpot clinic through the SAME service the
// tenant's own admin uses, on the caller's transaction (scoped to the target org, attributed to the operator). The body is
// parsed here with M12's own schemas; nothing returned carries a credential. The operator's lane is `platform`, the one lane
// that may set a Subscription-Key.
import { type DbClient, schema } from "@chartwarden/db";
import type { ConnectionProbeOutcome } from "@chartwarden/dosespot";
import { withOrgContext } from "@chartwarden/tenancy";
import { ChartWardenError } from "@chartwarden/types";
import { desc, eq } from "drizzle-orm";
import { assertTxScopedToOrg } from "../../../bootstrap/onboarding-credential-port";
import type {
  OnboardingDoseSpotPort,
  OnboardingDoseSpotResult,
  OnboardingPlan,
  OnboardingWriteScope,
} from "../../../bootstrap/onboarding-dosespot-port";
import type { DoseSpotWriteOutboxPort } from "../dosespot-route-service-db";
import { parse } from "../routes/dosespot-typebox";
import { CLINIC_AUDIT_EVENTS } from "./audit-port";
import { createDrizzleConfigStore } from "./config-store";
import {
  type ClinicAlertPort,
  type ClinicServiceChange,
  alertAfterCommit,
  applyInTransaction,
  changeOfPut,
  changeOfTransition,
  registrationOf,
} from "./effects";
import type { EnrollPlan, PrescriberEnrollmentService } from "./prescriber-enrollment";
import { createDrizzleRosterStore } from "./roster-store";
import type { ClinicActor, ClinicConfigView, DoseSpotClinicService, VerifyPlan } from "./service";
import { EnrollPrescriberVendorBodySchema, PutClinicBodySchema } from "./typebox";

const P = schema.dosespotPrescribers;

const actorFor = (scope: OnboardingWriteScope): ClinicActor => ({
  organizationId: scope.organizationId,
  userId: scope.operatorUserId,
  membershipId: scope.operatorMembershipId,
  lane: "platform",
});

const asEnrollActor = (scope: OnboardingWriteScope) => ({
  ...actorFor(scope),
  request: scope.request,
});

export function buildDoseSpotClinicOnboardingPort(deps: {
  readonly db: DbClient;
  readonly service: DoseSpotClinicService;
  readonly outbox: DoseSpotWriteOutboxPort;
  readonly enrollment: PrescriberEnrollmentService;
  readonly alerts?: ClinicAlertPort;
}): OnboardingDoseSpotPort {
  const { db, service } = deps;

  /**
   * The outbox event for the change (in the operator's transaction) and the registration row's id for the audit row. The go-live
   * void is the platform write wrapper's own (it runs in this same transaction for every onboarding write), so none is passed.
   */
  async function finish(
    tx: DbClient,
    scope: OnboardingWriteScope,
    view: ClinicConfigView,
    change: ClinicServiceChange | null,
    extra: Omit<OnboardingDoseSpotResult, "resourceId" | "view" | "afterCommit"> = {},
  ): Promise<OnboardingDoseSpotResult> {
    const registration = await registrationOf(createDrizzleConfigStore(tx), scope.organizationId);
    await applyInTransaction(
      tx,
      { outbox: deps.outbox },
      {
        organizationId: scope.organizationId,
        userId: scope.operatorUserId,
        membershipId: scope.operatorMembershipId,
        registration,
        change,
      },
    );
    return {
      resourceId: registration.id,
      view,
      ...extra,
      ...(change?.kind === "deactivated" && deps.alerts
        ? {
            afterCommit: () =>
              alertAfterCommit(deps.alerts, scope.organizationId, registration, change),
          }
        : {}),
    };
  }

  return {
    get: (scope) =>
      withOrgContext<DbClient, object>(
        db,
        { organizationId: scope.organizationId, userId: scope.operatorUserId },
        (tx) => service.view(createDrizzleConfigStore(tx), scope.organizationId),
      ),

    async put(tx, scope, body, expectedVersion) {
      await assertTxScopedToOrg(tx, scope.organizationId);
      const input = parse(PutClinicBodySchema, body);
      const result = await service.put(
        createDrizzleConfigStore(tx),
        actorFor(scope),
        input,
        expectedVersion,
      );
      // A no-op save changed nothing: no event, but the row still exists for the audit row to name.
      return finish(tx, scope, result.view, changeOfPut(result), {
        created: result.created,
        changedFields: result.changedFields,
      });
    },

    async prepareVerify(scope) {
      return withOrgContext<DbClient, VerifyPlan>(
        db,
        { organizationId: scope.organizationId, userId: scope.operatorUserId },
        (tx) => service.prepareVerify(createDrizzleConfigStore(tx), actorFor(scope)),
      );
    },

    async runProbe(plan: OnboardingPlan) {
      return service.runProbe(plan as VerifyPlan);
    },

    async completeVerify(tx, scope, plan, outcome) {
      await assertTxScopedToOrg(tx, scope.organizationId);
      const { view, test } = await service.completeVerify(
        createDrizzleConfigStore(tx),
        actorFor(scope),
        plan as VerifyPlan,
        outcome as ConnectionProbeOutcome,
      );
      return finish(tx, scope, view, null, {
        test,
        detail: { testOutcome: test.outcome, status: view.status ?? "none" },
      });
    },

    async activate(tx, scope) {
      await assertTxScopedToOrg(tx, scope.organizationId);
      const result = await service.activate(createDrizzleConfigStore(tx), actorFor(scope));
      return finish(tx, scope, result.view, changeOfTransition(result, "activated"));
    },

    async deactivate(tx, scope) {
      await assertTxScopedToOrg(tx, scope.organizationId);
      const result = await service.deactivate(createDrizzleConfigStore(tx), actorFor(scope));
      return finish(tx, scope, result.view, changeOfTransition(result, "deactivated"));
    },

    async listPrescribers(scope) {
      return withOrgContext<DbClient, readonly object[]>(
        db,
        { organizationId: scope.organizationId, userId: scope.operatorUserId },
        async (tx) => {
          const rows = await tx
            .select({
              membershipId: P.membershipId,
              enrolledWithDoseSpot: P.dosespotPrescriberId,
              revokedAt: P.revokedAt,
              requestedAt: P.vendorEnrollmentRequestedAt,
            })
            .from(P)
            .where(eq(P.organizationId, scope.organizationId))
            .orderBy(desc(P.createdAt))
            .limit(500);
          // no NPI, no DEA number, no vendor id: only whether each roster prescriber is linked
          return rows.map((r) => ({
            membershipId: r.membershipId,
            onRoster: r.revokedAt === null,
            enrolledWithDoseSpot: r.enrolledWithDoseSpot !== null,
            vendorEnrollmentRequestedAt: r.requestedAt ? r.requestedAt.toISOString() : null,
          }));
        },
      );
    },

    prepareEnroll(scope, membershipId, body) {
      const input = parse(EnrollPrescriberVendorBodySchema, body);
      return deps.enrollment.prepare(asEnrollActor(scope), membershipId, input);
    },

    callVendor: (plan) => deps.enrollment.callVendor(plan as EnrollPlan),

    async completeEnroll(tx, scope, plan, vendorId) {
      await assertTxScopedToOrg(tx, scope.organizationId);
      const enrollPlan = plan as EnrollPlan;
      const store = createDrizzleRosterStore(tx);
      if (vendorId === null) {
        // already linked: nothing was called or recorded; the audit row still names the roster row
        const [row] = await tx
          .select({ id: P.id })
          .from(P)
          .where(eq(P.membershipId, enrollPlan.membershipId))
          .limit(1);
        if (!row) throw new ChartWardenError("INTERNAL_ERROR", "the roster row vanished", 500);
        return {
          resourceId: row.id,
          view: { membershipId: enrollPlan.membershipId, enrolledWithDoseSpot: true },
        };
      }
      const { rosterId } = await deps.enrollment.complete(
        store,
        tx,
        asEnrollActor(scope),
        enrollPlan,
        vendorId,
      );
      return {
        resourceId: rosterId,
        view: { membershipId: enrollPlan.membershipId, enrolledWithDoseSpot: true },
        detail: { event: CLINIC_AUDIT_EVENTS.prescriberEnrolled },
      };
    },
  };
}
