# M38 — catalog loading and search filters (decision record)

Context: the `CodeSearchInput` pickers (branch `feat/code-search-pickers`) call
`GET /api/v1/terminology/{system}/search`. On the dev DB only ICD-10-CM is loaded (196,589 rows); `concept_loinc`,
`concept_snomed`, `concept_carc`, `concept_rarc`, `concept_rxnorm` are empty, and two search options did nothing.

## A. Search filters (fixed)

- `inValueSet` was ignored by `terminology-store-db.ts` `searchConcepts`. It now restricts to the value set's platform
  `value_set_member` rows covering `asOf` for the searched system, plus the calling tenant's live
  `value_set_tenant_extension` rows. The tenant read runs in `withOrgContext` with the org taken from the request
  context (never a parameter), so RLS scopes it; `SearchOptions.orgId` carries it. An unknown value set is 404, not an
  empty list. Members with no concept row (the `sud_test_loinc` LOINC codes while `concept_loinc` is unloaded) are
  still searchable through `annotations.display`; `billableOnly` skips them because there is no status to trust.
- `billableOnly` was ICD-10-CM only. Decision: it means "usable on a claim". ICD-10-CM: `status = active` AND
  `is_billable_leaf`. Every other system has no billable flag, so it means `status = active` (a deprecated or retired
  code is not billable). Not a no-op; documented on `SearchOptions` and covered by tests. The in-memory store matches.
- LIKE wildcards in the query are now escaped (`q=%` used to match everything); results are ordered by code.
- Proof: unit tests (`packages/terminology/__tests__/search-filters.test.ts`) and the new live suite
  `apps/backend/__tests__/m38-terminology-search.live.test.ts` (`bun run test:m38:search:live`, ci.yml row "M38
  terminology search"): through the real route, real permission gate, as NOBYPASSRLS `wardenx_app`, data loaded through
  the real loader. Run on a private `pgvector/pgvector:pg18` container. The existing M38 admin and loader live suites
  were re-run green (admin needed a stale expectation fixed: migration 0500 added `sud_test_loinc` to the catalog list).

## B. Catalogs: what was loaded vs what needs an operator

Nothing was loaded into any shared or production database. The loader, the admin routes and the licence gate already
existed (GAP-063/GAP-108); this work added the missing pieces and a runbook
(`docs/runbooks/terminology-catalog-loading.md`).

| System | Status | Why |
|---|---|---|
| CARC | loader ready (HTML page parser + CSV), **not seeded** | public pages, but X12 asserts copyright; see below |
| RARC | loader ready (HTML page parser + CSV), **not seeded** | same |
| LOINC | loader ready, needs operator | free loinc.org account + licence acceptance + attestation |
| SNOMED CT | loader ready (now reads language refset preferred terms), needs operator | UMLS/affiliate licence + attestation |
| RxNorm | loader ready (term-type filter tightened), needs operator | UMLS licence + attestation |

### CARC / RARC: why there is no seed migration

Retrieved 2026-10-08 from `https://x12.org/codes/claim-adjustment-reason-codes` (list dated 11/1/2025: 407 rows, 297
active / 110 retired) and `https://x12.org/codes/remittance-advice-remark-codes` (list dated 7/1/2026: 1216 rows, 1137
active / 79 retired). (`wpc-edi.com/reference/…` now 404s; WPC distributes on X12's behalf at x12.org/codes.) The pages
need no login and no click-through, and they are the authoritative lists. But x12.org states "X12 manages the
exclusive copyright to all standards, publications, and products… Any use of any X12 work product must be compliant
with US Copyright laws and X12 Intellectual Property policies", and reproduction needs permission (`ip@x12.org`); WPC
also sells code-list subscriptions. Reading the page is not redistributing it, but a migration would copy 1,600+ rows of
their text into the repository and into every environment. I judged that a licensing decision for the owner, not for an
implementer: the brief's test was "no login or licence acceptance", and a copyright notice with a permission
requirement is exactly the kind of term that should not be crossed silently. So the data stays out of the repo, the
parser is verified against the live pages (counts above, zero rejected rows), and loading is one operator command away
(`bun run terminology:x12:fetch`, then upload + load). To seed every environment: obtain X12's written permission, then
a migration (ordinal 0550-0559; check `arch:migration-numbering` against `main`) can be generated from the parsed
output; the parser already yields every field needed.

### Loader changes

- `packages/terminology-loader/src/parsers/x12-code-list-html.ts`: strict reader for the saved X12 page; wired into
  the `carc`/`rarc` parsers alongside the normalized CSV (auto-detected).
- SNOMED: `der2_cRefset_Language*Snapshot*` is read; display becomes the US-English (else any English) preferred
  synonym, falling back to the FSN without its tag. Previously a stated limitation.
- RxNorm: only `SCD SBD GPCK BPCK IN MIN PIN BN SCDC SBDC SCDF SBDF` become concepts.
- LOINC: unchanged (the by-name `Loinc.csv` reader already matched the release layout).
- All verified on tiny INVENTED fixtures (`packages/terminology-loader/__tests__/catalog-parsers.test.ts`); the
  RRF/RF2 layouts are still documented-layout readers never run against a real licensed file.
- `scripts/terminology/import-x12-codes.ts` + gitignored `.terminology-downloads/`.

### Not done

- Licensed downloads were not attempted and no attestation was recorded or called, by anyone.
- The changed search route was not exercised on the Docker dev stack with a signed-in user: the session had no
  sanctioned way to obtain dev credentials (reading the local credentials file was refused), and rebuilding the shared
  `api` container from this branch would have replaced a service other sessions use. The live suite above is the proof
  of the route; a quick manual check on the Docker stack is still worthwhile before merging to `main` (auto-deploys).
- `validate`/`lookup` for `sud_test_loinc` codes stay "unknown" until LOINC is loaded (membership is not validity).
