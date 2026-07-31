// apps/backend/src/modules/16-bereavement/consumers/death-discharge.ts — M16-T03 (§2.5, §4.3.1, D16).
//
// Resolve the DEATH FACT behind an inbound `m6.bereavement.eligible` through M6's seams.
//
// SPEC-vs-CODE DEVIATION, deliberate and load-bearing. §4.3.1 writes the worker as if M6's event payload
// carried `deathAt` plus the whole D16 provenance block (`source`, `sourceProposalId`, `sourceMessageId`,
// `sourceFacilityMdmId`, `sourceFacilityName`, `ackReceivedAt`). The MERGED M6 event
// (apps/backend/src/modules/06-admission/events-by-m6.ts) carries three fields — `admissionId`,
// `patientId`, `eligibleAt` — and M6 owns that catalog. M16 cannot widen another module's event, and
// `eligibleAt` is the instant the RULE cleared, not the instant of death: anchoring the 13-month clock on
// it would shorten every survivor's program by however long the discharge paperwork lagged (exactly the
// failure D4's "anchor on death, never on discharge filing" rule exists to prevent).
//
// So the death fact is READ, not received:
//
//   • M6's §4.11 `DeathDischargeReader` is the only published surface carrying `deathAt` — and it carries
//     the D16 `source` + `cosignStatus` too. Its one method is a PERIOD scan, so M16 asks for a narrow
//     window ending at `eligibleAt` and matches on `admissionId` — the same "the seam has no by-id lookup,
//     so window-and-match" shape M15-T03 used against M8's `SignedEncountersReader`.
//   • M6's §4.7 `AdmissionStatusReader` supplies `providerEntityId` (NOT NULL on every M16 PHI table) and
//     `dischargedAt` for the §2.5 death-date cross-check.
//
// FAIL-CLOSED: an unresolvable death fact throws `DEATH_FACT_UNRESOLVED` (422) and NO plan row is written.
// Inventing a death date from `eligibleAt` would silently mis-anchor the regulatory clock, which is worse
// than a dead-lettered event a human can re-drive.
//
// KNOWN LIMITATION, carried from the seam's own contract: M6's frozen `discharge_event` models only the
// death fact, so its `DeathDischargeReader` impl currently returns `source='internal_clinician_recorded'`
// for every decedent. M16 branches on the CONTRACT, so external-source plans start being created — with
// their D18 cosign gate — the day M6 models HL7-external death intake, with no change here.
import type {
  AdmissionId,
  BereavementExternalSourceMetadata,
  DeathDischargeRow,
  IsoInstant,
  PatientId,
} from "@wardenx/types";
import { getAdmissionStatusReader, getDeathDischargeReader } from "../seams/index";

/**
 * How far back the death-discharge scan windows from `eligibleAt`. M6 fires the eligibility rule inside the
 * discharge transaction, but W-DC-01 allows a LATE discharge filing, so the window must cover a death
 * recorded well before the paperwork landed. 180 days covers the longest realistic filing lag without
 * pulling a whole year of an org's decedent census for one lookup.
 */
export const DEATH_DISCHARGE_LOOKBACK_DAYS = 180;

const MS_PER_DAY = 86_400_000;

/** The resolved death fact the §4.3.1 intake decides over. */
export interface ResolvedDeathFact {
  readonly admissionId: AdmissionId;
  readonly patientId: PatientId;
  readonly providerEntityId: string;
  /** The instant of death (D4's anchor), as M6 recorded it. */
  readonly deathAt: IsoInstant;
  /** `YYYY-MM-DD` in UTC — the `bereavement_plan.death_date` column. */
  readonly deathDate: string;
  /** D16 — which intake path produced the death fact. */
  readonly source: DeathDischargeRow["source"];
  readonly cosignStatus: DeathDischargeRow["cosignStatus"];
  /** M6's admission-level discharge date, for the §2.5 cross-check. Null when M6 has none recorded. */
  readonly admissionDischargeDate: string | null;
}

/** The UTC calendar date of an instant (`bereavement_plan.death_date` is a DATE column). */
export function utcDateOf(iso: IsoInstant): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new RangeError(`bereavement: malformed instant '${iso}'`);
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Resolve the death fact for an `m6.bereavement.eligible` delivery. Returns `null` when M6's census has no
 * death-discharge row for the admission inside the lookback window — the caller turns that into
 * `DEATH_FACT_UNRESOLVED` rather than guessing.
 */
export async function resolveDeathFact(
  organizationId: string,
  admissionId: AdmissionId,
  eligibleAt: IsoInstant,
): Promise<ResolvedDeathFact | null> {
  const eligibleMs = Date.parse(eligibleAt);
  if (Number.isNaN(eligibleMs)) {
    throw new RangeError(`bereavement: malformed eligibleAt '${eligibleAt}'`);
  }
  const from = new Date(eligibleMs - DEATH_DISCHARGE_LOOKBACK_DAYS * MS_PER_DAY).toISOString();

  const decedents = await getDeathDischargeReader().listDeathDischargesInPeriod(organizationId, {
    from,
    to: eligibleAt,
  });
  const match = decedents.find((d) => d.admissionId === admissionId);
  if (match === undefined) return null;

  const summary = await getAdmissionStatusReader().getAdmissionSummary(admissionId);

  return {
    admissionId,
    patientId: match.patientId,
    providerEntityId: summary.providerEntityId,
    deathAt: match.deathAt,
    deathDate: utcDateOf(match.deathAt),
    source: match.source,
    cosignStatus: match.cosignStatus,
    admissionDischargeDate: summary.dischargedAt,
  };
}

/**
 * D16 — the `external_source_metadata` blob an external-source plan is stamped with, or `null` for an
 * internal-clinician-recorded death (which is never gated).
 *
 * The seam carries the provenance FACTS M6 can prove (`source`, `cosignStatus`) but not the HL7 message
 * identifiers §4.3.1's payload sketch lists — M6 does not model them yet. Rather than fabricate them, the
 * identifier fields carry the admission-scoped correlation M16 does have, and `cosignStatus` falls back to
 * `'pending'`: an external-source plan whose cosign state is unknown must GATE first contact, not sail
 * past it (the same fail-closed reading `evaluateExternalSourceGate` takes on a malformed blob).
 */
export function externalSourceMetadataFor(
  fact: ResolvedDeathFact,
): BereavementExternalSourceMetadata | null {
  if (fact.source !== "hl7_external") return null;
  return {
    sourceProposalId: fact.admissionId,
    sourceMessageId: fact.admissionId,
    sourceFacilityMdmId: "",
    sourceFacilityName: "",
    ackReceivedAt: fact.deathAt,
    cosignStatus: fact.cosignStatus === "cosigned" ? "cosigned" : "pending",
  };
}
