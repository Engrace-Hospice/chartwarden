// @chartwarden/forms — §3.1 / §1.2 the PrintVendorAdapter contract (Architecture §25.14 adapter mandate).
//
// M22 owns the adapter CONTRACT; the per-tenant configuration lives on `tenant_template_overlay`. The
// default is the deny-stub (no print vendor configured → M22 emits the rendered PDF as a tenant-
// downloadable artifact and the originating module surfaces a "Counselor confirmed mailed" capture, per
// M16 §7.6). The Lob / PostalMethods adapters are optional and land in later M22 tasks. T01 ships the
// contract + the deny-stub shape only.

/** §3.1 — the result of dispatching a rendered document to an external print/mail vendor. */
export interface PrintDispatchResult {
  readonly dispatched: boolean;
  /** Vendor-side message id used to dedup the delivery webhook (§2.6). `null` when not dispatched. */
  readonly vendorMessageId: string | null;
  /** Set when `dispatched=false`; e.g. `"no_print_vendor_configured"`. */
  readonly reason: string | null;
}

/** §3.1 — the contract every print-vendor adapter (Lob, PostalMethods, …) implements. */
export interface PrintVendorAdapter {
  readonly vendorKey: string;
  dispatch(args: {
    readonly organizationId: string;
    readonly documentVersionId: string;
    readonly minioObjectKey: string;
  }): Promise<PrintDispatchResult>;
}

/** §1.2 — the default adapter when no print vendor is configured. Always `dispatched=false`; the rendered
 * PDF is surfaced as a tenant-downloadable artifact instead. */
export const denyStubPrintVendorAdapter: PrintVendorAdapter = {
  vendorKey: "none",
  dispatch: async () => ({
    dispatched: false,
    vendorMessageId: null,
    reason: "no_print_vendor_configured",
  }),
};
