# WardenX — Event Catalog, Seam Matrix & Enforcement-Coverage Assessment

Companion to `FITNESS_ENFORCEMENT_AUDIT.md` (manifest-derived: modules, tables, dependency
graph, cycles). This file covers the **spec-prose** layer (events, seams) and assesses **what
is actually enforced** vs. documented.

> **Confidence levels.** Sections 1–4 of the companion audit are *machine-verified* from
> `architecture/module-manifest.ts` (HIGH confidence). The event/seam catalog below is
> *extracted from the 40 module specs* and is a reference map (MEDIUM confidence) — exact
> event names show cross-spec convention drift (see §B) and should be reconciled against the
> authoritative runtime catalog (`outbox_event_catalog`, owned by M01) once code lands.

---

## A. Module Event & Seam Catalog (spec-derived)

Per module: outbox events **published**, events **consumed**, seams **exposed**, seams
**consumed**. (`dependsOn` import edges are in the companion file §1; per ADR-0005, consuming
an event or seam adds **no** import edge.)

| Module | Publishes (events) | Consumes (events) | Seams exposed | Seams consumed |
|---|---|---|---|---|
| M01 Foundation | org/provider_entity/location.created, membership.invited/accepted, feature_flag.updated, system_status.changed | — | SeamRegistry, outbox.publish, audit(), withOrgContext, RLS generator, idempotency | — |
| M02 Identity | m2.invitation.created, m2.magic_link.requested, auth.login_succeeded/failed/account_locked, auth.2fa_*, passkey.*, m2.organization.activated/suspended/closed, m2.session.step_up.* , membership.suspended/revoked, user.deactivated | m29.hl7_inbound_proposal.accepted (indirect) | SessionRepository, OrgRepository, MembershipRepository, AuditorSessionMinter | — (imports M1/M3/M4) |
| M03 Authorization | role.assigned/revoked/updated, m3.breakglass.invoked/ended, m3.engagement.* | — | CaseloadProvider (contract), step_up_recent + deny-stub predicates (OnCallShift, BereavementWindow, Supervision, VolunteerGate, ConsentEvaluator) | the deny-stub predicates above |
| M04 Audit | audit.elevated_access, data.destruction_certified, m4.legal_hold.applied/released, audit.disclosure_report_generated_* , m4.audit.archive_partition | — (write-trigger registration) | DataEraser, HoldApplier registries; consumes PatientLifecycleProvider, SudClassResolver, CertificatePdfRenderer | PatientLifecycleProvider (M5), SudClassResolver (M29), CertificatePdfRenderer (M22) |
| M05 Patient | patient.created/updated/address_changed/status/merged/privacy_flag_changed, patient.amendment_request.accepted/denied | m29.hl7_inbound_proposal.accepted, m39.consent.changed | CaseloadProvider, PatientReader, PatientMutator, OrganizationSettingsReader, PrivacyFlagSnapshot | (DataEraser→M4, consent→M39 stub) |
| M06 Admission/Election/Cert | m6.referral.*, m6.admission.activated/discharged/on_hold, m6.election.signed/period_started/period_ended, m6.cti.signed/late_flagged/voided, m6.discharge.*, m6.compliance.window.*, m6.bereavement.eligible | m29.hl7_inbound_proposal.accepted | AdmissionReader, ElectionPeriodReader, CertificationReader, FaceToFaceReader, LevelOfCareReader, AdmissionStatusReader, AdmissionCensusReader | ConsentEvaluator (M39), MDM readers (M40) |
| M07 Care Plan | m7.care_plan.created/version_signed/review_overdue/discharged, problem/goal/intervention.* | m6.admission.activated, m14.idg.decision_recorded, m9.assessment.recorded | CarePlanReader, careplan.isReviewOverdue(), relevantElementsForEncounter() | LatestAssessmentProvider (M9), ConsentEvaluator (M39) |
| M08 Encounters | m8.encounter.created/finalized/signed/cosigned/addendum_signed, cosignature_routed/overdue/escalated/hard_cap, late_entry/administrative_override, voided, hearthnote.layer2_enhanced, vitals/mileage.captured | m6.admission.activated, m17.visit.scheduled, m18.evv.check*, m9.assessment.*, m10.hope.timepoint_signed | SignedEncountersReader, BillableEncounterReader, EncounterStatisticsProvider, EncounterCreator | CarePlanReader (M7), LatestAssessmentProvider (M9), HOPE seam (M10), narrativeEnhancement (M32), vocab (M38), consent (M39) |
| M09 Assessments | assessment.recorded/amended/significant_change(+ack/escalated), scale.license_pending_renewal/lapsed, scale.policy_changed | m8.encounter.signed, m6.admission.activated | LatestAssessmentProvider, ScaleSeriesProvider, AssessmentComplianceReader | M6 admission reader, M38 value-sets, M39 sud predicate |
| M10 HOPE | hope.timepoint.scheduled/signed/expired, hope.j2051.triggered, hope.sfv.created/completed/overdue/missed, hope.correction.submitted, hope.submission.queued/transmitted/accepted/rejected | m6.admission.activated/discharged, m8.encounter.signed, m9.assessment.recorded | HopeTimepointProvider, HopeSubmissionProvider, HopeJ2051Provider | M6 admission reader, M38 value-set, iqies-client |
| M11 Orders | m11.order.draft_created/signature_requested/verbal_received/cosign_*/signed(+on_behalf)/verbal_signed_in_time/verbal_expired_unsigned/discontinued/completed/corrected, level_of_care_change_signed, recertification_signed, supply_fulfillment/cancellation_requested, hl7_orm_requested, transmission_status_changed/terminal_failed, results_received(+critical)/overdue, idg_drafted, standing_created/spawned/discontinued, suggestion_state_changed | m6.admission.discharged, m9.assessment.significant_change, m10.hope.j2051_trigger_fired, m14.idg.decision_recorded, m21.supply_request.status_changed, m29.lab_* | OrderSignatureProvider, OrderProvider | — (M12 imports M11's seam) |
| M12 DoseSpot | m12.medication_order.signed/list_changed/active/discontinued/transmission_*/ack_received/nack_received/document_requested, m12.refill_request.created/approved/denied | m5.patient.*, m6.admission.*/cti.signed, m11.order_signature (seam), m14.idg.decision_recorded | MedicationOrderProvider, RefillInboxProvider, RxBenefitProvider | OrderSignatureProvider (M11), consent (M39), M40 pharmacy, M38 |
| M13 eMAR | m13.administration_record.recorded/document_requested, scheduled_dose.missed, prn_administration_recorded, caregiver_administration.acknowledged, comfort_kit.replenishment_needed/return_required, reconciliation.document_requested/completed | m12.medication_order.active/discontinued, m6.admission.*, m8.encounter.signed, m9.prn_reassessment_overdue | MedicationAdministrationProvider, ReconciliationProvider | MedicationOrderProvider (M12), SignedEncountersReader (M8), LatestAssessmentProvider (M9), consent (M39) |
| M14 IDG | m14.packet.render_requested, minutes.signed, meeting.cancelled/started/adjourned, packets.ready, decision_recorded (discriminated), idg_decision.applied, notification.composed | m6.*, m7.care_plan.version_signed, m8.encounter.signed, m9.assessment.*, m10.hope.*, m11.order.*, m12.medication_order.*, m22.document.rendered_critical_results | IdgPacketProvider, IdgDecisionProvider, IdgScheduleProvider | CarePlanReader, SignedEncountersReader, LatestAssessmentProvider/ScaleSeriesProvider, HopeTimepointProvider, OrderProvider, MedicationOrderProvider, CaseloadProvider, consent, M40 taxonomy |
| M15 Discipline Plans | m15.plan.bootstrapped/version_signed/discharged, aide_supervisory.completed/overdue, msw/chaplain.assessment_initial_overdue, volunteer.gate_expiring/expired/assignment_inactivated/ratio_recomputed, idg_decision.applied, discipline_assessment.amended | m6.admission.*, m8.encounter.signed, m9.assessment.recorded, m14.idg.decision_recorded, m7.care_plan.version_signed | DisciplinePlanReader, MswRiskFactorReader, VolunteerComplianceProvider, SupervisoryCadenceReader, DisciplineComplianceProvider | CarePlanReader, SignedEncountersReader, LatestAssessmentProvider, consent, M40 |
| M16 Bereavement | bereavement.plan_opened/closed_*/paused/resumed/skipped, counselor_assigned, contact_*, external_source_cosign_received, outreach_artifact_requested | m6.bereavement.eligible, m6.discharge.cosigned, m8.encounter.signed, m39.consent.revoked, m22.document.rendered, m4.legal_hold.*, m14.idg.decision_recorded | BereavementPlanProvider, BereavementOutreachProvider, BereavementRiskFactorsProvider, bereavement_window predicate | PatientReader/CaregiverReader (M5), ScaleSeriesProvider (M9), MswRiskFactorReader (M15), EncounterCreator (M8), ConsentEvaluator (M39) |
| M17 Scheduling | m17.visit.published/assigned/completed/started/cancelled_caregiver_notification/unassigned/no_show_detected, reassignment_needed, route_optimized | m7.care_plan.discharged, m8.encounter.signed, m18.evv.check_in/out_recorded/geofence_breach_recorded, m14.idg.decision_recorded, m11.order_requires_visit | VisitReader, VisitAssignmentReader, PortalVisitReader, VisitMetricsProvider + ABAC predicates | PatientAddressReader (M5), CarePlanReader (M7), VolunteerComplianceProvider/SupervisoryCadenceReader (M15), EvvLocationProvider (M18), BillableEncounterReader (M8) |
| M18 EVV | m18.evv.check_in/out_recorded, at_patient_address, geofence_breach_recorded, late_check_out_detected/resolved, gps_spoof_suspected, device_*, geofence_policy_changed, aggregator_accepted/rejected/timeout/cancelled, verification_pdf_requested, visit_verified, event_corrected | m17.visit.published/cancelled, m5.patient.deceased, m8.encounter.signed | EvvBracketResolver, EvvComplianceReader, EvvAggregatorReferenceReader, EvvLocationProvider, EvvMetricsProvider, EvvVerificationProvider + predicates | PatientAddressReader (M5), VisitReader/VisitAssignmentReader (M17), device_attestation/CredentialReader (M2) |
| M19 On-Call Triage | m19.triage_call.visit_needed/gip_admission_proposed/care_plan_change_indicated/documented | m17.visit.no_show_detected, m18.evv.late_check_out_detected | OnCallProvider, TriageCallReader/Provider/MetricsProvider, PortalTriageReader + predicates | PatientReader/CaregiverReader (M5), VisitAssignmentReader (M17), EncounterCreator (M8), OrderSignatureProvider (M11), RefillInboxProvider (M12), ProtocolSuggestionProvider/HospitalizationRiskProvider (M32), consent (M39) |
| M20 Field Safety | m20.safety.sos_alert_raised/acknowledged, check_in_overdue, high_risk_area_entered, incident_reported, policy_violation_recorded, incident_report_requested, sos_terminus_reached | m17.visit.*, m18.evv.check_in/out_recorded/gps_spoof_suspected, m5.patient.deceased | SafetyDashboardProvider, SafetyContextReader, SafetyIncidentReader, SafetyMetricsProvider, SafetyCheckInProvider, SafetyPolicyProvider, SafetySupervisorProvider + predicates | PatientAddressReader/PatientReader (M5), VisitReader/VisitAssignmentReader (M17), EvvLocationProvider (M18), OnCallProvider (M19), M40 jurisdiction/polygon |
| M21 Supplies/DME | m21.supply_request.status_changed/created_from_external/delivered/cancelled, comfort_kit.dispatched/deployed_at_patient/returned/return_reconciliation, controlled_substance_discrepancy, par.below_threshold, invoice_accrued/reconciled | m11.order.supply_fulfillment/cancellation_requested, m13.comfort_kit.replenishment_needed/return_required/controlled_substance_discrepancy | SupplyFulfillmentProvider, ComfortKitDispatchProvider, SupplyCostProvider | OrderProvider (M11), MedicationAdministrationProvider (M13), MdmEntityProvider (M40) |
| M22 Documents | m22.document.created/versioned/rendered(+critical_results)/render_failed/delivered/legal_hold_*/tombstoned/statement_of_disagreement_published, m22.intake.* (uploaded, docling_complete, page_classified, classification_confirmed, sud_detected, completed, rejected), m22.extraction.* (job_ready_for_review, review_required, discrepancy_detected, review_opened/completed, commit_requested/completed/failed), form_template.published, tenant_overlay.published, signed_url.issued/consumed, phi_bundle.exported, media.disclosure_restricted | ~30 source events from M5/M6/M8/M11/M12/M13/M14/M15/M16/M17/M18/M23/M29/M39/M4 (document render triggers) | (none stated — M22 is a sink + renderer) | PatientReader (M5), MdmEntityProvider (M40), LabObservationReader (M29), OrderProvider (M11), consent (M39) |
| M23 Billing Medicare | m23.claim.* (draft_created…paid/denied/adjusted), m23.noe.* (+window_warning/breached), m23.notr.* (+window_warning/breached), m23.eligibility.*, m23.abn.required, m23.mac_portal.unavailable/recovered | m5.patient.*, m6.election/cti/f2f/loc/revocation/transfer/discharge.*, m8.encounter.signed/cosigned, m18.evv.late_check_resolved, cap.projection_updated, mdm.canonical_updated, m25.remittance.* | ClaimReader, ClaimDayProjectionProvider, ClaimSubmissionReader, ClaimMetricsProvider, EligibilityReader, ProviderEntityClaimChannelReader | CaseloadProvider (M5), AdmissionReader (M6), EncounterProvider (M8), SupplyFulfillmentProvider (M21), CapManagementReader (M26), MDM/Payer (M40) |
| M24 Billing Medicaid | m24.medicaid_claim.* (draft…abandoned), rb_arrangement.* , rb_day.overridden, eligibility.checked/stale_at_assembly/mco_assignment_changed, state_channel.unavailable/recovered | m5.patient.*, m6.election/loc.*, m8.encounter.signed, m18.evv.late_check_resolved, m23.claim.paid, m25.remittance.* (flag-gated) | MedicaidClaimReader, MedicaidClaimDayProjectionProvider, MedicaidClaimSubmissionReader, MedicaidClaimMetricsProvider, MedicaidEligibilityReader, StateRateScheduleReader, RoomAndBoardReader | MedicaidAdapter (per-state), CaseloadProvider (M5), AdmissionReader (M6), EncounterProvider (M8), ClaimReader (M23), MDM (M40) |
| M25 Remittance | m25.edi.835_received, remittance.parsed/advice_posted/claim_paid/partial_paid/denied/adjusted/recouped/manual_match_recorded, denial.opened/aging_threshold_breached/resolved_favorable_via_appeal, patient_responsibility.recorded, appeal_packet/denial_resolution_letter.render_requested, appeal.submitted/decided, taxonomy.unmapped_code_observed | m23.claim.rejected, m18.evv.aggregator_rejected, m22.document.rendered (filtered) | RemittanceReader, DenialReader, DenialMetricsProvider, AppealCaseReader, AppealMetricsProvider, PatientResponsibilityReader, UnmatchedRemittanceProvider | EvvAggregatorReferenceReader (M18), ClaimReader (M23), MedicaidClaimSubmissionReader (M24), TerminologyProvider (M38), Payer (M40) |
| M26 Cap | cap.accrual_recorded/projection_updated/threshold_crossed/year_opened/year_closing/year_closed/settlement_proposed/settlement_finalized/psr_variance_raised | m5.patient.deceased, m6.revocation.created/transfer.created, m25.remittance.advice_posted, m36.notification.delivery_failed | CapProjectionProvider, CapAccrualReader, CapSettlementProvider, InpatientCapProvider, CapWatchSubscriberProvider, CapMetricsProvider | PatientReader, ElectionPeriodReader, MedicareClaimReader/ClaimLineReader (M23), RemittanceReader (M25), Terminology, MDM |
| M27 Cost Report | m27.trial_balance.pulled/pull_failed, validation.overridden/rule_suggestion_created, allocation.recomputed, cost_report.submitted/reopened, artifact.render_requested/store_requested | m23.* (seam), m26.* (seam) | CostReportProvider, CostReportFilingStatusReader, EcrArtifactReader, ValidationResultProvider, XeroClientFactory, GustoClientFactory, CostReportMetricsProvider | ProviderEntityReader, EncounterStatisticsProvider, MedicationOrder/AdministrationProvider (M12/M13), PatientDaysProvider (M23 deny-stub), CapAccrualReader (M26 deny-stub), M38, M22 |
| M28 FHIR Gateway | **none** (all alerts via M36) | m11.order.results_*, m8.encounter.signed/cosigned, m5.patient.deceased/merged, m6.election/revocation/transfer/discharge.*, mdm.physician_deactivated | FhirGatewayMetricsProvider, FhirClientReader, FhirInboundProposalReader + 24 FHIR R4 projections | ~35 reader seams across M5–M40 (read-only projection) |
| M29 External Interfaces | m29.hl7_message.cascade_resolved_*/routing_dropped, hl7_inbound_proposal.created/accepted/rejected/discarded/expired, lab_order.transmitted/transmission_failed, lab_observation.received, document.upload_requested, nppes.provider_synced/deactivated, adt.demographic_update_accepted/admission_event | m11.order.hl7_orm_requested, m5.patient.deceased, m6.discharge.death, m22.document.created | LabObservationReader, Hl7InboundProposalReader, ExternalFeedReader, NppesProviderReader, ExternalInterfaceMetricsProvider | PatientReader, OrderProvider, ConsentEvaluator, TerminologyProvider, MDM readers, Xero/GustoClientFactory (M27) |
| M30 HQRP | m30.measure.recomputed/superseded, cahps.*, qapi.*, cop.status_changed, sra.*, incident.*, mortality_review.*, infection.* | m6.discharge.death/cosigned, m8.encounter.signed, m10.hope.submission_accepted, m11/m12/m13/m14/m17/m18/m23/m25 metric events | QualityMeasureProvider, IncidentRegisterProvider, QapiProjectProvider, ComplianceStatusProvider, SecurityRiskAssessmentReader | ~25 metric/reader seams across modules |
| M31 Portal/Telehealth | m31.portal_invitation.*, portal_account.activated/bereaved_mode_*, portal_access_grant.*, telehealth.room_created/ended/recording.available/vendor_*, portal_document.*, portal_amendment_request.submitted, caregiver_attestation.recorded, portal_session.*, eraser.* | m5.patient.*, m6.admission.discharged, m16.bereavement.*, m17.visit.*, m19.portal_triage_log_entry, m22.intake.*, m36.care_team_channel_created, m39.consent.*, m8.encounter.signed, m4.legal_hold.* | PortalAccountReader, PortalAccessGrantReader, PortalEngagementProvider, TelehealthMetricsProvider, TelehealthVisitReader, PortalSessionMinter, PortalDisclosureAccountingProvider | ~30 reader seams (M5–M40) + MessagingProvider (M36), consent (M39) |
| M32 AI Platform | ai.capability.*, ai.tenant_opt_in.*, ai.clinician_opt_out.recorded, ai.capability_invoked, ai.phi_disclosed, ai.local_inference, ai.output_accepted/edited/rejected/flagged, ai.kill_switch.*, ai.hallucination_report.*, ai.prompt_template.activated, ai.routing_override.set, ai.evaluation.completed, ai.drift.detected | **none stated** | NarrativeEnhancementProvider, DocLens{Classifier,Extractor,VisionVerifier,SudDetector}, ProtocolSuggestionProvider, HospitalizationRiskProvider, BereavementRiskNarrativeProvider, DenialOutcomePredictionProvider, AIPromptRegistry, AICapabilityMetricsProvider, AITokenLedgerProvider | M3 predicate registry, M36 alert registry, M38, M1 outbox |
| M33 Reporting | m33.report_definition.published, report_view.shared_org, report_schedule.created, scheduled_report.render_requested/delivered/failed, mv.refresh_succeeded/failed, lag.exceeded/recovered, drilldown.emitted, export.csv_streamed | ~all m*.* domain events (incremental MV refresh) | MetricsProvider, DashboardCatalogProvider, ScheduledReportProvider | ~40 reader/metrics seams (every module) |
| M34 SaaS Tenant | m34.tenant.provision_started/provisioned/activated/suspended/offboarding_initiated/destroyed, onboarding.step_advanced/task_completed/task_blocked, support_consent_grant.*, support_session.*, dsar_export.*, tenant_export.*, tenant.dek_rotation_completed, baa.executed | m2.organization.activated/suspended/closed, m4.legal_hold.*, m22.document.created | TenantLifecycleProvider, TenantKeyProvider, TenantOnboardingProvider, TenantSupportSessionProvider, TenantSubscriptionEntitlementReader (deny-stub) | OrganizationReader/MembershipReader (M2), AlertEmitter (M36), M22 renderer, M35 OnboardingStatus (deny-stub) |
| M35 Subscription Billing | m35.subscription.*, dunning.*, invoice.*, payment_method.*, usage.*, refund.*, promo.*, stripe.*, tenant.billing_blocked, revenue.monthly_snapshot_computed | m2.organization.*, m2.session.created, m5.patient.created/status_changed/deceased/merged | SubscriptionStateProvider, BillingStatusProvider, UsageMeteringIngest, PatientCounterProvider, RevenueMetricsProvider, PlanCatalogReader | OrganizationReader/MembershipReader (M2), AlertEmitter (M36), M28/M29/M32/M34 meters (deny-stub) |
| M36 Messaging | m36.notification.delivery_failed, alert.dispatched/channel_failure/payload_validation_refused/tenant_override_applied | m2.session.step_up_lockout, m5.patient/care_team/discharge events, m6.level_of_care.requires_ipu_bed, m16.bereavement_plan.*, m19.on_call.shift_changed, m37.ipu_admission.* (14 payloads), m39.consent.*, m40.nppes.* | MessagingProvider, AlertEmitter, RecipientResolver registry | CareTeamProvider (M5), OnCallProvider (M19), M2 membership, M3 predicates |
| M37 IPU | m37.ipu_admission.* (opened…discharged), census.snapshot_taken, shift.coverage_gap_projected/rn_uncovered, gip_criteria.reassessment_due, irc_episode.cap_approaching/breached, equipment.inspection_overdue, body_release.*, bed.cleaning_overdue, visitor_restriction.applied, restraint.applied/reassessment_due, iv_safety_overlay.required, dispense_cabinet.discrepancy_detected | m6.level_of_care.requires_ipu_bed/activated, m6.discharge.death, m8.encounter.signed, m11.order.signed, m22.document.rendered, m30.incident_report | IpuAdmissionReader, IpuCensusProvider, IpuBedAssignmentProvider, IpuShiftCoverageReader, IpuIvSafetyOverlayProvider, IpuVisitorReader, Ipu{Acuity,Mortality,Falls,Infection,Restraint}Provider, IpuTenantPostureReader | ~20 reader seams (M5–M40) |
| M38 Terminology | m38.code_version.loaded, terminology.version_loaded/deprecations_detected/tenant_deprecation_scan | **none** (read-only service) | TerminologyProvider, FHIR shape exports | **none** |
| M39 Consent | m39.consent.created/signed/supersedes/revoked/expired/expiring_soon/renewal_cycle_opened/renewed/recipient_added/removed/dpoa.*/delegated_access.*/repointed | m5.patient.merged, m22.document.rendered | ConsentEvaluator, BereavementOutreachConsentProvider, DelegatedAccessReader, RecipientDirectoryReader, ConsentStateAdvisoryProvider (deny-stub); 11 ABAC predicates → M3 | ExternalPhysician/Facility/Pharmacy readers (M40), Terminology (M38), DocumentRenderer (M22), AlertEmitter (M36) |
| M40 MDM | m40.nppes.provider_synced.applied, mdm.physician_deactivated/duplicate_suspected/merge_executed/provisional_promoted/canonical_updated/baa_expiring/baa_status_changed/license_expiring | m29.nppes.provider_synced/deactivated, m29.nppes_sync_run.completed | MdmEntityProvider, BaaStatusProvider | **none** (canonical lookup service) |

---

## B. Event Catalog — cross-checks & drift

- **Subscriber→publisher pairing (topic level):** every consumed event family maps to a
  declared publisher (e.g. `m6.admission.activated` → consumed by M07/M08/M10/M12/M13/M14/M15;
  `m8.encounter.signed` → consumed by 12+ modules; `m39.consent.*` → M05/M16/M22/M28/M31). No
  consumed event family lacks a producer **at the topic level**.
- **Authoritative convention (verified against source).** Outbox event names use
  **`mN.<resource>.<verb>[_from_<source>]`**; the `outbox_event_catalog` (M01 Foundation spec
  **D8**) stores `event_name` + `module_owner` (`mN`) + `consumers[]`, and
  `outbox.publish(eventName, payload)` **refuses** any event whose `mN.` prefix the caller
  doesn't own (or that isn't a registered unprefixed system event). Ratified by M03 D9
  ("modules own their `mN.` namespace") and M04's action-catalog convention; M04 notes
  adoption "across M5/M6/M11/M29/M40 v0.3". This corrects the earlier MEDIUM-confidence "drift
  vs. ADR-0005" framing — the rule is real and lives in M01 D8.
