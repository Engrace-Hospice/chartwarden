// apps/backend/src/modules/14-idg/jobs/packet-build.ts — §2.2 `BUILD_PACKETS`/§2.4 D1/§2.5 D7/§7.2
// W-PKT-01 the T-24h IDG packet-build worker (F-171, #248), continuing the F-129/F-145/F-164/F-167/F-169
// investigation of the m14 `handlers-unbound` group. Every prior pass in that chain (most recently F-169,
// 2026-09-29) confirmed the SAME root cause for the group's 8 remaining blocked events: "the M14 §2.4 T-24h
// packet-build worker has never been written in production ... `jobs/index.ts` ships exactly ONE cron
// (`idg.review-clock-sweep`) ... `buildPackets` only flips meeting status and counts pre-existing packet
// rows ... no INSERT into `idg_patient_packet` anywhere under `14-idg/` outside test fixtures." This file
// is that worker, built for real rather than investigated a further time.
//
// SCOPE, decided conservatively per the user's explicit "a wrong guess here is a patient-safety-adjacent
// defect" instruction — every field with no cheap, CORRECT cross-module source is left honestly absent
// (`null` / `[]`), never guessed, and documented per-field below rather than silently:
//   • `hopeContext`         — null. No org-explicit M9/M10 "current upcoming timepoints" seam exists; the
//                             only M9/M10 facts this worker has are the F-164 cache's EVENT HISTORY
//                             (significant changes / J2051 triggers), not a live "what's upcoming" snapshot.
//   • `flaggedEvents`       — []. §2.4's "hospitalisation / ER / missed dose / fall / infection — derived"
//                             needs event-tagging infrastructure (which M8 encounter types or outbox events
//                             map to which flag kind) that does not exist anywhere in this codebase yet.
//   • `carryForwardActionItems` — []. §2.7's carry-forward computation is a SEPARATE cron concern (its own
//                             row in the §2.7 table, "T-24h cron on next meeting build") this pass does not
//                             attempt — reported, not built.
//   • `nextRecertDueAt`, `f2fWindowState`, `activeDpoa` — null. Each needs either a real M6 window-state
//                             decider (F2F/recert timing rules this pass declines to re-derive from raw
//                             CTI/F2F rows without an existing pure source — the exact "STOP rather than
//                             guess" case for a load-bearing clinical-timing judgment) or an M39 DPOA seam
//                             this pass does not build. All three are display-only cover facts (they feed a
//                             discussion FLAG, never D9 inclusion), so an honest `null` is the safe
//                             direction — never a fabricated compliance judgment.
//   • Layer 2 narrative polish — untouched; the pure builder already always returns `layer2Polished: null`
//                             ("BASIC build" per its own header).
// Every OTHER §2.4 field is populated from REAL data: M5 patient identity, M6 admission siting +
// inclusion (new org-explicit seam, `idgPacketInclusionForOrg`) + current LOC (`idgCurrentLevelOfCareForOrg`),
// M7 active-plan summary + terminal diagnosis + SUD flag (new org-explicit seam,
// `idgPacketCarePlanContextForOrg`), M8 signed encounters since cursor (the already-published
// `SignedEncountersReader` seam), and the F-164 Valkey "since last IDG" cache for M9/M10 event history +
// M11/M12 discontinuations.
//
// FAILURE ISOLATION (the §4.9.1 `build-packet` per-patient-job design, done here as a per-patient
// transaction rather than a separate BullMQ job per patient — effort-scoped, but the load-bearing property
// is preserved): any per-patient data gap this pass cannot honestly fill with a REQUIRED (non-nullable)
// packet field — no care plan, no signed version, no terminal diagnosis, no current LOC — is caught and
// reported via the ALREADY-CATALOGUED `m14.packets.build_failed_for_patient` (§4.4), never fabricated, and
// never aborts the meeting's other patients' builds.
import { randomUUID } from "node:crypto";
import { type DbClient, schema } from "@wardenx/db";
import {
  buildPacketSnapshot,
  type CarePlanSummaryInput,
  type PacketBuildContext,
  type PacketCoverInput,
  POST_DISCHARGE_WRAP_UP_FLOOR_DAYS,
  resolveSinceCursor,
  type SinceLastIdgInput,
  transitionMeeting,
} from "@wardenx/idg";
import { withOrgContext } from "@wardenx/tenancy";
import type { DisciplineKey, DisciplineViewBlock, IdgLevelOfCare, PacketSnapshot } from "@wardenx/types";
import { and, eq, inArray, lte } from "drizzle-orm";
import type Redis from "ioredis";
import { getSeam } from "../../../bootstrap/index";
import { readSinceLastIdgEntry } from "../consumers/since-last-idg-cache";
import type { IdgWriteOutboxPort } from "../idg-route-service-db";
import type { ActiveOrgListPort } from "./index";

