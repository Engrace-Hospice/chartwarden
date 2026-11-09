# Immutable submitted-line evidence

`packages/x12-837-client/src/clearinghouse/submission-evidence.ts` extracts line position, procedure/revenue code, service date, units, charge cents, and a line control reference only when `REF*6R` exists in the final submitted bytes. The parser hashes the exact X12 payload as before.

M23 and M41 pass source-owned internal line IDs and values from the same loaded/rendered claim snapshot into the existing evidence reservation. Reservation compares those values to the parsed final payload and persists them in `claimmd_submission_line_evidence` in the same transaction as attempt evidence. Evidence is append-only and bound to attempt, tenant, provider, account/environment, and payload digest.

Legacy attempts are not backfilled. A missing 835 reference or missing original line evidence remains unavailable; line matching/allocation is not certified. No new `REF*6R` is emitted. Vendor/payer echo support is unverified. X12 reference: [X12 005010X222 TR3](https://ecommerce.x12.org/assets/tr3/x222-005010-PDF.pdf); this does not establish support for every payer or this product's routes.
