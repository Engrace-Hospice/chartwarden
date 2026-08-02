-- M13L write lifecycle — the Drizzle eMAR write path (record/correct/void/refuse administration, caregiver-
-- attested capture + acknowledge/dispute, intentional-hold, missed-dose acknowledge, reconciliation
-- decision/finalize/void, comfort-kit return, policy put). The `administration_record` table was shaped for a
-- COMMITTED dose whose three-column tenancy (provider_entity_id + location_id) is denormalized from the M6
-- admission at commit-time; the §4.1 write routes carry only the clinical intent (a bedside record has the
-- medication order + mode + administered_at). Relax the NOT-NULLs those thin routes do not capture, mirroring
-- M6 0123 / M7 0127 / M8 0128 / M9 0129 / M10 0130 / M11 0131 / M12 0132:
--
--   * administration_record provider_entity_id + location_id were NOT NULL (denormalized siting for location-
--     scoped ABAC + survey-grade reconstruction). recordAdministration sources them from the scheduled_dose
--     when a scheduledDoseId is supplied (that row carries the siting); an ad-hoc / PRN record that names no
--     scheduled dose has no siting to copy until the M6 admission / M17 visit context is threaded, so the
--     column must be nullable. `administration_record` is PARTITION BY RANGE(administered_at) — the ALTER on
--     the partitioned parent propagates to every monthly leaf (the M12 0132 medication_order precedent).
ALTER TABLE "administration_record" ALTER COLUMN "provider_entity_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "administration_record" ALTER COLUMN "location_id" DROP NOT NULL;
