// @chartwarden/fhir — the DiagnosticReport read-time projector (§4.11.2 D19, M28-T04).
//
// A lab DiagnosticReport is COMPOSED at read time from three sources (D19), never persisted (§1.2):
//   (a) the M11 `order_record`     — report metadata (code, subject, performer, effectivePeriod.start)
//   (b) the M29 `lab_observation`  — the result values + abnormal/critical flags (via LabObservationReader)
//   (c) the M40 facility           — the performer Organization reference
// The report `id` is the M11 order id (consumers identify reports by the test order, not the lab
// system's internal observation id); child Observation ids use the synthetic `<obs-id>--<index>` form.
//
// The projector is PURE given its injected deps: same rows + same `asOf` ⇒ byte-identical output. It
// returns `null` when the report does not (yet) exist — no order, non-lab order, no attached observation,
// or a missing patient — so the route answers 404 without inventing an empty resource.

import type { DiagnosticReport, FhirReference, Observation } from "../../types";
import type {
  ExternalPhysicianReader,
  FacilityReader,
  LabObservationReader,
  OrderProvider,
  PatientReader,
} from "../deps";
import { projectChildObservations } from "./child-observation-projector";
import { applySudRedactionToDiagnosticReport } from "./sud-redaction-applier";

/** The US Core lab DiagnosticReport profile the projection conforms to. */
export const US_CORE_DIAGNOSTIC_REPORT_LAB_PROFILE =
  "http://hl7.org/fhir/us/core/StructureDefinition/us-core-diagnosticreport-lab";

export interface DiagnosticReportProjectorDeps {
  readonly orderProvider: OrderProvider;
  readonly labObservationReader: LabObservationReader;
  readonly patientReader: PatientReader;
  readonly externalPhysicianReader: ExternalPhysicianReader;
  readonly facilityReader: FacilityReader;
  /** D20 whole-report redaction; injected so a test can assert the composed report BEFORE redaction. */
  readonly sudRedactionApplier: (report: DiagnosticReport) => DiagnosticReport;
}

export interface ProjectDiagnosticReportInput {
  readonly organizationId: string;
  readonly orderId: string;
  readonly asOf?: Date;
  readonly clientId: string;
}

/**
 * Compose a single lab DiagnosticReport from `input.orderId`. Returns `null` when the report does not
 * exist. The mapping is purely structural — no clinical inference, no value transformation (D19).
 */
export async function projectDiagnosticReport(
  deps: DiagnosticReportProjectorDeps,
  input: ProjectDiagnosticReportInput,
): Promise<DiagnosticReport | null> {
  // 1. The order (M11) is the metadata backbone; a non-lab order has no lab report.
  const order = await deps.orderProvider.findOrder(input.organizationId, input.orderId);
  if (!order || order.kind !== "lab") return null;

  // 2. No attached observation ⇒ no result yet ⇒ the report does not exist.
  if (!order.lastLabObservationAttachedId) return null;
  const observation = await deps.labObservationReader.loadById(
    input.organizationId,
    order.lastLabObservationAttachedId,
  );
  if (!observation) return null;

  // 3. The subject.
  const patient = await deps.patientReader.findById({
    organizationId: input.organizationId,
    patientId: order.patientId,
  });
  if (!patient) return null;

  // 4/5. Performers — ordering provider (M40) + lab facility (M40); both optional.
  const orderingProvider = order.orderingPhysicianMdmId
    ? await deps.externalPhysicianReader.findById(
        input.organizationId,
        order.orderingPhysicianMdmId,
      )
    : null;
  const performerFacility = order.labDestinationFacilityId
    ? await deps.facilityReader.findById(input.organizationId, order.labDestinationFacilityId)
    : null;

  // 6. Child Observations (one per value).
  const subjectRef = `Patient/${patient.id}`;
  const childObservations: Observation[] = projectChildObservations(observation, subjectRef);

  const performer: FhirReference[] = [
    ...(orderingProvider ? [{ reference: `Practitioner/${orderingProvider.id}` }] : []),
    ...(performerFacility ? [{ reference: `Organization/${performerFacility.id}` }] : []),
  ];

  // 7. The report envelope.
  const report: DiagnosticReport = {
    resourceType: "DiagnosticReport",
    id: order.id,
    meta: {
      lastUpdated: observation.attachedAt,
      profile: [US_CORE_DIAGNOSTIC_REPORT_LAB_PROFILE],
    },
    status: "final",
    category: [
      { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v2-0074", code: "LAB" }] },
    ],
    code: {
      coding: order.data?.observationIdentifier
        ? [
            {
              system: "http://loinc.org",
              code: order.data.observationIdentifier.code,
              display: order.data.observationIdentifier.text,
            },
          ]
        : [],
    },
    subject: { reference: subjectRef },
    effectivePeriod: {
      start: order.signedAt ?? undefined,
      end: observation.attachedAt,
    },
    issued: observation.attachedAt,
    performer,
    result: childObservations.map((_, idx) => ({
      reference: `Observation/${observation.id}--${idx}`,
    })),
    contained: childObservations,
  };

  // 8. D20 SUD redaction at egress.
  return deps.sudRedactionApplier(report);
}
