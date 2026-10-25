// Adapter-side mapping of a ClearinghouseTransport `AckEvent` onto M23's acknowledgment alphabet (ADR-0053 D2).
//
// M23's lifecycle machines were built for the direct-MAC path: a 999 moves a record to `ack_pending`, a 277CA moves it to
// `ack_accepted` / `ack_rejected`. A clearinghouse answers BEFORE the payer, so its acceptance must never reach
// `ack_accepted` (that state is judged for NOE timeliness, ADR-0052 D4). The clearinghouse stage therefore rides the 999
// edge and only a payer-stage event rides the 277CA edge. Pure: no I/O, no clock.
import type { AckDisposition, AckEvent, AckStage } from "../clearinghouse/types";

export interface RoutedAckEvent {
  readonly kind: "ack_999" | "ack_277ca";
  readonly stage: AckStage;
  readonly outcome: AckDisposition;
}

export function routeAckEvent(event: AckEvent): RoutedAckEvent {
  if (event === null || typeof event !== "object") throw new Error("ack event: not an object");
  // Widened: the type forbids a clearinghouse partial, but vendor JSON is not typed.
  const { stage, disposition }: { stage: unknown; disposition: unknown } = event;
  if (stage !== "clearinghouse" && stage !== "payer") throw new Error("ack event: unknown stage");
  if (disposition !== "accepted" && disposition !== "rejected" && disposition !== "partial") {
    throw new Error("ack event: unknown disposition");
  }
  // A partial is a 277CA (payer) answer; a clearinghouse 999 is accepted or rejected. Fail closed on the mix.
  if (disposition === "partial" && stage === "clearinghouse") {
    throw new Error("ack event: a partial disposition is payer-stage only");
  }
  return { kind: stage === "clearinghouse" ? "ack_999" : "ack_277ca", stage, outcome: disposition };
}
