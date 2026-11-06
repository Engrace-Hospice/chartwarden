// apps/backend/src/modules/23-billing-medicare/tenant-clearinghouse/tenant-service.ts — the tenant routes' service: the
// rules of `service.ts` run on the tenant pool under the caller's own `withOrgContext` (RLS scopes every statement to the
// caller's organization; the M4 write-audit trigger attributes each row change to the caller via `app.user_id`).
//
// After a change COMMITS the optional `onChanged` hook runs (the composition root binds it to the M34 onboarding advance
// pass, so choosing a vendor settles wizard step 7 at once); a failure there is logged and never fails the change.
import type { DbClient } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import type { M23ReadActor, M23WriteActor } from "../routes/actor";
import { createDrizzleConfigStore } from "./config-store";
import type {
  ClearinghouseConfigView,
  PutClearinghouseInput,
  TenantClearinghouseService,
} from "./service";
import type { VerifyClearinghouseBody } from "./typebox";

export interface TenantClearinghouseRouteService {
  get(actor: M23ReadActor): Promise<ClearinghouseConfigView>;
  put(
    actor: M23WriteActor,
    body: PutClearinghouseInput,
    expectedVersion: number | undefined,
  ): Promise<{ readonly created: boolean; readonly view: ClearinghouseConfigView }>;
  verify(
    actor: M23WriteActor,
    body: VerifyClearinghouseBody,
  ): Promise<{
    readonly view: ClearinghouseConfigView;
    readonly test: { readonly outcome: string } | null;
  }>;
  activate(actor: M23WriteActor): Promise<ClearinghouseConfigView>;
}

export function buildDrizzleTenantClearinghouseRouteService(deps: {
  readonly db: DbClient;
  readonly service: TenantClearinghouseService;
  /** Post-commit, best effort. */
  readonly onChanged?: (organizationId: string) => Promise<void>;
  readonly logError?: (cause: unknown, context: { organizationId: string }) => void;
}): TenantClearinghouseRouteService {
  const { db, service } = deps;
  const inOrg = <T>(actor: M23ReadActor, fn: (tx: DbClient) => Promise<T>): Promise<T> =>
    withOrgContext<DbClient, T>(
      db,
      { organizationId: actor.organizationId, userId: actor.userId },
      fn,
    );
  const changed = async (organizationId: string): Promise<void> => {
    if (!deps.onChanged) return;
    try {
      await deps.onChanged(organizationId);
    } catch (cause) {
      deps.logError?.(cause, { organizationId });
    }
  };
  const then = async <T>(organizationId: string, result: T): Promise<T> => {
    await changed(organizationId);
    return result;
  };

  return {
    get: (actor) =>
      inOrg(actor, (tx) => service.view(createDrizzleConfigStore(tx), actor.organizationId)),
    async put(actor, body, expectedVersion) {
      const result = await inOrg(actor, (tx) =>
        service.put(createDrizzleConfigStore(tx), actor, body, expectedVersion),
      );
      return then(actor.organizationId, result);
    },
    async verify(actor, body) {
      const result = await inOrg(actor, (tx) =>
        service.verify(createDrizzleConfigStore(tx), actor, body),
      );
      return then(actor.organizationId, result);
    },
    async activate(actor) {
      const view = await inOrg(actor, (tx) =>
        service.activate(createDrizzleConfigStore(tx), actor),
      );
      return then(actor.organizationId, view);
    },
  };
}
