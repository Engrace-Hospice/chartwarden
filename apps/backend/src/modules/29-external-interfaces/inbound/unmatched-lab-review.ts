// apps/backend/src/modules/29-external-interfaces/inbound/unmatched-lab-review.ts — the §4.2 unmatched-lab
// review queue's EXIT decisions (GAP-044). PURE: no DB, no clock, no seams — the caller supplies the queue
// item, the resolved patient facts, and `now`.
//
// The two routes (`POST …/attach-patient`, `POST …/discard`) were permanent 501s pointing at T-29.13, which
// is the FRONTEND task; no backend task ever owned this. The queue had no exit and — because the attach
// planner wrote no link row for an unmatched result — no entrance either.
//
// THE BIND materializes the `lab_observation` PARENT that ingest deliberately deferred, under the id the
// link row already reserved, and flips `match_method` to `manual` (the T02 schema reserved that enum member
// for exactly this). It is NOT an update of an existing observation: there was never a row to update.
//
// THE DISCARD writes no observation at all. The link row and its `lab_observation_value` children stay —
// §8 retains an unmatched-then-discarded result for 180 days, and the §164.528 disclosure-accounting
// record needs the receipt to survive the decision to ignore it — they just stop surfacing in the queue.
import type { NewLabObservationRow } from "@wardenx/db/schema";
import type {
  LabAbnormalFlag,
  LabAbnormalSummary,
  LabResultStatus,
  LabTerminologyValidation,
} from "@wardenx/types";
import { computeAbnormalSummary } from "./lab-abnormal";

/** §5.2.4 — a discard must say why, in at least this many characters. Also a DB CHECK (migration 0200). */
export const DISCARD_REASON_MIN_CHARS = 10;

/**
 * One OBX row already persisted under the reserved observation id. These are what the reviewer reads to
 * decide WHICH patient the result belongs to, and what the bind derives the parent's observation-level
 * columns from.
 */
export interface UnmatchedLabValueFacts {
  readonly obxSetId: number;
  readonly loincCode: string;
  readonly loincDisplayText: string;
  readonly terminologyValidation: LabTerminologyValidation;
  readonly abnormalFlag: LabAbnormalFlag | null;
  readonly receivedAt: Date;
}

/** The queue item a review decision is made against — the link row plus its value rows. */
export interface UnmatchedLabQueueItem {
  readonly linkId: string;
  readonly organizationId: string;
  /** The RESERVED observation id. No `lab_observation` row bears it until a bind. */
  readonly observationId: string;
  readonly sourceMessageId: string;
  readonly matchMethod: string;
  readonly candidatePatientId: string | null;
  readonly resolvedAt: Date | null;
  readonly createdAt: Date;
  readonly values: readonly UnmatchedLabValueFacts[];
}

/** The patient facts the bind needs, resolved through M5's `PatientReader` seam (never M5's tables). */
export interface BindPatientFacts {
  readonly patientId: string;
  /** ARCH-011 — `lab_observation.provider_entity_id` is NOT NULL; a patient without one cannot be bound. */
  readonly providerEntityId: string | null;
}

export type UnmatchedReviewRefusal =
  /** The queue item was already bound or discarded — decided-is-decided. */
  | "already_resolved"
  /** The link row is an AUTO-attached lab's provenance record, not a queue item. */
  | "not_an_unmatched_result"
  /** §5.2.4 — the discard reason is missing or under {@link DISCARD_REASON_MIN_CHARS}. */
  | "reason_too_short"
  /** The target patient does not resolve in this tenant (or resolved to a merged-away id). */
  | "patient_not_found"
  /** The patient resolves but carries no `provider_entity_id`, so ARCH-011 cannot be satisfied. */
  | "patient_has_no_provider_entity"
  /** Ingest wrote no OBX rows — there is no result to attach to a chart. */
  | "no_result_values";

/** A refusal carries the machine reason plus the sentence a reviewer reads. */
export interface UnmatchedReviewRefused {
  readonly kind: "refused";
  readonly reason: UnmatchedReviewRefusal;
  readonly message: string;
}

