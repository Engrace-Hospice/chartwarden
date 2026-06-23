// @wardenx/evv-aggregators — the Phase-1 Sandata adapter (M18-T06, §4.5 D1, §7.8/§7.9, §8.5).
//
// Sandata covers the plurality of mandate states by population; it ships ENABLED at launch (the other vendor
// adapters are Phase-2 scaffolding). Per §8.5 this file is one of the ONLY places a Sandata endpoint / payload
// shape may live — dependency-cruiser forbids any import of a `sandata-*` SDK from outside this package.
//
// Sandata is a polling-mode vendor (§4.8 `m18.aggregator-response-poller`): `submit()` hands the payload to the
// transport and (in the common case) returns `pending_async` with a transaction id + a next-poll time; a later
// `poll()` returns the terminal `accepted | rejected | timeout`. The HTTP/transport itself is injected (the
// `SandataTransport` port) so the adapter stays deterministic and unit-testable with no network — the default
// Phase-1 transport is a sandbox stub that accepts on the first poll. A real HTTPS transport plugs in here when
// M1 infra wires Sandata sandbox/production credentials; the adapter's logic does not change (§8.5).
//
// PHI boundary: `buildSubmissionPayload` constructs the body from typed inputs (no coordinates — EVV aggregators
// receive timestamps + service metadata, not raw GPS, per §8.3); the caller encrypts it before persist
// (`payload_cipher`). The adapter never persists or logs PHI.
import {
  type AggregatorCredentials,
  type AggregatorPollResult,
  type AggregatorSubmitResult,
  type BuildSubmissionPayloadArgs,
  type EvvAggregatorAdapter,
} from "../interface";
import { eventPairHash } from "../event-pair-hash";

/** The documented Sandata submission body — the MINIMUM field set the vendor mandates (§8.3 PHI-leak
 * resistance: no clinician home address, no patient SSN, no diagnosis codes, no encounter notes). */
export interface SandataSubmissionBody {
  readonly providerNpi: string | null;
  readonly memberMedicaidId: string;
  readonly serviceCode: string;
  readonly visitDurationMinutes: number;
  readonly checkInEventId: string;
  readonly checkOutEventId: string;
}

/** The injected transport the adapter calls (the seam that becomes real HTTPS in production). Kept as a port so
 * the §7.8/§7.9 flows are exercised deterministically with a sandbox stub and no network. */
export interface SandataTransport {
  post(args: {
    readonly body: unknown;
    readonly idempotencyKey: string;
    readonly credentials: AggregatorCredentials;
  }): Promise<AggregatorSubmitResult>;
  pollStatus(args: {
    readonly transactionId: string;
    readonly credentials: AggregatorCredentials;
  }): Promise<AggregatorPollResult>;
  ping(): Promise<boolean>;
}

/** A clock injected for deterministic ISO timestamps (the adapter never reads the wall clock directly). */
export type Clock = () => Date;

const SANDATA_STATES = [
  // Sandata's largest-by-population mandate states (Phase-1 launch set; extended via M40 master data).
  "TX",
  "FL",
  "PA",
  "OH",
  "NC",
] as const;

/** The default Phase-1 sandbox transport: deterministic, no network. `post` acknowledges asynchronously
 * (Sandata is polling-mode) and `pollStatus` accepts on the first poll. The transaction id is derived from the
 * idempotency key so a retry of the same event-pair yields the same id (vendor-dedupe parity). */
export function createSandataSandboxTransport(clock: Clock = () => new Date()): SandataTransport {
  const pollDelayMs = 5 * 60 * 1000; // §4.8 — 5-minute poll cadence
  return {
    async post({ idempotencyKey }) {
      return {
        result: "pending_async",
        transactionId: `sandata-sbx-${idempotencyKey.slice(0, 24)}`,
        nextPollAt: new Date(clock().getTime() + pollDelayMs).toISOString(),
      };
    },
    async pollStatus() {
      return { result: "accepted", acceptedAt: clock().toISOString() };
    },
    async ping() {
      return true;
    },
  };
}

/** Phase-1 Sandata adapter. Vendor `'sandata'`; states resolved from M40 master data at registry-build time but
 * defaulted to the launch set so a non-M40 boot still selects Sandata for its mandate states. */
export class SandataAdapter implements EvvAggregatorAdapter {
  readonly vendor = "sandata";
  readonly states: readonly string[];
  private readonly transport: SandataTransport;

  constructor(opts: { transport?: SandataTransport; states?: readonly string[]; clock?: Clock } = {}) {
    this.transport = opts.transport ?? createSandataSandboxTransport(opts.clock);
    this.states = opts.states ?? SANDATA_STATES;
  }

  async buildSubmissionPayload(
    args: BuildSubmissionPayloadArgs,
  ): Promise<{ body: unknown; idempotencyKey: string }> {
    const body: SandataSubmissionBody = {
      providerNpi: args.clinicianNpi,
      memberMedicaidId: args.patientStateIdentifier,
      serviceCode: args.serviceTypeCode,
      visitDurationMinutes: args.encounterDurationMinutes,
      checkInEventId: args.checkInEventId,
      checkOutEventId: args.checkOutEventId,
    };
    return { body, idempotencyKey: eventPairHash(args.checkInEventId, args.checkOutEventId) };
  }

  submit(args: {
    body: unknown;
    idempotencyKey: string;
    credentials: AggregatorCredentials;
  }): Promise<AggregatorSubmitResult> {
    return this.transport.post(args);
  }

  poll(args: {
    transactionId: string;
    credentials: AggregatorCredentials;
  }): Promise<AggregatorPollResult> {
    return this.transport.pollStatus(args);
  }

  healthy(): Promise<boolean> {
    return this.transport.ping();
  }
}
