// apps/backend/src/modules/23-billing-medicare/tenant-clearinghouse/tenant-service.ts — the tenant routes' service: the
// rules of `service.ts` run on the tenant pool under the caller's own `withOrgContext` (RLS scopes every statement to the
// caller's organization; the M4 write-audit trigger attributes each row change to the caller via `app.user_id`).
//
// Every change ALSO writes a field-level audit row (names, never values) in the same transaction, through the injected
// `ClearinghouseAuditPort`: the row trigger cannot say which fields a person chose to change.
//
// `verify` is three steps in two transactions (service.ts): read and decrypt, then the vendor probe with NO transaction open,
// then lock and compare-and-set. After a change COMMITS the optional `onChanged` hook runs (the composition root binds it to
// the M34 onboarding advance pass, so choosing a vendor settles wizard step 7 at once); a failure there is logged and never
// fails the change.
import type { DbClient } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { ChartWardenError } from "@chartwarden/types";
import type { M23ReadActor, M23WriteActor } from "../routes/actor";
import {
  CLEARINGHOUSE_AUDIT_EVENTS,
  type ClearinghouseAuditEvent,
  type ClearinghouseAuditPort,
} from "./audit-port";
import { createDrizzleConfigStore } from "./config-store";
import type {
  ClearinghouseConfigView,
  PutClearinghouseInput,
  RecordBaaInput,
  TenantClearinghouseService,
  VerifyClearinghouseInput,
} from "./service";

export interface TenantClearinghouseRouteService {
  get(actor: M23ReadActor): Promise<ClearinghouseConfigView>;
  put(
    actor: M23WriteActor,
    body: PutClearinghouseInput,
    expectedVersion: number | undefined,
  ): Promise<{ readonly created: boolean; readonly view: ClearinghouseConfigView }>;
  /** The tenant records the BAA it holds with its own vendor account. */
  recordBaa(actor: M23WriteActor, body: RecordBaaInput): Promise<ClearinghouseConfigView>;
  verify(
    actor: M23WriteActor,
    body: VerifyClearinghouseInput,
  ): Promise<{
    readonly view: ClearinghouseConfigView;
    readonly test: { readonly outcome: string } | null;
  }>;
  activate(actor: M23WriteActor): Promise<ClearinghouseConfigView>;
}

export function buildDrizzleTenantClearinghouseRouteService(deps: {
  readonly db: DbClient;
  readonly service: TenantClearinghouseService;
  /** The field-level audit writer (required: a change is never silently un-audited). */
  readonly audit: ClearinghouseAuditPort;
  /** Post-commit, best effort. */
  readonly onChanged?: (organizationId: string) => Promise<void>;
  readonly logError?: (cause: unknown, context: { organizationId: string }) => void;
}): TenantClearinghouseRouteService {
  const { db, service, audit } = deps;
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

  /** The audit row of one change, on the change's own transaction. The row exists after any successful write. */
  async function record(
    tx: DbClient,
    actor: M23WriteActor,
    eventType: ClearinghouseAuditEvent,
    changedFields: readonly string[],
    detail?: Readonly<Record<string, string | number | boolean>>,
  ): Promise<void> {
    const row = await createDrizzleConfigStore(tx).find(actor.organizationId);
    if (!row) {
      throw new ChartWardenError(
        "INTERNAL_ERROR",
        "the clearinghouse config vanished after its write",
        500,
      );
    }
    await audit.record(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      actorMembershipId: actor.membershipId,
      eventType,
      resourceId: row.id,
      changedFields,
      ...(detail ? { detail } : {}),
      ...(actor.request ? { request: actor.request } : {}),
    });
  }

  return {
    get: (actor) =>
      inOrg(actor, (tx) => service.view(createDrizzleConfigStore(tx), actor.organizationId)),

    async put(actor, body, expectedVersion) {
      const result = await inOrg(actor, async (tx) => {
        const done = await service.put(createDrizzleConfigStore(tx), actor, body, expectedVersion);
        if (done.changedFields.length > 0) {
          await record(tx, actor, CLEARINGHOUSE_AUDIT_EVENTS.put, done.changedFields, {
            created: done.created,
            status: done.view.status ?? "none",
          });
        }
        return { created: done.created, view: done.view };
      });
      return then(actor.organizationId, result);
    },

    async recordBaa(actor, body) {
      const result = await inOrg(actor, async (tx) => {
        const done = await service.recordBaa(createDrizzleConfigStore(tx), actor, body);
        if (done.changedFields.length > 0) {
          await record(tx, actor, CLEARINGHOUSE_AUDIT_EVENTS.baaRecorded, done.changedFields, {
            status: done.view.status ?? "none",
          });
        }
        return done.view;
      });
      return then(actor.organizationId, result);
    },

    async verify(actor, body) {
      // Read + decrypt in one transaction, the vendor call with none open, the compare-and-set in another.
      const plan = await inOrg(actor, (tx) =>
        service.prepareVerify(createDrizzleConfigStore(tx), actor, body),
      );
      const outcome = await service.runProbe(plan);
      const result = await inOrg(actor, async (tx) => {
        const done = await service.completeVerify(
          createDrizzleConfigStore(tx),
          actor,
          plan,
          outcome,
        );
        await record(tx, actor, CLEARINGHOUSE_AUDIT_EVENTS.verified, [], {
          kind: plan.evidence === null ? "connection_test" : "attested",
          ...(done.test ? { outcome: done.test.outcome } : {}),
        });
        return done;
      });
      return then(actor.organizationId, result);
    },

    async activate(actor) {
      const view = await inOrg(actor, async (tx) => {
        const done = await service.activate(createDrizzleConfigStore(tx), actor);
        await record(tx, actor, CLEARINGHOUSE_AUDIT_EVENTS.activated, [], {
          status: done.status ?? "none",
        });
        return done;
      });
      return then(actor.organizationId, view);
    },
  };
}
