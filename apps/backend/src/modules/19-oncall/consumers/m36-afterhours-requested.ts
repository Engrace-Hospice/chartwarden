// apps/backend/src/modules/19-oncall/consumers/m36-afterhours-requested.ts — ADR-0082 decision 4 (slice S2).
//
// M19's subscriber to `m36.afterhours_triage.requested`: an urgent after-hours message asked, by id only,
// for a triage call. M36 never writes M19 tables; M19 decides here and answers with
// `m19.afterhours_triage.outcome` (always, including `no_coverage`, so M36 never waits on silence).
//
// THE FOUR OUTCOMES (the shape of `./m36-delivery-failed` and `./inbound-trigger`, one grain finer):
//   • idempotent_skip — a call already carries this outbox event id (`triage_call_source_dedupe_uq`). The
//     first delivery published its outcome in the same transaction as the insert; nothing more to say.
//   • coalesced       — the patient already has an OPEN machine-opened call; the request joins it.
//   • open_call       — a `system_inbound` call with the patient attached, in the covering shift.
//   • no_coverage     — nothing covers the instant: the existing `coverage_gap` plus outcome `no_coverage`.
// A patient that does not resolve in the envelope's organization THROWS (dead-letter): the frozen outcome
// contract has no "refused" arm, and inventing one would be a contract change.
//
// WHAT THIS FILE NEVER DOES: copy message text. The payload is id-only, the parser keeps exactly three
// ids, and `chief_complaint_text` is a fixed platform sentence (§3.6 denylists that column for caller
// words; a machine-opened call has no caller). The organization comes from the ENVELOPE, never the payload.
import type {
  IsoInstant,
  OrgId,
  PatientId,
  ProviderEntityId,
  TriageCallId,
  TriageCallInboundChannel,
  TriageCallSource,
} from "@wardenx/types";
import { require_ } from "../lifecycle/errors";
import { UUID_PATTERN } from "../seams/escalation-router";
import {
  type CoveringShiftCandidate,
  type TriggerCoverageGap,
  resolveCoveringShift,
  resolveGapWindow,
} from "./inbound-trigger";
import type { InboundTriggerPorts } from "./trigger-context";

/** The M36-owned event this consumer subscribes to (catalogued by M36 slice S1). */
export const M36_AFTERHOURS_REQUESTED_EVENT = "m36.afterhours_triage.requested" as const;

/** The event M19 publishes back, declared in `../events-by-m19.ts`. */
export const M19_AFTERHOURS_OUTCOME_EVENT = "m19.afterhours_triage.outcome" as const;

export const AFTERHOURS_CALL_SOURCE = "m36_afterhours_request" as const satisfies TriageCallSource;
export const AFTERHOURS_CALL_CHANNEL =
  "inbound_afterhours_request" as const satisfies TriageCallInboundChannel;

/** Platform words, never the sender's. The detail stays in the care-team thread behind M36's own RLS. */
export const AFTERHOURS_CHIEF_COMPLAINT =
  "After-hours urgent message about this patient; review and contact the care team." as const;

export type AfterHoursOutcome = "opened" | "coalesced" | "no_coverage";

/** The three ids M19 reads off the request. Everything else on the payload is ignored on purpose. */
export interface AfterHoursRequestedPayload {
  readonly messageId: string;
  readonly requestId: string;
  readonly patientId: PatientId;
}

/** Keep exactly the id fields; a missing or non-uuid one dead-letters rather than being guessed. */
export function parseAfterHoursRequested(raw: unknown): AfterHoursRequestedPayload {
  const record = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const uuidOf = (key: string): string => {
    const value = record[key];
    require_(
      typeof value === "string" && UUID_PATTERN.test(value),
      "AFTERHOURS_PAYLOAD_INVALID",
      `m36.afterhours_triage.requested: '${key}' must be a uuid`,
    );
    return value;
  };
  return {
    messageId: uuidOf("messageId"),
    requestId: uuidOf("requestId"),
    patientId: uuidOf("patientId") as PatientId,
  };
}

