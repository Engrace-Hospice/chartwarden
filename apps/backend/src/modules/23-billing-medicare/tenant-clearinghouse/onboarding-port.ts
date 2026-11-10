// apps/backend/src/modules/23-billing-medicare/tenant-clearinghouse/onboarding-port.ts — M23's side of the platform
// onboarding seam (bootstrap/onboarding-clearinghouse-port.ts): a platform operator sets a tenant's clearinghouse through
// the SAME service the tenant's own admin uses, on the caller's transaction (scoped to the target org, attributed to the
// operator). The body is parsed here with M23's own schemas; nothing returned carries the credential.
import type { DbClient } from "@chartwarden/db";
import { parse } from "@chartwarden/shared/route-kit";
import { withOrgContext } from "@chartwarden/tenancy";
import { ChartWardenError } from "@chartwarden/types";
import type {
  OnboardingClearinghousePort,
  OnboardingClearinghouseResult,
  OnboardingWriteScope,
  VerifyPlan,
} from "../../../bootstrap/onboarding-clearinghouse-port";
import { assertTxScopedToOrg } from "../../../bootstrap/onboarding-credential-port";
import { createDrizzleConfigStore } from "./config-store";
import type {
  ClearinghouseActor,
  ClearinghouseConfigView,
  RevokeBaaInput,
  VerifyPlan as ServiceVerifyPlan,
  TenantClearinghouseService,
} from "./service";
import { PutClearinghouseBodySchema, VerifyClearinghouseBodySchema } from "./typebox";

// The platform-ops lane: the one lane that may set test mode on a production deployment (the route records a reason).
const actorFor = (scope: OnboardingWriteScope): ClearinghouseActor => ({
  organizationId: scope.organizationId,
  userId: scope.operatorUserId,
  membershipId: scope.operatorMembershipId,
  lane: "platform",
});

/** The catalog-validating outbox publisher (callerModule m23): the revoke announces itself in its own transaction. */
export interface ClearinghouseOutboxPort {
  publish(
    tx: DbClient,
    input: {
      readonly eventName: string;
      readonly organizationId: string;
      readonly aggregateKind: string;
      readonly aggregateId: string;
      readonly payload: Record<string, unknown>;
    },
  ): Promise<void>;
}

