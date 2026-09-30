// apps/backend/src/modules/11-orders/orm-request/orm-requested.ts — the PRODUCER side of
// `m11.order.hl7_orm_requested` (F-181, #248).
//
// WHAT WAS MISSING. M29's outbound T08 worker (F-175) and M11's `LabTransmissionApplier` (F-177) are both real,
// and nothing published the event between them: F-120 left `lab` unbound because `OrmRequestedPayload` needs
// patient demographics + a resolved M40 physician identity + a destination facility, none of which M11's own
// tables hold. A signed lab order therefore never became an HL7 ORM and `transmission_status` never moved off
// `pending`. This file is the missing middle.
//
// WHAT THIS FILE IS: the pure decision core + the port shapes. No IO of its own — every fact arrives through an
// injected port so M11 keeps its `dependsOn [1, 6, 36, 38, 40]` boundary (M5 facts via a NEW M5-owned seam
// function, the M40 physician via the registered `MdmEntityProvider`, the destination via the composition root's
// M29-aware resolver). The DB write of a refusal and the outbox publish live in `orders-route-service-db.ts`,
// on the sign transaction.
//
// REFUSE, NEVER FABRICATE. Every fact the payload carries is either resolved from a system of record or the
// whole request is REFUSED with a typed reason — the order stays signed, `transmission_status` becomes `failed`
// with `orm_refused:<reason>` in `transmission_failure_reason`, and `m11.order.transmission_terminal_failed`
// (M36's ordering-provider alert) fires with `transmittedAttempts: 0`. Nothing partial is ever emitted, because
// a partial PID is worse than none: it is a PHI disclosure to a third party with the wrong person's chart.
// The refusals, and why each is a refusal and not a default:
//   sud_restricted            — 42 CFR Part 2: F-035 D3 makes SUD redaction default-ON at every egress; an ORM
//                               carries name/DOB/MRN + the test to an outside lab. Fail-closed on the M5 flag
//                               (including a stale/invalidated snapshot).
//   patient_*                 — no spine / merged spine / no MRN / no name / no DOB. Identity must be certain.
//   patient_sex_unrecorded    — M5's default is `UNK` ("not yet recorded"). Reference ranges depend on sex; we do
//                               not turn "nobody asked" into HL7 `U` ("asked, unknown"). An explicit `U` passes.
//   patient_sex_unmappable    — a code that is not M/F/O/U (or their spelled-out / SNOMED forms).
//   physician_*               — the ordering provider must be a resolvable, ACTIVE M40 physician with a
//                               CONFIRMED 10-digit NPI and a name. A provisional canonical has no confirmed NPPES
//                               match; a deactivated one must not be ordering.
//   lab_test_codes_missing / multiple_test_codes_unsupported
//                             — `OrderHl7LabOrderPayload` carries ONE `observationIdentifier`. An order with
//                               several tests would silently lose all but one; refuse instead.
//   no_routing_lab / lab_facility_unresolved / no_active_feed / ambiguous_feed
//                             — the destination. `labDestinationFacilityId` MUST be an M40 FACILITY: M29 gates
//                               the D16 BAA on exactly that id. See `OrmDestinationPort`.
//   payload_invalid           — the assembled payload fails the catalogued TypeBox schema. Checked here so a
//                               schema defect refuses the ORM rather than throwing out of (and blocking) the sign.
//   dependency_unavailable    — a port threw. The sign must not fail because a lab-routing dependency hiccuped.
//
// MINIMUM NECESSARY. The ORM carries `collectionInstructions` and a fasting flag as NTE lines (a specimen
// cannot be collected without them). It deliberately does NOT carry `clinicalJustification` or `notes`: both
// are free text, routinely holding diagnoses, and neither is needed to run the test.
import { Value } from "@sinclair/typebox/value";
import type { DbClient } from "@wardenx/db";
import type { OrmRequestedPayload } from "@wardenx/types";
import { ormRequestedPayloadSchema } from "../events-by-m11";
import type { OrmOutboundEvidence } from "./orm-resend";

