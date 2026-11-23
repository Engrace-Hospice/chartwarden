// packages/types/src/idg-follow-up.ts — the M14 IDG action-item read the visit-note draft consumes (ADR-0114 S5b, VN-D64 to VN-D69). Split out of `idg.ts`
// to keep it under the file-size ceiling; the package index re-exports it, so importers of `@chartwarden/types` are unchanged. Type-only and leaf-safe: M8,
// which M14 depends on, reads M14 through the M1 seam registry and never imports it.
import type { PatientId } from "./admission";
import type { IsoInstant, MembershipId } from "./care-plan";
import type { IdgActionItemId, IdgActionItemStatus, IdgDecisionKind } from "./idg";

/** The session identity a follow-up read is made for: the M39 Part 2 verdict is asked as this member (never request input). */
export interface IdgFollowUpViewer {
  readonly roles: readonly string[];
  /** The viewer's ACTIVE membership id, or `null` when the session carries none (the read then answers nothing). */
  readonly membershipId: MembershipId | null;
}

/**
 * One IDG action item a visit may follow up (ADR-0114 S5b, VN-D65): FACTS ONLY. The item's title, its body and the decision's payload (the team's narrative)
 * never cross: the note states the meeting date, a fixed label for the decision kind and the due date.
 */
export interface IdgFollowUpItem {
  readonly actionItemId: IdgActionItemId;
  /** When the meeting the decision was made at took place (its actual start; its scheduled start when none was recorded). */
  readonly meetingAt: IsoInstant;
  readonly decisionKind: IdgDecisionKind;
  /** The item's due date, or `null` when it has none. */
  readonly dueAt: IsoInstant | null;
  /**
   * The item's status. `openFollowUpItems` hands over `open` and `in_progress` only; `linkedFollowUpItem` hands over the real status, because the item a visit
   * is linked to may have closed since (M14 closes an encounter-kind item when its assignee signs ANY visit, `m8.encounter.signed`).
   */
  readonly status: IdgActionItemStatus;
  /** True when the patient's team record may hold 42 CFR Part 2 content (the viewer was cleared for it): whatever is drafted from the item files as Part 2. */
  readonly sudRelated: boolean;
}

/**
 * §4.8 (S5b) — the open IDG action items a visit's author may follow up (consumed by M8's visit-note draft). Leaf-typed so M8, which M14 depends on, reads
 * M14 through the registry and never imports it.
 */
export interface IdgFollowUpReader {
  /**
   * The patient's OPEN or IN-PROGRESS action items that are assigned to the viewer's own membership and linked to an encounter (the kind M14 closes when the
   * assignee signs a visit), newest meeting first, as the viewer may read them. Org-explicit: self-scopes under `organizationId`'s tenant context.
   * 42 CFR Part 2 (W-SUD-01) is decided here, per viewer: for a patient with an active SUD flag, or none the meeting's packet vouches for, a viewer M39 does
   * not clear is handed NOTHING (no item, no count). An item with no recorded decision is not listed (its kind cannot be stated). Throws when a read fails,
   * so a consumer fails closed rather than drafting from a guess.
   */
  openFollowUpItems(query: {
    readonly organizationId: string;
    readonly patientId: PatientId;
    readonly viewer: IdgFollowUpViewer;
  }): Promise<readonly IdgFollowUpItem[]>;

  /**
   * The ONE action item a visit is linked to, by id, in ANY status (completed, cancelled and auto-closed too), for the viewer's own membership and the patient:
   * the draft states the item the author linked and confirmed, which M14's own auto-close may have closed since. The same facts, and the same per-viewer Part 2
   * verdict, as `openFollowUpItems`; `null` when the item is absent, not assigned to the viewer, another patient's or organization's, has no recorded decision, or
   * is Part 2 and the viewer is not cleared. Throws when a read fails.
   */
  linkedFollowUpItem(query: {
    readonly organizationId: string;
    readonly patientId: PatientId;
    readonly actionItemId: IdgActionItemId;
    readonly viewer: IdgFollowUpViewer;
  }): Promise<IdgFollowUpItem | null>;
}
