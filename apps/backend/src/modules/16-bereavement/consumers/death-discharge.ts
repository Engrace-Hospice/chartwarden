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
//   • The admission's own siting supplies `providerEntityId` (NOT NULL on every M16 PHI table) and
//     `dischargedAt` for the §2.5 death-date cross-check. It arrives through an INJECTED port rather than
//     through M6's §4.7 `AdmissionStatusReader`, which this file used to call directly (F-105). That seam's
//     id-keyed reads open `withOrgContextFromRequest`, and a relay tick is not a request — so the moment a
//     live consumer called `resolveDeathFact`, every delivery would have thrown `no ambient request context`
//     and dead-lettered, for every death, forever. The port is bound at the composition root to M6's
//     org-explicit `admissionSchedulingContextForOrg` (#48), the same substitution M15's plan bootstrap
//     makes for the same reason.
//
// FAIL-CLOSED: an unresolvable death fact throws `DEATH_FACT_UNRESOLVED` (422) and NO plan row is written.
// Inventing a death date from `eligibleAt` would silently mis-anchor the regulatory clock, which is worse
// than a dead-lettered event a human can re-drive.
//
// F-227 (#248): M6 now models HL7-external death intake (`discharge_event.source`/`source_proposal_id`/
// cosign columns), so the seam returns real provenance and external-source plans are created with their D18
// cosign gate and the REAL proposal id.
import { localDateInTimeZone } from "@wardenx/shared/dates";
import type {
  AdmissionId,
  BereavementExternalSourceMetadata,
  DeathDischargeRow,
  IsoInstant,
  MembershipId,
  PatientId,
} from "@wardenx/types";
import { getDeathDischargeReader } from "../seams/index";

/**
 * How far back the death-discharge scan windows from `eligibleAt`. M6 fires the eligibility rule inside the
 * discharge transaction, but W-DC-01 allows a LATE discharge filing, so the window must cover a death
 * recorded well before the paperwork landed. 180 days covers the longest realistic filing lag without
 * pulling a whole year of an org's decedent census for one lookup.
 */
export const DEATH_DISCHARGE_LOOKBACK_DAYS = 180;

const MS_PER_DAY = 86_400_000;

/**
 * F-105 — the window's upper bound is pushed one millisecond past `eligibleAt`, and without it NO DEATH
 * EVER RESOLVED.
 *
 * `DeathDischargeReader`'s period is HALF-OPEN — its query is `death_at >= from AND death_at < to` — which
 * is the right contract for the reporting-period scans it was written for (M30 asks for a calendar month,
 * and an inclusive bound would double-count the boundary instant into the next one). But M16 is not asking
 * for a period. It is asking "is there a death for this admission AT OR BEFORE the instant the eligibility
 * rule cleared", and on M6's own emit path those two instants are THE SAME VALUE: `m6.bereavement.eligible`
 * carries `eligibleAt = discharge_event.effective_at`, and `discharge_event.death_at` is set from that same
 * `dischargeDate` field in the same statement. So `death_at < to` was false for precisely the row being
 * looked for, `resolveDeathFact` returned null, and the intake threw `DEATH_FACT_UNRESOLVED` — for every
 * death, every time, fail-CLOSED and reported as "M6's census has no row for this admission", which is the
 * opposite of true.
 *
 * The fix is here rather than in the seam: making `listDeathDischargesInPeriod` inclusive would change a
 * published contract under M5, M21 and M30 to fix M16's off-by-one-instant. M5's own death consumer
 * already pads the same bound (`to = dischargeDate + 1 day`) for the same reason; a millisecond is the
 * smallest padding that expresses "inclusive of `eligibleAt`" and cannot pull in a later death.
 */
const INCLUSIVE_BOUND_EPSILON_MS = 1;

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
  /** F-227 — the REAL M29 proposal id M6 stamped on an `hl7_external` death (absent for internal deaths). */
  readonly sourceProposalId?: string;
  /** F-227 — the director attestation once M6 recorded it (only with `cosignStatus='cosigned'`). */
  readonly cosignedAt?: IsoInstant;
  readonly medicalDirectorMembershipId?: string;
  /** The admission's service location. Nullable on `bereavement_plan` by design — a post-death transfer
   *  can leave the decedent's location unresolved (see that table's own tenancy note). */
  readonly locationId: string | null;
}

/**
 * The admission facts the death-fact resolution needs, org-EXPLICIT so it is callable from a relay tick.
 * Bound at the composition root to M6's `admissionSchedulingContextForOrg`; injected so the unit tests
 * drive the same resolver through a double. `null` means the id is unknown in this org — indistinguishable
 * from another tenant's, which is the point.
 */
