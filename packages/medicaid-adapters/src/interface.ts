// @wardenx/medicaid-adapters — the `MedicaidAdapter` seam (D1, §4.5) — the architectural commitment from
// ARCH §11.E / §13: a new state's MMIS joins as a new adapter implementation, never an M24 core change.
// The dependency-cruiser mandate (Architecture §25.14) forbids any module outside this package from
// speaking a state's wire format or hitting a state URL; M24 backend consumes only this interface + seams.
//
// Adapter METHODS are the only async surface in this package (they do real I/O when implemented). The pure
// validation rules never call them — the Phase-3 service resolves the adapter, calls it, and folds the
// results into the plain-data validation context. PURE here = type contracts + the metadata shape only.
import type {
  IsoDate,
  IsoDateTime,
  McoId,
  MedicaidChannel,
  MedicaidClaimId,
  MedicaidEligibilityOutcome,
  MedicaidLevelOfCare,
  OrgId,
  PatientId,
  StateCode,
} from "./contracts";
import type { TradingPartnerCredentials } from "./credentials";

/** A parsed acknowledgment (999 / 277CA / proprietary). */
export interface AckParsedDto {
  readonly kind: "sync_999" | "sync_277ca" | "async_state_specific";
  readonly outcome: "accepted" | "rejected" | "partial";
  readonly payerClaimControlNumber?: string;
  readonly acceptedLineNumbers?: readonly number[];
  readonly rejectedLineNumbers?: readonly number[];
  readonly errorCodes?: ReadonlyArray<{ code: string; message: string; lineNumber?: number }>;
}

/** A parsed remittance (835 / proprietary) — consumed by M25, not M24. */
export interface RemittanceParsedDto {
  readonly payerClaimControlNumber: string | null;
  readonly paidAmountCents: number;
  readonly adjustments: ReadonlyArray<{ groupCode: string; reasonCode: string; amountCents: number }>;
}

/** The eligibility round-trip result. The Recipient ID digits are NEVER returned (D12 / §3.6). */
export interface EligibilityResult {
  readonly outcome: MedicaidEligibilityOutcome;
  readonly mcoId: McoId | null;
  readonly mcoName: string | null;
  readonly routingChannel: MedicaidChannel | null;
  readonly recipientIdFormatValid: boolean;
  readonly recipientIdMasked: string | null;
  readonly vendorTransactionId: string | null;
}

/** Optional state-specific cap result. */
export interface CapResult {
  readonly patientWithinCap: boolean;
  readonly projectedCents: number;
  readonly capCents: number;
}

/** The assembled-claim snapshot the adapter renders to a wire payload (ids + lines + COB + R&B context). */
export interface MedicaidClaimAssemblySnapshot {
  readonly claimId: MedicaidClaimId;
  readonly patientId: PatientId;
  readonly serviceState: StateCode;
  readonly tob: string;
  readonly serviceFrom: IsoDate;
  readonly serviceTo: IsoDate;
  readonly mcoId: McoId | null;
  readonly medicaidClaimControlNumber: string;
  readonly lines: ReadonlyArray<{
    readonly lineNumber: number;
    readonly serviceDate: IsoDate;
    readonly levelOfCare: MedicaidLevelOfCare;
    readonly revenueCode: string;
    readonly qCode: string;
    readonly modifiers: readonly string[];
    readonly units: number;
    readonly rateCents: number;
    readonly chargesCents: number;
    readonly isRb: boolean;
  }>;
}

export interface MedicaidAdapterMetadata {
  readonly acceptsDocumentedMissingEvv: boolean;
  readonly combinesHospiceAndRb: boolean;
  readonly hasNoeEquivalent: boolean;
  readonly supportedChannels: ReadonlyArray<MedicaidChannel>;
  readonly ackMode: "sync" | "async_poll";
  readonly supportedTobs: ReadonlyArray<string>;
}

export type SubmitResult =
  | { result: "accepted_sync"; vendorTransactionId: string; ack999?: AckParsedDto; ack277ca?: AckParsedDto }
  | { result: "pending_async"; vendorTransactionId: string; nextPollAt: IsoDateTime }
  | { result: "rejected_sync"; rejectionCode: string; rejectionReason: string; vendorTransactionId: string | null }
  | { result: "transport_failure"; nextRetryAt: IsoDateTime };

export type PollResult =
  | { result: "accepted"; ack: AckParsedDto }
  | { result: "still_pending"; nextPollAt: IsoDateTime }
  | { result: "rejected"; rejectionCode: string; rejectionReason: string }
  | { result: "timeout" };

export interface MedicaidAdapter {
  readonly state: StateCode;
  readonly vendor: string;
  readonly version: string;
  readonly metadata: MedicaidAdapterMetadata;

  replacementTob(originalTob: string): string;
  voidTob(originalTob: string): string;

  eligibilityCheck(args: {
    orgId: OrgId;
    patientId: PatientId;
    asOfServiceDate: IsoDate;
    recipientIdPlain: string;
    credentials: TradingPartnerCredentials;
  }): Promise<EligibilityResult>;

  assembleSubmissionPayload(args: {
    orgId: OrgId;
    claimId: MedicaidClaimId;
    claimSnapshot: MedicaidClaimAssemblySnapshot;
    credentials: TradingPartnerCredentials;
  }): Promise<{ body: Uint8Array; idempotencyKey: string; channel: MedicaidChannel; mcoId: McoId | null }>;

  submit(args: {
    body: Uint8Array;
    idempotencyKey: string;
    channel: MedicaidChannel;
    credentials: TradingPartnerCredentials;
  }): Promise<SubmitResult>;

  poll(args: { vendorTransactionId: string; credentials: TradingPartnerCredentials }): Promise<PollResult>;

  parseAcknowledgment(args: { rawPayload: Uint8Array; expectedKind: string }): Promise<AckParsedDto>;

  parseRemittance(args: {
    rawPayload: Uint8Array;
    credentials: TradingPartnerCredentials;
  }): Promise<RemittanceParsedDto>;

  rateLookup(args: {
    serviceDate: IsoDate;
    loc: MedicaidLevelOfCare;
    county: string | null;
  }): Promise<{ rateCents: number; scheduleId: string }>;

  capCalculation?(args: { orgId: OrgId; patientId: PatientId; capYear: number }): Promise<CapResult | null>;

  healthy(): Promise<{
    ok: boolean;
    lastChecked: IsoDateTime;
    latencyMs: number;
    channelStatus: Record<string, "up" | "degraded" | "down">;
  }>;
}
