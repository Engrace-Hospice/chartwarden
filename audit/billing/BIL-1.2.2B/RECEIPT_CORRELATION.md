# Receipt correlation

Direct upload responses preserve allowlisted Claim.MD fields in `SubmissionReceipt.vendorIdentifiers`. Upload-list reconciliation now preserves `inboundid` as `{field:'inboundid',value}` and only reports a confirmed hit when the field is present and within the vendor-ID bound. Missing `inboundid` is unknown/error, never the literal ID `unknown`.

M23/M41 consumers append receipt observations with source provenance:

- `upload_response` for the immediate vendor response.
- `upload_reconciliation` for upload-list `inboundid` confirmation.
- `attempt_store_replay` for legacy generic durable attempt receipts where field-level vendor provenance is unavailable.

Generic `clearinghouseSubmissionId` is stored only as opaque evidence and is not promoted to `claimid`/`claimmd_id`. Message-level `responseid` does not identify an outbound attempt. `fileid`, `inboundid`, `batchid`, `claimid`, `claimmd_id`, `remote_claimid`, and `pcn` remain source-field distinct. The matcher accepts only exact field-to-field comparisons; file/batch evidence additionally requires matching PCN.

No new Claim.MD network poller was added. Existing transport upload-list reconciliation remains the sole enrichment source. The mock transport test verifies source retention using synthetic upload responses; Claim.MD field guarantees and account-specific behavior are not runtime-certified.
