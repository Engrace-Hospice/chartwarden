-- compat: expand
-- M34 onboarding wizard v2 (slice 1a). Owner decisions: the ops wizard order is organisation -> plan & contract -> BAA ->
-- provisioning -> provider entity & NPI -> locations -> billing (clearinghouse, MAC credentials, payer enrollment) ->
-- e-prescribing -> people (first admin, compliance officer) -> sample data (optional) -> go-live.
--
-- Template catalog (platform-shared, org-less): three new columns.
--   completion_mode  'auto'        the advance sweep settles the step from its fact (precondition_dsl); a human cannot
--                    'attestation' a human settles it with evidence; the sweep never does
--                    'either'      the sweep settles it when its fact holds, otherwise a human may attest
--   is_optional      an optional step never locks a later one and is not part of the activation guard
--   retired_at       a retired template is excluded from guards, listings, the sweep and new tenants' tasks; its
--                    existing onboarding_task rows stay as history (xero_connected / payroll_connected / org_seeded)
-- `canonical_order` is the step's sequence and `required_role` its owner (platform_ops | org_admin | compliance_officer |
-- either); `either` = the tenant's org_admin or platform ops.
--
-- onboarding_task: the human attestation that settled the step (evidence_note required, evidence_ref optional) and who
-- gave it. The M4 write-audit trigger already records the full before/after image, so an attestation is audited by the
-- row write itself.
--
-- Tenants already in `onboarding` get a pending task for every new template, so their wizard is complete.
-- The CHECKs are written inline on the new columns (a column that is added with its own rule is `expand`; a bare ADD
-- CONSTRAINT on a live table is enforced against the previous release's writes too).
ALTER TABLE "onboarding_task_template"
  ADD COLUMN "completion_mode" text NOT NULL DEFAULT 'auto'
    CONSTRAINT "onboarding_task_template_completion_mode_ck" CHECK ("completion_mode" IN ('auto', 'attestation', 'either')),
  ADD COLUMN "is_optional" boolean NOT NULL DEFAULT false,
  ADD COLUMN "retired_at" timestamp with time zone;--> statement-breakpoint

-- The attestation columns travel together, and evidence is only ever recorded with an attester: the cross-column rule rides
-- on the last column added.
ALTER TABLE "onboarding_task"
  ADD COLUMN "evidence_note" text
    CONSTRAINT "onboarding_task_evidence_note_ck" CHECK ("evidence_note" IS NULL OR length(btrim("evidence_note")) BETWEEN 1 AND 2000),
  ADD COLUMN "evidence_ref" text
    CONSTRAINT "onboarding_task_evidence_ref_ck" CHECK ("evidence_ref" IS NULL OR length("evidence_ref") <= 500),
  ADD COLUMN "attested_by_membership_id" uuid,
  ADD COLUMN "attested_by_actor_kind" text
    CONSTRAINT "onboarding_task_attested_actor_kind_ck" CHECK ("attested_by_actor_kind" IS NULL OR "attested_by_actor_kind" IN ('platform_ops', 'tenant')),
  ADD COLUMN "attested_at" timestamp with time zone
    CONSTRAINT "onboarding_task_attestation_ck" CHECK (
      ("attested_at" IS NULL) = ("attested_by_membership_id" IS NULL)
      AND ("attested_by_membership_id" IS NULL) = ("attested_by_actor_kind" IS NULL)
      AND ("evidence_note" IS NULL OR NOT ("attested_by_membership_id" IS NULL))
    );--> statement-breakpoint

-- Retire the steps the ops wizard drops. Their sequence moves clear of the live range; history is kept.
UPDATE "onboarding_task_template"
   SET "retired_at" = now(),
       "canonical_order" = CASE "key" WHEN 'org_seeded' THEN 900 WHEN 'xero_connected' THEN 901 ELSE 902 END
 WHERE "key" IN ('org_seeded', 'xero_connected', 'payroll_connected')
   AND "retired_at" IS NULL;--> statement-breakpoint

-- The steps that stay, in their new wizard position.
-- ROLLBACK TRIPWIRE: the go-live row carries `context.goLiveApproved == true`, a field no release produces. If deploy.sh
-- restores the previous release over this `expand` migration, its sweep reads a NULL precondition as met and would take
-- the tenant live with no attestation or approval; with this expression its evaluator throws on the unknown field instead
-- (that tenant's pass fails loud and retries). This release never evaluates it: go-live is `attestation` mode and the
-- machine config drops every attestation step's DSL (steps.ts GO_LIVE_ROLLBACK_GUARD_DSL; a test pins the two together).
UPDATE "onboarding_task_template" AS t
   SET "display_label" = v.label,
       "description" = v.descr,
       "canonical_order" = v.seq,
       "required_role" = v.owner,
       "precondition_dsl" = v.dsl,
       "default_due_days_after_provisioning" = v.due,
       "completion_mode" = v.mode,
       "is_optional" = v.optional
  FROM (VALUES
    ('account_created', 'Organisation', 'Legal name, display name and time zone confirmed with the customer', 1, 'platform_ops', NULL, 0, 'attestation', false),
    ('ccn_registered', 'Provider entity & NPI verification', 'Provider entity registered with its CCN and its NPI verified against the registry', 5, 'either', NULL, 7, 'attestation', false),
    ('locations_seeded', 'Locations', 'All expected locations created with at least one primary', 6, 'org_admin', 'context.primaryLocationExists == true', 10, 'either', false),
    ('mac_configured', 'Billing: MAC credentials', 'Medicare MAC submitter credentials recorded', 8, 'either', 'context.macFeedConfigured == true', 14, 'either', false),
    ('dosespot_kickoff_initiated', 'e-Prescribing (DoseSpot)', 'DoseSpot clinic registration started', 10, 'either', 'context.dosespotKickoffRecorded == true', 21, 'either', false),
    ('first_admin_invited', 'People: first admin', 'At least one org_admin membership exists and has accepted', 11, 'platform_ops', 'context.orgAdminAcceptedMembershipCount > 0', 1, 'auto', false),
    ('sample_data_loaded', 'Sample data (optional)', 'Optional starter data for staff training', 13, 'platform_ops', NULL, 45, 'attestation', true),
    ('go_live_checklist_complete', 'Go-live', 'The compliance officer attests readiness and a platform operator approves; the tenant then goes active', 14, 'compliance_officer', 'context.goLiveApproved == true', 60, 'attestation', false)
  ) AS v(key, label, descr, seq, owner, dsl, due, mode, optional)
 WHERE t."key" = v.key;--> statement-breakpoint

-- The steps the ops wizard adds. Plan, clearinghouse, payer enrollment and e-prescribing get real producers in later
-- slices; until then a human attests them so the wizard works end to end.
INSERT INTO "onboarding_task_template"
  ("key", "display_label", "description", "canonical_order", "required_role", "precondition_dsl",
   "default_due_days_after_provisioning", "is_canonical", "completion_mode", "is_optional")
VALUES
  ('plan_contract', 'Plan & contract', 'Subscription plan and signed order form confirmed', 2, 'platform_ops', NULL, 0, true, 'attestation', false),
  ('baa_executed', 'BAA', 'Platform business associate agreement executed', 3, 'platform_ops', 'context.baaExecuted == true', 3, true, 'auto', false),
  ('provisioning_complete', 'Provisioning', 'Tenant organisation, encryption key ring and first-admin invitation provisioned', 4, 'platform_ops', NULL, 1, true, 'auto', false),
  ('clearinghouse_selected', 'Billing: clearinghouse', 'Clearinghouse chosen: Stedi, Claim.MD, or billing outside ChartWarden', 7, 'either', NULL, 14, true, 'attestation', false),
  ('payer_enrollment', 'Billing: payer enrollment', 'Payer enrollment submitted or confirmed', 9, 'either', NULL, 21, true, 'attestation', false),
  ('compliance_officer_assigned', 'People: compliance officer', 'A compliance officer is assigned to attest go-live readiness', 12, 'either', 'context.complianceOfficerAssigned == true', 14, true, 'either', false)
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint

-- Tenants mid-onboarding get a pending task for every active template they lack.
INSERT INTO "onboarding_task" ("organization_id", "tenant_account_id", "template_key", "status", "due_at")
SELECT a."organization_id", a."id", t."key", 'pending', now() + (t."default_due_days_after_provisioning" * interval '1 day')
  FROM "tenant_account" a
  CROSS JOIN "onboarding_task_template" t
 WHERE a."status" = 'onboarding'
   AND t."retired_at" IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM "onboarding_task" k WHERE k."tenant_account_id" = a."id" AND k."template_key" = t."key"
   );
