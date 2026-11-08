// apps/backend/src/modules/34-saas-tenant-platform/routes/platform/onboarding-clearinghouse-put.ts — the operator's clearinghouse write
// (`putClearinghouse` of the onboarding data service), including the switch out of `outside` that also sets the billing mode: the plan,
// the early refusals, the mode written before the vendor, the vendor write on the data service's one-transaction `write()`, and the
// recovery when the vendor change fails (mode put back to none, or kept when an ambiguous COMMIT landed) or the mode is not confirmed.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { ChartWardenError, NotFoundError } from "@chartwarden/types";
import { eq } from "drizzle-orm";
import type {
  OnboardingClearinghousePort,
  OnboardingWriteScope,
} from "../../../../bootstrap/onboarding-clearinghouse-port";
import { sqlStatesInChain } from "../../../../bootstrap/redact-database-error";
import {
  type ClearinghouseSwitchPlan,
  planClearinghouseSwitch,
} from "./onboarding-clearinghouse-switch";
import {
  ONBOARDING_DATA_AUDIT_EVENTS as EVENTS,
  type OnboardingAuditTarget,
  type OnboardingOperator,
  recordOnboardingAudit,
} from "./onboarding-data-audit";
import type {
  OnboardingDataDeps,
  OnboardingDataService,
  OnboardingFields,
} from "./onboarding-data-types";
import type { WriteResult, WriteSpec } from "./onboarding-write-types";
import { CLEARINGHOUSE_SWITCH_STATUSES } from "./tenant-onboarding-lock";

export const CLEARINGHOUSE_KIND = "tenant_clearinghouse_config";

const ACCOUNT = schema.tenantAccount;

/** The data service's own pieces the put runs on, passed in so this file imports no value from the service that uses it. */
export interface ClearinghousePutDeps {
  readonly deps: Pick<OnboardingDataDeps, "db" | "billingMode" | "warn" | "logAuditError">;
  readonly clearinghousePort: () => OnboardingClearinghousePort;
  readonly targetOf: (orgSlug: string) => Promise<OnboardingAuditTarget>;
  readonly scopeOf: (op: OnboardingOperator, organizationId: string) => OnboardingWriteScope;
  readonly write: <T>(
    op: OnboardingOperator,
    orgSlug: string,
    spec: WriteSpec,
    run: (tx: DbClient, target: OnboardingAuditTarget) => Promise<WriteResult<T>>,
    resolved?: OnboardingAuditTarget,
  ) => Promise<T>;
  readonly recordFailedWrite: (
    op: OnboardingOperator,
    target: OnboardingAuditTarget,
    spec: WriteSpec,
    err: unknown,
  ) => Promise<void>;
  readonly statusRefusal: (
    spec: Pick<WriteSpec, "allowedStatuses">,
    status: string,
  ) => ChartWardenError;
  readonly settleStepAfter: <T>(organizationId: string, result: T) => Promise<T>;
}

type PutResult = Awaited<ReturnType<OnboardingDataService["putClearinghouse"]>>;

