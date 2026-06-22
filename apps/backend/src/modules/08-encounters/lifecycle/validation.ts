// apps/backend/src/modules/08-encounters/lifecycle/validation.ts — M8-T04 (§2.7).
//
// §2.7 has two kinds of rule: SYNCHRONOUS (run inside the service before/within the optimistic-locked
// transaction, raise an inline `EncounterStateError` with the §2.7 code) and ASYNC (the cosignature SLA
// chain + late-entry-override compliance surfaces, raised as `m8.*` outbox events for M30/M33/M36 to act
// on in their own domains). This module ships the synchronous catalog as pure validators the §2.3
// machine composes, plus the async catalog as data (the events the transitions emit). No IO: every fact
// a rule needs (org-timezone "today", the M5 caseload check, the M38 active vocab version, the M15
// volunteer-assignment lookup) is resolved by the caller and passed in as a boolean/value — M8 never
// imports another module's schema (§2.8).
import {
  EncounterStateError,
  type M8ErrorCode,
  require_,
} from "./errors";
import {
  type EncounterDiscipline,
  type EncounterStatus,
  type EncounterType,
  type LateEntryTier,
  type LocalDate,
  isValidEncounterDisciplinePair,
} from "@wardenx/types";

// ── §2.7 thresholds (the free-text minimums + the D13 step-up freshness window) ─────────────────────

/** Minimum free-text lengths the §2.5/§2.7 guards enforce. */
export const TEXT_MINIMUMS = {
  /** §2.5 late-entry / significant-late-entry reason. */
  lateEntryReason: 40,
  /** §2.3 admin void reason. */
  voidReason: 40,
  /** §2.5 significant-late-entry (3–14d) Clinical Supervisor override reason (also a DB CHECK). */
  significantLateOverrideReason: 40,
  /** §2.5 administrative-override (>14d) reason (also a DB CHECK). */
  administrativeOverrideReason: 100,
  /** §2.7 D9 EVV-missing documented reason. */
  evvMissingReason: 20,
  /** §2.4 D3 cosignature 48h-hard-cap supervisor-release reason (also a DB CHECK). */
  supervisorReleaseReason: 40,
} as const;

/** §2.7 D13 — a sign requires step-up auth no older than 5 minutes. */
export const STEP_UP_MAX_AGE_SECONDS = 300;

/** The disciplines whose primary signature routes the encounter into `cosign_pending` (§2.3). */
export const COSIGN_REQUIRED_DISCIPLINES: ReadonlyArray<EncounterDiscipline> = ["lpn", "chha"];

/** §2.5 — late-entry tiers that demand a `late_entry_reason` ≥ 40 chars at sign. */
const LATE_ENTRY_REASON_TIERS: ReadonlyArray<LateEntryTier> = [
  "late_entry",
  "significant_late_entry",
  "administrative_override",
];

// ── §2.7 async rule catalog (data — surfaced via the named `m8.*` outbox event, never a sync block) ──

/** The §2.7 async rules: the outbox event each raises for a downstream module to act on. */
export const ASYNC_VALIDATION_EVENTS = {
  "cosignature.overdue_12h": "m36",
  "cosignature.escalated_24h": "m36",
  "cosignature.hard_cap_48h": "m36",
  "encounter.administrative_override": "m30",
  "encounter.orphan": "m33",
} as const;

// ── Pure calendar helper (LocalDate `yyyy-mm-dd`; UTC math avoids DST drift; mirrors M6) ────────────

