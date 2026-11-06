// apps/backend/src/modules/23-billing-medicare/tenant-clearinghouse/onboarding-port.ts — M23's side of the platform
// onboarding seam (bootstrap/onboarding-clearinghouse-port.ts): a platform operator sets a tenant's clearinghouse through
// the SAME service the tenant's own admin uses, on the caller's transaction (scoped to the target org, attributed to the
// operator). The body is parsed here with M23's own schemas; nothing returned carries the credential.
import type { DbClient } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { ChartWardenError } from "@chartwarden/types";
import type {
  OnboardingClearinghousePort,
  OnboardingClearinghouseResult,
  OnboardingWriteScope,
} from "../../../bootstrap/onboarding-clearinghouse-port";
import { assertTxScopedToOrg } from "../../../bootstrap/onboarding-credential-port";
import { parse } from "../routes/billing-typebox";
import { createDrizzleConfigStore } from "./config-store";
import type {
  ClearinghouseActor,
  ClearinghouseConfigView,
  TenantClearinghouseService,
} from "./service";
import { PutClearinghouseBodySchema, VerifyClearinghouseBodySchema } from "./typebox";

const actorFor = (scope: OnboardingWriteScope): ClearinghouseActor => ({
  organizationId: scope.organizationId,
  userId: scope.operatorUserId,
  membershipId: scope.operatorMembershipId,
});

export function buildTenantClearinghouseOnboardingPort(deps: {
  readonly db: DbClient;
  readonly service: TenantClearinghouseService;
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
    view: ClearinghouseConfigView,
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
        (tx) => service.view(createDrizzleConfigStore(tx), scope.organizationId),
      ),

    async put(tx, scope, body, expectedVersion) {
      await assertTxScopedToOrg(tx, scope.organizationId);
      const input = parse(PutClearinghouseBodySchema, body);
      const { created, view } = await service.put(
        createDrizzleConfigStore(tx),
        actorFor(scope),
        input,
        expectedVersion,
      );
      return withId(tx, scope, view, { created, changedFields: Object.keys(input) });
    },

    async verify(tx, scope, body) {
      await assertTxScopedToOrg(tx, scope.organizationId);
      const input = parse(VerifyClearinghouseBodySchema, body);
      const { view, test } = await service.verify(
        createDrizzleConfigStore(tx),
        actorFor(scope),
        input,
      );
      return withId(tx, scope, view, {
        test,
        detail: {
          verificationKind: view.verification?.kind ?? "none",
          ...(test ? { testOutcome: test.outcome } : {}),
        },
      });
    },

    async activate(tx, scope) {
      await assertTxScopedToOrg(tx, scope.organizationId);
      const view = await service.activate(createDrizzleConfigStore(tx), actorFor(scope));
      return withId(tx, scope, view);
    },
  };
}
