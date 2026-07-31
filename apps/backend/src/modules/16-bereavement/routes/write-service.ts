// apps/backend/src/modules/16-bereavement/routes/write-service.ts — the M16 WRITE service interface
// (the §4.1 POST/PATCH surface) + the transactional-outbox port.
//
// Every command runs under `withOrgContext` (RLS), decides through the PURE §2.2–§2.4 machines in
// `../lifecycle` (no business rule lives in the SQL layer), stamps the SERVER-assembled acting membership,
// and emits its §4.4 `m16.*` event on the caller's own transaction through the injected
// {@link WriteOutboxPort} — the transactional outbox, so an event can never describe a write that rolled
// back. The M22 sympathy-letter / anniversary-card render is exactly that handshake (D14): M16 emits
// `m16.bereavement.outreach_artifact_requested`, M22 owns the render and answers with
// `m22.document.rendered`.
//
// Optimistic concurrency is §2.5: every PATCH / state transition carries `expectedVersion` (the `If-Match`
// header) and a mismatch raises `STALE_VERSION` → 412 with the current row.
import type { BereavementSideEffect } from "../lifecycle/index";
import type { M16MutatingActor, M16WriteActor } from "./actor";
import type {
  BereavedContactRowView,
  BereavementClosureView,
  BereavementOutreachRowView,
  BereavementPlanDetail,
  BereavementRiskScoreView,
} from "./read-service";

/** A §4.4 `m16.*` transactional-outbox emission. PHI-free by construction (§8.1 payload scrubbing). */
export interface OutboxEmission {
  readonly eventName: string;
  readonly payload: Record<string, unknown>;
  readonly aggregateKind?: string;
  readonly aggregateId?: string;
}

/**
 * The transactional-outbox port (the composition root binds the catalog-validating M1 publisher pinned to
 * callerModule `m16`); `publish` writes the `outbox_event` row on the CALLER'S tx (same unit of work).
 * The default is a no-op so the slice/tests run without a dispatcher.
 */
export interface WriteOutboxPort {
  publish(tx: unknown, emission: OutboxEmission): Promise<void>;
}

/**
 * The §4.10 M36 alert port. §2.6 declares an alert as an EFFECT (`{kind:'alert', alert:<discriminator>}`);
 * the service resolves the rest of the typed payload and hands it here. Unbound ⇒ the alert is dropped
 * with the mutation still committing: a bereavement touchpoint must not roll back because a notification
 * channel is down, and M36's own retry/DLQ owns delivery.
 */
export interface AlertPort {
  emit(input: {
    readonly organizationId: string;
    readonly kind: string;
    readonly payload: Record<string, unknown>;
  }): Promise<void>;
}

/** Route 3 — initial counselor assignment (§7.2). */
export interface AssignCounselorInput {
  readonly expectedVersion?: number;
  readonly counselorUserId: string;
  readonly effectiveAt?: string;
}

/** Route 4 — volunteer assignment; the 418.78 gates resolve through M15's seam, never the body. */
export interface AssignVolunteerInput {
  readonly expectedVersion?: number;
  readonly volunteerUserId: string;
  readonly effectiveAt?: string;
}

/** One counselor-supplied roster addition (§4.2 `SeedRosterAndScheduleBody.additionalContacts[]`). */
export interface ContactDraftInput {
  readonly displayName: string;
  readonly relationshipCode: string;
  readonly email?: string;
  readonly phone?: string;
  readonly mailingAddress?: string;
  readonly preferredLanguageIso639?: string;
  readonly consentRecordId?: string;
  readonly outreachPreferences?: { readonly allowedKinds: readonly string[] };
}

/** Route 5 — seed the roster + materialize the D4 schedule and open the program. */
export interface SeedRosterAndScheduleInput {
  readonly expectedVersion?: number;
  /** Pull the M5 caregiver rows for the decedent's admission (defaults true, per §4.2). */
  readonly seedFromCaregivers?: boolean;
  readonly additionalContacts?: readonly ContactDraftInput[];
}

/** Route 6 — pause (a pause without a recorded reason is a lapse, §2.2). */
export interface PausePlanInput {
  readonly expectedVersion?: number;
  readonly pauseKind: string;
  readonly reason: string;
}

/** Route 7 — resume; the forward schedule regenerates FROM NOW, never replayed from the death date. */
export interface ResumePlanInput {
  readonly expectedVersion?: number;
}

/** Route 8 — D7 early close (≥40-char narrative; the cosign lands on route 9). */
export interface CloseEarlyInput {
  readonly expectedVersion?: number;
  readonly reason: string;
  readonly narrative: string;
}

/** Route 9 — the clinical-supervisor cosign that ratifies a pending early close. */
export interface CosignCloseInput {
  readonly expectedVersion?: number;
  readonly attestation?: string;
}