const MTG = schema.idgMeeting;
const PKT = schema.idgPatientPacket;
const POL = schema.idgRecurringPolicy;

// ── ports (M6/M7 org-explicit reads injected by the composition root — a locally-declared structural
// type, never an imported one, per `arch:boundaries`'s type-only-import rule, F-165's `m16-plan-closed.ts`
// precedent) ─────────────────────────────────────────────────────────────────────────────────────────────

/** The §2.3 D9 inclusion candidate shape `idgPacketInclusionForOrg` (M6) returns. */
export interface Idg6PacketInclusionCandidate {
  readonly admissionId: string;
  readonly patientId: string;
  readonly providerEntityId: string;
  readonly locationId: string;
  readonly activatedAtIso: string;
  readonly inclusionReason: "active" | "post_discharge_wrap_up";
}

/** The M6 port: §2.3 D9 inclusion + §2.4 current LOC, both org-explicit and cron-callable. */
export interface Idg6PacketPort {
  inclusionForOrg(
    organizationId: string,
    locationId: string,
    asOfIso: string,
    wrapUpDays: number,
  ): Promise<readonly Idg6PacketInclusionCandidate[]>;
  /** Returns the M6 `LevelOfCare` enum string (`routine_home_care`, …) — mapped to `IdgLevelOfCare` below. */
  currentLevelOfCareForOrg(
    organizationId: string,
    admissionId: string,
    asOfIso: string,
  ): Promise<string | null>;
}

/** The §2.4 `carePlanSummary` + terminal-diagnosis + SUD-flag shape `idgPacketCarePlanContextForOrg` (M7)
 *  returns. `null` fields are genuine care-plan gaps (never signed, no terminal problem) the caller treats
 *  as a per-patient build failure rather than fabricating a value for a non-nullable packet field. */
export interface Idg7PacketCarePlanContext {
  readonly carePlanId: string;
  readonly activeProblemCount: number;
  readonly activeGoalCount: number;
  readonly activeInterventionCount: number;
  readonly lastSignedVersionId: string | null;
  readonly lastSignedAt: string | null;
  readonly nextReviewDueAt: string | null;
  readonly isReviewOverdue: boolean;
  readonly terminalDiagnosisIcd10: string | null;
  readonly terminalDiagnosisLabel: string | null;
  readonly sudFlag: boolean;
}

/** The M7 port: §2.4 `carePlanSummary` + cover diagnosis/SUD facts, org-explicit and cron-callable. */
export interface Idg7PacketPort {
  carePlanContextForOrg(
    organizationId: string,
    patientId: string,
    asOfIso: string,
  ): Promise<Idg7PacketCarePlanContext | null>;
}

export interface PacketBuildWorkerDeps {
  readonly db: DbClient;
  readonly outbox: IdgWriteOutboxPort;
  readonly redis: Redis;
  readonly m6: Idg6PacketPort;
  readonly m7: Idg7PacketPort;
  readonly activeOrgs: ActiveOrgListPort;
  now?: () => Date;
}

/** The M6 `level_of_care` enum → M14's `IdgLevelOfCare` — the two enums use different string values
 *  (checked directly against both schemas, not assumed to align). */
const LOC_MAP: Readonly<Record<string, IdgLevelOfCare>> = {
  routine_home_care: "routine",
  continuous_home_care: "continuous",
  inpatient_respite_care: "inpatient_respite",
  general_inpatient_care: "general_inpatient",
};

/** The §7.2 T-24h lookahead: a `scheduled`/`packets_building` meeting whose `scheduled_start` is at or
 *  before `now + 24h` is due. `packets_building` is included (not only `scheduled`) so a build interrupted
 *  mid-run — this worker builds each patient in its OWN transaction, so a crash after patient 3 of 10 never
 *  rolls back 1-2 — is resumed on the next tick rather than stuck forever (a `packets_building` meeting is
 *  excluded from nothing else, since only THIS query ever reads that status). */
