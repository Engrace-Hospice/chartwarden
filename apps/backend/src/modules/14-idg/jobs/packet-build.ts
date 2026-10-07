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
//   • `hopeContext`        — POPULATED from M10 (`idgHopeContextForOrg`, org-explicit + BATCHED, bound through
//                             the `Idg10HopeContextPort`): the patient's still-open HOPE schedule windows
//                             (`upcomingTimepoints`, due = window close) + the open/overdue SFV count. Seam
//                             success ⇒ an entry for every patient (an empty context is a TRUE "nothing due");
//                             unbound port / seam error / missing patient ⇒ `null` ("not captured"), never a guess.
//   • `flaggedEvents`      — POPULATED from four org-explicit BATCHED seams behind `IdgFlaggedEventSourcePort`s:
//                             M6 (`idgHospitalEventsForOrg` → `hospitalisation` / `er_visit`, from the ADT-derived
//                             `concurrent_hospital_admission` windows), M13 (`idgMissedDosesForOrg` → `missed_dose`),
//                             M30 (`idgQualityFlaggedEventsForOrg` → `fall` / `infection`), M19 (`idgTriageCarePlanChangesForOrg` →
//                             `triage_care_plan_change`, F-218). Each source is isolated —
//                             one failing is logged and contributes nothing, never a guessed row. The builder applies
//                             the per-patient `> cursor` filter.
//   • `carryForwardActionItems` — POPULATED from M14's OWN `idg_action_item` (read directly, no seam): the patient's
//                             `open`/`in_progress` items from OTHER meetings whose `due_date` is past (spec §2.7:
//                             "open action items past `due_date`"). `carryForwardCount` is the row's stored
//                             `meeting_carry_forward_count`. This is the packet's READ of carry-forward state; the
//                             §2.7/§7.6 `compute-carry-forward` cron (`./carry-forward.ts` — agenda items of
//                             `kind='carry_forward'`, the once-per-(item,meeting) count increment, the ≥3 Compliance
//                             alert) is a SEPARATE concern this build deliberately does not perform (an on-demand
//                             rebuild must never double-increment; it only READS the stored count).
//   • `activeDpoa`          — null. Needs an M39 DPOA seam this pass does not build. Display-only cover
//                             fact (feeds a discussion FLAG, never D9 inclusion), so an honest `null` is the
//                             safe direction — never a fabricated compliance judgment.
//   • `nextRecertDueAt`, `f2fWindowState` — POPULATED at build time (packet-freeze semantics: snapshotted into
//                             `built_snapshot`, never re-read live) from the M6 seam `idgRecertWindowsForOrg`
//                             through the org-explicit `Idg6RecertWindowPort` (ONE batched call per meeting,
//                             evaluated as of the tick's `now` in the ORG's timezone). The window math is M6's
//                             own (`computeF2fWindow`/`decideF2fWindowStatus`) — NOT re-derived here; this
//                             worker only maps: the seam's org-local `nextRecertDueDate` (`yyyy-mm-dd`) →
//                             an ISO instant at that calendar day's 00:00Z (a date anchor, not a local-midnight
//                             claim), and its §2.4 `f2fWindowState` enum straight through. FAIL-HONEST: no
//                             port bound, a seam error/timeout (logged, never thrown — a display-only cover
//                             fact must not fail a patient's packet), a patient absent from the result, or an
//                             unresolvable benefit period ⇒ `null` for that field, never a guess.
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
  type CarePlanSummaryInput,
  POST_DISCHARGE_WRAP_UP_FLOOR_DAYS,
  type PacketBuildContext,
  type PacketCoverInput,
  type SinceLastIdgInput,
  buildPacketSnapshot,
  resolveSinceCursor,
  transitionMeeting,
} from "@wardenx/idg";
import { withOrgContext } from "@wardenx/tenancy";
import type {
  DisciplineKey,
  DisciplineViewBlock,
  IdgLevelOfCare,
  PacketActionItemCarryForwardDigest,
  PacketFlaggedEventDigest,
  PacketSnapshot,
} from "@wardenx/types";
import { and, eq, inArray, lt, lte, ne } from "drizzle-orm";
import type Redis from "ioredis";
import { getSeam } from "../../../bootstrap/index";
import { readSinceLastIdgEntry } from "../consumers/since-last-idg-cache";
import type { IdgWriteOutboxPort } from "../idg-route-service-db";
import type { IdgMembershipDisplayPort, IdgSiteDisplayPort } from "../routes/idg-enrichment";
import type { ActiveOrgListPort } from "./index";
import {
  type PacketSiteNames,
  buildPacketRenderContext,
  resolveMemberNames,
  resolvePacketSiteNames,
} from "./packet-render-context";

