// apps/backend/src/modules/14-idg/routes/service.ts — M14-T05 the §4.1 route service over an in-memory
// backend (the M8-T09 / M9-T05 / M10-T06 / M11-T06 / M12-T08 / M13-T08 in-mem-slice precedent; Drizzle in prod
// under `withOrgContext` so RLS backstops every read). The service composes the PURE M14 domain (`@wardenx/idg`):
// the §2.2 meeting state machine (`transitionMeeting`), the §2.7 decision record/supersede deciders
// (`planDecisionRecord` / `planDecisionSupersede`), the §1.1/D8 action-item machine (`transitionActionItem` /
// `planActionItemCreate`), and the §2.6 minutes-amendment decider — and emits the §4.4 outbox events the relay
// publishes (drainable for tests).
//
// This service ALSO implements {@link IdgAbacResolver} so the §4.7 predicates (`idg_meeting_scope` /
// `quorate_decision` / `per_patient_review_floor_clear`) resolve over the same dataset (M12/M13-T08 precedent:
// the backend is both the route service and the ABAC resolver).
import {
  DISCIPLINE_NOTE_ADDENDUM_WINDOW_DAYS,
  evaluateQuorum,
  planActionItemCreate,
  planDecisionRecord,
  planDecisionSupersedeInto,
  planDecisionUpdate,
  planMeetingScheduled,
  planMinutesAmendmentRequest,
  transitionActionItem,
  transitionMeeting,
} from "@wardenx/idg";
import type {
  IdgActionItemLinkedKind,
  IdgActionItemStatus,
  IdgAgendaItemKind,
  IdgAttendanceStatus,
  IdgDecisionKind,
  IdgDecisionRecordedPayload,
  IdgDecisionStatus,
  IdgMeetingStatus,
  QuorumSnapshot,
} from "@wardenx/types";
import { ForbiddenError, NotFoundError, ValidationError, WardenXError } from "@wardenx/types";
import type { IdgAbacResolver, MeetingScopeFacts, ReviewFloorBreachFact } from "../abac-predicates";
import { type PacketContentView, mapPacketContent } from "./packet-content";

// ── §4.4 outbox events the service records (the relay wraps them in the M1 envelope) ────────────────────
export interface RecordedIdgEvent {
  readonly eventName: string;
  readonly payload: Record<string, unknown>;
}

// ── view DTOs (read projections; never the raw Drizzle row) ──────────────────────────────────────────────
export interface MeetingView {
  readonly id: string;
  readonly organizationId: string;
  readonly locationId: string;
  readonly status: IdgMeetingStatus;
  readonly scheduledStart: string;
  readonly scheduledEnd: string;
  readonly adjournedAt: string | null;
  /** The meeting's IDG coordinator (M1 membership id — resolve the display name via `GET /orgs/{id}/members`). */
  readonly coordinatorMembershipId: string;
}
export interface AttendanceView {
  readonly id: string;
  readonly meetingId: string;
  readonly membershipId: string;
  readonly discipline: string;
  readonly status: IdgAttendanceStatus;
  readonly checkedInAt: string;
  /** True when a coordinator ATTESTED a discipline the member's roles do not confer (0286). Legacy rows: false. */
  readonly disciplineAttested: boolean;
  /** Who wrote the row; null for a legacy (pre-0286) row. */
  readonly recordedByMembershipId: string | null;
  /** GAP-127 — the row version a PATCH/DELETE echoes back as `If-Match`. */
  readonly version: number;
}
export interface AgendaItemView {
  readonly id: string;
  readonly meetingId: string;
  readonly kind: IdgAgendaItemKind;
  readonly patientId: string | null;
  /** GAP-127 — the row version a PATCH/DELETE echoes back as `If-Match`. */
  readonly version: number;
}
/**
 * F-234 — a downstream module's acknowledgement that it APPLIED an emitted decision (`idg_decision_application_ack`).
 * Metadata only: which module, the plan/version it landed on, how many mutations, when. Populated on the
 * decision LIST read only; absent on the POST/PATCH echoes and null/empty until a module acknowledges.
 */
export interface DecisionApplicationView {
  readonly module: "m15";
  readonly planId: string | null;
  readonly versionId: string | null;
  readonly mutationsApplied: number;
  readonly acknowledgedAt: string;
}
export interface DecisionView {
  readonly id: string;
  readonly meetingId: string;
  readonly patientId: string | null;
  readonly agendaItemId: string | null;
  readonly decisionKind: IdgDecisionKind;
  readonly status: IdgDecisionStatus;
  readonly wasQuorate: boolean;
  readonly recordedByMembershipId: string;
  readonly recordedAt: string;
  readonly supersededByDecisionId: string | null;
  /** Optimistic-concurrency token: the PATCH must echo it in `If-Match`; every edit bumps it. */
  readonly version: number;
  /** F-234 — downstream "applied" acknowledgements (list read only). */
  readonly applications?: readonly DecisionApplicationView[];
}
export interface ActionItemView {
  readonly id: string;
  readonly meetingId: string;
  readonly decisionId: string | null;
  readonly patientId: string | null;
  readonly assignedToMembershipId: string;
  readonly status: IdgActionItemStatus;
  readonly dueDate: string;
  readonly linkedArtifactKind: IdgActionItemLinkedKind | null;
  /** F-104 — the D8 auto-close key, previously absent from the view as well as from the write path. */
  readonly linkedArtifactId: string | null;
  /** GAP-127 — the row version a PATCH/DELETE echoes back as `If-Match`. */
  readonly version: number;
}
/**
 * A meeting's minutes (GET /idg/meetings/:id/minutes).
 *
 * COUNTS, not the snapshots themselves. `idg_minutes` freezes `attendance_snapshot` /
 * `decision_list_snapshot` / `action_item_list_snapshot` at finalize, and those nest the decision
 * PAYLOADS — the §3.3 denylisted clinical narrative. Publishing them would reopen the W-SUD-01
 * redaction question this module's read surface is deliberately built to avoid (see
 * {@link PatientIdgHistoryView}: "PHI-safe by construction … never the denylisted packet cover
 * summaries, decision payloads, or item body text"). The counts plus the finalize attribution are
 * what a minutes SCREEN needs — the readable document is the M22 render at `minutesDocumentId`,
 * which is the designed delivery path for the narrative and carries its own consent gate.
 *
 * `closingNote` is likewise withheld: it is a DENYLISTED free-text column (§3.3).
 */
export type MinutesRenderStatus = "not_rendered" | "pending" | "rendered";

/** Pure derivation of {@link MinutesView.renderStatus}. */
export function minutesRenderStatus(
  status: "in_progress" | "final",
  minutesDocumentId: string | null,
): MinutesRenderStatus {
  if (minutesDocumentId !== null) return "rendered";
  return status === "final" ? "pending" : "not_rendered";
}

export interface MinutesView {
  readonly id: string;
  readonly meetingId: string;
  readonly status: "in_progress" | "final";
  readonly finalizedAt: string | null;
  readonly finalizedByMembershipId: string | null;
  /** M22 rendered-PDF back-ref; null until the render lands. */
  readonly minutesDocumentId: string | null;
  /**
   * Where the M22 render of these minutes stands, derived from real data (never guessed):
   * `not_rendered` — still `in_progress`, nothing frozen so nothing to render; `pending` — `final` and the
   * `m14.minutes.signed` render request is in flight (no `minutesDocumentId` yet); `rendered` — the M22
   * back-ref is stamped. A `final` row that stays `pending` means the render is failing/retrying upstream.
   */
  readonly renderStatus: MinutesRenderStatus;
  /** The finalizer's discipline as recorded on THIS meeting's frozen attendance snapshot, when they attended. */
  readonly finalizedByDiscipline: string | null;
  /** Snapshot sizes — null while `in_progress` (nothing is frozen yet). */
  readonly attendanceCount: number | null;
  readonly decisionCount: number | null;
  readonly actionItemCount: number | null;
  /**
   * Discipline notes frozen at adjournment — a COUNT, like the other snapshots (the text is read through
   * `GET /idg/meetings/:id/discipline-notes`, which applies Part 2 redaction per caller). Null while `in_progress`.
   */
  readonly disciplineNoteCount: number | null;
  /**
   * LATE ADDENDA recorded after adjournment — a LIVE count of `idg_discipline_note` rows with `is_addendum`
   * (NOT read from the frozen snapshot, which never changes after adjournment). Count only: the text is read
   * through `GET .../discipline-notes` with the same Part 2 redaction. 0 while `in_progress`.
   */
  readonly disciplineAddendumCount: number;
  /**
   * Whether a LATE ADDENDUM can still be recorded on this meeting, so a UI can show why not without provoking a 422.
   * See {@link AddendumState}. Derived per read (server clock + live meeting data), never stored.
   */
  readonly addendumState: AddendumState;
}
/**
 * Late-addendum eligibility of a meeting (WINDOW B). `open` = the meeting is ADJOURNED and within
 * {@link DISCIPLINE_NOTE_ADDENDUM_WINDOW_DAYS} days of `actual_end` (`closesAt` = that boundary; null when not adjourned).
 * `closedReason` is `window_elapsed` exactly when the adjourned meeting is past the window, else null (a meeting that is
 * not adjourned takes ordinary notes/none, so it has no closed reason). `supersededPatientIds` are the patients of THIS
 * meeting for whom a later ADJOURNED IDG exists: patient-scoped addenda for them are refused
 * (`ADDENDUM_SUPERSEDED_BY_NEWER_IDG`) even while `open`; meeting-level addenda are unaffected. Empty unless `open`.
 */
