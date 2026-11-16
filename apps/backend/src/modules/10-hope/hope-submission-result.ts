// M10 — pure rules for recording the CMS (iQIES) Final Validation Report against a submission batch.
// Shared by the DB backend and the in-memory slice so the two cannot drift. iQIES has no submission API:
// the user uploads the zip in the CMS portal, then records the outcome here.
import { createHash } from "node:crypto";
import { HopeStateError, type M10ErrorCode } from "@chartwarden/hope";
import type { HopeSubmissionItemStatus, HopeSubmissionStatus } from "@chartwarden/types";

/** Batch states a result may be recorded against: the zip was downloaded or marked uploaded. A `packaged`
 * batch was never handed to CMS, so a result for it is a mistake. */
export const RESULT_IMPORTABLE_STATUSES: readonly HopeSubmissionStatus[] = [
  "exported",
  "in_flight",
  "submitted_pending_result",
];

export const isResultImportable = (status: string): boolean =>
  (RESULT_IMPORTABLE_STATUSES as readonly string[]).includes(status);

/** The batch statuses that count as ACCEPTED by iQIES: every item accepted, with or without CMS warnings (the batch's
 * `accepted_count` already counts a warning item as accepted: `deriveBatchOutcome`). */
export const ACCEPTED_BATCH_STATUSES = [
  "accepted",
  "accepted_with_warnings",
] as const satisfies readonly HopeSubmissionStatus[];

/** The batch statuses iQIES has ANSWERED on (the acceptance-rate denominator and the M30 submission-posture rows): a
 * queued or in-flight batch has no acceptance outcome yet. The dashboard and the M30 rollup read this one list, so they
 * agree on WHICH batches count; they do not share the unit (the dashboard counts batches, the rollup sums the items of
 * the batches). */
export const ANSWERED_BATCH_STATUSES = [
  ...ACCEPTED_BATCH_STATUSES,
  "rejected",
  "partially_accepted",
] as const satisfies readonly HopeSubmissionStatus[];

/**
 * The batch statuses with nothing left for an operator to do: answered clean by CMS (`accepted`, `accepted_with_warnings`) or
 * dead (`cancelled`: never uploaded, its records are packaged again in a new batch). EVERY OTHER status can still need someone:
 * a batch to download or mark uploaded (`packaged`), to record a result for (`exported`, `in_flight`,
 * `submitted_pending_result`), or rejected items to correct (`rejected`, `partially_accepted`); `ready`, `queued` and
 * `file_error` are in no manual lifecycle but are not closed either. The submission list is capped, and the cap keeps these
 * batches first (see `GET /hope/submissions`), so a status added later is kept by default rather than hidden.
 * `rejected` and `partially_accepted` are deliberately never closed: a correction goes in a NEW batch and the old one stays
 * `rejected` (see SUBMISSION_LIST_LIMIT in hope-route-service-db.ts for what that costs and why it is left).
 */
export const CLOSED_BATCH_STATUSES = [
  "accepted",
  "accepted_with_warnings",
  "cancelled",
] as const satisfies readonly HopeSubmissionStatus[];

/** Why a result cannot be recorded against a batch in `status` (the 409 code): never handed to CMS, cancelled
 * (R-08: it must never be uploaded or settled), or already settled. */
export const resultRefusalCode = (status: string): M10ErrorCode =>
  ["packaged", "queued", "ready"].includes(status)
    ? "M10_SUBMISSION_RESULT_NOT_UPLOADED"
    : status === "cancelled"
      ? "M10_SUBMISSION_CANCELLED"
      : "M10_SUBMISSION_RESULT_ALREADY_RECORDED";

/** Polarity-safe status text -> outcome: "not accepted" is a rejection, "0 errors" is not an error, anything
 * unrecognised is null (the row stays pending rather than being guessed accepted). The web parser mirrors this. */
