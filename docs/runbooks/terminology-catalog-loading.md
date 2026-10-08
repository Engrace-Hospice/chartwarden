# Runbook — loading the M38 terminology catalogs

Audience: a **platform operator** (holds `terminology.admin.load`, passes step-up, satisfies the
`terminology_admin_platform_ops` ABAC predicate). Everything below goes through the supported door; there is no
direct database path (`wardenx_app` cannot write a canonical table, and the loader writes only through the
`terminology_loader_*` SECURITY DEFINER functions, migration 0364).

Why this exists: search pickers (`CodeSearchInput`) call `GET /api/v1/terminology/{system}/search`, which can only
return what is in `concept_<system>`. On a fresh environment only ICD-10-CM is loaded; the rest need an operator.
Decision record: [`docs/history/m38-catalog-loading-and-search.md`](../history/m38-catalog-loading-and-search.md).

## How data gets in (the only path)

1. **Obtain the release file** under the licence in the per-system section below.
2. **Attest the licence** (licensed systems only): `POST /api/v1/admin/terminology/{system}/license-attestation`
   with `{licensee, licenseReference, effectiveFrom, effectiveTo?, attributionText}`. Step-up required. The
   attesting person must be someone entitled to accept that licence for the platform operator (legal/compliance
   owner of the licence). The route records `attested_by` from the session. **Nobody — and no automation or agent —
   attests on another person's behalf**, and the `attributionText` must be the text the licence demands (it is served
   with every read as `X-Terminology-Attribution` and in FHIR `CodeSystem.copyright`). Public systems (CARC, RARC)
   need no attestation (attesting one returns 409 `LICENSE_NOT_REQUIRED`).
3. **Upload**: `POST /api/v1/admin/terminology/uploads` `{system, fileName, sha256}` returns `sourceFileRef`,
   `checksum` and a presigned PUT (15 min). `PUT` the file bytes to it with the returned headers.
   `sha256sum <file>` gives the checksum; the storage layer rejects bytes that differ.
4. **Load**: `POST /api/v1/admin/terminology/{system}/load`
   `{version, sourceFileRef, checksum, releasedOn?, effectiveFrom?, activate?}` (step-up). Answers
   `{versionId, status:"loading", ingestion:"enqueued"}`; the worker (`terminology.load_version`) fetches, verifies the
   sha256, parses, stages in 2,000-row chunks, then activates atomically (prior version becomes `superseded`, never
   deleted). `activate:false` stages only. A repeat of the same `(system, version)` answers 409 and re-drives a stuck
   `loading`/`staged` version. A bad file moves the version to `failed` with **no staging or concept rows left**.
5. **Verify** (below). `GET /api/v1/admin/terminology/versions?system=…` shows the ledger.

Requirements: the API/worker must be running with object storage (`MINIO_*`) and Valkey configured, otherwise the
routes answer 503 (`OBJECT_STORAGE_UNAVAILABLE` / `LOADER_UNAVAILABLE`) before registering anything.

Memory note: a source file is read into the worker's memory (zip members inflate up to 1.5 GB, hard cap) and parsed
into one array before being staged in 2,000-row chunks. The full SNOMED CT US Edition and RxNorm RRF set are the
heavy cases; run them with the worker given several GB of heap and not alongside other loads.

## Per system

### CARC and RARC (public — X12 code lists)

- **Licence**: none to hold for *reading* the public pages; **X12 asserts copyright** over the lists and requires
  permission to reproduce them (`ip@x12.org`). For that reason no list content is committed to this repository (see
  the decision record); each environment loads its own copy through the steps above. If your organisation wants the
  lists seeded in every environment from a migration, obtain X12's written permission first.
- **Download**: public web pages (no file download exists)
  `https://x12.org/codes/claim-adjustment-reason-codes` and `https://x12.org/codes/remittance-advice-remark-codes`.
  `bun run terminology:x12:fetch` saves both pages into the gitignored `.terminology-downloads/x12/`, parses them with
  the worker's parser and prints sha256, the list's own "updated" date and counts. (Browser "Save Page As… HTML only"
  works equally.)
- **Format accepted**: the saved page (`.html`, raw or zipped) or the normalized CSV
  `code,display[,status][,effective_date][,end_date]`.
- **Version label**: use the list's updated date, e.g. `2026-07-01`.
- **Upload + load**: steps 3–4 with `system` = `carc` / `rarc`, the `.html` file.
- **Expected rows** (fetched 2026-10-08): CARC list dated 11/1/2025 = **407** (297 active, 110 retired); RARC list dated
  7/1/2026 = **1216** (1137 active, 79 retired). Row counts change with each X12 maintenance cycle.
- **Mapping**: `current`/`to be deactivated` -> `active` (a scheduled Stop date becomes `end_date`); `deactivated` ->
  `retired` with `end_date` = Stop. `Last Modified`, `Notes`, and the RARC `Alert:` marker go to `properties`.

### LOINC (free licence + attribution)

- **Licence to hold**: the LOINC licence from Regenstrief Institute (accepted with a free loinc.org account). It
  requires the copyright notice/attribution Regenstrief specifies; use their current wording as `attributionText`.
- **Who attests**: the platform operator's licence owner (the person whose loinc.org account accepted the terms).
- **Download**: `https://loinc.org/downloads/` (login required) — "LOINC Table File (CSV)": `Loinc_<ver>.zip`, which
  contains `LoincTable/Loinc.csv`. Upload the zip (or the raw `Loinc.csv`).