- **⚠ Finding — v0.2→v0.3 adoption gap (real).** Ground-truth grep of the specs confirms the
  **v0.3/v0.4 modules conform** (`m6.*`, `m11.*`, `m29.*`, `m40.*` + the v0.4 set), while
  several **v0.2 modules still use bare domain prefixes for events**: M07 (`care_plan.*`),
  M09 (`assessment.*`), M26 (`cap.*`), M32 (`ai.*`); M02/M03 are mixed. It is *load-bearing*,
  not cosmetic: the conforming M23 (v0.3) consumes `cap.projection_updated` **by its bare
  name**, so renaming `cap.*`→`m26.*` is a cross-module refactor touching consumers too.
  (Caveat: the per-module event lists in §A are LLM-extracted; some bare tokens there are
  actually **permission keys / ABAC predicates**, which use feature prefixes by design —
  `care_plan.author`, `messaging.send` — *not* the event convention.)
- **Reconciliation stance.** Renaming is deferred to each v0.2 module's **next version bump**
  (deliberate, with its consumers), not a blind global rename. The convention is now
  **statically armed**: `scripts/check-fitness-gaps.ts` (event-catalog sub-check) enforces
  `mN.` ownership + valid consumers the moment the `events-by-mN.ts` / outbox registry lands,
  and M01's boot validation refuses violations at runtime.