/** Whole calendar days from `a` to `b` (b - a). Negative when `b` precedes `a`. */
export function daysBetween(a: LocalDate, b: LocalDate): number {
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

// ── §2.7 synchronous validators (each raises the catalogued code on failure) ────────────────────────

/** §2.7 — `(encounter_type × discipline)` must be a legal §2.2 pair (also a DB CHECK). */
export function checkEncounterDisciplinePair(input: {
  encounterType: EncounterType;
  discipline: EncounterDiscipline;
}): void {
  require_(
    isValidEncounterDisciplinePair(input.encounterType, input.discipline),
    "INVALID_ENCOUNTER_DISCIPLINE_PAIR",
    `discipline '${input.discipline}' may not author a '${input.encounterType}' encounter`,
  );
}

/** §2.7 — `service_date` must not be in the future (org timezone "today" resolved upstream). */
export function checkServiceDateNotFuture(input: { serviceDate: LocalDate; today: LocalDate }): void {
  require_(
    daysBetween(input.serviceDate, input.today) >= 0,
    "SERVICE_DATE_IN_FUTURE",
    "service_date is in the future",
  );
}

/** §2.7 — `service_date` must be ≥ the patient's admission activation date. */
export function checkServiceDateAfterAdmission(input: {
  serviceDate: LocalDate;
  admissionActivationDate: LocalDate;
}): void {
  require_(
    daysBetween(input.admissionActivationDate, input.serviceDate) >= 0,
    "SERVICE_DATE_BEFORE_ADMISSION",
    "service_date precedes the patient's admission activation date",
  );
}

/** §2.5/§2.7 — tiers ≥ `late_entry` require a `late_entry_reason` ≥ 40 chars. */
export function checkLateEntryReason(input: { tier: LateEntryTier; reason: string | null }): void {
  if (!LATE_ENTRY_REASON_TIERS.includes(input.tier)) return;
  require_(
    (input.reason?.trim().length ?? 0) >= TEXT_MINIMUMS.lateEntryReason,
    "LATE_ENTRY_REASON_REQUIRED",
    `late entry (tier '${input.tier}') requires a reason ≥ ${TEXT_MINIMUMS.lateEntryReason} characters`,
  );
}

/**
 * §2.7 — a volunteer encounter must reference an active `volunteer_assignment` (the M15 reader; Phase 1
 * deny-stub resolves `hasActiveVolunteerAssignment=false`). The validator is pure: the service decides
 * what the seam returns. Non-volunteer encounter types are unaffected.
 */
export function checkVolunteerAssignment(input: {
  encounterType: EncounterType;
  hasActiveVolunteerAssignment: boolean;
}): void {
  if (input.encounterType !== "volunteer_visit") return;
  require_(
    input.hasActiveVolunteerAssignment,
    "NO_VOLUNTEER_ASSIGNMENT",
    "a volunteer encounter must reference an active volunteer_assignment",
  );
}

/** §2.7 D11 — the pinned vocab version must equal the active M38 version at finalize-time. */
export function checkVocabVersion(input: { pinnedVersionId: string; activeVersionId: string }): void {
  require_(
    input.pinnedVersionId === input.activeVersionId,
    "VOCAB_VERSION_MISMATCH",
    "the pinned vocabulary version is no longer the active M38 version",
  );
}

/** §2.7 D13 — sign requires a step-up auth no older than {@link STEP_UP_MAX_AGE_SECONDS}. */
export function checkStepUpFresh(input: { stepUpAgeSeconds: number | null }): void {
  require_(
    input.stepUpAgeSeconds !== null && input.stepUpAgeSeconds <= STEP_UP_MAX_AGE_SECONDS,
    "STEP_UP_AUTH_REQUIRED",
    `sign requires a step-up auth ≤ ${STEP_UP_MAX_AGE_SECONDS}s old`,
  );
}

/** §2.7 D1 — an F2F encounter requires `face_to_face_encounter_id` (M6) populated in the same tx. */
export function checkF2fDualWrite(input: { isF2f: boolean; faceToFaceEncounterIdPresent: boolean }): void {
  if (!input.isF2f) return;
  require_(
    input.faceToFaceEncounterIdPresent,
    "F2F_DUAL_WRITE_REQUIRED",
    "an F2F encounter requires the M6 face_to_face_encounter_id in the same transaction",
  );
}

/** §2.3 gate check 10 — for LPN/CHHA a cosignature-eligible RN must exist on the caseload (M5). */
export function checkEligibleCosignerExists(input: {
  discipline: EncounterDiscipline;
  eligibleCosignerExists: boolean;
}): void {
  if (!COSIGN_REQUIRED_DISCIPLINES.includes(input.discipline)) return;
  require_(
    input.eligibleCosignerExists,
    "NO_ELIGIBLE_COSIGNER",
    "no cosignature-eligible RN exists on the patient's caseload",
  );
}

/** §2.7 — the cosigner must hold `encounter.cosign`, be an RN, and be on the patient's caseload. */
export function checkCosignerEligibility(input: {
  hasCosignPermission: boolean;
  isRn: boolean;
  onCaseload: boolean;
}): void {
  require_(
    input.hasCosignPermission && input.isRn && input.onCaseload,
    "NOT_COSIGN_ELIGIBLE",
    "cosigner must hold encounter.cosign, be an RN, and be on the patient's caseload",
  );
}

/** §2.7 — an addendum cannot be created on a `voided` encounter. */
export function checkParentNotVoided(input: { parentStatus: EncounterStatus }): void {
  require_(
    input.parentStatus !== "voided",
    "PARENT_VOIDED",
    "cannot author an addendum on a voided encounter",
  );
}

/** §2.7 — optimistic concurrency: the `If-Match` version must equal the row's current version. */
export function checkVersion(input: { expected: number; actual: number }): void {
  require_(
    input.expected === input.actual,
    "VERSION_MISMATCH",
    `version mismatch: expected ${input.expected}, row is at ${input.actual}`,
  );
}

/** §2.7 — a `signed`/`cosigned`/`voided` row is immutable; the only edits are via `encounter_addendum`. */
export function checkMutableForEdit(input: { status: EncounterStatus }): void {
  const sealed: ReadonlyArray<EncounterStatus> = ["signed", "cosign_pending", "cosigned", "voided"];
  if (sealed.includes(input.status)) {
    throw new EncounterStateError(
      "IMMUTABLE_AFTER_SIGN",
      `encounter is '${input.status}'; edits are only permitted via an addendum`,
    );
  }
}

/** Re-export the code type so the service layer can narrow without importing `errors` directly. */
export type { M8ErrorCode };