export type AdmissionAnchorResolver = (
  organizationId: string,
  admissionId: AdmissionId,
) => Promise<{
  readonly providerEntityId: string | null;
  readonly locationId: string | null;
  readonly dischargedAt: string | null;
} | null>;

/**
 * The calendar date of an instant, in `timezone` (`bereavement_plan.death_date` is a DATE column).
 *
 * PARAM-004: was UTC-instant slicing (`new Date(ms).toISOString().slice(0, 10)`) — a death recorded
 * at, say, 11:45pm Pacific is 06:45 UTC the FOLLOWING day, so the naive slice misdated `death_date`
 * one day late for a large fraction of every US evening. D4's 13-month bereavement clock anchors on
 * this exact date, so the off-by-one is regulatory-significant, not cosmetic. `timezone` is the
 * organization's `org_timezone` setting (packages/db/src/organization-settings) — the caller
 * resolves it (this file stays a PURE decision core, no DB access, per its own header) via
 * `todayForOrganization`'s sibling read before calling `resolveDeathFact`.
 */
export function localDateOf(iso: IsoInstant, timezone: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new RangeError(`bereavement: malformed instant '${iso}'`);
  return localDateInTimeZone(new Date(ms), timezone);
}

/**
 * F-105 — the calendar date of a death as M6 ACTUALLY records it, which is not an instant.
 *
 * PARAM-004 replaced a UTC slice with {@link localDateOf} on the reasoning that "a death recorded at
 * 11:45pm Pacific is 06:45 UTC the FOLLOWING day, so the naive slice misdated `death_date` one day late".
 * That is correct about instants and wrong about this column. `discharge_event.death_at` is a `timestamptz`
 * whose ONLY writer is `new Date(input.dischargeDate)`, and `dischargeDate` is `Type.String({ format:
 * "date" })` — a calendar date. M6's own state machine types the field `deathAt: LocalDate`. M6 does not
 * model a time of death at all.
 *
 * So every value in this column is midnight UTC of the date the clinician entered, and converting THAT
 * through a US org's timezone lands on the previous evening — dating every single death ONE DAY EARLY in
 * every organization west of UTC, which is every US hospice. PARAM-004 fixed a failure this data cannot
 * exhibit and introduced one it always will; its own test pins `DEATH_AT = "2026-03-01T04:20:00.000Z"`, an
 * instant with a time component M6's writer can never produce. D4 anchors the 13-month CoP 418.64(d) clock
 * on this exact date, so a day either way is regulatory, not cosmetic.
 *
 * Reading the UTC date is therefore reading M6's value back in the representation M6 wrote it in — the
 * same thing M5's own death consumer does (`deathAt.slice(0, 10)`). `timezone` stays in the signature
 * because it becomes the right answer the day M6 records a real time of death, and {@link localDateOf} is
 * kept and tested for exactly that; until then it would be converting a date that has no time.
 */
