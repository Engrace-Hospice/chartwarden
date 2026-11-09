// apps/backend/src/modules/16-bereavement/routes/group-service.ts — the support-group service interface (ADR-0109 D10, PR 3, routes 53-66).
//
// Owner decisions (2026-11-05): a group is recurring or drop-in, in person or virtual, for PROGRAM families only (an active plan, an active contact,
// no open full / pause opt-out), facilitated by staff or by a volunteer who passes the 418.78 gates. Attendance writes a contact-log ACTIVITY row
// (`support_group_session`, outcome `attended`) and satisfies NO cadence item.
//
// The views carry ids, enum tokens, counts and the agency's own wording. A roster names the contact by the display name M16 already stores; a
// VOLUNTEER facilitator's roster is the reduced projection (display name, enrollment status, attended): no relationship, no plan.
import type {
  BereavedContactRelationship,
  BereavementGroupEnrollmentStatus,
  BereavementGroupFacilitatorKind,
  BereavementGroupFormat,
  BereavementGroupRecurrence,
  BereavementGroupSessionStatus,
  BereavementGroupStatus,
  BereavementGroupWithdrawnReason,
  BereavementProgramModality,
} from "@chartwarden/types";
import type { M16ReadActor, M16WriteActor } from "./actor";
import type { CursorPage } from "./concurrency";

export interface GroupView {
  readonly groupId: string;
  readonly name: string;
  readonly description: string | null;
  readonly format: BereavementGroupFormat;
  readonly modality: BereavementProgramModality;
  readonly enrollmentRequired: boolean;
  readonly facilitatorKind: BereavementGroupFacilitatorKind;
  /** Membership ids. */
  readonly facilitatorUserId: string;
  readonly coFacilitatorUserId: string | null;
  readonly capacity: number | null;
  readonly status: BereavementGroupStatus;
  readonly recurrence: BereavementGroupRecurrence | null;
  readonly timezone: string;
  readonly venueText: string | null;
  /** True when a virtual meeting link is stored (the link itself is only on the detail read). */
  readonly hasJoinUrl: boolean;
  readonly enrolledCount: number;
  /** The next scheduled session's start, if any. */
  readonly nextSessionAt: string | null;
  readonly openedAt: string | null;
  readonly closedAt: string | null;
  /** The `If-Match` token. */
  readonly version: number;
  readonly createdAt: string;
}

/** The detail read adds the decrypted meeting link (staff-facing: the facilitators send it to families). */
export interface GroupDetailView extends GroupView {
  readonly joinUrl: string | null;
}

