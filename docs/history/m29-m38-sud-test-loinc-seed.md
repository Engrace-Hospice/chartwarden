# M29 / M38 — the `sud_test_loinc` value set (GAP-086 blocker)

## What was wrong

M29's inbound lab path (`apps/backend/src/modules/29-external-interfaces/inbound/inbound-seam-ports.ts`
`classifyLoinc`, consumed by `lab-sud-redaction.ts` `decideLabSudRedaction`) marks an inbound result
SUD-class (42 CFR Part 2, spec §11 D15) only when its OBX-3 LOINC is a member of the M38 value set
`sud_test_loinc` — the platform members plus the calling tenant's own `value_set_tenant_extension` rows.
Nothing ever created that value set: not a migration, not a seed script. `PLATFORM_VALUE_SETS` /
`PLATFORM_VALUE_SET_MEMBERS` in `packages/terminology/src/seed/` are pure TypeScript data that no runner
inserts, and the only other DB writes to `value_set` are tests. So `isMemberOf('sud_test_loinc', …)` was
false for every code and **no SUD lab result was ever redacted at ingest**. The unit tests passed because
they fake `classifyLoinc` (`code === "3426-4" ? ["sud_test"] : []`); the existing live suite
(`gap-086-m29-listener.live.test.ts`) does the same.

A tenant could in principle list its own drug-screen LOINCs as extensions, but `addTenantExtension` refuses a
value set that does not exist (FK), so even that door was shut.

## What changed

- `packages/db/migrations/0500_terminology_sud_test_loinc_value_set.sql` — DML only. Inserts the platform
  `value_set` row (scope `platform`) and one `value_set_member` per code (system `loinc`,
  `member_effective` 1970-01-01, `annotations` = `{source, display = LOINC long common name,
  loincDeprecated}`). `ON CONFLICT DO NOTHING` on both inserts, so it is idempotent. M38 platform tables
  are non-tenant reference data (`wardenx_app` SELECT only; writes via the migration owner / the
  `terminology_loader` door), so no RLS policy change was needed; the M38 write-audit triggers still record
  each row.
- `packages/terminology/src/seed/sud-test-loinc.ts` — the generated, verified member list (source of truth),
  wired into `PLATFORM_VALUE_SETS` and `PLATFORM_VALUE_SET_MEMBERS` so the in-memory seed/provider path and the
  database agree. `packages/terminology/__tests__/sud-test-loinc.test.ts` asserts content, no duplicates, and
  migration-0500 parity (code-for-code, name-for-name).
- `apps/backend/__tests__/gap-086-sud-test-loinc-seed.live.test.ts`
  (`bun run test:m29:sud-loinc-seed:live`, CI row "M29 SUD test-LOINC seed (GAP-086)") — as the NOBYPASSRLS
  `wardenx_app` role: seed present and idempotent; app role reads but cannot write the platform members; the
  REAL `buildM29InboundSeamPorts().terminology.classifyLoinc` over the REAL `createDbTerminologyStore` provider
  flags seeded codes (every one), leaves glucose/hemoglobin/creatinine alone, classifies as of the
  observation date; `decideLabSudRedaction` redacts a SUD result without consent (the M39 evaluator is the only
  stub); a tenant extension added through the real `addTenantExtension` makes a code SUD for that tenant only
  (org B and an org-less call do not see it; RLS hides the row from org B).

## How the codes were chosen and verified

No code was typed from memory. Every code and long common name was read from the LOINC table as served by the
NLM Clinical Table Search Service (`https://clinicaltables.nlm.nih.gov/api/loinc_items/v3/search`), fetched
2026-10-07 (repopulate by re-running the same queries; a spot-check re-lookup of every panel/"drugs identified"
code and a random sample of the analyte codes matched exactly). LOINC.org itself requires a login for search,
so the NLM redistribution was the authoritative public source used. Selection:

1. Analyte rule — a LOINC whose component is a substance-use analyte, in urine (incl. 24 h), serum/plasma,
   blood, saliva/oral fluid, hair, breath, body fluid or unspecified specimen, at any property/method
   (presence, mass/volume, moles/volume, "cutoff", creatinine ratio, screen vs confirmatory). Families:
   amphetamines (incl. methamphetamine, MDMA/MDA/MDEA), barbiturates, benzodiazepines (class, parent drugs,
   metabolites, designer analogs), cannabinoids (THC, carboxy-THC, synthetic cannabinoids), cocaine /
   benzoylecgonine / cocaethylene / ecgonine methyl ester, opiates and opioids (morphine, codeine, 6-MAM,
   heroin, hydrocodone, hydromorphone, oxycodone, oxymorphone and metabolites, methadone / EDDP,
   buprenorphine / norbuprenorphine, fentanyl and analogs), phencyclidine, and alcohol (ethanol, ethyl
   glucuronide, ethyl sulfate, phosphatidylethanol).
2. Panel rule — drugs-of-abuse / drug-screen / class panels and "drugs identified/tested for" tests, plus
   the class `Narcotics [Identifier]` tests.
3. Retired codes (LOINC long name starting `Deprecated `) are kept and annotated `loincDeprecated: true`: a lab
   can still send one, and an unrecognised SUD result must be redacted, not shown.

The specs (M29 §11 D15 / T-29.07 §5 and T-29.11, M38 §3.9, M39) give examples ("urine drug screen panel codes,
opioid metabolite tests, etc.") but no list, and no rule beyond "M38 returns the category". The set was made
conservative (redact on any doubt) because the failure being closed is silent non-redaction.

## Deliberately not included (and why)

- **Cotinine / nicotine / trans-3-hydroxycotinine** — tobacco; no spec classes it as SUD.
- Tramadol, meperidine, tapentadol, carisoprodol / meprobamate, ketamine, propoxyphene, methaqualone, LSD,
  GHB, xylazine, kratom — outside the requested list; arguably SUD-adjacent. Clinical call.
- Phenobarbital / mephobarbital — anticonvulsant therapeutic-drug monitoring, not an SUD test; redacting
  them would hide routine clinical results.
- Generic volatiles / toxicology panels (`Volatiles panel`, `Toxicology panel - Blood`,
  `Volatiles and gases`) — not SUD-specific.
- Questionnaires / assessment items (AUDIT, DAST, TAPS, CMS opioid items) — not laboratory results.
- Neonatal and post-mortem matrices (meconium, cord tissue, milk, gastric, vitreous, stool, tissue, bile).

## Known trade-off — REQUIRES clinical and compliance review

The set is intentionally broad. It includes tests a hospice also orders for pain management (serum / urine
morphine, hydromorphone, oxycodone, fentanyl, methadone, lorazepam / midazolam levels). Under D15 a result in
this set is persisted redacted unless the patient has SUD-disclosure consent, so a routine opioid or
benzodiazepine level can be hidden from clinicians who lack that consent. A clinical owner and the compliance
officer must review the list (and may narrow it by matrix — e.g. drop serum/plasma therapeutic-drug levels —
or add tenant extensions) **before it is relied upon**. Re-running the selection after a LOINC release is a
curation change: update `sud-test-loinc.ts`, add a new DML migration for the delta, and let the
`classifyLoinc` re-classification sweep (T-29.11 §6) re-evaluate persisted observations — migration 0500 does
not retro-redact labs already ingested.

## Follow-ups not done here

- Observations ingested before this migration were never classified; the T-29.11 class-drift sweep is the
  intended retro path and was not run or changed here.
- The `index.ts` boot does not insert `PLATFORM_VALUE_SETS` for the other (still unseeded) sets; this change
  fixes `sud_test_loinc` only.
