// @wardenx/quality — consumed-seam view of M11 (Orders). PRESENT producer (§4.4).
//
// M30 consumes M11's `OrderProvider.getVerbalOrderTimeliness` for the verbal-order-signature-on-time
// CoP 418.104(b) indicator and `OrderProvider.getOrderCompletionRate` for the order-completion measure;
// it does NOT write to M11. Aggregate-by-default (D6). Bound to the live M11 reader via `getSeam` (P2C).
// (The `m11.order.verbal_expired_unsigned` auto-incident is outbox-side, not a read here.)
export interface QualityOrderConsumer {
  /** M11 `OrderProvider.getVerbalOrderTimeliness` — verbal-order-signed-on-time rate over a window. */
  verbalOrderTimelinessRate(
    organizationId: string,
    period: { from: string; to: string },
  ): Promise<number>;
  /** M11 `OrderProvider.getOrderCompletionRate` — order-completion rate over a window. */
  orderCompletionRate(
    organizationId: string,
    period: { from: string; to: string },
  ): Promise<number>;
}
