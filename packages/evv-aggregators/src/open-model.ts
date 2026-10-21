import type { Clock } from "./adapters/sandata-adapter";
import { eventPairHash } from "./event-pair-hash";
// @chartwarden/evv-aggregators — the open-model (no-aggregator) adapter (M18-T06, §4.5 D1, §8.5).
//
// For non-mandate states and open-model states that allow any alt-EVV vendor conforming to the state's data
// spec, there is no central aggregator to submit to: the EVV record is its own substantiation artifact. This
// adapter short-circuits the submission to an immediate local `accepted` (D7 — open_no_aggregator states
// short-circuit) so the downstream billing gate is never blocked waiting on a vendor that does not exist. The
// sentinel state code `'__ALL_OPEN_MODEL__'` marks this adapter in the registry; it is never matched directly
// by a real two-letter state code.
import type {
  AggregatorCredentials,
  AggregatorPollResult,
  AggregatorSubmitResult,
  BuildSubmissionPayloadArgs,
  EvvAggregatorAdapter,
} from "./interface";

/** The open-model "submission" body — a local verification record (no external vendor payload). */
export interface OpenModelSubmissionBody {
  readonly model: "open_no_aggregator";
  readonly serviceCode: string;
  readonly visitDurationMinutes: number;
  readonly checkInEventId: string;
  readonly checkOutEventId: string;
}

/** The no-aggregator adapter: builds a local verification body and accepts immediately. */
export class OpenModelAdapter implements EvvAggregatorAdapter {
  readonly vendor = "open_model";
  readonly states: readonly string[] = ["__ALL_OPEN_MODEL__"];
  private readonly clock: Clock;

  constructor(opts: { clock?: Clock } = {}) {
    this.clock = opts.clock ?? (() => new Date());
  }

  async buildSubmissionPayload(
    args: BuildSubmissionPayloadArgs,
  ): Promise<{ body: unknown; idempotencyKey: string }> {
    const body: OpenModelSubmissionBody = {
      model: "open_no_aggregator",
      serviceCode: args.serviceTypeCode,
      visitDurationMinutes: args.encounterDurationMinutes,
      checkInEventId: args.checkInEventId,
      checkOutEventId: args.checkOutEventId,
    };
    return { body, idempotencyKey: eventPairHash(args.checkInEventId, args.checkOutEventId) };
  }

  async submit(args: {
    body: unknown;
    idempotencyKey: string;
    credentials: AggregatorCredentials;
  }): Promise<AggregatorSubmitResult> {
    const at = this.clock().toISOString();
    return {
      result: "accepted",
      transactionId: `open-model-${args.idempotencyKey.slice(0, 24)}`,
      acceptedAt: at,
    };
  }

  async poll(_args: {
    transactionId: string;
    credentials: AggregatorCredentials;
  }): Promise<AggregatorPollResult> {
    // Open-model submissions accept synchronously; a poll only ever confirms the already-accepted state.
    return { result: "accepted", acceptedAt: this.clock().toISOString() };
  }

  async healthy(): Promise<boolean> {
    return true;
  }
}
