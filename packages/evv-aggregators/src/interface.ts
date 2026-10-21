// @chartwarden/evv-aggregators — the §4.5 D1 `EvvAggregatorAdapter` interface (M18-T01).
//
// Per architecture §25.14 (the adapter mandate) this package is the ONLY place a state-EVV-aggregator
// vendor's endpoint, credentials, and payload shape live; dependency-cruiser (architecture-fitness §25.15
// check #2) forbids any other module — including the M18 backend — from calling Sandata / HHAeXchange /
// Tellus / CareBridge directly. The M18 backend consumes ONLY this interface via the boot-registered
// `StateAggregatorRegistry`.
//
// M18-T01 ships the interface + credentials shape (the layout). The Phase-1 `SandataAdapter` + the
// `OpenModelAdapter` (the no-aggregator open-model path), the per-state `StateAggregatorRegistry` selector
// (reads M40 master data), the circuit-breaker integration, and the degraded-error envelope land in
// M18-T06. The HHAeXchange / Tellus / CareBridge adapters are Phase-2 candidates.
//
// PHI boundary: the submission body is built here from typed inputs and encrypted by the caller before
// persist (`payload_cipher`); the adapter never persists or logs PHI itself.

import type { OrgId, VisitId } from "@chartwarden/types";

/** Per-(provider, state) credentials resolved by the M18 credential-store layer and handed to `submit`/
 * `poll`. The `secrets` map is opaque to the M18 backend — only the adapter interprets its keys. */
export interface AggregatorCredentials {
  readonly providerEntityId: string;
  readonly secrets: Record<string, string>;
}

/** The typed inputs to a (visit, event-pair) submission payload. No coordinates — EVV aggregators receive
 * timestamps + service metadata, not raw GPS. */
export interface BuildSubmissionPayloadArgs {
  readonly orgId: OrgId;
  readonly visitId: VisitId;
  readonly checkInEventId: string;
  readonly checkOutEventId: string;
  readonly serviceTypeCode: string;
  readonly clinicianNpi: string | null;
  /** State-Medicaid ID or equivalent. */
  readonly patientStateIdentifier: string;
  readonly encounterDurationMinutes: number;
}

/** The `submit` call result + next-action signal. */
export type AggregatorSubmitResult =
  | { result: "accepted"; transactionId: string; acceptedAt: string }
  | { result: "pending_async"; transactionId: string; nextPollAt: string }
  | {
      result: "rejected";
      rejectionCode: string;
      rejectionReason: string;
      transactionId: string | null;
    }
  | { result: "transport_failure"; nextRetryAt: string };

/** The `poll` call result for adapters whose vendor responds asynchronously. */
export type AggregatorPollResult =
  | { result: "accepted"; acceptedAt: string }
  | { result: "still_pending"; nextPollAt: string }
  | { result: "rejected"; rejectionCode: string; rejectionReason: string }
  | { result: "timeout" };

/** §4.5 D1 — the per-state aggregator adapter the M18 backend depends on. The sentinel state code
 * `'__ALL_OPEN_MODEL__'` marks the open-model (no-aggregator) adapter. */
export interface EvvAggregatorAdapter {
  /** Identifier for ops dashboards and the per-state registry. */
  readonly vendor: string;
  /** The state codes this adapter serves (e.g. `['WI']`, `['NY','MA','OK']`, `['__ALL_OPEN_MODEL__']`). */
  readonly states: readonly string[];

  /** Build the payload for a (visit, event-pair). The body is encrypted by the caller before persist. */
  buildSubmissionPayload(
    args: BuildSubmissionPayloadArgs,
  ): Promise<{ body: unknown; idempotencyKey: string }>;

  /** Submit. Returns the vendor's transaction id + the next-action signal. */
  submit(args: {
    body: unknown;
    idempotencyKey: string;
    credentials: AggregatorCredentials;
  }): Promise<AggregatorSubmitResult>;

  /** Poll for adapters whose vendor responds asynchronously. */
  poll(args: {
    transactionId: string;
    credentials: AggregatorCredentials;
  }): Promise<AggregatorPollResult>;

  /** Health probe for the ops dashboard. */
  healthy(): Promise<boolean>;
}
