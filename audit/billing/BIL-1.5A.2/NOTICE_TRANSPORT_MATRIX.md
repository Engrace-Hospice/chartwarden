# Notice transport support matrix

Claim.MD's current [supported file formats](https://docs.claim.md/docs/supported-file-formats) document 837I institutional claims. The official documentation located during this phase does not expressly document NOE, NOTR, or transfer notice handling; searches for those specific notice terms did not find a vendor capability statement. Thus general 837I support is not treated as hospice notice support. No Claim.MD commercial agreement or payer route was verified in this change.

| Notice | Internal document / payload | WardenX route today | Claim.MD transport result | Classification |
|---|---|---|---|---|
| NOE | `noe_record`; `generateNoe()` yields final X12 string | `runNoeSubmit()` calls the injected upload port; legacy mode reaches MAC portal | Transport `submitNotice` accepts raw X12 only after institutional 837I identity/evidence reservation; off unless explicit flag | Legacy path implemented; Claim.MD external route **unverified**, disabled by default |
| NOTR | `notr_record`; `generateNotr()` yields final X12 string | `runNotrSubmit()` calls the injected upload port; legacy mode reaches MAC portal | Same typed notice evidence path; no claim identity fabrication | Legacy path implemented; Claim.MD external route **unverified**, disabled by default |
| Transfer | `transfer_notice_record`; transfer-specific `buildTransferNoticeDocument()` then X12 generator | `runTransferNoticeSubmit()` uses durable original submission ID | Same typed notice evidence path; no claim/PCN aliasing | Internal 837I generation implemented; Claim.MD route **unverified**, disabled by default |

The committed synthetic route fixtures use distinct claim type/frequency values: NOE `81:A:A`, NOTR `81:A:B`, transfer `81:A:C`; the transfer document builder allows the paired `8xD` frequency too. The evidence parser enforces these kind-specific discriminators, exact CLM01-to-notice-control equality, and the documented Claim.MD receiver identity. This is repository/test-fixture behavior, not a claim of payer/vendor policy.

The source calls `ClearinghouseTransport.submitNotice()` and sends raw X12. This proves only WardenX adapter wiring. It does not prove Claim.MD supports each hospice notice kind, correct payer route, or a notice-level acknowledgment. No external portal form, XLSX enrollment, API-specific notice contract, or payer enrollment was verified. Claim.MD route remains unsupported for activation until contract and test-account evidence confirm it.

Transfer has its own notice document builder; no claim business semantics were added. The transport checks the final bytes for one institutional 837 transaction envelope and a unique billing provider and payer identity; it records CLM01, if present, only as `outbound_business_control_number`.
