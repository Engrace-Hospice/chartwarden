# P6–P10 — Missing-domain expansion

> Prepend the [Lantern preamble](./README.md#the-lantern-preamble-prepend-to-every-generation-prompt).
> These 28 screens close the gap vs. a comprehensive hospice EHR. Same recipe as P1–P5: open the
> phase `.pen`, install Lantern variables + components, then `batch_design` per screen, verify with
> `get_screenshot`, record the node id in [`../SCREENS.md`](../SCREENS.md). Field detail lives in
> each linked spec.

Suggested phase files: `wardenx-P6-compliance.pen` · `wardenx-P7-controls-staffing.pen` ·
`wardenx-P8-external-portals.pen` · `wardenx-P9-mobile-integration.pen` ·
`wardenx-P10-cert-billing-ops.pen`.

---

## P6 — Compliance, Privacy & Quality

### 6.1 HIPAA Privacy & Disclosure — M04·M39 · `Work Queue`
[spec](../screens/compliance/WARDENX_UI_HIPAA_PRIVACY_DISCLOSURE.md)
```
Work Queue. KPI (open access requests, amendment requests due, disclosures logged, overdue). Tabs:
Disclosure accounting (§164.528) · Access requests (30-day countdown chips) · Amendment requests
(60-day). Right detail = request lifecycle + deadline. SYSTEMS: deadline countdowns (warning→error),
PHI masked, every disclosure row carries actor + purpose + provenance chip.
```

### 6.2 Breach & Security Incidents — M04 · `Work Queue`
[spec](../screens/compliance/WARDENX_UI_BREACH_SECURITY_INCIDENTS.md)
```
Work Queue. Incident queue (type, severity ALERT-coded, status). Right = breach 4-factor risk
assessment + 60-day notification countdown + containment/eradication/recovery timeline. SYSTEMS:
ALERT for reportable breach; deadline chip; audit trail.
```

### 6.3 Business Associate Agreements — M40·M34 · `Work Queue`
[spec](../screens/compliance/WARDENX_UI_BAA_MANAGER.md)
```
Work Queue. Vendor BAA register (vendor, status, review date countdown, subcontractors). Right =
BAA detail + the as-of BAA-status gate that vendor integrations depend on. SYSTEMS: review-due
countdowns; status badge taxonomy.
```

### 6.4 Patient Rights & Grievances — M30 · `Work Queue`
[spec](../screens/compliance/WARDENX_UI_PATIENT_RIGHTS_GRIEVANCES.md)
```
Work Queue. Three streams: rights-acknowledgment tracker (8+ notices/admission), grievances (5-day
ack / 30-day resolution countdowns), abuse/neglect mandatory reports (state agency, investigation).
SYSTEMS: dual deadline chips; ALERT on abuse report; compassionate tone.
```

### 6.5 QAPI Program & Incidents — M30 · `Dashboard`
[spec](../screens/compliance/WARDENX_UI_QAPI_INCIDENTS.md)
```
Dashboard. QAPI KPIs + incident trend; incident report form + investigation (root-cause, corrective
action, status). Right = open PIPs / risk. SYSTEMS: severity ALERT; status lifecycle.
```

### 6.6 Quality Measures & Chart Audit — M30 · `Dashboard`
[spec](../screens/compliance/WARDENX_UI_QUALITY_MEASURES_CHART_AUDIT.md)
```
Dashboard. Quality-measure cards (num/denom/rate, meets-target), chart-audit findings table (CoP
ref, severity, corrective action), CAHPS tracking. tabular-nums; Meets/Below badges; trend bars.
```

### 6.7 Accreditation & Survey Readiness — M30 · `Work Queue`
[spec](../screens/compliance/WARDENX_UI_ACCREDITATION_SURVEY.md)
```
Work Queue. Standards tracker (CHAP/ACHC/TJC compliance), survey findings + plan-of-correction with
deadlines. Right = deficiency detail + POC status. SYSTEMS: deadline chips; status taxonomy.
```

### 6.8 OIG Exclusion & Compliance Program — M30·M34 · `Work Queue`
[spec](../screens/compliance/WARDENX_UI_OIG_COMPLIANCE_PROGRAM.md)
```
Work Queue. Monthly OIG exclusion screening (staff/vendor/volunteer, match review), 7-elements
program status, state-regulatory-rules config. SYSTEMS: ALERT on potential match; review workflow.
```

---

## P7 — Prescribing Controls, Staffing & Patient Billing

### 7.1 EPCS & Controlled Substances — M12 · `Work Queue`
[spec](../screens/clinical/WARDENX_UI_EPCS_CONTROLLED_SUBSTANCES.md)
```
Work Queue. EPCS identity proofing (IAL2, expiration), 2FA prompt (hard-token/biometric), prescriber
privileges (DEA #, schedules, EPCS status), PDMP query log, controlled-substance audit (Sched II–IV),
PBM status. SYSTEMS: Signature Ceremony + step-up (EPCS hard-token); ALERT controlled-substance
treatment; mono identifiers (DEA #).
```

### 7.2 Staff Credentials & Compliance — M02·M34 · `Work Queue`
[spec](../screens/staffing/WARDENX_UI_STAFF_CREDENTIALS_COMPLIANCE.md)
```
Work Queue. Credentials (license, expiration), immunizations, training/competency (HIPAA/OSHA, CE/CME,
aide 12h in-service), 14-day aide supervision. SYSTEMS: expiration countdown chips (warning→error);
OIG-clear badge; document upload.
```

### 7.3 Staff Scheduling & Caseload — M02·M17·M34 · `Work Queue`
[spec](../screens/staffing/WARDENX_UI_STAFF_SCHEDULING_CASELOAD.md)
```
Work Queue. Availability (day-of-week, max visits/day, geo prefs), PTO requests + approval, caseload
assignment (max vs current load, zones). SYSTEMS: PTO approval flow; over-caseload warning.
```

### 7.4 Timesheets & Payroll — M34 · `Work Queue`
[spec](../screens/staffing/WARDENX_UI_TIMESHEETS_PAYROLL.md)
```
Work Queue. Timesheet entry (visit/travel/on-call/admin/PTO hours), payroll export (ADP/Paychex/Gusto
+ approval), daily staffing summary (hours by discipline, volunteer %, CHC). tabular-nums; approval gate.
```

### 7.5 Patient Statements & Financial Assistance — M23·M24 · `Work Queue`
[spec](../screens/revenue/WARDENX_UI_PATIENT_STATEMENTS_ASSISTANCE.md)
```
Work Queue. Patient statements (coinsurance/deductible/non-covered), payment recording, financial
assistance (charity/hardship/payment plans/sliding scale). tabular-nums for money; compassionate tone.
```

---

## P8 — External & Coordination Portals

> Portal family: scoped least-privilege, PHI minimized, every view audited, access-level enforced
> server-side; persistent safety/contact affordance; plain language; AA→AAA.

### 8.1 External Physician Portal — M29·M31 · `Portal Dashboard`
[spec](../screens/portal/WARDENX_UI_EXTERNAL_PHYSICIAN_PORTAL.md)
```
Portal Dashboard. Assigned patients · pending order signing (EPCS) · cert/recert signing (prognosis
narrative) · patient summary · messaging. Signature ceremonies; scoped to assigned patients only.
```

### 8.2 Consulting Physician Portal — M31 · `Portal Dashboard`
[spec](../screens/portal/WARDENX_UI_CONSULTING_PHYSICIAN_PORTAL.md)
```
Portal Dashboard. Read-mostly patient summary, consult notes, limited messaging. Narrower scope.
```

### 8.3 Referral Source Portal — M29 · `Portal Dashboard`
[spec](../screens/portal/WARDENX_UI_REFERRAL_SOURCE_PORTAL.md)
```
Portal Dashboard. Submit referral (demographics/dx/insurance/clinical summary/packet upload) + track
status (received → intake_review → eligible/rejected). Stepper-style submission inside the portal.
```

### 8.4 Facility Nurse Portal — M31 · `Portal Dashboard`
[spec](../screens/portal/WARDENX_UI_FACILITY_NURSE_PORTAL.md)
```
Portal Dashboard. Patients at this facility (LOC orders, status) + limited observation documentation
per access_level.
```

### 8.5 DME Vendor Portal — M31 · `Portal Dashboard`
[spec](../screens/portal/WARDENX_UI_DME_VENDOR_PORTAL.md)
```
Portal Dashboard. Pending DME orders (delivery/pickup status updates) + equipment tracking. Minimal PHI.
```

### 8.6 Surveyor Access Portal — M30 · `Work Queue`
[spec](../screens/portal/WARDENX_UI_SURVEYOR_ACCESS_PORTAL.md)
```
Work Queue (read-only). Time-boxed survey access: sampled charts/documents, every open audited, auto-
revoking session banner, no edit. SYSTEMS: persistent "read-only survey session · all views audited".
```

---

## P9 — Mobile, Integration & Ops

### 9.1 Mobile Field Suite — M17·M18·M22 · `Dashboard + Mobile Task Flow`
[spec](../screens/mobile/WARDENX_UI_MOBILE_FIELD_SUITE.md)
```
Phone frame set (separate React Native/Expo renderer, ADR-0072), one action per screen: patient list+day schedule ·
offline visit doc (queued) · EVV check-in/out (geofence advisory) · tasks · messages · offline-queue/
sync indicator · mobile telehealth. 44px targets; offline badges; same PHI masking/consent as desktop.
```

### 9.2 HL7 & Interface Logs — M29 · `Work Queue`
[spec](../screens/integration/WARDENX_UI_HL7_INTERFACE_LOGS.md)
```
Work Queue. HL7 ADT/ORU/MDM log (match confidence), NCPDP SCRIPT log, clearinghouse acks (999/TA1/
277CA), control numbers (mono), errors + retry. SYSTEMS: error/ALERT; retry controls.
```

### 9.3 Submission & Resubmission — M10·M29 · `Work Queue`
[spec](../screens/integration/WARDENX_UI_SUBMISSION_RESUBMISSION.md)
```
Work Queue. QIES/ASAP HOPE status, HOPE resubmission (corrected data + audit), OCR ingestion status,
external system health. SYSTEMS: rejection→resubmit flow; endpoint health badges.
```

### 9.4 Workflow & Event Operations — M01 · `Status Board`
[spec](../screens/platform/WARDENX_UI_WORKFLOW_EVENT_OPS.md)
```
Status Board. Workflow transition log (invariants checked, idempotency), outbox monitor (pending/
published/failed + retry), job-queue (BullMQ) depth, cache (Valkey) status. Internal-operator surface.
```

---

## P10 — Certification, Billing-Ops, Note Lifecycle, Facility & Role Dashboards

### 10.1 Certification & Recert Lifecycle — M06 · `Stepper Workflow`
[spec](../screens/clinical/WARDENX_UI_CERTIFICATION_RECERT_LIFECYCLE.md)
```
Stepper. Recert dashboard (benefit periods, due windows) → recert wizard (assessment → narrative) →
LOC segment manager (RHC/CHC/IRC/GIP, justification, revenue codes) → benefit-period manager → F2F
workspace → physician CTI. Recert invariant alert (missing F2F/prognosis/HOPE = Guardrail blocker).
```

### 10.2 Clinical Note Lifecycle — M08 · `Work Queue + Review Workspace`
[spec](../screens/clinical/WARDENX_UI_CLINICAL_NOTE_LIFECYCLE.md)
```
Work Queue + Review Workspace. Version history · side-by-side compare · amendment workspace · late-
entry (tiered) · missed-visit · unsigned-notes dashboard · forensic audit trail. SYSTEMS: late-entry
tier banners; amendment ceremony; SUD redaction in previews.
```

### 10.3 NOE/NOTR & Claim Ops — M23 · `Work Queue`
[spec](../screens/revenue/WARDENX_UI_NOE_NOTR_CLAIM_OPS.md)
```
Work Queue. NOE manager (5-day timely-filing countdown), NOTR manager, claim scrubber results (rule-by-
rule), clearinghouse config, EDI transaction log (837/835/999/277CA control numbers), rate-schedule
config (FY rates, wage index, CBSA, SIA). tabular-nums; timely-filing deadline chips.
```

### 10.4 Facility & Supply Operations — M21·M37 · `Admin Hierarchy Layout`
[spec](../screens/clinical/WARDENX_UI_FACILITY_SUPPLY_OPERATIONS.md)
```
Admin Hierarchy. Facility master (GIP/IRC, contract status, beds) → contract manager (R&B rates) → bed
inventory → supply inventory (par/reorder) → supply transaction ledger. Tree | detail | validation.
```

### 10.5 Role Dashboards — M33 · `Dashboard`
[spec](../screens/core/WARDENX_UI_ROLE_DASHBOARDS.md)
```
Dashboard. One template, a variant per role: Medical Director · Billing Manager · Bereavement
Coordinator · Scheduler/Dispatcher · QA Officer · Compliance Officer · Intake Coordinator — each with
its KPI strip + "needs you now" queue. Generate one frame per role.
```
