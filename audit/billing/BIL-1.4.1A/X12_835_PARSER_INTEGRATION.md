# X12 835 parser integration

`apps/backend/src/modules/25-remittance/ingest/claimmd-era-resolution.ts` calls `parseX12835AllSets` from `@chartwarden/x12-835-client` for each decrypted original file. The parser remains the existing in-process TypeScript implementation in `packages/x12-835-client/src/parse-x12-835.ts`; no second tokenizer/parser was added. Parse failure is a fixed safe `X12_PARSE_INVALID` outcome. One malformed file invalidates resolution for the complete source artifact.

The parser representation now exposes functional group control number, all payer/payee REF values, claim and service-line REF values (including `REF*6R`), individual PLB reason/reference/signed amount pairs, and unknown ST..SE segments. Existing CLP status, payer ICN, charge/payment/patient responsibility, CAS, SVC procedure/revenue identifiers, dates, and remarks remain intact. Existing exact-cent parser behavior remains the rounding boundary; resolution stores the parsed summary encrypted.

`CLP02`, zero-pay, reversal status, negative PLB values, CAS, service lines and unknown segments are preserved as evidence and are not interpreted as posting authorization. The parsed representation is held in process only; the persisted decision summary is encrypted and does not copy original 835 bytes.
