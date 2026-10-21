# P11 — Core & Clinical Cleanup (the 7 deferred screens)

These 7 screens exist in the [screen index](../CHARTWARDEN_UI_COMPLETE_SCREEN_INDEX.md) but were
never authored into a P0–P5 prompt block, so they were never generated. Each one's layout
pattern is already proven by a sibling screen — they are not new patterns, just the index
entries that the original phase prompts skipped. This phase closes the corpus to 97/97.

> Prepend the [Lantern preamble](./README.md#the-lantern-preamble-prepend-to-every-generation-prompt)
> to every block. Reuse the chrome already built for the matching pattern (Stepper from P10
> Recert, Work Queue + Review from P10 Note Lifecycle, Admin Settings from P4, Work Queue from
> any console screen). Record each node id back into [`../SCREENS.md`](../SCREENS.md).

File: `chartwarden-P11-core-clinical-cleanup.pen`

---

### 11.1 Help & Training Center — M01 (cross-cutting) · `Work Queue`
[spec](../screens/core/CHARTWARDEN_UI_HELP_TRAINING.md)
```
Work Queue (category sidebar | article list | article reader). Searchable help; role-based how-
tos (clinician/biller/admin/scheduler); clinical-workflow help (documentation, eMAR, IDG, HOPE);
release notes; FAQs; guided tours; route-to-support. Optional assigned-training tracker with
completion chips. SYSTEMS: content is role-aware (show "for your role" filter); no PHI here.
```

### 11.2 User Profile & Preferences — M02·M36·M17 · `Admin Settings Layout`
[spec](../screens/core/CHARTWARDEN_UI_USER_PROFILE_PREFERENCES.md)
```
Admin Settings (settings sidebar | content | right help/impact notes). Self-only — no admin
override. Categories: Profile (display name, discipline, signature setup, language) · Security
(password with live policy meter; MFA enroll TOTP — QR + secret + backup codes, SMS fallback) ·
Notifications (per-channel toggles) · Availability (scheduler hours) · Sessions & devices
(active sessions, revoke). SYSTEMS: security-sensitive actions confirm; sessions show last-seen.
```

### 11.3 Admissions / Referral Intake — M06 · `Stepper Workflow + Review Workspace`
[spec](../screens/clinical/CHARTWARDEN_UI_ADMISSIONS_REFERRAL_INTAKE.md)
```
Stepper + Review (top nav · referral header · left admission steps · center referral/intake form ·
right documents/eligibility/risk · sticky footer). Steps: referral received → demographics/payer →
document review → eligibility check → clinical summary → admit prep. SYSTEMS: eligibility result
chips (Medicare A / MBI verify); referral-source attribution; risk flags; DocLens-ingested docs
shown as AI-extracted (provenance). VARIANTS: new referral · in review · eligible · not eligible.
```

### 11.4 Election & Certification — M06 · `Patient Workspace + Stepper Workflow`
[spec](../screens/clinical/CHARTWARDEN_UI_ELECTION_CERTIFICATION.md)
```
Patient Workspace + Stepper (patient banner · election/cert header · benefit-period timeline ·
certification detail · right compliance/deadlines/signatures). Hospice election statement,
benefit periods (1st/2nd/3rd+), cert vs recert, F2F requirement, physician attestations. SYSTEMS:
election-statement signature ceremony; missing-F2F/attestation = Guardrail blocker (reuse P10
Recert pattern); timely-filing & cert-window deadline chips; benefit-period timeline.
```

### 11.5 Eligibility Worksheet / CTI — M06·M09·M38 · `Patient Workspace + Documentation Workspace`
[spec](../screens/clinical/CHARTWARDEN_UI_ELIGIBILITY_WORKSHEET_CTI.md)
```
Patient Workspace + Documentation (patient banner · CTI header w/ benefit period + deadlines ·
left diagnosis/decline-evidence/narrative/F2F/signatures · center worksheet · right deadlines/
decline-trend/prior-periods). Build the Certification of Terminal Illness: terminal dx validation,
LCD-style decline evidence supporting ≤6-month prognosis, AI-drafted prognosis narrative
(provenance + citations to assessments/HOPE), physician signature + F2F. SYSTEMS: prognosis
narrative AI-suggested halo; decline-evidence value-sets (M38); CTI signature ceremony; deadline chips.
```

### 11.6 Document Management — M22 · `Work Queue + Review Workspace`
[spec](../screens/clinical/CHARTWARDEN_UI_DOCUMENT_MANAGEMENT.md)
```
Work Queue + Review (document header · KPI strip · document queue · right detail/preview/actions).
Upload, classify, store, review, patient-link, DocLens-process, sign, retain. KPIs: pending
classification, unsigned, retention due, DocLens queue. SYSTEMS: SUD/Part-2 documents render as
sealed (consent gate, break-glass); retention & legal-hold chips; signature ceremony for signable
docs; AI-classified type shown with provenance. VARIANTS: queued · classified · signed · sealed · on legal hold.
```

### 11.7 DocLens Extraction Review — M22·M32 · `Work Queue + Review Workspace`
[spec](../screens/clinical/CHARTWARDEN_UI_DOCLENS_EXTRACTION_REVIEW.md)
```
Work Queue + Review (page header · KPI strip · extraction queue | source image w/ bounding boxes |
fields + confidence). Human-in-the-loop boundary: classify document, check each AI-extracted field
against the source image, triage low-confidence + high-risk fields, commit accepted values as
DRAFTS to owning modules. KPIs: ready for review, low-confidence, high-risk, committed today.
SYSTEMS: every field carries a confidence score + AI-extracted provenance; high-risk fields require
RN review (Guardrail); accept/edit/reject per field; source-image bounding-box highlight on select.
```
