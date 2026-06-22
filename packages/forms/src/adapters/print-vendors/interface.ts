// @wardenx/forms — the §3.1 `PrintVendorAdapter` contract (M22-T01).
//
// Per architecture §25.14 (the adapter mandate) a physical-mail print vendor (Lob.com, PostalMethods, …)
// may only be integrated here. The default registered adapter is the deny-stub (no print vendor configured);
// the optional Lob / PostalMethods adapters land in M22-T03 and are registered only when a tenant configures
// outbound physical mail. A `form_fill` transitions `rendered → delivered` only on a vendor delivery webhook
// (§2.2.4), verified by HMAC + deduped by `(vendor_message_id, organization_id)` (§2.6).
//
// M22-T01 ships the interface (the layout). This file is type-only.

/** The §2.2.4 delivery dispatch the M22 backend hands to a configured print vendor after a render succeeds. */
export interface PrintVendorDispatchArgs {
  readonly organizationId: string;
  readonly documentVersionId: string;
  /** The rendered binary to mail. */
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  /** The recipient mailing address (opaque to the M22 backend; only the adapter interprets it). */
  readonly recipient: PrintRecipient;
}

/** A physical-mail recipient address. */
export interface PrintRecipient {
  readonly name: string;
  readonly addressLines: readonly string[];
  readonly city: string;
  readonly stateCode: string;
  readonly postalCode: string;
}

/** The dispatch result + the vendor message id used as the delivery-webhook dedup key. */
export type PrintVendorDispatchResult =
  | { result: "accepted"; vendorMessageId: string }
  | { result: "rejected"; reason: string }
  | { result: "no_vendor_configured" };

/** §3.1 — the print-vendor adapter the M22 form-render worker depends on. The deny-stub returns
 * `no_vendor_configured`; real adapters (Lob / PostalMethods) return a `vendorMessageId`. */
export interface PrintVendorAdapter {
  /** Identifier for ops dashboards. */
  readonly vendor: string;
  /** Dispatch a rendered document for physical mail. */
  dispatch(args: PrintVendorDispatchArgs): Promise<PrintVendorDispatchResult>;
  /** Verify an inbound delivery webhook's HMAC signature (§2.6). */
  verifyWebhookSignature(args: { rawBody: string; signatureHeader: string }): boolean;
}
