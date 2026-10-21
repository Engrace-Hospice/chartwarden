// @chartwarden/audit — In-memory adapters for the audit job processors (M4-T11, §4.4, §12.7).
//
// Deterministic, infra-free ports the job unit/integration tests run against — the same forward
// pattern as ../lifecycle/ports (eraser) and the in-memory AuditQuery. Each adapter records what
// the processor asked it to do so a run's effects are assertable; the production Drizzle/MinIO/
// Valkey adapters bind the identical port shapes (a tracked follow-up).
import type { ExportArtifact } from "../export/index";
import type { IntegritySampleRow, SealCheckpoint } from "../integrity/index";
import type { AuditEventRecord } from "../query/audit-query";
import { type EraserPorts } from "../lifecycle/eraser";
import { createInMemoryEraserPorts, type InMemoryEraserSeed } from "../lifecycle/ports";
import type {
  BuildExportPorts,
  ExecuteDestructionPorts,
  IntegritySamplePorts,
  RetentionCandidate,
  RetentionScanPorts,
  SealPartitionPorts,
} from "./processors";
import type { DestructionResult } from "../lifecycle/destruction";

const FIXED_NOW = "2026-06-15T00:00:00.000Z";

/** In-memory `RetentionScanPorts`: returns the seeded candidates + tallies opened certificates. */
export function createInMemoryRetentionScanPorts(seed: {
  readonly candidates?: readonly RetentionCandidate[];
  readonly now?: string;
}): { ports: RetentionScanPorts; opened(): RetentionCandidate[] } {
  const candidates = seed.candidates ?? [];
  const fixedNow = new Date(seed.now ?? FIXED_NOW);
  const opened: RetentionCandidate[] = [];
  let seq = 0;
  const ports: RetentionScanPorts = {
    listExpiredCandidates: () => candidates,
    openCertificate: (candidate) => {
      opened.push(candidate);
      seq += 1;
      return `cert_${seq}`;
    },
    now: () => fixedNow,
  };
  return { ports, opened: () => opened };
}

/** In-memory `ExecuteDestructionPorts`: wraps an eraser-port seed + records emitted events/status. */
export function createInMemoryExecuteDestructionPorts(seed: InMemoryEraserSeed = {}): {
  ports: ExecuteDestructionPorts;
  emitted(): DestructionResult["auditEvents"][number][];
  statuses(): { certificateId: string; status: DestructionResult["status"] }[];
} {
  const { ports: eraser }: { ports: EraserPorts } = createInMemoryEraserPorts(seed);
  const emitted: DestructionResult["auditEvents"][number][] = [];
  const statuses: { certificateId: string; status: DestructionResult["status"] }[] = [];
  const ports: ExecuteDestructionPorts = {
    eraser,
    emit: (event) => void emitted.push(event),
    recordCertificateStatus: (certificateId, status) => void statuses.push({ certificateId, status }),
  };
  return { ports, emitted: () => emitted, statuses: () => statuses };
}

/** In-memory `IntegritySamplePorts`: returns a fixed live/backup sample + captures any alert. */
export function createInMemoryIntegritySamplePorts(seed: {
  readonly live: readonly IntegritySampleRow[];
  readonly backup: readonly IntegritySampleRow[];
}): { ports: IntegritySamplePorts; alerts(): IntegritySampleRow["id"][][] } {
  const alerts: string[][] = [];
  const ports: IntegritySamplePorts = {
    sample: () => ({ live: seed.live, backup: seed.backup }),
    alert: (mismatches) => void alerts.push(mismatches.map((m) => m.id)),
  };
  return { ports, alerts: () => alerts };
}

/** In-memory `BuildExportPorts`: serves seeded records + stores the rendered artifact in a map. */
export function createInMemoryBuildExportPorts(seed: {
  readonly records: readonly AuditEventRecord[];
}): { ports: BuildExportPorts; stored(): Map<string, ExportArtifact> } {
  const stored = new Map<string, ExportArtifact>();
  let seq = 0;
  const ports: BuildExportPorts = {
    loadRecords: () => seed.records,
    store: (_exportId, artifact) => {
      seq += 1;
      const fileRef = `obj_${seq}`;
      stored.set(fileRef, artifact);
      return fileRef;
    },
  };
  return { ports, stored: () => stored };
}

/** In-memory `SealPartitionPorts`: a togglable flag, seeded partition events, captured seals. */
export function createInMemorySealPartitionPorts(seed: {
  readonly enabled: boolean;
  readonly events?: readonly IntegritySampleRow[];
  readonly prevChainHash?: string | null;
}): { ports: SealPartitionPorts; sealed(): SealCheckpoint[] } {
  const sealed: SealCheckpoint[] = [];
  const ports: SealPartitionPorts = {
    isHashChainEnabled: () => seed.enabled,
    loadPartitionEvents: () => seed.events ?? [],
    loadPrevChainHash: () => seed.prevChainHash ?? null,
    store: (seal) => void sealed.push(seal),
  };
  return { ports, sealed: () => sealed };
}
