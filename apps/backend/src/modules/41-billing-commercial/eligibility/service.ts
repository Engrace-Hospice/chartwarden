// apps/backend/src/modules/41-billing-commercial/eligibility/service.ts - M41 commercial eligibility (270/271), issue #724.
//
// ONE path to a payer: the platform ClearinghouseTransport binding (ADR-0100 D4). There is no direct-to-payer channel and no
// fallback clearinghouse. The order is fail closed, and each step that refuses sends nothing:
//   service date valid -> idempotent replay? -> plan exists -> gate (bound, routed, enrolled) -> coverage names this payer
//   -> clearinghouse context (NPI on file) -> ONE checkEligibility call -> validate the answer -> persist outcome + as-of date.
//
// MEMBER ID: it is read from M5's coverage seam into a local variable, handed to the transport in the request object, and goes
// no further. It is never stored (the table has no column for it), never in a log event, never in an error message, and
// transport failures are reduced to a fixed message plus a code before they leave this function.
import {
  COMMERCIAL_ELIGIBILITY_ERROR,
  COMMERCIAL_ELIGIBILITY_OUTCOME_VALUES,
  COMMERCIAL_SEND_REFUSAL,
  type CommercialEligibilityOutcome,
  type PatientCoverage,
  type PatientCoverageReader,
  IdempotencyConflictError,
  NotFoundError,
  ValidationError,
} from "@chartwarden/types";
import {
  CH,
  type ClearinghouseContext,
  type ClearinghouseTransport,
} from "@chartwarden/x12-837-client";
import { CommercialRefusalError, HTTP_STATUS, statusForRefusal } from "../errors";
import { type EligibilityFreshnessFinding, evaluateEligibilityFreshness } from "./freshness";
import { evaluateSendGate } from "./send-gate";
import type { EligibilityStore, OrgScope, PlanRef, StoredEligibilityCheck } from "./store";

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
/** A real calendar day: 2026-02-30 is refused (Date.parse would roll it over). */
const isRealDay = (v: string): boolean =>
  ISO_DAY.test(v) && new Date(`${v}T00:00:00.000Z`).toISOString().startsWith(v);
const DEFAULT_LIST_LIMIT = 20;
const LATEST_SCAN_LIMIT = 50;

export type EligibilityActor = OrgScope;

export interface CheckEligibilityArgs {
  readonly providerEntityId: string;
  readonly locationId?: string | null;
  readonly patientId: string;
  readonly planId: string;
  /** ISO yyyy-mm-dd the coverage is checked for. */
  readonly serviceDate: string;
  /** The route's Idempotency-Key. Also the row's uniqueness key, so a worker retry cannot double-record. */
  readonly idempotencyKey: string;
}

/** What callers and the API see. No member id, no 271 body. */
export interface EligibilityCheckView {
  readonly id: string;
  readonly providerEntityId: string;
  readonly patientId: string;
  readonly planId: string;
  readonly clearinghouseKey: string;
  readonly serviceDate: string;
  readonly outcome: CommercialEligibilityOutcome;
  readonly asOfDate: string;
  readonly requestId: string;
  readonly checkedAt: string;
  readonly replayed: boolean;
  readonly freshness: EligibilityFreshnessFinding;
}

export interface LatestEligibilityView {
  readonly latest: EligibilityCheckView | null;
  readonly freshness: EligibilityFreshnessFinding;
}

/** The clearinghouse binding as the service needs it: `vendor` null means unbound. */
export interface ClearinghouseBindingPort {
  readonly vendor: string | null;
  readonly transport: Pick<ClearinghouseTransport, "checkEligibility">;
}

export interface CommercialContextPort {
  /** The per-call context for the provider entity and the payer id the clearinghouse routes on; null when no NPI is on file. */
  contextFor(
    organizationId: string,
    providerEntityId: string,
    clearinghousePayerId: string,
  ): Promise<ClearinghouseContext | null>;
}

/** PHI-free: event name, a stable code, an error class name. Never a value from the request or the response. */
export interface EligibilityLogEvent {
  readonly event: "eligibility.refused" | "eligibility.transport_fault" | "eligibility.checked";
  readonly code?: string;
  readonly errorName?: string;
}

export interface EligibilityServiceDeps {
  readonly store: EligibilityStore;
  readonly coverage: Pick<PatientCoverageReader, "coveragesForPatient">;
  readonly binding: ClearinghouseBindingPort;
  readonly contexts: CommercialContextPort;
  readonly now: () => Date;
  readonly newRequestId: () => string;
  readonly log: (event: EligibilityLogEvent) => void;
}

const unavailable = (): CommercialRefusalError =>
  new CommercialRefusalError(
    COMMERCIAL_ELIGIBILITY_ERROR.CLEARINGHOUSE_UNAVAILABLE,
    "The clearinghouse could not answer the eligibility check. Nothing was recorded. Try again shortly.",
    HTTP_STATUS.UNAVAILABLE,
  );