export function classifyStatusText(
  raw: string,
): "accepted" | "accepted_with_warnings" | "rejected" | null {
  const s = raw
    .toLowerCase()
    .replace(/_/g, " ") // enum tokens (accepted_with_warnings): `_` is a word char, so \b would not split them
    .replace(/\b(no|zero|0)\s+(errors?|warnings?|failures?)\b/g, " ");
  if (s.trim() === "") return null;
  if (
    /\b(not|non|never)[\s-]*(accepted|pass(ed|ing)?|successful|ok)\b|\bun(accepted|successful)\b/.test(
      s,
    )
  )
    return "rejected";
  if (/\b(reject(ed)?|fail(ed|ure)?|fatal|errors?)\b/.test(s)) return "rejected";
  if (/\bwarn(ing|ings)?\b/.test(s)) return "accepted_with_warnings";
  if (/\b(accepted|pass(ed)?|success(ful)?|ok)\b/.test(s)) return "accepted";
  return null;
}

/** Map one raw CMS report row to the per-item outcome (never `unmatched`/`blocked`: those are ours). */
export function classifyCmsResult(
  raw: Record<string, unknown>,
): "accepted" | "accepted_with_warnings" | "rejected" | "pending" {
  const status = String(raw.status ?? raw.result ?? raw.outcome ?? "");
  const severity = String(raw.severity ?? raw.cmsSeverity ?? "").toLowerCase();
  if (severity === "fatal" || severity === "error") return "rejected";
  const byText = classifyStatusText(status);
  if (byText === "rejected") return "rejected";
  if (severity === "warning") return "accepted_with_warnings";
  return byText ?? "pending";
}

/** The item statuses that are a CMS verdict (final, see `isSettledItemStatus`). */
export const SETTLED_ITEM_STATUSES = ["accepted", "accepted_with_warnings", "rejected"] as const;

/** A CMS verdict on an item is final: once an item is accepted/accepted_with_warnings/rejected, a later
 * report must not flip it (the RESULT event rows are still recorded for audit). Correct a rejection with a
 * correction assessment in a new batch, not by re-reporting. */
export const isSettledItemStatus = (status: string): boolean =>
  (SETTLED_ITEM_STATUSES as readonly string[]).includes(status);

/** The iQIES record id a report row names, or null when it names none: a blank or whitespace-only id is none (it must not
 * be stamped on the item or the assessment: an empty `iqies_record_id` reads as "already recorded" to every `IS NULL` test). */
export const nonBlankRecordId = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null;

/**
 * A report row's edit code or item code as stored: the trimmed text, or NULL for a blank cell. The result-event table's unique
 * index (`uniq_hope_sub_result_event_import`) is partial on `cms_edit_code IS NOT NULL`, so a stored `""` would be a key: two rows
 * of one assessment in one report with blank codes and different messages would collide, and the second would be silently dropped.
 */
export const nullIfBlank = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

const sha256Hex = (text: string): string => createHash("sha256").update(text).digest("hex");

/**
 * The identity of a report, for replay detection. `canonical` sorts each row's keys, so the same report
 * re-serialised by another client (different key order) is still recognised as already recorded.
 * `legacy` is the plain `JSON.stringify` digest that batches recorded before the canonical form stored:
 * both count as "seen", but only `canonical` is written from now on. (Row ORDER still matters.)
 */
