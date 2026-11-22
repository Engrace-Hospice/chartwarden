# M24-1075-L3 — Synthetic Institutional 837I Technical Qualification

Date: 2026-11-22
Status: offline structural foundation; not payer-certified or production-authorized.

## Reuse boundary and design decisions

1. `@chartwarden/x12-837-client` remains the only X12 837I serializer. Its envelope, delimiter validation, diagnosis/date/amount validation, institutional claim loops, and existing 999/277CA readers are reused. The M23 assembler and its Medicare qualification rules are not reused.
2. The shared X12 party contract gains an explicit, generic subscriber member identifier and a claim-filing indicator while preserving the legacy `mbi` input and Medicare defaults used by M23. M24 passes `MC` and a Medicaid member ID; it does not call the identifier an MBI.
3. M24 document and policy mapping lives in `@chartwarden/medicaid-adapters`, not the M23-owned billing package. Its production-facing mapper requires a package-private unique-symbol capability and fails with a typed gap for caller-created facts. No production reader currently mints that capability, so production document generation remains unavailable in this lot. The existing electronic-submission hard stop is unchanged.
4. The synthetic conformance entry point is exposed only through the package's `./testing` subpath. It requires an explicit synthetic marker and is not called by production claim routes. Rendering returns transient X12/vendor request objects and does not write claim or submission state.
5. Vendor request mappers are pure data constructors. Stedi institutional JSON and raw X12 are distinct body models. Claim.MD models the documented multipart X12 file upload. No mapper imports or constructs either vendor's HTTP transport. The test-only receipt simulation accepts only an enum outcome and request data; it accepts no callback or transport port.
6. Synthetic acknowledgment correlation is in-memory and scoped by organization, provider entity, canonical payer/program and claim control number. A 999 must match both AK1 group and AK2 transaction controls. Shared 277CA parsing exposes claim control/date only; because it does not establish payer identity, raw 277CA inspection returns those facts without assigning canonical payer identity. The synthetic typed-event correlator reports duplicate, delayed, out-of-order, mismatched-payer and unknown events without mutating M24/M25 claim state.

## Vendor contract sources inspected

- Stedi institutional claims guide: https://www.stedi.com/docs/healthcare/submit-institutional-claims
- Stedi 837I JSON API: https://www.stedi.com/docs/healthcare/api-reference/post-healthcare-institutional-claims
- Stedi raw X12 API: https://www.stedi.com/docs/healthcare/api-reference/post-healthcare-institutional-claims-raw-x12
- Claim.MD supported file formats: https://docs.claim.md/docs/supported-file-formats
- Claim.MD API upload contract: https://api.claim.md/
- Claim.MD test account workflow: https://docs.claim.md/docs/test-account-quickstart-guide

These sources document request shapes and transport workflows. They do not qualify an EOCCO payer destination, hospice coding, provider participation, payer acceptance, or production use for Engrace.

## Deliberately unresolved

No Oregon/EOCCO claim format or code is certified by this work. CHC clinical hours, in-home respite coding, qualified rates, payer authorization requirements, provider/transaction enrollment, clearinghouse payer mapping and customer production activation remain unresolved. No real transport, payer acknowledgment, ERA, or production claim-state transition is enabled.

## Qualification performed

- Focused synthetic and shared X12 regression run: **12 test files, 312 tests passed**. It covered M24 mapping, document gaps, X12 rendering, unit/date/total validation, Stedi request mapping, Claim.MD upload representation, route refusal, in-memory fake delivery, synthetic idempotency/ack correlation, shared 999/277CA helpers, M23 claim rendering/party/error paths, and the shared commercial 837I serializer used by M41.
- Targeted TypeScript checks for `packages/x12-837-client` and `packages/medicaid-adapters` passed with `bunx tsc -p <package>/tsconfig.json --noEmit --pretty false`.
- Changed-file Biome and `git diff --check` passed. `bun run harness:phi-scan` passed with 13,447 files scanned.
- The synthetic outcome simulation accepts no callback and the test asserted zero `fetch` calls. The synthetic package subpath imports no Stedi or Claim.MD transport implementation. No HTTP, SFTP, vendor sandbox, payer transaction, database, or production route was used.
- The production mapper's caller-created facts are refused at runtime; no authoritative production reader issues its package-private validation capability. The raw 277CA helper deliberately does not assert payer identity; payer/scope mismatch tests exercise only the typed synthetic event correlation contract.
- No database model or migration changed in L3; PostgreSQL/RLS suites were not applicable. The repository-wide backend typecheck, complete architecture fitness suite, vendor sandbox tests and end-to-end UI/browser qualification were not run for this increment.

The results are pure unit tested, synthetic X12 tested, and offline vendor-contract mapped. They are **not** vendor-sandbox tested, payer certified, or production authorized. A successful serialization is not evidence of EOCCO conformance.