/** Reduce a transport refusal to a fixed code and message. The vendor's reason text is dropped on purpose. */
function refusalFromTransportCode(code: string): CommercialRefusalError {
  switch (code) {
    case CH.NOT_WIRED:
      return new CommercialRefusalError(
        COMMERCIAL_SEND_REFUSAL.NOT_WIRED,
        "The connected clearinghouse cannot run commercial eligibility checks yet, so nothing was sent. Ask a platform administrator.",
        HTTP_STATUS.UNAVAILABLE,
      );
    case CH.NOT_ENROLLED:
      return new CommercialRefusalError(
        COMMERCIAL_SEND_REFUSAL.PROVIDER_NOT_ENROLLED,
        "The clearinghouse reports this provider entity is not enrolled with the payer. Complete enrollment before retrying.",
        HTTP_STATUS.CONFLICT,
      );
    case CH.INVALID_REQUEST:
      return new CommercialRefusalError(
        COMMERCIAL_ELIGIBILITY_ERROR.CLEARINGHOUSE_REJECTED,
        "The clearinghouse refused the eligibility request. Check the plan's payer id and the patient's coverage, then retry.",
        HTTP_STATUS.UNPROCESSABLE,
      );
    default:
      return unavailable();
  }
}

function inForceOn(c: PatientCoverage, day: string): boolean {
  return c.effectiveFrom <= day && (c.effectiveTo === null || c.effectiveTo >= day);
}

const sameRequest = (row: StoredEligibilityCheck, args: CheckEligibilityArgs): boolean =>
  row.patientId === args.patientId &&
  row.planId === args.planId &&
  row.serviceDate === args.serviceDate &&
  row.providerEntityId === args.providerEntityId;

const isOutcome = (v: unknown): v is CommercialEligibilityOutcome =>
  (COMMERCIAL_ELIGIBILITY_OUTCOME_VALUES as readonly unknown[]).includes(v);

