# M25 835 payee identity and parser follow-ups (#671)

> Follow-up to #659/#660. Point-in-time narrative; generated reports under `audit/` are authoritative. Index: [`README.md`](./README.md).

## Payee identity

- **TIN compare.** M25 never reads `provider_entity`. The composition root (`apps/backend/src/index.ts`, `m25PayeeTinDeps`) reads the sealed EIN through M1's published `FoundationSiteReader.providerEntityBillingFacts` inside the tenant's org tx and opens it with M2's `createTaxIdCipher` (the M23 837I billing-provider precedent), then injects it as `M25IngestDrizzleDeps.payeeTin`. This is the existing injected-port seam pattern (same as `payeeNpi`), so `seams.ts`, the manifest `dependsOn`/`allowedImportPaths` and the `.cjs` mirror need no change. When bound, a payee REF*TJ that is present must equal the tenant's TIN even when the NPI matched. A decrypt failure, an unbound key ring or an unknown entity refuses the file (fail closed, reason carries no TIN, never logged). TINs compare as nine digits, hyphens ignored.
- **Tax-id-only payee (N103=FI).** Default is still REFUSE. `M25_PAYEE_TIN_POLICY={"<orgId>":["medicaid","commercial"]}` (env, parsed by `ingest/payee-tin-policy.ts`) lets that tenant's files for those payer programs pass on an exact TIN match. Env rather than a table: operator-owned, tenant-scoped, no tenant-writable surface that could widen acceptance, no migration. A malformed value throws at boot; unset = refuse everything.
- **PTAN: decision, no storage added.** No coherent owner: `provider_entity` is M1's tenancy spine row, and a PTAN is per payer/MAC enrolment (one provider has several), so a single column would be wrong. It belongs to a payer-enrolment table that does not exist yet; adding it needs a spec decision on the owner module. Migration number 1284 was reserved and is left unused. A PTAN-only payee (N103 XV/other) stays refused.

## Parser

- SVC01 qualifier kept as `ParsedServiceLine.serviceIdQualifier`.
- `productionDate` = BPR16, falling back to DTM*405. Per the 5010 835 TR3 BPR16 is the check issue / EFT effective date and DTM*405 the production date; they are different facts. The TR3 is not in this repo (`docs/reference/cms` holds only CMS manuals), so the rule is recorded from knowledge, unverified. Pinned by tests.
- BPR02 = 0 with BPR04 other than NON: accepted, pinned by a test, not enforced (spec text unavailable; repo zero-pay fixture uses NON).
- `receiveAdvice` tokenizes once: `X12835WorkerClient.parse835All` (optional; `parseX12835AllSets`) returns every ST/SE set in one pass; clients without it fall back to one `parse835` per ST02.
- Multiple GS groups / ISA interchanges per file: still rejected. `unwrapEnvelope` and `parseX12EnvelopeHeader` assume one ISA/GS; supporting more means a nested group walk and per-group GE/IEA accounting plus a dedup-key change (ISA13 is per interchange). Not straightforward; left.
- `parse277ca` sidecar: ADR-0029 puts the 277CA with M23's client; the `parse277ca` here stays the fail-closed sidecar mapper and no port is wired. No code change.

## Still blocked on real MAC files / the companion guide

- Validate sum(SVC02)=CLP03 with partial lines, CLP05=sum(PR), and interest in CLP04 (AMT*I) vs PLB L6 against real CGS, NGS J6 and Palmetto hospice 835s.
- Confirm the BPR02=0 / BPR04 rule and the BPR16 vs DTM*405 semantics against the TR3 and real files.
- Which Medicaid/MCO programs actually send FI-only payees (decides who goes in `M25_PAYEE_TIN_POLICY`).
- Where a PTAN should live (payer-enrolment owner) and whether to compare it.
- Multiple GS/ISA per file, if any MAC or clearinghouse sends them.
