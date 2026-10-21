-- GAP-036 follow-up — M12: backfill medication_order.is_sud_treatment for rows that pre-date the writer.
--
-- Until batch 7 NOTHING wrote medication_order.is_sud_treatment (it stayed at its DEFAULT false), so every
-- reader (M13 portal/FHIR, M19 triage context, M22 medication-list render, M28 FHIR gate) saw false for every
-- SUD-treatment order. The draft create / edit / request-signature writers now derive it from the SUD-treatment
-- drug list in `@chartwarden/dosespot` (classes/sud-treatment-drugs.ts, the single source of truth). This migration
-- brings EXISTING rows into line.
--
-- The list below is the TS list rendered as a Postgres regex; `m12-sud-treatment-drug-list.test.ts` asserts the
-- two are identical, so a drift in either direction fails CI. `\m` / `\M` are Postgres word-start / word-end,
-- the analogue of the TS `\b`; `~*` is case-insensitive. Generic names only (see the TS file).
--
-- FORWARD-ONLY and IDEMPOTENT: it only ever flips false -> true (never clears a flag, never touches a row that
-- is already true), so a re-run changes nothing. No row is deleted; status / version / updated_at are NOT
-- touched (a flag correction is not an order edit and must not invalidate an in-flight optimistic-lock version).
--
-- AUDIT: medication_order and administration_record carry the M4 write-audit trigger. The trigger tolerates
-- the absent app.user_id of a migration session (actor_user_id is nullable; precedent 0328), so each flipped
-- row writes a normal `<table>.update` audit_event with a NULL actor. The migration tags the audit
-- correlation_id so those rows are attributable to this backfill rather than reading as an anonymous 'system'
-- write. The flag is a boolean, not free text: no audit denylist change (arch:audit-denylist-sync unaffected).
-- Both tables are RLS + FORCE; like 0328 this runs as the migration owner, which is not subject to the app.org_id
-- policy, so the backfill spans all tenants by design.
--
-- administration_record (M13) carries a snapshot copy of the flag (it is what the M28 FHIR gate and the M31
-- portal redaction read for a MedicationAdministration). M13 never wrote it either, so it is backfilled here
-- from the (now correct) parent order — keyed on the order id, NOT the drug-name snapshot (legacy
-- caregiver-attested rows carry an empty snapshot). medication_order is partitioned with PK (id, created_at);
-- id is a gen_random_uuid(), unique in practice.
SELECT set_config('app.correlation_id', 'migration-0340-m12-sud-backfill', true);--> statement-breakpoint
UPDATE "medication_order"
   SET is_sud_treatment = true
 WHERE is_sud_treatment = false
   AND drug_name ~* '\m(methadone|buprenorphine|naltrexone|disulfiram|acamprosate|lofexidine|varenicline)\M';--> statement-breakpoint
UPDATE "administration_record" ar
   SET is_sud_treatment = true
  FROM "medication_order" mo
 WHERE ar.is_sud_treatment = false
   AND mo.id = ar.medication_order_id
   AND mo.organization_id = ar.organization_id
   AND mo.is_sud_treatment = true;