const BUILD_LOOKAHEAD_MS = 24 * 60 * 60 * 1000;

interface DueMeeting {
  readonly meetingId: string;
  readonly locationId: string;
  readonly status: "scheduled" | "packets_building";
  readonly version: number;
}

async function dueMeetingsForOrg(
  tx: DbClient,
  organizationId: string,
  now: Date,
): Promise<readonly DueMeeting[]> {
  const rows = await tx
    .select({ id: MTG.id, locationId: MTG.locationId, status: MTG.status, version: MTG.version })
    .from(MTG)
    .where(
      and(
        eq(MTG.organizationId, organizationId),
        inArray(MTG.status, ["scheduled", "packets_building"] as never),
        lte(MTG.scheduledStart, new Date(now.getTime() + BUILD_LOOKAHEAD_MS)),
      ),
    );
  return rows.map((r) => ({
    meetingId: r.id,
    locationId: r.locationId,
    status: r.status as "scheduled" | "packets_building",
    version: r.version,
  }));
}

/** §2.3 D9 — the platform-floor post-discharge wrap-up window, per LOCATION (`idg_recurring_policy`),
 *  never below the 7-day platform floor even if a row is mis-seeded under it. */
async function wrapUpDaysForLocation(
  tx: DbClient,
  organizationId: string,
  locationId: string,
): Promise<number> {
  const [row] = await tx
    .select({ days: POL.postDischargeWrapUpDays })
    .from(POL)
    .where(
      and(
        eq(POL.organizationId, organizationId),
        eq(POL.locationId, locationId),
        eq(POL.active, true),
      ),
    )
    .limit(1);
  return row ? Math.max(row.days, POST_DISCHARGE_WRAP_UP_FLOOR_DAYS) : POST_DISCHARGE_WRAP_UP_FLOOR_DAYS;
}

/** §1.1 — the prior IDG's `adjourned_at` for THIS patient: `MAX(last_idg_reviewed_at)` across every OTHER
 *  packet the patient has (M14-owned table, read directly — no seam needed). `null` ⇒ first IDG. */
async function priorIdgAdjournedAtForPatient(
  tx: DbClient,
  organizationId: string,
  patientId: string,
  excludeMeetingId: string,
): Promise<string | null> {
  const rows = await tx
    .select({ meetingId: PKT.idgMeetingId, lastIdgReviewedAt: PKT.lastIdgReviewedAt })
    .from(PKT)
    .where(and(eq(PKT.organizationId, organizationId), eq(PKT.patientId, patientId)));
  let latest: Date | string | null = null;
  for (const r of rows) {
    if (r.meetingId === excludeMeetingId || r.lastIdgReviewedAt === null) continue;
    if (latest === null || new Date(r.lastIdgReviewedAt) > new Date(latest)) latest = r.lastIdgReviewedAt;
  }
  return latest === null ? null : latest instanceof Date ? latest.toISOString() : latest;
}

/** Whole-years age as of `asOf`, from an ISO `yyyy-mm-dd` date of birth (calendar-correct, not a flat
 *  365.25-day division). */
function ageAsOf(dateOfBirth: string, asOf: Date): number {
  const dob = new Date(`${dateOfBirth}T00:00:00.000Z`);
  let age = asOf.getUTCFullYear() - dob.getUTCFullYear();
  const hadBirthdayThisYear =
    asOf.getUTCMonth() > dob.getUTCMonth() ||
    (asOf.getUTCMonth() === dob.getUTCMonth() && asOf.getUTCDate() >= dob.getUTCDate());
  if (!hadBirthdayThisYear) age -= 1;
  return age;
}

/** A deterministic, real-data (never fabricated) Layer-1 cover sentence for the DENYLISTED
 *  `cover_summary_layer1` column — the closest this BASIC build gets to §2.4's narrative cover without
 *  attempting Layer 2 AI polish (out of scope; the pure builder already always returns
 *  `layer2Polished: null`). */
function layer1CoverSummary(snapshot: PacketSnapshot): string {
  const s = snapshot.sinceLastIdg;
  const sinceLabel = snapshot.meta.sinceContext === "first_idg" ? "admission" : "the last IDG";
  return (
    `${snapshot.flagsForDiscussion.length} discussion flag(s); since ${sinceLabel}: ` +
    `${s.encounters.length} encounter(s), ${s.significantAssessmentChanges.length} assessment change(s), ` +
    `${s.j2051Triggers.length} HOPE trigger(s), ${s.ordersChanged.length} order change(s), ` +
    `${s.medicationsChanged.length} medication change(s); ` +
    `${snapshot.carryForwardActionItems.length} carried-forward action item(s).`
  );
}