---

## C. Enforcement-Coverage Assessment (the "PARTIAL" question)

What is **actually enforced by automated checks today** vs. documented-only. Checks:
`.dependency-cruiser.cjs` (boundaries), `check-table-ownership.ts`, `check-tenancy.ts`,
`check-ddl-legality.ts`, `check-ui-screens.ts`, all under `bun run arch:fitness`.

| Enforcement target | Status | Mechanism | Gap |
|---|---|---|---|
| **Module boundaries** (imports) | ✅ Enforced (static) | dependency-cruiser rules generated from manifest `dependsOn` + leaf/foundation allow-list | Inert until app source exists under `apps/`/`packages/`; depcruise also not installed in this corpus-only repo |
| **Table ownership** | ✅ Enforced (static) | `check-table-ownership.ts` blocks cross-module schema access / raw SQL / helper-table evasion against manifest `ownedTables` | Inert until source lands; heuristic (import-level) |
| **Dependency rules / no cycles** | ✅ Enforced + ✅ verified now | dependency-cruiser `no-circular`; **this audit confirms the manifest graph is acyclic (0 cycles, 157 edges)** | Same inert-until-source caveat for the import-level rule |
| **RLS requirements** | ✅ Armed (was partial) | `check-tenancy.ts` (shapes/3-column) **+ `check-fitness-gaps.ts` phi-guards** (every org-scoped table must declare an RLS policy/enable) | Armed-inert until schema code lands |
| **Seam restrictions** | ✅ Armed (was runtime-only) | `check-fitness-gaps.ts` seam-registry (every consumed seam ∈ REQUIRED_SEAMS / registered) + runtime `validateSeams()` | Armed-inert until seam source lands |
| **Audit requirements** | ✅ Armed (was runtime-only) | `check-fitness-gaps.ts` phi-guards (every org-scoped table must carry an audit trigger) + runtime M04 triggers | Armed-inert until schema code lands; route-level `audit()` presence still runtime |
| **Event catalog consistency** | ✅ Armed (was runtime-only) | `check-fitness-gaps.ts` event-catalog (`mN.` ownership + valid consumers) + runtime M01 boot catalog | Armed-inert until the outbox registry lands; publisher↔subscriber payload-typing still runtime |