/** The patient reads the router already uses (`EscalationRouterReads`), narrowed to what this needs. */
export interface AfterHoursReads {
  /** `null` = the patient does not resolve in `orgId`; `{providerEntityId: null}` = found, none yet. */
  patientProviderEntity(
    orgId: OrgId,
    patientId: string,
  ): Promise<{ readonly providerEntityId: string | null } | null>;
  providerEntityIdsOfOrg(orgId: OrgId): Promise<readonly string[]>;
}

export interface AfterHoursFacts {
  /** §2.6 — a call already written for THIS outbox event (the redelivery guard). */
  readonly existingCallForEventId: TriageCallId | null;
  /** An outcome was already published for THIS event: the decision was made and answered. This is the
   *  redelivery guard for the arms that write no call row (`coalesced`, `no_coverage`), which would
   *  otherwise re-decide against facts that have since moved. */
  readonly outcomeAlreadyPublished: boolean;
  /** `null` = the patient is not in the organization. */
  readonly patient: { readonly providerEntityId: ProviderEntityId | null } | null;
  /** An OPEN machine-opened call already running for this patient (the coalesce grain). */
  readonly openMachineCallForPatientId: TriageCallId | null;
  readonly candidateShifts: readonly CoveringShiftCandidate[];
}

/** Resolve the facts in the cheapest-first order, short-circuiting like `resolveInboundTriggerFacts`. */
export async function resolveAfterHoursFacts(input: {
  readonly organizationId: OrgId;
  readonly sourceOutboxEventId: string;
  readonly payload: AfterHoursRequestedPayload;
  readonly at: IsoInstant;
  readonly ports: InboundTriggerPorts;
  readonly reads: AfterHoursReads;
  /** Has `m19.afterhours_triage.outcome` already been published for this source event? */
  readonly outcomeAlreadyPublished: (
    organizationId: OrgId,
    sourceOutboxEventId: string,
  ) => Promise<boolean>;
}): Promise<AfterHoursFacts> {
  const { organizationId, payload, ports, reads } = input;
  const empty: AfterHoursFacts = {
    existingCallForEventId: null,
    outcomeAlreadyPublished: false,
    patient: null,
    openMachineCallForPatientId: null,
    candidateShifts: [],
  };

  const existingCallForEventId = await ports.findCallBySourceEvent(
    organizationId,
    input.sourceOutboxEventId,
  );
  if (existingCallForEventId !== null) return { ...empty, existingCallForEventId };
  if (await input.outcomeAlreadyPublished(organizationId, input.sourceOutboxEventId)) {
    return { ...empty, outcomeAlreadyPublished: true };
  }

  // The patient-in-org check is the router's own read: RLS-scoped, and `null` for another tenant's patient.
  const found = await reads.patientProviderEntity(organizationId, payload.patientId);
  if (found === null) return empty;
  const providerEntityId = await anchorOf(reads, organizationId, found.providerEntityId);
  const patient = { providerEntityId };

  const openMachineCallForPatientId = await ports.findOpenMachineCallForPatient(
    organizationId,
    payload.patientId,
  );
  if (openMachineCallForPatientId !== null) {
    return { ...empty, patient, openMachineCallForPatientId };
  }
  if (providerEntityId === null) return { ...empty, patient };

  const candidateShifts = await ports.candidateShiftsForProviderEntity(
    organizationId,
    providerEntityId,
    input.at,
  );
  return { ...empty, patient, candidateShifts };
}

/** The patient's provider entity, else the organization's only one — never a guess among several. */
async function anchorOf(
  reads: AfterHoursReads,
  organizationId: OrgId,
  fromPatient: string | null,
): Promise<ProviderEntityId | null> {
  if (fromPatient !== null) return fromPatient as ProviderEntityId;
  const all = await reads.providerEntityIdsOfOrg(organizationId);
  return all.length === 1 ? ((all[0] ?? null) as ProviderEntityId | null) : null;
}