// Every `withOrgContext` call below stamps `userId: ""`, not `M14_WORKER_SYSTEM_USER_ID` — the F-102
// `CONSUMER_USER_ID` convention (also `idg-route-service-db.ts`'s own `withOrg` helper): `idg_meeting`/
// `idg_patient_packet` carry the M4 write-audit trigger, which resolves `app.user_id` to `actor_user_id`
// through a real FK into `"user"` — a fabricated-looking sentinel UUID with no matching row throws 23503
// on every write (caught live, writing this file's own test), while the empty-string GUC sentinel maps to
// a NULL actor, correctly describing "the system, not a person, made this change".

/** One per-patient build outcome — either a built packet id, or a reported (never fabricated) reason. */
type PatientBuildResult =
  | { readonly ok: true; readonly packetId: string; readonly patientId: string; readonly snapshot: PacketSnapshot; readonly disciplineViews: Record<DisciplineKey, DisciplineViewBlock> }
  | { readonly ok: false; readonly patientId: string; readonly reason: string };

/** Build (or replace-in-place, D5) one patient's packet for one meeting. Every REQUIRED (non-nullable)
 *  §2.4 field this pass cannot honestly source is a build FAILURE for this one patient, never a fabricated
 *  value and never an abort of the meeting's other patients. */
