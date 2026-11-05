// apps/backend/src/modules/23-billing-medicare/routes/onboarding-credential-port.ts — M23's side of the platform
// onboarding seam (bootstrap/onboarding-credential-port.ts): a platform operator fills in a tenant's MAC submitter
// credential through the SAME write service the tenant's own admin uses, on the caller's transaction.
//
// The body is the tenant route's (`UpsertMacCredentialBodySchema`), parsed here with M23's own schema. The service
// view carries only a `hasSecret` flag and the safe identifiers (§3.6): no secret ever leaves through this port.
import type {
  OnboardingCredentialPort,
  OnboardingWriteScope,
} from "../../../bootstrap/onboarding-credential-port";
import type { M23ReadActor, M23WriteActor } from "./actor";
import { UpsertMacCredentialBodySchema, parse } from "./billing-typebox";
import type { M23ReadRouteService } from "./read-service";
import type { M23WriteRouteService } from "./write-service";

/** A tenant has one credential per provider entity; this is far beyond any real count. */
const LIST_LIMIT = 100;

const writeActorFor = (scope: OnboardingWriteScope): M23WriteActor => ({
  organizationId: scope.organizationId,
  userId: scope.operatorUserId,
  roles: scope.operatorRoles,
  membershipId: scope.operatorMembershipId,
  stepUpRecent: scope.stepUpRecent,
  actorKind: "user",
  request: scope.request,
});

const readActorFor = (scope: OnboardingWriteScope): M23ReadActor => ({
  organizationId: scope.organizationId,
  userId: scope.operatorUserId,
  roles: scope.operatorRoles,
});

export function buildMacOnboardingCredentialPort(deps: {
  readonly writeService: Pick<M23WriteRouteService, "upsertMacCredentialOnTx">;
  readonly readService: Pick<M23ReadRouteService, "listMacCredentials">;
}): OnboardingCredentialPort {
  return {
    async upsert(tx, scope, body, expectedVersion) {
      const args = parse(UpsertMacCredentialBodySchema, body);
      const view = await deps.writeService.upsertMacCredentialOnTx(
        tx,
        writeActorFor(scope),
        { ...args, expectedVersion },
      );
      return { resourceId: view.credentialId, view };
    },
    async list(scope) {
      const page = await deps.readService.listMacCredentials(
        readActorFor(scope),
        undefined,
        LIST_LIMIT,
      );
      return page.items;
    },
  };
}