export function buildTenantClearinghouseOnboardingPort(deps: {
  readonly db: DbClient;
  readonly service: TenantClearinghouseService;
  /** Required for a revoke: a fact the tenant must be told of is not written without its announcement (typed 503 when absent). */
  readonly outbox?: ClearinghouseOutboxPort;
}): OnboardingClearinghousePort {
  const { db, service } = deps;

  /** The row id, for the audit row (the view deliberately carries none). The row exists after any successful write. */
  async function resourceIdOf(tx: DbClient, organizationId: string): Promise<string> {
    const row = await createDrizzleConfigStore(tx).find(organizationId);
    if (!row) {
      throw new ChartWardenError(
        "INTERNAL_ERROR",
        "the clearinghouse config vanished after its write",
        500,
      );
    }
    return row.id;
  }
  const withId = async (
    tx: DbClient,
    scope: OnboardingWriteScope,
    view: ClearinghouseConfigView | object,
    extra: Omit<OnboardingClearinghouseResult, "resourceId" | "view"> = {},
  ): Promise<OnboardingClearinghouseResult> => ({
    resourceId: await resourceIdOf(tx, scope.organizationId),
    view,
    ...extra,
  });

  return {
    get: (scope) =>
      withOrgContext<DbClient, object>(
        db,
        { organizationId: scope.organizationId, userId: scope.operatorUserId },
        (tx) =>
          service.view(createDrizzleConfigStore(tx), scope.organizationId, { operator: true }),
      ),

    async put(tx, scope, body, expectedVersion) {
      await assertTxScopedToOrg(tx, scope.organizationId);
      const input = parse(PutClearinghouseBodySchema, body);
      const { created, view, changedFields } = await service.put(
        createDrizzleConfigStore(tx),
        actorFor(scope),
        input,
        expectedVersion,
      );
      // The names of what the put actually CHANGED (never a value): a put that rotated only the credential says `secret`.
      return withId(tx, scope, view, { created, changedFields });
    },

    async prepareVerify(scope, body) {
      const input = parse(VerifyClearinghouseBodySchema, body);
      return withOrgContext<DbClient, ServiceVerifyPlan>(
        db,
        { organizationId: scope.organizationId, userId: scope.operatorUserId },
        (tx) => service.prepareVerify(createDrizzleConfigStore(tx), actorFor(scope), input),
      );
    },

    async runProbe(plan: VerifyPlan) {
      return service.runProbe(plan as ServiceVerifyPlan);
    },

    async completeVerify(tx, scope, plan, outcome) {
      await assertTxScopedToOrg(tx, scope.organizationId);
      const { view, test } = await service.completeVerify(
        createDrizzleConfigStore(tx),
        actorFor(scope),
        plan as ServiceVerifyPlan,
        outcome as Parameters<TenantClearinghouseService["completeVerify"]>[3],
      );
      return withId(tx, scope, view, {
        test,
        detail: {
          verificationKind: view.verification?.kind ?? "none",
          ...(test ? { testOutcome: test.outcome } : {}),
        },
      });
    },

    async verifyBaa(tx, scope, expected, options) {
      await assertTxScopedToOrg(tx, scope.organizationId);
      const store = createDrizzleConfigStore(tx);
      // Hold the same row lock the service will reuse so `dataChanged` describes this exact write, not a pre-read race.
      const before = await store.findForUpdate(scope.organizationId);
      const view = await service.verifyBaa(store, actorFor(scope), expected, options);
      // The audit row names the record that was verified (a screened document reference and a date: never patient data), and says
      // when the operator verified a document that was revoked before (the earlier revocation's time): a knowing supersession.
      const previous = view.baa?.previousRevocation;
      return withId(tx, scope, view, {
        dataChanged: before?.baaVerifiedAt === null,
        detail: {
          baaVerified: view.baa?.verified !== null && view.baa?.verified !== undefined,
          ...(view.baa
            ? {
                baaDocumentRef: view.baa.documentRef,
                baaEffectiveDate: view.baa.effectiveDate,
                baaRecordedAt: view.baa.recordedAt,
              }
            : {}),
          ...(previous?.sameDocument
            ? { supersededRevocation: true, previousRevocationAt: previous.at }
            : {}),
        },
      });
    },

    async revokeBaa(tx, scope, expected, input) {
      await assertTxScopedToOrg(tx, scope.organizationId);
      const { outbox } = deps;
      if (!outbox) {
        throw new ChartWardenError(
          "CLEARINGHOUSE_OUTBOX_UNBOUND",
          "the outbox is not bound: a BAA revoke that the tenant must be told of cannot be recorded",
          503,
        );
      }
      const result = await service.revokeBaa(
        createDrizzleConfigStore(tx),
        actorFor(scope),
        expected,
        input as RevokeBaaInput,
      );
      // The tenant's announcement commits or rolls back with the revoke (ids, a closed code and counts only: no ticket, no text).
      await outbox.publish(tx, {
        eventName: "m23.tenant_clearinghouse.baa_revoked",
        organizationId: scope.organizationId,
        aggregateKind: "tenant_clearinghouse_config",
        aggregateId: result.configId,
        payload: {
          clearinghouseConfigId: result.configId,
          vendor: result.vendor,
          reasonCode: result.reasonCode,
          wasActive: result.wasActive,
          ...result.impact,
        },
      });
      const { view } = result;
      // The platform audit row: the vendor, the closed code, the ticket, the record revoked, what it stopped and what it leaves owed.
      // Ids, codes, counts and a screened document reference: nothing a person typed beyond the ticket reference.
      return withId(tx, scope, view, {
        detail: {
          baaRevoked: true,
          wasActive: result.wasActive,
          vendor: result.vendor,
          reasonCode: result.reasonCode,
          ticketRef: view.baa?.revokedTicketRef ?? "",
          credentialCleared: result.credentialCleared,
          ...result.impact,
          ...(view.baa
            ? { baaDocumentRef: view.baa.documentRef, baaRecordedAt: view.baa.recordedAt }
            : {}),
        },
      });
    },

    async releaseCredentials(tx, scope, reason) {
      await assertTxScopedToOrg(tx, scope.organizationId);
      const { released, view } = await service.releaseCredentials(
        createDrizzleConfigStore(tx),
        actorFor(scope),
        reason,
      );
      // The audit row says how many were released, never which (a fingerprint is never audited).
      return withId(tx, scope, { released, config: view }, { detail: { released } });
    },
  };
}
