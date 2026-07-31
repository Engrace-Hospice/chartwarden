// apps/backend/src/modules/19-oncall/consumers/trigger-context.ts — M19-T04 (§4.4, §4.5, §2.7 D-C).
//
// The IO half of the D10 inbound triggers and the §4.5 roster pull: resolve the facts the pure deciders
// need, through the M1 seam registry, and hand them over as plain data. Keeping the reads here is what
// lets `decideNoShowTrigger` / `decideLateCheckoutTrigger` / `reconcileOnCallRoster` be pure functions with
// no DB, no clock and no seam — the M15/M16/M21 shape.
//
// TWO PORTS, NOT SEAMS. `findCallBySourceEvent` and `openMachineCallForPatient` read M19's OWN
// `triage_call` rows, so they are not seam calls; they are declared as an injected port because the
// Drizzle implementation belongs to the M19-T07 service layer and the §9 tests implement them in memory.
//
// THE FAIL DIRECTION IS SET HERE ONLY WHERE IT IS AN IO FACT. A seam that throws becomes a `null` fact and
// the DECIDER turns that null into a dead-letter or a degraded plan — the M21-T04 split, because the fail
// direction of a fact is a domain decision and belongs next to the rule that depends on it. The ONE
// exception is the roster read, where the distinction "unreadable" vs "empty" cannot survive as a null: see
// `readOnCallRoster`.
import type {
  IsoInstant,
  OnCallRosterEntry,
  OrgId,
  PatientId,
  TriageCallId,
} from "@wardenx/types";
import type { OnCallRosterRead } from "../roster/shift-sync";
import { getVisitAssignmentReader, getVisitReader } from "../seams/consumed";
import type {
  CoveringShiftCandidate,
  InboundTriggerFacts,
  TriggerVisitContext,
} from "./inbound-trigger";

/** The M19-owned reads a trigger needs that are NOT seams. Drizzle-backed in M19-T07; in-memory in §9. */
export interface InboundTriggerPorts {
  /** §2.6 / D10 — a `triage_call` already written for this outbox event id. */
  findCallBySourceEvent(organizationId: OrgId, sourceOutboxEventId: string): Promise<TriageCallId | null>;
  /** The coalesce grain (`./inbound-trigger`) — an OPEN call for this patient that a machine opened. */
  findOpenMachineCallForPatient(
    organizationId: OrgId,
    patientId: PatientId,
  ): Promise<TriageCallId | null>;
  /** M19's own non-terminal shifts for a ProviderEntity around the trigger instant. */
  candidateShiftsForProviderEntity(
    organizationId: OrgId,
    providerEntityId: string,
    at: IsoInstant,
  ): Promise<readonly CoveringShiftCandidate[]>;
}

/**
 * Read the visit a trigger names back through M17's `VisitReader`, narrowed to the anchors a `triage_call`
 * needs.
 *
 * Returns `null` on an unresolvable or erroring read rather than throwing: both mean the same thing to the
 * decider ("no tenancy anchor"), and the decider is where §7.6's dead-letter decision lives. A visit the
 * seam refuses under RLS and a visit that does not exist are deliberately indistinguishable here — telling
 * a consumer which one it was would leak the existence of another tenant's visit.
 */
export async function readTriggerVisit(
  organizationId: OrgId,
  visitId: string,
): Promise<TriggerVisitContext | null> {
  try {
    const visit = await getVisitReader().visitForEncounter(organizationId, visitId);
    if (visit === null) return null;
    return {
      visitId: visit.id,
      organizationId: visit.organizationId,
      providerEntityId: visit.providerEntityId,
      locationId: visit.locationId,
      patientId: visit.patientId,
      admissionId: visit.admissionId,
      scheduledStartedAt: visit.scheduledStartedAt,
      scheduledEndedAt: visit.scheduledEndedAt,
    };
  } catch {
    return null;
  }
}

/**
 * Resolve every fact a D10 inbound trigger decider reads, for one delivery.
 *
 * The event-id check runs FIRST and short-circuits: a redelivery must not spend a seam read to conclude it
 * is a redelivery, and at the volume `m17.visit.assigned` storms can reach that is not a micro-optimisation
 * — it is what keeps a retry burst from hammering M17's read path.
 */
export async function resolveInboundTriggerFacts(input: {
  readonly organizationId: OrgId;
  readonly sourceOutboxEventId: string;
  readonly visitId: string;
  readonly at: IsoInstant;
  readonly ports: InboundTriggerPorts;
}): Promise<InboundTriggerFacts> {
  const existingCallForEventId = await input.ports.findCallBySourceEvent(
    input.organizationId,
    input.sourceOutboxEventId,
  );
  if (existingCallForEventId !== null) {
    return {
      existingCallForEventId,
      openMachineCallForPatientId: null,
      visit: null,
      candidateShifts: [],
    };
  }

  const visit = await readTriggerVisit(input.organizationId, input.visitId);
  if (visit === null) {
    return {
      existingCallForEventId: null,
      openMachineCallForPatientId: null,
      visit: null,
      candidateShifts: [],
    };
  }

  const openMachineCallForPatientId = await input.ports.findOpenMachineCallForPatient(
    input.organizationId,
    visit.patientId,
  );
  if (openMachineCallForPatientId !== null) {
    // The coalesce short-circuits the shift read too: no row is written, so no shift is needed.
    return {
      existingCallForEventId: null,
      openMachineCallForPatientId,
      visit,
      candidateShifts: [],
    };
  }

  const candidateShifts = await input.ports.candidateShiftsForProviderEntity(
    input.organizationId,
    visit.providerEntityId,
    input.at,
  );
  return {
    existingCallForEventId: null,
    openMachineCallForPatientId: null,
    visit,
    candidateShifts,
  };
}

/**
 * §4.5 path 1 / §2.7 D-C — read M17's on-call roster, preserving the difference between "M17 says nobody"
 * and "M17 did not answer".
 *
 * This is the one place in M19-T04 where the IO layer, not the decider, fixes a fail direction — because
 * the distinction cannot survive the trip. A thrown seam error caught into `[]` and an org with genuinely
 * no on-call assignments are the same value, and the reconciler's response to them is opposite: leave the
 * committed shifts alone (D-C) versus cancel the scheduled ones the roster dropped. Returning the
 * discriminated {@link OnCallRosterRead} is what keeps an M17 outage from cancelling tonight's coverage.
 */
export async function readOnCallRoster(
  organizationId: OrgId,
  asOfIso: IsoInstant,
): Promise<OnCallRosterRead> {
  try {
    const entries: readonly OnCallRosterEntry[] = await getVisitAssignmentReader().tonightsOnCallRoster(
      organizationId,
      asOfIso,
    );
    return { kind: "roster", entries };
  } catch (error) {
    return {
      kind: "unavailable",
      reason: error instanceof Error ? error.message : "VisitAssignmentReader read failed",
    };
  }
}
