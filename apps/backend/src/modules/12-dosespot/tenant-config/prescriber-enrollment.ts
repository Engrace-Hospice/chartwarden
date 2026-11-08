// apps/backend/src/modules/12-dosespot/tenant-config/prescriber-enrollment.ts — a prescriber's DoseSpot (vendor) enrolment
// (tenant onboarding slice 4, ADR-0110). Until now the roster `enroll` route only wrote a local row, so `dosespot_prescriber_id`
// (the id `transmit-newrx` sends under) was never set by any production path and an API-enrolled prescriber's orders failed
// permanently as `prescriber_not_enrolled`. This is the missing step: register the clinician at DoseSpot and record its id.
//
// WHO the clinician is is never typed: the NPI and legal name come from the practitioner record the roster links the membership to
// (practitioner-profile.ts: an NPPES-sourced M40 record, cross-checked against NPPES's public directory).
//
// CREATE-THEN-RECORD, never a transaction across the vendor call:
//   1. tx   the registration must be `verified` or `active` (a tenant may enrol before it activates); read the roster row (it must
//           exist, so its linked practitioner record can be read); then, with no transaction open, derive the profile; then tx: CLAIM
//           the roster row (`FOR UPDATE`, refused if the roster moved meanwhile) and COMMIT `vendor_enrollment_requested_at`. A
//           prescriber already linked to DoseSpot returns early (idempotent).
//   2. --   the vendor call (`DoseSpotClient.enrollPrescriber`, resolved under the `setup` purpose), nothing open.
//   3. tx   record the vendor's id and the NPI, publish `m12.prescriber_enrolled` with the REAL vendor id, write the field-level
//           audit row (names, never values) and void a pending go-live (the data it attested just changed).
// A crash between 2 and 3 leaves the request marker set with no vendor id and an orphan clinician at DoseSpot; a retry may meet a
// vendor duplicate (DoseSpot's dedupe by NPI is unverified: it needs a sandbox run). Enrolment never starts EPCS or IAL2.
import type { DbClient } from "@chartwarden/db";
import {
  type DoseSpotClient,
  isConfigUnavailableError,
  isDegradedError,
  isNotEnabledError,
  isUnconfirmedOutcomeError,
} from "@chartwarden/dosespot";
import { ChartWardenError, NotFoundError } from "@chartwarden/types";
import type { DoseSpotWriteOutboxPort } from "../dosespot-route-service-db";
import { CLINIC_AUDIT_EVENTS, type ClinicAuditPort } from "./audit-port";
import type { PractitionerProfile, PractitionerProfileSource } from "./practitioner-profile";

export interface RosterRow {
  readonly id: string;
  readonly membershipId: string;
  readonly dosespotPrescriberId: string | null;
  readonly revokedAt: Date | null;
  readonly vendorEnrollmentRequestedAt: Date | null;
  readonly npi: string | null;
  /** The M40 physician record the roster links this membership to (the source of the NPI and the legal name). */
  readonly externalPhysicianMdmId: string | null;
  /** What the PRESCRIBER confirmed from their own account: the record, and the NPI they were shown (null = never confirmed). */
  readonly linkConfirmedMdmId: string | null;
  readonly linkConfirmedNpi: string | null;
  /** WHO confirmed it: counts only when it is the row's own membership (the CHECK and the trigger say so too; the gate re-checks). */
  readonly linkConfirmedByMembershipId: string | null;
  /** WHO asserted the link (migration 1387; null = before that, or outside the roster route). It must not be the confirmer. */
  readonly linkedByMembershipId: string | null;
}

/**
 * Has the row's OWN member confirmed `physicianMdmId` and `npi`, and is that member NOT the one who made the link? The one test the claim,
 * the view and the enrolment gate share: a link one person both made and confirmed is one person's word, which the confirmation exists to rule out.
 */
