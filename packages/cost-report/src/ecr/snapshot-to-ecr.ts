// @chartwarden/cost-report — M27 snapshot → ECR/PI adapter (D11, §2.4 / §4.10). The submit transaction freezes
// the cost report into a `cost_report_snapshot` row whose `worksheet_snapshot` jsonb holds the 21
// worksheets' `data` payloads; this adapter is the single pure entry point the `ecr-generation` worker
// calls to turn that frozen snapshot into the two artifact strings — the machine ECR file and the human-
// readable Print Image. The worker then emits `m27.artifact.render_requested` (×2: `ecr`, `pi`) so M22
// renders + stores the bytes in MinIO and back-references the resulting `document_id`; none of that
// outbox/MinIO machinery lives here (it is P3 worker wiring) — this file is the deterministic byte
// production only.
//
// PURE DOMAIN: no Fastify, no Drizzle/DB, no BullMQ, no `@chartwarden/db`, no `getSeam`, no MinIO, no M22 code.
// No PHI — the snapshot is aggregate financial / statistical only (D18).
import { type PiFormat, renderPi } from "./pi-renderer";
import { type EcrHeaderContext, type SnapshotWorksheets, writeEcr } from "./writer";

/**
 * The minimal shape of a `cost_report_snapshot` this adapter needs: the per-worksheet snapshot map, and
 * optionally the report-level identity (so the ECR header + PI banner can carry the CCN and fiscal-year
 * window) and the content hash (echoed into the PI for review traceability). Kept structural so the P3
 * worker can pass the Drizzle row directly without a parallel DTO.
 */
export interface CostReportSnapshotLike {
  worksheetSnapshot: SnapshotWorksheets;
  materializedInputs?: unknown;
  contentHashSha256?: string;
  header?: EcrHeaderContext;
}

/** The two rendered artifact strings the `ecr-generation` worker hands to the M22 render pipeline. */
export interface EcrArtifacts {
  ecrText: string;
  piText: string;
}

export interface BuildEcrArtifactsOptions {
  /** Overrides any header carried on the snapshot (e.g. resolved fresh from M40 at generation time). */
  header?: EcrHeaderContext;
  /** Print-Image output format; defaults to canonical plain text. */
  piFormat?: PiFormat;
}

/**
 * Adapt a `cost_report_snapshot` into its ECR + PI artifact strings. Deterministic: the same snapshot
 * always yields the same `{ ecrText, piText }`. The header is resolved from `options.header` first, then
 * the snapshot's own `header`, else rendered blank (never fabricated).
 */
export function buildEcrArtifacts(
  snapshot: CostReportSnapshotLike,
  options?: BuildEcrArtifactsOptions,
): EcrArtifacts {
  const worksheets: SnapshotWorksheets = snapshot.worksheetSnapshot ?? {};
  const header = options?.header ?? snapshot.header;

  return {
    ecrText: writeEcr(worksheets, header),
    piText: renderPi(worksheets, header, { format: options?.piFormat ?? "text" }),
  };
}
