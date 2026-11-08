// apps/backend/src/modules/16-bereavement/routes/draft-service.ts — the pre-death risk-assessment draft service
// interface (ADR-0109 D5, routes 35 / 36).
//
// An MSW, chaplain or bereavement counselor on the patient's care team (or bereavement oversight) records the eight D17 risk
// factors for an ADMISSION before the death. The draft exists before any bereavement plan, so it is addressed by admission
// id, not plan id; the §4.8 `bereavement_pre_death_assessor` predicate is the route gate. Writable only while no plan exists
// for the admission; at plan seed the write service carries it into the initial score.
import type { RiskFactorWireKey } from "@chartwarden/bereavement";
import type {
  BereavementFactorValue,
  BereavementRiskFactorInputs,
  IsoInstant,
} from "@chartwarden/types";
import type { M16ReadActor, M16WriteActor } from "./actor";
import type { BereavementRedactedCategory } from "./disclosure";

/** Routes 35 / 36 — the draft as the web sees it: wire keys (the same shape the PUT body carries), eight tri-state values. */
export interface PreDeathDraftView {
  readonly admissionId: string;
  /** False when nothing has been recorded yet (all `unknown`, version 0) — the first PUT names version 0. */
  readonly exists: boolean;
  readonly factors: Readonly<Record<RiskFactorWireKey, BereavementFactorValue>>;
  readonly lastEditedDiscipline: string | null;
  readonly lastEditedAt: IsoInstant | null;
  /** The initial score that consumed the draft at plan seed; null until a plan opened. */
  readonly carriedScoreId: string | null;
  readonly carriedAt: IsoInstant | null;
  /** True once a bereavement plan exists for the admission: the draft is a closed record. */
  readonly locked: boolean;
  /** The `If-Match` token (0 until the first write). */
  readonly version: number;
  /** `sud` when the reader is not cleared for 42 CFR Part 2 content (the substance-use slot reads `unknown`). */
  readonly redactedCategories: readonly BereavementRedactedCategory[];
}

export interface PutPreDeathDraftInput {
  /** All eight factors, tri-state: a PUT replaces the whole vector. */
  readonly factors: BereavementRiskFactorInputs;
  /** The version the caller read (the `If-Match` header; 0 for the first write). */
  readonly expectedVersion: number;
}

export interface M16DraftService {
  /** `null` = the admission is absent or another tenant's (the route's 404). */
  getDraft(actor: M16ReadActor, admissionId: string): Promise<PreDeathDraftView | null>;
  /** 404 unknown admission · 409 `DRAFT_LOCKED` once a plan exists · 412 `STALE_VERSION`. */
  putDraft(
    actor: M16WriteActor,
    admissionId: string,
    input: PutPreDeathDraftInput,
  ): Promise<PreDeathDraftView>;
}
