# Claim.MD identifier preservation

The existing Claim.MD transport in `packages/x12-837-client/src/clearinghouse/claimmd-transport.ts` extracts claim `claimid` or file `fileid` for its legacy generic submission ID. This slice additionally preserves recognized raw upload response identifiers as `{field,value}` pairs on `SubmissionReceipt.vendorIdentifiers` before returning to M23/M41.

| Vendor field | Stored namespace | Notes |
|---|---|---|
| `fileid`, `inboundid` | `file` | Distinct source fields remain distinct. `inboundid` may be discovered by upload-list reconciliation in a later enrichment path. |
| `batchid` | `batch` | Exact field name retained. |
| `claimid` | `claim` | Exact field name retained. |
| `claimmd_id`, `remote_claimid` | `remote_claim` | Namespaces are internal categories, not claims about equivalence in vendor semantics. |
| `pcn` | `pcn` | Distinct from payer ICN/DCN and from ISA13. |
| generic `clearinghouseSubmissionId` | `opaque_submission` | Used when original vendor field provenance is unavailable, such as replay. |

The parser bounds identifier values and allowlists fields. Values are treated as external identifiers, never as trusted tenant/provider routing authority. No remote identifier alone may select a tenant. Routing must join it to immutable evidence, account reference, environment, and explicit provider/claim scope in BIL-1.2.2B.

This implementation reflects fields recognized by current source and available vendor documentation. It does not establish that every field is present for every upload response or guarantee vendor semantics. No live request was made.
