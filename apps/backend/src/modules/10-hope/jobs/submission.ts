// apps/backend/src/modules/10-hope/jobs/submission.ts — the §4.10 iQIES submission worker loop (M10-T07).
// PURE, deterministic processors over the §4.8 `hope:submission` queue catalog (NO BullMQ import — the
// worker construction binds the drivers at app boot, same pattern as the M10-T06 watchdog/alert scans).
// The three-stage cron pipeline (§4.10):
//   • assemble-hope-submission (daily) — group signed-and-unsubmitted assessments per ProviderEntity per
//     submission period into a `hope_submission` (status=queued) + `hope_submission_item` rows; emit
//     `m10.hope.submission_queued`. Idempotent: an assessment already on an active item (or already iQIES-
//     accepted) is never re-included (the §3 uniqueness constraint backs this up).
//   • iqies-submit-worker (every 30 min) — CAS queued→in_flight, re-run pre-submission validation per
//     item; ANY blocking error rolls the batch back to queued + alerts (never a partial transmit); else
//     hand the envelope to `@chartwarden/iqies-client.submitBatch`, store it (encrypted) in MinIO, record the
//     SHA-256, emit `m10.hope.submission_transmitted`. Idempotent: a re-pick of an `in_flight` row skips.
//   • iqies-reconcile-worker (hourly) — fold the acceptance report into per-item outcomes + the batch
//     status (all accepted → accepted / all rejected → rejected / mixed → partially_accepted) + a
//     `hope_validation_finding` per rejected item; emit `m10.hope.submission_accepted` / `_rejected`.
//   • submit-correction-rfa (event-driven) — when a correction supersedes an already-accepted original,
//     queue a Correction RFA referencing the original `iqies_record_id` (D7); otherwise the correction is
//     assembled normally (no Correction RFA needed).
// Capture (Tier 2) is decoupled from submission (Tier 3): an iQIES outage queues batches and retries per
// §4.8.1 — it never blocks `recordHopeTimepoint` (§5.6 / §7.10). The adapter call + SHA-256 + MinIO put
// are the only IO; they live in the boot-bound driver. Everything in this file is pure decision logic.
import type { HopeEnvelopeItem, HopeSubmissionEnvelope } from "@chartwarden/iqies-client";
import type { HopeRfaKind, HopeSubmissionItemStatus, HopeSubmissionStatus } from "@chartwarden/types";

// ── shared event shape (mirrors the §2.4 catalog the runner publishes) ───────────────────────────────

/** A submission-lifecycle outbox event a processor asks the runner to publish (§2.4 / events-by-m10.ts). */
export interface PlannedSubmissionEvent {
  readonly eventName:
    | "m10.hope.submission_queued"
    | "m10.hope.submission_transmitted"
    | "m10.hope.submission_accepted"
    | "m10.hope.submission_rejected";
  readonly payload: Record<string, unknown>;
}

/** A `hope_validation_finding` row a reconcile pass asks the runner to write for a rejected item (§4.10). */
export interface PlannedSubmissionFinding {
  readonly hopeAssessmentId: string;
  readonly ruleId: string;
  readonly severity: "error";
  readonly section: string | null;
  readonly message: string;
}

// ── assemble-hope-submission (§4.10, daily cron) ─────────────────────────────────────────────────────

/** The signed-assessment projection the assembler batches (a slice of the §3 `hope_assessment` row). */
export interface AssemblableAssessment {
  readonly assessmentId: string;
  readonly providerEntityId: string;
  /** CMS submission period (`YYYY-Qn` or `YYYY-MM`); the batch key alongside the PE. */
  readonly submissionPeriod: string;
  readonly rfaKind: HopeRfaKind;
  readonly signedAt: string;
  /** True once the assessment is on an active (non-rejected) submission item — never re-include it. */
  readonly hasActiveSubmissionItem: boolean;
  /** Non-null once iQIES accepted the assessment — terminal; never re-include it. */
  readonly iqiesRecordId: string | null;
  /** Set for a Correction RFA: the accepted original's iQIES record id this row corrects (D7). */
  readonly correctsIqiesRecordId: string | null;
}