// ── Port shapes (structural; the composition root binds them — see apps/backend/src/index.ts) ────────────

/** The M5-owned facts (`hl7OrmDemographicsInTx`), duplicated structurally so M11 imports nothing from M5. */
export interface OrmPatientFacts {
  readonly patientId: string;
  readonly mrn: string;
  readonly mrnAssigningAuthority: string;
  readonly familyName: string;
  readonly givenName: string;
  readonly dateOfBirth: string;
  readonly sexCode: string;
  readonly status: string;
  readonly address: {
    readonly line1: string;
    readonly city: string;
    readonly state: string | null;
    readonly postalCode: string;
  } | null;
  readonly sudRestricted: boolean;
}

/** The resolved M40 ordering physician. `npi` is non-null ONLY for a `identifierType === 'npi'` canonical whose
 *  value is a well-formed 10-digit string; `status` is M40's post-redirect status. */
export interface OrmPhysicianFacts {
  readonly status: "active" | "deactivated" | "provisional";
  readonly npi: string | null;
  readonly firstName: string;
  readonly lastName: string;
}

export type OrmDestinationResult =
  | { readonly ok: true; readonly facilityId: string }
  | {
      readonly ok: false;
      readonly reason: 
        | "no_routing_lab"
        | "lab_facility_unresolved"
        | "no_active_feed"
        | "ambiguous_feed"
        | "no_feed_for_destination"
        | "feed_identity_incomplete";
    };

/**
 * The destination port. `routingLabId` is the order's own `data.routingLabId` (an M40 facility id, optional in
 * the lab kind schema). The binding MUST return an M40 FACILITY id that is `active`, because M29's D16 BAA gate
 * (`resolveOutboundBaaResult` → `BaaStatusProvider.baaStatusByMdmEntity({kind:'facility', id})`) runs on it and
 * `hl7_message_outbound.destination_facility_id` is a `uuid`. The composition-root binding then asks M29 to
 * resolve the active `orm_outbound` feed LINKED to that facility (F-181: `external_feed.lab_destination_facility_id`)
 * and refuses (`no_active_feed` / `ambiguous_feed` / `no_feed_for_destination` / `feed_identity_incomplete`) rather
 * than emit an event M29 would only alert on and drop. Runs on the sign transaction (`tx`) so feed reads are RLS-scoped.
 */
export type OrmDestinationPort = (
  tx: DbClient,
  organizationId: string,
  args: { readonly routingLabId: string | null },
) => Promise<OrmDestinationResult>;

/** F-188 — M29's read-only outbound/inbound evidence for one order (injected: M11 does not depend on M29). */
export type OrmOutboundEvidencePort = (
  tx: DbClient,
  organizationId: string,
  orderId: string,
) => Promise<OrmOutboundEvidence>;

export interface OrmRequestedPorts {
  /**
   * F-188 — evidence for the attested recovery's contradiction check. Optional: absent ⇒ the recovery FAILS CLOSED
   * (`evidence_unavailable`) for `not_received_by_lab`; the producer itself never reads it.
   */
  readonly outboundEvidence?: OrmOutboundEvidencePort;
  /** M5 — `hl7OrmDemographicsInTx`. `null` = no such patient in this org. */
  readonly patient: (
    tx: DbClient,
    organizationId: string,
    patientId: string,
  ) => Promise<OrmPatientFacts | null>;
  /** M40 — the ordering physician by `order_record.ordering_physician_mdm_id`. `null` = unresolvable. */
  readonly physician: (organizationId: string, mdmId: string) => Promise<OrmPhysicianFacts | null>;
  readonly destination: OrmDestinationPort;
}