const MTG = schema.idgMeeting;
const PKT = schema.idgPatientPacket;
const POL = schema.idgRecurringPolicy;
const ACT = schema.idgActionItem;

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

/** One patient's recert/F2F cover facts as M6's `idgRecertWindowsForOrg` projects them (structural subset —
 *  dates are org-local `yyyy-mm-dd`; `f2fWindowState` is already the §2.4 cover enum, null = unknown). */
export interface Idg6RecertWindowFact {
  readonly nextRecertDueDate: string | null;
  readonly f2fWindowState: "not_due" | "window_open" | "overdue" | null;
}

/** The M6 recert/F2F window port (§2.4 cover): BATCHED + org-explicit + cron-callable. Patients with no live
 *  admission are absent from the map. */
export interface Idg6RecertWindowPort {
  recertWindowsForOrg(
    organizationId: string,
    patientIds: readonly string[],
    asOfIso: string,
  ): Promise<ReadonlyMap<string, Idg6RecertWindowFact>>;
}

/** One flagged-event fact as an owning module's org-explicit seam projects it (structural subset of
 *  `PacketFlaggedEventDigest`; validated again on this side — an unrecognised kind/severity/instant is dropped). */
export interface IdgFlaggedEventFact {
  readonly kind: string;
  readonly sourceId: string;
  readonly occurredAt: string;
  readonly severity: string;
}

/** One source of §2.4 flagged events (M6 hospital/ER, M13 missed dose, M30 fall/infection): BATCHED +
 *  org-explicit + cron-callable. `sinceIso` is the EARLIEST §1.1 cursor in the batch (a lower bound — the
 *  builder re-filters per patient). Patients with nothing are absent from the map. */
export interface IdgFlaggedEventSourcePort {
  /** Stable label for warnings (`m6.hospital`, `m13.missed_dose`, `m30.fall_infection`). */
  readonly source: string;
  flaggedEventsForOrg(
    organizationId: string,
    patientIds: readonly string[],
    sinceIso: string,
  ): Promise<ReadonlyMap<string, readonly IdgFlaggedEventFact[]>>;
}

/** One patient's HOPE context as M10's `idgHopeContextForOrg` projects it. */
export interface Idg10HopeContextFact {
  readonly upcomingTimepoints: ReadonlyArray<{
    readonly timepoint: string;
    readonly dueAt: string;
  }>;
  readonly openSfvCount: number;
}

/** One patient's external medication-history state as M12's `idgMedicationHistoryForOrg` projects it (F-230). */
export interface Idg12MedicationHistoryFact {
  readonly state: "not_pulled" | "none_available" | "available";
  readonly recordCount: number;
  readonly lastPulledAt: string | null;
}

/** The M12 external-medication-history port (F-230 `medicationHistory` slot): BATCHED + org-explicit. */
export interface Idg12MedicationHistoryPort {
  medicationHistoryForOrg(
    organizationId: string,
    patientIds: readonly string[],
  ): Promise<ReadonlyMap<string, Idg12MedicationHistoryFact>>;
}

/** The M10 HOPE-context port (§2.4 `hopeContext`): BATCHED + org-explicit + cron-callable. */
export interface Idg10HopeContextPort {
  hopeContextForOrg(
    organizationId: string,
    patientIds: readonly string[],
  ): Promise<ReadonlyMap<string, Idg10HopeContextFact>>;
}

const FLAGGED_KINDS: ReadonlySet<string> = new Set([
  "hospitalisation",
  "er_visit",
  "missed_dose",
  "fall",
  "infection",
  "triage_care_plan_change",
]);
const FLAGGED_SEVERITIES: ReadonlySet<string> = new Set(["info", "attention", "urgent"]);
const validInstant = (v: string): boolean => Number.isFinite(Date.parse(v));

/**
 * Resolve the flagged events for a meeting's candidate patients from every bound source. Never throws: a
 * source failure is reported through `warn` and that source contributes nothing. Facts are validated (known
 * kind + severity, a real instant, a non-empty id) and de-duplicated on `(kind, sourceId)`; each patient's
 * list is ordered oldest → newest.
 */