export interface ListGroupsInput {
  readonly status?: BereavementGroupStatus | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

/** Create / edit input. `joinUrl` undefined = keep (edit) or none (create); null = clear. */
export interface GroupFieldsInput {
  readonly name: string;
  readonly description: string | null;
  readonly modality: BereavementProgramModality;
  readonly enrollmentRequired: boolean;
  readonly facilitatorKind: BereavementGroupFacilitatorKind;
  readonly facilitatorUserId: string;
  readonly coFacilitatorUserId: string | null;
  readonly capacity: number | null;
  readonly timezone: string;
  readonly venueText: string | null;
  readonly joinUrl?: string | null | undefined;
}

export interface CreateGroupInput extends GroupFieldsInput {
  readonly format: BereavementGroupFormat;
  /** Required for `recurring`, refused for `drop_in`. */
  readonly recurrence: BereavementGroupRecurrence | null;
}

export interface UpdateGroupInput extends GroupFieldsInput {
  readonly expectedVersion: number;
  /** A recurring group's schedule may change while it is a draft (its sessions are materialized at open). */
  readonly recurrence?: BereavementGroupRecurrence | undefined;
}

export interface GroupSessionView {
  readonly sessionId: string;
  readonly groupId: string;
  readonly sessionNo: number;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly status: BereavementGroupSessionStatus;
  readonly attendeeCount: number;
  readonly version: number;
}

/** One roster line. The staff projection adds relationship and plan; the volunteer one omits them (absent, not null). */
export interface GroupRosterEntry {
  readonly contactId: string;
  readonly displayName: string;
  readonly enrollmentStatus: BereavementGroupEnrollmentStatus;
  readonly attendedSessions: number;
  readonly relationshipCode?: BereavedContactRelationship;
  readonly planId?: string;
}

export interface GroupRosterView {
  readonly groupId: string;
  /** `volunteer` = the reduced projection (D10). */
  readonly projection: "staff" | "volunteer";
  readonly entries: readonly GroupRosterEntry[];
}

export interface GroupEnrollmentView {
  readonly enrollmentId: string;
  readonly groupId: string;
  readonly groupName: string;
  readonly groupStatus: BereavementGroupStatus;
  readonly contactId: string;
  readonly status: BereavementGroupEnrollmentStatus;
  readonly withdrawnReason: BereavementGroupWithdrawnReason | null;
  readonly enrolledAt: string;
  readonly withdrawnAt: string | null;
}

export interface AttendanceResultView {
  readonly sessionId: string;
  /** Contacts newly recorded by this call. */
  readonly recordedCount: number;
  /** Contacts that were already recorded (a retry is a no-op for them). */
  readonly alreadyRecordedCount: number;
  /** Everyone now recorded for the session. */
  readonly attendeeCount: number;
}

export interface M16GroupService {
  /** Route 53 — groups, newest first (cursor-paginated). */
  listGroups(actor: M16ReadActor, input: ListGroupsInput): Promise<CursorPage<GroupView>>;
  /** Route 55 — one group (with its meeting link); null = absent. */
  getGroup(actor: M16ReadActor, groupId: string): Promise<GroupDetailView | null>;
  /** Route 54 — a draft group. */
  createGroup(actor: M16WriteActor, input: CreateGroupInput): Promise<GroupDetailView>;
  /** Route 56 — edit a draft or open group. */
  updateGroup(
    actor: M16WriteActor,
    groupId: string,
    input: UpdateGroupInput,
  ): Promise<GroupDetailView>;
  /** Route 57 — draft -> open; a recurring group's sessions are materialized; a volunteer facilitator must pass the 418.78 gates now. */
  openGroup(
    actor: M16WriteActor,
    groupId: string,
    input: { readonly expectedVersion: number },
  ): Promise<GroupDetailView>;
  /** Route 58 — open | draft -> completed | cancelled: live enrollments are withdrawn (`group_ended`), future sessions cancelled. */
  closeGroup(
    actor: M16WriteActor,
    groupId: string,
    input: { readonly expectedVersion: number; readonly status: "completed" | "cancelled" },
  ): Promise<GroupDetailView>;
  /** Route 59 — every session, by start. null = the group is absent. */
  listSessions(actor: M16ReadActor, groupId: string): Promise<GroupSessionView[] | null>;
  /** Route 60 — add one session (a drop-in meeting, or an extra meeting of a recurring group). */
  addSession(
    actor: M16WriteActor,
    groupId: string,
    input: { readonly startsAt: string; readonly endsAt: string },
  ): Promise<GroupSessionView>;
  /** Route 61 — cancel a scheduled session. */
  cancelSession(
    actor: M16WriteActor,
    groupId: string,
    sessionId: string,
    input: { readonly expectedVersion: number },
  ): Promise<GroupSessionView>;
  /** Route 62 — the roster of live program families (staff or volunteer projection). null = the group is absent. */
  roster(actor: M16ReadActor, groupId: string): Promise<GroupRosterView | null>;
  /** Route 63 — enroll a program contact. */
  enroll(actor: M16WriteActor, groupId: string, contactId: string): Promise<GroupEnrollmentView>;
  /** Route 64 — withdraw a contact's live enrollment. */
  withdraw(
    actor: M16WriteActor,
    groupId: string,
    contactId: string,
    input: { readonly reason: "requested" | "staff_removed" },
  ): Promise<GroupEnrollmentView>;
  /** Route 65 — record who attended a session (idempotent per contact); each new attendee gets a contact-log activity row. */
  recordAttendance(
    actor: M16WriteActor,
    groupId: string,
    sessionId: string,
    contactIds: readonly string[],
  ): Promise<AttendanceResultView>;
  /** Route 66 — one contact's enrollments (live and past). null = the contact is absent or out of reach. */
  contactEnrollments(actor: M16ReadActor, contactId: string): Promise<GroupEnrollmentView[] | null>;
}
