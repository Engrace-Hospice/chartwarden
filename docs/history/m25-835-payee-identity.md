# M25 835 payee identity and parser follow-ups (#671)

> Follow-up to #659/#660. Point-in-time narrative; generated reports under `audit/` are authoritative. Index: [`README.md`](./README.md).

## Payee identity

- **TIN compare.** M25 never reads `provider_entity`. The composition root (`apps/backend/src/index.ts`, `m25PayeeTinDeps`) reads the sealed EIN through M1's published `FoundationSiteReader.providerEntityBillingFacts` inside the tenant's org tx and opens it with M2's `createTaxIdCipher` (the M23 837I billing-provider precedent), then injects it as `M25IngestDrizzleDeps.payeeTin`. This is the existing injected-port seam pattern (same as `payeeNpi`), so `seams.ts`, the manifest `dependsOn`/`allowedImportPaths` and the `.cjs` mirror need no change. When bound, a payee REF*TJ that is present must equal the tenant's TIN even when the NPI matched. A decrypt failure, an unbound key ring or an unknown entity refuses the file (fail closed, reason carries no TIN, never logged). TINs compare as nine digits, hyphens ignored.
- **Tax-id-only payee (N103=FI).** Default is still REFUSE. `M25_PAYEE_TIN_POLICY={"<orgId>":["medicaid","commercial"]}` (env, parsed by `ingest/payee-tin-policy.ts`) lets that tenant's files for those payer programs pass on an exact TIN match. Env rather than a table: operator-owned, tenant-scoped, no tenant-writable surface that could widen acceptance, no migration. A malformed value throws at boot; unset = refuse everything.
- **PTAN: decision, no storage added.** No coherent owner: `provider_entity` is M1's tenancy spine row, and a PTAN is per payer/MAC enrolment (one provider has several), so a single column would be wrong. It belongs to a payer-enrolment table that does not exist yet; adding it needs a spec decision on the owner module. Migration number 1284 was reserved and is left unused. A PTAN-only payee (N103 XV/other) stays refused.

## Parser

- SVC01 qualifier kept as `ParsedServiceLine.serviceIdQualifier`.
- Date fields are distinct: BPR16 → payment effective date, DTM*405 → adjudication cutoff, GS04 → functional-group creation date. DTM*405 is never substituted for BPR16. Historical `production_date` is retained because its source cannot be recovered with certainty; new rows populate it only from BPR16.
- BPR02=0 with CHK/ACH remains accepted when the rest of the transaction balances; no bank payment is created by this parser or claim posting path. BPR01 H is constrained to zero BPR02 and BPR04 NON. MAC-specific zero-payment combinations remain unverified.
- `receiveAdvice` tokenizes once: `X12835WorkerClient.parse835All` (optional; `parseX12835AllSets`) returns every ST/SE set in one pass; clients without it fall back to one `parse835` per ST02.
- Multiple GS groups / ISA interchanges per file: still rejected. `unwrapEnvelope` and `parseX12EnvelopeHeader` assume one ISA/GS; supporting more means a nested group walk and per-group GE/IEA accounting plus a dedup-key change (ISA13 is per interchange). Not straightforward; left.
- `parse277ca` sidecar: ADR-0029 puts the 277CA with M23's client; the `parse277ca` here stays the fail-closed sidecar mapper and no port is wired. No code change.

## Still blocked on real MAC files / the companion guide

- Validate sum(SVC02)=CLP03 with partial lines, CLP05=sum(PR), and interest in CLP04 (AMT*I) vs PLB L6 against real CGS, NGS J6 and Palmetto hospice 835s.
- Confirm the BPR02=0 / BPR04 rule and the BPR16 vs DTM*405 semantics against the TR3 and real files.
- Which Medicaid/MCO programs actually send FI-only payees (decides who goes in `M25_PAYEE_TIN_POLICY`).
- Where a PTAN should live (payer-enrolment owner) and whether to compare it.
- Multiple GS/ISA per file, if any MAC or clearinghouse sends them.

## M25-671-A date and balancing hardening

- **Date provenance:** new nullable `payment_effective_date`, `adjudication_cutoff_date`, and `functional_group_creation_date` columns retain the source date independently. The additive migration does not backfill historical rows; `production_date` is nullable for new remittances that omit BPR16. Reports use BPR16 when known and the legacy value for old rows.
- **BPR:** BPR02 remains nonnegative and zero is valid. BPR01 H requires BPR02=0 and BPR04=NON; debit BPR03 and unsupported methods remain refused. TRN01 must be `1`. Zero-dollar CHK/ACH is accepted without a synthetic cash movement.
- **Claim balance:** calculations remain integer cents. CLP05 is checked against PR CAS but omitted from the independent balancing sum; CLP02=22 is exempt from the CLP05 comparison as directed by X12 RFI 2548. Service-line and claim charge/payment/CAS balances remain strict.
- **PLB and interest:** payment equation remains BPR02 = sum(CLP04) - sum(PLB); zero PLB amounts are refused. AMT*I total must equal the opposite-signed PLB L6 total, and zero net requires no L6. Test fixtures cover both directions.
- **Evidence:** [X12 RFI 2548](https://x12.org/resources/requests-for-interpretation/rfi-2548-clp05-has-different-value-sum-pr-cas-segments) (CLP05/PR and reversals), [X12 RFI 2123](https://x12.org/resources/requests-for-interpretation/rfi-2123-835-interest-reporting-reqquir) (interest and L6), [X12 RFI 2831](https://x12.org/resources/requests-for-interpretation/rfi-2831-bpr01-and-bpr02-requirements-835) (BPR01/BPR02). Scope is the generic 005010 X221/X221A1 transaction rules. Synthetic tests do not certify CGS, NGS or Palmetto companion-guide behavior.
