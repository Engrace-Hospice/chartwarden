# Coverage ledger (status words per directive)

| Area | Status | Notes |
|---|---|---|
| Web static routes (178), 4 roles, load state + API status | VERIFIED (load state only) | Admin, Clinician, Org Admin corrected capture; Auditor 178 live, only 60 rows retained in export |
| Web interactions, forms, dialogs | PARTIAL | patient chart tabs, Orders sub-tabs, screen lock, sign-in; most create/edit forms NOT TESTED |
| Form submission | PARTIAL | referral created (F-038); safety incident BLOCKED by 500 (no tenant key ring), triage intake BLOCKED by 409 (no covering shift), admission not submitted (needs a real patient); claims/orders/medications deliberately not submitted |
| Patient chart, 2 patients | PARTIAL | Delgado (12 tabs, visual), Okonkwo (14 URLs, load state, 8 Orders sub-tabs) |
| Dynamic `:param` routes other than chart | NOT TESTED | web ~110, admin 11, portal 12 |
| Admin app | PARTIAL | 28 static + 11 :param routes load-state (4 with real IDs, 7 with fake IDs); forms reach validation or step-up, all writes BLOCKED by step-up (second factor); 768 px checked |
| Portal signed-out | VERIFIED | F-032, F-033 |
| Portal signed-in | BLOCKED | no seeded account; I did not create one |
| Responsive | PARTIAL | 1440, 1280, 1024, 768, 500 on ~10 routes; phone width < 500 NOT TESTED |
| Dark theme | NOT TESTED | tokens read only |
| Accessibility | PARTIAL | DOM heuristics only; keyboard, focus, SR, contrast NOT TESTED |
| Security/privacy | PARTIAL | headers, CSRF, storage, authz probes; no XSS/upload/rate-limit tests |
| Performance | NOT TESTED | dev build |
| Design fidelity | PARTIAL | internal consistency only; no independent mockups (DA-2) |
| Regression of 2026-08-07 | PARTIAL | see 03 |
| Clinical/regulatory interpretation | NOT ASSESSED | escalate F-023, F-009, F-025 to qualified reviewers |