export function deathCalendarDate(iso: IsoInstant, timezone: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new RangeError(`bereavement: malformed instant '${iso}'`);
  void timezone;
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
  /** The organization's `org_timezone` setting — resolve via `todayForOrganization`'s sibling read
   *  (packages/db/src/organization-settings/org-today.ts) before calling; this stays a pure function. */
  timezone: string,
  /** The admission's siting + discharge anchor, org-explicit. Injected rather than resolved from M6's
   *  request-scoped §4.7 seam — see the file header (F-105). */
  resolveAdmission: AdmissionAnchorResolver,
): Promise<ResolvedDeathFact | null> {
  const eligibleMs = Date.parse(eligibleAt);
  if (Number.isNaN(eligibleMs)) {
    throw new RangeError(`bereavement: malformed eligibleAt '${eligibleAt}'`);
  }
  const from = new Date(eligibleMs - DEATH_DISCHARGE_LOOKBACK_DAYS * MS_PER_DAY).toISOString();

  const decedents = await getDeathDischargeReader().listDeathDischargesInPeriod(organizationId, {
    from,
    // See INCLUSIVE_BOUND_EPSILON_MS — the seam's period is half-open and the death instant IS
    // `eligibleAt` on M6's emit path.
    to: new Date(eligibleMs + INCLUSIVE_BOUND_EPSILON_MS).toISOString(),
  });
  const match = decedents.find((d) => d.admissionId === admissionId);
  if (match === undefined) return null;

  const summary = await resolveAdmission(organizationId, admissionId);
  // The census has a death row for this admission, so the admission exists in this org. A null here means
  // the two reads disagree about the tenant — a hard fault, not an unsited admission.
  if (summary === null) {
    throw new Error(
      `bereavement: admission ${admissionId} has a death-discharge row but no admission row in org ${organizationId}`,
    );
  }
  // `provider_entity_id` is NOT NULL on `bereavement_plan` and every child table denormalizes it for the
  // §4.6 per-CCN compliance rollups. An unsited admission is a real upstream defect; refusing here
  // dead-letters one delivery a human can see, where a fabricated id would site a 13-month regulatory
  // program under a provider that never served the patient.
  if (summary.providerEntityId === null) {
    throw new Error(
      `bereavement: admission ${admissionId} has no provider entity to site the plan against`,
    );
  }

  return {
    admissionId,
    patientId: match.patientId,
    providerEntityId: summary.providerEntityId,
    deathAt: match.deathAt,
    deathDate: deathCalendarDate(match.deathAt, timezone),
    source: match.source,
    cosignStatus: match.cosignStatus,
    ...(match.sourceProposalId !== undefined ? { sourceProposalId: match.sourceProposalId } : {}),
    ...(match.cosignedAt !== undefined ? { cosignedAt: match.cosignedAt } : {}),
    ...(match.medicalDirectorMembershipId !== undefined
      ? { medicalDirectorMembershipId: match.medicalDirectorMembershipId }
      : {}),
    // F-105 — DELIBERATELY null, and it is not the same as "M6 has no discharge date".
    //
    // `checkDeathDateMatchesAdmission`'s second parameter is named `admissionDeathDate` and its message
    // calls it "the M6 discharge-by-death date": it wants `discharge_event.effective_at`. This resolver
    // used to pass `AdmissionSummary.dischargedAt`, which is `admission.discharged_at` — and that column
    // is written `now()` by the discharge transition, i.e. the instant the paperwork was FILED. Those two
    // agree only when a death is recorded the same day it happened, so the check rejected precisely the
    // late filing W-DC-01 permits and the 180-day lookback above exists to accommodate: every such
    // delivery threw BEREAVEMENT_DEATH_DATE_MISMATCH and no plan opened. The live suite hit it on a
    // backdated death with the message "the plan death date 2026-04-11 does not match the M6
    // discharge-by-death date 2026-08-30" — the second date being today.
    //
    // The value the check asks for is not published: `DeathDischargeRow` carries `deathAt`, `source` and
    // `cosignStatus`, not `effective_at`. Passing null takes the decider's own documented branch ("a null
    // `dischargedAt` is NOT a mismatch"), and the check starts performing the day M6 adds `effectiveAt` to
    // that row — a producer-side change, reported rather than worked around here. Note it would be
    // VACUOUS today even then: M6 sets `death_at` and `effective_at` from the same field in the same
    // statement, so its two surfaces cannot disagree by construction.
    admissionDischargeDate: null,
    locationId: summary.locationId,
  };
}

/**
 * D16 — the `external_source_metadata` blob an external-source plan is stamped with, or `null` for an
 * internal-clinician-recorded death (which is never gated).
 *
 * F-227 (#248) — `sourceProposalId` is the REAL M29 proposal id M6 stamped on the death (`discharge_event.
 * source_proposal_id`, read through the seam); it used to be FABRICATED from `admissionId`, which could
 * never equal the id on a later `m6.discharge.cosigned`, so the D18 release could not have matched. A
 * hl7_external row with no proposal id violates M6's own CHECK (migration 0300) — refuse rather than invent.
 * The HL7 message identifiers §4.3.1 lists beyond the proposal (`sourceMessageId`, facility mdm/name) are
 * still not modelled by M6 and carry the proposal id / empty string. `cosignStatus` falls back to
 * `'pending'`: an external-source plan whose cosign state is unknown must GATE first contact (the same
 * fail-closed reading `evaluateExternalSourceGate` takes on a malformed blob). When the director already
 * attested before the plan was opened, the facts ride along.
 */
export function externalSourceMetadataFor(
  fact: ResolvedDeathFact,
): BereavementExternalSourceMetadata | null {
  if (fact.source !== "hl7_external") return null;
  if (fact.sourceProposalId === undefined) {
    throw new Error(
      `bereavement: hl7_external death for admission ${fact.admissionId} carries no source proposal id`,
    );
  }
  const cosigned =
    fact.cosignStatus === "cosigned" &&
    fact.cosignedAt !== undefined &&
    fact.medicalDirectorMembershipId !== undefined;
  return {
    sourceProposalId: fact.sourceProposalId,
    sourceMessageId: fact.sourceProposalId,
    sourceFacilityMdmId: "",
    sourceFacilityName: "",
    ackReceivedAt: fact.deathAt,
    cosignStatus: cosigned ? "cosigned" : "pending",
    ...(cosigned
      ? {
          cosignedAt: fact.cosignedAt,
          medicalDirectorMembershipId: fact.medicalDirectorMembershipId as MembershipId,
        }
      : {}),
  };
}
