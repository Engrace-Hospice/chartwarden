# Remediation backlog (ranked; direction only, no code changed)

| # | Item | Sev | Direction |
|---|---|---|---|
| 1 | F-031 Unlock mints an org-less session, then 401 -> `/expired` and drafts cleared | P1 | Re-run `select-organization` after unlock sign-in, or verify password without a new session; add a live (unmocked) test; separate "no org" from "session dead" in `global-response-signal.ts` |
| 2 | F-034 chart tab strip occluded below ~1280 px | P1 | Give banner and tabs distinct sticky offsets (or make only one sticky); add a layout test at 768/1024 |
| 3 | F-009 / F-022 / F-024 / F-029 / F-030 absence-as-404 and 403-as-empty states | P2 | One shared rule: 403 = "no access" panel, 404 on a by-id read = empty state; stop showing zeros for failures |
| 4 | F-023 clinician sees org-wide documents; F-025 auditor can open entry forms | P2 | Authorization review (clinical/privacy owner); hide or gate the entry points; server already returns 403 |
| 5 | F-032 portal protected page without session | P2 | Redirect to sign-in on 401 |
| 6 | F-033 portal router default error page | P3 | Add `errorElement`/catch-all |
| 3b | F-038 UTC-as-local default on datetime-local fields (referral, aide POC, assessment editor, order editor) | P2 | Use the offset-corrected helper already used in eMAR/HOPE; one shared util + test in a non-UTC TZ |
| 3c | F-039 and F-040 generic or off-screen form errors (key ring 500, triage 409) | P2 | Map server error codes to specific messages; scroll the banner into view or use an inline summary at the submit button; seed a tenant key ring and an on-call shift in the dev seed |
| 3d | F-042 to F-045 admin forms: explain disabled submit, preserve input across step-up, no Try again on 404, key-ring screen explains missing ring | P3 | Inline required markers and messages; keep draft state through /step-up; hide retry for 404 |
| 7 | F-035, F-036, F-037, F-026, F-027, F-028 | P3 | Tab strip overflow cue, dead "Communication" tab, chart h1, form highlighting, raw-ID inputs, "835 Advices" vs unavailable |
| 8 | DESIGN.md colour section stale (D-1) | doc | Update to `#1a56eb` |
| 9 | Test gap: sign-in flows mocked in `screen-lock.dom.test.tsx` | process | Add an end-to-end session test |
| 10 | Optional: rotate the exposed Pencil token | hygiene | user decision |

## GitHub issues (created 2026-10-22, Engrace-Hospice/chartwarden)
#589 F-031 unlock session (P1) | #590 F-034 chart tabs occluded (P1) | #591 absence-as-404 family (P2) | #592 authorization review F-023/F-025 (P2) | #593 portal no redirect F-032 | #594 portal errorElement F-033 | #595 F-038 UTC-as-local (P2) | #596 F-039/F-040/F-045 errors + seed gaps (P2) | #597 admin forms F-042-044 | #598 chart/form polish bundle | #599 DESIGN.md colour | #600 e2e session test gap.
Not filed: item 10 (rotate the exposed Pencil token; user decision, no issue text needed).