/** Routes 11 — add one bereaved contact to an open plan. */
export interface CreateContactInput extends ContactDraftInput {}

/** Route 12 — preferences / channels (`If-Match` required). */
export interface UpdateContactInput {
  readonly expectedVersion?: number;
  readonly displayName?: string;
  readonly email?: string | null;
  readonly phone?: string | null;
  readonly mailingAddress?: string | null;
  readonly preferredLanguageIso639?: string;
  readonly outreachPreferences?: { readonly allowedKinds: readonly string[] };
  readonly volunteerVisibleOnly?: boolean;
}

/** Route 13 — proposed → active (the D6 consent verdict is resolved server-side, fail-CLOSED). */
export interface ConfirmContactInput {
  readonly expectedVersion?: number;
  readonly consentRecordId?: string;
}

/** Route 14 — per-contact opt-out (D9). */
export interface OptOutInput {
  readonly expectedVersion?: number;
  readonly optOutKind: string;
  readonly channelKinds?: readonly string[];
  readonly reason?: string;
  readonly sourceKind: string;
}

/** Route 15 — undo an opt-out inside the D9 window (or by a counselor, with a reason). */
export interface RescindOptOutInput {
  readonly expectedVersion?: number;
  readonly reason?: string;
}

/** Route 16 — the survivor themselves died (verified date + source, §2.3). */
export interface MarkDeceasedInput {
  readonly expectedVersion?: number;
  readonly deceasedAt: string;
  readonly deathSource: string;
}

/** Route 17 — accept the 3-strikes unreachable proposal. */
export interface MarkUnreachableInput {
  readonly expectedVersion?: number;
  readonly note?: string;
}

/** Route 18 — §7.7 complicated-grief referral out of the program. */
export interface FlagComplicatedGriefInput {
  readonly expectedVersion?: number;
  readonly externalResourceId: string;
  readonly pg13Score?: number;
  readonly ipgrScore?: number;
  readonly note?: string;
}

/** Route 21 — the D15-discriminated completion. */
export interface CompleteOutreachInput {
  readonly expectedVersion?: number;
  readonly kind: string;
  readonly outcome: string;
  readonly contactResponded: boolean;
  /** Required for `in_person_visit`, FORBIDDEN for every other kind (D15). */
  readonly sourceEncounterId?: string;
  readonly artifactDocumentId?: string;
  readonly notes?: string;
}

/** Routes 22 / 23 — the two fixed-outcome completions. */
export interface OutreachOutcomeInput {
  readonly expectedVersion?: number;
  readonly notes?: string;
}

/** Route 24 — cancel a scheduled touchpoint. */
export interface CancelOutreachInput {
  readonly expectedVersion?: number;
  readonly reason: string;
}

/** Route 25 — missed → in_progress inside the 7-day grace. */
export interface LateAttemptInput {
  readonly expectedVersion?: number;
}

/** Route 26 — an ad-hoc contact-log row for a touchpoint that had no scheduled outreach. */
export interface LogDirectContactInput {
  readonly kind: string;
  readonly outcome: string;
  readonly contactAt: string;
  readonly contactResponded: boolean;
  readonly artifactDocumentId?: string | null;
  readonly notes?: string;
}

/** Route 27 — regenerate the FORWARD schedule. */
export interface RegenerateScheduleInput {
  readonly expectedVersion?: number;
  readonly contactId?: string;
  readonly fromAt?: string;
}

/** Route 28 — recompute the deterministic score (+ the `ai.full`-gated Layer 2 when requested). */
export interface RecomputeRiskInput {
  readonly bereavedContactId?: string;
  readonly requestAugmentation?: boolean;
  /** §7.3 — a counselor override needs BOTH the tier it lands on and a ≥40-char documented reason. */
  readonly overrideTier?: string;
  readonly overrideReason?: string;
}

/** Route 32 — log an external-resource referral WITHOUT ending the program for this survivor. */
export interface ReferExternalInput {
  readonly externalResourceId: string;
  readonly contactAt?: string;
  readonly notes?: string;
}

/** Route 33 — the D18-gated counselor first contact (§4.3.2). */
export interface InitiateContactInput {
  readonly contactId: string;
  readonly kind?: string;
}

/** The contact-log row an ad-hoc / referral write lands on. */
export interface BereavementContactLogView {
  readonly contactLogId: string;
  readonly planId: string;
  readonly contactId: string;
  readonly outreachId: string;
  readonly kind: string;
  readonly outcome: string;
  readonly contactAt: string;
  readonly artifactDocumentId: string | null;
}

/** Route 27's answer: what the regeneration actually materialized (never a bare 204). */
export interface ScheduleRegenerationView {
  readonly planId: string;
  readonly cancelledCount: number;
  readonly generatedCount: number;
  readonly outreach: readonly BereavementOutreachRowView[];
}