export interface AddendumState {
  readonly open: boolean;
  readonly closesAt: string | null;
  readonly closedReason: "window_elapsed" | null;
  readonly supersededPatientIds: readonly string[];
}
/** Pure derivation of {@link AddendumState} from the meeting facts. */
export function deriveAddendumState(input: {
  readonly status: string;
  readonly adjournedAt: Date | null;
  readonly now: Date;
  readonly supersededPatientIds: readonly string[];
}): AddendumState {
  if (input.status !== "adjourned" || input.adjournedAt === null) {
    return { open: false, closesAt: null, closedReason: null, supersededPatientIds: [] };
  }
  const closes = new Date(
    input.adjournedAt.getTime() + DISCIPLINE_NOTE_ADDENDUM_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  );
  const open = input.now.getTime() <= closes.getTime();
  return {
    open,
    closesAt: closes.toISOString(),
    closedReason: open ? null : "window_elapsed",
    supersededPatientIds: open ? [...input.supersededPatientIds].sort() : [],
  };
}
/**
 * One per-discipline meeting note (`idg_discipline_note`). `patientId` null = a meeting-level note for that
 * discipline. `bodyText` is free-text PHI: for a patient carrying an active SUD flag (or one the packet cannot
 * vouch for) the READ elides it for a caller without a Part 2 release — `bodyText: null` +
 * `bodyWithheld: true` (fail-closed; the metadata still shows that a note exists). The POST/PATCH echo returns
 * the text the caller just submitted. `authorName` is attached by the route (membership-display seam).
 */
export interface DisciplineNoteView {
  readonly id: string;
  readonly meetingId: string;
  readonly patientId: string | null;
  readonly discipline: string;
  readonly bodyText: string | null;
  readonly bodyWithheld: boolean;
  readonly authorMembershipId: string;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** True for a LATE ADDENDUM (written after the meeting was adjourned; append-only, outside the frozen snapshot). */
  readonly isAddendum: boolean;
  /** Server time the addendum was recorded (== `createdAt`); null for an original (live) note. */
  readonly addendumRecordedAt: string | null;
  /**
   * The note's `reason` (free-text PHI, ≤500): OPTIONAL context on any note, REQUIRED on a late addendum. Withheld
   * (null) under Part 2 exactly when `bodyText` is; null when none was given.
   */
  readonly reason: string | null;
}
/** The acting principal of a note write: the membership + whether it holds `idg.coordinate` (any-discipline). */
export interface DisciplineNoteActor {
  readonly membershipId: string;
  readonly isCoordinator: boolean;
}
export interface CreateDisciplineNoteArgs {
  /** Null/absent = a meeting-level note; otherwise the patient MUST be on the meeting's agenda/packet set. */
  readonly patientId?: string | null;
  readonly discipline: string;
  readonly bodyText: string;
  /** Optional context (≤500; blank/whitespace = absent) on a live note; REQUIRED non-blank when the meeting is adjourned (=> a late addendum). */
  readonly reason?: string | null;
}
/** The per-discipline notes a meeting's minutes froze at adjournment (only for the M22 render payload). */
export interface DisciplineNoteSnapshotEntry {
  readonly noteId: string;
  readonly patientId: string | null;
  readonly discipline: string;
  readonly bodyText: string | null;
  readonly bodyWithheld: boolean;
  /** Optional per-note reason; elided (null) exactly when `bodyText` is (same fail-closed Part 2 rule). */
  readonly reason: string | null;
  readonly authorMembershipId: string;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}
/** Partial edit of a live original note: at least one of the two. `reason: null` (or blank) clears it. */
export interface DisciplineNotePatch {
  readonly bodyText?: string;
  readonly reason?: string | null;
}

/**
 * One entry of the minutes render's 'Addenda' appendix (`renderPayload.disciplineAddenda` on
 * `m14.discipline_note.addendum_recorded` / `m14.minutes.amended`), built from live addendum rows. Text and
 * reason are null + `bodyWithheld` for a patient whose text must be withheld (42 CFR Part 2), exactly like
 * {@link DisciplineNoteSnapshotEntry}. `authorName` is the M2 display name only (null when unresolvable).
 */
export interface DisciplineAddendumRenderEntry {
  readonly noteId: string;
  readonly patientId: string | null;
  readonly discipline: string;
  readonly authorMembershipId: string;
  readonly authorName: string | null;
  readonly recordedAt: string;
  readonly reason: string | null;
  readonly bodyText: string | null;
  readonly bodyWithheld: boolean;
}

/** Statuses of an attendance row that count as "in the room" for writing a discipline note. */
export const NOTE_PRESENT_STATUSES: readonly IdgAttendanceStatus[] = [
  "present",
  "tardy",
  "partial",
];

/** GAP-127 — 403: an action item may be moved only by its assignee or a coordinator. */
export function actionItemNotAssigneeError(): ForbiddenError {
  return new ForbiddenError("only the assignee or an IDG coordinator may update this action item");
}
/** GAP-127 — 409: an action item of an adjourned meeting is part of the closed record and cannot be removed. */
export function actionItemMeetingAdjournedError(): WardenXError {
  return new WardenXError(
    "MEETING_ADJOURNED",
    "the meeting is adjourned: its action items can no longer be removed",
    409,
  );
}
/** The 422 for a note write on a meeting that is neither `live` nor (in-window) `adjourned`. */
export function noteMeetingNotLiveError(): WardenXError {
  return new WardenXError(
    "MEETING_NOT_LIVE",
    "discipline notes may only be written while the meeting is live, or as a late addendum after it is adjourned",
    422,
  );
}
/** The 422 for an edit of a note that is FROZEN (original note of an adjourned meeting) or of a non-live meeting. */
export function noteFrozenError(): WardenXError {
  return new WardenXError(
    "MEETING_NOT_LIVE",
    "the meeting is no longer live: its notes are frozen; record a late addendum instead",
    422,
  );
}
/** The 422 for a PATCH of a late addendum (append-only; a correction is a further addendum). */
export function addendumImmutableError(): WardenXError {
  return new WardenXError(
    "ADDENDUM_IMMUTABLE",
    "a late addendum cannot be edited; record a further addendum to correct it",
    422,
  );
}
/** The 422 for an addendum attempted after {@link DISCIPLINE_NOTE_ADDENDUM_WINDOW_DAYS} days past adjournment. */
export function addendumWindowClosedError(): WardenXError {
  return new WardenXError(
    "ADDENDUM_WINDOW_CLOSED",
    `late addenda are only accepted within ${DISCIPLINE_NOTE_ADDENDUM_WINDOW_DAYS} days of adjournment`,
    422,
  );
}
/** The 422 for an addendum without a (non-blank) reason. */
export function addendumReasonRequiredError(): WardenXError {
  return new WardenXError("ADDENDUM_REASON_REQUIRED", "a late addendum requires a reason", 422);
}
/** The 422 for a patient-scoped addendum when a NEWER ADJOURNED IDG meeting has included that patient (WINDOW B). */
export function addendumSupersededError(): WardenXError {
  return new WardenXError(
    "ADDENDUM_SUPERSEDED_BY_NEWER_IDG",
    "a late addendum for this patient is no longer accepted: a more recent IDG meeting that included the patient has since been adjourned; record the note in the patient's current IDG instead",
    422,
  );
}
/** The retryable 503 when the WINDOW B eligibility lookup itself fails (fail-closed: never allow on error). */
export function addendumEligibilityUnavailableError(): WardenXError {
  return new WardenXError(
    "ADDENDUM_ELIGIBILITY_UNAVAILABLE",
    "could not verify whether a newer IDG meeting supersedes this addendum; please retry",
    503,
  );
}
/** Result of {@link planDisciplineNoteCreate}. */
export interface DisciplineNoteCreatePlan {
  readonly isAddendum: boolean;
  readonly addendumRecordedAt: Date | null;
  readonly reason: string | null;
}
/**
 * Pure state matrix for creating a discipline note: `live` => an ordinary note whose `reason` is OPTIONAL context
 * (blank/whitespace => absent => null); `adjourned` => a late ADDENDUM iff (1) within
 * {@link DISCIPLINE_NOTE_ADDENDUM_WINDOW_DAYS} days of `adjournedAt` (inclusive), (2) for a PATIENT-scoped note, no
 * NEWER ADJOURNED IDG has included that patient (`newerAdjournedIdgForPatient`, WINDOW B; ignored for meeting-level
 * notes, which keep the 14-day rule only) and (3) a non-blank reason is given (server clock `now` is the
 * recorded-at). Any other status => MEETING_NOT_LIVE. An adjourned meeting with no recorded end time is treated as
 * out of window (fail-closed). Check order: window, superseded, reason.
 */
export function planDisciplineNoteCreate(input: {
  readonly status: string;
  readonly adjournedAt: Date | null;
  readonly now: Date;
  readonly reason?: string | null;
  readonly patientId?: string | null;
  /** True iff another ADJOURNED IDG (same org) with a later `actual_end` included `patientId`. */
  readonly newerAdjournedIdgForPatient?: boolean;
}): DisciplineNoteCreatePlan {
  const reason = input.reason?.trim() ?? "";
  if (input.status === "live") {
    return {
      isAddendum: false,
      addendumRecordedAt: null,
      reason: reason.length > 0 ? reason : null,
    };
  }
  if (input.status !== "adjourned") throw noteMeetingNotLiveError();
  const windowMs = DISCIPLINE_NOTE_ADDENDUM_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  if (input.adjournedAt === null || input.now.getTime() > input.adjournedAt.getTime() + windowMs) {
    throw addendumWindowClosedError();
  }
  if (input.patientId != null && input.newerAdjournedIdgForPatient === true) {
    throw addendumSupersededError();
  }
  if (reason.length === 0) throw addendumReasonRequiredError();
  return { isAddendum: true, addendumRecordedAt: input.now, reason };
}
/** Normalise an optional reason: trim, blank => null. */
export function normalizeNoteReason(reason: string | null | undefined): string | null {
  const t = reason?.trim() ?? "";
  return t.length > 0 ? t : null;
}
/** The 422 for a note about a patient who is not on the meeting's caseload (URL-tamper defense, §2.3 D9). */
export function noteInclusionError(): WardenXError {
  return new WardenXError(
    "INCLUSION_CRITERIA_FAILED",
    "the patient is not on this meeting's agenda",
    422,
  );
}
/**
 * Pure authorization for one note write: a coordinator (`idg.coordinate`) may write any discipline; anyone
 * else must be an attendee recorded present/tardy/partial FOR THE NOTE'S DISCIPLINE. 403 otherwise.
 */