export function linkConfirmedBy(
  row: Pick<
    RosterRow,
    | "membershipId"
    | "externalPhysicianMdmId"
    | "linkConfirmedMdmId"
    | "linkConfirmedNpi"
    | "linkConfirmedByMembershipId"
    | "linkedByMembershipId"
  >,
  expected: { readonly physicianMdmId: string | null; readonly npi: string },
): boolean {
  return (
    expected.physicianMdmId !== null &&
    row.externalPhysicianMdmId === expected.physicianMdmId &&
    row.linkConfirmedMdmId === expected.physicianMdmId &&
    row.linkConfirmedNpi === expected.npi &&
    row.linkConfirmedByMembershipId === row.membershipId &&
    row.linkedByMembershipId !== row.linkConfirmedByMembershipId
  );
}

/** The link a profile was derived from, and the NPI it carried: what the claim re-checks under the row lock. */
export interface ExpectedLink {
  readonly physicianMdmId: string | null;
  readonly confirmedNpi: string;
}

/** The two tables an enrolment touches, over ONE open org-scoped transaction. */
export interface RosterStore {
  /** The registration's status and environment, or null when the org has none. */
  registration(
    organizationId: string,
  ): Promise<{ readonly status: string; readonly environment: string } | null>;
  /** Is this membership a member of THIS organization (read under the org's own RLS scope)? */
  membershipExists(organizationId: string, membershipId: string): Promise<boolean>;
  /** The membership's roster row, or null when it is not on the roster. */
  rosterRow(organizationId: string, membershipId: string): Promise<RosterRow | null>;
  /**
   * The step-1 CLAIM on a roster prescriber, atomic on the row (`FOR UPDATE`). The row must exist, still link the physician record the
   * profile was derived from, and still carry the PRESCRIBER's confirmation of that record and NPI (`expected`), else 409
   * `DOSESPOT_ROSTER_CHANGED`. A row that is REVOKED or already
   * LINKED is returned untouched (nothing is stamped, nothing is reinstated); a row whose request marker is younger than
   * `claimWindowMs` with no vendor id is another attempt IN FLIGHT (`inProgress`); otherwise the marker is stamped.
   */
  ensureRequested(
    organizationId: string,
    membershipId: string,
    at: Date,
    claimWindowMs: number,
    expected: ExpectedLink,
  ): Promise<{ readonly row: RosterRow; readonly inProgress: boolean }>;
  /**
   * The PRESCRIBER's confirmation of the linked record: set only for their own live row while it still links `mdmId` (null otherwise).
   * `membershipId` is both the row's member and the confirmer, which the table's CHECK also enforces.
   */
  confirmLink(
    organizationId: string,
    membershipId: string,
    input: { readonly mdmId: string; readonly npi: string; readonly at: Date },
  ): Promise<RosterRow | null>;
  /**
   * Release the claim after a DEFINITIVE refusal, so a corrected retry need not wait out the window. Conditional on THIS attempt's own
   * marker (`claimedAt`): a claim that aged out and was re-stamped by another administrator must not be cleared by the first attempt.
   */
  releaseRequest(organizationId: string, membershipId: string, claimedAt: Date): Promise<void>;
  /** Record the vendor link and the NPI the enrolment was made under. */
  recordVendorId(
    organizationId: string,
    membershipId: string,
    input: {
      readonly dosespotPrescriberId: string;
      readonly npi: string;
      readonly at: Date;
      /**
       * The physician record the NPI came from: the row must still link it AND still carry the member's own confirmation of it and of
       * `npi` (409 DOSESPOT_ROSTER_CHANGED otherwise): a re-link, a revoke or a cleared confirmation while the vendor call ran stops
       * the vendor id being linked under an NPI nobody confirmed.
       */
      readonly expectedPhysicianMdmId: string | null;
    },
  ): Promise<RosterRow>;
}

export interface EnrollActor {
  readonly organizationId: string;
  readonly userId: string;
  readonly membershipId: string;
  readonly request?: {
    readonly correlationId?: string;
    readonly requestId?: string;
    readonly sourceIp?: string;
    readonly userAgent?: string;
  };
}