/** One planned `hope_submission_item` row (status=pending) inside a planned batch. */
export interface PlannedSubmissionItem {
  readonly hopeAssessmentId: string;
  readonly rfaKind: HopeRfaKind;
  readonly correctsIqiesRecordId: string | null;
}

/** One planned `hope_submission` row (status=queued) — the per-PE / per-period batch. */
export interface PlannedSubmission {
  readonly providerEntityId: string;
  readonly submissionPeriod: string;
  readonly items: readonly PlannedSubmissionItem[];
  readonly itemCount: number;
  readonly event: PlannedSubmissionEvent;
}

/** The assembler's output: the new batches to create + the assessments skipped as already-included. */
export interface AssembleSubmissionsPlan {
  readonly submissions: readonly PlannedSubmission[];
  readonly skippedAssessmentIds: readonly string[];
}

/**
 * `assemble-hope-submission` (§4.10) — group every eligible signed assessment into one `hope_submission`
 * per `(providerEntityId, submissionPeriod)`. Eligibility (§4.10): `status=signed` AND `iqiesRecordId IS
 * NULL` AND no active submission item. Items are ordered by `signedAt` (then `assessmentId` for stability)
 * so the envelope is deterministic. Idempotent: a re-run after the prior batch's items are persisted
 * re-sees those assessments as `hasActiveSubmissionItem=true` and skips them — no double-include (the §3
 * uniqueness constraint is the backstop). `submissionId` is minted by the runner (left out of the pure
 * plan); the runner stamps it onto the `submission_queued` payload after insert.
 */
