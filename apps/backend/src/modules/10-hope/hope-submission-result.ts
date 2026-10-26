// M10 — pure rules for recording the CMS (iQIES) Final Validation Report against a submission batch.
// Shared by the DB backend and the in-memory slice so the two cannot drift. iQIES has no submission API:
// the user uploads the zip in the CMS portal, then records the outcome here.
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
    default:
      return "resubmitted";
  }
}

/** Longest correction chain followed; a real chain is a handful of rounds, this only stops a corrupt cycle. */
export const MAX_CORRECTION_CHAIN = 25;

/** The current (terminal) correction of `originalId`: follows original -> correction -> correction-of-the-correction.
 * A rejected original is only resolved by the END of its chain (B rejected, C accepted resolves A). `childOf`
 * maps an assessment id to the assessment that corrects it. Returns null when it has no correction. */
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
 */
export function manualUploadTransmittedPayload(
  submissionId: string,
  packageSha256: string | null | undefined,
  at: Date,
): {
  submissionId: string;
  transmittedAt: string;
  envelopeSha256: string;
  transportMode: "manual_iqies_upload";
  submittedAt: string;
} {
  if (!packageSha256) throw new Error(`Submission ${submissionId} has no package hash to record`);
  const iso = at.toISOString();
  return {
    submissionId,
    transmittedAt: iso,
    envelopeSha256: packageSha256,
    transportMode: "manual_iqies_upload",
    submittedAt: iso,
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