export function createEligibilityService(deps: EligibilityServiceDeps) {
  const { store, binding } = deps;

  function view(
    row: StoredEligibilityCheck,
    plan: PlanRef,
    replayed: boolean,
  ): EligibilityCheckView {
    return {
      id: row.id,
      providerEntityId: row.providerEntityId,
      patientId: row.patientId,
      planId: row.planId,
      clearinghouseKey: row.clearinghouseKey,
      serviceDate: row.serviceDate,
      outcome: row.outcome,
      asOfDate: row.asOfDate,
      requestId: row.requestId,
      checkedAt: row.checkedAt,
      replayed,
      freshness: evaluateEligibilityFreshness({
        latest: { outcome: row.outcome, checkedAt: row.checkedAt },
        policy: plan.eligibilityStalenessPolicy,
        maxAgeDays: plan.eligibilityMaxAgeDays,
        now: deps.now().toISOString(),
      }),
    };
  }

  const refuse = (e: CommercialRefusalError): never => {
    deps.log({ event: "eligibility.refused", code: e.code });
    throw e;
  };

  async function loadPlan(scope: OrgScope, planId: string): Promise<PlanRef> {
    const plan = await store.loadPlan(scope, planId);
    if (!plan) throw new NotFoundError("payer plan", planId);
    return plan;
  }

  return {
    async check(
      actor: EligibilityActor,
      args: CheckEligibilityArgs,
    ): Promise<EligibilityCheckView> {
      const { organizationId } = actor;
      if (!isRealDay(args.serviceDate)) {
        throw new ValidationError("serviceDate must be a date (yyyy-mm-dd)", [
          { field: "serviceDate", code: "INVALID", message: "must be a date (yyyy-mm-dd)" },
        ]);
      }

      const plan = await loadPlan(actor, args.planId);

      // A repeat of the same request answers from the stored row; the same key for a different request is a conflict.
      const prior = await store.findCheckByIdempotencyKey(
        actor,
        args.providerEntityId,
        args.idempotencyKey,
      );
      if (prior) {
        if (!sameRequest(prior, args)) throw new IdempotencyConflictError();
        return view(prior, plan, true);
      }

      const clearinghouseKey = binding.vendor;
      const [routes, enrollments] =
        clearinghouseKey === null
          ? [[], []]
          : await Promise.all([
              store.routesFor(actor, plan.id, clearinghouseKey),
              store.enrollmentsFor(actor, args.providerEntityId, plan.payerId, clearinghouseKey),
            ]);
      const gate = evaluateSendGate({
        clearinghouseKey,
        routes,
        enrollments,
        serviceDate: args.serviceDate,
      });
      if (!gate.ok) {
        return refuse(new CommercialRefusalError(gate.code, gate.message, statusForRefusal(gate.code)));
      }
      // The gate proved the binding is non-null; narrow for the rest of the function.
      const boundKey = clearinghouseKey as string;

      const coverages = await deps.coverage.coveragesForPatient({
        organizationId,
        patientId: args.patientId,
      });
      const chosen = [...coverages]
        .sort((a, b) => a.rank - b.rank)
        .find(
          (c) =>
            c.payerId === plan.payerId &&
            inForceOn(c, args.serviceDate) &&
            c.subscriberId.trim() !== "",
        );
      if (!chosen) {
        return refuse(
          new CommercialRefusalError(
            COMMERCIAL_ELIGIBILITY_ERROR.COVERAGE_NOT_FOUND,
            "The patient has no coverage with this plan's payer and a member id on the service date. Add or correct the coverage, then retry.",
            HTTP_STATUS.UNPROCESSABLE,
          ),
        );
      }

      const ctx = await deps.contexts.contextFor(
        organizationId,
        args.providerEntityId,
        gate.clearinghousePayerId,
      );
      if (!ctx) {
        return refuse(
          new CommercialRefusalError(
            "COMMERCIAL_PROVIDER_NPI_MISSING",
            "The provider entity has no NPI on file, so nothing was sent. Add the NPI, then retry.",
            HTTP_STATUS.CONFLICT,
          ),
        );
      }

      // The id sent to the clearinghouse is the id stored, so a vendor log joins to our audit trail.
      const requestId = deps.newRequestId();
      let answer: Awaited<ReturnType<ClearinghouseTransport["checkEligibility"]>>;
      try {
        answer = await binding.transport.checkEligibility(
          { ...ctx, correlationId: requestId },
          // TRANSIENT: the only place the member id leaves the coverage row.
          { memberId: chosen.subscriberId.trim(), serviceDate: args.serviceDate },
        );
      } catch (error) {
        // Only the class name is kept: a message could carry whatever the transport interpolated.
        deps.log({
          event: "eligibility.transport_fault",
          errorName: error instanceof Error ? error.name : "unknown",
        });
        throw unavailable();
      }
      if (!answer.ok) {
        return refuse(refusalFromTransportCode(answer.degraded.code));
      }
      const { outcome, asOfDate } = answer.data;
      if (!isOutcome(outcome) || !isRealDay(asOfDate)) {
        return refuse(unavailable());
      }

      const { row, replayed } = await store.insertCheck(actor, {
        organizationId,
        providerEntityId: args.providerEntityId,
        locationId: args.locationId ?? null,
        patientId: args.patientId,
        planId: plan.id,
        patientPayerId: chosen.id,
        clearinghouseKey: boundKey,
        clearinghousePayerId: gate.clearinghousePayerId,
        serviceDate: args.serviceDate,
        outcome,
        asOfDate,
        requestId,
        idempotencyKey: args.idempotencyKey,
        checkedByUserId: actor.userId,
      });
      // A concurrent request with the same key may have won the insert: it only counts as a replay if it was the same request.
      if (replayed && !sameRequest(row, args)) throw new IdempotencyConflictError();
      deps.log({ event: "eligibility.checked" });
      return view(row, plan, replayed);
    },

    /** The newest check for a patient and plan, with the plan's freshness verdict. */
    async latest(
      actor: EligibilityActor,
      args: {
        readonly providerEntityId: string;
        readonly patientId: string;
        readonly planId: string;
        /**
         * When given, only a check made FOR this service date counts (a check for another date of service says nothing about this
         * one). Claim assembly passes the claim's date of service; without it the newest check of any date is used.
         */
        readonly serviceDate?: string;
      },
    ): Promise<LatestEligibilityView> {
      const plan = await loadPlan(actor, args.planId);
      const recent = await store.listChecks(actor, {
        providerEntityId: args.providerEntityId,
        patientId: args.patientId,
        planId: args.planId,
        limit: LATEST_SCAN_LIMIT,
      });
      const newest = args.serviceDate
        ? recent.find((c) => c.serviceDate === args.serviceDate)
        : recent[0];
      const freshness = evaluateEligibilityFreshness({
        latest: newest ? { outcome: newest.outcome, checkedAt: newest.checkedAt } : null,
        policy: plan.eligibilityStalenessPolicy,
        maxAgeDays: plan.eligibilityMaxAgeDays,
        now: deps.now().toISOString(),
      });
      return { latest: newest ? view(newest, plan, false) : null, freshness };
    },

    async list(
      actor: EligibilityActor,
      args: {
        readonly providerEntityId: string;
        readonly patientId: string;
        readonly planId?: string;
        readonly limit?: number;
      },
    ): Promise<readonly StoredEligibilityCheck[]> {
      return store.listChecks(actor, {
        providerEntityId: args.providerEntityId,
        patientId: args.patientId,
        ...(args.planId ? { planId: args.planId } : {}),
        limit: args.limit ?? DEFAULT_LIST_LIMIT,
      });
    },
  };
}

export type EligibilityService = ReturnType<typeof createEligibilityService>;
