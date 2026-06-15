// @wardenx/audit — Audit job processors (M4-T11, M4 spec §4.4, §6, §10.4–10.6, §12).
//
// The pure, infra-free logic each BullMQ worker runs. Every processor is a function over injected
// ports (DB / object store / clock / flags), mirroring the rest of the M4 surface: the logic is
// unit-tested against in-memory ports (../jobs/ports), and the app wiring binds the production
// Drizzle/MinIO/Valkey adapters to the same port shapes (a tracked follow-up, like the eraser's).
//
//   • retention scan       → open pending destruction certs for expired partitions, skipping
//                            legal-hold and not-yet-erasable Part 2 rows (§4.4, §6).
//   • execute destruction  → run an approved cert through the eraser, emit its audit events (§6).
//   • integrity sample     → compare a live-vs-backup sample, alert on any mismatch (§12.3).
//   • build export         → load records, render the watermarked artifact, store it (§4.3, §4.4).
//   • seal partition       → Phase 2; compute + store the hash-chain seal when the flag is on.
import {
  type DestructionResult,
  type DestructionRun,
  runDestruction,
} from "../lifecycle/destruction";
import type { EraserPorts, PatientLifecycle } from "../lifecycle/eraser";
import {
  type IntegritySampleRow,
  type SampleMismatch,
  type SealCheckpoint,
  compareSampleToBackup,
  sealPartition,
} from "../integrity/index";
import { type ExportArtifact, type ExportRequest, renderAuditExport } from "../export/index";
import type { AuditRetentionClass } from "../lifecycle/eraser";
import type { AuditEventRecord } from "../query/audit-query";

// --- retention scan (audit.retention_scan, §4.4 daily) ----------------------------------------

/** One expired partition/object the retention scan evaluates for destruction. */
export interface RetentionCandidate {
  readonly partition: string;
  readonly organizationId: string;
  readonly dataClass: string;
  readonly retentionClass: AuditRetentionClass;
  /** ISO-8601 instant this partition's retention expired (already past per the caller's query). */
  readonly expiresAt: string;
  /**
   * For a Part 2 (SUD) candidate, the patient's lifecycle — drives the §6 lifetime check. A Part 2
   * candidate with no patient is treated conservatively (kept), never destroyed.
   */
  readonly patient?: PatientLifecycle | null;
}

/** Why the scan skipped a candidate (never destroyed silently). */
export type RetentionSkipReason = "legal_hold" | "part_two_lifetime" | "not_expired";

/** The decision the scan reaches for one candidate, before any side effect. */
export interface RetentionDecision {
  readonly partition: string;
  readonly action: "open_certificate" | "skip";
  readonly reason?: RetentionSkipReason;
}

/** Add `years` whole years to `date` (UTC) — the §6 six-year post-death window. */
function addYears(date: Date, years: number): Date {
  const out = new Date(date.getTime());
  out.setUTCFullYear(out.getUTCFullYear() + years);
  return out;
}

/** True when a Part 2 candidate's patient is past the lifetime+6yr window (so it MAY be destroyed). */
function isPartTwoErasable(patient: PatientLifecycle | null | undefined, now: Date): boolean {
  if (!patient) return false; // unknown patient → never destroy a Part 2 row (§6 conservative)
  if (patient.status === "active") return false; // alive → kept
  if (!patient.deceasedDate) return false; // deceased but no date → can't prove the window elapsed
  return addYears(new Date(patient.deceasedDate), 6) <= now;
}

/**
 * Decide, per candidate, whether the retention scan opens a destruction certificate or skips it
 * (§4.4): a `legal_hold`-classed candidate is never destroyed; a not-yet-expired one is skipped;
 * a Part 2 candidate is skipped while its patient is alive or within 6yr post-death (§6). Pure —
 * no side effects; the runner applies the decisions.
 */