/** The row an after-hours request inserts. Patient attached; no admission, no location, no caller. */
export interface AfterHoursCallDraft {
  readonly organizationId: OrgId;
  readonly providerEntityId: ProviderEntityId;
  readonly locationId: null;
  readonly onCallShiftId: CoveringShiftCandidate["shiftId"];
  readonly patientId: PatientId;
  readonly admissionId: null;
  readonly callerKind: "system_inbound";
  readonly inboundChannel: typeof AFTERHOURS_CALL_CHANNEL;
  readonly source: typeof AFTERHOURS_CALL_SOURCE;
  readonly sourceOutboxEventId: string;
  readonly chiefComplaintText: typeof AFTERHOURS_CHIEF_COMPLAINT;
  readonly openedAt: IsoInstant;
}

export type AfterHoursAction =
  /** A redelivery. Nothing is written or republished: the first delivery's outcome stands. */
  | { readonly kind: "idempotent_skip"; readonly triageCallId: TriageCallId | null }
  | { readonly kind: "coalesced"; readonly intoTriageCallId: TriageCallId }
  | { readonly kind: "open_call"; readonly draft: AfterHoursCallDraft }
  | { readonly kind: "no_coverage"; readonly gap: TriggerCoverageGap };

/**
 * ORDER: idempotency first (a redelivery re-checks nothing), then the tenancy anchor (a patient outside
 * the organization is refused before anything can coalesce onto, or be anchored to, it), then the
 * coalesce, then coverage.
 */
export function decideAfterHoursRequested(input: {
  readonly organizationId: OrgId;
  readonly sourceOutboxEventId: string;
  readonly payload: AfterHoursRequestedPayload;
  readonly facts: AfterHoursFacts;
  readonly at: IsoInstant;
}): AfterHoursAction {
  const { facts, payload } = input;
  if (facts.existingCallForEventId !== null) {
    return { kind: "idempotent_skip", triageCallId: facts.existingCallForEventId };
  }
  if (facts.outcomeAlreadyPublished) return { kind: "idempotent_skip", triageCallId: null };

  const patient = facts.patient;
  require_(
    patient !== null,
    "AFTERHOURS_PATIENT_NOT_IN_ORG",
    `after-hours request ${input.sourceOutboxEventId}: patient does not resolve in organization ${input.organizationId}`,
  );
  if (facts.openMachineCallForPatientId !== null) {
    return { kind: "coalesced", intoTriageCallId: facts.openMachineCallForPatientId };
  }
  const providerEntityId = patient.providerEntityId;
  require_(
    providerEntityId !== null,
    "AFTERHOURS_PROVIDER_ENTITY_UNRESOLVED",
    `after-hours request ${input.sourceOutboxEventId}: no provider entity can anchor a triage_call row`,
  );

  const shift = resolveCoveringShift(facts.candidateShifts, input.at);
  if (shift === null) {
    return {
      kind: "no_coverage",
      gap: {
        organizationId: input.organizationId,
        providerEntityId,
        ...resolveGapWindow(facts.candidateShifts, input.at),
        discipline: "clinical_rn",
      },
    };
  }

  return {
    kind: "open_call",
    draft: {
      organizationId: input.organizationId,
      providerEntityId,
      locationId: null,
      onCallShiftId: shift.shiftId,
      patientId: payload.patientId,
      admissionId: null,
      callerKind: "system_inbound",
      inboundChannel: AFTERHOURS_CALL_CHANNEL,
      source: AFTERHOURS_CALL_SOURCE,
      sourceOutboxEventId: input.sourceOutboxEventId,
      chiefComplaintText: AFTERHOURS_CHIEF_COMPLAINT,
      openedAt: input.at,
    },
  };
}
