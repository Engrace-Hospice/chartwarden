// @wardenx/messaging — webhook rejection error (M36-T08, spec §4.9).
//
// A ChartWardenError subclass so the M1 Fastify error handler renders the §4.9 rejection into the
// standard error envelope without a cross-module edge (the same reason routes throw @wardenx/types
// errors). `WebhookError(status, code)` carries the security-relevant `code` (e.g.
// `REPLAY_WINDOW_EXPIRED`, `INVALID_SIGNATURE`, `FORBIDDEN_SOURCE`); a forged/stale webhook is
// rejected with this BEFORE any application logic runs (§4.9 — neither layer may be short-circuited).
import { ChartWardenError } from "@wardenx/types";

/** A webhook request rejected by the §4.9 two-layer defense (replay window + signature). */
export class WebhookError extends ChartWardenError {
  constructor(statusCode: number, code: string, message: string = code) {
    super(code, message, statusCode);
    this.name = "WebhookError";
  }
}