export function assertMayWriteDisciplineNote(
  actor: DisciplineNoteActor,
  discipline: string,
  attendance: ReadonlyArray<{
    readonly membershipId: string;
    readonly discipline: string;
    readonly status: string;
  }>,
): void {
  if (actor.isCoordinator) return;
  const ok = attendance.some(
    (a) =>
      a.membershipId === actor.membershipId &&
      a.discipline === discipline &&
      (NOTE_PRESENT_STATUSES as readonly string[]).includes(a.status),
  );
  if (!ok) {
    throw new ForbiddenError(
      "a discipline note may only be written by an attendee recorded present for that discipline, or by a coordinator",
    );
  }
}
/** 412 STALE_VERSION when the `If-Match` version no longer matches the row (optimistic concurrency, §7.7). */
export function assertNoteVersion(expected: number, current: number): void {
  if (expected !== current) {
    throw new WardenXError(
      "STALE_VERSION",
      `stale write: expected row version ${expected} but current is ${current}`,
      412,
    );
  }
}

/** 412 STALE_VERSION when the row moved between the version check and the guarded write (a lost race). */
export function staleRowError(readVersion: number): WardenXError {
  return new WardenXError(
    "STALE_VERSION",
    `stale write: the row changed after version ${readVersion} was read; re-read and retry`,
    412,
  );
}

export interface PacketDigestView {
  readonly packetId: string;
  readonly meetingId: string;
  readonly patientId: string;
  readonly frozenAt: string | null;
}
/**
 * One patient's packet with its CONTENT (GET /idg/meetings/:meetingId/packets/:patientId): the frozen
 * `built_snapshot` + discipline views shaped for the packet page / live centre pane. Built by the pure
 * `mapPacketContent` (./packet-content.ts) — snapshot facts only, never fabricated, W-SUD-01 applied per caller.
 * `content` is null only for a row whose stored snapshot is missing/an unsupported schema version.
 */
export interface PacketDetailView extends PacketDigestView {
  readonly content: PacketContentView | null;
  /** W-SUD-01 — Part 2 content was elided for THIS caller on THIS read. */
  readonly appliedSudRedaction: boolean;
  /** "Some content filtered per 42 CFR Part 2" when `appliedSudRedaction`, else null. */
  readonly redactionNotice: string | null;
}
/**
 * The per-request viewer the packet READ resolves W-SUD-01 through. `sudDisclosureAllowed` is consulted lazily
 * (only for a SUD-flagged patient); an ABSENT viewer means "cannot prove a Part 2 release" ⇒ redact
 * (fail-closed), so a caller that forgets to pass one narrows the read, never widens it.
 */
export interface PacketViewer {
  sudDisclosureAllowed(patientId: string): Promise<boolean>;
  /** Sampled-audit hook — called when redaction elided content (count is for the server log, never the wire). */
  onSudRedaction?(info: { patientId: string; redactedEntryCount: number }): void;
}
export interface RecurringPolicyView {
  readonly id: string;
  readonly locationId: string;
  readonly cadenceDays: number;
  readonly active: boolean;
  /** GAP-127 — the row version a PATCH echoes back as `If-Match`. */
  readonly version: number;
}
export interface MeetingScheduleView {
  readonly id: string;
  readonly locationId: string;
  readonly status: IdgMeetingStatus;
  readonly scheduledStart: string;
  readonly scheduledEnd: string;
  /** The meeting's IDG coordinator (M1 membership id). */
  readonly coordinatorMembershipId: string;
}

/**
 * A patient's IDG review history — the meetings this patient was reviewed in (has a packet), each with
 * the meeting's schedule/status and the patient's decisions + action items from that meeting. PHI-safe by
 * construction: it surfaces only non-narrative metadata (decision KIND, action-item status/discipline,
 * meeting dates) — never the denylisted packet cover summaries, decision payloads, or item body text — so
 * there is no §3.3 SUD narrative to redact (mirrors the packet-digest reads). Empty `meetings` when the
 * patient has never been on an agenda.
 */
export interface PatientIdgHistoryView {
  readonly meetings: readonly {
    readonly meetingId: string;
    readonly status: string;
    readonly scheduledStart: string;
    readonly actualStart: string | null;
    readonly actualEnd: string | null;
    readonly reviewedAt: string | null;
    readonly packetFrozenAt: string | null;
    readonly decisions: readonly {
      readonly id: string;
      readonly decisionKind: string;
      readonly status: string;
      readonly wasQuorate: boolean;
      readonly recordedAt: string | null;
    }[];
    readonly actionItems: readonly {
      readonly id: string;
      readonly status: string;
      readonly discipline: string | null;
      readonly dueDate: string | null;
      readonly closedAt: string | null;
    }[];
  }[];
}

// ── service args ─────────────────────────────────────────────────────────────────────────────────────────
export interface RecurringPolicyArgs {
  readonly locationId: string;
  readonly cadenceDays: number;
  readonly active?: boolean;
}
/** `POST /idg/meetings` — schedule ONE ad-hoc meeting (no recurring policy). */
export interface ScheduleMeetingArgs {
  readonly locationId: string;
  readonly scheduledStart: string;
  readonly scheduledEnd: string;
  /** Defaults to the acting membership when omitted. */
  readonly coordinatorMembershipId?: string;
}
/** An ad-hoc meeting may not run longer than this (a fat-fingered end date is refused, not persisted). */
export const MAX_MEETING_DURATION_MS = 12 * 3_600_000;
/** The pure window rules for scheduling a single meeting (shared by the in-memory + Drizzle backends).
 * 422 VALIDATION_FAILED when end <= start, the window exceeds {@link MAX_MEETING_DURATION_MS}, or the
 * start is already in the past. */
export function validateMeetingWindow(
  scheduledStart: string,
  scheduledEnd: string,
  nowMs: number,
): void {
  const s = Date.parse(scheduledStart);
  const e = Date.parse(scheduledEnd);
  const fail = (field: string, message: string): never => {
    throw new ValidationError("request validation failed", [{ field, code: "INVALID", message }]);
  };
  if (Number.isNaN(s)) fail("scheduledStart", "scheduledStart is not a valid instant");
  if (Number.isNaN(e)) fail("scheduledEnd", "scheduledEnd is not a valid instant");
  if (e <= s) fail("scheduledEnd", "scheduledEnd must be after scheduledStart");
  if (e - s > MAX_MEETING_DURATION_MS) fail("scheduledEnd", "a meeting may not exceed 12 hours");
  if (s < nowMs) fail("scheduledStart", "scheduledStart must not be in the past");
}
/** The uniform 422 for an unusable `coordinatorMembershipId` (absent / other org / not active) — no existence oracle. */
export function invalidCoordinatorError(): ValidationError {
  return new ValidationError("request validation failed", [
    {
      field: "coordinatorMembershipId",
      code: "INVALID",
      message: "coordinatorMembershipId must be an active member of this organization",
    },
  ]);
}
export interface RescheduleArgs {
  readonly reason: string;
  readonly newScheduledStart: string;
  readonly newScheduledEnd: string;
  /** GAP-091 — see `cancelMeeting`'s `overrideAuthorized` doc; resolved by the route, not the caller. */
  readonly overrideAuthorized?: boolean;
}
export interface RecordAttendanceArgs {
  readonly membershipId: string;
  readonly discipline: string;
  readonly status?: IdgAttendanceStatus;
  readonly checkedInAt?: string;
  /** The acting membership (the route's caller). Absent (service-level callers/tests) => stored null, like a legacy row. */
  readonly recordedByMembershipId?: string;
  /** The route's verdict ({@link planAttendanceRecord}): a coordinator's flagged override of an unheld discipline. */
  readonly disciplineAttested?: boolean;
}
export interface AddAgendaItemArgs {
  readonly kind: IdgAgendaItemKind;
  readonly patientId?: string;
}
export interface RecordDecisionArgs {
  readonly patientId: string | null;
  readonly agendaItemId?: string;
  readonly decisionKind: IdgDecisionKind;
  readonly payload: IdgDecisionRecordedPayload;
}
export interface SupersedeDecisionArgs {
  /** The subsequent (live) meeting the successor decision is recorded in. */
  readonly meetingId: string;
  /** The caller's location memberships. When given, the service refuses (404, no leak) a decision whose PRIOR meeting
   * is at a location outside it — defence in depth behind the route's `idg_meeting_scope` gate on that meeting. */
  readonly callerLocationIds?: readonly string[];
}
export interface CreateActionItemArgs {
  readonly decisionId?: string;
  readonly patientId: string | null;
  readonly assignedToMembershipId: string;
  readonly dueDate: string;
  readonly linkedArtifactKind?: IdgActionItemLinkedKind;
  /** F-104 — the D8 auto-close key. Must arrive WITH `linkedArtifactKind`; see the route contract. */
  readonly linkedArtifactId?: string;
}

/** Child resources whose public id does not itself identify the meeting/location authorization target. */
export type IdgScopedChildKind =
  | "agenda_item"
  | "attendance"
  | "decision"
  | "action_item"
  | "discipline_note"
  | "minutes";

/** Minimum facts needed to authorize a child route without returning the child itself first. */
export interface IdgScopedChildFacts {
  readonly meetingId: string;
  readonly locationId: string;
  readonly patientId: string | null;
  readonly assignedToMembershipId: string | null;
}

/** SQL/read-model scope for the action-item worklist. `null` means a server-recognized org-wide scope. */
export interface ActionItemListScope {
  readonly assigneeMembershipId: string;
  readonly locationIds: readonly string[] | null;
  readonly patientIds: readonly string[] | null;
}