/**
 * How long a committed request marker with no vendor id means "another enrolment is in flight (or crashed)": then a retry may go. It
 * must outlast the WORST-CASE vendor call, or a slow first attempt would be raced by a second one that creates a duplicate clinician:
 * one DoseSpot request times out at `DOSESPOT_REQUEST_TIMEOUT_MS`, and the call is a token mint plus the add (and the same again for a
 * forced re-mint on a 401), so four timeouts; the window is five minutes, well past that.
 */
export const ENROLL_CLAIM_WINDOW_MS = 5 * 60_000;

/** What step 1 read and validated: everything the vendor call and the record need, so no store call is open while DoseSpot is called. */
export interface EnrollPlan {
  readonly organizationId: string;
  readonly userId: string;
  readonly membershipId: string;
  /** Who DoseSpot is told the clinician is (derived, never typed); null when the prescriber is already linked. */
  readonly profile: PractitionerProfile | null;
  /** The physician record the profile was derived from: recording the vendor id is refused if the roster row no longer links it. */
  readonly physicianMdmId: string | null;
  /** The marker THIS attempt stamped (null when the prescriber was already linked and nothing was claimed). */
  readonly claimedAt: Date | null;
  /** The prescriber is already linked to DoseSpot: there is nothing to call or record. */
  readonly alreadyLinked: boolean;
}

export interface PrescriberEnrollmentService {
  /** The whole flow for the tenant's own route: prepare, call, record (each its own transaction or none). */
  enroll(
    actor: EnrollActor,
    membershipId: string,
  ): Promise<{ readonly membershipId: string; readonly enrolledWithDoseSpot: true }>;
  /** Step 1: check the registration is ready, derive the practitioner profile, claim the roster row and commit the request marker. */
  prepare(actor: EnrollActor, membershipId: string): Promise<EnrollPlan>;
  /** Step 2 (NO transaction): the vendor call. Returns the vendor's id, or null when the prescriber was already linked. */
  callVendor(plan: EnrollPlan): Promise<string | null>;
  /** Step 3 (the caller's transaction): record the vendor id, publish, audit, void a pending go-live. */
  complete(
    store: RosterStore,
    tx: DbClient,
    actor: EnrollActor,
    plan: EnrollPlan,
    vendorId: string,
  ): Promise<{ readonly rosterId: string }>;
}

export interface PrescriberEnrollmentDeps {
  readonly inTx: <T>(
    organizationId: string,
    userId: string,
    fn: (store: RosterStore, tx: DbClient) => Promise<T>,
  ) => Promise<T>;
  readonly client: Pick<DoseSpotClient, "enrollPrescriber">;
  /** Who the prescriber is: the NPI and legal name come from the roster-linked practitioner record, never from the request. */
  readonly profiles: PractitionerProfileSource;
  readonly outbox: DoseSpotWriteOutboxPort;
  readonly audit: ClinicAuditPort;
  readonly afterWrite?: (
    tx: DbClient,
    scope: { organizationId: string; userId: string; membershipId: string | null },
  ) => Promise<void>;
  readonly now?: () => Date;
  /**
   * A structured warning (pino's `(fields, message)` shape); never given a secret, an NPI or a name. REQUIRED, not optional: a claim
   * that cannot be released after a definitive refusal is only ever visible here, and an optional sink was left unwired in production.
   */
  readonly warn: (fields: Record<string, string>, message: string) => void;
}

/**
 * Did the call definitely NOT create a clinician? A refusal (non-retryable), or a failure before anything was sent. A 2xx that could not
 * be read, or carried no clinician id, is NOT definitive: DoseSpot accepted the request, so the clinician may exist.
 */
function isDefinitive(err: unknown): boolean {
  if (isNotEnabledError(err) || isConfigUnavailableError(err)) return true;
  if (isUnconfirmedOutcomeError(err)) return false;
  return isDegradedError(err) && !err.retryable;
}

