// apps/backend/src/modules/08-encounters/drafting/draft-store.ts — what the visit-note draft's routes need of the M8 tables, as
// interfaces (S1 PR C2b1). The Drizzle implementation is db-draft-store.ts; the orchestration (resolve-section.ts, draft-service.ts)
// and its tests see only these, so neither needs a database.
import type { AuditContext } from "@chartwarden/audit";
import type { DraftSourceRef } from "@chartwarden/hearthnote";
import type { EncounterStatus } from "@chartwarden/types";
import type { DraftEncounter, DraftStorePorts } from "./ports";
import type { ConfirmationRecord } from "./section-state";

/** An encounter as the draft routes load it: the draft's projection plus the status and the siting the satellite rows copy. */
export interface DraftEncounterRow extends DraftEncounter {
  readonly status: EncounterStatus;
  readonly providerEntityId: string | null;
  readonly locationId: string | null;
}

/** One confirmation to keep (an upsert on encounter + section). `sourceRefs` are ids and kinds only, never text (VN-D7). */
export interface ConfirmationWrite extends ConfirmationRecord {
  readonly encounter: DraftEncounterRow;
  readonly edited: boolean;
  /** The compiler's Part 2 verdict on the section: the row's audit image withholds its source ids and files under the Part 2 class. */
  readonly part2Derived: boolean;
  readonly sourceRefs: readonly DraftSourceRef[];
  readonly resolvedByMembershipId: string;
  readonly resolvedAt: Date;
}

/** The five store ports the draft computation reads, plus the confirmation and care-plan-link reads and writes. */
export interface DraftStore extends DraftStorePorts {
  confirmations(encounterId: string): Promise<readonly ConfirmationRecord[]>;
  /** Sections where the clinician has put something of their own (a selected entry, or prose): the rubber-stamp indicator's input (VN-D18). */
  ownTextSectionIds(encounterId: string): Promise<ReadonlySet<string>>;
  saveConfirmation(write: ConfirmationWrite): Promise<void>;
  /** Idempotently links the care-plan elements among `refs`; returns how many links it wrote. */
  linkCarePlan(encounter: DraftEncounterRow, refs: readonly DraftSourceRef[]): Promise<number>;
  /** Removes the care-plan elements among `refs` from the encounter (soft-remove, or an already-removed tombstone); returns how many it changed. */
  removeCarePlan(
    encounter: DraftEncounterRow,
    refs: readonly DraftSourceRef[],
    removedByMembershipId: string,
    now: Date,
  ): Promise<number>;
}

/** The explicit audit event of one resolution (ids, enums and counts only). */
export interface DraftResolvedEvent {
  readonly encounterId: string;
  /** The addendum whose amended section was resolved (VN-D30); `null` for a note's own section. */
  readonly addendumId: string | null;
  readonly sectionId: string;
  readonly resolution: "confirmed" | "deselected";
  readonly edited: boolean;
  /** The hash the clinician saw (what the request carried and the server matched). */
  readonly contentHash: string;
  /**
   * The hash the stored confirmation is bound to; `null` when the section was left empty and there was no row to keep. A deselect that
   * emptied a section the clinician had resolved keeps that row withdrawn: this is then the hash no recomputed section can equal.
   */
  readonly boundContentHash: string | null;
  readonly corpusVersion: string;
  /** The section's Part 2 verdict: it selects the audit retention class and whether the source ids are recorded. */
  readonly part2Derived: boolean;
  readonly sourceRefs: readonly DraftSourceRef[];
  readonly carePlanElementsLinked: number;
  readonly carePlanElementsRemoved: number;
}

/** An addendum of the encounter as the amendment routes load it: its state, its author and the sections it names (VN-D30). */
export interface AmendmentRef {
  readonly id: string;
  readonly status: "draft" | "finalized" | "signed" | "voided";
  readonly authoredByMembershipId: string;
  /** The sections the addendum amends, by section id; empty for a free addendum. */
  readonly sectionIds: readonly string[];
}

/** Everything one request does inside one tenant transaction. */
export interface DraftUnit {
  /** Whether the tenant has the visit-note draft switched on (`isVisitNoteDraftEnabled`). */
  enabled(): Promise<boolean>;
  /**
   * The encounter, or `null` (absent or another tenant's). `forUpdate` locks the row (`FOR NO KEY UPDATE`), serializing the draft writes of
   * one encounter with each other and with finalize, sign, the picker and the selections save, which take the same lock first.
   */
  encounter(encounterId: string, forUpdate: boolean): Promise<DraftEncounterRow | null>;
  readonly store: DraftStore;
  recordResolved(event: DraftResolvedEvent): Promise<void>;
  /** The addendum of that encounter, or `null` (absent, another encounter's or another tenant's). */
  amendment(encounterId: string, addendumId: string): Promise<AmendmentRef | null>;
  /** `store` with the addendum's resolutions in place of the note's and no care-plan link changes (`createAmendmentDraftStore`). */
  amendmentStore(addendumId: string): DraftStore;
}

export interface DraftScope {
  readonly organizationId: string;
  /** The acting user, as the row triggers attribute the write. */
  readonly userId: string;
  readonly now: Date;
  /** The request's audit context; required by a write. */
  readonly audit?: AuditContext;
}

/** Runs `fn` inside one tenant transaction (`withOrgContext` in production). */
export type RunInOrg = <T>(scope: DraftScope, fn: (unit: DraftUnit) => Promise<T>) => Promise<T>;