export function planRetentionScan(
  candidates: readonly RetentionCandidate[],
  now: Date,
): RetentionDecision[] {
  return candidates.map((c) => {
    if (new Date(c.expiresAt) > now) {
      return { partition: c.partition, action: "skip", reason: "not_expired" };
    }
    if (c.retentionClass === "legal_hold") {
      return { partition: c.partition, action: "skip", reason: "legal_hold" };
    }
    if (c.retentionClass === "compliance_42cfr_part2" && !isPartTwoErasable(c.patient, now)) {
      return { partition: c.partition, action: "skip", reason: "part_two_lifetime" };
    }
    return { partition: c.partition, action: "open_certificate" };
  });
}

/** Ports the retention-scan runner resolves through. */
export interface RetentionScanPorts {
  /** Expired candidates from the partition/object catalog (already filtered to past-expiry). */
  listExpiredCandidates(): Promise<readonly RetentionCandidate[]> | readonly RetentionCandidate[];
  /** Open a pending `destruction_certificate` for a candidate; returns its id. */
  openCertificate(candidate: RetentionCandidate): Promise<string> | string;
  now(): Date;
}

/** The outcome of a retention scan: certs opened + everything skipped (with the reason). */
export interface RetentionScanResult {
  readonly opened: { readonly partition: string; readonly certificateId: string }[];
  readonly skipped: { readonly partition: string; readonly reason: RetentionSkipReason }[];
}

/** Run the daily retention scan: plan each candidate, then open certificates for the eligible ones. */
export async function runRetentionScan(ports: RetentionScanPorts): Promise<RetentionScanResult> {
  const candidates = await ports.listExpiredCandidates();
  const decisions = planRetentionScan(candidates, ports.now());
  const byPartition = new Map(candidates.map((c) => [c.partition, c]));
  const opened: RetentionScanResult["opened"] = [];
  const skipped: RetentionScanResult["skipped"] = [];
  for (const decision of decisions) {
    if (decision.action === "skip") {
      skipped.push({ partition: decision.partition, reason: decision.reason! });
      continue;
    }
    const candidate = byPartition.get(decision.partition)!;
    const certificateId = await ports.openCertificate(candidate);
    opened.push({ partition: decision.partition, certificateId });
  }
  return { opened, skipped };
}

// --- execute destruction (audit.execute_destruction, §4.4 on approval) ------------------------

/** Ports the destruction runner resolves through (the eraser + the audit writer). */
export interface ExecuteDestructionPorts {
  readonly eraser: EraserPorts;
  /** File one of the run's audit events (refusal / certification) through the M4 writer (§10.5). */
  emit(event: DestructionResult["auditEvents"][number]): Promise<void> | void;
  /** Persist the certificate's terminal status (executed | partial_refused | held). */
  recordCertificateStatus(certificateId: string, status: DestructionResult["status"]): Promise<void> | void;
}

/**
 * Run an approved destruction certificate: erase its authorized rows through the eraser (legal-hold
 * supremacy + Part 2 lifetime are enforced row-by-row), emit every resulting audit event, and
 * persist the certificate's terminal status. Returns the faithful `DestructionResult` (§6, §10.5).
 */
export async function runExecuteDestruction(
  run: DestructionRun,
  ports: ExecuteDestructionPorts,
): Promise<DestructionResult> {
  const result = await runDestruction(run, ports.eraser);
  for (const event of result.auditEvents) {
    await ports.emit(event);
  }
  await ports.recordCertificateStatus(result.certificateId, result.status);
  return result;
}

// --- integrity sample (audit.integrity_sample, §4.4 quarterly) --------------------------------

/** Ports the integrity-sample runner resolves through. */
export interface IntegritySamplePorts {
  /** Draw a sample of `size` live events + the same ids from the backup, each reduced to a hash. */
  sample(
    size: number,
  ):
    | Promise<{ live: readonly IntegritySampleRow[]; backup: readonly IntegritySampleRow[] }>
    | { live: readonly IntegritySampleRow[]; backup: readonly IntegritySampleRow[] };
  /** Raise the Security-Hardening-T6 alert when a mismatch is found (no-op when the sample is clean). */
  alert(mismatches: readonly SampleMismatch[]): Promise<void> | void;
}

/** The outcome of one integrity sample: how many were checked + any divergences (+ alert flag). */
export interface IntegritySampleResult {
  readonly checked: number;
  readonly mismatches: SampleMismatch[];
  readonly alerted: boolean;
}