export async function resolveFlaggedEvents(
  sources: readonly IdgFlaggedEventSourcePort[] | undefined,
  organizationId: string,
  patientIds: readonly string[],
  sinceIso: string,
  warn: PacketBuildWarn,
): Promise<ReadonlyMap<string, readonly PacketFlaggedEventDigest[]>> {
  const out = new Map<string, PacketFlaggedEventDigest[]>();
  const ids = [...new Set(patientIds)];
  if (!sources || sources.length === 0 || ids.length === 0) return out;
  const seen = new Set<string>();
  for (const source of sources) {
    try {
      for (let i = 0; i < ids.length; i += 500) {
        const chunk = await source.flaggedEventsForOrg(
          organizationId,
          ids.slice(i, i + 500),
          sinceIso,
        );
        for (const [patientId, facts] of chunk) {
          for (const f of facts) {
            if (
              !FLAGGED_KINDS.has(f.kind) ||
              !FLAGGED_SEVERITIES.has(f.severity) ||
              !validInstant(f.occurredAt) ||
              f.sourceId.length === 0
            )
              continue;
            const key = `${patientId}|${f.kind}|${f.sourceId}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const list = out.get(patientId) ?? [];
            list.push({
              kind: f.kind as PacketFlaggedEventDigest["kind"],
              sourceId: f.sourceId,
              occurredAt: new Date(f.occurredAt).toISOString(),
              severity: f.severity as PacketFlaggedEventDigest["severity"],
            });
            out.set(patientId, list);
          }
        }
      }
    } catch (error) {
      warn("m14.packet_build.flagged_events_unavailable", {
        organizationId,
        source: source.source,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  for (const list of out.values())
    list.sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
  return out;
}

/**
 * Resolve the §2.4 `hopeContext` for a meeting's candidate patients. Never throws: no port, a seam error, or a
 * patient absent from the result ⇒ that patient's context is ABSENT (the caller stores `null` = "not captured").
 * Values are validated — a bad timepoint row is dropped, a negative/non-integer count becomes absent context.
 */
export async function resolveHopeContext(
  port: Idg10HopeContextPort | undefined,
  organizationId: string,
  patientIds: readonly string[],
  warn: PacketBuildWarn,
): Promise<ReadonlyMap<string, NonNullable<PacketSnapshot["hopeContext"]>>> {
  const out = new Map<string, NonNullable<PacketSnapshot["hopeContext"]>>();
  const ids = [...new Set(patientIds)];
  if (!port || ids.length === 0) return out;
  try {
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = await port.hopeContextForOrg(organizationId, ids.slice(i, i + 500));
      for (const [patientId, ctx] of chunk) {
        if (!Number.isInteger(ctx.openSfvCount) || ctx.openSfvCount < 0) continue;
        out.set(patientId, {
          upcomingTimepoints: ctx.upcomingTimepoints
            .filter((t) => t.timepoint.length > 0 && validInstant(t.dueAt))
            .map((t) => ({ timepoint: t.timepoint, dueAt: new Date(t.dueAt).toISOString() })),
          openSfvCount: ctx.openSfvCount,
        });
      }
    }
  } catch (error) {
    warn("m14.packet_build.hope_context_unavailable", {
      organizationId,
      error: error instanceof Error ? error.message : String(error),
    });
    return new Map();
  }
  return out;
}

/**
 * F-230 — resolve the packet's `medicationHistory` slot for a meeting's candidate patients from M12's seam.
 * Never throws: no port, a seam error, or a patient absent from the result ⇒ that patient's slot is ABSENT
 * (the caller stores `null` = "not captured" — NEVER a fabricated `none_available`). Values are validated: an
 * inconsistent fact (e.g. `available` with a zero count, a non-null instant on `not_pulled`) is dropped.
 */
export async function resolveMedicationHistory(
  port: Idg12MedicationHistoryPort | undefined,
  organizationId: string,
  patientIds: readonly string[],
  warn: PacketBuildWarn,
): Promise<ReadonlyMap<string, NonNullable<PacketSnapshot["medicationHistory"]>>> {
  const out = new Map<string, NonNullable<PacketSnapshot["medicationHistory"]>>();
  const ids = [...new Set(patientIds)];
  if (!port || ids.length === 0) return out;
  try {
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = await port.medicationHistoryForOrg(organizationId, ids.slice(i, i + 500));
      for (const [patientId, f] of chunk) {
        if (!Number.isInteger(f.recordCount) || f.recordCount < 0) continue;
        if (f.state === "not_pulled") {
          if (f.recordCount !== 0 || f.lastPulledAt !== null) continue;
          out.set(patientId, { state: "not_pulled", recordCount: 0, lastPulledAt: null });
        } else if (f.state === "none_available" || f.state === "available") {
          if (f.lastPulledAt === null || !validInstant(f.lastPulledAt)) continue;
          if ((f.state === "available") !== f.recordCount > 0) continue;
          out.set(patientId, {
            state: f.state,
            recordCount: f.recordCount,
            lastPulledAt: new Date(f.lastPulledAt).toISOString(),
          });
        }
      }
    }
  } catch (error) {
    warn("m14.packet_build.medication_history_unavailable", {
      organizationId,
      error: error instanceof Error ? error.message : String(error),
    });
    return new Map();
  }
  return out;
}

/** Cover facts resolved for one patient (both fields null = unknown). */
export interface PacketRecertCoverFacts {
  readonly nextRecertDueAt: string | null;
  readonly f2fWindowState: "not_due" | "window_open" | "overdue" | null;
}

const F2F_STATES = new Set(["not_due", "window_open", "overdue"]);
const YMD = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Resolve the recert cover facts for a meeting's candidate patients. Never throws: a port failure is
 * reported through `warn` and yields an empty map (every patient's fields stay null). Values are validated
 * — an unrecognised enum or a malformed date is dropped to null rather than passed through.
 */
export async function resolveRecertCoverFacts(
  port: Idg6RecertWindowPort | undefined,
  organizationId: string,
  patientIds: readonly string[],
  asOf: Date,
  warn: PacketBuildWarn,
): Promise<ReadonlyMap<string, PacketRecertCoverFacts>> {
  const out = new Map<string, PacketRecertCoverFacts>();
  if (!port || patientIds.length === 0) return out;
  const ids = [...new Set(patientIds)];
  const facts = new Map<string, Idg6RecertWindowFact>();
  try {
    // The seam caps a call at 500 patients (an IDG caseload is dozens) — chunk rather than fail a big org.
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = await port.recertWindowsForOrg(
        organizationId,
        ids.slice(i, i + 500),
        asOf.toISOString(),
      );
      for (const [k, v] of chunk) facts.set(k, v);
    }
  } catch (error) {
    warn("m14.packet_build.recert_windows_unavailable", {
      organizationId,
      error: error instanceof Error ? error.message : String(error),
    });
    return out;
  }
  for (const [patientId, f] of facts) {
    const date = f.nextRecertDueDate;
    out.set(patientId, {
      nextRecertDueAt: date !== null && YMD.test(date) ? `${date}T00:00:00.000Z` : null,
      f2fWindowState:
        f.f2fWindowState !== null && F2F_STATES.has(f.f2fWindowState) ? f.f2fWindowState : null,
    });
  }
  return out;
}

/** Structured warning sink (default: JSON line on stderr). */
export type PacketBuildWarn = (event: string, context: Record<string, unknown>) => void;

const defaultWarn: PacketBuildWarn = (event, context) => {
  console.warn(JSON.stringify({ level: "warn", event, ...context }));
};

export interface PacketBuildWorkerDeps {
  readonly db: DbClient;
  readonly outbox: IdgWriteOutboxPort;
  readonly redis: Redis;
  readonly m6: Idg6PacketPort;
  readonly m7: Idg7PacketPort;
  /** §2.4 cover recert/F2F facts (M6 `idgRecertWindowsForOrg`). Optional: unbound ⇒ the fields stay null. */
  readonly recertWindows?: Idg6RecertWindowPort;
  /** §2.4 `sinceLastIdg.flaggedEvents` sources (M6 hospital/ER, M13 missed dose, M30 fall/infection, M19 triage GIP proposal). Unbound ⇒ `[]`. */
  readonly flaggedEventSources?: readonly IdgFlaggedEventSourcePort[];
  /** §2.4 `hopeContext` (M10 `idgHopeContextForOrg`). Unbound ⇒ `null` (not captured). */
  readonly hope?: Idg10HopeContextPort;
  /** F-230 `medicationHistory` (M12 `idgMedicationHistoryForOrg`). Unbound ⇒ `null` (not captured). */
  readonly medicationHistory?: Idg12MedicationHistoryPort;
  /** M1 org/location display names for the packet PDF header. Unbound/failing ⇒ no names. */
  readonly siteDisplay?: IdgSiteDisplayPort;
  /** M2 batched staff display read (names only) for the carry-forward assignees. Unbound/failing ⇒ no names. */
  readonly membershipDisplay?: IdgMembershipDisplayPort;
  readonly activeOrgs: ActiveOrgListPort;
  now?: () => Date;
  readonly warn?: PacketBuildWarn;
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
  /** Carried onto `m14.packets.ready` for the M36 T-24h reminder (the expected-attendee roster is resolved there). */
  readonly scheduledStart: Date;
  readonly coordinatorMembershipId: string;
}

async function dueMeetingsForOrg(
  tx: DbClient,
  organizationId: string,
  now: Date,
): Promise<readonly DueMeeting[]> {
  const rows = await tx
    .select({
      id: MTG.id,
      locationId: MTG.locationId,
      status: MTG.status,
      version: MTG.version,
      scheduledStart: MTG.scheduledStart,
      coordinatorMembershipId: MTG.coordinatorMembershipId,
    })
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
    scheduledStart: r.scheduledStart,
    coordinatorMembershipId: r.coordinatorMembershipId,
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
  return row
    ? Math.max(row.days, POST_DISCHARGE_WRAP_UP_FLOOR_DAYS)
    : POST_DISCHARGE_WRAP_UP_FLOOR_DAYS;
}

/** §1.1 — the prior IDG's `adjourned_at` per patient: `MAX(last_idg_reviewed_at)` across every OTHER packet
 *  the patient has (M14-owned table, read directly — no seam needed), ONE query for the whole batch. A patient
 *  with no prior review is absent from the map (⇒ first IDG). */
async function priorIdgAdjournedAtForPatients(
  tx: DbClient,
  organizationId: string,
  patientIds: readonly string[],
  excludeMeetingId: string,
): Promise<ReadonlyMap<string, string>> {
  const out = new Map<string, string>();
  if (patientIds.length === 0) return out;
  const rows = await tx
    .select({
      patientId: PKT.patientId,
      meetingId: PKT.idgMeetingId,
      lastIdgReviewedAt: PKT.lastIdgReviewedAt,
    })
    .from(PKT)
    .where(and(eq(PKT.organizationId, organizationId), inArray(PKT.patientId, [...patientIds])));
  for (const r of rows) {
    if (r.meetingId === excludeMeetingId || r.lastIdgReviewedAt === null) continue;
    const iso = new Date(r.lastIdgReviewedAt).toISOString();
    const prior = out.get(r.patientId);
    if (prior === undefined || iso > prior) out.set(r.patientId, iso);
  }
  return out;
}

/** §2.4 `carryForwardActionItems` / §2.7 — per patient, the `open`/`in_progress` action items from OTHER
 *  meetings whose `due_date` is past `asOf` (an item with no due date cannot be overdue). M14's own table, ONE
 *  query for the batch. `carryForwardCount` is the stored `meeting_carry_forward_count` (the `idg.carry-forward`
 *  cron, `./carry-forward.ts`, is the only writer). Oldest due first. */
export async function carryForwardForPatients(
  tx: DbClient,
  organizationId: string,
  patientIds: readonly string[],
  excludeMeetingId: string,
  asOf: Date,
): Promise<ReadonlyMap<string, readonly PacketActionItemCarryForwardDigest[]>> {
  const out = new Map<string, PacketActionItemCarryForwardDigest[]>();
  if (patientIds.length === 0) return out;
  const rows = await tx
    .select({
      id: ACT.id,
      patientId: ACT.patientId,
      assignedToMembershipId: ACT.assignedToMembershipId,
      dueDate: ACT.dueDate,
      count: ACT.meetingCarryForwardCount,
    })
    .from(ACT)
    .where(
      and(
        eq(ACT.organizationId, organizationId),
        inArray(ACT.patientId, [...patientIds]),
        inArray(ACT.status, ["open", "in_progress"] as never),
        ne(ACT.idgMeetingId, excludeMeetingId),
        lt(ACT.dueDate, asOf),
      ),
    )
    .orderBy(ACT.dueDate);
  for (const r of rows) {
    if (r.patientId === null || r.dueDate === null) continue;
    const list = out.get(r.patientId) ?? [];
    list.push({
      actionItemId: r.id as never,
      assignedToMembershipId: r.assignedToMembershipId as never,
      dueDate: new Date(r.dueDate).toISOString(),
      carryForwardCount: r.count,
    });
    out.set(r.patientId, list);
  }
  return out;
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

// Every `withOrgContext` call below stamps `userId: ""`, never a synthetic worker uuid — the F-102
// `CONSUMER_USER_ID` convention (also `idg-route-service-db.ts`'s own `withOrg` helper): `idg_meeting`/
// `idg_patient_packet` carry the M4 write-audit trigger, which resolves `app.user_id` to `actor_user_id`
// through a real FK into `"user"` — a fabricated-looking sentinel UUID with no matching row throws 23503
// on every write (caught live, writing this file's own test), while the empty-string GUC sentinel maps to
// a NULL actor, correctly describing "the system, not a person, made this change".

/** One per-patient build outcome — either a built packet id, or a reported (never fabricated) reason. */
type PatientBuildResult =
  | {
      readonly ok: true;
      readonly packetId: string;
      readonly patientId: string;
      readonly snapshot: PacketSnapshot;
      readonly disciplineViews: Record<DisciplineKey, DisciplineViewBlock>;
    }
  | { readonly ok: false; readonly patientId: string; readonly reason: string };

/** The per-patient facts `processDueMeeting` resolves for the WHOLE meeting in batched reads. */
interface PatientPacketExtras {
  /** The prior IDG's `adjourned_at` for this patient (`null` ⇒ first IDG). */
  readonly priorIdgAdjournedAt: string | null;
  /** Flagged events already fetched from every source (the builder applies the per-patient cursor filter). */
  readonly flaggedEvents: readonly PacketFlaggedEventDigest[];
  /** `null` ⇒ HOPE context not captured (unbound / failed seam). */
  readonly hopeContext: PacketSnapshot["hopeContext"];
  /** F-230 — `null` ⇒ external medication history not captured (unbound / failed seam). */
  readonly medicationHistory: PacketSnapshot["medicationHistory"];
  readonly carryForward: readonly PacketActionItemCarryForwardDigest[];
  /** Header names for the M22 render payload (per meeting, NOT stored in the snapshot). */
  readonly site: PacketSiteNames;
  /** Meeting-wide membership id -> display name (a superset; filtered per patient to the redacted snapshot). */
  readonly memberNames: ReadonlyMap<string, string>;
}

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
  recert: PacketRecertCoverFacts | undefined,
  extras: PatientPacketExtras,
): Promise<PatientBuildResult> {
  const fail = (reason: string): PatientBuildResult => ({
    ok: false,
    patientId: candidate.patientId,
    reason,
  });
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

    const priorIdgAdjournedAt = extras.priorIdgAdjournedAt;
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
      flaggedEvents: extras.flaggedEvents, // M6/M13/M30 seams, resolved per meeting — see file header
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
      nextRecertDueAt: recert?.nextRecertDueAt ?? null, // M6 seam, snapshotted at freeze — see file header
      f2fWindowState: recert?.f2fWindowState ?? null, // M6 seam, snapshotted at freeze — see file header
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
      hopeContext: extras.hopeContext, // M10 seam, resolved per meeting — see file header
      medicationHistory: extras.medicationHistory ?? null, // M12 seam (F-230), resolved per meeting
      carryForwardActionItems: extras.carryForward, // M14's own idg_action_item — see file header
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
            // Names ride the render payload ONLY (never the frozen `built_snapshot`); re-derived at every emit.
            // `memberNames` is filtered to the assignees of the REDACTED snapshot, so a Part 2-elided item is
            // never named.
            renderPayload: {
              snapshot,
              disciplineViews,
              ...buildPacketRenderContext(snapshot, {
                meetingId,
                locationId,
                site: extras.site,
                names: extras.memberNames,
              }),
            },
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
  const wrapUpDays = await withOrgContext(deps.db, { organizationId, userId: "" }, (tx) =>
    wrapUpDaysForLocation(tx as unknown as DbClient, organizationId, meeting.locationId),
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

  const recertFacts = await resolveRecertCoverFacts(
    deps.recertWindows,
    organizationId,
    candidates.map((c) => c.patientId),
    now,
    deps.warn ?? defaultWarn,
  );

  // ── §2.4 batched per-meeting reads: the §1.1 cursor per patient (one M14 query), then flagged events (M6/M13/
  // M30), HOPE context (M10) and carry-forward (M14) — each ONE round-trip per source for the whole caseload.
  const warn = deps.warn ?? defaultWarn;
  const patientIds = candidates.map((c) => c.patientId);
  const [priorByPatient, carryForwardByPatient] = await withOrgContext(
    deps.db,
    { organizationId, userId: "" },
    async (txRaw) => {
      const tx = txRaw as unknown as DbClient;
      const prior = await priorIdgAdjournedAtForPatients(
        tx,
        organizationId,
        patientIds,
        meeting.meetingId,
      );
      const carry = await carryForwardForPatients(
        tx,
        organizationId,
        patientIds,
        meeting.meetingId,
        now,
      );
      return [prior, carry] as const;
    },
  );
  const cursorOf = (c: Idg6PacketInclusionCandidate): string =>
    resolveSinceCursor(priorByPatient.get(c.patientId) ?? null, c.activatedAtIso).sinceCursorIso;
  const earliestCursor =
    candidates.length === 0
      ? now.toISOString()
      : candidates.map(cursorOf).reduce((a, b) => (Date.parse(a) <= Date.parse(b) ? a : b));
  const flaggedByPatient = await resolveFlaggedEvents(
    deps.flaggedEventSources,
    organizationId,
    patientIds,
    earliestCursor,
    warn,
  );
  const hopeByPatient = await resolveHopeContext(deps.hope, organizationId, patientIds, warn);
  const medHistoryByPatient = await resolveMedicationHistory(
    deps.medicationHistory,
    organizationId,
    patientIds,
    warn,
  );

  // Display names for the PDF (org/location header + carry-forward assignees) — resolved here, ONCE per meeting,
  // outside any tenant tx (the ports open their own). Failures degrade to no names.
  const site = await resolvePacketSiteNames(
    deps.siteDisplay,
    organizationId,
    meeting.locationId,
    warn,
  );
  const memberNames = await resolveMemberNames(
    deps.membershipDisplay,
    organizationId,
    [...carryForwardByPatient.values()].flatMap((items) =>
      items.map((i) => i.assignedToMembershipId as string),
    ),
    warn,
  );

  let builtCount = 0;
  for (const candidate of candidates) {
    const result = await buildOnePatientPacket(
      deps,
      organizationId,
      meeting.meetingId,
      meeting.locationId,
      candidate,
      now,
      recertFacts.get(candidate.patientId),
      {
        priorIdgAdjournedAt: priorByPatient.get(candidate.patientId) ?? null,
        flaggedEvents: flaggedByPatient.get(candidate.patientId) ?? [],
        hopeContext: hopeByPatient.get(candidate.patientId) ?? null,
        medicationHistory: medHistoryByPatient.get(candidate.patientId) ?? null,
        carryForward: carryForwardByPatient.get(candidate.patientId) ?? [],
        site,
        memberNames,
      },
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
          // NO automatic retry: the meeting still flips `packets_building → packets_ready` below (spec §2.2/§1435 —
          // one bad patient must not hold the whole IDG meeting hostage past its T-24h window), so the next tick
          // does NOT re-select it. Recovery is the coordinator's on-demand `POST /meetings/:id/packets/build`
          // (idempotent on `(meeting_id, patient_id)`, spec §1215 `willRetry=false` DLQ semantics). SPEC AMBIGUITY
          // flagged: §1435 says "once all per-patient jobs complete" -> ready, §1197/§1215 give the per-patient
          // retry to the queue's own attempts (not modelled here); this worker builds inline, so a failure is final.
          willRetry: false,
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
        // The M36 reminder consumer's inputs (it resolves the expected attendees from the location itself).
        locationId: meeting.locationId,
        scheduledStart: meeting.scheduledStart.toISOString(),
        coordinatorMembershipId: meeting.coordinatorMembershipId,
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
      const due = await withOrgContext(deps.db, { organizationId, userId: "" }, (tx) =>
        dueMeetingsForOrg(tx as unknown as DbClient, organizationId, now),
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
