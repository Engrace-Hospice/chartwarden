// apps/backend/src/modules/16-bereavement/routes/letter-service.ts — the physician condolence letter service interface (ADR-0109 D6,
// routes 38 / 39 / 40).
//
// A letter to the patient's INTERNAL attending clinician is created `pending_review` when the intake opens the plan. Bereavement
// oversight reviews it: approve (optionally with a short personal note and, when the care team resolved nobody, the internal
// clinician who should receive it) or decline with a documented reason. Approval emits `m16.bereavement.document_requested` in the
// same transaction; M22 renders it. Everything here is oversight-only (`org_scope_bereavement_oversight`), so no volunteer or portal
// shaping is needed.
import type { M16ReadActor, M16WriteActor } from "./actor";
import type { CursorPage } from "./concurrency";

export type PhysicianLetterStatus = "pending_review" | "approved" | "rendered" | "declined";

/** One physician letter as the review queue shows it. The sealed note is never returned, only whether one exists. */
export interface PhysicianLetterView {
  readonly letterId: string;
  readonly planId: string;
  readonly patientId: string;
  readonly status: PhysicianLetterStatus;
  /** Death + 2 days: past this a pending letter is overdue. */
  readonly dueAt: string;
  readonly createdAt: string;
  /** The internal clinician the letter goes to; null until the care team resolves one or the reviewer names one. */
  readonly attendingUserId: string | null;
  readonly hasPersonalNote: boolean;
  /** The redacted decline reason (declined letters only). */
  readonly declineReason: string | null;
  readonly reviewedAt: string | null;
  readonly renderedDocumentId: string | null;
  /** The `If-Match` token. */
  readonly version: number;
}

export interface ListPhysicianLettersInput {
  readonly status?: PhysicianLetterStatus | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

export interface ApprovePhysicianLetterInput {
  readonly expectedVersion: number;
  readonly personalNote?: string | undefined;
  readonly attendingUserId?: string | undefined;
}

export interface DeclinePhysicianLetterInput {
  readonly expectedVersion: number;
  readonly reason: string;
}

export interface M16LetterService {
  /** Route 38 — the review queue, oldest due first, cursor-paged. */
  listLetters(
    actor: M16ReadActor,
    input: ListPhysicianLettersInput,
  ): Promise<CursorPage<PhysicianLetterView>>;
  /** Route 38 — the plan's letter, or null when the plan has none (a plan opened before the letter existed). */
  getLetterForPlan(actor: M16ReadActor, planId: string): Promise<PhysicianLetterView | null>;
  /** Route 39 — pending_review -> approved, and the render request in the same transaction. */
  approveLetter(
    actor: M16WriteActor,
    letterId: string,
    input: ApprovePhysicianLetterInput,
  ): Promise<PhysicianLetterView>;
  /** Route 40 — pending_review -> declined with a documented reason. */
  declineLetter(
    actor: M16WriteActor,
    letterId: string,
    input: DeclinePhysicianLetterInput,
  ): Promise<PhysicianLetterView>;
}
