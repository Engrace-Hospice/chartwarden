-- M34 SaaS Tenant Platform §3.12 — Seed (platform-owned onboarding task templates).
-- The eleven canonical onboarding steps (the platform-shared, read-only reference floor every
-- tenant observes — onboarding_task_template carries NO organization_id by design; ADR-0010 /
-- SD-036 pattern-2). Each row mirrors the §2.3 onboarding state machine: step key, canonical
-- order, display label, the typed precondition_dsl evaluated against OnboardingContext at
-- advance-attempt time, the role accountable for the step, and the default due-days SLA.
--
-- This INSERT runs in the migration (platform-ops) context. ON CONFLICT (key) DO NOTHING keeps the
-- migration idempotent across re-runs; the eleven keys form the primary-key floor and are
-- never updated here (a step's label/precondition change is a deliberate later migration).
INSERT INTO "onboarding_task_template"
	("key", "display_label", "description", "canonical_order", "required_role", "precondition_dsl", "default_due_days_after_provisioning", "is_canonical")
VALUES
	('account_created', 'Account created', 'Tenant account and first organization seeded', 1, 'platform_ops', NULL, 0, true),
	('org_seeded', 'Organization seeded', 'M2 organization, first provider_entity, first location exist', 2, 'platform_ops', 'context.providerEntityCount > 0 AND context.locationCount > 0', 1, true),
	('ccn_registered', 'CCN registered', 'CCN populated on at least one provider_entity', 3, 'org_admin', 'context.providerEntities[*].ccn != null', 7, true),
	('mac_configured', 'MAC configured', 'Medicare MAC submitter credentials recorded', 4, 'compliance_officer', 'context.macFeedConfigured == true', 14, true),
	('dosespot_kickoff_initiated', 'DoseSpot kickoff initiated', 'DoseSpot clinic registration row inserted', 5, 'compliance_officer', 'context.dosespotKickoffRecorded == true', 21, true),
	('xero_connected', 'Xero connected', 'Xero OAuth handshake recorded', 6, 'org_admin', 'context.xeroConnected == true', 28, true),
	('payroll_connected', 'Payroll connected', 'Gusto OAuth handshake recorded', 7, 'org_admin', 'context.gustoConnected == true', 28, true),
	('locations_seeded', 'Locations seeded', 'All expected locations created with at least one primary', 8, 'org_admin', 'context.primaryLocationExists == true', 30, true),
	('first_admin_invited', 'First admin invited', 'At least one org_admin membership exists and has accepted', 9, 'platform_ops', 'context.orgAdminAcceptedMembershipCount > 0', 1, true),
	('sample_data_loaded', 'Sample data loaded (optional)', 'Optional starter data for staff training', 10, 'platform_ops', NULL, 45, true),
	('go_live_checklist_complete', 'Go-live checklist complete', 'Compliance officer attestation signed; all required tasks done', 11, 'compliance_officer', 'context.allCanonicalTasksDoneOrSkipped == true AND context.baaExecuted == true', 60, true)
ON CONFLICT ("key") DO NOTHING;
