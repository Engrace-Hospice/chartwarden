-- M8 — therapy visits in the encounter model (CMS Pub. 100-04 ch. 11 §30.3).
--
-- Hospice claims report every visit by hospice therapists as its own 15-minute-unit line: physical therapy (revenue
-- 0421 / G0151), occupational therapy (0431 / G0152), speech-language pathology (0441 / G0153). The encounter model
-- had no therapist discipline, so those lines could never be produced. This adds:
--   encounter_discipline  'pt', 'ot', 'slp'                  (the authoring / signing discipline)
--   encounter_type        'pt_visit', 'ot_visit', 'slp_visit' (discipline-named types, each pinned to its discipline
--                                                              by the §2.2 legal-pair matrix in @chartwarden/types, like
--                                                              chha_visit => chha)
-- Code-side mirrors: packages/db/src/enums.ts, packages/types/src/encounter.ts, the encounters TypeBox vocab, the
-- HearthNote template registry, the M17 visit seed consumer. Therapists need no RN cosignature (COSIGN_REQUIRED stays
-- lpn + chha). Idempotent; the new values are not used by any statement in this file.
ALTER TYPE "public"."encounter_discipline" ADD VALUE IF NOT EXISTS 'pt';--> statement-breakpoint
ALTER TYPE "public"."encounter_discipline" ADD VALUE IF NOT EXISTS 'ot';--> statement-breakpoint
ALTER TYPE "public"."encounter_discipline" ADD VALUE IF NOT EXISTS 'slp';--> statement-breakpoint
ALTER TYPE "public"."encounter_type" ADD VALUE IF NOT EXISTS 'pt_visit';--> statement-breakpoint
ALTER TYPE "public"."encounter_type" ADD VALUE IF NOT EXISTS 'ot_visit';--> statement-breakpoint
ALTER TYPE "public"."encounter_type" ADD VALUE IF NOT EXISTS 'slp_visit';