export interface UnmatchedBindPlanned {
  readonly kind: "bind";
  /** The deferred parent, materialized under the reserved id. */
  readonly observation: NewLabObservationRow;
  /** The link-row patch: `manual`, the bound patient as the (now settled) candidate, and the exit stamp. */
  readonly linkPatch: {
    readonly matchMethod: "manual";
    readonly candidatePatientId: string;
    readonly resolution: "manually_matched";
    readonly resolvedAt: Date;
    readonly resolvedByMembershipId: string;
    readonly resolutionReason: string | null;
  };
  readonly event: {
    readonly name: "m29.lab_observation.manually_matched";
    readonly payload: {
      readonly observationId: string;
      readonly organizationId: string;
      readonly patientId: string;
      readonly sourceMessageId: string;
      readonly loincCode: string;
      readonly abnormalSummary: LabAbnormalSummary;
      readonly decidedByMembershipId: string;
      readonly decidedAt: string;
    };
  };
}

export interface UnmatchedDiscardPlanned {
  readonly kind: "discard";
  readonly linkPatch: {
    readonly resolution: "discarded";
    readonly resolvedAt: Date;
    readonly resolvedByMembershipId: string;
    readonly resolutionReason: string;
  };
  readonly event: {
    readonly name: "m29.lab_observation.discarded";
    readonly payload: {
      readonly observationId: string;
      readonly organizationId: string;
      readonly sourceMessageId: string;
      readonly decidedByMembershipId: string;
      readonly decidedAt: string;
      readonly reason: string;
    };
  };
}

export type UnmatchedBindDecision = UnmatchedBindPlanned | UnmatchedReviewRefused;
export type UnmatchedDiscardDecision = UnmatchedDiscardPlanned | UnmatchedReviewRefused;

const refuse = (reason: UnmatchedReviewRefusal, message: string): UnmatchedReviewRefused => ({
  kind: "refused",
  reason,
  message,
});

/** Shared preconditions: the item must be an unmatched result that nobody has already resolved. */
function guardQueueItem(item: UnmatchedLabQueueItem): UnmatchedReviewRefused | null {
  if (item.resolvedAt !== null) {
    return refuse(
      "already_resolved",
      "this unmatched lab result has already been bound or discarded — reload the queue",
    );
  }
  if (item.matchMethod !== "unmatched") {
    return refuse(
      "not_an_unmatched_result",
      `link ${item.linkId} records an auto-attached result (match_method='${item.matchMethod}') — it is not a review-queue item`,
    );
  }
  return null;
}

/**
 * The observation-level columns, derived from the persisted OBX rows. THE FIDELITY LIMIT IS REAL AND
 * DELIBERATE: `lab_observation.loinc_code` normally carries OBR-4 (the panel code), but an unmatched
 * result's OBR is not persisted anywhere — only the OBX values are — so the bind uses the first value's
 * LOINC as the panel code and its `received_at` as the observation datetime. `result_status` defaults to
 * `final`, which is what `mapResultStatus` already returns for a resulted ORU with no explicit status.
 * Recording the panel code and collection time faithfully would mean persisting the OBR at ingest; that is
 * a schema addition this gap does not need, and the LOINC recorded here is the one the reviewer saw.
 */
function observationFactsFrom(values: readonly UnmatchedLabValueFacts[]): {
  loincCode: string;
  loincDisplayText: string;
  terminologyValidation: LabTerminologyValidation;
  abnormalSummary: LabAbnormalSummary;
  observationDate: Date;
  receivedAt: Date;
  resultStatus: LabResultStatus;
} {
  const ordered = [...values].sort((a, b) => a.obxSetId - b.obxSetId);
  const first = ordered[0] as UnmatchedLabValueFacts;
  const earliest = ordered.reduce(
    (min, v) => (v.receivedAt < min ? v.receivedAt : min),
    first.receivedAt,
  );
  return {
    loincCode: first.loincCode,
    loincDisplayText: first.loincDisplayText,
    // The panel inherits the WEAKEST validation across its values: one unmapped OBX means the panel is
    // not safe for the FHIR projection / HQRP filters that key on `valid`.
    terminologyValidation: ordered.some((v) => v.terminologyValidation === "unknown_code")
      ? "unknown_code"
      : ordered.some((v) => v.terminologyValidation === "deprecated")
        ? "deprecated"
        : "valid",
    abnormalSummary: computeAbnormalSummary(ordered.map((v) => v.abnormalFlag ?? null)),
    observationDate: earliest,
    receivedAt: earliest,
    resultStatus: "final",
  };
}