/** The §4.1 route service contract (the routes layer composes over this). */
export interface IdgRouteService {
  // schedule + recurring policies
  listSchedule(
    orgId: string,
    q: { location: string; from: string; to: string },
  ): Promise<MeetingScheduleView[]>;
  createRecurringPolicy(
    orgId: string,
    userId: string,
    args: RecurringPolicyArgs,
  ): Promise<RecurringPolicyView>;
  updateRecurringPolicy(
    orgId: string,
    userId: string,
    id: string,
    args: RecurringPolicyArgs,
    expectedVersion?: number,
  ): Promise<RecurringPolicyView>;
  // meeting lifecycle
  /** Schedule ONE ad-hoc meeting (`status: 'scheduled'`, no recurring policy). Emits `m14.meeting.scheduled`.
   * 409 `IDG_MEETING_OVERLAP` when a live (non-cancelled/rescheduled) meeting at the location overlaps. */
  scheduleMeeting(orgId: string, userId: string, args: ScheduleMeetingArgs): Promise<MeetingView>;
  getMeeting(orgId: string, id: string): Promise<MeetingView>;
  /** GAP-091 — `overrideAuthorized` is resolved by the ROUTE (idg.override_review_floor + fresh step-up,
   * via the `per_patient_review_floor_clear` ABAC predicate) and passed through, same as `adjournMeeting`'s
   * `stepUpFresh` — the service cannot independently verify permission/session state from a bare membership
   * id. Defaults to `false` (no override) for any caller that doesn't pass it. */
  cancelMeeting(
    orgId: string,
    userId: string,
    id: string,
    reason: string,
    overrideAuthorized?: boolean,
  ): Promise<MeetingView>;
  rescheduleMeeting(
    orgId: string,
    userId: string,
    id: string,
    args: RescheduleArgs,
  ): Promise<MeetingView>;
  buildPackets(orgId: string, userId: string, id: string): Promise<MeetingView>;
  startMeeting(orgId: string, userId: string, id: string): Promise<MeetingView>;
  adjournMeeting(
    orgId: string,
    userId: string,
    id: string,
    stepUpFresh: boolean,
  ): Promise<MeetingView>;
  // attendance
  recordAttendance(
    orgId: string,
    userId: string,
    meetingId: string,
    args: RecordAttendanceArgs,
  ): Promise<AttendanceView>;
  updateAttendance(
    orgId: string,
    userId: string,
    id: string,
    status: IdgAttendanceStatus,
    expectedVersion?: number,
  ): Promise<AttendanceView>;
  removeAttendance(
    orgId: string,
    userId: string,
    id: string,
    expectedVersion?: number,
  ): Promise<{ id: string; removed: true }>;
  /**
   * The meeting's attendance roster — the §2.7 participation the `quorate_decision` predicate reads.
   *
   * F-062: this is the read the three attendance WRITES never had. A coordinator could check a
   * clinician in, amend the row, and delete it, and no route in the module would return it — so the
   * live quorum gauge the §5 surface is specified around had no source, and an attendance ledger
   * nobody can read cannot evidence the §418.56 group composition it exists to record.
   */
  listAttendance(orgId: string, meetingId: string): Promise<AttendanceView[]>;
  // packets
  listPackets(orgId: string, meetingId: string): Promise<PacketDigestView[]>;
  getPacket(
    orgId: string,
    meetingId: string,
    patientId: string,
    viewer?: PacketViewer,
  ): Promise<PacketDetailView>;
  /** Patient-scoped IDG review history (patient-chart tab); empty meetings when never on an agenda. */
  getPatientIdgHistory(orgId: string, patientId: string): Promise<PatientIdgHistoryView>;
  // agenda
  addAgendaItem(
    orgId: string,
    userId: string,
    meetingId: string,
    args: AddAgendaItemArgs,
  ): Promise<AgendaItemView>;
  updateAgendaItem(
    orgId: string,
    userId: string,
    id: string,
    expectedVersion?: number,
  ): Promise<AgendaItemView>;
  removeAgendaItem(
    orgId: string,
    userId: string,
    id: string,
    expectedVersion?: number,
  ): Promise<{ id: string; removed: true }>;
  /** The meeting's ordered agenda (F-062 — add/update/remove existed; nothing listed them). */
  listAgenda(orgId: string, meetingId: string): Promise<AgendaItemView[]>;
  // decisions
  recordDecision(
    orgId: string,
    userId: string,
    meetingId: string,
    args: RecordDecisionArgs,
  ): Promise<DecisionView>;
  updateDecision(
    orgId: string,
    userId: string,
    id: string,
    payload: IdgDecisionRecordedPayload,
    ifMatchVersion: number,
  ): Promise<DecisionView>;
  /**
   * GAP-043 / §2.8: the successor is written into `args.meetingId` — a LATER, LIVE meeting — with the quorum
   * computed from that meeting's stored attendance; `QUORUM_NOT_MET` (422) when it is not quorate.
   */
  supersedeDecision(
    orgId: string,
    userId: string,
    id: string,
    args: SupersedeDecisionArgs,
  ): Promise<DecisionView>;
  /**
   * The meeting's decision ledger — metadata only, on the {@link PatientIdgHistoryView} precedent.
   *
   * F-062: record/update/supersede all wrote to `idg_decision` and the only reader anywhere was the
   * PATIENT-scoped history tab, which returns one patient's decisions across meetings. Nothing could
   * answer "what did this meeting decide", which is the question the live surface exists to ask and
   * the one an adjournment commits to.
   *
   * The `payload` is deliberately NOT returned: it is the D4 canonical narrative (rationaleText /
   * mutations / recommendations), denylisted in the §3.3 write-audit trigger, and publishing it would
   * reopen W-SUD-01 for a surface that has never had to answer it.
   */
  listDecisions(orgId: string, meetingId: string): Promise<DecisionView[]>;
  // action items
  createActionItem(
    orgId: string,
    userId: string,
    meetingId: string,
    args: CreateActionItemArgs,
  ): Promise<ActionItemView>;
  updateActionItem(
    orgId: string,
    userId: string,
    id: string,
    status: ActionItemPatchStatus,
    /** GAP-127 — the caller holds `idg.coordinate`; without it the caller must be the assignee. */
    isCoordinator?: boolean,
    expectedVersion?: number,
  ): Promise<ActionItemView>;
  removeActionItem(
    orgId: string,
    userId: string,
    id: string,
    expectedVersion?: number,
  ): Promise<{ id: string; removed: true }>;
  listActionItems(
    orgId: string,
    q: { status?: IdgActionItemStatus },
    scope: ActionItemListScope,
  ): Promise<ActionItemView[]>;
  // discipline notes (spec extension)
  /**
   * The meeting's discipline notes, oldest first, optionally for one patient. Readable in ANY meeting status
   * (after adjournment they are simply frozen). W-SUD-01: for a patient with an active SUD flag — or whom the
   * packet cannot vouch for — the text is withheld (`bodyWithheld`) unless `viewer` proves a Part 2 release;
   * an ABSENT viewer withholds (fail-closed).
   */
  listDisciplineNotes(
    orgId: string,
    meetingId: string,
    q: { patientId?: string },
    viewer?: PacketViewer,
  ): Promise<DisciplineNoteView[]>;
  /** Write a note. 422 MEETING_NOT_LIVE unless `live`; 422 INCLUSION_CRITERIA_FAILED for a patient off the agenda;
   * 403 unless the actor is a coordinator or is present for `args.discipline`. */
  createDisciplineNote(
    orgId: string,
    actor: DisciplineNoteActor,
    meetingId: string,
    args: CreateDisciplineNoteArgs,
  ): Promise<DisciplineNoteView>;
  /** Edit a live original note's text and/or reason (same guards; a non-coordinator may edit only their OWN note;
   * 412 on stale `If-Match`). Addenda are immutable. */
  updateDisciplineNote(
    orgId: string,
    actor: DisciplineNoteActor,
    id: string,
    patch: DisciplineNotePatch,
    ifMatchVersion: number,
  ): Promise<DisciplineNoteView>;
  /** The owning meeting id of a note (null when absent/cross-tenant) — for the route's per-meeting ABAC. */
  disciplineNoteMeetingId(orgId: string, id: string): Promise<string | null>;
  /** The owning meeting id of a decision (null when absent/cross-tenant) — for the supersede route's prior-meeting ABAC. */
  decisionMeetingId(orgId: string, id: string): Promise<string | null>;
  /** Resolve the parent meeting/location (and patient when present) for a child-id route, under org RLS. */
  scopedChildFacts(
    orgId: string,
    kind: IdgScopedChildKind,
    id: string,
  ): Promise<IdgScopedChildFacts | null>;
  /** Resolve an existing recurring policy's location under org RLS. */
  recurringPolicyLocationId(orgId: string, id: string): Promise<string | null>;
  // minutes
  getMinutes(orgId: string, meetingId: string): Promise<MinutesView>;
  submitAmendment(
    orgId: string,
    userId: string,
    minutesId: string,
    amendmentReason: string,
  ): Promise<{ amendmentId: string; minutesId: string }>;
}

// ── seed shapes ──────────────────────────────────────────────────────────────────────────────────────────
export interface IdgMeetingSeed {
  readonly id: string;
  readonly organizationId: string;
  readonly locationId: string;
  readonly status?: IdgMeetingStatus;
  readonly scheduledStart: string;
  readonly scheduledEnd: string;
  readonly coordinatorMembershipId?: string;
  /** Patients in the meeting's included set (inclusion + per-patient review-floor evaluation). */
  readonly includedPatientIds?: readonly string[];
  /** Per-patient stored packet (`built_snapshot` + `discipline_views` jsonb) — drives the packet CONTENT read. */
  readonly packets?: Readonly<
    Record<string, { readonly builtSnapshot: unknown; readonly disciplineViews: unknown }>
  >;
}
export interface IdgRouteSeed {
  readonly now?: () => string;
  readonly meetings?: readonly IdgMeetingSeed[];
  /** Membership id → its discipline (drives attendance + the quorum present-set). */
  readonly disciplinesByMembership?: Readonly<Record<string, string>>;
  /** Per-meeting review-floor breaches the `per_patient_review_floor_clear` predicate surfaces (default none). */
  readonly reviewFloorBreaches?: Readonly<Record<string, readonly ReviewFloorBreachFact[]>>;
  /**
   * Org id -> the ACTIVE membership ids of that org (the identity dataset the DB backend reads from M1's
   * `membership`). When given, `scheduleMeeting` rejects an explicit `coordinatorMembershipId` outside the
   * caller's org list; when omitted the slice has no identity dataset and does not enforce (DB backend does).
   */
  readonly activeMembershipsByOrg?: Readonly<Record<string, readonly string[]>>;
}