/** Route 5's answer: the opened plan plus what opening it produced. */
export interface PlanActivationView {
  readonly plan: BereavementPlanDetail;
  readonly contactsSeededCount: number;
  readonly outreachScheduledCount: number;
  readonly anniversaryRemindersCount: number;
  /** The §2.6 effect list the transition declared — the audit trail's own account of what ran. */
  readonly effects: readonly BereavementSideEffect["kind"][];
}

/** The §4.1 POST/PATCH surface. Implemented over Drizzle in prod (RLS-scoped per `withOrgContext`). */
export interface M16WriteService {
  assignCounselor(
    actor: M16WriteActor,
    planId: string,
    input: AssignCounselorInput,
  ): Promise<BereavementPlanDetail>;
  assignVolunteer(
    actor: M16WriteActor,
    planId: string,
    input: AssignVolunteerInput,
  ): Promise<BereavementPlanDetail>;
  seedRosterAndSchedule(
    actor: M16WriteActor,
    planId: string,
    input: SeedRosterAndScheduleInput,
  ): Promise<PlanActivationView>;
  pausePlan(
    actor: M16WriteActor,
    planId: string,
    input: PausePlanInput,
  ): Promise<BereavementPlanDetail>;
  resumePlan(
    actor: M16WriteActor,
    planId: string,
    input: ResumePlanInput,
  ): Promise<BereavementPlanDetail>;
  closeEarly(
    actor: M16WriteActor,
    planId: string,
    input: CloseEarlyInput,
  ): Promise<BereavementClosureView>;
  cosignClose(
    actor: M16WriteActor,
    planId: string,
    input: CosignCloseInput,
  ): Promise<BereavementClosureView>;
  createContact(
    actor: M16WriteActor,
    planId: string,
    input: CreateContactInput,
  ): Promise<BereavedContactRowView>;
  updateContact(
    actor: M16WriteActor,
    contactId: string,
    input: UpdateContactInput,
  ): Promise<BereavedContactRowView>;
  confirmContact(
    actor: M16WriteActor,
    contactId: string,
    input: ConfirmContactInput,
  ): Promise<BereavedContactRowView>;
  /** Routes 14 / 15 accept a PORTAL session, which carries no membership — hence `M16MutatingActor`. */
  optOutContact(
    actor: M16MutatingActor,
    contactId: string,
    input: OptOutInput,
  ): Promise<BereavedContactRowView>;
  rescindOptOut(
    actor: M16MutatingActor,
    contactId: string,
    input: RescindOptOutInput,
  ): Promise<BereavedContactRowView>;
  markContactDeceased(
    actor: M16WriteActor,
    contactId: string,
    input: MarkDeceasedInput,
  ): Promise<BereavedContactRowView>;
  markContactUnreachable(
    actor: M16WriteActor,
    contactId: string,
    input: MarkUnreachableInput,
  ): Promise<BereavedContactRowView>;
  flagComplicatedGrief(
    actor: M16WriteActor,
    contactId: string,
    input: FlagComplicatedGriefInput,
  ): Promise<BereavedContactRowView>;
  startOutreach(
    actor: M16WriteActor,
    outreachId: string,
    expectedVersion?: number,
  ): Promise<BereavementOutreachRowView>;
  completeOutreach(
    actor: M16WriteActor,
    outreachId: string,
    input: CompleteOutreachInput,
  ): Promise<BereavementOutreachRowView>;
  declineOutreach(
    actor: M16WriteActor,
    outreachId: string,
    input: OutreachOutcomeInput,
  ): Promise<BereavementOutreachRowView>;
  noResponseOutreach(
    actor: M16WriteActor,
    outreachId: string,
    input: OutreachOutcomeInput,
  ): Promise<BereavementOutreachRowView>;
  cancelOutreach(
    actor: M16WriteActor,
    outreachId: string,
    input: CancelOutreachInput,
  ): Promise<BereavementOutreachRowView>;
  lateAttemptOutreach(
    actor: M16WriteActor,
    outreachId: string,
    input: LateAttemptInput,
  ): Promise<BereavementOutreachRowView>;
  logDirectContact(
    actor: M16WriteActor,
    contactId: string,
    input: LogDirectContactInput,
  ): Promise<BereavementContactLogView>;
  regenerateSchedule(
    actor: M16WriteActor,
    planId: string,
    input: RegenerateScheduleInput,
  ): Promise<ScheduleRegenerationView>;
  recomputeRisk(
    actor: M16WriteActor,
    planId: string,
    input: RecomputeRiskInput,
  ): Promise<BereavementRiskScoreView>;
  referExternal(
    actor: M16WriteActor,
    contactId: string,
    input: ReferExternalInput,
  ): Promise<BereavementContactLogView>;
  initiateContact(
    actor: M16WriteActor,
    planId: string,
    input: InitiateContactInput,
  ): Promise<BereavementOutreachRowView>;
}
