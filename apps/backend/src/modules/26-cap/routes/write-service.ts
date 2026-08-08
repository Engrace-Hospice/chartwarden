// apps/backend/src/modules/26-cap/routes/write-service.ts — the M26 WRITE service interface (the §4.1
// POST/PATCH surface) + the transactional-outbox port. Each command runs under withOrgContext (RLS),
// validates the §2.2 transition via the pure cap-period state machine, stamps the acting user, and emits
// the §4.10 outbox event on the caller's tx through the injected WriteOutboxPort (transactional outbox).
import type { M26WriteActor } from "./actor";
import type { PeriodView, ProjectionView, SettlementView } from "./read-service";

/** A §4.10 `m26.cap.*` transactional-outbox emission. PHI-free payload by construction (D13). */
export interface OutboxEmission {
  readonly eventName: string;
  readonly payload: Record<string, unknown>;
  readonly organizationId: string;
  readonly aggregateKind: string;
  readonly aggregateId: string;
}

/** The transactional-outbox port (the composition root binds the catalog-validating M1 publisher pinned to
 * callerModule `m26`); `publish` writes the outbox_event row on the CALLER'S tx (same unit of work). No-op default.
 * `organizationId`/`aggregateKind`/`aggregateId` are REQUIRED here (found live, same class as the M24 bug in
 * the same session: every call site omitted them, which type-checked ONLY because interface method-shorthand
 * parameters are checked bivariantly — the real bound publisher at boot always required them, and every
 * write 500'd `null value in column "aggregate_kind"` at the actual insert). */
export interface WriteOutboxPort {
  publish(tx: unknown, emission: OutboxEmission): Promise<void>;
}

export interface OpenPeriodInput {
  capYear: string;
  methodology?: "streamlined" | "proportional";
  graceWindowDays?: number;
}
export interface LockMethodologyInput {
  methodology: "streamlined" | "proportional";
  reason: string;
}
export interface ReopenInput {
  reason: string;
}
export interface AcknowledgeInput {
  notes?: string;
}
export interface ImportPsrInput {
  macRegion: string;
  psrPeriodFrom: string;
  psrPeriodTo: string;
  fileBase64: string;
}
export interface ResolveVarianceInput {
  varianceReason: string;
  resolutionNotes: string;
}
export interface FinalizeInput {
  attestation: string;
}
export interface PublishConstantInput {
  capYear: string;
  aggregateCapAmountCents: number;
  inpatientCapPct?: number;
  sourceUrl?: string;
}
export interface AmendConstantInput {
  aggregateCapAmountCents: number;
  sourceUrl?: string;
}

export interface M26WriteService {
  openPeriod(actor: M26WriteActor, input: OpenPeriodInput): Promise<PeriodView>;
  lockMethodology(
    actor: M26WriteActor,
    periodId: string,
    input: LockMethodologyInput,
  ): Promise<PeriodView>;
  closePeriod(actor: M26WriteActor, periodId: string): Promise<PeriodView>;
  reopenPeriod(actor: M26WriteActor, periodId: string, input: ReopenInput): Promise<PeriodView>;
  recompute(actor: M26WriteActor, periodId: string): Promise<ProjectionView[]>;
  acknowledgeEvent(actor: M26WriteActor, eventId: string, input: AcknowledgeInput): Promise<void>;
  importPsr(
    actor: M26WriteActor,
    periodId: string,
    input: ImportPsrInput,
  ): Promise<{ importId: string }>;
  resolveVariance(actor: M26WriteActor, lineId: string, input: ResolveVarianceInput): Promise<void>;
  proposeSettlement(actor: M26WriteActor, periodId: string): Promise<SettlementView>;
  finalizeSettlement(
    actor: M26WriteActor,
    periodId: string,
    input: FinalizeInput,
  ): Promise<SettlementView>;
  publishConstant(actor: M26WriteActor, input: PublishConstantInput): Promise<void>;
  amendConstant(actor: M26WriteActor, capYear: string, input: AmendConstantInput): Promise<void>;
}