interface MeetingRow {
  id: string;
  organizationId: string;
  locationId: string;
  status: IdgMeetingStatus;
  scheduledStart: string;
  scheduledEnd: string;
  adjournedAt: string | null;
  coordinatorMembershipId: string;
  includedPatientIds: Set<string>;
}
interface AttendanceRow {
  id: string;
  meetingId: string;
  membershipId: string;
  discipline: string;
  status: IdgAttendanceStatus;
  checkedInAt: string;
  disciplineAttested: boolean;
  recordedByMembershipId: string | null;
  version: number;
}
interface AgendaRow {
  id: string;
  meetingId: string;
  kind: IdgAgendaItemKind;
  patientId: string | null;
  version: number;
}
interface DecisionRow {
  id: string;
  meetingId: string;
  patientId: string | null;
  agendaItemId: string | null;
  recordedByMembershipId: string;
  recordedAt: string;
  decisionKind: IdgDecisionKind;
  payload: IdgDecisionRecordedPayload;
  status: IdgDecisionStatus;
  wasQuorate: boolean;
  quorumSnapshot: QuorumSnapshot;
  supersededByDecisionId: string | null;
  version: number;
}
interface ActionItemRow {
  id: string;
  meetingId: string;
  decisionId: string | null;
  patientId: string | null;
  assignedToMembershipId: string;
  status: IdgActionItemStatus;
  dueDate: string;
  linkedArtifactKind: IdgActionItemLinkedKind | null;
  linkedArtifactId: string | null;
  version: number;
}
interface NoteRow {
  id: string;
  meetingId: string;
  patientId: string | null;
  discipline: string;
  bodyText: string;
  authorMembershipId: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  isAddendum: boolean;
  addendumRecordedAt: string | null;
  reason: string | null;
}
interface MinutesRow {
  id: string;
  meetingId: string;
  status: "in_progress" | "final";
  finalizedAt: string | null;
  finalizedByMembershipId: string | null;
  minutesDocumentId: string | null;
  attendanceCount: number | null;
  decisionCount: number | null;
  actionItemCount: number | null;
  disciplineNoteCount: number | null;
}
interface RecurringPolicyRow {
  id: string;
  organizationId: string;
  locationId: string;
  cadenceDays: number;
  active: boolean;
  version: number;
}

let _seq = 0;
const nextId = (prefix: string): string => `${prefix}-${(++_seq).toString().padStart(8, "0")}`;

/** The action-item statuses a PATCH may transition TO (`open` is genesis-only — an item is never re-opened). */
export type ActionItemPatchStatus = "in_progress" | "completed" | "cancelled";

const PATCH_STATUS_EVENT: Record<ActionItemPatchStatus, "start" | "complete" | "cancel"> = {
  in_progress: "start",
  completed: "complete",
  cancelled: "cancel",
};

/**
 * Read-only inspection surface over the slice (the §7/§9 route + workflow-acceptance suites assert
 * against it). The M22 `DocumentBackendInspect` shape.
 */
export interface IdgBackendInspect {
  /** Drain the recorded outbox emissions since the last call (deterministic; test-only). */
  drainEvents(): RecordedIdgEvent[];
  /** The §2.6 quorum snapshot for a meeting as its attendance currently stands. */
  currentQuorum(meetingId: string): QuorumSnapshot;
}