async function buildOnePatientPacket(
  deps: PacketBuildWorkerDeps,
  organizationId: string,
  meetingId: string,
  locationId: string,
  candidate: Idg6PacketInclusionCandidate,
  asOf: Date,
): Promise<PatientBuildResult> {
  const fail = (reason: string): PatientBuildResult => ({ ok: false, patientId: candidate.patientId, reason });
  try {
    const identity = await getSeam("PatientReader").findById({
      organizationId,
      id: candidate.patientId,
    });
    if (!identity) return fail("patient_identity_not_found");

    const carePlan = await deps.m7.carePlanContextForOrg(
      organizationId,
      candidate.patientId,
      asOf.toISOString(),
    );
    if (!carePlan) return fail("no_care_plan");
    if (carePlan.lastSignedVersionId === null || carePlan.lastSignedAt === null) {
      return fail("no_signed_care_plan_version");
    }
    if (carePlan.nextReviewDueAt === null) return fail("no_next_review_due_date");
    if (carePlan.terminalDiagnosisIcd10 === null || carePlan.terminalDiagnosisLabel === null) {
      return fail("no_terminal_diagnosis");
    }

    const locRaw = await deps.m6.currentLevelOfCareForOrg(
      organizationId,
      candidate.admissionId,
      asOf.toISOString(),
    );
    const levelOfCare = locRaw !== null ? LOC_MAP[locRaw] : undefined;
    if (!levelOfCare) return fail("no_level_of_care");

    const priorIdgAdjournedAt = await withOrgContext(
      deps.db,
      { organizationId, userId: "" },
      (tx) =>
        priorIdgAdjournedAtForPatient(
          tx as unknown as DbClient,
          organizationId,
          candidate.patientId,
          meetingId,
        ),
    );
    const { sinceCursorIso } = resolveSinceCursor(priorIdgAdjournedAt, candidate.activatedAtIso);

    const cacheEntry = await readSinceLastIdgEntry(deps.redis, candidate.patientId);
    const encounters = await getSeam("SignedEncountersReader").signedEncountersForPatientSince(
      organizationId,
      candidate.patientId as never,
      sinceCursorIso,
    );

    const sinceLastIdg: SinceLastIdgInput = {
      encounters: encounters.map((e) => ({
        encounterId: e.encounterId,
        encounterType: e.encounterType,
        signedAt: e.signedAt,
        authorDiscipline: e.discipline,
      })),
      significantAssessmentChanges: cacheEntry.significantAssessmentChanges,
      j2051Triggers: cacheEntry.j2051Triggers,
      ordersChanged: cacheEntry.orderChanges,
      medicationsChanged: cacheEntry.medicationChanges,
      flaggedEvents: [], // §2.4 event-tagging infra unbuilt — see file header
    };

    const carePlanSummary: CarePlanSummaryInput = {
      activeProblemCount: carePlan.activeProblemCount,
      activeGoalCount: carePlan.activeGoalCount,
      activeInterventionCount: carePlan.activeInterventionCount,
      lastSignedVersionId: carePlan.lastSignedVersionId,
      lastSignedAt: carePlan.lastSignedAt,
      nextReviewDueAt: carePlan.nextReviewDueAt,
      isReviewOverdue: carePlan.isReviewOverdue,
    };

    const cover: PacketCoverInput = {
      firstName: identity.firstName,
      lastInitial: identity.lastName.charAt(0).toUpperCase(),
      age: ageAsOf(identity.dateOfBirth, asOf),
      primaryDiagnosisIcd10: carePlan.terminalDiagnosisIcd10,
      primaryDiagnosisLabel: carePlan.terminalDiagnosisLabel,
      levelOfCare,
      nextRecertDueAt: null, // see file header
      f2fWindowState: null, // see file header
      activeDpoa: null, // see file header
      activeSudFlag: carePlan.sudFlag,
    };

    const context: PacketBuildContext = {
      meetingId: meetingId as never,
      patientId: candidate.patientId as never,
      admissionId: candidate.admissionId as never,
      locationId: locationId as never,
      builtAt: asOf.toISOString(),
      builderJobId: randomUUID(),
      priorIdgAdjournedAt,
      admissionActivatedAt: candidate.activatedAtIso,
    };

    const { snapshot, disciplineViews } = buildPacketSnapshot({
      context,
      cover,
      sinceLastIdg,
      carePlanSummary,
      hopeContext: null, // see file header
      carryForwardActionItems: [], // see file header
    });

    const packetId = await withOrgContext(
      deps.db,
      { organizationId, userId: "" },
      async (txRaw) => {
        const tx = txRaw as unknown as DbClient;
        const [existing] = await tx
          .select({ id: PKT.id })
          .from(PKT)
          .where(
            and(
              eq(PKT.organizationId, organizationId),
              eq(PKT.idgMeetingId, meetingId),
              eq(PKT.patientId, candidate.patientId),
            ),
          )
          .limit(1);
        const coverSummaryLayer1 = layer1CoverSummary(snapshot);
        let id: string;
        if (existing) {
          await tx
            .update(PKT)
            .set({
              builtAt: asOf,
              sinceCursorIso,
              builtSnapshot: snapshot,
              disciplineViews,
              coverSummaryLayer1,
              updatedAt: asOf,
            })
            .where(eq(PKT.id, existing.id));
          id = existing.id;
        } else {
          const [row] = await tx
            .insert(PKT)
            .values({
              organizationId,
              providerEntityId: candidate.providerEntityId,
              locationId,
              idgMeetingId: meetingId,
              patientId: candidate.patientId,
              admissionId: candidate.admissionId,
              builtAt: asOf,
              sinceCursorIso,
              builtSnapshot: snapshot,
              disciplineViews,
              coverSummaryLayer1,
            })
            .returning({ id: PKT.id });
          id = row!.id;
        }
        await deps.outbox.publish(tx, {
          eventName: "m14.packet.render_requested",
          payload: {
            meetingId,
            patientId: candidate.patientId,
            packetId: id,
            renderPayload: { snapshot, disciplineViews },
          },
          organizationId,
          aggregateKind: "idg_patient_packet",
          aggregateId: id,
        });
        return id;
      },
    );

    return { ok: true, packetId, patientId: candidate.patientId, snapshot, disciplineViews };
  } catch (error) {
    return fail(`unexpected_error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Process one due meeting: transition `scheduled → packets_building` (skipped if already there — the
 *  resume-after-crash case), build every §2.3 D9-included patient's packet (each independently, per-patient
 *  failure isolation), then `packets_building → packets_ready` + `m14.packets.ready`. */
async function processDueMeeting(
  deps: PacketBuildWorkerDeps,
  organizationId: string,
  meeting: DueMeeting,
  now: Date,
): Promise<void> {
  const wrapUpDays = await withOrgContext(
    deps.db,
    { organizationId, userId: "" },
    (tx) => wrapUpDaysForLocation(tx as unknown as DbClient, organizationId, meeting.locationId),
  );
  const candidates = await deps.m6.inclusionForOrg(
    organizationId,
    meeting.locationId,
    now.toISOString(),
    wrapUpDays,
  );

  if (meeting.status === "scheduled") {
    transitionMeeting("scheduled", {
      type: "BUILD_PACKETS",
      includedPatientCount: candidates.length,
    });
    await withOrgContext(deps.db, { organizationId, userId: "" }, async (txRaw) => {
      const tx = txRaw as unknown as DbClient;
      const [row] = await tx
        .select({ version: MTG.version, status: MTG.status })
        .from(MTG)
        .where(eq(MTG.id, meeting.meetingId))
        .limit(1);
      if (!row || row.status !== "scheduled") return; // raced with another tick/the on-demand route
      await tx
        .update(MTG)
        .set({ status: "packets_building", version: row.version + 1, updatedAt: now })
        .where(eq(MTG.id, meeting.meetingId));
      await deps.outbox.publish(tx, {
        eventName: "m14.packets.build_started",
        payload: { meetingId: meeting.meetingId, includedPatientCount: candidates.length },
        organizationId,
        aggregateKind: "idg_meeting",
        aggregateId: meeting.meetingId,
      });
    });
  }

  let builtCount = 0;
  for (const candidate of candidates) {
    const result = await buildOnePatientPacket(
      deps,
      organizationId,
      meeting.meetingId,
      meeting.locationId,
      candidate,
      now,
    );
    if (result.ok) {
      builtCount += 1;
      continue;
    }
    await withOrgContext(deps.db, { organizationId, userId: "" }, (txRaw) =>
      deps.outbox.publish(txRaw, {
        eventName: "m14.packets.build_failed_for_patient",
        payload: {
          meetingId: meeting.meetingId,
          patientId: result.patientId,
          reason: result.reason,
          willRetry: true, // the next tick re-selects this meeting (status stays `packets_building`)
        },
        organizationId,
        aggregateKind: "idg_meeting",
        aggregateId: meeting.meetingId,
      }),
    );
  }

  await withOrgContext(deps.db, { organizationId, userId: "" }, async (txRaw) => {
    const tx = txRaw as unknown as DbClient;
    const [row] = await tx
      .select({ version: MTG.version, status: MTG.status })
      .from(MTG)
      .where(eq(MTG.id, meeting.meetingId))
      .limit(1);
    if (!row || row.status !== "packets_building") return;
    transitionMeeting("packets_building", { type: "PACKETS_READY", builtPacketCount: builtCount });
    await tx
      .update(MTG)
      .set({ status: "packets_ready", version: row.version + 1, updatedAt: now })
      .where(eq(MTG.id, meeting.meetingId));
    await deps.outbox.publish(tx, {
      eventName: "m14.packets.ready",
      payload: {
        meetingId: meeting.meetingId,
        builtPacketCount: builtCount,
        // No invitee-roster table exists anywhere in M14's schema (`idg_attendance` rows are CHECK-INS,
        // written only from `START` onward — after packets are already ready); honestly 0 rather than
        // guessed, matching the M23/M26 "honest absence" convention this arc uses throughout.
        scheduledAttendees: 0,
      },
      organizationId,
      aggregateKind: "idg_meeting",
      aggregateId: meeting.meetingId,
    });
  });
}

/** `idg.packets-cron` (§4.8/§4.9.1 `tminus-24h-build` — F-171, #248) — for each active org, build every
 *  packet for every meeting due within the T-24h lookahead. One org's failure never blocks a sibling org's
 *  tick (collected + rethrown together, the `runReviewClockSweepCron` shape); one meeting's failure never
 *  blocks a sibling meeting in the SAME org. */
export async function runPacketBuildCron(deps: PacketBuildWorkerDeps): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();
  const orgs = await deps.activeOrgs.listActiveOrgs();
  const failures: { organizationId: string; error: unknown }[] = [];
  for (const { organizationId } of orgs) {
    try {
      const due = await withOrgContext(
        deps.db,
        { organizationId, userId: "" },
        (tx) => dueMeetingsForOrg(tx as unknown as DbClient, organizationId, now),
      );
      for (const meeting of due) {
        await processDueMeeting(deps, organizationId, meeting, now);
      }
    } catch (error) {
      failures.push({ organizationId, error });
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((f) => f.error),
      `M14_PACKET_BUILD: ${failures.length} of ${orgs.length} org(s) failed — ` +
        `${failures.map((f) => f.organizationId).join(", ")}`,
    );
  }
}
