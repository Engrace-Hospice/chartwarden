// apps/backend/src/modules/24-billing-medicaid/routes/onboarding-credential-port.ts — M24's side of the platform
// onboarding seam (bootstrap/onboarding-credential-port.ts): a platform operator fills in a tenant's state Medicaid
// trading-partner credential through the SAME write service the tenant's own admin uses, on the caller's transaction.
//
// The body is the tenant route's (`UpsertCredentialBody`, which refuses unknown keys — the platform `reason` has
// already been removed), parsed here with M24's own schema. Secrets are sealed by the service's credential cipher
// and no view ever carries one: the list projects only `hasClientSecret` / `hasSftpKey` presence flags (§8.7).
import type {
  OnboardingCredentialPort,
  OnboardingWriteScope,
} from "../../../bootstrap/onboarding-credential-port";
import type { M24WriteActor } from "./actor";
import { UpsertCredentialBody, parse } from "./m24-typebox";
import type { M24ReadService } from "./read-service";
import type { M24WriteService } from "./write-service";

const actorFor = (scope: OnboardingWriteScope): M24WriteActor => ({
  organizationId: scope.organizationId,
  userId: scope.operatorUserId,
  roles: scope.operatorRoles,
  stepUpRecent: scope.stepUpRecent,
});

export function buildMedicaidOnboardingCredentialPort(deps: {
  readonly writeService: Pick<M24WriteService, "upsertCredentialOnTx">;
  readonly readService: Pick<M24ReadService, "listTradingPartnerCredentials">;
}): OnboardingCredentialPort {
  return {
    async upsert(tx, scope, body) {
      const { id } = await deps.writeService.upsertCredentialOnTx(
        tx,
        actorFor(scope),
        parse(UpsertCredentialBody, body),
      );
      return { resourceId: id, view: { id } };
    },
    async list(scope) {
      return deps.readService.listTradingPartnerCredentials(actorFor(scope));
    },
  };
}