**Net (updated):** all **6 named targets now have a static fitness check wired** into
`arch:fitness` — boundaries, table ownership, and dependency rules were already enforced;
**RLS, seams, audit-trigger presence, and event-catalog convention are now armed** via
`scripts/check-fitness-gaps.ts` (`arch:gaps`). Like the pre-existing checks, the new ones are
**armed-but-inert until implementation code lands** under `apps/`/`packages/` (they report
`inert … armed` and pass); they begin enforcing automatically per-file as source appears.
Negative-tested: the event/RLS/audit/consumer assertions all fire on planted violations.
This converts the audit's "PARTIAL / runtime-only" gaps into wired static gates — the
remaining work is running them against the implementation repo in CI as code lands.

---

## D. Findings & Recommendations

1. **Table count: 451, not 447.** The manifest owns exactly **451** tables across 40 modules,
   all uniquely owned (no table owned twice), every module has a spec file + codePaths. The
   "447" in the brief is stale.
2. **Dependency graph is a clean DAG** — 157 edges, **0 cycles**, every `dependsOn` resolves
   to a real module. Topological order computed (see companion §3). No hidden *import*
   dependencies are possible by construction once depcruise runs (consumption via event/seam
   is intentional and edge-free per ADR-0005).
3. **Event-name convention — authoritative rule confirmed** (§B): `mN.<resource>.<verb>`
   (M01 D8). v0.3/v0.4 modules conform; v0.2 modules (M07/M09/M26/M32, M02/M03 mixed) carry
   bare-prefix events. **DONE:** the convention is now statically armed (`arch:gaps`
   event-catalog sub-check). **Remaining (deferred to each v0.2 module's version bump):**
   rename bare-prefix events to `mN.` together with their consumers (e.g. `cap.*`→`m26.*`
   plus M23's consumer ref).
4. **Static checks for the formerly-unenforced targets — DONE.** `scripts/check-fitness-gaps.ts`
   adds: (a) seam-registry completeness, (b) audit-trigger presence on org-scoped tables,
   (c) RLS-policy presence on org-scoped tables, (d) event `mN.` ownership + valid consumers.
   Wired into `arch:fitness` as `arch:gaps`; negative-tested; armed-inert until code lands.
5. **All static enforcement remains inert until app source exists** (no `apps/`/`packages/`;
   depcruise not installed). The rules are correct, wired, and ready; they must run in CI
   against the implementation repo as code lands — the unstarted validation the brief calls
   out. Route-level `audit()` presence and event payload-type pairing stay runtime-validated
   (M04 / M01 boot) and are candidates for additional static checks once route code exists.