export function createClearinghousePut(ctx: ClearinghousePutDeps) {
  const { deps, clearinghousePort, scopeOf } = ctx;
  const { db } = deps;

  /** The tenant's status on a short org-scoped read (no lock): the early look the switch takes BEFORE it writes the billing mode. */
  async function tenantStatusOf(
    op: OnboardingOperator,
    target: OnboardingAuditTarget,
  ): Promise<string> {
    return withOrgContext<DbClient, string>(
      db,
      { organizationId: target.organizationId, userId: op.userId },
      async (tx) => {
        const [account] = await tx
          .select({ status: ACCOUNT.status })
          .from(ACCOUNT)
          .where(eq(ACCOUNT.organizationId, target.organizationId))
          .limit(1);
        if (!account) throw new NotFoundError("tenant");
        return account.status;
      },
    );
  }

  /**
   * The audit row a refusal for the tenant's status leaves (the same `write_refused` row `write()` leaves, there in the write's own
   * transaction), here on its own short transaction because nothing else is open yet. FAIL CLOSED: a refusal that cannot be audited is
   * answered 503 (the cause is logged), never a 409 with no trail. Nothing was changed either way.
   */
  async function recordStatusRefusal(
    op: OnboardingOperator,
    target: OnboardingAuditTarget,
    spec: WriteSpec,
    status: string,
  ): Promise<void> {
    try {
      await withOrgContext<DbClient, void>(
        db,
        { organizationId: target.organizationId, userId: op.userId },
        (tx) =>
          recordOnboardingAudit(tx, op, target, {
            eventType: EVENTS.writeRefused,
            resourceKind: spec.resourceKind,
            outcome: "denied",
            reason: spec.reason,
            detail: { attemptedEvent: spec.event, tenantStatus: status },
          }),
      );
    } catch (auditError) {
      deps.logAuditError?.(auditError, { organizationId: target.organizationId });
      throw new ChartWardenError(
        "ONBOARDING_AUDIT_UNAVAILABLE",
        "the refusal could not be recorded in the audit trail, so it was not answered; nothing was changed, try again",
        503,
      );
    }
  }

  /**
   * What an operator's clearinghouse write needs beyond the vendor: only a vendor write (or a write that names a billing mode) reads the
   * tenant's current choice, and only the switch OUT of outside for a contracted tenant carries a mode.
   */
  async function planSwitch(
    op: OnboardingOperator,
    target: OnboardingAuditTarget,
    fields: OnboardingFields,
  ): Promise<ClearinghouseSwitchPlan> {
    if (fields.vendor === "outside" && fields.billingServiceMode === undefined) {
      return { body: fields, billingServiceMode: null };
    }
    return planClearinghouseSwitch(
      {
        clearinghouse: clearinghousePort(),
        ...(deps.billingMode ? { billingMode: deps.billingMode } : {}),
        ...(deps.warn ? { warn: deps.warn } : {}),
      },
      scopeOf(op, target.organizationId),
      fields,
    );
  }

  /**
   * The vendor's COMMIT failed with no definite answer from the database, so the row may have landed and putting the mode back to none
   * blindly could leave a vendor without its mode. The vendor is read again: still outside -> null (it did not land: the caller restores
   * none); no longer outside -> the switch stands and its result is the row as it is now (the caller goes on as for a success, so the
   * mode is confirmed); unreadable -> the mode is LEFT as set and the answer is the typed 503 that says the outcome is unknown (logged).
   * RESIDUAL (narrow, not closable from here): a commit the client gave up on can still land AFTER the read-back saw `outside` (the
   * server was still processing it), leaving a vendor with the mode put back to none; the operator reads the tenant's clearinghouse and
   * contract after any failed switch and sets the mode (CHANGES.md and the OpenAPI summary say so for every failed switch; the 503's own
   * message says to read them only on the unreadable path above).
   */
  async function vendorLandedAfterAmbiguousCommit(
    op: OnboardingOperator,
    target: OnboardingAuditTarget,
    commitError: unknown,
  ): Promise<{ created: boolean; view: unknown } | null> {
    let current: { vendor?: string | null; source?: string };
    try {
      current = (await clearinghousePort().get(
        scopeOf(op, target.organizationId),
      )) as typeof current;
    } catch (readError) {
      deps.warn?.(
        "m34.onboarding data: the clearinghouse switch's COMMIT failed without a definite answer and the vendor could not be read again; the billing mode was left as set",
        { organizationId: target.organizationId, err: readError, commitError },
      );
      throw new ChartWardenError(
        "CLEARINGHOUSE_SWITCH_OUTCOME_UNKNOWN",
        "the clearinghouse change may or may not have been saved, and the billing mode was left as set; read the tenant's clearinghouse and contract before changing anything",
        503,
      );
    }
    if (current.source === "tenant" && current.vendor === "outside") {
      // Not landed as far as this read can tell, and the mode goes back to none: leave the ids that let ops correlate it if the commit
      // the client gave up on lands anyway (the residual above). Ids only: the organization and the error's class, never the error.
      deps.warn?.(
        "m34.onboarding data: the clearinghouse switch's COMMIT failed without a definite answer and the vendor still reads as outside; the billing mode goes back to none (a commit the client gave up on could still land)",
        {
          organizationId: target.organizationId,
          sqlstate: sqlStatesInChain(commitError)[0] ?? null,
          errorType: commitError instanceof Error ? commitError.name : typeof commitError,
        },
      );
      return null;
    }
    deps.warn?.(
      "m34.onboarding data: the clearinghouse switch's COMMIT failed without a definite answer but the vendor row is there; the switch stands and the billing mode was kept",
      { organizationId: target.organizationId, err: commitError },
    );
    // A switch always changes an existing row (the tenant was outside), so it is an update, never a creation.
    return { created: false, view: current };
  }

  /** The vendor change failed after the mode was set: the tenant, still outside, goes back to none (best effort, loudly warned). */
  async function restoreNoneAfterFailedSwitch(
    mode: ClearinghouseSwitchPlan["billingServiceMode"],
    organizationId: string,
  ): Promise<void> {
    if (mode === null || mode === "none" || !deps.billingMode) return;
    try {
      await deps.billingMode.restoreNone(organizationId);
    } catch (cause) {
      deps.warn?.(
        "m34.onboarding data: putting the billing mode back to none after a failed switch also failed; the hourly pricing sweep corrects it",
        { organizationId, err: cause },
      );
    }
  }

  /**
   * After the vendor committed: the operator's mode is asked for once more (idempotent), and once more if that fails. Returns whether it
   * was confirmed; when it was not, the cause is warned about and the CALLER tells the operator (the vendor change stands).
   */
  async function reassertModeAfterSwitch(
    op: OnboardingOperator,
    orgSlug: string,
    mode: NonNullable<ClearinghouseSwitchPlan["billingServiceMode"]>,
    reason: string,
    organizationId: string,
  ): Promise<boolean> {
    let lastCause: unknown;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        await deps.billingMode?.setModeLeavingOutside(op, orgSlug, mode, reason);
        return true;
      } catch (cause) {
        lastCause = cause;
      }
    }
    deps.warn?.(
      "m34.onboarding data: the vendor switch committed but the billing mode could not be confirmed afterwards (after a retry); read the tenant's contract and set it if it is not the one chosen",
      { organizationId, err: lastCause },
    );
    return false;
  }

  return async function putClearinghouse(
    op: OnboardingOperator,
    orgSlug: string,
    fields: OnboardingFields,
    reason: string,
    expectedVersion: number | undefined,
  ): Promise<PutResult> {
    const target = await ctx.targetOf(orgSlug);
    const spec = { event: EVENTS.clearinghouseSet, resourceKind: CLEARINGHOUSE_KIND, reason };
    // Everything that can be refused BEFORE anything is written is judged first: the plan (a mode named or missing, 422) and, for the
    // switch out of outside, the put's own refusals (the body's rules, the If-Match, the locks, the credential). So a plain input error
    // writes nothing, not even the billing mode. A refusal here is audited like any other failed attempt.
    let plan: ClearinghouseSwitchPlan;
    try {
      plan = await planSwitch(op, target, fields);
      if (plan.billingServiceMode !== null) {
        // The status is looked at BEFORE the mode is written: a tenant that is offboarding, retained or being destroyed is refused
        // here, with the refusal audited, instead of getting a mode set and put back. `write()` judges it again under the lock.
        const status = await tenantStatusOf(op, target);
        if (!CLEARINGHOUSE_SWITCH_STATUSES.has(status)) {
          const refusal = ctx.statusRefusal(
            { allowedStatuses: CLEARINGHOUSE_SWITCH_STATUSES },
            status,
          );
          await recordStatusRefusal(op, target, spec, status);
          throw refusal;
        }
        await clearinghousePort().validatePut(
          scopeOf(op, target.organizationId),
          plan.body,
          expectedVersion,
        );
      }
    } catch (err) {
      // A status refusal already left its own row (write_refused); every other early refusal is a failed attempt.
      if (!(err instanceof ChartWardenError && err.code === "TENANT_NOT_ONBOARDING")) {
        await ctx.recordFailedWrite(op, target, spec, err);
      }
      throw err;
    }
    const mode = plan.billingServiceMode;
    // Leaving `outside` for a vendor while the tenant has a contract also sets the billing mode: BEFORE the vendor, so a failure never
    // leaves a vendor without its mode, and put back to none if the vendor change then fails.
    if (mode !== null && deps.billingMode) {
      try {
        await deps.billingMode.setModeLeavingOutside(op, orgSlug, mode, reason);
      } catch (err) {
        // The mode is written before the vendor: a refusal there ends the attempt, and it is audited like any other failed attempt.
        await ctx.recordFailedWrite(op, target, spec, err);
        throw err;
      }
    }
    let result: { created: boolean; view: unknown };
    // Set by `write()` when the vendor's COMMIT failed without a definite answer from the database: the vendor row may have landed.
    let commitMayHaveLanded = false;
    try {
      result = await ctx.write(
        op,
        orgSlug,
        // The contracted tenant's switch is the operator's for a live tenant too (an explicit allowlist of statuses): a tenant that
        // bills outside has no other way to leave outside (its own lane is blocked while a contract exists). Every other clearinghouse
        // write stays onboarding-only.
        {
          ...spec,
          ...(mode !== null ? { allowedStatuses: CLEARINGHOUSE_SWITCH_STATUSES } : {}),
          onFailure: async ({ commitReached }) => {
            commitMayHaveLanded = commitReached;
          },
        },
        async (tx, t) => {
          const done = await clearinghousePort().put(
            tx,
            scopeOf(op, t.organizationId),
            plan.body,
            expectedVersion,
          );
          return {
            value: { created: done.created === true, view: done.view },
            resourceId: done.resourceId,
            ...(done.changedFields ? { changedFields: done.changedFields } : {}),
          };
        },
        target,
      );
    } catch (err) {
      // A failure the database refused (or one before the commit) is a certain rollback: the tenant is still outside, so the mode goes
      // back to none. A COMMIT that failed with no definite answer may have landed: look at the vendor row before undoing anything.
      const landed =
        commitMayHaveLanded && mode !== null
          ? await vendorLandedAfterAmbiguousCommit(op, target, err)
          : null;
      if (landed === null) {
        await restoreNoneAfterFailedSwitch(mode, target.organizationId);
        throw err;
      }
      result = landed;
    }
    // The vendor is committed and the tenant no longer bills outside, so nothing the system does reverts the mode now. But a sync or
    // sweep may have set none in the window between the mode write and this commit (the tenant was still outside): ask for the
    // operator's mode again. Idempotent (a no-op when it is already in force or pending), dated like any mode change.
    const confirmed =
      mode !== null && deps.billingMode
        ? await reassertModeAfterSwitch(op, orgSlug, mode, reason, target.organizationId)
        : true;
    const settled = await ctx.settleStepAfter(target.organizationId, result);
    // An unconfirmed mode is never a silent 200: the flag travels with the result, and the screen says so.
    return confirmed ? settled : { ...settled, billingModeConfirmed: false as const };
  };
}
