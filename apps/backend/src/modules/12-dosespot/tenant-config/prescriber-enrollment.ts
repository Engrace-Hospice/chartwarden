// apps/backend/src/modules/12-dosespot/tenant-config/prescriber-enrollment.ts — a prescriber's DoseSpot (vendor) enrolment
// (tenant onboarding slice 4, ADR-0110). Until now the roster `enroll` route only wrote a local row, so `dosespot_prescriber_id`
// (the id `transmit-newrx` sends under) was never set by any production path and an API-enrolled prescriber's orders failed
// permanently as `prescriber_not_enrolled`. This is the missing step: register the clinician at DoseSpot and record its id.
//
// CREATE-THEN-RECORD, never a transaction across the vendor call:
//   1. tx   the registration must be `verified` or `active` (a tenant may enrol before it activates); ensure the roster row and
//           COMMIT `vendor_enrollment_requested_at`. A prescriber already linked to DoseSpot returns here (idempotent).
//   2. --   the vendor call (`DoseSpotClient.enrollPrescriber`, resolved under the `setup` purpose), nothing open.
//   3. tx   record the vendor's id and the NPI, publish `m12.prescriber_enrolled` with the REAL vendor id, write the field-level
//           audit row (names, never values) and void a pending go-live (the data it attested just changed).
// A crash between 2 and 3 leaves the request marker set with no vendor id and an orphan clinician at DoseSpot; a retry may meet a
// vendor duplicate (DoseSpot's dedupe by NPI is unverified: it needs a sandbox run). Enrolment never starts EPCS or IAL2.
import type { DbClient } from "@chartwarden/db";
import { type DoseSpotClient, isDegradedError } from "@chartwarden/dosespot";
import { ChartWardenError, ValidationError } from "@chartwarden/types";
import type { DoseSpotWriteOutboxPort } from "../dosespot-route-service-db";
import { CLINIC_AUDIT_EVENTS, type ClinicAuditPort } from "./audit-port";

export interface RosterRow {
  readonly id: string;
  readonly membershipId: string;
  readonly dosespotPrescriberId: string | null;
  readonly revokedAt: Date | null;
  readonly vendorEnrollmentRequestedAt: Date | null;
  readonly npi: string | null;
}

/** The two tables an enrolment touches, over ONE open org-scoped transaction. */
export interface RosterStore {
  /** The registration's status, or null when the org has none. */
  configStatus(organizationId: string): Promise<string | null>;
  /** Ensure the roster row (a missing one is created on the roster with no DEA schedules) and stamp the request marker. */
  ensureRequested(organizationId: string, membershipId: string, at: Date): Promise<RosterRow>;
  /** Record the vendor link and the NPI the enrolment was made under. */
  recordVendorId(
    organizationId: string,
    membershipId: string,
    input: { readonly dosespotPrescriberId: string; readonly npi: string; readonly at: Date },
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

export interface EnrollInput {
  readonly npi: string;
  readonly firstName: string;
  readonly lastName: string;
}

export interface PrescriberEnrollmentService {
  enroll(
    actor: EnrollActor,
    membershipId: string,
    input: EnrollInput,
  ): Promise<{ readonly membershipId: string; readonly enrolledWithDoseSpot: true }>;
}

export interface PrescriberEnrollmentDeps {
  readonly inTx: <T>(
    organizationId: string,
    userId: string,
    fn: (store: RosterStore, tx: DbClient) => Promise<T>,
  ) => Promise<T>;
  readonly client: Pick<DoseSpotClient, "enrollPrescriber">;
  readonly outbox: DoseSpotWriteOutboxPort;
  readonly audit: ClinicAuditPort;
  readonly afterWrite?: (
    tx: DbClient,
    scope: { organizationId: string; userId: string; membershipId: string | null },
  ) => Promise<void>;
  readonly now?: () => Date;
}

/**
 * The NPI check: ten digits whose Luhn check digit holds with the 80840 prefix.
 * ponytail: a local copy; M2 and M29 each carry theirs and modules may not import each other. Extract to a shared package when
 * a fourth consumer appears.
 */
export function isValidNpi(npi: string): boolean {
  if (!/^\d{10}$/.test(npi)) return false;
  const digits = `80840${npi}`.split("").map(Number).reverse();
  const sum = digits.reduce((acc, d, i) => {
    if (i % 2 === 0) return acc + d;
    const doubled = d * 2;
    return acc + (doubled > 9 ? doubled - 9 : doubled);
  }, 0);
  return sum % 10 === 0;
}

const invalid = (field: string, code: string, message: string): ValidationError =>
  new ValidationError("request validation failed", [{ field, code, message }]);

function validate(input: EnrollInput): EnrollInput {
  if (!isValidNpi(input.npi)) {
    throw invalid(
      "npi",
      "DOSESPOT_NPI_INVALID",
      "the NPI must be 10 digits with a valid check digit",
    );
  }
  const firstName = input.firstName.trim();
  const lastName = input.lastName.trim();
  if (firstName === "")
    throw invalid("firstName", "DOSESPOT_NAME_REQUIRED", "the prescriber's first name is required");
  if (lastName === "")
    throw invalid("lastName", "DOSESPOT_NAME_REQUIRED", "the prescriber's last name is required");
  return { npi: input.npi, firstName, lastName };
}

/** A vendor failure as a typed error: retryable => 503, a refusal => 422. No vendor text beyond the PHI-free message. */
function vendorError(err: unknown): never {
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
  return {
    async enroll(actor, membershipId, rawInput) {
      const input = validate(rawInput);
      const { organizationId } = actor;
      const ready = await deps.inTx(organizationId, actor.userId, async (store) => {
        const status = await store.configStatus(organizationId);
        if (status !== "verified" && status !== "active") {
          throw new ChartWardenError(
            "DOSESPOT_NOT_READY",
            "register and test the DoseSpot connection before enrolling prescribers",
            409,
          );
        }
        const row = await store.ensureRequested(organizationId, membershipId, now());
        return row.dosespotPrescriberId !== null && row.revokedAt === null;
      });
      if (ready) return { membershipId, enrolledWithDoseSpot: true };

      let vendorId: string;
      try {
        const out = await deps.client.enrollPrescriber(organizationId, {
          membershipId,
          firstName: input.firstName,
          lastName: input.lastName,
          npi: input.npi,
          epcsRequested: false,
        });
        vendorId = out.dosespotPrescriberId;
      } catch (err) {
        return vendorError(err);
      }

      await deps.inTx(organizationId, actor.userId, async (store, tx) => {
        const row = await store.recordVendorId(organizationId, membershipId, {
          dosespotPrescriberId: vendorId,
          npi: input.npi,
          at: now(),
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
          ...(actor.request ? { request: actor.request } : {}),
        });
        await deps.afterWrite?.(tx, {
          organizationId,
          userId: actor.userId,
          membershipId: actor.membershipId,
        });
      });
      return { membershipId, enrolledWithDoseSpot: true };
    },
  };
}
