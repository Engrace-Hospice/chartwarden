import { eventPairHash } from "../event-pair-hash";
// @chartwarden/evv-aggregators — Phase-2 vendor scaffolding (M18-T06, §4.5, §8.5).
//
// HHAeXchange / Tellus / CareBridge ship as INTERFACE-CONFORMANCE-ONLY scaffolding for Phase 2 (§8.5): each
// satisfies `EvvAggregatorAdapter` (so the registry + the conformance test typecheck) but refuses live
// submission — `submit`/`poll` return a `transport_failure` / `timeout` that surfaces as an operator-triage
// item rather than a silent acceptance. They are NOT registered in the default `StateAggregatorRegistry`
// (their states list is empty), so a state that maps to one of these vendors before its Phase-2 enablement
// fails registry-build loudly (`No adapter for vendor …`) rather than silently dropping submissions. A new
// state's go-live replaces the scaffolding with a real implementation behind the SAME interface.
import type {
  AggregatorCredentials,
  AggregatorPollResult,
  AggregatorSubmitResult,
  BuildSubmissionPayloadArgs,
  EvvAggregatorAdapter,
} from "../interface";

abstract class Phase2ScaffoldingAdapter implements EvvAggregatorAdapter {
  abstract readonly vendor: string;
  // Empty states — not selectable until the real implementation lands (§8.5).
  readonly states: readonly string[] = [];

  async buildSubmissionPayload(
    args: BuildSubmissionPayloadArgs,
  ): Promise<{ body: unknown; idempotencyKey: string }> {
    return {
      body: {
        scaffolding: this.vendor,
        checkInEventId: args.checkInEventId,
        checkOutEventId: args.checkOutEventId,
      },
      idempotencyKey: eventPairHash(args.checkInEventId, args.checkOutEventId),
    };
  }

  async submit(_args: {
    body: unknown;
    idempotencyKey: string;
    credentials: AggregatorCredentials;
  }): Promise<AggregatorSubmitResult> {
    // Not enabled — surfaces as a transport failure for operator triage (never a silent acceptance).
    return { result: "transport_failure", nextRetryAt: new Date(0).toISOString() };
  }

  async poll(_args: {
    transactionId: string;
    credentials: AggregatorCredentials;
  }): Promise<AggregatorPollResult> {
    return { result: "timeout" };
  }

  async healthy(): Promise<boolean> {
    return false;
  }
}

/** Phase-2 scaffolding for HHAeXchange (NY / MA / OK and others) — interface conformance only (§8.5). */
export class HhaeXchangeAdapter extends Phase2ScaffoldingAdapter {
  readonly vendor = "hhaexchange";
}

/** Phase-2 scaffolding for Tellus — interface conformance only (§8.5). */
export class TellusAdapter extends Phase2ScaffoldingAdapter {
  readonly vendor = "tellus";
}

/** Phase-2 scaffolding for CareBridge — interface conformance only (§8.5). */
export class CareBridgeAdapter extends Phase2ScaffoldingAdapter {
  readonly vendor = "carebridge";
}