export interface UnmatchedBindCommand {
  readonly patient: BindPatientFacts;
  readonly decidedByMembershipId: string;
  readonly note?: string;
  readonly now: Date;
}

/** Plan the manual bind (§4.2, `m29.lab_observation.manually_matched`). Total — never throws. */
export function planUnmatchedBind(
  item: UnmatchedLabQueueItem,
  cmd: UnmatchedBindCommand,
): UnmatchedBindDecision {
  const guard = guardQueueItem(item);
  if (guard) return guard;
  if (item.values.length === 0) {
    return refuse(
      "no_result_values",
      `unmatched result ${item.observationId} carries no OBX values — there is nothing to attach to a chart`,
    );
  }
  if (cmd.patient.providerEntityId === null) {
    return refuse(
      "patient_has_no_provider_entity",
      `patient ${cmd.patient.patientId} has no provider entity on file — a lab observation cannot be filed without one (ARCH-011)`,
    );
  }

  const facts = observationFactsFrom(item.values);
  const note = cmd.note?.trim() ? cmd.note.trim() : null;
  return {
    kind: "bind",
    observation: {
      id: item.observationId,
      organizationId: item.organizationId,
      providerEntityId: cmd.patient.providerEntityId,
      locationId: null,
      sourceMessageId: item.sourceMessageId,
      patientId: cmd.patient.patientId,
      orderId: null,
      observationDate: facts.observationDate,
      collectionDate: null,
      resultStatus: facts.resultStatus,
      loincCode: facts.loincCode,
      loincDisplayText: facts.loincDisplayText,
      terminologyValidation: facts.terminologyValidation,
      abnormalSummary: facts.abnormalSummary,
      // The parent is co-partitioned with its already-persisted children: it MUST reuse their
      // `received_at`, not the bind instant, or parent and values land in different monthly partitions
      // and the composite-PK join stops resolving.
      receivedAt: facts.receivedAt,
      sudRedactedAtIngest: false,
    },
    linkPatch: {
      matchMethod: "manual",
      candidatePatientId: cmd.patient.patientId,
      resolution: "manually_matched",
      resolvedAt: cmd.now,
      resolvedByMembershipId: cmd.decidedByMembershipId,
      resolutionReason: note,
    },
    event: {
      name: "m29.lab_observation.manually_matched",
      payload: {
        observationId: item.observationId,
        organizationId: item.organizationId,
        patientId: cmd.patient.patientId,
        sourceMessageId: item.sourceMessageId,
        loincCode: facts.loincCode,
        abnormalSummary: facts.abnormalSummary,
        decidedByMembershipId: cmd.decidedByMembershipId,
        decidedAt: cmd.now.toISOString(),
      },
    },
  };
}

export interface UnmatchedDiscardCommand {
  readonly reason: string;
  readonly decidedByMembershipId: string;
  readonly now: Date;
}

/** Plan the discard (§4.2/§5.2.4, `m29.lab_observation.discarded`). Total — never throws. */
export function planUnmatchedDiscard(
  item: UnmatchedLabQueueItem,
  cmd: UnmatchedDiscardCommand,
): UnmatchedDiscardDecision {
  const guard = guardQueueItem(item);
  if (guard) return guard;
  const reason = cmd.reason.trim();
  if (reason.length < DISCARD_REASON_MIN_CHARS) {
    return refuse(
      "reason_too_short",
      `a discard reason of at least ${DISCARD_REASON_MIN_CHARS} characters is required (§5.2.4) — a result thrown away without one cannot be explained later`,
    );
  }
  return {
    kind: "discard",
    linkPatch: {
      resolution: "discarded",
      resolvedAt: cmd.now,
      resolvedByMembershipId: cmd.decidedByMembershipId,
      resolutionReason: reason,
    },
    event: {
      name: "m29.lab_observation.discarded",
      payload: {
        observationId: item.observationId,
        organizationId: item.organizationId,
        sourceMessageId: item.sourceMessageId,
        decidedByMembershipId: cmd.decidedByMembershipId,
        decidedAt: cmd.now.toISOString(),
        reason,
      },
    },
  };
}
