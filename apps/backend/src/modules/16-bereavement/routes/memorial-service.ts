// apps/backend/src/modules/16-bereavement/routes/memorial-service.ts — the memorial-service service interface (ADR-0109 D10, PR 3, routes 67-76).
//
// Owner decisions (2026-11-05): a memorial invites the families of deaths within `inviteWindowMonths` (default 12) of the service, program families
// only; RSVP by staff (phone) and by the family in the bereaved portal. Publishing selects the invitations set-based and drafts ONE
// `memorial_invitation` mailing run for the families who can receive post (the run is then worded, generated, downloaded and confirmed like any other
// mailing run). Attendance writes a contact-log ACTIVITY row (`memorial_service_attendance`) and satisfies no cadence item.
import type {
  BereavedContactRelationship,
  BereavementMemorialDelivery,
  BereavementMemorialInvitationStatus,
  BereavementMemorialRsvpResponse,
  BereavementMemorialRsvpSource,
  BereavementMemorialStatus,
  BereavementProgramModality,
} from "@chartwarden/types";
import type { M16ReadActor, M16WriteActor } from "./actor";
import type { CursorPage } from "./concurrency";

export interface MemorialRsvpCounts {
  readonly invited: number;
  readonly yes: number;
  readonly no: number;
  readonly maybe: number;
  readonly attended: number;
  readonly noShow: number;
  /** Guests the `yes` answers bring (people expected = yes + guestsExpected). */
  readonly guestsExpected: number;
}

export interface MemorialView {
  readonly serviceId: string;
  readonly title: string;
  readonly description: string | null;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly modality: BereavementProgramModality;
  readonly venueText: string | null;
  readonly hasJoinUrl: boolean;
  readonly capacity: number | null;
  /** `YYYY-MM-DD`; the portal stops taking answers after it. */
  readonly rsvpBy: string | null;
  readonly inviteWindowMonths: number;
  readonly status: BereavementMemorialStatus;
  readonly publishedAt: string | null;
  readonly invitedCount: number;
  readonly rsvpCounts: MemorialRsvpCounts;
  /** The invitation mailing run drafted at publish (null when nobody could receive post, or not yet published). */
  readonly mailingRunId: string | null;
  /** The `If-Match` token. */
  readonly version: number;
  readonly createdAt: string;
}

export interface MemorialDetailView extends MemorialView {
  readonly joinUrl: string | null;
}

export interface MemorialFieldsInput {
  readonly title: string;
  readonly description: string | null;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly modality: BereavementProgramModality;
  readonly venueText: string | null;
  /** Omit to keep (edit) / none (create); null clears. */
  readonly joinUrl?: string | null | undefined;
  readonly capacity: number | null;
  readonly rsvpBy: string | null;
  readonly inviteWindowMonths: number;
}

export interface ListMemorialsInput {
  readonly status?: BereavementMemorialStatus | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

/** One invitation on the oversight list (names the family by the display name M16 stores). */
export interface MemorialInvitationView {
  readonly invitationId: string;
  readonly serviceId: string;
  readonly contactId: string;
  readonly planId: string;
  readonly displayName: string;
  readonly relationshipCode: BereavedContactRelationship;
  readonly delivery: BereavementMemorialDelivery;
  readonly status: BereavementMemorialInvitationStatus;
  readonly guests: number;
  readonly rsvpSource: BereavementMemorialRsvpSource | null;
  readonly rsvpAt: string | null;
  readonly attendedAt: string | null;
  readonly version: number;
}

/** One contact's invitation, as their counselor sees it on the contact screen. */
export interface ContactMemorialInvitationView {
  readonly invitationId: string;
  readonly serviceId: string;
  readonly serviceTitle: string;
  readonly startsAt: string;
  readonly serviceStatus: BereavementMemorialStatus;
  readonly delivery: BereavementMemorialDelivery;
  readonly status: BereavementMemorialInvitationStatus;
  readonly guests: number;
  readonly rsvpSource: BereavementMemorialRsvpSource | null;
  readonly rsvpAt: string | null;
  readonly version: number;
}

export interface M16MemorialService {
  /** Route 67 — services, newest start first (cursor-paginated). */
  listMemorials(actor: M16ReadActor, input: ListMemorialsInput): Promise<CursorPage<MemorialView>>;
  /** Route 69 — one service with its link; null = absent. */
  getMemorial(actor: M16ReadActor, serviceId: string): Promise<MemorialDetailView | null>;
  /** Route 68 — a draft service. */
  createMemorial(actor: M16WriteActor, input: MemorialFieldsInput): Promise<MemorialDetailView>;
  /** Route 70 — edit a draft or published service (the invitation window is fixed once published). */
  updateMemorial(
    actor: M16WriteActor,
    serviceId: string,
    input: MemorialFieldsInput & { readonly expectedVersion: number },
  ): Promise<MemorialDetailView>;
  /** Route 71 — draft -> published: invitations set-based + the invitation mailing run. */
  publishMemorial(
    actor: M16WriteActor,
    serviceId: string,
    input: { readonly expectedVersion: number },
  ): Promise<MemorialDetailView>;
  /** Route 72 — published -> held (once started) | draft / published -> cancelled (its unmailed invitation run is cancelled too). */
  closeMemorial(
    actor: M16WriteActor,
    serviceId: string,
    input: { readonly expectedVersion: number; readonly status: "held" | "cancelled" },
  ): Promise<MemorialDetailView>;
  /** Route 73 — every invitation of a service, by name; null = the service is absent. */
  listInvitations(actor: M16ReadActor, serviceId: string): Promise<MemorialInvitationView[] | null>;
  /** Route 74 — a family's answer taken by phone. */
  recordStaffRsvp(
    actor: M16WriteActor,
    contactId: string,
    invitationId: string,
    input: { readonly response: BereavementMemorialRsvpResponse; readonly guests: number },
  ): Promise<ContactMemorialInvitationView>;
  /** Route 75 — attended (activity row) or a no-show, once the service has started. */
  recordAttendance(
    actor: M16WriteActor,
    serviceId: string,
    invitationId: string,
    input: { readonly attended: boolean },
  ): Promise<MemorialInvitationView>;
  /** Route 76 — one contact's invitations; null = the contact is absent. */
  contactInvitations(
    actor: M16ReadActor,
    contactId: string,
  ): Promise<ContactMemorialInvitationView[] | null>;
}