/** A vendor failure as a typed error: retryable => 503, accepted-but-unconfirmed => 502, a refusal => 422. No vendor text beyond the PHI-free message. */
function vendorError(err: unknown): never {
  if (isUnconfirmedOutcomeError(err)) {
    throw new ChartWardenError(
      "DOSESPOT_ENROLLMENT_UNCONFIRMED",
      "DoseSpot accepted the enrollment but did not confirm it; the request is held for a few minutes, so check DoseSpot before trying again",
      502,
    );
  }
  if (isDegradedError(err)) {
    throw err.retryable
      ? new ChartWardenError("DOSESPOT_UNAVAILABLE", err.customerMessage, 503)
      : new ChartWardenError("DOSESPOT_ENROLLMENT_REJECTED", err.customerMessage, 422);
  }
  throw err;
}

export function createPrescriberEnrollmentService(
  deps: PrescriberEnrollmentDeps,
): PrescriberEnrollmentService {
  const now = deps.now ?? (() => new Date());

  const notReady = (): ChartWardenError =>
    new ChartWardenError(
      "DOSESPOT_NOT_READY",
      "register and test the DoseSpot connection before enrolling prescribers",
      409,
    );
  const revoked = (): ChartWardenError =>
    new ChartWardenError(
      "DOSESPOT_PRESCRIBER_REVOKED",
      "this prescriber was revoked from the roster; re-enroll them on the roster first",
      409,
    );

  const unconfirmed = (): ChartWardenError =>
    new ChartWardenError(
      "DOSESPOT_PRACTITIONER_UNCONFIRMED",
      "the prescriber has not confirmed that the linked physician record is theirs; ask them to confirm it from their own account (they are shown the record's name and NPI)",
      409,
    );

  async function prepare(actor: EnrollActor, membershipId: string): Promise<EnrollPlan> {
    const { organizationId, userId } = actor;
    // Read first, on its own short transaction: is the registration ready, is the member ours, what does the roster link them to?
    const seen = await deps.inTx(organizationId, userId, async (store) => {
      const registration = await store.registration(organizationId);
      if (registration?.status !== "verified" && registration?.status !== "active") {
        throw notReady();
      }
      // the roster key must not reach a membership of another organization (the FK alone is not tenant-scoped)
      if (!(await store.membershipExists(organizationId, membershipId))) {
        throw new NotFoundError("prescriber membership");
      }
      return {
        environment: registration.environment,
        row: await store.rosterRow(organizationId, membershipId),
      };
    });
    if (seen.row?.revokedAt) throw revoked();
    if (seen.row?.dosespotPrescriberId) {
      return {
        organizationId,
        userId,
        membershipId,
        profile: null,
        physicianMdmId: null,
        claimedAt: null,
        alreadyLinked: true,
      };
    }
    // Who the clinician is: derived from the roster-linked practitioner record (no transaction open: it reads M40 and NPPES).
    const physicianMdmId = seen.row?.externalPhysicianMdmId ?? null;
    const profile = await deps.profiles.profileFor({
      organizationId,
      physicianMdmId,
      environment: seen.environment,
    });
    // The roster administrator's link is one person's assertion about another: the PRESCRIBER must have confirmed THIS link and the NPI
    // the record carries now (a re-link clears it, and a record whose NPI changed is no longer what they confirmed).
    if (seen.row === null || !linkConfirmedBy(seen.row, { physicianMdmId, npi: profile.npi })) {
      throw unconfirmed();
    }
    if (physicianMdmId === null) throw unconfirmed(); // unreachable (linkConfirmedBy refused it); narrows the type
    const expected: ExpectedLink = { physicianMdmId, confirmedNpi: profile.npi };
    const claim = await deps.inTx(organizationId, userId, async (store) => {
      const { row, inProgress } = await store.ensureRequested(
        organizationId,
        membershipId,
        now(),
        ENROLL_CLAIM_WINDOW_MS,
        expected,
      );
      if (row.revokedAt !== null) throw revoked();
      if (inProgress) {
        throw new ChartWardenError(
          "DOSESPOT_ENROLLMENT_IN_PROGRESS",
          "an enrollment for this prescriber is already in flight; try again in a couple of minutes",
          409,
        );
      }
      return {
        alreadyLinked: row.dosespotPrescriberId !== null,
        claimedAt: row.dosespotPrescriberId === null ? row.vendorEnrollmentRequestedAt : null,
      };
    });
    return {
      organizationId,
      userId,
      membershipId,
      profile: claim.alreadyLinked ? null : profile,
      physicianMdmId: claim.alreadyLinked ? null : physicianMdmId,
      claimedAt: claim.claimedAt,
      alreadyLinked: claim.alreadyLinked,
    };
  }

  async function callVendor(plan: EnrollPlan): Promise<string | null> {
    if (plan.alreadyLinked || plan.profile === null) return null;
    const { profile } = plan;
    try {
      const out = await deps.client.enrollPrescriber(plan.organizationId, {
        membershipId: plan.membershipId,
        firstName: profile.firstName,
        lastName: profile.lastName,
        npi: profile.npi,
        epcsRequested: false,
      });
      return out.dosespotPrescriberId;
    } catch (err) {
      // Release the claim ONLY when the outcome is definitive: DoseSpot refused (a non-retryable refusal), or nothing could have reached
      // it (no live registration, an unreadable credential). A retryable or ambiguous outcome (a 5xx, a timeout) may well mean the
      // clinician WAS created, so the marker stays for the window and a second attempt waits for it.
      if (plan.claimedAt !== null && isDefinitive(err)) {
        const claimedAt = plan.claimedAt;
        await deps
          .inTx(plan.organizationId, plan.userId, (store) =>
            store.releaseRequest(plan.organizationId, plan.membershipId, claimedAt),
          )
          .catch((releaseFault: unknown) => {
            // the claim then simply ages out of its window; say so rather than swallow it (ids and the error class only)
            deps.warn(
              {
                organizationId: plan.organizationId,
                membershipId: plan.membershipId,
                cause: releaseFault instanceof Error ? releaseFault.name : "unknown",
              },
              "DoseSpot enrolment claim could not be released after a definitive refusal; it will age out",
            );
          });
      }
      return vendorError(err);
    }
  }

  async function complete(
    store: RosterStore,
    tx: DbClient,
    actor: EnrollActor,
    plan: EnrollPlan,
    vendorId: string,
  ): Promise<{ readonly rosterId: string }> {
    const { organizationId, membershipId, profile } = plan;
    if (profile === null)
      throw new Error("an enrolment plan with no profile has nothing to record");
    const row = await store.recordVendorId(organizationId, membershipId, {
      dosespotPrescriberId: vendorId,
      npi: profile.npi,
      at: now(),
      expectedPhysicianMdmId: plan.physicianMdmId,
    });
    await deps.outbox.publish(tx, {
      eventName: "m12.prescriber_enrolled",
      organizationId,
      aggregateKind: "dosespot_prescriber",
      aggregateId: membershipId,
      payload: { membershipId, dosespotPrescriberId: vendorId },
    });
    await deps.audit.record(tx, {
      organizationId,
      actorUserId: actor.userId,
      actorMembershipId: actor.membershipId,
      eventType: CLINIC_AUDIT_EVENTS.prescriberEnrolled,
      resourceKind: "dosespot_prescriber",
      resourceId: row.id,
      changedFields: ["dosespotPrescriberId", "npi"],
      detail: { nppesVerified: profile.nppesVerified },
      ...(actor.request ? { request: actor.request } : {}),
    });
    await deps.afterWrite?.(tx, {
      organizationId,
      userId: actor.userId,
      membershipId: actor.membershipId,
    });
    return { rosterId: row.id };
  }

  return {
    prepare,
    callVendor,
    complete,
    async enroll(actor, membershipId) {
      const plan = await prepare(actor, membershipId);
      const vendorId = await callVendor(plan);
      if (vendorId !== null) {
        await deps.inTx(plan.organizationId, actor.userId, (store, tx) =>
          complete(store, tx, actor, plan, vendorId),
        );
      }
      return { membershipId, enrolledWithDoseSpot: true };
    },
  };
}
