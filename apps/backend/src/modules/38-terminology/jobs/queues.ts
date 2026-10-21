// apps/backend/src/modules/38-terminology/jobs/queues.ts — the §4.3 worker layer's constants (GAP-108). The nine
// queue names and the cron cadences are M38's own pure catalog (`@chartwarden/terminology` TERMINOLOGY_QUEUES /
// TERMINOLOGY_JOB_SCHEDULES); this file adds only what the BullMQ wiring needs. BullMQ job ids and queue names
// must not contain ':'.
import { TERMINOLOGY_QUEUES } from "@chartwarden/terminology";

export { TERMINOLOGY_JOB_SCHEDULES, TERMINOLOGY_QUEUES } from "@chartwarden/terminology";

/** The platform job id the active-org enumerator enters `withPlatformContext` under (must be allowlisted). */
export const M38_PLATFORM_JOB_ID = "m38-terminology-workers";

/** Retries a job gets before BullMQ gives up (the DLQ alert fires on the last failure). */
export const TERMINOLOGY_JOB_ATTEMPTS = 3;
export const TERMINOLOGY_JOB_BACKOFF_MS = 30_000;

/** Deprecated codes handed to a code-usage producer per call (bounds one seam round trip). */
export const SCAN_CODES_PER_PRODUCER_CALL = 500;

/** Repeatable-job names inside `terminology.scheduled_icd10cm`. */
export const ICD10CM_DRY_RUN_JOB = "dry_run";
export const ICD10CM_ACTIVATE_JOB = "activate";

/** The deterministic job ids (dedupe a re-enqueue while the first is still queued/active). */
export const jobIds = {
  load: (versionId: string): string => `terminology-load-${versionId}`,
  expansions: (system: string, versionId: string): string =>
    `terminology-expansions-${system}-${versionId}`,
  embeddings: (system: string, versionId: string): string =>
    `terminology-embeddings-${system}-${versionId}`,
  scan: (versionId: string): string => `terminology-scan-${versionId}`,
} as const;

/** Every queue the module owns, for the DLQ alert / close-all wiring. */
export const ALL_TERMINOLOGY_QUEUES: readonly string[] = Object.values(TERMINOLOGY_QUEUES);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** `terminology.load_version` payload. A malformed payload throws (the job fails loudly). */
export interface LoadVersionJobData {
  readonly versionId: string;
  readonly activate: boolean;
}
export function parseLoadVersionJobData(data: unknown): LoadVersionJobData {
  const d = data as { versionId?: unknown; activate?: unknown } | null;
  if (typeof d?.versionId !== "string" || !UUID_RE.test(d.versionId)) {
    throw new Error("terminology.load_version: job data must carry a uuid versionId");
  }
  return { versionId: d.versionId, activate: d.activate !== false };
}

/** `terminology.refresh_expansions` / `terminology.refresh_embeddings` payload. */
export interface SystemJobData {
  readonly system: string;
  readonly versionId: string | null;
}
export function parseSystemJobData(data: unknown): SystemJobData {
  const d = data as { system?: unknown; versionId?: unknown } | null;
  if (typeof d?.system !== "string" || d.system.length === 0 || d.system.length > 32) {
    throw new Error("terminology job: data must carry a system");
  }
  if (
    d.versionId !== undefined &&
    d.versionId !== null &&
    !(typeof d.versionId === "string" && UUID_RE.test(d.versionId))
  ) {
    throw new Error("terminology job: versionId must be a uuid");
  }
  return { system: d.system, versionId: (d.versionId as string | null | undefined) ?? null };
}

/** `terminology.tenant_deprecation_scan` payload. */
export interface TenantScanJobData {
  readonly system: string;
  readonly versionId: string;
  readonly effectiveFrom: string;
}
export function parseTenantScanJobData(data: unknown): TenantScanJobData {
  const d = data as { system?: unknown; versionId?: unknown; effectiveFrom?: unknown } | null;
  if (
    typeof d?.system !== "string" ||
    typeof d.versionId !== "string" ||
    !UUID_RE.test(d.versionId) ||
    typeof d.effectiveFrom !== "string" ||
    !ISO_DATE_RE.test(d.effectiveFrom)
  ) {
    throw new Error(
      "terminology.tenant_deprecation_scan: data must carry system, a uuid versionId and an ISO effectiveFrom",
    );
  }
  return { system: d.system, versionId: d.versionId, effectiveFrom: d.effectiveFrom };
}
