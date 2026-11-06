// apps/backend/src/modules/12-dosespot/tenant-config/tenant-service.ts — the tenant routes' service: the rules of `service.ts`
// run on the tenant pool under the caller's own `withOrgContext` (RLS scopes every statement to the caller's organization; the
// M4 write-audit trigger attributes each row change to the caller via `app.user_id`).
//
// Every change ALSO writes a field-level audit row (names, never values) in the same transaction, through the injected
// `ClinicAuditPort`, plus the in-transaction effects (outbox event, go-live void) of `effects.ts`. `verify` is three steps in two
// transactions (service.ts): read and unseal, then the vendor probe with NO transaction open, then lock and compare-and-set.
// After a change COMMITS the optional `onChanged` hook runs (the composition root binds it to the M34 onboarding advance pass, so
// activating settles the wizard step at once) and a lost-service alert goes out; a failure of either is logged, never failed.
import type { DbClient } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { CLINIC_AUDIT_EVENTS, type ClinicAuditEvent, type ClinicAuditPort } from "./audit-port";
import { createDrizzleConfigStore } from "./config-store";
import {
  type ClinicAlertPort,
  type ClinicEffectDeps,
  type ClinicServiceChange,
  alertAfterCommit,
  applyInTransaction,
  changeOfPut,
  changeOfTransition,
  registrationOf,
} from "./effects";
import type { ClinicRequestActor } from "./route-guards";
import type { ClinicConfigView, DoseSpotClinicService, PutClinicInput } from "./service";

export interface DoseSpotClinicRouteService {
  get(organizationId: string, userId: string): Promise<ClinicConfigView>;
  put(
    actor: ClinicRequestActor,
    body: PutClinicInput,
    expectedVersion: number | undefined,
  ): Promise<{ readonly created: boolean; readonly view: ClinicConfigView }>;
  verify(actor: ClinicRequestActor): Promise<{
    readonly view: ClinicConfigView;
    readonly test: { readonly outcome: string };
  }>;
  activate(actor: ClinicRequestActor): Promise<ClinicConfigView>;
  deactivate(actor: ClinicRequestActor): Promise<ClinicConfigView>;
}

export function buildDrizzleDoseSpotClinicRouteService(
  deps: ClinicEffectDeps & {
    readonly db: DbClient;
    readonly service: DoseSpotClinicService;
    /** The field-level audit writer (required: a change is never silently un-audited). */
    readonly audit: ClinicAuditPort;
    readonly alerts?: ClinicAlertPort;
    /** Post-commit, best effort. */
    readonly onChanged?: (organizationId: string) => Promise<void>;
    readonly logError?: (cause: unknown, context: { organizationId: string }) => void;
  },
): DoseSpotClinicRouteService {
  const { db, service, audit } = deps;
  const inOrg = <T>(
    organizationId: string,
    userId: string,
    fn: (tx: DbClient) => Promise<T>,
  ): Promise<T> => withOrgContext<DbClient, T>(db, { organizationId, userId }, fn);

  /** The audit row, the outbox event and the go-live void of one change, on the change's own transaction. */
  async function record(
    tx: DbClient,
    actor: ClinicRequestActor,
    eventType: ClinicAuditEvent,
    changedFields: readonly string[],
    change: ClinicServiceChange | null,
    detail?: Readonly<Record<string, string | number | boolean>>,
  ): Promise<{ readonly id: string; readonly environment: "sandbox" | "production" }> {
    const registration = await registrationOf(createDrizzleConfigStore(tx), actor.organizationId);
    await audit.record(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      actorMembershipId: actor.membershipId,
      eventType,
      resourceKind: "dosespot_clinic_registration",
      resourceId: registration.id,
      changedFields,
      ...(detail ? { detail } : {}),
      request: actor.request,
    });
    await applyInTransaction(tx, deps, {
      organizationId: actor.organizationId,
      userId: actor.userId,
      membershipId: actor.membershipId,
      registration,
      change,
    });
    return registration;
  }

  /** After the commit: the lost-service alert and the onboarding settle. Never fails the change. */
  async function afterCommit(
    organizationId: string,
    registration: { readonly id: string; readonly environment: "sandbox" | "production" },
    change: ClinicServiceChange | null,
  ): Promise<void> {
    try {
      await alertAfterCommit(deps.alerts, organizationId, registration, change);
    } catch (cause) {
      deps.logError?.(cause, { organizationId });
    }
    try {
      await deps.onChanged?.(organizationId);
    } catch (cause) {
      deps.logError?.(cause, { organizationId });
    }
  }

  return {
    get: (organizationId, userId) =>
      inOrg(organizationId, userId, (tx) =>
        service.view(createDrizzleConfigStore(tx), organizationId),
      ),

    async put(actor, body, expectedVersion) {
      const done = await inOrg(actor.organizationId, actor.userId, async (tx) => {
        const result = await service.put(
          createDrizzleConfigStore(tx),
          actor,
          body,
          expectedVersion,
        );
        if (result.changedFields.length === 0) return { result, registration: null, change: null };
        const change = changeOfPut(result);
        const registration = await record(
          tx,
          actor,
          CLINIC_AUDIT_EVENTS.put,
          result.changedFields,
          change,
          {
            created: result.created,
            status: result.view.status ?? "none",
          },
        );
        return { result, registration, change };
      });
      if (done.registration)
        await afterCommit(actor.organizationId, done.registration, done.change);
      return { created: done.result.created, view: done.result.view };
    },

    async verify(actor) {
      // Read + unseal in one transaction, the vendor call with none open, the compare-and-set in another.
      const plan = await inOrg(actor.organizationId, actor.userId, (tx) =>
        service.prepareVerify(createDrizzleConfigStore(tx), actor),
      );
      const outcome = await service.runProbe(plan);
      const done = await inOrg(actor.organizationId, actor.userId, async (tx) => {
        const result = await service.completeVerify(
          createDrizzleConfigStore(tx),
          actor,
          plan,
          outcome,
        );
        const registration = await record(
          tx,
          actor,
          CLINIC_AUDIT_EVENTS.verified,
          ["lastTest"],
          null,
          {
            testOutcome: result.test.outcome,
            status: result.view.status ?? "none",
          },
        );
        return { result, registration };
      });
      await afterCommit(actor.organizationId, done.registration, null);
      return done.result;
    },

    async activate(actor) {
      const done = await inOrg(actor.organizationId, actor.userId, async (tx) => {
        const result = await service.activate(createDrizzleConfigStore(tx), actor);
        if (!result.changed) return { result, registration: null, change: null };
        const change = changeOfTransition(result, "activated");
        const registration = await record(
          tx,
          actor,
          CLINIC_AUDIT_EVENTS.activated,
          ["status"],
          change,
        );
        return { result, registration, change };
      });
      if (done.registration)
        await afterCommit(actor.organizationId, done.registration, done.change);
      return done.result.view;
    },

    async deactivate(actor) {
      const done = await inOrg(actor.organizationId, actor.userId, async (tx) => {
        const result = await service.deactivate(createDrizzleConfigStore(tx), actor);
        if (!result.changed) return { result, registration: null, change: null };
        const change = changeOfTransition(result, "deactivated");
        const registration = await record(
          tx,
          actor,
          CLINIC_AUDIT_EVENTS.deactivated,
          ["status"],
          change,
        );
        return { result, registration, change };
      });
      if (done.registration)
        await afterCommit(actor.organizationId, done.registration, done.change);
      return done.result.view;
    },
  };
}