export type OrmRefusalReason =
  | "patient_not_found"
  | "patient_merged"
  | "sud_restricted"
  | "patient_mrn_missing"
  | "patient_name_missing"
  | "patient_dob_missing"
  | "patient_sex_unrecorded"
  | "patient_sex_unmappable"
  | "physician_unresolved"
  | "physician_not_active"
  | "physician_npi_unconfirmed"
  | "physician_name_missing"
  | "lab_test_codes_missing"
  | "multiple_test_codes_unsupported"
  | "no_routing_lab"
  | "lab_facility_unresolved"
  | "no_active_feed"
  | "ambiguous_feed"
  | "no_feed_for_destination"
  | "feed_identity_incomplete"
  | "payload_invalid"
  | "dependency_unavailable";

export type OrmRequestedOutcome =
  | { readonly kind: "ok"; readonly payload: OrmRequestedPayload }
  | { readonly kind: "refused"; readonly reason: OrmRefusalReason };

/** The order-side facts the sign path already holds. */
export interface OrmOrderFacts {
  readonly orderId: string;
  readonly organizationId: string;
  readonly patientId: string;
  readonly orderingPhysicianMdmId: string;
  /** `order_record.priority` (`routine` | `stat` | `asap` | null). */
  readonly priority: string | null;
  readonly signedAt: Date;
  /** `order_record.data` — already validated against `lab.v1` at draft time. */
  readonly data: unknown;
}

const nonBlank = (s: string | null | undefined): s is string =>
  typeof s === "string" && s.trim().length > 0;

/** `order_record.priority` → HL7 ORC-7/OBR-5. `null` is HL7's own default (routine); it is not a clinical fact. */
export function toHl7Priority(priority: string | null): "R" | "S" | "A" {
  if (priority === "stat") return "S";
  if (priority === "asap") return "A";
  return "R";
}

/** M5 `sex_assigned_at_birth` → HL7 table 0001. `"unrecorded"` (UNK/blank) and `null` (unmappable) are DISTINCT
 *  refusals — the first is "nobody has recorded it", the second is "someone recorded something we cannot read". */
export function toHl7Sex(code: string | null | undefined): "M" | "F" | "O" | "U" | "unrecorded" | null {
  const c = (code ?? "").trim().toUpperCase();
  if (c === "" || c === "UNK") return "unrecorded";
  if (c === "M" || c === "MALE" || c === "248153007") return "M";
  if (c === "F" || c === "FEMALE" || c === "248152002") return "F";
  if (c === "O" || c === "OTHER") return "O";
  if (c === "U" || c === "UNKNOWN") return "U";
  return null;
}

/**
 * PURE. Turn resolved facts into the catalogued payload, or a typed refusal. Order of checks is deliberate:
 * the Part 2 gate runs BEFORE anything is assembled, so a restricted patient's demographics are never even
 * copied into a payload object.
 */