/** Default sample size for the quarterly check (§4.4 "sample 100 events vs backup"). */
export const DEFAULT_INTEGRITY_SAMPLE_SIZE = 100;

/** Run the quarterly integrity sample: compare live↔backup hashes and alert on any mismatch. */
export async function runIntegritySample(
  ports: IntegritySamplePorts,
  size: number = DEFAULT_INTEGRITY_SAMPLE_SIZE,
): Promise<IntegritySampleResult> {
  const { live, backup } = await ports.sample(size);
  const mismatches = compareSampleToBackup(live, backup);
  if (mismatches.length > 0) await ports.alert(mismatches);
  return { checked: live.length, mismatches, alerted: mismatches.length > 0 };
}

// --- build export (audit.build_export, §4.3–4.4 on request) -----------------------------------

/** Ports the export builder resolves through. */
export interface BuildExportPorts {
  /** Load the audit records for the request's scope (org-scoped by RLS in the real adapter). */
  loadRecords(exportId: string): Promise<readonly AuditEventRecord[]> | readonly AuditEventRecord[];
  /** Render → store the artifact in object storage; returns the stored object ref (§3.5 file_ref). */
  store(exportId: string, artifact: ExportArtifact): Promise<string> | string;
}

/** The outcome of building one export: the stored object ref + how many records it covered. */
export interface BuildExportResult {
  readonly exportId: string;
  readonly fileRef: string;
  readonly recordCount: number;
  readonly format: ExportRequest["format"];
}

/** Run an export request: load its records, render the watermarked artifact, store it (§4.3). */
export async function runBuildExport(
  exportId: string,
  request: Pick<ExportRequest, "format" | "watermark">,
  ports: BuildExportPorts,
): Promise<BuildExportResult> {
  const records = await ports.loadRecords(exportId);
  const artifact = renderAuditExport({ ...request, records });
  const fileRef = await ports.store(exportId, artifact);
  return { exportId, fileRef, recordCount: artifact.recordCount, format: request.format };
}

// --- seal partition (audit.seal_partition, §4.4 Phase 2 — flag-gated) -------------------------

/** Ports the seal runner resolves through (Phase 2; inert until the hash-chain flag is on). */
export interface SealPartitionPorts {
  /** Whether the `audit_hash_chain_enabled` flag is on for this scope (§14 D2). */
  isHashChainEnabled(): Promise<boolean> | boolean;
  /** The partition's events in canonical order, each reduced to its content hash. */
  loadPartitionEvents(partition: string): Promise<readonly IntegritySampleRow[]> | readonly IntegritySampleRow[];
  /** The chain hash of the prior seal (null = genesis). */
  loadPrevChainHash(organizationId: string | null): Promise<string | null> | string | null;
  /** Persist the computed `audit_seal` checkpoint. */
  store(seal: SealCheckpoint): Promise<void> | void;
}

/** The outcome of a seal attempt — Phase-2 inert (flag off) or empty partitions resolve to skipped. */
export interface SealPartitionResult {
  readonly sealed: boolean;
  readonly reason?: "flag_disabled" | "empty";
  readonly seal?: SealCheckpoint;
}

/**
 * Seal a closed partition (Phase 2, §3.5). When the `audit_hash_chain_enabled` flag is OFF the job
 * is inert — it persists nothing and reports `flag_disabled`, keeping the seal feature dark until
 * Phase 2 turns it on (§14 D2). When on, it computes the chain checkpoint linking to the prior seal
 * and stores it; an empty partition is skipped.
 */
export async function runSealPartition(
  partition: string,
  organizationId: string | null,
  ports: SealPartitionPorts,
): Promise<SealPartitionResult> {
  if (!(await ports.isHashChainEnabled())) {
    return { sealed: false, reason: "flag_disabled" };
  }
  const events = await ports.loadPartitionEvents(partition);
  if (events.length === 0) return { sealed: false, reason: "empty" };
  const prevChainHash = await ports.loadPrevChainHash(organizationId);
  const seal = sealPartition({ partition, organizationId, events, prevChainHash });
  await ports.store(seal);
  return { sealed: true, seal };
}