export function planAssembleSubmissions(
  eligible: readonly AssemblableAssessment[],
): AssembleSubmissionsPlan {
  const skipped: string[] = [];
  const groups = new Map<string, AssemblableAssessment[]>();
  for (const a of eligible) {
    if (a.hasActiveSubmissionItem || a.iqiesRecordId != null) {
      skipped.push(a.assessmentId);
      continue;
    }
    // A NUL separator: it cannot occur in a uuid or a `YYYY-Qn` period, so no pair of values can
    // collide on the key. Written as the ESCAPE rather than a literal NUL byte — the byte made git treat
    // this whole file as binary, so every diff of it read `Bin 17194 -> 19008 bytes`.
    const key = `${a.providerEntityId}\u0000${a.submissionPeriod}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(a);
    else groups.set(key, [a]);
  }

  const submissions: PlannedSubmission[] = [];
  // Iterate groups in a stable PE/period order so the plan is deterministic across runs.
  for (const key of [...groups.keys()].sort()) {
    const members = groups.get(key) ?? [];
    const sorted = [...members].sort((a, b) =>
      a.signedAt < b.signedAt
        ? -1
        : a.signedAt > b.signedAt
          ? 1
          : a.assessmentId < b.assessmentId
            ? -1
            : a.assessmentId > b.assessmentId
              ? 1
              : 0,
    );
    const first = sorted[0];
    if (!first) continue;
    const items: PlannedSubmissionItem[] = sorted.map((a) => ({
      hopeAssessmentId: a.assessmentId,
      rfaKind: a.rfaKind,
      correctsIqiesRecordId: a.correctsIqiesRecordId,
    }));
    submissions.push({
      providerEntityId: first.providerEntityId,
      submissionPeriod: first.submissionPeriod,
      items,
      itemCount: items.length,
      event: {
        eventName: "m10.hope.submission_queued",
        payload: {
          providerEntityId: first.providerEntityId,
          submissionPeriod: first.submissionPeriod,
          itemCount: items.length,
        },
      },
    });
  }
  return { submissions, skippedAssessmentIds: skipped };
}

// ── iqies-submit-worker (§4.10, every-30-min cron) ───────────────────────────────────────────────────

/** Per-item pre-submission validation verdict the submit worker re-runs before transmit (§4.10). */
export interface SubmissionItemValidation {
  readonly hopeAssessmentId: string;
  /** A blocking CMS pre-submission error (from `validateHopeAssessment` / `hasBlockingError`). */
  readonly hasBlockingError: boolean;
}

/** The submit worker's CAS + validation decision for one queued batch. */
export type SubmitReadiness =
  | { readonly action: "skip"; readonly reason: "not_queued" }
  | {
      readonly action: "rollback";
      readonly nextStatus: "queued";
      readonly blockingAssessmentIds: readonly string[];
    }
  | { readonly action: "transmit"; readonly nextStatus: "in_flight" };

/**
 * `iqies-submit-worker` readiness gate (§4.10) — decide whether a picked batch may transmit. A non-queued
 * batch is skipped (the CAS lost / a concurrent worker already advanced it — the idempotent re-pick).
 * A queued batch with ANY blocking item validation error rolls back to queued (the caller alerts; never a
 * partial transmit). Otherwise the batch advances to in_flight and the driver runs the adapter call.
 */
export function decideSubmitReadiness(input: {
  readonly status: HopeSubmissionStatus;
  readonly items: readonly SubmissionItemValidation[];
}): SubmitReadiness {
  if (input.status !== "queued") return { action: "skip", reason: "not_queued" };
  const blocking = input.items.filter((i) => i.hasBlockingError).map((i) => i.hopeAssessmentId);
  if (blocking.length > 0) {
    return { action: "rollback", nextStatus: "queued", blockingAssessmentIds: blocking };
  }
  return { action: "transmit", nextStatus: "in_flight" };
}

/**
 * Build the `HopeSubmissionEnvelope` for a batch the driver is about to transmit. Pure projection of the
 * batch's PE CCN + period + items into the `@chartwarden/iqies-client` envelope model (the canonical
 * serialization + SHA-256 are computed by the client). Correction items carry `correctsIqiesRecordId`.
 */
export function buildSubmissionEnvelope(input: {
  readonly providerEntityCcn: string;
  readonly submissionPeriod: string;
  readonly items: readonly PlannedSubmissionItem[];
}): HopeSubmissionEnvelope {
  const items: HopeEnvelopeItem[] = input.items.map((i) => ({
    hopeAssessmentId: i.hopeAssessmentId,
    rfaKind: i.rfaKind,
    correctsIqiesRecordId: i.correctsIqiesRecordId,
  }));
  return {
    providerEntityCcn: input.providerEntityCcn,
    submissionPeriod: input.submissionPeriod,
    items,
  };
}

/** The post-transmit record update + event the driver persists after a successful `submitBatch` (§4.10). */
export interface TransmitResultPlan {
  readonly submissionId: string;
  readonly nextStatus: "in_flight";
  readonly iqiesBatchId: string;
  /**
   * The MinIO key of the RENDERED submission XML — null until a transport that renders and stores it
   * exists (F-072 / #177). `envelope_sha256` is not null in that state and does not depend on it: the
   * digest is over `assembleEnvelopeCanonical`, which is deterministic from the envelope model, so
   * batch membership stays audit-replayable with no object behind the key.
   */
  readonly envelopeStorageUri: string | null;
  readonly envelopeSha256: string;
  readonly transmittedAt: string;
  readonly event: PlannedSubmissionEvent;
}

/**
 * `planTransmitResult` (§4.10) — fold a successful adapter `submitBatch` into the `hope_submission` update
 * (`iqies_batch_id`, `envelope_storage_uri`, `envelope_sha256`, `transmitted_at`) + the
 * `m10.hope.submission_transmitted` event. The batch stays `in_flight` until the reconcile worker pulls
 * the acceptance report. Pure: the adapter call + the MinIO put already happened in the driver.
 */
export function planTransmitResult(input: {
  readonly submissionId: string;
  readonly iqiesBatchId: string;
  readonly envelopeStorageUri: string | null;
  readonly envelopeSha256: string;
  readonly transmittedAt: string;
}): TransmitResultPlan {
  return {
    submissionId: input.submissionId,
    nextStatus: "in_flight",
    iqiesBatchId: input.iqiesBatchId,
    envelopeStorageUri: input.envelopeStorageUri,
    envelopeSha256: input.envelopeSha256,
    transmittedAt: input.transmittedAt,
    event: {
      eventName: "m10.hope.submission_transmitted",
      payload: {
        submissionId: input.submissionId,
        transmittedAt: input.transmittedAt,
        envelopeSha256: input.envelopeSha256,
      },
    },
  };
}

// ── iqies-reconcile-worker (§4.10, hourly cron) ──────────────────────────────────────────────────────

/** One per-item outcome from the iQIES acceptance report the reconcile worker folds in (§4.10). */
export interface ReconcileItemOutcome {
  readonly hopeAssessmentId: string;
  readonly outcome: "accepted" | "rejected";
  readonly iqiesRecordId: string | null;
  readonly findings: ReadonlyArray<{ readonly ruleId: string; readonly message: string }>;
}

/** One per-item transition the reconcile worker writes onto `hope_submission_item` (§3). */
export interface ReconcileItemTransition {
  readonly hopeAssessmentId: string;
  readonly itemStatus: HopeSubmissionItemStatus;
  readonly iqiesRecordId: string | null;
}

/** The reconcile worker's full plan: batch status + per-item transitions + findings + outbox events. */
export interface ReconcilePlan {
  readonly nextStatus: HopeSubmissionStatus;
  readonly acceptedCount: number;
  readonly rejectedCount: number;
  readonly itemTransitions: readonly ReconcileItemTransition[];
  readonly findings: readonly PlannedSubmissionFinding[];
  readonly events: readonly PlannedSubmissionEvent[];
}

/**
 * `iqies-reconcile-worker` (§4.10 / §7.9) — fold the acceptance report into the batch. Status: all
 * accepted → `accepted`; all rejected → `rejected`; mixed → `partially_accepted` (D5 batch semantics).
 * Each rejected item yields one `hope_validation_finding` (severity=error) carrying the iQIES rule id +
 * PHI-free message. Events: `submission_accepted` when any item accepted (M30 reads the acceptance rate),
 * `submission_rejected` when any item rejected (M36 alerts compliance), with the rejection rule-id counts.
 * Idempotent: re-fetching the acceptance report is a read; a re-run yields the same plan.
 */
export function planReconcile(input: {
  readonly submissionId: string;
  readonly outcomes: readonly ReconcileItemOutcome[];
}): ReconcilePlan {
  const itemTransitions: ReconcileItemTransition[] = [];
  const findings: PlannedSubmissionFinding[] = [];
  let acceptedCount = 0;
  let rejectedCount = 0;
  const ruleCounts = new Map<string, number>();

  for (const o of input.outcomes) {
    itemTransitions.push({
      hopeAssessmentId: o.hopeAssessmentId,
      itemStatus: o.outcome,
      iqiesRecordId: o.outcome === "accepted" ? o.iqiesRecordId : null,
    });
    if (o.outcome === "accepted") {
      acceptedCount += 1;
      continue;
    }
    rejectedCount += 1;
    for (const f of o.findings) {
      findings.push({
        hopeAssessmentId: o.hopeAssessmentId,
        ruleId: f.ruleId,
        severity: "error",
        section: null,
        message: f.message,
      });
      ruleCounts.set(f.ruleId, (ruleCounts.get(f.ruleId) ?? 0) + 1);
    }
  }

  const nextStatus: HopeSubmissionStatus =
    rejectedCount === 0 ? "accepted" : acceptedCount === 0 ? "rejected" : "partially_accepted";

  const events: PlannedSubmissionEvent[] = [];
  if (acceptedCount > 0) {
    events.push({
      eventName: "m10.hope.submission_accepted",
      payload: { submissionId: input.submissionId, acceptedCount, rejectedCount },
    });
  }
  if (rejectedCount > 0) {
    events.push({
      eventName: "m10.hope.submission_rejected",
      payload: {
        submissionId: input.submissionId,
        rejectedCount,
        findings: [...ruleCounts.keys()]
          .sort()
          .map((ruleId) => ({ ruleId, count: ruleCounts.get(ruleId) ?? 0 })),
      },
    });
  }

  return { nextStatus, acceptedCount, rejectedCount, itemTransitions, findings, events };
}

// ── submit-correction-rfa (§4.10 / §7.8, event-driven) ───────────────────────────────────────────────

/** The correction context the `hope.correction.submitted` consumer evaluates (§7.8 / D7). */
export interface CorrectionContext {
  readonly correctionAssessmentId: string;
  readonly originalAssessmentId: string;
  /** Non-null iff iQIES already accepted the original (the Correction RFA references it). */
  readonly originalIqiesRecordId: string | null;
}

/** The correction worker's decision: queue a Correction RFA or let the normal assembler handle it. */
export type CorrectionRfaPlan =
  | {
      readonly action: "queue_correction";
      readonly correctionAssessmentId: string;
      readonly originalIqiesRecordId: string;
    }
  | { readonly action: "skip"; readonly reason: "original_not_submitted" };

/**
 * `submit-correction-rfa` (§7.8 / D7) — if the corrected original was already accepted by iQIES, the next
 * worker tick queues a Correction RFA referencing the original's `iqies_record_id`. If the original was
 * never submitted (still queued / rejected / not yet accepted), there is nothing to correct at iQIES — the
 * correction row is a fresh assessment the normal `assemble-hope-submission` pass picks up. Pure decision.
 */
export function planCorrectionRfa(ctx: CorrectionContext): CorrectionRfaPlan {
  if (ctx.originalIqiesRecordId == null) {
    return { action: "skip", reason: "original_not_submitted" };
  }
  return {
    action: "queue_correction",
    correctionAssessmentId: ctx.correctionAssessmentId,
    originalIqiesRecordId: ctx.originalIqiesRecordId,
  };
}

// ── the batch key: which CMS submission period an assessment belongs to (F-058 / #150) ───────────────

/**
 * The `hope_submission.submission_period` an assessment belongs to — `YYYY-Qn`, derived from the
 * assessment's own `target_date`.
 *
 * TWO decisions are load-bearing here, and the pre-F-058 `assembleSubmission` got both wrong by writing
 * `new Date().toISOString().slice(0, 7)`:
 *
 * • **The anchor is the assessment, not the clock.** HQRP assigns a record to the quarter its EVENT
 *   falls in, so an Admission timepoint dated 2026-03-30 belongs to 2026-Q1 however long it sits
 *   unsigned. Anchoring on "now" put every assessment into the month the operator happened to press the
 *   button, which merges quarters and splits one quarter across two batches.
 *
 * • **The grain is quarterly, not monthly.** CMS HQRP data-submission deadlines are quarterly (the
 *   §1.3 APU signal is a QUARTERLY acceptance rate), and `hope_submission`'s own doc comment, the
 *   iQIES-client fixtures and the M10 unit tests all use `YYYY-Qn`. `slice(0, 7)` produced `YYYY-MM`,
 *   so nothing that reads a period could have parsed what the route wrote.
 *
 * Computed in UTC deliberately: `target_date` is the partition key and is stored/compared as a UTC
 * instant everywhere else in M10, and a per-org timezone shift would move a 31 March assessment across
 * a quarter boundary depending on which side of the map the tenant sits on.
 */
export function submissionPeriodFor(targetDateIso: string): string {
  const d = new Date(targetDateIso);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`M10_SUBMISSION_PERIOD_UNPARSEABLE: ${targetDateIso}`);
  }
  const quarter = Math.floor(d.getUTCMonth() / 3) + 1;
  return `${d.getUTCFullYear()}-Q${quarter}`;
}