export function reportHashes(results: readonly Record<string, unknown>[]): {
  canonical: string;
  legacy: string;
} {
  const sortedRow = (row: Record<string, unknown>): string =>
    JSON.stringify(
      Object.fromEntries(Object.entries(row).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    );
  return {
    canonical: sha256Hex(`[${results.map(sortedRow).join(",")}]`),
    legacy: sha256Hex(JSON.stringify(results)),
  };
}

/** Matches the route schema's `maxItems` for `results`. */
export const MAX_RETAINED_RESULTS = 2000;

/**
 * The most `hope_submission_result_event` rows one batch may hold. The rows are append-only audit evidence, and every import whose
 * report differs by a character (a new report hash) adds up to 2000 more while the batch is still `submitted_pending_result`, so the
 * total is bounded: an import that would pass it is a 409 and records nothing. The batch's findings read is limited to the same number.
 */
export const MAX_RESULT_EVENTS_PER_SUBMISSION = 20_000;

/** Append a later report's raw rows to those already stored on the batch, keeping the newest `MAX_RETAINED_RESULTS`. */
export function appendReportResults(
  previous: unknown,
  next: readonly Record<string, unknown>[],
): Record<string, unknown>[] {
  const prior = Array.isArray(previous) ? (previous as Record<string, unknown>[]) : [];
  return [...prior, ...next].slice(-MAX_RETAINED_RESULTS);
}

const OUTCOME_RANK = { pending: 0, accepted: 1, accepted_with_warnings: 2, rejected: 3 } as const;

/** Merge two row outcomes for the SAME assessment, worst wins. A Final Validation Report carries one row per
 * finding, so a later "warning" row must never downgrade an earlier "rejected" one (and row order must not matter). */
export function worstOutcome<T extends keyof typeof OUTCOME_RANK>(a: T, b: T): T {
  return OUTCOME_RANK[b] > OUTCOME_RANK[a] ? b : a;
}

/** A report row is a finding when it names an edit code, an item or a message; severity is the shipped
 * `hope_validation_severity` (error blocks, warning is advisory). */
export function findingSeverity(row: {
  resultStatus: string;
  cmsSeverity?: string | null;
}): "error" | "warning" {
  const severity = (row.cmsSeverity ?? "").toLowerCase();
  if (row.resultStatus === "rejected" || severity === "error" || severity === "fatal")
    return "error";
  return "warning";
}

export interface BatchOutcome {
  readonly status: HopeSubmissionStatus;
  readonly acceptedCount: number;
  readonly rejectedCount: number;
  readonly pendingCount: number;
}

/** Derive the batch outcome from ALL its item statuses (recomputed, so a re-import is idempotent). */
export function deriveBatchOutcome(
  itemStatuses: readonly HopeSubmissionItemStatus[],
): BatchOutcome {
  const count = (s: HopeSubmissionItemStatus) => itemStatuses.filter((x) => x === s).length;
  const warnings = count("accepted_with_warnings");
  const acceptedCount = count("accepted") + warnings;
  const rejectedCount = count("rejected");
  const pendingCount = itemStatuses.length - acceptedCount - rejectedCount;
  const status: HopeSubmissionStatus =
    pendingCount > 0
      ? "submitted_pending_result"
      : rejectedCount > 0 && acceptedCount > 0
        ? "partially_accepted"
        : rejectedCount > 0
          ? "rejected"
          : warnings > 0
            ? "accepted_with_warnings"
            : "accepted";
  return { status, acceptedCount, rejectedCount, pendingCount };
}

export type RejectedItemResolution =
  | "needs_correction"
  | "correction_in_progress"
  | "resubmitted"
  | "resolved";

/** Where a rejected assessment stands: corrections supersede (originals are never edited) and are then
 * re-packaged in a NEW batch. `correctionItemStatus` is the latest batch-item status of the correction. */
export function resolveRejectedItem(
  correction: { readonly itemStatus: HopeSubmissionItemStatus | null } | null,
): RejectedItemResolution {
  if (!correction) return "needs_correction";
  switch (correction.itemStatus) {
    case null:
      return "correction_in_progress";
    case "accepted":
    case "accepted_with_warnings":
      return "resolved";
    case "rejected":
      return "needs_correction";
    case "cancelled": // its package was cancelled before upload: the correction is signed but not in a live batch
      return "correction_in_progress";
    default:
      return "resubmitted";
  }
}

/** Longest correction chain followed; a real chain is a handful of rounds, this only stops a corrupt cycle. */
export const MAX_CORRECTION_CHAIN = 25;

/** The current (terminal) correction of `originalId`: follows original -> correction -> correction-of-the-correction.
 * A rejected original is only resolved by the END of its chain (B rejected, C accepted resolves A). `childOf`
 * maps an assessment id to the NEWEST assessment that corrects it (an older child is an abandoned attempt). Returns null when it has no correction. */
export function terminalCorrection(
  originalId: string,
  childOf: ReadonlyMap<string, string>,
): string | null {
  let current: string | null = null;
  let next = childOf.get(originalId);
  for (let hops = 0; next && hops < MAX_CORRECTION_CHAIN; hops += 1) {
    current = next;
    next = childOf.get(next);
  }
  return current;
}

/**
 * Payload of `m10.hope.submission_transmitted` for a MANUAL iQIES upload. The catalog schema requires
 * `transmittedAt` and `envelopeSha256`; a manual upload has no signed envelope, so the package's own
 * SHA-256 is the integrity hash that identifies what was uploaded. Emitting the older
 * `{submittedAt, transportMode}`-only shape failed catalog validation and turned "Mark uploaded" into a 500.
 * `transmittedAt` is the instant the system recorded the upload (the retention anchor, the server's clock);
 * `submittedAt` is when the operator says it happened, and is `transmittedAt` when they said nothing.
 */
export function manualUploadTransmittedPayload(
  submissionId: string,
  packageSha256: string | null | undefined,
  transmittedAt: Date,
  submittedAt: Date = transmittedAt,
): {
  submissionId: string;
  transmittedAt: string;
  envelopeSha256: string;
  transportMode: "manual_iqies_upload";
  submittedAt: string;
} {
  if (!packageSha256)
    throw new HopeStateError(
      "M10_SUBMISSION_PACKAGE_HASH_MISSING",
      `Submission ${submissionId} has no package hash to record; re-package the batch before marking it uploaded.`,
    );
  return {
    submissionId,
    transmittedAt: transmittedAt.toISOString(),
    envelopeSha256: packageSha256,
    transportMode: "manual_iqies_upload",
    submittedAt: submittedAt.toISOString(),
  };
}

/**
 * Payload of `m10.hope.submission_accepted` / `m10.hope.submission_rejected` for a settled batch. The
 * catalog requires `providerEntityId` + both counts on accepted, and `rejectedCount` + a non-empty-count
 * `findings: [{ruleId, count}]` on rejected; the old `{submissionId, importedBy}`-style emit failed catalog
 * validation, so recording a CMS result 500'd against a real publisher. `ruleId` is the CMS edit code,
 * else the item code, else `cms.rejected`; if this report carried no rejected rows (a later report settled
 * a batch whose rejections arrived earlier) the batch's rejected count is reported as one `cms.rejected` finding.
 */
export function settledBatchEvent(
  submissionId: string,
  providerEntityId: string,
  outcome: { readonly acceptedCount: number; readonly rejectedCount: number },
  results: readonly Record<string, unknown>[],
):
  | {
      eventName: "m10.hope.submission_accepted";
      payload: {
        submissionId: string;
        providerEntityId: string;
        acceptedCount: number;
        rejectedCount: number;
      };
    }
  | {
      eventName: "m10.hope.submission_rejected";
      payload: {
        submissionId: string;
        rejectedCount: number;
        findings: { ruleId: string; count: number }[];
      };
    } {
  if (outcome.rejectedCount === 0) {
    return {
      eventName: "m10.hope.submission_accepted",
      payload: {
        submissionId,
        providerEntityId,
        acceptedCount: outcome.acceptedCount,
        rejectedCount: 0,
      },
    };
  }
  const counts = new Map<string, number>();
  for (const raw of results) {
    if (classifyCmsResult(raw) !== "rejected") continue;
    const ruleId = [raw.code, raw.itemCode].find((v) => typeof v === "string" && v !== "") as
      | string
      | undefined;
    counts.set(ruleId ?? "cms.rejected", (counts.get(ruleId ?? "cms.rejected") ?? 0) + 1);
  }
  const findings =
    counts.size > 0
      ? [...counts].map(([ruleId, count]) => ({ ruleId, count }))
      : [{ ruleId: "cms.rejected", count: outcome.rejectedCount }];
  return {
    eventName: "m10.hope.submission_rejected",
    payload: { submissionId, rejectedCount: outcome.rejectedCount, findings },
  };
}