/** Build the in-memory M14 route backend (also the {@link IdgAbacResolver}). */
export function createInMemoryIdgBackend(
  seed: IdgRouteSeed = {},
): IdgRouteService & IdgAbacResolver & IdgBackendInspect {
  const now = seed.now ?? (() => new Date().toISOString());
  const disciplines = seed.disciplinesByMembership ?? {};
  const reviewFloorBreaches = seed.reviewFloorBreaches ?? {};

  /** meetingId → patientId → stored packet jsonb (seeded; the slice never builds packets). */
  const packetSeeds = new Map<string, NonNullable<IdgMeetingSeed["packets"]>>();
  for (const m of seed.meetings ?? []) if (m.packets) packetSeeds.set(m.id, m.packets);

  const meetings = new Map<string, MeetingRow>();
  for (const m of seed.meetings ?? []) {
    meetings.set(m.id, {
      id: m.id,
      organizationId: m.organizationId,
      locationId: m.locationId,
      status: m.status ?? "scheduled",
      scheduledStart: m.scheduledStart,
      scheduledEnd: m.scheduledEnd,
      adjournedAt: null,
      coordinatorMembershipId: m.coordinatorMembershipId ?? "00000000-0000-4000-8000-0000000000c0",
      includedPatientIds: new Set(m.includedPatientIds ?? []),
    });
  }
  const attendance = new Map<string, AttendanceRow>();
  const agenda = new Map<string, AgendaRow>();
  const notes = new Map<string, NoteRow>();
  const decisions = new Map<string, DecisionRow>();
  const actionItems = new Map<string, ActionItemRow>();
  const minutes = new Map<string, MinutesRow>(); // keyed by meetingId
  const minutesById = new Map<string, MinutesRow>();
  const policies = new Map<string, RecurringPolicyRow>();
  const events: RecordedIdgEvent[] = [];

  const emit = (eventName: string, payload: Record<string, unknown>): void => {
    events.push({ eventName, payload });
  };

  /** Resolve a meeting under the caller's tenant (404 — existence non-leak — when absent / cross-tenant). */
  function meetingOf(orgId: string, id: string): MeetingRow {
    const m = meetings.get(id);
    if (!m || m.organizationId !== orgId) throw new NotFoundError("idg_meeting");
    return m;
  }
  function toMeetingView(m: MeetingRow): MeetingView {
    return {
      id: m.id,
      organizationId: m.organizationId,
      locationId: m.locationId,
      status: m.status,
      scheduledStart: m.scheduledStart,
      scheduledEnd: m.scheduledEnd,
      adjournedAt: m.adjournedAt,
      coordinatorMembershipId: m.coordinatorMembershipId,
    };
  }
  /** WINDOW B: another ADJOURNED meeting of the org, ending later than `m`, that included the patient. */
  function newerAdjournedFor(m: MeetingRow, patientId: string): boolean {
    if (m.adjournedAt === null) return false;
    return [...meetings.values()].some(
      (o) =>
        o.id !== m.id &&
        o.organizationId === m.organizationId &&
        o.status === "adjourned" &&
        o.adjournedAt !== null &&
        o.adjournedAt > (m.adjournedAt as string) &&
        o.includedPatientIds.has(patientId),
    );
  }
  function toNoteView(n: NoteRow, withheld: boolean): DisciplineNoteView {
    return {
      id: n.id,
      meetingId: n.meetingId,
      patientId: n.patientId,
      discipline: n.discipline,
      bodyText: withheld ? null : n.bodyText,
      bodyWithheld: withheld,
      authorMembershipId: n.authorMembershipId,
      version: n.version,
      createdAt: n.createdAt,
      updatedAt: n.updatedAt,
      isAddendum: n.isAddendum,
      addendumRecordedAt: n.addendumRecordedAt,
      reason: withheld ? null : n.reason,
    };
  }
  /** The disciplines PRESENT (present/tardy/partial) at the meeting right now (the quorum present-set). */
  function presentDisciplinesFor(meetingId: string): string[] {
    return [...attendance.values()]
      .filter((a) => a.meetingId === meetingId && a.status !== "absent" && a.status !== "excused")
      .map((a) => a.discipline);
  }
  function ensureMinutes(meetingId: string): MinutesRow {
    let row = minutes.get(meetingId);
    if (!row) {
      row = {
        id: nextId("idg-min"),
        meetingId,
        status: "in_progress",
        finalizedAt: null,
        finalizedByMembershipId: null,
        minutesDocumentId: null,
        attendanceCount: null,
        decisionCount: null,
        actionItemCount: null,
        disciplineNoteCount: null,
      };
      minutes.set(meetingId, row);
      minutesById.set(row.id, row);
    }
    return row;
  }

  const service: IdgRouteService & IdgAbacResolver = {
    // ── schedule + recurring policies ──────────────────────────────────────────────────────────────────
    async listSchedule(orgId, q) {
      return [...meetings.values()]
        .filter(
          (m) =>
            m.organizationId === orgId &&
            m.locationId === q.location &&
            m.scheduledStart >= q.from &&
            m.scheduledStart <= q.to,
        )
        .sort((a, b) => (a.scheduledStart < b.scheduledStart ? -1 : 1))
        .map((m) => ({
          id: m.id,
          locationId: m.locationId,
          status: m.status,
          scheduledStart: m.scheduledStart,
          scheduledEnd: m.scheduledEnd,
          coordinatorMembershipId: m.coordinatorMembershipId,
        }));
    },
    async createRecurringPolicy(orgId, _userId, args) {
      const id = nextId("idg-pol");
      const row: RecurringPolicyRow = {
        id,
        organizationId: orgId,
        locationId: args.locationId,
        cadenceDays: args.cadenceDays,
        active: args.active ?? true,
        version: 0,
      };
      policies.set(id, row);
      emit("m14.schedule.materialised", { recurringPolicyId: id, locationId: args.locationId });
      return {
        id: row.id,
        locationId: row.locationId,
        cadenceDays: row.cadenceDays,
        active: row.active,
        version: row.version,
      };
    },
    async updateRecurringPolicy(orgId, _userId, id, args, expectedVersion) {
      const row = policies.get(id);
      if (!row || row.organizationId !== orgId) throw new NotFoundError("idg_recurring_policy");
      if (expectedVersion !== undefined) assertNoteVersion(expectedVersion, row.version);
      row.cadenceDays = args.cadenceDays;
      row.active = args.active ?? row.active;
      row.version += 1;
      return {
        id: row.id,
        locationId: row.locationId,
        cadenceDays: row.cadenceDays,
        active: row.active,
        version: row.version,
      };
    },

    // ── meeting lifecycle ────────────────────────────────────────────────────────────────────────────────
    async scheduleMeeting(orgId, userId, args) {
      validateMeetingWindow(args.scheduledStart, args.scheduledEnd, Date.parse(now()));
      if (
        args.coordinatorMembershipId !== undefined &&
        seed.activeMembershipsByOrg !== undefined &&
        !(seed.activeMembershipsByOrg[orgId] ?? []).includes(args.coordinatorMembershipId)
      ) {
        throw invalidCoordinatorError();
      }
      const s = Date.parse(args.scheduledStart);
      const e = Date.parse(args.scheduledEnd);
      for (const o of meetings.values()) {
        if (o.organizationId !== orgId || o.locationId !== args.locationId) continue;
        if (o.status === "cancelled" || o.status === "rescheduled") continue;
        if (Date.parse(o.scheduledStart) < e && Date.parse(o.scheduledEnd) > s) {
          throw new WardenXError(
            "IDG_MEETING_OVERLAP",
            "another IDG meeting at this location overlaps the requested window",
            409,
          );
        }
      }
      const id = globalThis.crypto.randomUUID(); // a real uuid so the id round-trips the `:id` uuid params
      const row: MeetingRow = {
        id,
        organizationId: orgId,
        locationId: args.locationId,
        status: "scheduled",
        scheduledStart: new Date(s).toISOString(),
        scheduledEnd: new Date(e).toISOString(),
        adjournedAt: null,
        coordinatorMembershipId: args.coordinatorMembershipId ?? userId,
        includedPatientIds: new Set(),
      };
      meetings.set(id, row);
      emit("m14.meeting.scheduled", {
        meetingId: id,
        locationId: row.locationId,
        scheduledStart: row.scheduledStart,
        scheduledEnd: row.scheduledEnd,
      });
      return toMeetingView(row);
    },
    async getMeeting(orgId, id) {
      return toMeetingView(meetingOf(orgId, id));
    },
    async cancelMeeting(orgId, userId, id, reason, overrideAuthorized = false) {
      const m = meetingOf(orgId, id);
      // GAP-091 — the route's `per_patient_review_floor_clear` ABAC already checked this same seeded breach
      // set to decide allow/deny; the service resolves it again (defense in depth, same as GAP-020) and
      // feeds the REAL facts into the pure machine instead of the old hardcoded "always clear + authorized".
      const breaches = reviewFloorBreaches[id] ?? [];
      const t = transitionMeeting(m.status, {
        type: "CANCEL",
        reason,
        reviewFloorClear: breaches.length === 0,
        overrideAuthorized,
        breachingPatients: breaches,
      });
      m.status = t.to;
      emit("m14.meeting.cancelled", { meetingId: id, cancellationReason: reason });
      if (breaches.length > 0 && overrideAuthorized) {
        emit("m14.review_floor.override_recorded", {
          meetingId: id,
          actorMembershipId: userId,
          reason,
          breachingPatients: breaches,
          overriddenAt: now(),
        });
      }
      return toMeetingView(m);
    },
    async rescheduleMeeting(orgId, userId, id, args) {
      const m = meetingOf(orgId, id);
      const breaches = reviewFloorBreaches[id] ?? [];
      const t = transitionMeeting(m.status, {
        type: "RESCHEDULE",
        reason: args.reason,
        reviewFloorClear: breaches.length === 0,
        overrideAuthorized: args.overrideAuthorized ?? false,
        breachingPatients: breaches,
      });
      m.status = t.to;
      const newId = nextId("idg-mtg");
      meetings.set(newId, {
        id: newId,
        organizationId: m.organizationId,
        locationId: m.locationId,
        status: "scheduled",
        scheduledStart: args.newScheduledStart,
        scheduledEnd: args.newScheduledEnd,
        adjournedAt: null,
        coordinatorMembershipId: m.coordinatorMembershipId,
        includedPatientIds: new Set(m.includedPatientIds),
      });
      emit("m14.meeting.rescheduled", {
        priorMeetingId: id,
        newMeetingId: newId,
        newScheduledStart: args.newScheduledStart,
        reason: args.reason,
      });
      if (breaches.length > 0 && args.overrideAuthorized) {
        emit("m14.review_floor.override_recorded", {
          meetingId: id,
          actorMembershipId: userId,
          reason: args.reason,
          breachingPatients: breaches,
          overriddenAt: now(),
        });
      }
      return toMeetingView(m);
    },
    async buildPackets(orgId, _userId, id) {
      const m = meetingOf(orgId, id);
      const t = transitionMeeting(m.status, {
        type: "BUILD_PACKETS",
        includedPatientCount: m.includedPatientIds.size,
      });
      m.status = t.to;
      emit("m14.packets.build_started", {
        meetingId: id,
        includedPatientCount: m.includedPatientIds.size,
      });
      return toMeetingView(m);
    },
    async startMeeting(orgId, _userId, id) {
      const m = meetingOf(orgId, id);
      const t = transitionMeeting(m.status, { type: "START" });
      m.status = t.to;
      emit("m14.meeting.started", { meetingId: id, startedAt: now() });
      return toMeetingView(m);
    },
    async adjournMeeting(orgId, userId, id, stepUpFresh) {
      const m = meetingOf(orgId, id);
      // `transitionMeeting` raises STEP_UP_REQUIRED (412) when the fresh step-up is absent (§2.2 D13).
      const t = transitionMeeting(m.status, { type: "ADJOURN", stepUpFresh });
      m.status = t.to;
      m.adjournedAt = now();
      // The commit point: emit every open decision, finalize the minutes (§2.7).
      for (const d of decisions.values()) {
        if (d.meetingId === id && d.status === "open") {
          d.status = "emitted";
          if (d.decisionKind !== "team_note") {
            emit("idg.decision_recorded", {
              decisionId: d.id,
              meetingId: id,
              patientId: d.patientId,
              organizationId: orgId,
              decisionKind: d.decisionKind,
              payload: d.payload,
              payloadSchemaVersion: "2026-01-v1",
              recordedByMembershipId: userId,
              recordedAt: now(),
              meetingAdjournedAt: m.adjournedAt,
              wasQuorate: d.wasQuorate,
              quorumSnapshot: d.quorumSnapshot,
            });
          }
        }
      }
      const min = ensureMinutes(id);
      min.status = "final";
      min.finalizedAt = m.adjournedAt;
      min.finalizedByMembershipId = userId;
      min.attendanceCount = [...attendance.values()].filter((a) => a.meetingId === id).length;
      min.decisionCount = [...decisions.values()].filter((d) => d.meetingId === id).length;
      min.actionItemCount = [...actionItems.values()].filter((a) => a.meetingId === id).length;
      min.disciplineNoteCount = [...notes.values()].filter((n) => n.meetingId === id).length;
      emit("m14.meeting.adjourned", { meetingId: id, adjournedAt: m.adjournedAt });
      emit("m14.minutes.signed", { minutesId: min.id, meetingId: id });
      return toMeetingView(m);
    },

    // ── attendance ───────────────────────────────────────────────────────────────────────────────────────
    async recordAttendance(orgId, _userId, meetingId, args) {
      meetingOf(orgId, meetingId);
      const id = nextId("idg-att");
      const row: AttendanceRow = {
        id,
        meetingId,
        membershipId: args.membershipId,
        discipline: args.discipline,
        status: args.status ?? "present",
        checkedInAt: args.checkedInAt ?? now(),
        disciplineAttested: args.disciplineAttested ?? false,
        recordedByMembershipId: args.recordedByMembershipId ?? null,
        version: 0,
      };
      attendance.set(id, row);
      emit("m14.attendance.checked_in", {
        meetingId,
        attendanceId: id,
        membershipId: args.membershipId,
        discipline: args.discipline,
      });
      return { ...row };
    },
    async updateAttendance(orgId, _userId, id, status, expectedVersion) {
      const row = attendance.get(id);
      if (!row) throw new NotFoundError("idg_attendance");
      meetingOf(orgId, row.meetingId);
      if (expectedVersion !== undefined) assertNoteVersion(expectedVersion, row.version);
      row.status = status;
      row.version += 1;
      return { ...row };
    },
    async removeAttendance(orgId, _userId, id, expectedVersion) {
      const row = attendance.get(id);
      if (!row) throw new NotFoundError("idg_attendance");
      meetingOf(orgId, row.meetingId);
      if (expectedVersion !== undefined) assertNoteVersion(expectedVersion, row.version);
      attendance.delete(id);
      return { id, removed: true };
    },

    async listAttendance(orgId, meetingId) {
      meetingOf(orgId, meetingId);
      return [...attendance.values()]
        .filter((a) => a.meetingId === meetingId)
        .map((a) => ({ ...a }));
    },

    // ── packets ──────────────────────────────────────────────────────────────────────────────────────────
    async listPackets(orgId, meetingId) {
      const m = meetingOf(orgId, meetingId);
      return [...m.includedPatientIds].map((patientId) => ({
        packetId: nextId("idg-pkt"),
        meetingId,
        patientId,
        frozenAt: m.status === "adjourned" ? m.adjournedAt : null,
      }));
    },
    async getPacket(orgId, meetingId, patientId, viewer) {
      const m = meetingOf(orgId, meetingId);
      if (!m.includedPatientIds.has(patientId)) throw new NotFoundError("idg_patient_packet");
      const stored = packetSeeds.get(meetingId)?.[patientId];
      const mapped = stored
        ? await mapPacketContent(
            stored,
            () => viewer?.sudDisclosureAllowed(patientId) ?? Promise.resolve(false),
          )
        : {
            content: null,
            appliedSudRedaction: false,
            redactionNotice: null,
            redactedEntryCount: 0,
          };
      if (mapped.appliedSudRedaction) {
        viewer?.onSudRedaction?.({ patientId, redactedEntryCount: mapped.redactedEntryCount });
      }
      return {
        packetId: nextId("idg-pkt"),
        meetingId,
        patientId,
        frozenAt: m.status === "adjourned" ? m.adjournedAt : null,
        content: mapped.content,
        appliedSudRedaction: mapped.appliedSudRedaction,
        redactionNotice: mapped.redactionNotice,
      };
    },
    async getPatientIdgHistory(orgId, patientId) {
      const rows = [...meetings.values()]
        .filter((m) => m.organizationId === orgId && m.includedPatientIds.has(patientId))
        .sort((a, b) => Date.parse(b.scheduledStart) - Date.parse(a.scheduledStart))
        .map((m) => ({
          meetingId: m.id,
          status: m.status as string,
          scheduledStart: m.scheduledStart,
          actualStart: null,
          actualEnd: m.adjournedAt,
          reviewedAt: null,
          packetFrozenAt: m.status === "adjourned" ? m.adjournedAt : null,
          decisions: [...decisions.values()]
            .filter((d) => d.meetingId === m.id && d.patientId === patientId)
            .map((d) => ({
              id: d.id,
              decisionKind: d.decisionKind as string,
              status: d.status as string,
              wasQuorate: d.wasQuorate,
              recordedAt: null,
            })),
          actionItems: [...actionItems.values()]
            .filter((a) => a.meetingId === m.id && a.patientId === patientId)
            .map((a) => ({
              id: a.id,
              status: a.status as string,
              discipline: null,
              dueDate: a.dueDate,
              closedAt: null,
            })),
        }));
      return { meetings: rows };
    },

    // ── agenda ───────────────────────────────────────────────────────────────────────────────────────────
    async addAgendaItem(orgId, _userId, meetingId, args) {
      meetingOf(orgId, meetingId);
      const id = nextId("idg-agd");
      const row: AgendaRow = {
        id,
        meetingId,
        kind: args.kind,
        patientId: args.patientId ?? null,
        version: 0,
      };
      agenda.set(id, row);
      return { ...row };
    },
    async updateAgendaItem(orgId, _userId, id, expectedVersion) {
      const row = agenda.get(id);
      if (!row) throw new NotFoundError("idg_agenda_item");
      meetingOf(orgId, row.meetingId);
      if (expectedVersion !== undefined) assertNoteVersion(expectedVersion, row.version);
      return { ...row };
    },
    async removeAgendaItem(orgId, _userId, id, expectedVersion) {
      const row = agenda.get(id);
      if (!row) throw new NotFoundError("idg_agenda_item");
      meetingOf(orgId, row.meetingId);
      if (expectedVersion !== undefined) assertNoteVersion(expectedVersion, row.version);
      agenda.delete(id);
      return { id, removed: true };
    },

    async listAgenda(orgId, meetingId) {
      meetingOf(orgId, meetingId);
      return [...agenda.values()].filter((a) => a.meetingId === meetingId).map((a) => ({ ...a }));
    },

    // ── decisions ────────────────────────────────────────────────────────────────────────────────────────
    async recordDecision(orgId, userId, meetingId, args) {
      const m = meetingOf(orgId, meetingId);
      // `planDecisionRecord` enforces MEETING_NOT_LIVE + INCLUSION_CRITERIA_FAILED and stamps the quorum.
      const plan = planDecisionRecord({
        meetingIsLive: m.status === "live",
        patientIncluded: args.patientId === null || m.includedPatientIds.has(args.patientId),
        presentDisciplines: presentDisciplinesFor(meetingId),
      });
      const id = nextId("idg-dec");
      const row: DecisionRow = {
        id,
        meetingId,
        patientId: args.patientId,
        agendaItemId: args.agendaItemId ?? null,
        recordedByMembershipId: userId,
        recordedAt: now(),
        decisionKind: args.decisionKind,
        payload: args.payload,
        status: plan.status,
        wasQuorate: plan.wasQuorate,
        quorumSnapshot: plan.quorumSnapshot,
        supersededByDecisionId: null,
        version: 0,
      };
      decisions.set(id, row);
      emit("m14.decision.recorded_open", {
        decisionId: id,
        meetingId,
        patientId: args.patientId,
        decisionKind: args.decisionKind,
        wasQuorate: plan.wasQuorate,
      });
      return { ...row };
    },
    async updateDecision(orgId, _userId, id, payload, ifMatchVersion) {
      const row = decisions.get(id);
      if (!row) throw new NotFoundError("idg_decision");
      const m = meetingOf(orgId, row.meetingId);
      // GAP-043: only an `open` decision in a live meeting is editable (§2.8).
      planDecisionUpdate({ status: row.status, meetingIsLive: m.status === "live" });
      assertNoteVersion(ifMatchVersion, row.version);
      row.version += 1;
      row.decisionKind = payload.kind;
      row.payload = payload;
      return { ...row };
    },
    async supersedeDecision(orgId, userId, id, args) {
      const prior = decisions.get(id);
      if (!prior) throw new NotFoundError("idg_decision");
      const priorMeeting = meetingOf(orgId, prior.meetingId);
      if (args.callerLocationIds && !args.callerLocationIds.includes(priorMeeting.locationId)) {
        throw new NotFoundError("idg_decision");
      }
      const target = meetingOf(orgId, args.meetingId);
      // GAP-043: the successor lands in a LATER, LIVE, QUORATE meeting; the quorum is computed from the target
      // meeting's stored attendance (never asserted, never copied from the prior row). Also raises
      // DECISION_SUPERSEDED / DECISION_NOT_OPEN (only an `emitted` decision may be superseded, §2.8).
      const plan = planDecisionSupersedeInto({
        priorStatus: prior.status,
        priorMeetingStart: priorMeeting.scheduledStart,
        target: {
          isLive: target.status === "live",
          scheduledStart: target.scheduledStart,
          patientIncluded:
            prior.patientId === null || target.includedPatientIds.has(prior.patientId),
          presentDisciplines: presentDisciplinesFor(target.id),
        },
      });
      const newId = nextId("idg-dec");
      decisions.set(newId, {
        id: newId,
        meetingId: target.id,
        patientId: prior.patientId,
        agendaItemId: null,
        recordedByMembershipId: userId,
        recordedAt: now(),
        decisionKind: prior.decisionKind,
        payload: prior.payload,
        status: "open",
        version: 0,
        wasQuorate: plan.wasQuorate,
        quorumSnapshot: plan.quorumSnapshot,
        supersededByDecisionId: null,
      });
      prior.status = "superseded";
      prior.supersededByDecisionId = newId;
      return { ...prior };
    },

    /** Metadata projection — `payload` and `quorumSnapshot` are deliberately NOT returned (§3.3). */
    async listDecisions(orgId, meetingId) {
      meetingOf(orgId, meetingId);
      return [...decisions.values()]
        .filter((d) => d.meetingId === meetingId)
        .map((d) => ({
          id: d.id,
          meetingId: d.meetingId,
          patientId: d.patientId,
          agendaItemId: d.agendaItemId,
          decisionKind: d.decisionKind,
          status: d.status,
          wasQuorate: d.wasQuorate,
          recordedByMembershipId: d.recordedByMembershipId,
          recordedAt: d.recordedAt,
          supersededByDecisionId: d.supersededByDecisionId,
          version: d.version,
        }));
    },

    // ── action items ─────────────────────────────────────────────────────────────────────────────────────
    async createActionItem(orgId, _userId, meetingId, args) {
      meetingOf(orgId, meetingId);
      planActionItemCreate();
      const id = nextId("idg-act");
      const row: ActionItemRow = {
        id,
        meetingId,
        decisionId: args.decisionId ?? null,
        patientId: args.patientId,
        assignedToMembershipId: args.assignedToMembershipId,
        status: "open",
        dueDate: args.dueDate,
        linkedArtifactKind: args.linkedArtifactKind ?? null,
        linkedArtifactId: args.linkedArtifactId ?? null,
        version: 0,
      };
      actionItems.set(id, row);
      emit("m14.action_item.created", {
        actionItemId: id,
        meetingId,
        decisionId: row.decisionId,
        patientId: row.patientId,
        assignedToMembershipId: row.assignedToMembershipId,
        dueDate: row.dueDate,
      });
      return { ...row };
    },
    async updateActionItem(
      orgId,
      userId,
      id,
      status,
      isCoordinator = false,
      expectedVersion?: number,
    ) {
      const row = actionItems.get(id);
      if (!row) throw new NotFoundError("idg_action_item");
      meetingOf(orgId, row.meetingId);
      if (!isCoordinator && row.assignedToMembershipId !== userId)
        throw actionItemNotAssigneeError();
      if (expectedVersion !== undefined) assertNoteVersion(expectedVersion, row.version);
      const t = transitionActionItem(row.status, { type: PATCH_STATUS_EVENT[status] });
      const from = row.status;
      row.status = t.to;
      row.version += 1;
      emit("m14.action_item.status_changed", {
        actionItemId: id,
        fromStatus: from,
        toStatus: row.status,
      });
      return { ...row };
    },
    async removeActionItem(orgId, _userId, id, expectedVersion) {
      const row = actionItems.get(id);
      if (!row) throw new NotFoundError("idg_action_item");
      if (meetingOf(orgId, row.meetingId).status === "adjourned")
        throw actionItemMeetingAdjournedError();
      if (expectedVersion !== undefined) assertNoteVersion(expectedVersion, row.version);
      actionItems.delete(id);
      return { id, removed: true };
    },
    async listActionItems(orgId, q, scope) {
      return [...actionItems.values()]
        .filter((a) => {
          const m = meetings.get(a.meetingId);
          if (!m || m.organizationId !== orgId) return false;
          if (a.assignedToMembershipId !== scope.assigneeMembershipId) return false;
          if (scope.locationIds !== null && !scope.locationIds.includes(m.locationId)) return false;
          if (
            a.patientId !== null &&
            scope.patientIds !== null &&
            !scope.patientIds.includes(a.patientId)
          )
            return false;
          if (q.status !== undefined && a.status !== q.status) return false;
          return true;
        })
        .map((a) => ({ ...a }));
    },

    // ── discipline notes ─────────────────────────────────────────────────────────────────────────────────
    async listDisciplineNotes(orgId, meetingId, q, viewer) {
      meetingOf(orgId, meetingId);
      const rows = [...notes.values()]
        .filter((n) => n.meetingId === meetingId)
        .filter((n) => q.patientId === undefined || n.patientId === q.patientId)
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
      const packets = packetSeeds.get(meetingId) ?? {};
      const allowed = new Map<string, boolean>();
      for (const n of rows) {
        if (n.patientId === null || allowed.has(n.patientId)) continue;
        const cover = (
          packets[n.patientId]?.builtSnapshot as
            | { patientCover?: { activeSudFlag?: unknown } }
            | undefined
        )?.patientCover;
        // The slice mirrors the DB rule: flagged, or no packet to vouch for the patient => needs a release.
        const needsRelease = cover === undefined || cover.activeSudFlag !== false;
        allowed.set(
          n.patientId,
          needsRelease ? (viewer ? await viewer.sudDisclosureAllowed(n.patientId) : false) : true,
        );
      }
      return rows.map((n) => {
        const withheld = n.patientId !== null && allowed.get(n.patientId) === false;
        return toNoteView(n, withheld);
      });
    },
    async createDisciplineNote(orgId, actor, meetingId, args) {
      const m = meetingOf(orgId, meetingId);
      const at = now();
      const patientId = args.patientId ?? null;
      const plan = planDisciplineNoteCreate({
        status: m.status,
        adjournedAt: m.adjournedAt === null ? null : new Date(m.adjournedAt),
        now: new Date(at),
        reason: args.reason,
        patientId,
        newerAdjournedIdgForPatient: patientId !== null && newerAdjournedFor(m, patientId),
      });
      if (patientId !== null && !m.includedPatientIds.has(patientId)) throw noteInclusionError();
      assertMayWriteDisciplineNote(
        actor,
        args.discipline,
        [...attendance.values()].filter((a) => a.meetingId === meetingId),
      );
      const row: NoteRow = {
        // A real uuid: `PATCH /idg/discipline-notes/:id` validates its param as one (the other slice ids are not).
        id: crypto.randomUUID(),
        meetingId,
        patientId,
        discipline: args.discipline,
        bodyText: args.bodyText,
        authorMembershipId: actor.membershipId,
        version: 0,
        createdAt: at,
        updatedAt: at,
        isAddendum: plan.isAddendum,
        addendumRecordedAt: plan.addendumRecordedAt === null ? null : at,
        reason: plan.reason,
      };
      notes.set(row.id, row);
      const min = plan.isAddendum ? minutes.get(meetingId) : undefined;
      if (min) {
        // Slice parity with the DB backend's `m14.discipline_note.addendum_recorded` (the render appendix is
        // built from live rows there; the slice records only the identity fields).
        emit("m14.discipline_note.addendum_recorded", {
          minutesId: min.id,
          meetingId,
          addendumId: row.id,
          addendumCount: [...notes.values()].filter(
            (n) => n.meetingId === meetingId && n.isAddendum,
          ).length,
          recordedByMembershipId: actor.membershipId,
        });
      }
      return toNoteView(row, false);
    },
    async updateDisciplineNote(orgId, actor, id, patch, ifMatchVersion) {
      const row = notes.get(id);
      if (!row) throw new NotFoundError("idg_discipline_note");
      const m = meetingOf(orgId, row.meetingId);
      if (row.isAddendum) throw addendumImmutableError();
      if (m.status !== "live") throw noteFrozenError();
      assertMayWriteDisciplineNote(
        actor,
        row.discipline,
        [...attendance.values()].filter((a) => a.meetingId === row.meetingId),
      );
      if (!actor.isCoordinator && row.authorMembershipId !== actor.membershipId) {
        throw new ForbiddenError("only the note's author or a coordinator may edit it");
      }
      assertNoteVersion(ifMatchVersion, row.version);
      if (patch.bodyText !== undefined) row.bodyText = patch.bodyText;
      if (patch.reason !== undefined) row.reason = normalizeNoteReason(patch.reason);
      row.version += 1;
      row.updatedAt = now();
      return toNoteView(row, false);
    },
    async disciplineNoteMeetingId(orgId, id) {
      const row = notes.get(id);
      if (!row) return null;
      const m = meetings.get(row.meetingId);
      return m && m.organizationId === orgId ? row.meetingId : null;
    },
    async decisionMeetingId(orgId, id) {
      const row = decisions.get(id);
      if (!row) return null;
      const m = meetings.get(row.meetingId);
      return m && m.organizationId === orgId ? row.meetingId : null;
    },
    async scopedChildFacts(orgId, kind, id) {
      const child =
        kind === "agenda_item"
          ? agenda.get(id)
          : kind === "attendance"
            ? attendance.get(id)
            : kind === "decision"
              ? decisions.get(id)
              : kind === "action_item"
                ? actionItems.get(id)
                : kind === "discipline_note"
                  ? notes.get(id)
                  : [...minutes.values()].find((row) => row.id === id);
      if (!child) return null;
      const meeting = meetings.get(child.meetingId);
      if (!meeting || meeting.organizationId !== orgId) return null;
      const patientId =
        "patientId" in child && typeof child.patientId === "string" ? child.patientId : null;
      const assignedToMembershipId =
        "assignedToMembershipId" in child && typeof child.assignedToMembershipId === "string"
          ? child.assignedToMembershipId
          : null;
      return {
        meetingId: child.meetingId,
        locationId: meeting.locationId,
        patientId,
        assignedToMembershipId,
      };
    },
    async recurringPolicyLocationId(orgId, id) {
      const row = policies.get(id);
      return row?.organizationId === orgId ? row.locationId : null;
    },

    // ── minutes ──────────────────────────────────────────────────────────────────────────────────────────
    async getMinutes(orgId, meetingId) {
      const mtg = meetingOf(orgId, meetingId);
      const row = ensureMinutes(meetingId);
      const finalizerAttendance =
        row.finalizedByMembershipId === null
          ? undefined
          : [...attendance.values()].find(
              (a) => a.meetingId === meetingId && a.membershipId === row.finalizedByMembershipId,
            );
      return {
        ...row,
        disciplineAddendumCount: [...notes.values()].filter(
          (n) => n.meetingId === meetingId && n.isAddendum,
        ).length,
        addendumState: deriveAddendumState({
          status: mtg.status,
          adjournedAt: mtg.adjournedAt === null ? null : new Date(mtg.adjournedAt),
          now: new Date(now()),
          supersededPatientIds: [...mtg.includedPatientIds].filter((p) =>
            newerAdjournedFor(mtg, p),
          ),
        }),
        renderStatus: minutesRenderStatus(row.status, row.minutesDocumentId),
        finalizedByDiscipline: finalizerAttendance?.discipline ?? null,
      };
    },
    async submitAmendment(orgId, _userId, minutesId, _amendmentReason) {
      const row = minutesById.get(minutesId);
      if (!row) throw new NotFoundError("idg_minutes");
      meetingOf(orgId, row.meetingId);
      // §2.6 D10 — an amendment applies ONLY to `final` minutes (the original row is never edited in place;
      // the amendment workflow is the post-adjournment correction path). `planMinutesAmendmentRequest` raises
      // MINUTES_NOT_IN_PROGRESS when the minutes are not yet final.
      planMinutesAmendmentRequest(row.status);
      const amendmentId = nextId("idg-amd");
      emit("m14.minutes.amended", { amendmentId, minutesId });
      return { amendmentId, minutesId };
    },

    // ── IdgAbacResolver (§4.7) ───────────────────────────────────────────────────────────────────────────
    async loadMeetingScope(orgId, meetingId): Promise<MeetingScopeFacts | null> {
      const m = meetings.get(meetingId);
      if (!m || m.organizationId !== orgId) return null;
      return { organizationId: m.organizationId, locationId: m.locationId };
    },
    async loadPresentDisciplines(orgId, meetingId): Promise<readonly string[] | null> {
      const m = meetings.get(meetingId);
      if (!m || m.organizationId !== orgId) return null;
      return presentDisciplinesFor(meetingId);
    },
    async loadReviewFloorBreaches(orgId, meetingId): Promise<readonly ReviewFloorBreachFact[]> {
      const m = meetings.get(meetingId);
      if (!m || m.organizationId !== orgId) return [];
      return reviewFloorBreaches[meetingId] ?? [];
    },
  };

  // Expose the recorded-event log + the quorum helper for the slice/tests (drainable, deterministic).
  // Declared as `IdgBackendInspect` and folded into the RETURN TYPE (the M22 `DocumentBackendInspect`
  // precedent). It used to be an untyped `Object.assign` under a `IdgRouteService & IdgAbacResolver`
  // annotation, which widens back to the annotation: both members existed at runtime and neither was
  // visible to a caller, so the acceptance suite's ~10 `svc.drainEvents()` / `svc.currentQuorum()` calls
  // were only ever legal because nothing typechecked that file (F-098).
  const inspect: IdgBackendInspect = {
    drainEvents: () => events.splice(0, events.length),
    currentQuorum: (meetingId) => evaluateQuorum(presentDisciplinesFor(meetingId)),
  };
  return Object.assign(service, inspect);
}