- **Version label**: the LOINC version, e.g. `2.78`. `effectiveFrom` = the release date.
- **Parsed**: columns by name (`LOINC_NUM, COMPONENT, PROPERTY, TIME_ASPCT, SYSTEM, SCALE_TYP, METHOD_TYP, CLASS,
  STATUS, SHORTNAME, LONG_COMMON_NAME`); display = long common name. `ACTIVE`/`TRIAL` -> active, `DISCOURAGED` ->
  deprecated, `DEPRECATED` -> retired.
- **Expected rows**: one concept per row of `Loinc.csv` (deprecated codes included). Compare with the row count of the
  file (`wc -l` minus header, mind quoted newlines — or count with the load summary) and the release notes.
- **`sud_test_loinc` note**: migration 0500 seeds that value set's LOINC codes into `value_set_member` with the long
  common name in `annotations.display`; it does **not** populate `concept_loinc`. Before LOINC is loaded, `validate` /
  `lookup` for those codes answer "unknown", but the value-set membership M29 redaction relies on is unaffected, and
  `search?inValueSet=sud_test_loinc` finds them by `annotations.display`. After a LOINC load the concept rows take over.
  `validate` is deliberately **not** widened to treat value-set members as valid LOINC codes (membership is not
  validity).

### SNOMED CT US Edition (national/affiliate licence)

- **Licence to hold**: a SNOMED International affiliate licence for the United States — in practice via a UMLS
  account/licence with the SNOMED CT agreement accepted. Attribution text per SNOMED International's requirements.
- **Who attests**: the platform operator's licence owner holding that UMLS/SNOMED agreement.
- **Download**: NLM "SNOMED CT US Edition" (`https://www.nlm.nih.gov/healthit/snomedct/us_edition.html`; UMLS login
  required): `SnomedCT_ManagedServiceUS_PRODUCTION_US1000124_<date>T120000Z.zip`.
- **Files read** (Snapshot only): `sct2_Concept_Snapshot*`, `sct2_Description_Snapshot*` (required);
  `sct2_Relationship_Snapshot*` (hierarchy path from `Is a`; warned when absent); `der2_cRefset_Language*Snapshot*`
  (preferred synonym; US English refset `900000000000509007` preferred, else any English refset; warned when absent).
  Display = preferred synonym, falling back to the FSN without its "(semantic tag)"; the FSN and tag are kept in
  `properties`. Inactive concepts are not loaded.
- **Version label**: the release date, e.g. `2026-09-01`.
- **Expected rows**: the number of **active** rows in `sct2_Concept_Snapshot` — check
  `awk -F'\t' 'NR>1 && $3==1' <file> | wc -l` against `select count(*) from concept_snomed`.

### RxNorm (UMLS licence for the full release)

- **Licence to hold**: UMLS Metathesaurus licence (RxNorm is NLM's; the full monthly release is UMLS-licensed). Check
  the NLM RxNorm files page for whether a prescribable-content subset is available without one — the platform gate
  requires an attestation for `rxnorm` regardless.
- **Who attests**: the platform operator's licence owner holding the UMLS licence.
- **Download**: `https://www.nlm.nih.gov/research/umls/rxnorm/docs/rxnormfiles.html` (UMLS login) — "RxNorm Full
  Monthly Release" zip with an `rrf/` folder.
- **Files read**: `RXNCONSO.RRF` (required), `RXNSAT.RRF` (NDCs), `RXNREL.RRF` (ingredient links).
- **Loaded**: only `SAB=RXNORM`, `SUPPRESS=N` atoms whose term type is one of `SCD SBD GPCK BPCK IN MIN PIN BN SCDC
  SBDC SCDF SBDF`; one concept per RXCUI labelled by its best type. Dose forms, dose-form groups, entry terms,
  prescribable names and synonyms are not concepts of their own.
- **Version label**: the release date, e.g. `2026-10-05`.
- **Expected rows**: the count of distinct RXCUIs having an unsuppressed RXNORM atom of a loaded TTY:
  `awk -F'|' '$12=="RXNORM" && $17=="N" && $13 ~ /^(SCD|SBD|GPCK|BPCK|IN|MIN|PIN|BN|SCDC|SBDC|SCDF|SBDF)$/ {print $1}' RXNCONSO.RRF | sort -u | wc -l`.

## Verify a load

```sql
-- as a DBA, read only
select code_system_id, version, status, effective_from from code_system_version order by loaded_at desc limit 10;
select count(*) from concept_carc;      -- likewise concept_rarc / concept_loinc / concept_snomed / concept_rxnorm
select * from terminology_update_log order by at desc limit 10;
```

Then through the route (any user with `terminology.read`):
`GET /api/v1/terminology/carc/search?q=deductible`, `GET /api/v1/terminology/rarc/M4`,
`GET /api/v1/terminology/loinc/search?q=glucose&billableOnly=true`.
`billableOnly` means *usable on a claim*: ICD-10-CM active + billable leaf; every other system active status.
`inValueSet=<id>` restricts to a value set's members (platform members covering `asOf`, plus the caller's own tenant
extensions); an unknown id is 404.

## Rollback

There is deliberately **no unload**: canonical rows are never deleted (spec §7.2) and a superseded version is kept.

- A load that fails (bad checksum, unparsable file, refused licence, not-newer version) leaves nothing behind.
- `activate:false` stages without exposing anything; abandon a staged version by registering a corrected one.
- A bad release that already activated is corrected by loading a corrected release as a newer version (it supersedes).
  Removing an activated version needs a DBA under change control with a data-destruction record.
- Revoke a licence with `POST …/license-attestations/{id}/revoke`: blocks further loads and drops the attribution
  header; it does not remove data already loaded.
- Prod is demo data (see team notes): a wrong prod catalog is fixed by reseeding, not by remediation scripts.
