# Regression retest of the 2026-08-07 audits (Administrator unless noted, 1440 px)

| Prior item | Result now | Evidence |
|---|---|---|
| 1 Roles catalog "816 of 8" | **Not reproduced** (PARTIAL) | `/roles` shows "1 / 895" catalog coverage for the selected role; the Administrator role's own count was not read |
| 2 Platform nav dead for org admin | **Not reproduced in web nav** | web sidebar lists no Platform/Tenants/Feature flags; those screens now live in the admin app (28 routes load) |
| 3 No scroll reset | **NOT TESTED** | my probe found no scrollable container; inconclusive |
| 4 Chart sub-nav vanishes on empty states | **Not reproduced at 1440** (tabs present on 13 of 14 URLs; `/privacy` lacks them, F-008b). **New related defect F-034 below 1280 px** | hit-tests |
| 5 Triage queue leaks spec text | **Not reproduced** | no M19/ADR/seam strings on `/triage` text |
| 6 No sign-out control | **Fixed** | header account menu opens with "Sign out" |
| 7 DB role drift | NOT APPLICABLE | environment, not frontend |
| 8 Zero KPIs on a 403 (Clinician) | NOT TESTED this pass | not re-run |
| F-up A platform-ops in wrong app | **Addressed** | admin app serves them |
| F-up B admin has no styled 404 | NOT TESTED | |
| F-up C IDG History completed review | NOT TESTED | |
| F-up D raw UUIDs on billing screens | NOT TESTED | |
| F-up E Cost Reports can't open a report | **BLOCKED** | list has 0 rows in the seed |
| F-up F KPI zero-state style | NOT TESTED | |
| Portal beyond login | **Still BLOCKED** | no seeded portal account |