export function planOrmRequested(input: {
  readonly order: OrmOrderFacts;
  readonly patient: OrmPatientFacts | null;
  readonly physician: OrmPhysicianFacts | null;
  readonly destination: OrmDestinationResult;
}): OrmRequestedOutcome {
  const { order, patient, physician, destination } = input;
  const refuse = (reason: OrmRefusalReason): OrmRequestedOutcome => ({ kind: "refused", reason });

  if (patient === null) return refuse("patient_not_found");
  if (patient.sudRestricted) return refuse("sud_restricted");
  if (patient.status === "merged") return refuse("patient_merged");
  if (!nonBlank(patient.mrn)) return refuse("patient_mrn_missing");
  if (!nonBlank(patient.familyName) || !nonBlank(patient.givenName)) return refuse("patient_name_missing");
  if (!nonBlank(patient.dateOfBirth)) return refuse("patient_dob_missing");
  const sex = toHl7Sex(patient.sexCode);
  if (sex === "unrecorded") return refuse("patient_sex_unrecorded");
  if (sex === null) return refuse("patient_sex_unmappable");

  if (physician === null) return refuse("physician_unresolved");
  if (physician.status === "deactivated") return refuse("physician_not_active");
  if (physician.status === "provisional" || !nonBlank(physician.npi)) {
    return refuse("physician_npi_unconfirmed");
  }
  if (!nonBlank(physician.firstName) || !nonBlank(physician.lastName)) {
    return refuse("physician_name_missing");
  }

  if (!destination.ok) return refuse(destination.reason);

  const data = (order.data ?? {}) as {
    testCodes?: ReadonlyArray<{ system?: string; code?: string; display?: string }>;
    fastingRequired?: boolean;
    collectionInstructions?: string;
  };
  const tests = Array.isArray(data.testCodes) ? data.testCodes : [];
  if (tests.length === 0 || !nonBlank(tests[0]?.code)) return refuse("lab_test_codes_missing");
  if (tests.length > 1) return refuse("multiple_test_codes_unsupported");
  const test = tests[0]!;

  const priority = toHl7Priority(order.priority);
  const notes: string[] = [];
  if (data.fastingRequired === true) notes.push("FASTING REQUIRED");
  if (nonBlank(data.collectionInstructions)) notes.push(data.collectionInstructions.trim());

  const address = patient.address;
  const payload: OrmRequestedPayload = {
    orderId: order.orderId,
    organizationId: order.organizationId,
    labDestinationFacilityId: destination.facilityId,
    priority,
    requestedAt: order.signedAt.toISOString(),
    labOrderPayload: {
      orderId: order.orderId,
      patientId: order.patientId,
      placerOrderNumber: order.orderId.replace(/-/g, ""),
      observationIdentifier: {
        code: test.code as string,
        // LOINC display text is descriptive, not identifying; fall back to the code rather than blank.
        text: nonBlank(test.display) ? test.display : (test.code as string),
        codingSystem: "LN",
      },
      orderingProviderNpi: physician.npi,
      orderingProviderName: { family: physician.lastName.trim(), given: physician.firstName.trim() },
      priority,
      ...(notes.length > 0 ? { clinicalNotes: notes } : {}),
      patientDemographics: {
        mrn: patient.mrn,
        internalMrnAuthority: patient.mrnAssigningAuthority,
        familyName: patient.familyName.trim(),
        givenName: patient.givenName.trim(),
        dateOfBirth: patient.dateOfBirth,
        administrativeSex: sex,
        ...(address
          ? {
              addressLine1: address.line1,
              addressCity: address.city,
              ...(address.state ? { addressState: address.state } : {}),
              addressPostal: address.postalCode,
            }
          : {}),
      },
    },
  };

  if (!Value.Check(ormRequestedPayloadSchema, payload)) return refuse("payload_invalid");
  return { kind: "ok", payload };
}

/**
 * IO shell: gather the facts through the ports (each guarded — a throwing dependency refuses with
 * `dependency_unavailable` instead of failing the caller's sign) and hand them to {@link planOrmRequested}.
 */
export async function resolveOrmRequested(
  ports: OrmRequestedPorts,
  tx: DbClient,
  order: OrmOrderFacts,
): Promise<OrmRequestedOutcome> {
  try {
    const patient = await ports.patient(tx, order.organizationId, order.patientId);
    // Do not even resolve the physician/destination for a restricted or unknown patient.
    if (patient === null || patient.sudRestricted) {
      return planOrmRequested({
        order,
        patient,
        physician: null,
        destination: { ok: false, reason: "no_routing_lab" },
      });
    }
    const physician = await ports.physician(order.organizationId, order.orderingPhysicianMdmId);
    const routingLabId = (order.data as { routingLabId?: unknown } | null)?.routingLabId;
    const destination = await ports.destination(tx, order.organizationId, {
      routingLabId: typeof routingLabId === "string" && routingLabId.length > 0 ? routingLabId : null,
    });
    return planOrmRequested({ order, patient, physician, destination });
  } catch {
    return { kind: "refused", reason: "dependency_unavailable" };
  }
}
