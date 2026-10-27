# 14 — Test-suite quality

The repository has unusually broad unit, architecture, and live-database coverage. Non-live Vitest
passed 27,236 tests and targeted live authentication/admission/HOPE/billing/remittance suites passed.
Tests use real catalog validation and app-role RLS in important areas.

Weaknesses: critical browser coverage is sparse (`CW-QA-0008`), Docling pytest is outside CI
(`CW-QA-0010`), one HOPE live suite is order-dependent (`CW-QA-0015`), one M17 table lacks live
evidence (`CW-QA-0016`), and Medicare E2E comments/coverage are stale (`CW-QA-0018`). Passing counts
do not erase 6,822 skipped cases; many are intentionally live suites.

## Critical workflow matrix

| Workflow | Unit | Integration | E2E | Security | Failure Path | Status |
|---|---|---|---|---|---|---|
| Identity/MFA/auditor activation | Yes | Targeted live | Partial | Targeted | Yes | Partial-pass |
| Tenant isolation/RLS | Yes | 109 live | No | Yes | Yes | Database pass; UI blocked |
| Referral/election/admission | Yes | Targeted live | Partial | Partial | Yes | Partial-pass |
| Care plan/IDG/recertification | Yes | Not run here | Sparse | Partial | Partial | Unverified end-to-end |
| Visit/note/sign/addendum | Yes | Not run here | Sparse | Partial | Partial | Browser/concurrency blocked |
| HOPE admission/HUV/SFV/discharge | Yes | Targeted live | Sparse | ABAC unit/live | Yes | Fail CW-QA-0006 |
| Medicare claim assembly | Yes | 69 live subset | Empty-state only | Permission tests | Yes | Fail CW-QA-0001 |
| NOE/NOTR/DDE | Yes | DDE targeted | Sparse | Partial | Partial | External acceptance blocked |
| Medicaid claim lifecycle | Yes | Repository suites | One seeded path | Partial | One filter path | State breadth unverified |
| 835/remittance/payment/denial | Yes | 83 targeted | Sparse | Payer guards | Yes | Partner exchange blocked |
| Commercial billing | Yes | Targeted remittance | Sparse | Partial | Partial | Vendor/payer breadth blocked |
| Documents/OCR/storage | TS + Python exists | Not run fully | Sparse | Scan controls | Partial | Pytest absent CI |
| Messaging/alerts | Yes | Not run here | Sparse | Partial | Partial | Vendor/load blocked |
| Backup/restore | Harness | Demo M36 | No | RLS subset | Limited | Fail CW-QA-0013 |
| Deployment/rollback | Shell checks | No fault drill | No | Image verification | Warning only | Fail CW-QA-0017 |
