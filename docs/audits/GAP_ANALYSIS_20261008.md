# WardenX Gap Analysis — 20261008

Generated: 2026-10-08T12:00:00Z · Repository: WardenX (`/Users/fabrice/Apps/x2/wardenx4`, branch `main`) · Brief: `docs/audits/GAP_ANALYSIS_AUDIT_PROMPT.md` · Prior audit: `docs/audits/GAP_ANALYSIS_20261004.md` (removed; see git history)

This report merges the output of **14 first-pass workers** (module batches plus the fitness-kit, seams, ui-parity, security, docs and discovered-gap workers). No worker failed. A verification pass followed the first pass:

- **P0:** none were raised this run.
- **P1:** an independent verifier re-read each finding and searched for counter-evidence. Every P1 below carries `Verified=true`.
- **P2/P3:** a sample was verified; the rest are marked `Verified=false`.

Where a verifier corrected a finding, the corrected gap, evidence and severity replace the original.

**Authority hierarchy:** architecture documents are authoritative. Module and UI screen specs are implementation proposals. Where a module or screen spec conflicts with architecture, architecture wins.

> **Scope exclusion (owner decision):** the CI/deploy `verify` gate is disabled on purpose. It is out of scope here, and any finding about it has been excluded.

## 1. Executive summary

| Severity        | Count         |
| --------------- | ------------- |
| P0              | 0             |
| P1              | 70            |
| P2              | 136           |
| P3              | 47            |
| **Total** | **253** |

### Top 5 risks (could break prod or block certification)

1. **Clinical-safety controls that do not run in production.** The eMAR write path never runs the five-rights check, and BCMA scans are evaluated against an empty order/patient context (GAP-020). The PRN minimum-interval gate is dead code (GAP-021) and nothing writes `prn_administration` (GAP-022). M12 standard sign persists no signature record (GAP-018), and the verbal-order 48h clock starts at a client-supplied `receivedAt` (GAP-017). The M29-to-M11 lab-result handshake is unbuilt, so every returned lab ends up falsely flagged overdue (GAP-016).
2. **Authentication trust is not enforced or audited.** The MFA matrix is not enforced server-side (GAP-003, GAP-005). No login, lockout, logout, reset, 2FA or passkey event reaches `audit_event` (GAP-002, GAP-004). The `bypassMatchReview` flag on `POST /patients` skips the duplicate-match pipeline with only `patient.create` (GAP-009). A suspended portal account keeps full PHI access (GAP-050).
3. **A freshly provisioned tenant cannot work.** No production path creates tenant `role` rows or default role-to-permission grants, so a first admin invitation attaches nothing (GAP-006). `membership_role.scope` is write-only (GAP-007). Legal-hold supremacy is incomplete for `dateRange`- and `resourceKinds`-only holds (GAP-008).
4. **PHI read-audit trail missing.** M23 eligibility reads (GAP-034), M29 lab and proposal reads (GAP-044, GAP-045), M32 invocation reads (GAP-055) and M36 message history (GAP-064) leave no audit event, because the config has no `resourceIdParam` or sits outside the governed prefixes. Patient-rights data is also exposed: M31 disclosure accounting always returns an empty list (GAP-052).
5. **Vendor transports and revenue pipelines unbound.** Stripe webhook and every M35 worker are unbuilt (GAP-058, GAP-059). All M36 push/SMS/voice/email deliveries settle failed (GAP-062), so SOS voice escalation cannot happen. The EVV aggregator path cannot succeed (GAP-028), the telehealth vendor adapter is unbound (GAP-051), and cron alert codes from M23/M25/M26/M27 have no alert rule, so the NOE/NOTR window-breach alert reaches zero recipients (GAP-035).

**Overall health:** the structural fitness kit is fully green (build clean, all 40 `arch:fitness` gates, 15,031 non-live tests passing, `bun audit` clean, 40 of 40 modules Implemented), and there are no P0s, but 70 verified P1s remain in clinical safety, identity assurance, tenant bootstrap, PHI audit coverage and unbound vendor transports that those gates cannot see.

### Delta vs. 2026-10-04 audit

The prior audit (`docs/audits/GAP_ANALYSIS_20261004.md` (removed; see git history)) had 208 gaps (6 P0, 106 P1, 76 P2, 20 P3). This run has 253 (0 P0, 70 P1, 136 P2, 47 P3).

**Findings that carry prior ids (regressions / incompletely fixed).** By tally, 66 of the 253 findings carry at least one `prior_gap_ids` value, covering 56 distinct prior ids. Nothing in the worker data reports a previously closed fix being reverted; these are residuals of fixes judged only part closed, or prior gaps still open. Source wording is kept in the Nature column.

| Prior id(s)      | New id(s)                          | Nature (from the finding)                                                                                                                       |
| ---------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| GAP-115          | GAP-001, GAP-074                   | M2 collaborator/funeral invite always 403 in production (seam target-key mismatch); provider-entity create always 503 (`taxIdCipher` unbound) |
| GAP-009          | GAP-003, GAP-005                   | Sign-up closed (that half fixed), but MFA enrolment still not enforced server-side                                                              |
| GAP-019          | GAP-010                            | Admit matcher fed only name+DOB+MBI; soft-review and hard-block outcomes unreachable                                                            |
| GAP-040          | GAP-022                            | PRN: GAP-040 only half closed;`prn_administration` never written                                                                              |
| GAP-052          | GAP-025                            | M17 cron workers use sentinel actor; audit-trigger FK fails when they write                                                                     |
| GAP-056          | GAP-028                            | EVV aggregator transport deny, credentials unbound                                                                                              |
| GAP-069, GAP-076 | GAP-035                            | Cron alert codes have no alert rule; zero recipients                                                                                            |
| GAP-150, GAP-076 | GAP-041                            | Cap band escalation never alerts; nightly crons publish to NOOP;`m26.cap.accrual_recorded` partly emitted                                     |
| GAP-088          | GAP-046                            | PIP/SRA close is nominee-based one-step close; migration 0335 relaxed V-11/V-12 (incomplete fix)                                                |
| GAP-157          | GAP-048                            | Quality UI read-only apart from mortality review                                                                                                |
| GAP-155          | GAP-049                            | Producer half closed; no M36 consumer for any`m30.*` event                                                                                    |
| GAP-095          | GAP-051, GAP-053, GAP-164          | Telehealth vendor adapter unbound; UI placeholder; halt-recording flips DB flag only                                                            |
| GAP-160, GAP-092 | GAP-054                            | No staff UI for telehealth or portal admin                                                                                                      |
| GAP-098, GAP-061 | GAP-057                            | M34 alert resolvers never registered                                                                                                            |
| GAP-100          | GAP-058, GAP-059, GAP-060          | M35 Stripe transport unbound, workers absent, payment method trusted from client                                                                |
| GAP-101          | GAP-062, GAP-063                   | No M36 vendor transport bound; endpoint verification code never delivered                                                                       |
| GAP-166          | GAP-063                            | Endpoint verification code never delivered                                                                                                      |
| GAP-099          | GAP-068, GAP-182                   | M40`physician_deactivated` alert unrouted; promo self-apply has no visibility restriction (redemption locking itself closed)                  |
| GAP-014          | GAP-083                            | Audit exports cannot be retrieved (`downloadUrl` never returned)                                                                              |
| GAP-026          | GAP-089                            | Window escalation closed; late-CTI written-cert deadline not persisted or followed up                                                           |
| GAP-024          | GAP-091                            | Child-resource binding closed for M6; M7 goal/intervention`problemId` not verified against plan                                               |
| GAP-053          | GAP-107                            | M17 write routes carry only RBAC                                                                                                                |
| GAP-131          | GAP-110                            | M17 route-efficiency 501; proposal sources never produced                                                                                       |
| GAP-055          | GAP-114                            | EVV reads lack caseload scope; attestation gate off by default                                                                                  |
| GAP-134          | GAP-116                            | M19 verbal-order step-up path never invoked; encounter-link retry worker absent                                                                 |
| GAP-064          | GAP-119                            | Location half closed;`patientId` half open (body `patientId` not checked against admission)                                                 |
| GAP-065, GAP-140 | GAP-121                            | Fake-success removed; PHI bundle export (503) and template publish (501) still absent                                                           |
| GAP-149          | GAP-127, GAP-142                   | Cost-report path fixed; cap-projection path and PS&R import still ignore CCN                                                                    |
| GAP-145          | GAP-128, GAP-129                   | M24 reads org-wide; claim predicate checks provider-entity scope only                                                                           |
| GAP-073          | GAP-134                            | Manual match validates and posts, but ABAC mis-targets the line id                                                                              |
| GAP-075          | GAP-138, GAP-143                   | Posting-event payload fixed; null-DTM drop and inert replaced/voided bindings remain                                                            |
| GAP-079          | GAP-146                            | Cap UI read-only                                                                                                                                |
| GAP-208          | GAP-147                            | Four of six M26 seams unregistered. GAP-181 (all six M35 seams deny-stubs) also names GAP-208 in its evidence but has an empty`prior_gap_ids` |
| GAP-082          | GAP-151                            | Cost-report workspace mostly wired; mapping, ECR, reopen and extension surfaces missing                                                         |
| GAP-154          | GAP-162                            | Patient-linked writes fixed; per-PE measure rows still computed from org-wide inputs                                                            |
| GAP-159          | GAP-163, GAP-166, GAP-167, GAP-170 | M31 events record-only; webhooks verify then discard; read-only gate fails open; recording lifecycle unbuilt                                    |
| GAP-161          | GAP-171, GAP-172                   | M32 queues and evaluation-run transitions not built                                                                                             |
| GAP-104          | GAP-183                            | M36 on-call/bereavement/discipline/location channels 501                                                                                        |
| GAP-116          | GAP-195, GAP-202                   | Permission half closed; terminology admin and MDM console remain search-only                                                                    |
| GAP-186          | GAP-205                            | `SCREEN_SPEC_STATUS` "built" checked only for citing a registered screen set                                                                  |
| GAP-191          | GAP-206                            | Step-up drafts persisted in`sessionStorage`                                                                                                   |
| GAP-179          | GAP-214                            | Frame fidelity: 2 pending, 14 partial                                                                                                           |
| GAP-188, GAP-208 | GAP-215                            | Stale seam-status comments                                                                                                                      |
| GAP-029          | GAP-226                            | M8 half closed; M9`cosigner_role_match` still compares the wrong id space                                                                     |
| GAP-124          | GAP-227                            | PUT/PATCH answers closed; HUV completion-date route lacks author-discipline guard                                                               |
| GAP-111          | GAP-230                            | Fixed in code; only stale "NULL actor" comments remain                                                                                          |
| GAP-130          | GAP-233                            | `close-13mo` legal-hold skip vacuous                                                                                                          |
| GAP-144          | GAP-238                            | Routes reconciled;`POST /admin/billing/platform-rules` is a permanent 501                                                                     |
| GAP-158, GAP-199 | GAP-246                            | Seams registered; minor drift remains in M31                                                                                                    |
| GAP-162          | GAP-247                            | `tile_warm_cache` has no worker; stale comments                                                                                               |
| GAP-068          | GAP-253                            | Operational env vars absent from example env files                                                                                              |

**Confirmed closed from the prior audit** (each re-checked against code at HEAD this run):

- **M1-M5 identity and platform:** GAP-001, 002, 003, 007, 008, 010, 011, 013, 015, 016, 017, 111, 112, 113, 114, 117, 118, 185. GAP-018 is closed for its routes only (remaining deferrals are listed in findings). GAP-004, 005, 006 and 009 (sign-up part only) are also closed.
- **M6-M10:** GAP-020, 022, 024, 025, 028, 121, 122. Also closed: GAP-029 (M8 half), GAP-124 (PUT and PATCH answers, regenerate-schedules), GAP-026 (window escalation and `recert_due_notify`), GAP-021 (discharge/revocation/transfer UI), GAP-023 (face-to-face UI) and GAP-027 (addendum finalize). All 14 M6/M7/M8/M10 outbox consumer factories are constructed in `apps/backend/src/index.ts`, and the M6-M10 cron workers are built, scheduled and given an org enumerator.
- **M11-M15:** GAP-030 to 039, 041 to 046, 125, 126, 127 (partial; assignee-check and pre-adjourn parts not re-verified), 128, 193. GAP-040 is only half closed (see GAP-022 above).
- **M16-M20:** GAP-047 to 051, 054, 057 to 061, 129, 132, 133, 135, 136, 194, 195.
- **M21-M25:** GAP-062, 063, 064 (Location half), 066 to 073, 137 to 139, 141 to 144 (routes), 146 to 148.
- **M26-M30:** GAP-075, 076, 077, 078, 080, 081, 083 to 087 (GAP-087 wiring half), 089, 090, 091, 150 (partial), 151 to 156, 198, plus GAP-155 (producer half) and GAP-154 (patient-linked M30 writes).
- **M31-M40:** GAP-006, 092 (largely), 093, 094, 096 to 099, 102 to 110, 158, 159/161 (partial), 163 to 165, 167, 169 (partial), 170 to 174.
- **UI and docs:** GAP-082 (cost-report read-only), 116 (permission half), 186 (no per-spec join; residual weakness is GAP-205).
- **Also confirmed intact:** the 2026-06-27 remediation items (ABAC registry, `step_up_recent`, PHI-safe logger, chromed-route guard, prod env validation, `platform.bypass_invoked` auditor, durable break-glass), a clean secret scan, byte-identical `CLAUDE.md` / `AGENTS.md`, and no duplicate screen ids or paths.

**New this run.** By tally, 187 of the 253 findings carry no `prior_gap_ids` and are new relative to the 2026-10-04 audit, including GAP-181 (which names GAP-208 only in its evidence text). The 253 total is 45 higher than the prior 208, while P0 falls from 6 to 0 and P1 from 106 to 70. P2 and P3 grow because this run reported more intra-module drift, stale-stub and UI action-coverage findings (for example GAP-203, GAP-204, GAP-205, GAP-213).

## 2. Fitness kit results

Every command passed. No row has a code or test-infra failure; where a passing gate emitted non-green output, the finding that captures it is named.

| Command                                                                                                                                                                                                                   | Pass/Fail | Metric                                                                                                                                                                             | Non-green output                                                                                                                                                            | Failure class (code/test-infra/unverified) |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `bun install`                                                                                                                                                                                                           | Pass      | lockfile consistency: 530 installs across 657 packages, no changes                                                                                                                 | none                                                                                                                                                                        | none                                       |
| `bun run build`                                                                                                                                                                                                         | Pass      | `tsc -b` clean, exit 0                                                                                                                                                           | none                                                                                                                                                                        | none                                       |
| `bun run arch:fitness`                                                                                                                                                                                                  | Pass      | OK: all 40 gates pass (~42s); includes openapi-coverage ratchet, inject-coverage 39/39, client:check, outbox-bindings, route-reachability, live-suites                             | none                                                                                                                                                                        | none                                       |
| `bun run status:matrix`                                                                                                                                                                                                 | Pass      | 40 Implemented, 0 Partial, 0 Placeholder, 0 warnings; every module Routes and Live ratio is full (e.g. 54/54, 21/21)                                                               | none                                                                                                                                                                        | none                                       |
| `bun run test`                                                                                                                                                                                                          | Pass      | Test Files 1083 passed, 336 skipped (1419); Tests 15031 passed, 3824 skipped, 12 todo; exit 0; 129s                                                                                | Skips are the live suites, which skip without a DB; noisy`(node:..) --localstorage-file` warnings only                                                                    | none (live suites not run)                 |
| `bun audit`                                                                                                                                                                                                             | Pass      | No vulnerabilities found                                                                                                                                                           | none                                                                                                                                                                        | none                                       |
| `bun run arch:migration-numbering`                                                                                                                                                                                      | Pass      | migration ordinals unique except 21 frozen historical pairs; 135 gaps reported, not fatal                                                                                          | none                                                                                                                                                                        | none                                       |
| `bun run arch:tenancy`                                                                                                                                                                                                  | Pass      | three-column rule,`app.org_id`, RLS enabled implies forced (no dangerous RLS shapes)                                                                                             | none                                                                                                                                                                        | none                                       |
| `bun run arch:abac-predicates`                                                                                                                                                                                          | Pass      | 198 declared, 164 used by`requireAbac` across 324 guards; every name declared                                                                                                    | none                                                                                                                                                                        | none                                       |
| `bun run arch:abac-composed`                                                                                                                                                                                            | Pass      | 192 declared, 165 composed, 27 allowlisted with reason (M22`document_within_admission_window` is an "Open gap" entry)                                                            | Gate counts the unused`PERIOD_ACTIVE` wrapper as composition (M27 `cost_report_period_active`)                                                                          | advisory: GAP-244, GAP-123, GAP-197        |
| `bun run arch:route-reachability`                                                                                                                                                                                       | Pass      | 187 registrars reached from composition root                                                                                                                                       | none                                                                                                                                                                        | none                                       |
| `bun run arch:outbox-bindings`                                                                                                                                                                                          | Pass      | 211 live bindings, 0 declared-but-unbound pairs; 86 subscribed names not routed (no-such-event 2)                                                                                  | The gate cannot see the M11 lab-results consumer because`m29.lab_observation.attached` declares no consumers                                                              | advisory blind spot: GAP-016               |
| `bun run arch:error-envelope`                                                                                                                                                                                           | Pass      | no flat error bodies                                                                                                                                                               | none                                                                                                                                                                        | none                                       |
| `bun run arch:request-header-auth`                                                                                                                                                                                      | Pass      | 43 header reads across 11 registered headers                                                                                                                                       | none                                                                                                                                                                        | none                                       |
| `bun run arch:context-attributes`                                                                                                                                                                                       | Pass      | 183 reads over 15 declared keys, 15 produced                                                                                                                                       | none                                                                                                                                                                        | none                                       |
| `bun run arch:openapi-provenance`                                                                                                                                                                                       | Pass      | 2080/2174 pairs attributed                                                                                                                                                         | none                                                                                                                                                                        | none                                       |
| `bun run arch:openapi-coverage`                                                                                                                                                                                         | Pass      | 1476/1476 enriched; the 1 unpublished-body route is the Stripe webhook (not M36-M40)                                                                                               | none                                                                                                                                                                        | advisory: GAP-208                          |
| `bun run openapi:coverage`                                                                                                                                                                                              | Pass      | 1476/1476 routes enriched; 1/840 mutating routes read a body they publish none for (M35`35-subscription`); 8/602 GETs carry no response schema (05-patient 4, 10-hope 1, others) | 1 mutating route in`35-subscription` handler reads a body but publishes no schema (ratcheted in `audit/openapi-coverage/baseline.json`); 8 GETs without response schema | advisory: GAP-207, GAP-208, GAP-220        |
| `bun run <scratchpad>/noresp.ts` (read `ROUTE_ENRICHMENTS`, list GET routes without response schema)                                                                                                                  | Pass      | 4 M5 GET routes lack a response schema                                                                                                                                             | `GET /api/v1/patients/:id/caregivers`, `/api/v1/patient-matches`, `/api/v1/patients/:id/amendments`, `/api/v1/amendments`                                           | advisory: GAP-220                          |
| `bun run arch:request-body-contract`                                                                                                                                                                                    | Pass      | 1476 routes                                                                                                                                                                        | none                                                                                                                                                                        | none                                       |
| `bun run docs:ui`                                                                                                                                                                                                       | Pass      | 113 screens, 29 patterns, 113 index entries, 290 links                                                                                                                             | none                                                                                                                                                                        | none                                       |
| `bun run ui:parity`                                                                                                                                                                                                     | Pass      | 113 documented screen specs, 330 screens registered (web 277, portal 18, admin 35); report regenerated,`git status` stayed clean                                                 | none                                                                                                                                                                        | none                                       |
| `bun run scripts/report-ui-parity.ts --check`                                                                                                                                                                           | Pass      | report fresh                                                                                                                                                                       | none                                                                                                                                                                        | none                                       |
| `bun run frame:fidelity`                                                                                                                                                                                                | Pass      | 19 screens mapped to 120 frames; 3 matched, 14 partial, 2 pending; 102 frames have no registry row (25 deferred, 7 design-library, 70 unmatched)                                   | Only 3 of 19 mapped screens are matched; M06 Death and Discharge are pending; 70 frames unmatched                                                                           | advisory: GAP-204, GAP-214                 |
| `bun run frame:fidelity:check`                                                                                                                                                                                          | Pass      | 19 mapped, 25 deferred, 70 unmatched; 3 matched / 14 partial / 2 pending                                                                                                           | none                                                                                                                                                                        | advisory: GAP-214                          |
| `vitest run` (module dirs + `packages/hope` + `packages/assessments`, non-live)                                                                                                                                     | Pass      | 14 files / 165 tests passed                                                                                                                                                        | none                                                                                                                                                                        | none (live suites not run)                 |
| `vitest run apps/backend/__tests__` M6-M10 non-live files in batches of 15                                                                                                                                              | Pass      | 90 files / 1272 tests passed (312+233+226+152+169+180)                                                                                                                             | none                                                                                                                                                                        | none (live suites not run)                 |
| `bunx vitest run` (non-live: `packages/emar`, `orders`, `dosespot`, `idg`, `discipline-plans`; `apps/backend/src/modules/11-15`; `apps/backend/__tests__` m11-m15, orders*, dosespot*, emar*, idg*, orm*) | Pass      | 38+15+40 files, 598+314+550 tests passed                                                                                                                                           | live suites skipped (not run by instruction)                                                                                                                                | none (live suites not run)                 |
| `bunx vitest run` M21-M25 modules plus `packages/supplies`, `forms`, `intake-extraction`                                                                                                                          | Pass      | 44 test files, 479 tests passed (non-live only)                                                                                                                                    | none                                                                                                                                                                        | none (live suites not run)                 |
| `npx vitest run` M26-M30 modules plus `packages/cap-management`, `cost-report`, `fhir`, `quality` (`--exclude '**/*.live.test.ts'`)                                                                           | Pass      | 84 files, 1123 tests passed                                                                                                                                                        | none                                                                                                                                                                        | none (live suites not run)                 |
| `audit/openapi-coverage/OPENAPI_COVERAGE.md` (read, not re-run)                                                                                                                                                         | Pass      | M21 40/40, M22 58/58, M23 72/72, M24 39/39, M25 33/33 routes enriched; route counts match independent extraction                                                                   | none                                                                                                                                                                        | none                                       |

## 3. Per-module gap table

Ordered by module, then severity (P1, P2, P3). Cross-module findings are filed under their first-named module; non-module findings (docs, UI corpus, ops) are at the end. Evidence is abbreviated; the full evidence list is in the finding record for each ID. "Verified" = Yes when reproduced by command or direct read, No when inferred.

| Module       | Area                                 | Gap                                                                                                                                                                               | Evidence                                                                                                                                                                                                                                       | Severity | Verified | Recommended fix                                                                                                                                               |
| ------------ | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M01          | M1 system status                     | GAP-072: POST /api/v1/admin/system/status mutates the platform-global status banner with no audit event and no actor                                                              | `apps/backend/src/bootstrap/routes/system.ts:93-99` handler upserts and returns with no audit() call; spec M01 §8.1 `system_status.changed`                                                                                               | P2       | No       | Resolve actor from request.context, write system_status.changed through audit(), populate system_status.updated_by                                            |
| M01          | Idempotency                          | GAP-218: Idempotency replay runs in a global preHandler before route authorization and key is not bound to user, method or path                                                   | `bootstrap/plugins/idempotency.ts:36-67` addHook('preHandler'); hash = computeIdempotencyHash(orgId, key, body) (line 43)                                                                                                                    | P3       | No       | Include userId, method, route URL in key/hash; run replay after route authorization                                                                           |
| M01          | M1 realtime                          | GAP-216: Socket.IO events (system.status_changed, feature_flag.updated) not emitted anywhere                                                                                      | `packages/messaging/src/realtime/events.ts:30` defines systemStatusChanged; no other reference; spec M01:2522-2523                                                                                                                           | P3       | Yes      | Emit from write paths via M36 socket gateway or amend spec to polling                                                                                         |
| M01          | RLS live coverage                    | GAP-217: processing_log (M1) and audit_integrity_run (M4) have no cross-tenant RLS assertion                                                                                      | `m4-audit-integrity-sample.live.test.ts` reads audit_integrity_run on admin connection and only asserts UPDATE refused as app (line 215)                                                                                                     | P3       | No       | Add both tables to module RLS isolation suites                                                                                                                |
| M02          | M2 collaborator/funeral links        | GAP-001: POST /collaborators/invite and /funeral/invite always 403 in production: route passes {patientId}, M5 predicate reads target.id                                          | `link-routes.ts:90-93` patientTarget returns `{ patientId }`; `caseload-provider.ts:61-67` `typeof target.id === "string"`; `m2-link-redemption.live.test.ts:289-290` `registry.register("caseload_membership", async () => true)` | P1       | Yes      | M5 predicate accepts`patientId` and `id` targets, or M2 passes {id}; replace live-suite stub with real predicate                                          |
| M02          | M2 authentication audit (164.312(b)) | GAP-002: No authentication audit trail: login, lockout, logout, reset, 2FA, passkey, session revoke neither emitted nor in action catalog                                         | `packages/auth/src/identity/mount.ts:60-90` records throttle outcome only; `packages/audit/src/actions/m2.ts` has no auth.login_*/auth.account_locked; spec M02 §8.1 lines 1436-1450                                                      | P1       | Yes      | Register auth.*/passkey.*/session.revoked in M4 catalog; emit from Better Auth hooks with ip prefix, no secrets                                             |
| M02          | Primary staff login audit            | GAP-004: Staff login success/failure, lockout, logout and 2FA enrol/disable/backup-code produce no audit_event (only step-up, portal-session, magic-link paths audited)           | `identity-audit.ts:18-32` IDENTITY_AUDIT_EVENTS has no auth/login/logout/lockout/2FA entries; `mount.ts:57-100` throttle only                                                                                                              | P1       | Yes      | Write spec'd auth.* events via M4 helper in registerIdentityAuth bridge; emit auth.account_locked on CredentialThrottleError                                  |
| M02          | M2 sign-in policy                    | GAP-003: MFA enrolment not enforced server-side for staff roles (spec §2.3); verify-email unbacked, requireEmailVerification unset                                               | spec`WARDENX_MODULE_02_IDENTITY_SPEC_v0_4.md:293` and `:724`; `auth.ts:348-361` session-create hook checks user status only; `auth.ts:255-282` no requireEmailVerification                                                             | P1       | Yes      | Add authenticate-stage gate holding session at MFA-enrolment stage; configure email verification or document invite-accept-only model                         |
| M02          | MFA matrix                           | GAP-005: Any role can sign in and bind an organization with password only                                                                                                         | grep`mfaRequired\|requireMfa\|MFA_REQUIRED\|twoFactorEnabled` over `apps/backend/src packages/auth/src` returns nothing; spec `:293`, `:729`, `:315`; HIPAA 164.312(d)                                                                  | P1       | Yes      | Before select-organization check enrolled factors against MFA matrix, answer 403 MFA_ENROLMENT_REQUIRED; block two-factor/disable for MFA-required roles      |
| M02          | M2 collaborator link                 | GAP-073: POST /collaborators/invite has no RBAC check (collaborator.invite never required)                                                                                        | `link-routes.ts:149-156` only requireSession() + requireAbac(...); funeral invite `:190-194` adds requirePermission("funeral.invite")                                                                                                      | P2       | No       | Add`requirePermission("collaborator.invite")` before ABAC                                                                                                   |
| M02          | Provider entity CRUD                 | GAP-074: POST /api/v1/provider-entities always 503 TAX_ID_CIPHER_UNBOUND in production                                                                                            | `index.ts:3889-3894` `mountOrgAdminRoutes(app, dbHandle.db, { outbox: m2OutboxPublisher })`; `org-admin-routes.ts:223-230` throws TAX_ID_CIPHER_UNBOUND 503                                                                              | P2       | No       | Bind TaxIdCipherPort over M34 tenant key ring; add live create-PE test                                                                                        |
| M02          | Background jobs                      | GAP-075: Spec'd jobs session.reap_expired, auth.offboard_user, auth.breach_check, auth.send_invitation do not exist; expired sessions never purged                                | spec M02 §4.6 lines 1200-1206;`apps/backend/src/bootstrap/jobs/` has only audit-archive, idempotency-cleanup, partition-rotation                                                                                                            | P2       | No       | Add platform-context session reaper cron and offboard/breach-check consumers or amend spec                                                                    |
| M02          | Offboarding                          | GAP-076: POST /users/:id/deactivate bypasses last-admin lockout guard, no self-deactivation guard or step-up                                                                      | `identity-routes.ts:749-790` no activeAdminCount check; `:583`, `:628` lastAdminLockout only on suspend/DELETE member                                                                                                                    | P2       | No       | Apply activeAdminCount guard, refuse self-deactivation, require step-up                                                                                       |
| M02          | Invitations                          | GAP-077: Invitation create deviates from spec: email not validated/normalised, location/PE ids not validated, TTL 72h not 7d, token returned in body                              | `identity-routes.ts:247-300` readString only; `identity-stores-db.ts:39` INVITE_TTL_MS = 72h vs spec `default TTL 7 days`; `:300-304` returns inviteUrl                                                                                | P2       | No       | Validate/lowercase email, validate location/PE ids (422 INVALID_LOCATION_SCOPE), align TTL, stop echoing token                                                |
| M02          | Step-up                              | GAP-078: Login-MFA step-up initialisation (W-M2-08) never wired: onLoginMfaCompleted has no caller                                                                                | `hooks/login-mfa-completed.ts:40` definition and barrel export only; spec §2.4 line 311                                                                                                                                                     | P2       | Yes      | Call onLoginMfaCompleted from two-factor/passkey completion hook; add live test                                                                               |
| M02          | Invitation accept                    | GAP-219: Invitation accept not atomic: invite consumed before membership insert                                                                                                   | `identity-routes.ts:372-410` consume(token) then memberships.create in separate tx                                                                                                                                                           | P3       | No       | Consume + create in one org-context tx or compensate                                                                                                          |
| M03          | Tenant onboarding (M3/M34)           | GAP-006: No production path creates tenant role rows or default role_permission grants                                                                                            | `role-store.ts:29-35` ROLE_TEMPLATES has no sync; `index.ts:2743-2748` throws 'org_admin role template is unavailable'; `deploy/production/compose.yml:141,155` no role seeding                                                          | P1       | Yes      | Add role-template materializer (migration/seed + M34 provisioning + backfill); live test: provision -> accept first-admin invite -> /me/permissions non-empty |
| M03          | RBAC/ABAC scope                      | GAP-007: membership_role.scope and role.scope_level are write-only; scoping a role grant has no effect                                                                            | `authz-routes.ts:309-322` stores `scope: body.scope`; `drizzle-store.ts:43-82` loadGrants selects roleKey/enabled/expiresAt only; spec §3.4 line 454, §4.2 line 704                                                                    | P1       | Yes      | Include membership_role.scope in actor enrichment and intersect in provider_entity_scope/location_scope; validate scope and expires_at                        |
| M03          | Break-glass                          | GAP-082: Break-glass grants satisfy mutating ABAC guards by default                                                                                                               | `require-abac.ts:221-227` breakGlassBypassable defaults to true; `patient-routes.ts:136-145` chartScope(patient.edit...)                                                                                                                   | P2       | No       | Bypass only for GET/HEAD guards; explicit opt-in for mutating guards                                                                                          |
| M03          | Break-glass                          | GAP-079: Cross-tenant break-glass not implemented: target_organization_id / consent_ref never written,`denied` unreachable                                                      | `break-glass-store.ts:63-89` invoke inserts intra-org columns only; spec M03 §2.3.2, §3.5                                                                                                                                                  | P2       | No       | Implement platform cross-tenant branch or amend spec; add deny-cosign action                                                                                  |
| M03          | Auditor engagement report            | GAP-080: GET /engagements/:id/summary hardcodes resourcesTouched: 0                                                                                                               | `engagement-store.ts:183-188` `resourcesTouched: 0, // populated from the break-glass + read-audit trail (M4/T10).`                                                                                                                        | P2       | No       | Compute from M4 read-audit trail keyed on engagement id                                                                                                       |
| M03          | RBAC cache                           | GAP-081: Permission cache is per-process 5-min TTL; spec requires Valkey, 60s TTL, cache_invalidate queue, permissions.changed push                                               | `resolve.ts:102` DEFAULT_TTL_MS = 5*60*1000; grep `cache_invalidate\|permissions.changed` none                                                                                                                                            | P2       | No       | Valkey-backed cache with 60s ceiling and publish invalidations from M2/M3 writers and CLI                                                                     |
| M04          | Retention / legal hold               | GAP-008: Legal-hold supremacy incomplete: dateRange/resourceKinds-only holds never stop audit erase; no retention_class flip; no HoldApplier                                      | `audit-eraser.ts:172-190` legalHoldFor `text.includes(input.resourceId)`; `legal-holds.ts:213-262` apply only INSERTs; spec §2.5, §2.6                                                                                                 | P1       | Yes      | Evaluate holds structurally; re-check in execute sweep; bind HoldApplier consumers; live tests                                                                |
| M04          | Compliance export                    | GAP-083: Audit exports built but GET /audit/exports/:id never returns downloadUrl                                                                                                 | `audit-exports.ts:82-92` `downloadUrl is always omitted`; stale vs `jobs/audit-job-ops.ts:236-270`                                                                                                                                       | P2       | Yes      | Presign short-lived URL when status='ready'; audit download; fix header comment                                                                               |
| M05          | Patient admit / duplicate prevention | GAP-009: POST /patients accepts client bypassMatchReview that skips duplicate pipeline with no bypass permission, step-up or critical audit                                       | `patient-route-service-db.ts:369` `if (!input.bypassMatchReview) {`; `patient-routes.ts:356-371` guard only `patient.create`; spec M05 lines 318, 1350, 1355, 1554, 2606                                                               | P1       | Yes      | Require patient.create_bypass_match + requireStepUp, emit critical audit; route test                                                                          |
| M05          | Matching §7.1/§7.3                 | GAP-010: Matcher fed only name+DOB+MBI; soft-review and hard-block unreachable; SSN/address/phone/email silently discarded                                                        | `matcher.ts:105-122` max 0.25+0.15+0.20 = 0.60 < 0.75; `patient-route-service-db.ts:313` `SSN is NOT stored ... nor are name_alias / address / phone / email`                                                                            | P1       | Yes      | Load candidate address/phone/email/SSN hash into MatchCandidate; persist or 422 the fields; live tests                                                        |
| M05          | Merge cascade                        | GAP-084: patient.merged has no wired consumers for M22 re-attach or M39 consent repoint; payload shape mismatch                                                                   | `merges-db.ts:76-80` no re-point; `events-by-m5.ts:165-183` declaredConsumers ["m35"]; `consent consumers.ts:60-66` expects mergedIntoId                                                                                                 | P2       | Yes      | Re-point or union-read patient-keyed rows; bind M22 and M39 consumers; live merge test                                                                        |
| M05          | Census/list                          | GAP-085: List lists merged charts, GET doesn't follow merged_into_id, search omits MBI/DOB                                                                                        | `patient-route-service-db.ts:117-150` no status != 'merged'; spec line 1240-1241                                                                                                                                                             | P2       | Yes      | Exclude merged by default, add MBI/DOB search, return mergedIntoId                                                                                            |
| M05          | Sensitive identifiers                | GAP-086: SSN/state-ID storage and reveal unbuilt; _match-preview and >30d unmerge deferred                                                                                        | `lifecycle-routes.ts:209-214` throws SENSITIVE_IDENTIFIER_UNSUPPORTED                                                                                                                                                                        | P2       | No       | Implement envelope-encrypted SSN path with step-up reveal, or descope in spec                                                                                 |
| M05          | Spec corpus                          | GAP-087: Spec route tables contradict code: M5 §4.3 marks built routes DEFERRED; M2 marks /me/session no route                                                                   | M5 spec`:1249,1252-1253,...` vs `lifecycle-routes.ts:157-381`; M2 spec `:739` vs `session-step-up.ts:159`                                                                                                                              | P2       | No       | Update route tables to as-built, keep true deferrals                                                                                                          |
| M05          | Input validation / OpenAPI           | GAP-220: Boundary validation gaps on M5 produce raw 500s                                                                                                                          | `patient-typebox.ts:260-282` payerId/effectiveFrom bare strings; `patient-route-service-db.ts:524-534` `throw new Error('patient ... not found')`                                                                                        | P3       | No       | Use uuid/date formats, NotFoundError, validate cursor, add response schemas                                                                                   |
| M05          | Read-audit completeness              | GAP-221: Read-audit coverage gate omits PHI-adjacent prefixes                                                                                                                     | `bootstrap/index.ts:120-300` lacks /api/v1/amendments, /patient-matches, /privacy, /audit, /funeral                                                                                                                                          | P3       | No       | Add prefixes; document chart-access-history read audit                                                                                                        |
| M05          | Census KPI (web)                     | GAP-251: Census KPI strip Admissions/Discharges/GIP/Recerts render as placeholders                                                                                                | `patient-list-census.tsx:132-133` 'cross-module KPIs ... render as honest placeholders until M6/billing reads land'                                                                                                                          | P3       | No       | Bind to M6 reads or remove tiles                                                                                                                              |
| M06          | Org timezone (D8)                    | GAP-088: Org timezone not used for M6 deadline math and M6/M7 crons                                                                                                               | `admission-route-service-db.ts:575,593` DEFAULT_ORG_TZ; `cron-workers.ts:91-93` calendarDate(now) = UTC; spec D8 lines 3994-4003                                                                                                           | P2       | No       | Resolve organizationTimezone at each deadline; per-org local date in F2F cron                                                                                 |
| M06          | Late (oral) CTI                      | GAP-089: Written-cert deadline neither persisted nor followed up; mark-late has no state guard                                                                                    | `admission-route-service-db.ts:4743-4786` markCtiLate; `events-by-m6.ts:540-549` declaredConsumers: []                                                                                                                                     | P2       | No       | Open compliance_window at mark-late; restrict to unsigned drafts                                                                                              |
| M06          | Election periods                     | GAP-090: PATCH /election-periods/:id accepts effectiveStart but only bumps version                                                                                                | `admission-route-service-db.ts:4386-4401` updates version/updated_at only                                                                                                                                                                    | P2       | Yes      | Implement edit for pending periods with status guard or remove                                                                                                |
| M06          | Compliance windows                   | GAP-222: GET /compliance-windows has no compliance.scope narrowing                                                                                                                | `admission-routes.ts:1536-1548` [COMPLIANCE_READ] only; `abac-uncomposed-allowlist.ts:62-63` 'Open gap to bind or delete'                                                                                                                  | P3       | No       | Apply readScopeOf narrowing or bind and delete allowlist entry                                                                                                |
| M06          | R-ADM-02                             | GAP-223: R-ADM-02 not implemented; constants hard-coded false                                                                                                                     | `admission-route-service-db.ts:3962-3965` privacyFlagBlock:false, initialAssessment48hOverdue:false, donOverride:false                                                                                                                       | P3       | No       | Implement guard from compliance_window rows + DON override, or amend spec                                                                                     |
| M06          | Stale docs                           | GAP-224: Stale deny-stub/forward-seam documentation and unworked queues                                                                                                           | `m29-proposal-accepted.ts:1-31` 'NOT live-wired' but `index.ts:9050` binds it; `jobs/index.ts:15-30` queues with no worker                                                                                                               | P3       | No       | Delete/correct stale stubs; extend as-built spec note                                                                                                         |
| M07          | Care-plan signature                  | GAP-011: Signature records client-claimed signerRole never checked against signer's roles; one user can fill every quorum slot                                                    | `care-plan-routes.ts:243-262`; `abac-predicates.ts:336-346` signer_role_match never sees body.signerRole; `0127_...sql:37` unique only (version, signer_role)                                                                            | P1       | Yes      | Reject unless actor holds signerRole; unique index on (version, membership_id); give predicate a getTarget                                                    |
| M07          | Finalize                             | GAP-012: Finalize accepts client requiredSignerSet; floor enforced only by array length                                                                                           | `care-plan-route-service-db.ts:1129-1141` `if (set.length < floor.length) throw`; spec line 1403 (D5)                                                                                                                                      | P1       | Yes      | Drop override or superset-check every floor slot; source tightening from tenant config                                                                        |
| M07          | Goal/intervention creation           | GAP-091: problemId/goalRefs not verified to belong to plan in path                                                                                                                | `care-plan-route-service-db.ts:1445-1475` addGoal checks presence only; `0028_...sql:150,156` plain FKs                                                                                                                                    | P2       | No       | Load problem with eq(carePlanId, planId); consider composite FK                                                                                               |
| M07          | PHI read audit                       | GAP-092: /internal/care-plan/relevant-elements auditRead has no resource/patient id                                                                                               | `care-plan-routes.ts:507-514` `auditRead: { resourceKind: "care_plan_element" }`                                                                                                                                                           | P2       | No       | Add patientIdQueryParam; live assertion                                                                                                                       |
| M08          | Late entry                           | GAP-013: Late-entry tier (24h/72h/14d) never computed; reason/override gates and billing guard dead                                                                               | `late-entry/tiers.ts:48-55` computeLateEntryTier no non-test caller; `0030_...sql:33` default 'normal'; spec §2.5, §2.7                                                                                                                  | P1       | Yes      | Compute tier at finalize, persist, require reason (>=40), require override for higher tiers                                                                   |
| M08          | Overrides                            | GAP-014: Late-entry, administrative and supervisor-release overrides lack step-up (D13) and caseload scope                                                                        | `encounters-routes.ts:625-636`, `:639-650`, `:714-727` preHandler lacks STEP_UP; D13 line 1862                                                                                                                                           | P1       | Yes      | Add STEP_UP and SCOPE_FOR to the three routes; typebox reason >=100                                                                                           |
| M08          | Seams (M8/M19/M17)                   | GAP-069: Production EncounterCreator, MileagePayrollReader, renderPayloadFor run on in-memory store; M19 persists phantom linked_encounter_id; M17 miles always 0                 | `seams/drizzle-store.ts:69,71` `const fallback = createInMemoryEncounterReaderStore().store; return { ...fallback, ...}`; `store.ts:141-152` uuidFromCounter(++created)                                                                  | P1       | Yes      | Implement the three against DB tables; require every method in store type; live suite                                                                         |
| M08          | HVLDL (M8/M30)                       | GAP-070: HVLDL numerator always 0: evv_bracket_state never persisted as 'evv_present'                                                                                             | `m30-jobs.ts:1033-1038`; `drizzle-store.ts:270` `?? "evv_missing_documented"`; `encounters-route-service-db.ts:1840` `?? "evv_present"`                                                                                              | P1       | Yes      | Persist EVV bracket at finalize/sign; one NULL rule                                                                                                           |
| M08          | Void                                 | GAP-093: Void records encounter author as voiding actor                                                                                                                           | `encounters-route-service-db.ts:2090` `voidedBy: r.authoredByMembershipId // no distinct void actor threaded`                                                                                                                              | P2       | No       | Pass actorMembershipId into voidEncounter                                                                                                                     |
| M08          | Volunteer visits                     | GAP-094: checkVolunteerAssignment and related validators never invoked                                                                                                            | `lifecycle/validation.ts:124-133` no production caller; spec §2.7 line 363                                                                                                                                                                  | P2       | No       | Resolve M15 reader in createDraft and call it                                                                                                                 |
| M08          | Cosignature queue                    | GAP-095: Queue returns all org cosign_pending to any encounter.cosign holder                                                                                                      | `encounters-route-service-db.ts:1136-1145` WHERE status='cosign_pending' no routed_to filter; spec lines 1148, 1511-1516                                                                                                                     | P2       | Yes      | Filter by routed_to_membership_id = caller or caseload                                                                                                        |
| M08          | Billable internal route              | GAP-225: GET /internal/encounters/billable applies simplified rule disagreeing with seam                                                                                          | `encounters-route-service-db.ts:1156-1170` vs `seams/readers.ts:34-52`                                                                                                                                                                     | P3       | No       | Route handler through deriveBillability                                                                                                                       |
| M09          | Cosigner predicate                   | GAP-226: m9.cosigner_role_match compares membership id to user id                                                                                                                 | `abac-predicates.ts:146` `return facts.recordedByUserId !== context.userId`                                                                                                                                                                | P3       | No       | Use membershipIdOf(context)                                                                                                                                   |
| M10          | HOPE timeliness gate                 | GAP-015: adminOverride is a body boolean any timepoint writer can set; override permission never enforced; window judged on client targetDate                                     | `hope-typebox.ts:185,196`; `timepoint-gate.ts:88-92`; `contributed.ts:1311` hope.admin.late_deadline_override unreferenced                                                                                                               | P1       | Yes      | Remove from public body; separate permission-checked route; classify against server now                                                                       |
| M10          | iQIES pipeline                       | GAP-096: Spec describes automated iQIES submit/reconcile and alert dispatcher; as-built is manual with unscheduled stages and unbound transport                                   | `cron-workers.ts:493-520` scheduleM10Jobs skips assemble/submit/reconcile; `index.ts:7290-7316` createUnboundIqiesAdapter()                                                                                                                | P2       | No       | Update spec/ADR to manual flow or schedule stages                                                                                                             |
| M10          | HUV / schedules                      | GAP-227: HUV completion-date route lacks ABAC_AUTHOR; GET /hope/schedules denied to non-org-wide clinicians                                                                       | `hope-routes.ts:431-445` vs siblings `:311-313`, `:417-419`                                                                                                                                                                              | P3       | Yes      | Add ABAC_AUTHOR; apply listScopeOf narrowing                                                                                                                  |
| M11          | M29-M11 lab handshake                | GAP-016: Lab-result handshake unbuilt: results_status never leaves awaiting_results, results_received never emitted, review queue empty                                           | spec M11 line 1499;`events-by-m29.ts:363-380,395-410` declaredConsumers: []; `orders-route-service-db.ts:915-921` resultsPendingReview always []                                                                                           | P1       | Yes      | Build lab-results-applier, bind in index.ts, add m11 to declaredConsumers, emit events, live suite                                                            |
| M11          | Verbal orders                        | GAP-017: 48h signature clock starts at client receivedAt with no bound                                                                                                            | `orders-typebox.ts:146-148`; `orders-route-service-db.ts:1178` computeVerbalDeadline(args.receivedAt); `0036_...sql:110` NOT NULL only                                                                                                   | P1       | Yes      | Reject future/over-old receivedAt; server-stamp; DB CHECK                                                                                                     |
| M11          | Order suggestions (D7)               | GAP-097: Banner half built: route returns empty list, HOPE J2051 trigger consumer unbound                                                                                         | `orders-route-service-db.ts:922-925` `suggestions: []`; `outbox-subscription-exceptions.ts:141-150` handler-unbound                                                                                                                      | P2       | No       | Read Valkey projection; bind trigger consumer                                                                                                                 |
| M11          | Orders (web)                         | GAP-098: Standing orders screen read-only; verbal-policy, sign-on-behalf, suggestions have no web caller                                                                          | `standing-orders.tsx:16-17` writes deferred, `:48` only client.GET                                                                                                                                                                         | P2       | Yes      | Wire lifecycle actions or mark spec partial                                                                                                                   |
| M11          | Orders (web) comment                 | GAP-228: Stale comment claims authoring and correct still deferred                                                                                                                | `screens.ts:28-29` vs `order-editor.tsx:104-121`                                                                                                                                                                                           | P3       | Yes      | Update comment                                                                                                                                                |
| M12          | Standard order sign                  | GAP-018: Sign writes no signature record; M11 sign seam not called                                                                                                                | `dosespot-route-service-db.ts` signOrder ~858-892 direct UPDATE; header `:25-27` admits no order_signature row; spec line 53 (D3), 1100, 1502                                                                                              | P1       | Yes      | Call signOrderTarget in sign transaction; same for signControlledComplete and retransmit                                                                      |
| M12          | rx-benefit lookup                    | GAP-019: POST /rx-benefit/lookup is a stub that always answers covered:true                                                                                                       | `dosespot-route-service-db.ts:1418-1420` returns `{ covered: true, copayCents: null }`; spec :1119 'cached lookup'                                                                                                                         | P1       | Yes      | Read rx_benefit_cache; return explicit unknown/503/501; fix OpenAPI status                                                                                    |
| M12          | Policy tables                        | GAP-099: refill_inbox_policy and controlled_substance_policy tables do not exist; PATCH routes don't persist, omit step-up; enroll lacks step-up                                  | `dosespot-route-service-db.ts:1546-1578` putRefillInboxPolicy returns view without writing; header `:26-28`; spec line 2189                                                                                                                | P2       | No       | Add tables (RLS, manifest, live suite); persist PATCH; step-up; platform_ops flip route                                                                       |
| M12          | EPCS sign                            | GAP-100: Controlled-sign hard-codes safety facts to true, never verifies second factor                                                                                            | `:894-909` `deaScheduleAuthorized: true`, `prescriberIal2Verified: true`; `:911-935` `challengeCompletedInTime: true`, `secondFactorType: 'totp'`                                                                                  | P2       | No       | Before enabling EPCS verify schedule, IAL2, nonce and second factor                                                                                           |
| M12          | OpenAPI                              | GAP-101: 17 mutating M12 routes publish no response schema; rx-benefit declares 201 returning 200                                                                                 | `scripts/openapi/enrichments.ts:4872-4999`; M14 `:5206-5222`                                                                                                                                                                               | P2       | No       | Add response schemas; extend coverage ratchet                                                                                                                 |
| M12          | DrugCostBillingReader (M12/M27)      | GAP-102: Reader never registered; M27 Worksheet-A cross-check always skips                                                                                                        | `registry.ts:464-472` RESERVATION; consumer `index.ts:6190`                                                                                                                                                                                | P2       | No       | Register reader or drop rule and seam                                                                                                                         |
| M12          | Refill approve                       | GAP-229: Refill approve checks neither prescriber nor signer eligibility and never signs; carry_forward never creates draft                                                       | `dosespot-routes.ts:630-644` [REFILL_DECIDE, ABAC_REFILL_DECIDE]; `actorInScope:true` hard-coded                                                                                                                                           | P3       | Yes      | Remove fabricated fallbacks; enforce eligibility; build D10 draft                                                                                             |
| M12          | Stale comments                       | GAP-230: Stale 'NULL actor' compromise comments in M12/M13/M14 headers                                                                                                            | `dosespot-route-service-db.ts:22-23`, `emar-route-service-db.ts:19-21`, `idg-route-service-db.ts:20` vs `context.ts:55-73` resolveActorUserId                                                                                          | P3       | No       | Update headers to cite GAP-111                                                                                                                                |
| M13          | Five rights / BCMA                   | GAP-020: Production eMAR write never runs five-rights; BCMA scans evaluated against empty context                                                                                 | `emar-route-service-db.ts:995-1007` `{ orderActive: true, rxnormRxcui: null, ndc: null }`; header `:44-48` 'remains open'; spec line 156                                                                                                 | P1       | Yes      | Extend port with dose/unit/rxnorm/ndc/wristband; call assertFiveRights; live test 422                                                                         |
| M13          | PRN interval                         | GAP-021: assertPrnInterval is dead code in production                                                                                                                             | `packages/emar/src/prn/interval.ts:44-90` no caller outside definition; spec line 204                                                                                                                                                        | P1       | Yes      | Load prior PRN dose and call assertPrnInterval in recordAdministration                                                                                        |
| M13          | prn_administration                   | GAP-022: No code writes prn_administration; PRN reassessment cron and M30 measure read empty table                                                                                | only INSERTs in live tests;`emar-route-service-db.ts:1132-1146` `prnAdministrationId: randomUUID()`                                                                                                                                        | P1       | Yes      | Insert row in same tx; use policy window; live test                                                                                                           |
| M13          | Reconciliation                       | GAP-023: Worksheet finalize/void/decision have no status guard; spec-correct finalizer unused                                                                                     | `:1678-1727` requires decisions.length >= 1 only; `reconciliation.ts:323-345` used only by test; `:1672` PATIENT_SENTINEL actor                                                                                                          | P1       | Yes      | Call finalizeReconciliationWorksheet; terminal-status guards; real userId                                                                                     |
| M13          | Intentional hold                     | GAP-024: Intentional-hold discards reason, writes no missed_dose row, no status/grace guard, omits ABAC floor                                                                     | `:1512-1525` UPDATE for any id; `emar-routes.ts:527-541` discards reason                                                                                                                                                                   | P1       | Yes      | Require pending + grace; insert missed_dose; add ABAC guard                                                                                                   |
| M13          | Caregiver attested / kit return      | GAP-103: Caregiver-attested administration under sentinel admission, empty drug snapshot; kit-return ack skips quantities and discrepancy                                         | `:1260` `admissionId: ADMISSION_SENTINEL`, `:1264` `drugNameSnapshot: ''`; `:1741-1768` `finalRemainingByMedication: {}`                                                                                                           | P2       | No       | Use identity fields; extend body with quantities; compute discrepancy; supervisor floor                                                                       |
| M14          | Idempotency                          | GAP-104: POST routes lack Idempotency-Key listed in spec §4.1                                                                                                                    | `idg-routes.ts` requireIdempotencyKey only on PATCH/DELETE and `:980`; POST decisions/action-items without it                                                                                                                              | P2       | No       | Add IDEMPOTENCY_KEY to listed POST routes                                                                                                                     |
| M14          | Internal routes                      | GAP-231: /internal/idg/* system routes absent; packet activeDpoa null                                                                                                             | `jobs/packet-build.ts:33-35,773` `activeDpoa: null`                                                                                                                                                                                        | P3       | No       | Add routes or amend spec; add M39 DPOA seam                                                                                                                   |
| M15          | Volunteer ABAC                       | GAP-232: Volunteer routes 19, 22, 23, 24 have no ABAC role restriction                                                                                                            | `volunteer.routes.ts:103,160,175,192` permission-only; `contributed.ts:3720-3748` abac:"none"                                                                                                                                              | P3       | Yes      | Compose coordinator/compliance-officer/DON guard or amend spec                                                                                                |
| M16          | RLS test coverage                    | GAP-105: Live RLS isolation tests omit three owned tables                                                                                                                         | `m16-rls-isolation.live.test.ts` lacks bereavement_cop_opt_out_credit; m17 lacks membership_credential; m19 lacks on_call_roster_sync_queue                                                                                                  | P2       | No       | Add the three tables to suites                                                                                                                                |
| M16          | Retention                            | GAP-233: close-13mo legal-hold skip vacuous: nothing sets bereavement_plan.legal_hold_id                                                                                          | `cron-workers.ts:187,293` filter on legal_hold_id IS NULL; grep legalHoldId shows only reads                                                                                                                                                 | P3       | No       | Consult M4 legal-hold read or implement subscription                                                                                                          |
| M17          | Cron workers / audit actor           | GAP-025: Reassignment-scan and caregiver-reminder crons run with sentinel actor in app.user_id; audit trigger FK fails when they write                                            | `scheduling-route-service-db.ts:1923,1934` withOrgContext without orgContextFor(); `0269_...sql:45-66` trg_audit_visit                                                                                                                     | P1       | Yes      | Use orgContextFor(orgId, userId) at lines 1923/1934; live test with M17_SYSTEM_USER_ID                                                                        |
| M17          | Recurring visits                     | GAP-026: POST /recurring-visits discards window, tz, dates, count, byday, address; always 09:00-10:00 UTC                                                                         | `scheduling-route-service-db.ts:1533-1543` hard-codes '09:00','10:00','UTC'; `scheduling-routes.ts:551-558` forwards six fields                                                                                                            | P1       | Yes      | Persist and validate all fields; contract test                                                                                                                |
| M17          | M17-M19 seam                         | GAP-029: M17 owns no on-call roster source: tonightsOnCallRoster always throws; M19 shift-sync permanently degraded (filed under M19)                                             | see M19 row                                                                                                                                                                                                                                    | P1       | Yes      | see M19 row                                                                                                                                                   |
| M17          | Proposal publish                     | GAP-106: Publishing a proposal hard-codes 13:00-14:00 UTC, ignores duration, leaves patient_address_id NULL                                                                       | `scheduling-route-service-db.ts:1420-1438`; counter-evidence `address-reader.ts:134-160`                                                                                                                                                   | P2       | Yes      | Take window from proposal in org tz; resolve service address via M5                                                                                           |
| M17          | ABAC                                 | GAP-107: Visit/proposal/recurring write routes carry only RBAC                                                                                                                    | `scheduling-routes.ts:326-343`, `:365-391`, `:480`, `:511-535`, `:538-586`; `contributed.ts:1893-1966`                                                                                                                             | P2       | No       | Compose per-visit/patient caseload_or_scope guard                                                                                                             |
| M17          | Concurrency                          | GAP-108: PATCH /visits and reassign have no status guard, no If-Match, no unassigned event                                                                                        | `:963-1038` editVisit and `:1297-1349` reassignVisit never inspect v.status; grep If-Match none                                                                                                                                            | P2       | No       | Require If-Match; restrict states; emit unassigned                                                                                                            |
| M17          | Validation                           | GAP-109: Visit creation never validates admission/patient/address/setting; caregiverReminderOptIn never stored                                                                    | `:638-706` insertAndPublish; `scheduling-routes.ts:260-270` drops three fields                                                                                                                                                             | P2       | No       | Validate via M6 reader; persist opt-in and notes                                                                                                              |
| M17          | Stubs                                | GAP-110: GET /metrics/route-efficiency always 501; proposal sources m11/m14/m15 never produced                                                                                    | `:2267-2275` NOT_IMPLEMENTED 501; `consumers/index.ts:12-14`                                                                                                                                                                               | P2       | No       | Implement producers or amend spec; implement or remove route                                                                                                  |
| M17          | Audit retention                      | GAP-111: PHI write-audit events use retention_class 'operational' vs spec 'compliance'                                                                                            | `0045_...sql:255-268`; M17 spec header item 4                                                                                                                                                                                                | P2       | Yes      | New migration to 'compliance' + backfill, or amend spec                                                                                                       |
| M17          | Idempotency                          | GAP-112: M17 and M18 mutating routes do not require Idempotency-Key; geofence PATCH lacks If-Match                                                                                | grep requireIdempotencyKey in 17-scheduling and 18-evv returns no files; M17-F08                                                                                                                                                               | P2       | No       | Add requireIdempotencyKey(); version on geofence PATCH                                                                                                        |
| M17          | Cron fan-out                         | GAP-234: Cron fan-out lacks per-org isolation; cancel reasonCode ignored                                                                                                          | `cron-workers.ts:47-77`; `scheduling-route-service-db.ts:1143` forces 'operational'                                                                                                                                                        | P3       | Yes      | Wrap in forEachActiveOrg; persist reasonCode                                                                                                                  |
| M18          | EVV capture                          | GAP-027: Every aggregator submission carries empty service-type code                                                                                                              | `evv-route-service-db.ts:476-478` `serviceTypeCode: ""`; `evv-routes.ts:178-186` never passes b.serviceTypeCode                                                                                                                          | P1       | Yes      | Resolve server-side at capture; reject empty in payload builder                                                                                               |
| M18          | Aggregator adapter                   | GAP-028: Submission path cannot succeed: Sandata transport deny, credentials unbound, state identifier throws, NPI null                                                           | `jobs/wiring.ts:1-12,35-65`; `index.ts:3391-3393`                                                                                                                                                                                          | P1       | Yes      | Bind real transport, KMS credential store, state-id reader, NPI source, or record launch-state decision                                                       |
| M18          | Offline capture                      | GAP-113: Offline-sync idempotency on (deviceId, localId) not implemented                                                                                                          | `evv-typebox.ts:45,62` localId never passed; `evv-route-service-db.ts:466-491` no ON CONFLICT                                                                                                                                              | P2       | No       | Persist localId; ON CONFLICT DO NOTHING; per-event results                                                                                                    |
| M18          | ABAC                                 | GAP-114: EVV reads have no caseload_or_scope; device attestation off by default                                                                                                   | `evv-routes.ts:303-310,316-327,367-379` P('evv.read') only; OPS_RUNBOOK:2103 default OFF                                                                                                                                                     | P2       | No       | Compose scope guard; track attestation as release gate                                                                                                        |
| M19          | M17-M19 seam                         | GAP-029: M17 owns no on-call roster source: tonightsOnCallRoster always throws; M19 shift-sync permanently degraded, creates no shifts                                            | `seams/drizzle-store.ts:294-299` throws unconditionally; `jobs/reconcile.ts:17-26` every call resolves unavailable; M19 spec:46                                                                                                            | P1       | Yes      | Add M17 on-call source (or move to M19) and implement reader, or amend specs                                                                                  |
| M19          | Write path                           | GAP-115: identify-patient takes unvalidated ids and can re-point a call in any state with no history or event                                                                     | `write-service-drizzle.ts:587-609` applyCallPatch                                                                                                                                                                                            | P2       | No       | Add lifecycle decision, validate via M5/M6, append history, emit event                                                                                        |
| M19          | Clinical flows                       | GAP-116: Verbal-order step-up and M11 recordVerbalOrder never invoked; deferred M8 encounter links have no retry worker                                                           | `clinical/verbal-order.ts:185-200` no production caller; `write-service-drizzle.ts:949-962` `.catch(() => undefined)`                                                                                                                    | P2       | Yes      | Route through recordTriageVerbalOrder; add retry worker                                                                                                       |
| M20          | Lone-worker check-in                 | GAP-030: POST /safety/check-ins closes any clinician's schedule row                                                                                                               | `write-service-drizzle.ts:637-650` UPDATE ... WHERE id = input.scheduleId AND organization_id; no clinician_membership_id predicate                                                                                                          | P1       | Yes      | Add owner and state predicates; 404/403 on zero rows; live test                                                                                               |
| M20          | SOS cancel                           | GAP-031: Cancel biometric requirement satisfied by any non-empty biometricVerificationToken                                                                                       | `:962-965` `biometricResult: input.biometricVerificationToken !== undefined ? "passed" : null`                                                                                                                                             | P1       | Yes      | Verify server-side; treat unverifiable as failed                                                                                                              |
| M20          | SOS escalation                       | GAP-032: Ladder never reaches or executes emergency terminus                                                                                                                      | `cron-workers.ts:36-52` tier-3 -> terminus refused; `effects-runner.ts:120-125` CALLER_OWNED_EFFECT_KINDS never executed                                                                                                                   | P1       | Yes      | Implement terminus effects or critical page-ops alert; live test                                                                                              |
| M20          | M20-M17 seam                         | GAP-117: SOS lastKnownVisitId client-supplied, drives cross-module visit cancellation                                                                                             | `write-service-drizzle.ts:839`; `17-scheduling/outbox-consumers/m20-safety-visit-cancellation.ts:100-140` no assignee check                                                                                                                | P2       | No       | Resolve visit server-side; verify in M17 consumer                                                                                                             |
| M20          | Stubs                                | GAP-118: High-risk-area evaluator and location-stream writer unbuilt; queues absent                                                                                               | `seams/consumed.ts:28-35`; no code inserts into safety_sos_location_stream                                                                                                                                                                   | P2       | No       | Build evaluator, sampler, dek-rotation                                                                                                                        |
| M21          | Supply request                       | GAP-119: createSupplyRequest persists body patientId without checking against admission's patient                                                                                 | `write-service-drizzle.ts:606-636` `patientId: input.patientId`; `0104_...sql:42-43` no FK                                                                                                                                               | P2       | Yes      | Derive patientId from admission; verify sourceOrderId                                                                                                         |
| M21          | Read audit (M21-M25)                 | GAP-120: Single-record PHI reads carry no patient attribution                                                                                                                     | `supply-requests.routes.ts:98-103`, `comfort-kits.routes.ts:87-92`; `drizzle-audit-query.ts:63-68` touchesPatient                                                                                                                        | P2       | No       | Add patientIdPayloadPath to configs                                                                                                                           |
| M21          | RLS tests                            | GAP-235: RLS suites omit some owned tables (M21-M23)                                                                                                                              | M21 missing supply_request_pharmacy_dispense; M22 missing intake_batch_relink, intake_records_request, intake_records_request_fax; M23 missing hospice_rate_table, tenant_wage_index, transfer_notice_record, unmapped_taxonomy_occurrence     | P3       | No       | Add eight tables to suites                                                                                                                                    |
| M21          | Cron                                 | GAP-236: m21.invoice_reconciliation hourly cron not built                                                                                                                         | `jobs/queues.ts:3` omitted; spec §4.6                                                                                                                                                                                                       | P3       | No       | Build reconciler or amend spec                                                                                                                                |
| M22          | PDF rendering                        | GAP-033: 44 of 50 platform templates render a non-PDF stand-in (JSON behind %PDF header)                                                                                          | `seams/renderer.ts:432-446` standInBytes/renderBytes fallback; `render-pdf/registry.ts:20-28` six builders; `renderer.ts:52` 50 keys                                                                                                     | P1       | Yes      | Register builders for all templates or fail closed; test every key                                                                                            |
| M22          | Routes                               | GAP-121: PHI bundle export fails closed (503) and template-version publish returns 501                                                                                            | `documents-route-service-db.ts:786-794` DegradedError; `:1192-1199` NOT_IMPLEMENTED 501                                                                                                                                                    | P2       | Yes      | Build bundle pipeline and publish path or remove routes                                                                                                       |
| M22          | Critical lane (D22)                  | GAP-122: forms-render-critical lane, CRITICAL RESULT watermark, rendered_critical_results not implemented                                                                         | grep finds only`events-by-m11.ts:499` declaredConsumers: []; spec :601, :732                                                                                                                                                                 | P2       | No       | Add critical lane or amend spec                                                                                                                               |
| M22          | ABAC                                 | GAP-123: document_within_admission_window registered but composed on no read route                                                                                                | `abac-uncomposed-allowlist.ts:16-17` 'Open gap'                                                                                                                                                                                              | P2       | No       | Compose on read routes or delete                                                                                                                              |
| M22          | Read audit                           | GAP-237: Content-download audit labels a version id as resourceKind 'document'                                                                                                    | `documents-routes.ts:306` vs `:292`, `:327` 'document_version'                                                                                                                                                                           | P3       | Yes      | Use 'document_version'                                                                                                                                        |
| M23          | Eligibility read audit               | GAP-034: Two PHI eligibility reads leave no read-audit trail                                                                                                                      | `eligibility.routes.ts:83`, `:95` `auditRead: { resourceKind: "eligibility_check" }` no resourceIdParam; `read-audit.ts:204-205`; `audit-events.ts:29` uuid                                                                          | P1       | Yes      | Add patientIdQueryParam or resourceIdParam; live assertion                                                                                                    |
| M23          | Alert rules (M23/M25/M26/M27/M36)    | GAP-035: Cron alert codes have no platform alert_rule; alerts persisted with zero recipients (incl. NOE/NOTR breach)                                                              | `alert-emitter-impl.ts:80-92` no rule -> recipientCount 0; `alert-rules.ts:657` only noe/notr.rejected seeded                                                                                                                              | P1       | Yes      | Seed rule per code; boot/arch gate for unseeded eventTypes                                                                                                    |
| M23          | Provider-entity scope                | GAP-124: Provider-entity scoping missing on NOE/NOTR/transfer lists, MAC list, AR dashboard and metrics                                                                           | `noe.routes.ts:51-53`, `notr.routes.ts:51-53`, `metrics.routes.ts:25-51`; contrast `claims.routes.ts:207-225`                                                                                                                          | P2       | Yes      | Apply server-derived PE scope to the list/aggregate reads                                                                                                     |
| M23          | Document back-ref                    | GAP-125: M23, M24, M25 never consume m22.document.rendered; back-reference columns never populated                                                                                | `events-by-m22.ts:88` declaredConsumers omit m23/m24/m25; handlers have no caller                                                                                                                                                            | P2       | No       | Bind three consumers; add to declaredConsumers                                                                                                                |
| M23          | ClaimReader                          | GAP-126: ClaimReader unregistered; M24 Medicare-primary context and M28 Claim projection have no source                                                                           | `registry.ts:600`; `m24-medicare-primary-ack.ts:14-19`; `28-fhir/seams/consumed.ts:221-222`                                                                                                                                              | P2       | No       | Publish ClaimReader; call await_medicare_primary                                                                                                              |
| M23          | Cap projection                       | GAP-127: Cap-projection path ignores CCN and picks first period by capYear                                                                                                        | `cap-projection-adapter.ts:~67`; `seam-impls.ts:79-80` `periods.find((p) => p.capYear === capYear)`                                                                                                                                      | P2       | Yes      | Thread providerEntityId/CCN through provider                                                                                                                  |
| M23          | Platform rules                       | GAP-238: POST /admin/billing/platform-rules permanent 501                                                                                                                         | `platform-admin-service.ts:109-121` PLATFORM_RULES_ARE_CODE_DEFINED 501                                                                                                                                                                      | P3       | No       | Build store/DSL or remove route                                                                                                                               |
| M23          | M26 bindings                         | GAP-239: M26 replaced/voided bindings inert; projection_updated revalidate consumer is deny-stub                                                                                  | `subscription-map.ts:310-318` deny_stub; `handlers.ts:560-566` ForwardSeamNotLandedError                                                                                                                                                   | P3       | No       | Widen payloads or drop; flip subscription                                                                                                                     |
| M23          | Stale TODOs                          | GAP-240: Stale TODO(boot-wiring) says DataClass union lacks billing_record etc.                                                                                                   | `billing-eraser.ts:643-646`; `packages/types/src/seams.ts:1766,1769,1772`                                                                                                                                                                  | P3       | No       | Remove stale items                                                                                                                                            |
| M24          | Provider-entity scope                | GAP-128: Several M24 reads org-wide                                                                                                                                               | `read-service-drizzle.ts:545-590`, `:426-451`, `:455-470`, `:285-301`, `:308-380`, `:510-540`; `guards.ts:74` ABAC_QUERY_PE never used                                                                                           | P2       | No       | Pass PE ids through peScope; delete or use ABAC_QUERY_PE                                                                                                      |
| M24          | ABAC                                 | GAP-129: medicaid_claim_in_billing_manager_caseload checks only PE scope                                                                                                          | `abac-predicates.ts:166-174`; spec :1717-1727; M23 `abac-predicates.ts:134-143`                                                                                                                                                            | P2       | No       | Add CaseloadProvider axis                                                                                                                                     |
| M24          | AR dashboard                         | GAP-130: Medicaid AR dashboard/metrics return hard-coded empty/zero                                                                                                               | `read-service-drizzle.ts:561` `buckets: []`, `:562` `chargesCents: 0`, `:588` `aging: []`                                                                                                                                          | P2       | No       | Compute from claim rows                                                                                                                                       |
| M24          | Read audit                           | GAP-131: Waiver on R&B arrangement routes says 'no patient data' but payload is patient-bound                                                                                     | `rb.routes.ts:60-67`, `:84-86`; `read-service-drizzle.ts:103-119`                                                                                                                                                                        | P2       | No       | Replace waiver with emission config                                                                                                                           |
| M24          | Ack-pull cron                        | GAP-132: medicaid-ack-pull declared but no worker/schedule constructed                                                                                                            | `jobs/queues.ts:13,21,31`; spec :413, :1782, :2263                                                                                                                                                                                           | P2       | No       | Construct Worker + schedule or amend spec                                                                                                                     |
| M24          | Events                               | GAP-133: Catalogued events with no emit site (submission_stalled, replaced, voided, awaiting_medicare_primary, acknowledgment_partial, refresh_requested, mco_assignment_changed) | `events-by-m24.ts:167,295,311,80,205,344,384` only in catalog                                                                                                                                                                                | P2       | No       | Emit stalled+alert on exhaustion; emit others or remove                                                                                                       |
| M25          | Appeal packet                        | GAP-036: Appeal packet render request carries empty payload; AppealPacketRenderPayload does not exist                                                                             | `write-service-drizzle.ts:335-340` `payload: {}`; M25 spec:86                                                                                                                                                                              | P1       | Yes      | Define payload type, populate at submit, add appeal_packet builder                                                                                            |
| M25          | manual_match ABAC                    | GAP-134: remittance.manual_match composes claim_assigned_to_actor against remittance line id; non-oversight roles always denied                                                   | `remittance.routes.ts:23,130`; `guards.ts:17-19`; `abac-predicates.ts:176-185`                                                                                                                                                           | P2       | Yes      | Target without denialCaseId or PE-scope guard; route test                                                                                                     |
| M25          | close-write-off                      | GAP-135: Emits fabricated m25.patient_responsibility.recorded and records no ledger row                                                                                           | `write-service-drizzle.ts:218-223` `ledgerId: id, patientId: id, prAmount: "0.00"`                                                                                                                                                         | P2       | No       | Write ledger and emit real values, or don't emit                                                                                                              |
| M25          | Documented reasons                   | GAP-136: Mandatory reasons for escalate/resolve/reopen/withdraw/decide validated then discarded                                                                                   | `:154`, `:158`, `:227`, `:466` take `_input` unread                                                                                                                                                                                  | P2       | No       | Persist reason on each transition                                                                                                                             |
| M25          | Appeal documents                     | GAP-137: Attached appeal document ids client-supplied and never validated                                                                                                         | `:289-303` attachAppealDocument sets appeal_packet_document_id from body                                                                                                                                                                     | P2       | No       | Validate via M22 DocumentReader seam                                                                                                                          |
| M25          | M25-M26                              | GAP-138: Paid 835 line whose claim lacks DTM service dates silently dropped from cap accrual                                                                                      | `ingest/service-drizzle.ts:225-226`; `26-cap/consumers/handlers.ts:41-60`                                                                                                                                                                  | P2       | No       | Fall back to M23 claim dates; surface refusals                                                                                                                |
| M26          | Projection                           | GAP-037: No code writes per-patient (patient_aggregate) snapshots; patient projection seam dead                                                                                   | `write-service-drizzle.ts:263-345` persists only agency_aggregate/inpatient; `seam-impls.ts:75-90` fabricates 'safe', 0%                                                                                                                   | P1       | Yes      | Iterate accrual rows in recompute; return null when absent                                                                                                    |
| M26          | Inpatient cap                        | GAP-038: cap_inpatient_accrual.total_patient_days never written; utilisation always 0%                                                                                            | `consumers/drizzle-store.ts:262-281` upserts only gipDays/ircDays/lastUpdatedAt; `accrual.ts:121` default 0                                                                                                                                | P1       | Yes      | Source patient-day denominator; supply RHC differential                                                                                                       |
| M26          | Lifecycle                            | GAP-039: Methodology-lock deadlock: first projection flips open->active, methodology can never be set, settlement never proposable                                                | `abac-predicates.ts:86-89`; `write-service-drizzle.ts:~437-442` throws METHODOLOGY_UNSET                                                                                                                                                   | P1       | Yes      | Require methodology at open or allow lock until first accrual; escape path                                                                                    |
| M26          | Alerts                               | GAP-040: Threshold-crossing cap alerts never delivered                                                                                                                            | `events-by-m26.ts:55-60` declaredConsumers []; `seam-impls.ts:232-234` listSubscribers() returns []                                                                                                                                        | P1       | Yes      | Add M36 consumer/worker; build or retire evaluator and refresh workers                                                                                        |
| M26          | Alerts (M26/M36)                     | GAP-041: Band escalation never alerts; nightly projection and year-close crons publish to NOOP                                                                                    | `jobs/index.ts:91` `buildDrizzleM26WriteService(db)` no outbox; spec :424, :1660                                                                                                                                                           | P1       | Yes      | Pass m26OutboxPublisher; dispatch alert on band transition; record computedBy                                                                                 |
| M26          | Settlement                           | GAP-139: Finalize skips PS&R-variance block, drops attestation, records user id as step-up id                                                                                     | `:520` `stepUpSessionId: actor.userId`, `:197`                                                                                                                                                                                           | P2       | No       | 409 on unresolved lines; persist attestation; stamp real step-up id                                                                                           |
| M26          | Audit                                | GAP-140: Reopen ignores reason, not flagged high; no application audit events; triggers hard-code 'info'                                                                          | `reopenPeriod(actor, periodId, _input)`; `0090_...sql` severity 'info'                                                                                                                                                                     | P2       | No       | Persist reason; emit high-severity audit                                                                                                                      |
| M26          | Authorization                        | GAP-141: POST /cap/periods accepts methodology with no step-up and no lock row                                                                                                    | `cap.routes.ts:64-70` PERIOD_MANAGE + IDEMPOTENT only                                                                                                                                                                                        | P2       | No       | Drop methodology from open or route through lockMethodology                                                                                                   |
| M26          | PS&R                                 | GAP-142: PS&R import performs no CCN validation; period CCN is 000000 sentinel for multi-entity orgs                                                                              | grep -i ccn in psr: no header check                                                                                                                                                                                                            | P2       | Yes      | Validate CCN via M40; per-PE periods                                                                                                                          |
| M26          | Consumers                            | GAP-143: claim.replaced/voided bound but inert                                                                                                                                    | `events-by-m23.ts:305-320` payload lacks fields; `handlers.ts:90-103` returns {recorded:false}                                                                                                                                             | P2       | No       | Widen M23 payloads or resolve by originalClaimId                                                                                                              |
| M26          | Workers                              | GAP-144: Cron fan-out lacks per-org isolation; nightly snapshots mislabelled manual_recompute                                                                                     | `jobs/index.ts:134-170`; `write-service-drizzle.ts:644`                                                                                                                                                                                    | P2       | No       | Child jobs per (org, period); pass compute basis                                                                                                              |
| M26          | Queues                               | GAP-145: platformConstantRefresh and thresholdEvaluator queues declared, never constructed                                                                                        | `jobs/queues.ts:14,17,27,50-72`                                                                                                                                                                                                              | P2       | No       | Build worker or delete queue and amend spec                                                                                                                   |
| M26          | Cap UI (web)                         | GAP-146: Cap UI read-only: no PS&R, methodology, recompute or settlement actions                                                                                                  | SCREEN_SPEC_STATUS: CAP_MANAGEMENT 'built ... read views only (no cap write is wired in the SPA)'                                                                                                                                              | P2       | No       | Wire writes or re-label 'partial'                                                                                                                             |
| M26          | Published seams                      | GAP-147: Four of six M26 published seams built but unregistered                                                                                                                   | `wiring.ts:19-20` registers only CapAccrualReader and CapProjectionProvider; spec :18, :70                                                                                                                                                   | P2       | No       | Register and bind consumers, or retire                                                                                                                        |
| M26          | PHI scope                            | GAP-241: Per-patient cap PHI routes compose no caseload_or_scope                                                                                                                  | `cap.routes.ts:196-215`, `:175-194` vs `claims.routes.ts:13`                                                                                                                                                                             | P3       | No       | Compose scope or document waiver                                                                                                                              |
| M26          | PS&R resolve                         | GAP-242: Resolve route ignores :importId                                                                                                                                          | `psr.routes.ts:75-84`; `write-service-drizzle.ts:393-408`                                                                                                                                                                                  | P3       | No       | Include psrImportId in WHERE                                                                                                                                  |
| M27          | Jobs                                 | GAP-042: Refresh/allocate/stats/tb/wage re-triggers silently dropped: constant BullMQ jobIds retained                                                                             | `wiring.ts:132,140-141` jobId=queue__dedupeKey, removeOnFail:false; `addStandardJob-9.lua:90-93`                                                                                                                                           | P1       | Yes      | Add day bucket/hash/request id to jobId or remove-on-complete/fail                                                                                            |
| M27          | Submission                           | GAP-148: Past-deadline filing block not implemented: submit and submit-past-deadline same path, reason discarded                                                                  | `write-service-drizzle.ts:1164-1167` `submitPastDeadline(actor, id, {reason: ''})`                                                                                                                                                         | P2       | No       | Guard submit; require and persist reason                                                                                                                      |
| M27          | Integrations                         | GAP-149: Live Xero trial-balance and Gusto wage pulls unbound; every pull job fails                                                                                               | `index.ts:6153-6210` no trialBalanceSeam/wageDataSeam/dek; `m27-jobs.ts:331-364` unboundWorkerPort                                                                                                                                         | P2       | No       | Bind clients with OAuth storage or demote to manual import                                                                                                    |
| M27          | Consumers                            | GAP-150: W-CR-08 and W-CR-12 have handlers but no binding or producing event                                                                                                      | `subscription-map.ts:14-22`; `index.ts:9472-9476`; no m40.provider_entity.offboarded producer                                                                                                                                              | P2       | No       | Bind consumer, introduce M40 event, or amend spec                                                                                                             |
| M27          | Cost report (web)                    | GAP-151: Workspace cannot map accounts, generate/track ECR, reopen, return to draft or request extensions                                                                         | `cost-report-api.ts:64-156`; 15 of 29 mutating ops uncalled                                                                                                                                                                                  | P2       | No       | Add surfaces or record deferral                                                                                                                               |
| M27          | Audit                                | GAP-243: Reopen creates no snapshot-chain link; financial reads declare no read-audit                                                                                             | `write-service-drizzle.ts:1337-1365`; grep auditRead in routes: 0 matches                                                                                                                                                                    | P3       | No       | Create link; add auditRead and prefix                                                                                                                         |
| M27          | ABAC                                 | GAP-244: cost_report_period_active never composed; arch:abac-composed passes on unused wrapper                                                                                    | `routes/guards.ts:57` PERIOD_ACTIVE only definition                                                                                                                                                                                          | P3       | Yes      | Compose or allowlist; require use site                                                                                                                        |
| M28          | Inbound                              | GAP-152: Inbound FHIR staging has no wire validation and no idempotency                                                                                                           | `fhir-r4.routes.ts:831-846`; `0136_...sql:52` plain CREATE INDEX                                                                                                                                                                           | P2       | No       | Validate per type; make dedup unique                                                                                                                          |
| M28          | Inbound                              | GAP-153: Accept pins reviewer-supplied acceptedAggregateId; no M5/M12 callback                                                                                                    | `m28-typebox.ts:143-147`; `admin-inbound.routes.ts:52-67`                                                                                                                                                                                  | P2       | No       | Implement apply flow minting id server-side                                                                                                                   |
| M28          | Terminology                          | GAP-154: CodeSystem/ValueSet read are 404 stubs; $expand returns empty expansion                                                                                                  | `fhir-r4.routes.ts:813-828` `expansion:{total:0, contains:[]}`                                                                                                                                                                             | P2       | No       | Implement via M38 or answer not-supported                                                                                                                     |
| M28          | Gateway UI                           | GAP-155: FHIR client management and M29 feed operations (68 ops) have no UI                                                                                                       | 35 of 35 M28 and 33 of 33 M29 operations uncalled; SCREEN_SPEC_STATUS deferred                                                                                                                                                                 | P2       | No       | Accept as documented deferral or schedule                                                                                                                     |
| M29          | Operations                           | GAP-043: Listener-down detection and feed health not implemented                                                                                                                  | evaluateListenerCircuit only definition and re-export; external_feed_health no INSERT/UPDATE                                                                                                                                                   | P1       | Yes      | Health prober emitting listener_down/recovered                                                                                                                |
| M29          | PHI audit                            | GAP-044: Lab observation and inbound-proposal GETs outside DEFAULT_READ_AUDIT_PREFIXES, no auditRead                                                                              | `bootstrap/index.ts:120-230`; `labs.routes.ts:37,59,78`, `proposal.routes.ts:31,54`                                                                                                                                                      | P1       | Yes      | Add auditRead to every M29 GET and prefixes                                                                                                                   |
| M29          | PHI audit                            | GAP-045: Lab-result reads emit no PHI read-audit and sit outside coverage gate                                                                                                    | `labs.routes.ts:37-56,59-76,78-93`; `read-audit.ts:138`                                                                                                                                                                                    | P1       | Yes      | Add config.auditRead to three routes and '/api/clinical' prefix                                                                                               |
| M29          | Messages                             | GAP-156: POST /messages/inbound/:id/decrypt hard-coded 501 though cipher exists                                                                                                   | `message.routes.ts:65-86`; `inbound-crypto.ts:42-70`                                                                                                                                                                                       | P2       | No       | Decrypt via cipher, write disclosure event, rate limit                                                                                                        |
| M29          | Proposals                            | GAP-157: Partial-field accept (W-XI-03) unreachable                                                                                                                               | `m29-typebox.ts:191-195`; `store-drizzle.ts:673-679`                                                                                                                                                                                       | P2       | No       | Accept appliedFields; set partially_applied                                                                                                                   |
| M29          | Retention                            | GAP-158: Data eraser still Phase-0 deny-stub                                                                                                                                      | `erasers/registry.ts:218-227`                                                                                                                                                                                                                | P2       | No       | Implement and register eraser                                                                                                                                 |
| M29          | Workers                              | GAP-245: Inbound pipeline is poll worker, not spec'd BullMQ queues                                                                                                                | `index.ts:8311-8350` FOR UPDATE SKIP LOCKED                                                                                                                                                                                                  | P3       | No       | Build queues or amend spec 4.9                                                                                                                                |
| M30          | Governance                           | GAP-046: PIP/SRA close is nominee-based one-step; second role-holder never attests; 0335 relaxed V-11/V-12                                                                        | `close-cosign.ts:9-13`; `0335_m30_closure_nominee_marker.sql`; prior GAP-088                                                                                                                                                               | P1       | Yes      | Pending-close + nominee confirmation in own step-up session; restore DB check                                                                                 |
| M30          | Jobs                                 | GAP-047: R-04 recompute and R-96 risk-register refresh ignored after first run                                                                                                    | `write-service-drizzle.ts:722-735`, `:1999-2005`; `wiring.ts:108-118`                                                                                                                                                                    | P1       | Yes      | Include period/version/date bucket in jobId                                                                                                                   |
| M30          | Quality UI (web)                     | GAP-048: Quality UI read-only apart from mortality review                                                                                                                         | `screens.ts:21,29,37`; 31 of 36 mutating /quality/* ops have no caller                                                                                                                                                                       | P1       | Yes      | Build incident/SRA/CAHPS/infection/QAPI writes or mark specs 'partial'                                                                                        |
| M30          | Alerts (M30/M36)                     | GAP-049: No M36 consumer or direct emit for any m30.* event                                                                                                                       | `events-by-m30.ts` all 21 `declaredConsumers: []`; `write-service-drizzle.ts:1537`                                                                                                                                                       | P1       | Yes      | Add M36 bindings and sweeps; set declaredConsumers truthfully                                                                                                 |
| M30          | SRA export                           | GAP-160: R-48 SRA NIST 800-66r2 export not implemented                                                                                                                            | `sra.routes.ts:27-30,81`                                                                                                                                                                                                                     | P2       | No       | Wire export or amend spec                                                                                                                                     |
| M30          | CAHPS                                | GAP-161: CAHPS result ingest (R-16) unreachable: quality.cahps.system granted to no role                                                                                          | `cahps.routes.ts:190-200`; `authenticate.ts:126-134`                                                                                                                                                                                       | P2       | No       | Add vendor service-principal path or internal ingest                                                                                                          |
| M30          | Measures                             | GAP-162: Per-PE measure rows computed from org-wide inputs                                                                                                                        | `m30-jobs.ts:909-912` 'the value is repeated per PE row'                                                                                                                                                                                     | P2       | No       | Add providerEntityId filter or write one row per org                                                                                                          |
| M31          | Portal ABAC                          | GAP-050: Suspended portal account keeps full PHI access                                                                                                                           | `abac-predicates.ts:315-329`; `store.ts:554-578` suspendAccount updates status only; `events-by-m31.ts:44-53`                                                                                                                            | P1       | Yes      | Require portal_account_active in predicate and/or revoke sessions on suspend                                                                                  |
| M31          | Telehealth                           | GAP-051: Vendor adapter never bound; join and start-recording 503, webhooks always 401                                                                                            | `telehealth.routes.ts:35-51` NOOP_ADAPTER; `:178`, `:319-320`; `index.ts:4846-4851`                                                                                                                                                    | P1       | Yes      | Bind Daily.co adapter with per-tenant key store                                                                                                               |
| M31          | Disclosure accounting                | GAP-052: PortalDisclosureAccountingProvider returns empty list; no access-log route (164.528)                                                                                     | `store.ts:483-489` `disclosuresForPatient(): Promise<...> { return []; }`                                                                                                                                                                  | P1       | Yes      | Implement over audit_event/document_access_log; add route + export                                                                                            |
| M31          | Portal (portal)                      | GAP-053: 'Video visit' renders static placeholder; no vendor SDK mounted                                                                                                          | `telehealth-waiting-room.tsx:77-79` 'The vendor SDK mounts here in the running app'                                                                                                                                                          | P1       | Yes      | Mount SDK via telehealth-client or mark deferred                                                                                                              |
| M31          | Staff UI (web)                       | GAP-054: No staff UI for telehealth or M31 portal-admin pane                                                                                                                      | grep of screens.ts finds none; no caller for /admin/portal-accounts*, /telehealth/visits/...                                                                                                                                                   | P1       | Yes      | Add screens or record deferral                                                                                                                                |
| M31          | Telehealth webhooks                  | GAP-163: Webhooks verify then discard body; signature over re-serialised JSON                                                                                                     | `telehealth.routes.ts:434-440` `raw = JSON.stringify(request.body)`                                                                                                                                                                        | P2       | Yes      | Capture raw body, map events, build recording finalize                                                                                                        |
| M31          | Telehealth recording                 | GAP-164: halt-recording only flips DB flag; vendor recording keeps running                                                                                                        | `admin.routes.ts:329-345`; contrast `telehealth.routes.ts:333-368`                                                                                                                                                                         | P2       | No       | Reuse stop-recording vendor path                                                                                                                              |
| M31          | Account lifecycle                    | GAP-165: suspend/reinstate unconditional; revoked rows hit CHECK and 500                                                                                                          | `store.ts:554-593`; `0138_...sql:62`                                                                                                                                                                                                       | P2       | No       | Guard transitions; 404/409                                                                                                                                    |
| M31          | Portal writes                        | GAP-166: Post-discharge read-only gate fails open on any M6 error                                                                                                                 | `write.routes.ts:166-178` `catch { return false }`                                                                                                                                                                                         | P2       | Yes      | Fail closed (503)                                                                                                                                             |
| M31          | Outbox consumers                     | GAP-167: All 22 m31.* events record-only                                                                                                                                          | `events-by-m31.ts` every entry `declaredConsumers: []`                                                                                                                                                                                     | P2       | No       | Bind M36 removal and M2 revocation                                                                                                                            |
| M31          | PHI read audit                       | GAP-168: Single-resource PHI reads declare auditRead without resourceIdParam                                                                                                      | `session.routes.ts:116`, `:143`; `admin.routes.ts:320`                                                                                                                                                                                   | P2       | No       | Add resourceIdParam/patientIdPayloadPath; live assertion                                                                                                      |
| M31          | RLS tests                            | GAP-169: RLS suite omits portal_invitation, portal_document_upload, portal_notification_preference                                                                                | `m31-rls-isolation.live.test.ts` references three of six tables                                                                                                                                                                              | P2       | No       | Extend suite                                                                                                                                                  |
| M31          | Jobs                                 | GAP-170: Recording lifecycle unbuilt; four spec queues missing with stale justification                                                                                           | `jobs/queues.ts:10-24`; `m31-portal-deferrals.md` vs migrations 0423, 0424                                                                                                                                                                 | P2       | No       | Build sweep and finalize path; correct deferral text                                                                                                          |
| M31          | Routes drift                         | GAP-246: Invitation list org-wide; fabricated invitedAt; 200 not_found; synthetic smart session id; grief-resources maps all errors to 501                                        | `invitations.ts:334-350`; `admin.routes.ts:238`; `store.ts:476-481`; `read.routes.ts:419-434`                                                                                                                                          | P3       | Yes      | Tidy; return 404/409                                                                                                                                          |
| M32          | PHI read audit                       | GAP-055: R16/R17 invocation reads leave no read-audit row                                                                                                                         | `invocations.routes.ts:46-49` INVOCATION_PHI no list/resourceIdParam; `read-audit.ts:195-209`                                                                                                                                              | P1       | Yes      | R16 list:true; R17 resourceIdParam; live test                                                                                                                 |
| M32          | Jobs                                 | GAP-171: Five of seven spec 4.8 queues have no worker or producer                                                                                                                 | `jobs/` contains only token-ledger-rollup.ts and triage-followup-worker.ts                                                                                                                                                                   | P2       | No       | Build drift sweep, evaluation, kill-switch workers or document                                                                                                |
| M32          | Evaluation                           | GAP-172: Evaluation runs can never leave 'pending'                                                                                                                                | `safety/service.ts:473` transitionAiEvaluationRun no non-test caller                                                                                                                                                                         | P2       | No       | Add evaluations worker; don't accept caller metrics as evidence                                                                                               |
| M32          | Routes                               | GAP-173: Unbound ports make R10 and R18 unusable                                                                                                                                  | `index.ts:5049` createDenyingAiOptInEvidenceResolver(); `:5077` cipher: null                                                                                                                                                               | P2       | No       | Bind tenant-DEK cipher and resolvers                                                                                                                          |
| M33          | Drilldown                            | GAP-056: POST /reporting/drilldown/emit and flush worker always fail: no envelope encryption port bound                                                                           | `wiring.ts:568-577`; `export-drilldown-service.ts:479-488` DrilldownDekUnavailable                                                                                                                                                         | P1       | Yes      | Bind drilldownEncryption over getTenantKeyProvider().dekForOrg                                                                                                |
| M33          | Drilldown                            | GAP-174: Consent narrowing trusts client patientIds cohort                                                                                                                        | `drilldown.routes.ts:68-80`; `consent-narrowing.ts:107-109`                                                                                                                                                                                | P2       | No       | Derive cohort server-side                                                                                                                                     |
| M33          | Reporting (web)                      | GAP-175: No report definitions, saved views, sharing or exports in UI                                                                                                             | `screens.ts` registers only five screens; 17 of 22 mutating ops uncalled                                                                                                                                                                     | P2       | No       | Build or downgrade status                                                                                                                                     |
| M33          | Data substrate (M33/M26/M30)         | GAP-176: Only three MVs exist; MetricsProvider read by no module                                                                                                                  | `grep -h 'CREATE MATERIALIZED VIEW'` returns only report_mv.mv_census_org_daily, mv_encounter_productivity_membership_day, mv_evv_compliance_org_week                                                                                        | P2       | Yes      | Add MVs/bases or record tiles as unbuilt                                                                                                                      |
| M33          | Jobs/docs                            | GAP-247: tile_warm_cache has no worker; stale FAIL_CLOSED comments                                                                                                                | `m33-jobs.ts:301-304,1120-1121`; `:1122` vs `wiring.ts:312-358`                                                                                                                                                                          | P3       | No       | Build or drop; refresh comments                                                                                                                               |
| M33          | Queues                               | GAP-248: tileWarmCache and tenantEraser queues declared with no worker                                                                                                            | `jobs/index.ts:62,68,78,81,132,159`; spec :1119, :1122, :1157                                                                                                                                                                                | P3       | No       | Remove from catalog or build                                                                                                                                  |
| M34          | Alert resolvers                      | GAP-057: M34 alert resolvers never registered; tenant-lifecycle/security rules unseeded                                                                                           | `alert-rules.ts:437-440` 'registerM34AlertResolvers is written but NOTHING CALLS IT'; `index.ts:5349-5363`                                                                                                                                 | P1       | Yes      | Bind ports, register resolvers, seed all rules, live suite                                                                                                    |
| M34          | ABAC                                 | GAP-177: DSAR job routes cannot use caseload arm; only org_admin passes                                                                                                           | `dsar-export-jobs.ts:46-62`; `abac-predicates.ts:178-188`                                                                                                                                                                                  | P2       | No       | Resolve job's patient via getTarget                                                                                                                           |
| M34          | Support access                       | GAP-178: Support-consent grant issuance doesn't enforce grantor = compliance_officer                                                                                              | `support-consent-grants.ts:50-52`; `service-drizzle.ts:100-126`                                                                                                                                                                            | P2       | No       | Add role predicate or in-service check                                                                                                                        |
| M34          | Events (M34/M27/M39/M25/M1)          | GAP-179: Catalogued events never emitted (dek_rotation_due, integrity_failure, renewal_cycle_opened, dpoa agent events, remittance.parsed, feature_flag.updated)                  | `events-by-m34.ts:232`; `events-by-m27.ts:474`; `events-by-m39.ts:158,232,259`; `events-by-m25.ts:66`; `events-by-m1.ts:32`                                                                                                          | P2       | Yes      | Add emit-site coverage gate; emit or remove                                                                                                                   |
| M34          | Admin app                            | GAP-180: Platform ops cannot create/revoke invitations, offboard, elevate, approve exports, fulfil DSAR, revoke promos, cancel/resume from any SPA                                | `apps/admin/src/modules/34-saas-platform/screens.ts` 10 screens, none cover these                                                                                                                                                            | P2       | No       | Add actions or document API-only                                                                                                                              |
| M34          | Read audit                           | GAP-249: GET /tenant/account auditRead has no resourceIdParam                                                                                                                     | `account-flags-routes.ts:43`                                                                                                                                                                                                                 | P3       | Yes      | Add resourceIdParam or waive                                                                                                                                  |
| M35          | Stripe                               | GAP-058: Transport unbound: webhook always 503, no outbound dispatcher                                                                                                            | `index.ts:4395-4423`; `webhooks.routes.ts:43-49` STRIPE_WEBHOOK_UNCONFIGURED; `service-drizzle.ts:890-899`                                                                                                                               | P1       | Yes      | Bind ingest with raw-body parser; run dispatcher                                                                                                              |
| M35          | Jobs                                 | GAP-059: No M35 workers exist (dunning, usage, posting, reconciler, snapshot, expiry watch)                                                                                       | `35-subscription` has no jobs/ directory                                                                                                                                                                                                     | P1       | Yes      | Build and register worker set                                                                                                                                 |
| M35          | Payment methods                      | GAP-060: attach trusts client stripePaymentMethodId; createSubscription accepts any paymentMethodId                                                                               | `service-drizzle.ts:901-944`, `:648-690`; `0141_...sql:35`, `:90`                                                                                                                                                                      | P1       | Yes      | Verify against completed SetupIntent; validate org ownership                                                                                                  |
| M35          | Refunds                              | GAP-061: Refund request has no cap/invoice validation; approved refunds never executed                                                                                            | `service-drizzle.ts:1426-1462`, `:1464-1498`; `events-by-m35.ts:381,397` no emitter                                                                                                                                                      | P1       | Yes      | Enforce amount <= paid minus prior; wire execution                                                                                                            |
| M35          | Seams                                | GAP-181: All six M35 published seams deny-stubs; usage_event has no production writer                                                                                             | `registry.ts:625-660`; no insert into usage_event                                                                                                                                                                                            | P2       | Yes      | Register Drizzle impls; bind UsageMeteringIngest                                                                                                              |
| M35          | Promos                               | GAP-182: Tenant promo self-apply has no 'publicly-visible' restriction                                                                                                            | `0140_...sql:93-109`; `promo-redemption.ts:76-92`                                                                                                                                                                                          | P2       | No       | Add public flag and require on tenant path                                                                                                                    |
| M36          | Transports                           | GAP-062: No vendor transport bound: every push/SMS/voice/email delivery settles failed                                                                                            | `index.ts:7589-7601` `transports: createDenyTransports()`; spec :60                                                                                                                                                                        | P1       | Yes      | Implement and bind real transports; live suite; boot warning                                                                                                  |
| M36          | Endpoint verification                | GAP-063: Verification code generated but never delivered; endpoints never verified                                                                                                | `messaging-route-service-db.ts:272`, `:851`; `0355_...sql:74`                                                                                                                                                                            | P1       | Yes      | Bind sendEndpointVerificationCode; 503 when no sender                                                                                                         |
| M36          | Read audit                           | GAP-064: Message history and alert inbox reads emit no read-audit; prefixes outside gate                                                                                          | grep auditRead in 36-messaging returns nothing; spec lines 98, 425                                                                                                                                                                             | P1       | Yes      | Add prefixes and auditRead configs                                                                                                                            |
| M36          | Consent gate                         | GAP-065: No M39 consent gate on care_team membership/visibility yet ACKs revocation cascade                                                                                       | `m39-consent-revoked.ts:1-46`; spec §7.13                                                                                                                                                                                                   | P1       | Yes      | Consult ConsentEvaluator in sync/canViewChannel before ACK                                                                                                    |
| M36          | Channels                             | GAP-183: on_call, bereavement, discipline, location channels never created (501)                                                                                                  | `messaging-provider-db.ts:69-74`, `:82`, `:303-308`                                                                                                                                                                                      | P2       | No       | Implement consumers or amend spec                                                                                                                             |
| M36          | Attachments                          | GAP-184: Attachments accepted (201) but silently dropped                                                                                                                          | `messaging-routes.ts:151`; grep message_attachment shows only eraser                                                                                                                                                                         | P2       | No       | Persist rows or reject with 422                                                                                                                               |
| M36          | Edit window                          | GAP-185: Edit window (5 min) not enforced; edit/delete skip membership/archive                                                                                                    | `messaging-route-service-db.ts:491-520`; grep EDIT_WINDOW none                                                                                                                                                                               | P2       | No       | Reject old edits; require visibility                                                                                                                          |
| M36          | Alert rules                          | GAP-186: Alert-rule overrides written with empty audit actor                                                                                                                      | `:1133` `userId: ''`; `generate.ts:155` NULLIF                                                                                                                                                                                           | P2       | No       | Thread request.context.userId                                                                                                                                 |
| M36          | Workers                              | GAP-187: Only 4 of 12 spec'd queues have workers                                                                                                                                  | `queues.ts:40-53`; `delivery-workers.ts:17-20`                                                                                                                                                                                             | P2       | Yes      | Build hash_verify, retention_scan, endpoint_health                                                                                                            |
| M36          | Read audit                           | GAP-188: Message history read with no read-audit declaration and outside coverage gate                                                                                            | `messaging-routes.ts:153,159,170`; `bootstrap/index.ts:120-262`                                                                                                                                                                            | P2       | No       | Declare auditRead and add prefixes or justified waiver                                                                                                        |
| M36          | Notifications (web)                  | GAP-189: Tasks and Mentions tabs placeholders; no tasks backend; DM/announce/alert-rule/endpoint workflows no UI                                                                  | `notifications-inbox.tsx:255-259` 'Your task worklist arrives with the Tasks module.'                                                                                                                                                        | P2       | No       | Build tasks or mark partial; add screens                                                                                                                      |
| M37          | Equipment                            | GAP-190: Equipment assign skips RN-coverage gate, trusts client bedId/patientId                                                                                                   | `service-drizzle.ts:2326-2362`; spec :220                                                                                                                                                                                                    | P2       | No       | Add coverageActiveFor; validate bed/patient                                                                                                                   |
| M37          | Scope                                | GAP-191: No per-patient scope or unit-staff check on IPU PHI reads                                                                                                                | `ipu.routes.ts:193-247, 396-440`; `requireUnitStaff` only at `:872,1870,1981,2026`                                                                                                                                                       | P2       | No       | Apply scoping or document role-only decision                                                                                                                  |
| M37          | IPU (web)                            | GAP-192: Bed board lacks cleaning-status, body release, RN-coverage/break-glass, meals, shifts, equipment writes                                                                  | 13 of 36 mutating ops uncalled;`ipu-api.ts:270` copy references absent break-glass                                                                                                                                                           | P2       | Yes      | Add actions or mark partial; correct frame note                                                                                                               |
| M38          | Remediation                          | GAP-193: Tenant deprecation remediation scans only M7 problem-list usage                                                                                                          | `index.ts:7135` single producer; `tenant-scan.ts:6`                                                                                                                                                                                        | P2       | No       | Register more producers or amend spec                                                                                                                         |
| M38          | Audit                                | GAP-194: Platform-ops cross-tenant admin reads not audited as audit.elevated_access                                                                                               | `admin-terminology-routes.ts:5-7` claims audit; route line 328 has none                                                                                                                                                                      | P2       | No       | Write org-less platform audit event (M38 and M40)                                                                                                             |
| M38          | Terminology (web)                    | GAP-195: Terminology admin is search-only                                                                                                                                         | `terminology-admin.tsx:16,67`; `screens.ts:18`                                                                                                                                                                                             | P2       | No       | Build panels or mark partial                                                                                                                                  |
| M39          | Revocation                           | GAP-066: Revocation validation trusts client revokedByKind; staff can skip 40-char reason + evidence                                                                              | `consent-routes.ts:331` `actorIsStaff: body.revokedByKind === "staff"`; `rules.ts:226-241`                                                                                                                                               | P1       | Yes      | Derive from session class on server; restrict break-glass kind                                                                                                |
| M39          | Merge cascade                        | GAP-067: m5.patient.merged has no M39 consumer; consents stay on merged-away patient                                                                                              | `consumers.ts:59-66` pure function, no binding; `events-by-m5.ts:165-185`                                                                                                                                                                  | P1       | Yes      | Add consumer re-pointing consent_record; live test                                                                                                            |
| M39          | Alerts                               | GAP-196: Four of five typed M39 alert payloads never emitted                                                                                                                      | `alerts-by-m39.ts:21,51,65,80`; `alert-rules.ts:1079` seeds only revoked_cascade_failed                                                                                                                                                    | P2       | No       | Emit from crons/writes; seed rules                                                                                                                            |
| M39          | ABAC                                 | GAP-197: Consent/retention ABAC predicates registered but composed by no route                                                                                                    | `abac-uncomposed-allowlist.ts:16-17,26-36,62-63`; arch:abac-composed '192 declared - 165 composed by requireAbac - 27 allowlisted'                                                                                                           | P2       | No       | Compose at consuming routes or delete                                                                                                                         |
| M40          | Alerts                               | GAP-068: mdm.physician_deactivated alerts reach nobody: no alert_rule seeded                                                                                                      | `nppes-consumer-ports.ts:214`; `alert-rules.ts` seeds mdm.license_expiring (1097) and mdm.baa_expiring (1117) only                                                                                                                         | P1       | Yes      | Seed platform rule; live test                                                                                                                                 |
| M40          | BAA event                            | GAP-198: mdm.baa_status_changed never emitted by recordBaa                                                                                                                        | grep`baa_status_changed` no .ts hits; `mdm-store-db.ts:416-443`; counter-evidence `stuck-order-support.ts:23-33`                                                                                                                         | P2       | Yes      | Emit in recordBaa tx; add M29 requeue consumer                                                                                                                |
| M40          | Canonical kinds                      | GAP-199: Only 3 of 7 canonical kinds have tables                                                                                                                                  | `mdm-store-db.ts:70-72` hasCanonicalTable physician/facility/payer only; `0205_...sql` MERGE_KIND_UNSUPPORTED                                                                                                                              | P2       | No       | Add tables or restrict KindSchema/spec                                                                                                                        |
| M40          | Overlay                              | GAP-200: PATCH overlay is a full replace                                                                                                                                          | `mdm-routes.ts:162-169` `b.doNotRefer ?? false`                                                                                                                                                                                            | P2       | No       | Merge onto existing overlay                                                                                                                                   |
| M40          | Merge                                | GAP-201: Merge approval doesn't re-point consumer FKs, emits no merge events; refusals surface as raw PG errors                                                                   | `0205_...sql:~130-165`; `events-by-m40.ts` only two events                                                                                                                                                                                 | P2       | Yes      | Add repoint or redirect contract; emit events; map to 409/422                                                                                                 |
| M40          | MDM (web)                            | GAP-202: Console is a single search box                                                                                                                                           | `mdm-console.tsx:15-16,69`; 12 mutating ops and 5 reads uncalled                                                                                                                                                                             | P2       | No       | Build panels or mark partial                                                                                                                                  |
| M40          | get-or-create                        | GAP-250: Never returns fuzzy_candidates, ignores identifierType                                                                                                                   | `provider.ts:96-116`                                                                                                                                                                                                                         | P3       | No       | Implement fuzzy branch or amend spec                                                                                                                          |
| Cross-module | Docs (module-29-tasks)               | GAP-071: M29 task addenda give RLS DDL using banned GUCs app.organization_id / app.current_organization_id                                                                        | `WARDENX_T-29.02_SCHEMA_PACKAGE.md:1085-1130`; `T-29.11:137`; `T-29.10:202`; canonical app.org_id per ADR-0010 D2                                                                                                                        | P2       | No       | Correct GUC name or mark superseded; optional docs grep gate                                                                                                  |
| Cross-module | Staff workflows                      | GAP-203: Residual staff-facing mutating routes with no caller in any SPA                                                                                                          | M5 merge/unmerge/caregivers/amendments; M6 cti/discharge; M8 overrides; M14 recurring-policies; M17 optimize-day/map-view; M22; M23-25; M39                                                                                                    | P2       | No       | Triage per spec: build UI or record API-only in SCREEN_SPEC_STATUS                                                                                            |
| Cross-module | UI frame fidelity                    | GAP-204: Only 3 of 19 mapped screens matched; 2 pending, 70 frames unmatched                                                                                                      | `FRAME_FIDELITY.md`: 'By status: 3 matched, 14 partial, 2 pending'; '102 frames not yet mapped: 25 deferred, 7 design-library, 70 unmatched'                                                                                                 | P2       | No       | Schedule region-by-region matching                                                                                                                            |
| Cross-module | UI corpus gate                       | GAP-205: SCREEN_SPEC_STATUS 'built' only checked for citing a registered screen set                                                                                               | `check-ui-screens.ts:155-203`                                                                                                                                                                                                                | P2       | No       | Add per-row action-coverage column; re-grade rows                                                                                                             |
| Cross-module | web (sessionStorage)                 | GAP-206: PHI-bearing step-up drafts persisted in sessionStorage, not cleared at sign-out                                                                                          | `step-up-redirect.ts:71-77`; `write-workflow.ts:12-17` states PHI must never be persisted to browser storage                                                                                                                               | P2       | Yes      | In-memory Map or clear on sign-out; add lint gate                                                                                                             |
| Cross-module | OpenAPI                              | GAP-207: 8 GET routes carry no response schema                                                                                                                                    | `OPENAPI_COVERAGE.md:8` '8/602 GETs carry no response schema'                                                                                                                                                                                | P3       | No       | Add response schemas                                                                                                                                          |
| Cross-module | OpenAPI (M35 webhook)                | GAP-208: POST /webhooks/stripe publishes no request schema                                                                                                                        | `enrichments.ts:2578`; `report-openapi-coverage.ts:120`                                                                                                                                                                                    | P3       | Yes      | Publish body schema; re-baseline to 0                                                                                                                         |
| Cross-module | Docs counts                          | GAP-209: Hand-mirrored counts diverge from generated reports                                                                                                                      | `BUSINESS_LOGIC.md:606` '60 routes' vs 61/61; `IMPLEMENTATION_ROADMAP.md:60` '36 packages' vs 49 + 4 apps                                                                                                                                  | P3       | No       | Remove or point to generated report                                                                                                                           |
| Cross-module | docs/cartography                     | GAP-210: Cartography docs cite nonexistent files                                                                                                                                  | `audit_encounters_visits.md:748,762`; `hope_report.md:190,383`                                                                                                                                                                             | P3       | Yes      | Date-stamp or fix paths                                                                                                                                       |
| Cross-module | docs/history                         | GAP-211: status-overview.md has 3 broken relative links                                                                                                                           | `status-overview.md:77-81`                                                                                                                                                                                                                   | P3       | Yes      | Fix to ../ paths or extend docs gate                                                                                                                          |
| Cross-module | docs/modules                         | GAP-212: Module specs cite ~470 nonexistent code paths                                                                                                                            | Path scan found 473 missing repo paths across 50 files                                                                                                                                                                                         | P3       | No       | Add as-built pointer or ratchet                                                                                                                               |
| Cross-module | e2e (web)                            | GAP-213: E2E reaches only 19 of 170 routable screens                                                                                                                              | `E2E_COVERAGE.md`: '19/170 E2E-reached, 163/170 axe-reached'                                                                                                                                                                                 | P3       | No       | Add specs for zero-coverage screens                                                                                                                           |
| Cross-module | Frame fidelity                       | GAP-214: 2 pending, 14 partial, 70 unmatched frames, 25 deferred                                                                                                                  | `frame:fidelity:check`: 'OK frame-fidelity: report fresh (19 mapped · 25 deferred · 70 unmatched · green 3 / amber 14 / grey 2)'                                                                                                          | P3       | No       | Owner decision on release-relevant frames                                                                                                                     |
| Cross-module | Composition root                     | GAP-215: Stale seam-status comments contradict code                                                                                                                               | `index.ts:5951`, `:3255-3262` vs `:3311`, `:1580-1584`; `m30-jobs.ts:2640-2644`                                                                                                                                                      | P3       | No       | Update or delete stale comments                                                                                                                               |
| Cross-module | Comments                             | GAP-252: Comments describe modules as not yet landed though all 40 are implemented                                                                                                | `m29-proposal-accepted.ts:36`; `m17-visit-scheduled.ts:197`; `subscription-map.ts:67,309`; ~15 'TODO(Phase 2D)' in M34                                                                                                                   | P3       | No       | Triage each; delete stale, track live                                                                                                                         |
| Cross-module | Ops/Config                           | GAP-253: Operational env vars read by backend absent from .env.example, compose and deploy example                                                                                | DOCUMENT_UPLOAD_SCAN_REQUIRED, OPS_ALERT_WEBHOOK_URL, WEB_APP_URL, PORTAL_APP_URL, ANTHROPIC_BAA_REFERENCE, TERMINOLOGY_* etc.; scan flag defaults to false (`index.ts:85-91`)                                                               | P3       | No       | Add production-relevant vars to`.env.production.example`; validate scan flag in env.ts                                                                      |

## 4. Cross-module seams table

Status vocabulary: live (constructed and bound), broken, missing, unbound, stubbed, partial, bound-unused, unconsumed, unimplemented. Rows with empty Risk had none recorded.

| Source                                                                            | Target                                               | Seam                                                                                                                                                                                     | Status                                              | Evidence                                                                                                                                                                                                                                                                                                                                                         | Verified                        | Risk                                                                                                            |
| --------------------------------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| M02 link-routes                                                                   | M05 CaseloadProvider (caseload_membership predicate) | collaborator/funeral invite ABAC                                                                                                                                                         | broken                                              | `link-routes.ts:90-93,154,192` pass {patientId}; `caseload-provider.ts:61-67` reads target.id; live suite stubs predicate allow-all (`m2-link-redemption.live.test.ts:290`)                                                                                                                                                                                | Yes (GAP-001)                   | Collaborator and funeral-home link minting always 403 in production                                             |
| M03 AuditorSessionMinter / close cron                                             | M02 auditor_magic_link                               | auditor link revoke at engagement close                                                                                                                                                  | live                                                | `index.ts:5716-5725` revokeAuditorMagicLinksForEngagement; engagement liveness re-checked per read (`engagement-reader.ts:53-67`)                                                                                                                                                                                                                            | Yes                             | Cancel/shorten does not revoke already-consumed links; protection relies on per-request liveness checks         |
| M34 provisioning                                                                  | M03 role/role_permission tables                      | tenant onboarding role materialization                                                                                                                                                   | missing                                             | `role-store.ts:29-33`; `proposed-role-attacher.ts:42-48`; no production insert of template roles                                                                                                                                                                                                                                                             | Yes (GAP-006)                   | New tenants cannot grant any permission without out-of-band seeding                                             |
| M03 reap_breakglass / close_engagements, M04 audit workers                        | active-org enumerator                                | cron fan-out                                                                                                                                                                             | live                                                | `index.ts:6870-6891, 5707-5731, 5690-5706` construct workers with buildActiveOrgEnumerator/platform job ids                                                                                                                                                                                                                                                    | Yes                             |                                                                                                                 |
| M04 m4.legal_hold.applied/released                                                | owning-module HoldApplier seams                      | legal hold propagation                                                                                                                                                                   | unbound                                             | `legal-holds.ts:50-58` header: no module registered a HoldApplier; `audit-eraser.ts:172-190` structural holds not evaluated                                                                                                                                                                                                                                  | Yes (GAP-008)                   | Holds do not reliably block destruction                                                                         |
| M05 outbox consumers                                                              | apps/backend/src/index.ts                            | consumer construction                                                                                                                                                                    | live                                                | All 10 M5 consumer factories and M29 proposal applier called in`index.ts` (8973-9042); snapshot-rebuild and amendment-SLA workers at 7884-7931                                                                                                                                                                                                                 | Yes                             |                                                                                                                 |
| M05 m5.patient.merged                                                             | M22 / M39 / FK-holding modules                       | merge cascade                                                                                                                                                                            | unbound                                             | `events-by-m5.ts:164-183` declaredConsumers [m35]; resolvePatientRedirect/applyPatientMergeCascade/decidePatientMergeRepoint have no callers; `merges-db.ts:76-80` no re-point                                                                                                                                                                               | Yes (GAP-084)                   | Survivor chart missing documents, consents and clinical history                                                 |
| M5                                                                                | M39                                                  | m5.patient.merged -> consent re-point                                                                                                                                                    | missing                                             | `events-by-m5.ts:185` declaredConsumers ['m35']; decidePatientMergeRepoint unbound                                                                                                                                                                                                                                                                             | Yes (GAP-067)                   | P1                                                                                                              |
| M6                                                                                | M7                                                   | m6.admission.activated/discharged -> care-plan bootstrap consumers                                                                                                                       | live                                                | buildM7AdmissionActivatedConsumer/DischargedConsumer at`index.ts:8424,8428`                                                                                                                                                                                                                                                                                    | Yes                             |                                                                                                                 |
| M6                                                                                | M10                                                  | m6.admission.activated/discharged -> HOPE timepoint schedules; AdmissionStatusReader                                                                                                     | live                                                | buildM10AdmissionWorkflowConsumer`index.ts:8728`; `hope-route-service-db.ts:1121`; older buildM10AdmissionSchedulingConsumer intentionally unbound (`index.ts:9043`)                                                                                                                                                                                       | Yes                             |                                                                                                                 |
| M14                                                                               | M7                                                   | idg.decision_recorded -> care-plan draft version                                                                                                                                         | live                                                | buildM7IdgDecisionConsumer`index.ts:8432`; M7_IDG_DECISION_CONSUMER_DEFERRED=false (`m14-idg-decision-recorded.ts:49`)                                                                                                                                                                                                                                       | Yes                             |                                                                                                                 |
| M17                                                                               | M8                                                   | visit published/closed -> encounter seeding                                                                                                                                              | live                                                | buildM8VisitPublishedConsumer/ClosedConsumer`index.ts:8599,8605`                                                                                                                                                                                                                                                                                               | Yes                             |                                                                                                                 |
| M7                                                                                | M8                                                   | CarePlanReader.relevantElementsForEncounter / isReviewOverdue                                                                                                                            | live                                                | `encounters-route-service-db.ts:1567-1572` uses getCarePlanReader()                                                                                                                                                                                                                                                                                            | Yes                             |                                                                                                                 |
| M9                                                                                | M8/M10                                               | LatestAssessmentProvider (gate scales, HOPE PPS/ESAS snapshot)                                                                                                                           | live                                                | `hope-route-service-db.ts:305-320`; M8 gate scalesPresentFor; `seams/drizzle-store.ts` fails closed on SUD AIMS rows                                                                                                                                                                                                                                         | Yes                             |                                                                                                                 |
| M10                                                                               | iQIES                                                | IqiesAdapterPort submit/reconcile transport                                                                                                                                              | stubbed                                             | `index.ts:7305` createUnboundIqiesAdapter(); automated stages unscheduled (`cron-workers.ts:440-520`); manual package flow is live path                                                                                                                                                                                                                      | Yes (GAP-096)                   | Spec still describes automated submission; no automated transmit or reconciliation                              |
| M9                                                                                | M22                                                  | assessment summary render                                                                                                                                                                | live                                                | event m9.assessment.summary_requested consumed by`render-consumer.ts:444`; exported deny-stub renderer (`m22-summary-pdf.ts`) is dead code                                                                                                                                                                                                                   | Yes                             |                                                                                                                 |
| M6                                                                                | M29                                                  | m29.hl7_inbound_proposal.accepted -> admission event applier                                                                                                                             | live                                                | buildM6ProposalAcceptedConsumer`index.ts:9050`; file header still claims deferred (doc rot)                                                                                                                                                                                                                                                                    | Yes                             |                                                                                                                 |
| M8                                                                                | M15                                                  | volunteer_assignment reader for volunteer encounters                                                                                                                                     | missing                                             | checkVolunteerAssignment (`lifecycle/validation.ts:124`) never called; createDraft (`encounters-route-service-db.ts:1202-1260`) does not resolve an M15 reader                                                                                                                                                                                               | Yes (GAP-094)                   | Volunteer visits can be authored without an active assignment                                                   |
| M8                                                                                | M23/M24                                              | BillableEncounterReader (late_entry_unattested branch)                                                                                                                                   | live                                                | `seams/readers.ts:34-52` correct, but the late_entry_tier it keys on is never computed                                                                                                                                                                                                                                                                         | Yes (GAP-013)                   | Late/administrative-override billing hold cannot trigger                                                        |
| M29                                                                               | M11                                                  | m29.lab_observation.attached / .unmatched to M11 lab-results-applier                                                                                                                     | missing                                             | No consumer under`apps/backend/src/modules/11-orders/`. `events-by-m29.ts:363-410` declares no consumers. m11.order.results_received has no emit site; M22 binds the dead event (`index.ts:9122`)                                                                                                                                                          | Yes (GAP-016)                   | P1: lab results never link to orders; review queue empty; false results_overdue alerts                          |
| M13                                                                               | M9                                                   | m13.prn_administration_recorded to prn_administration row to PRN reassessment                                                                                                            | missing                                             | `outbox-deferred-consumers.ts:349-353` dropped the M9 consumer. No code inserts prn_administration (only live tests). `emar-route-service-db.ts:1132-1146` emits a random id                                                                                                                                                                                 | Yes (GAP-022)                   | P1: PRN overdue cron and M30 prn_effectiveness measure inert                                                    |
| M12                                                                               | M11                                                  | OrderSignatureProvider.signOrderTarget for medication_order                                                                                                                              | missing                                             | `dosespot-route-service-db.ts:25-27,858-892`; only recordVerbalOrder (:979) and cosignOrder (:1059) call the seam                                                                                                                                                                                                                                              | Yes (GAP-018)                   | P1: no signature record for signed prescriptions                                                                |
| M10                                                                               | M11                                                  | m10.hope.j2051_trigger_fired to hope-trigger suggestion consumer                                                                                                                         | stubbed                                             | `consumers/hope-trigger.ts` has no binding; registered handler-unbound at `outbox-subscription-exceptions.ts:141-150`                                                                                                                                                                                                                                        | Yes (GAP-097)                   | P2: HOPE-driven order suggestions never appear                                                                  |
| M9                                                                                | M11                                                  | m9.assessment.significant_change to suggestion banner                                                                                                                                    | stubbed                                             | Consumer bound and writes Valkey, but suggestions() at`orders-route-service-db.ts:922` returns [] and nothing reads the key                                                                                                                                                                                                                                    | Yes (GAP-097)                   | P2                                                                                                              |
| M13                                                                               | M12                                                  | MedicationOrderProvider.administrationIdentity / getAdministrationContext                                                                                                                | live                                                | `emar-route-service-db.ts:790-830` resolves identity and allowAdministration gate. Dose, ndc, rxnorm, wristband data not carried, so five-rights and BCMA cannot run                                                                                                                                                                                           | Yes (GAP-020)                   | P1 (see five-rights finding)                                                                                    |
| M14                                                                               | M11/M12/M15                                          | idg.decision_recorded consumers                                                                                                                                                          | live                                                | `index.ts:8436-8442` (M11, M12) and `:9341` (M15); all constructed                                                                                                                                                                                                                                                                                           | Yes                             |                                                                                                                 |
| M11-M15                                                                           | workers                                              | cron/worker registration with active-org enumerator                                                                                                                                      | live                                                | `index.ts:6812,7426,7459,7627-7749,7945-7983`, each with buildActiveOrgEnumerator or org-explicit pass                                                                                                                                                                                                                                                         | Yes                             |                                                                                                                 |
| M17 VisitAssignmentReader.tonightsOnCallRoster                                    | M19 shift-sync / oncall_eligible                     | on-call roster read                                                                                                                                                                      | broken                                              | `17-scheduling/seams/drizzle-store.ts:294-299` always throws SchedulingOnCallRosterUnavailableError; `19-oncall/jobs/reconcile.ts:17-35` documents permanent degraded path                                                                                                                                                                                   | Yes (GAP-029)                   | Direct-model tenants get no synced on-call shifts                                                               |
| M11 m11.order_requires_visit / M14 idg.decision_recorded (change_visit_frequency) | M17 visit_proposal producers                         | proposal sources                                                                                                                                                                         | unbound                                             | No producer in M11; no M17 consumer (`consumers/index.ts:12-14` comment only)                                                                                                                                                                                                                                                                                  | Yes (GAP-110)                   | Order- and IDG-driven visits never proposed                                                                     |
| M15 SupervisoryCadenceReader                                                      | M17 propose-from-frequency / day view                | supervisory cadence advisory                                                                                                                                                             | bound-unused                                        | `seams/consumed.ts:40` getter never called                                                                                                                                                                                                                                                                                                                     | Yes                             | Supervisory visit proposals absent                                                                              |
| M18 submission worker                                                             | State aggregator (Sandata)                           | EvvAggregatorAdapter transport                                                                                                                                                           | stubbed                                             | `18-evv/jobs/wiring.ts:35-65` deny transport, unbound credentials, throwing state identifier                                                                                                                                                                                                                                                                   | Yes (GAP-028)                   | No real EVV submission                                                                                          |
| M20 SOS resolve                                                                   | M17 visit cancellation                               | m20.safety.visit_cancellation_requested                                                                                                                                                  | bound-unvalidated                                   | visitId from client lastKnownVisitId (`write-service-drizzle.ts:839,1149`); M17 consumer has no assignee check                                                                                                                                                                                                                                                 | Yes (GAP-117)                   | Cross-clinician visit cancellation                                                                              |
| M5 PatientAddressReader.serviceAddressCoordinate                                  | M20 high-risk-area evaluator                         | pre-visit advisory                                                                                                                                                                       | unconsumed                                          | M20`seams/consumed.ts:28-35` claims no address seam exists, but `18-evv/evv-route-service-db.ts:223` uses it                                                                                                                                                                                                                                                 | Yes (GAP-118)                   | D12 advisory and mandatory pre-visit check-in never produced                                                    |
| M19 disposition / document                                                        | M8 EncounterCreator                                  | encounter link with D-B deferral                                                                                                                                                         | partial                                             | `write-service-drizzle.ts:949-962` swallows errors; no retry worker in `jobs/index.ts`                                                                                                                                                                                                                                                                       | Yes (GAP-116)                   | Calls stuck in documented_pending_encounter                                                                     |
| M8                                                                                | M19/M17                                              | EncounterCreator.createDraftEncounter and MileagePayrollReader                                                                                                                           | stubbed                                             | `08-encounters/seams/drizzle-store.ts:69-71` spreads in-memory fallback; `store.ts:141` insertDraftEncounter mints fake id; consumers `19-oncall/clinical/encounter-link.ts:218` and `17-scheduling/seams/drizzle-store.ts:436`                                                                                                                          | Yes (GAP-069)                   | P1                                                                                                              |
| M20 emergency_terminus effects                                                    | M36 voice / M40 PSAP / platform page                 | dial/PSAP/page                                                                                                                                                                           | unimplemented                                       | `20-field-safety/jobs/cron-workers.ts:36-52`; `routes/effects-runner.ts:120-125`                                                                                                                                                                                                                                                                             | Yes (GAP-032)                   | Unacknowledged SOS never reaches the final rung                                                                 |
| M23                                                                               | M22                                                  | m22.document.rendered back-reference (noe/notr confirmation_document_id, claim acknowledgment_document_id)                                                                               | missing                                             | `events-by-m22.ts:88` declaredConsumers omit m23/m24/m25; no bound consumer in `index.ts`; columns never written                                                                                                                                                                                                                                             | Yes (GAP-125)                   | Receipts and acknowledgment letters render but are never linked to NOE/NOTR/claim rows                          |
| M25                                                                               | M22                                                  | m25.appeal_packet.render_requested -> render -> m22.document.rendered back-ref                                                                                                           | stubbed                                             | `write-service-drizzle.ts:339` emits payload {}; `renderer.ts` has no appeal_packet builder; backrefDocument (`denial-seed-store-drizzle.ts:85`) has no live caller                                                                                                                                                                                        | Yes (GAP-036)                   | Appeal packet PDF is an empty stand-in and not linked to appeal_case                                            |
| M25                                                                               | M23                                                  | m23.claim.rejected -> denial seed                                                                                                                                                        | live                                                | `index.ts:9559-9566` buildM23ClaimRejectedConsumer constructed                                                                                                                                                                                                                                                                                                 | Yes                             |                                                                                                                 |
| M25                                                                               | M18                                                  | m18.evv.aggregator_rejected -> denial seed                                                                                                                                               | live                                                | `index.ts:9565-9570` buildM18EvvAggregatorRejectedConsumer constructed                                                                                                                                                                                                                                                                                         | Yes                             |                                                                                                                 |
| M23                                                                               | M25                                                  | m25.remittance.claim_paid/denied/recouped consumer                                                                                                                                       | live                                                | `index.ts:9642` buildM23RemittanceConsumer                                                                                                                                                                                                                                                                                                                     | Yes                             |                                                                                                                 |
| M24                                                                               | M25                                                  | m25.remittance.claim_paid/denied consumer                                                                                                                                                | live                                                | `index.ts:8951` buildM24RemittanceConsumer                                                                                                                                                                                                                                                                                                                     | Yes                             |                                                                                                                 |
| M24                                                                               | M6                                                   | m6.loc.changed / m6.admission.discharged / m5.patient.deceased -> rb_day                                                                                                                 | live                                                | `index.ts:8935-8945` buildM24RbDayConsumers; payload fields match `events-by-m6.ts:775-779` and `events-by-m5.ts:135`                                                                                                                                                                                                                                      | Yes                             |                                                                                                                 |
| M21                                                                               | M27                                                  | invoice_accrued/invoice_reconciled emission                                                                                                                                              | live                                                | `write-service-drizzle.ts:734-803` emits both events; `outbox-deferred-consumers.ts` F-207 note says M27 binds them                                                                                                                                                                                                                                          | Yes                             | M27 binding itself not re-verified in this batch                                                                |
| M21                                                                               | M11/M13/M12/M22                                      | inbound consumers (order cancel cascade, supply fulfillment intake, comfort-kit cascade, pharmacy dispense, document backref)                                                            | live                                                | `index.ts:9431-9463` constructs all nine M21 consumers                                                                                                                                                                                                                                                                                                         | Yes                             |                                                                                                                 |
| M22                                                                               | M11                                                  | critical-results priority lane (m11.order.results_received_critical)                                                                                                                     | missing                                             | `events-by-m11.ts:499` declaredConsumers [] and no M22 forms-render-critical queue                                                                                                                                                                                                                                                                             | Yes (GAP-122)                   | Critical lab PDFs share the normal queue and carry no critical watermark                                        |
| M25                                                                               | M25                                                  | claim_assigned_to_actor on remittance.manual_match                                                                                                                                       | stubbed                                             | `remittance.routes.ts:23,130` + `guards.ts:19` pass the line id as denialCaseId                                                                                                                                                                                                                                                                              | Yes (GAP-134)                   | Non-oversight roles are always denied manual match                                                              |
| M23                                                                               | M26                                                  | CapProjectionProvider (patient scope) / claim.line_finalized / claim.paid consumers                                                                                                      | partial                                             | M23 emits line_finalized (`claim-line-finalized.ts`) and M26 consumers are bound (`index.ts:8512`); but patient_aggregate snapshots never written and replaced/voided payloads do not match handleClaimReversed                                                                                                                                              | Yes (GAP-037, GAP-143)          | Per-patient cap band always 'safe' for M23 validation; claim voids never reverse accruals                       |
| M26                                                                               | M27                                                  | CapAccrualReader.aggregateForCostReport                                                                                                                                                  | live                                                | `registerM26PublishedSeams(deps.db)` `index.ts:1598`; `seam-impls.ts:121-168` selects period by CCN; but totalMedicareDays reads cap_inpatient_accrual.total_patient_days which is never written                                                                                                                                                           | Yes (GAP-038)                   | Worksheet inpatient figures zero                                                                                |
| M26                                                                               | M36                                                  | alert.dispatcher / m26.cap.threshold_crossed                                                                                                                                             | missing                                             | No consumer of m26.cap.threshold_crossed; CapAlertSubscriberProvider returns []; typed alert payloads unused (`seam-impls.ts:232-237`)                                                                                                                                                                                                                         | Yes (GAP-040)                   | Cap watch/warn/breach alerts never reach users                                                                  |
| M25                                                                               | M26                                                  | m25.remittance.claim_paid/partial_paid/claim_recouped accrual consumer                                                                                                                   | live                                                | `consumers/outbox-binding.ts` BOUND_TOPICS; `index.ts:8512-8535` buildM26UpstreamConsumer                                                                                                                                                                                                                                                                    | Yes                             | None beyond period/status checks (accrual posts into settled periods; spec 2.3 CapPeriodNotActive not enforced) |
| M27                                                                               | M25                                                  | m25.denial.opened rule-suggestion consumer                                                                                                                                               | stubbed                                             | `consumers/subscription-map.ts:14-22`; `index.ts` binds only M22 backref and M21 vendor-invoice consumers                                                                                                                                                                                                                                                    | Yes (GAP-150)                   | W-CR-08 unavailable                                                                                             |
| M40                                                                               | M27                                                  | provider entity offboarded closes cost reports                                                                                                                                           | missing                                             | No producer of m40.provider_entity.offboarded; arch:outbox-bindings 'no-such-event'                                                                                                                                                                                                                                                                              | Yes (GAP-150)                   | W-CR-12 unavailable                                                                                             |
| M27                                                                               | M30                                                  | CostReportFilingStatusReader                                                                                                                                                             | live                                                | `registerM27PublishedSeams(deps.db)` `index.ts:1634`; M30 buildM30CostReportConsumer default (`m30-jobs.ts:2575`)                                                                                                                                                                                                                                          | Yes                             | None found                                                                                                      |
| M28                                                                               | M5/M12                                               | inbound proposal accept callback (owner-module review/apply)                                                                                                                             | missing                                             | No consumer of m28.fhir.inbound.accepted; FhirInboundProposalReader read only by M28/bootstrap                                                                                                                                                                                                                                                                   | Yes (GAP-153)                   | Accepted proposals never create native rows; accepted_aggregate_id is reviewer-asserted                         |
| M29                                                                               | M28                                                  | LabObservationReader (DiagnosticReport)                                                                                                                                                  | live                                                | registerM29PublishedSeams`index.ts:2255`; M28 consumed.ts getFhirLab reader                                                                                                                                                                                                                                                                                    | Yes                             | None found                                                                                                      |
| M29                                                                               | M5                                                   | m29.hl7_inbound_proposal.accepted applier                                                                                                                                                | live                                                | buildM29ProposalApplierConsumer()`index.ts:8969`; `05-patient/outbox-consumers/m29-proposal-accepted.ts`                                                                                                                                                                                                                                                     | Yes                             | Partial-field path unreachable from the route                                                                   |
| M29                                                                               | M36                                                  | listener_down alert                                                                                                                                                                      | missing                                             | evaluateListenerCircuit has no caller; external_feed_health never written                                                                                                                                                                                                                                                                                        | Yes (GAP-043)                   | Silent loss of ADT/ORU feeds is undetected                                                                      |
| M6                                                                                | M30                                                  | m6.discharge.death mortality-review creation                                                                                                                                             | live                                                | buildM30DischargeDeathConsumer`index.ts:8788`                                                                                                                                                                                                                                                                                                                  | Yes                             | None found                                                                                                      |
| M26/M27/M28/M30 workers                                                           | M2/M1                                                | active-org enumerator with withPlatformContext allowlist + withOrgContext per job                                                                                                        | live                                                | `index.ts:6635-6656` (M26), `6136-6173` (M27), `6968-6977` (M28), `5942-5950` (M30); wireM26/27/28/30Tenancy                                                                                                                                                                                                                                             | Yes                             | Cron loops lack per-org error isolation (M26)                                                                   |
| M31                                                                               | M2/M36 (session revoke, channel membership)          | m31.portal_account.suspended / portal_access_grant.revoked outbox events                                                                                                                 | unbound (declaredConsumers empty)                   | `events-by-m31.ts:44-53` and all other entries declaredConsumers: []                                                                                                                                                                                                                                                                                           | Yes (GAP-167)                   | Suspended or revoked caregivers keep sessions and channel membership                                            |
| M31                                                                               | Daily.co/Twilio vendor                               | TelehealthAdapterPort (@wardenx/telehealth-client)                                                                                                                                       | unbound in production (NOOP adapter)                | `index.ts:4888-4990` (no telehealth dep); `telehealth.routes.ts:37-52,70`                                                                                                                                                                                                                                                                                    | Yes (GAP-051)                   | Telehealth non-functional; webhooks always 401                                                                  |
| M31                                                                               | M30 / 164.528 scorecard                              | PortalDisclosureAccountingProvider                                                                                                                                                       | stub returning []                                   | `31-portal/routes/store.ts:483-489`                                                                                                                                                                                                                                                                                                                            | Yes (GAP-052)                   | Accounting of disclosures is empty                                                                              |
| M31                                                                               | M28 SMART launch                                     | PortalSessionMinter.createSmartLaunchSession                                                                                                                                             | synthetic id, nothing persisted (no consumer today) | `31-portal/routes/store.ts:476-481`                                                                                                                                                                                                                                                                                                                            | Yes                             | Latent fake-success if M28 starts to depend on it                                                               |
| M35                                                                               | M2/M33/M34/M36 and other modules                     | SubscriptionStateProvider, BillingStatusProvider, UsageMeteringIngest, PatientCounterProvider, RevenueMetricsProvider, PlanCatalogReader                                                 | deny-stubs only; no registration                    | `registry.ts:635-660`; no registerSeam in apps/backend/src or packages                                                                                                                                                                                                                                                                                         | Yes (GAP-181)                   | No billing enforcement or metering reaches other modules                                                        |
| M35                                                                               | Stripe                                               | stripe-dispatcher / webhook ingest                                                                                                                                                       | unbound (webhook 503, no dispatcher worker)         | `webhooks.routes.ts:43-49`; `index.ts:4395-4423`                                                                                                                                                                                                                                                                                                             | Yes (GAP-058)                   | Subscriptions, invoices, refunds never reach Stripe                                                             |
| M33                                                                               | M1 per-tenant DEK provider                           | drilldownEncryption port                                                                                                                                                                 | unbound; drilldown emit returns 500                 | `33-reporting/wiring.ts:568-577`                                                                                                                                                                                                                                                                                                                               | Yes (GAP-056)                   | Drilldown audit trail cannot be written                                                                         |
| M32                                                                               | M2 / BAA, ZDR registers                              | AiOptInEvidenceResolver                                                                                                                                                                  | denying stub bound in production                    | `index.ts:5049`; `governance/service.ts:96-105`                                                                                                                                                                                                                                                                                                              | Yes (GAP-173)                   | Cloud-reachable tenant opt-in cannot succeed (acceptable while ai.full is off)                                  |
| M32                                                                               | M32 evaluation workers                               | ai_evaluation_run transitions                                                                                                                                                            | no caller of transitionAiEvaluationRun              | `32-ai-platform/safety/service.ts:473`                                                                                                                                                                                                                                                                                                                         | Yes (GAP-172)                   | Stage-3 evidence unobtainable; drift endpoint always empty                                                      |
| M40                                                                               | M29                                                  | mdm.baa_status_changed outbox event (BAA renewal requeues DLQ'd outbound HL7)                                                                                                            | missing                                             | no producer or consumer anywhere; recordBaa at`40-mdm/mdm-store-db.ts:416` emits nothing                                                                                                                                                                                                                                                                       | Yes (GAP-198)                   | P1                                                                                                              |
| M40                                                                               | M36                                                  | mdm.physician_deactivated alert                                                                                                                                                          | stubbed                                             | emitted at`nppes-consumer-ports.ts:214` but no alert_rule seeded; emitter resolves zero recipients                                                                                                                                                                                                                                                             | Yes (GAP-068)                   | P1                                                                                                              |
| M36                                                                               | vendors (Twilio/Postmark/web-push)                   | OutOfBandTransports                                                                                                                                                                      | stubbed                                             | `index.ts:7601` createDenyTransports(); no real transport exists                                                                                                                                                                                                                                                                                               | Yes (GAP-062)                   | P1                                                                                                              |
| M5                                                                                | M39                                                  | m5.patient.merged -> consent re-point                                                                                                                                                    | missing                                             | `events-by-m5.ts:185` declaredConsumers ['m35']; decidePatientMergeRepoint unbound                                                                                                                                                                                                                                                                             | Yes (GAP-067)                   | P1                                                                                                              |
| M39                                                                               | M36                                                  | m39.consent.revoked cascade (m36_messaging ACK)                                                                                                                                          | stubbed                                             | `36-messaging/outbox-consumers/m39-consent-revoked.ts` ACKs with no action and no consent check in canViewChannel                                                                                                                                                                                                                                              | Yes (GAP-065)                   | P1                                                                                                              |
| M5/M6/M37/M13/M12                                                                 | M36/M37                                              | M37 IV overlay writers, M6 lcp/discharge/death consumers, M36 IPU alert consumers                                                                                                        | live                                                | `index.ts:8822-8846, 8661, 8694`                                                                                                                                                                                                                                                                                                                               | Yes                             | None                                                                                                            |
| M29                                                                               | M40                                                  | m29.nppes.provider_synced/deactivated platform consumers                                                                                                                                 | live                                                | buildM29NppesPlatformConsumers imported/registered at`index.ts:1412`; emits catalogued via M40_OUTBOX_EVENTS (`index.ts:3274`)                                                                                                                                                                                                                               | Yes                             | None                                                                                                            |
| M39                                                                               | M36                                                  | typed consent alerts (expiration_imminent, renewal_overdue, dpoa appointed, disclosure attempted)                                                                                        | missing                                             | `alerts-by-m39.ts` registers 5 payloads, only revoked_cascade_failed emitted/seeded                                                                                                                                                                                                                                                                            | Yes (GAP-196)                   | P2                                                                                                              |
| M23                                                                               | M26                                                  | CapAccrualReader / CapProjectionProvider / accrual feed (m25.remittance.claim_paid/partial_paid/claim_recouped, m23.claim.line_finalized)                                                | live                                                | `26-cap/wiring.ts:19-20` registers CapAccrualReader and CapProjectionProvider; consumer `index.ts:8513`; m23 line_finalized producer `claim-line-finalized.ts:20` wired at `m25-remittance.ts:190` and `index.ts:9642`; M23 reads projection at `cap-projection-adapter.ts:~64`. Caveats: CCN ignored, null-DTM drop, replaced/voided bindings inert | Yes (GAP-127, GAP-138, GAP-143) | P2                                                                                                              |
| M23                                                                               | M26                                                  | CapSettlementProvider (and InpatientCapProvider, CapMetricsProvider, CapAlertSubscriberProvider)                                                                                         | missing                                             | Built in`26-cap/seam-impls.ts:205-262`, never registered (`wiring.ts:19-20`) and absent from `registry.ts` REQUIRED_SEAMS; no getSeam consumer                                                                                                                                                                                                             | Yes (GAP-147)                   | P2                                                                                                              |
| M26                                                                               | M27                                                  | CMS-1984-14 cap calc inputs via CapAccrualReader.aggregateForCostReport                                                                                                                  | live                                                | `index.ts:6182` capResolver: m27CapSeamResolver; `cap-context.ts:36`; `seam-impls.ts:126-168`. Settlement snapshot and per-beneficiary attachment per spec not consumed                                                                                                                                                                                    | Yes (GAP-147)                   | P2                                                                                                              |
| M27                                                                               | M30                                                  | CostReportFilingStatusReader to cost_report_filing_compliance; M23 ClaimLineReader/PatientDaysProvider to HCI                                                                            | live                                                | `30-quality/consumed-seam-adapters.ts:73-125` resolves via getSeam; registered by registerM27PublishedSeams (`index.ts:1634`) and M23 `cost-report-seams.ts:112`; `m30-jobs.ts:2582` defaults                                                                                                                                                            | Yes                             |                                                                                                                 |
| M27                                                                               | M30                                                  | HCI/operational measure data binding (M5-M18 org-level readers to resolveInput)                                                                                                          | live                                                | `m30-jobs.ts:1728-1815` resolveInput dispatch; org-explicit readers self-scope via withOrgContext. Three claims-file HCI indicators are declared absences (HCI_UNAVAILABLE_MEASURE_CODES). Org-wide inputs repeated per PE; HVLDL broken by the EVV column issue                                                                                               | Yes (GAP-162, GAP-070)          | P1                                                                                                              |
| M1                                                                                | M30                                                  | Transactional outbox-row emit for quality events                                                                                                                                         | live                                                | `index.ts:3624` m30OutboxPublisher = bindCallerModule(txOutboxPublisher,'m30'); `bootstrap/outbox-persister.ts:93-135`; M30_OUTBOX_EVENTS in boot catalog (`index.ts:3243+`); dispatcher `index.ts:8420-8425,9793` runs only when role !== 'api'. The 21 m30.* events have zero consumers                                                                | Yes (GAP-049)                   | P1                                                                                                              |
| M30                                                                               | M36                                                  | m30.* events to alerts                                                                                                                                                                   | missing                                             | `events-by-m30.ts` declaredConsumers [] for all 21 events; no m30 reference in 36-messaging/outbox-consumers; `write-service-drizzle.ts:1537` publishes only                                                                                                                                                                                                 | Yes (GAP-049)                   | P1                                                                                                              |
| M30                                                                               | M33                                                  | Metrics provider registration and event consumption                                                                                                                                      | stubbed                                             | M33 registers MetricsProvider (`33-reporting/wiring.ts:297`) but no module calls getSeam("MetricsProvider"); M33 has no M30 dataset or m30 event consumer; only 3 MVs (`0060_reporting_mv.sql`)                                                                                                                                                              | Yes (GAP-176)                   | P2                                                                                                              |
| M6                                                                                | M30                                                  | DeathDischargeReader to HVLDL / HCI-10 denominator; m6.discharge.death to mortality review                                                                                               | live                                                | `06-admission/seams/index.ts:205-208` registers over createDeathDischargeReader(db); `index.ts:5955,5992` into buildM30WorkerDeps; consumer `index.ts:8788`. Reader is org-wide, not per PE                                                                                                                                                                | Yes (GAP-162)                   | P2                                                                                                              |
| M8                                                                                | M30                                                  | SignedEncountersReader to HVLDL, HCI 2/8/9, SSVI, late-entry                                                                                                                             | live                                                | `index.ts:1575` Drizzle store; `08-encounters/seams/drizzle-store.ts:128-300`. HVLDL EVV numerator always 0 because encounter.evv_bracket_state never set to 'evv_present' (`drizzle-store.ts:270`; `encounters-route-service-db.ts:1699,1752`)                                                                                                          | Yes (GAP-070)                   | P1                                                                                                              |
| M1/M40-free                                                                       | M30                                                  | Provider-entity resolver (primaryProviderEntityId, org lister, subject-derived entity)                                                                                                   | live                                                | `bootstrap/provider-entity-resolver.ts:29-72`; `index.ts:4356-4368`, `:1625`, `:6011`. cahps ingest and QAPI program adoption still use the primary entity                                                                                                                                                                                               | Yes                             |                                                                                                                 |
| M30                                                                               | BullMQ workers                                       | Per-job withOrgContext on measure_recompute, outbreak_detection, risk_register_refresh, cahps_export                                                                                     | live                                                | `m30-jobs.ts:2317-2335, 2344-2362, 2378-2398, 2406-2433`; cron consumers use org-explicit ForOrg readers (`index.ts:5996-6003`) or withOrgContext                                                                                                                                                                                                            | Yes                             |                                                                                                                 |
| M26                                                                               | M36                                                  | Cap threshold crossing, year-close reminder and PS&R variance alerts                                                                                                                     | missing                                             | No M36 binding or dispatch for m26.cap.threshold_crossed; crons use NOOP outbox (`26-cap/jobs/index.ts:91`); alert codes unruled                                                                                                                                                                                                                               | Yes (GAP-040, GAP-041)          | P1                                                                                                              |
| M23/M25/M26/M27                                                                   | M36                                                  | Cron alert dispatchers (alertCode used as eventType) to platform alert_rule                                                                                                              | missing                                             | `index.ts:6162,6282,6600,6642` pass alertCode as eventType; 12+ codes have no seeded rule (`alert-rules.ts`, 94 rules via bun import)                                                                                                                                                                                                                        | Yes (GAP-035)                   | P1                                                                                                              |
| M12                                                                               | M27                                                  | DrugCostBillingReader                                                                                                                                                                    | missing                                             | `registry.ts:464-472` reservation; no registerSeam; consumer `index.ts:6190`                                                                                                                                                                                                                                                                                 | Yes (GAP-102)                   | P2                                                                                                              |
| M23                                                                               | M24/M28/M37                                          | ClaimReader (medicareSecondaryContext, FHIR Claim projection, gipDaysForPatientInPeriod)                                                                                                 | missing                                             | `registry.ts:600`; no registerSeam; `28-fhir/seams/consumed.ts:221`; `m24-medicare-primary-ack.ts:14-39`                                                                                                                                                                                                                                                   | Yes (GAP-126)                   | P2                                                                                                              |
| M26                                                                               | M23                                                  | m26.cap.projection_updated to M23 revalidate consumer                                                                                                                                    | stubbed                                             | `23-billing-medicare/consumers/subscription-map.ts:310-318` status deny_stub; `handlers.ts:560-566` throws ForwardSeamNotLandedError; not bound in `index.ts`                                                                                                                                                                                              | Yes (GAP-239)                   | P3                                                                                                              |
| M5/M6/M8/M16                                                                      | M27                                                  | S-3 statistics seams (service census, payer program, visits by discipline, bereavement census)                                                                                           | live                                                | `index.ts:6199-6211` buildM27StatisticsSeams with org-explicit ports; `27-cost-report/jobs/statistics-seams.ts:198`                                                                                                                                                                                                                                          | Yes                             |                                                                                                                 |
| M35/M34/M32/M29                                                                   | M33/M34/M35                                          | SubscriptionStateProvider, BillingStatusProvider, UsageMeteringIngest, PatientCounterProvider, RevenueMetricsProvider, PlanCatalogReader, OnboardingStatusProvider, AITokenMeterProvider | missing                                             | `registry.ts:627-689` (GAP-208 prior: dormant, no registration, no getSeam consumer); only deny-stubs registered                                                                                                                                                                                                                                               | Yes (GAP-181)                   | P3                                                                                                              |

## 5. Global / systemic findings

### 5.1 Build/test failures (code)

**No gaps found.** No worker reported a failing build, typecheck or test command attributable to a code defect, and the supplied fitness data lists no failing gate. No unit, integration or live suite was executed by any worker (read-only audit), so pass/fail of the test suites is **unverified**, not green. One caveat from the workers: `bun run build` completed in about 1s, which may be a `tsc` incremental-cache no-op; a clean rebuild was not forced. The one gate-class defect found in code is GAP-208 (the M35 Stripe webhook publishes no request schema, so `client:gen` types its body as `never`).

### 5.2 Test infrastructure failures

No test-infrastructure failures were supplied to this section (the test-infra input was empty). Limits that bound confidence:

- Live suites (`*.live.test.ts`) were not run by any worker (Docker and DB were off-limits). Every RLS, read-audit and cross-tenant claim rests on reading the suites and code, not on executed proof. The status-matrix Live column is a name-match heuristic, not executed proof.
- 336 skipped test files and 3824 skipped tests were reported by the test run; whether they are all live or DB-gated suites was not enumerated.
- Live suites mask production defects where they stub the real seam. GAP-001 is the clearest case: `apps/backend/__tests__/m2-link-redemption.live.test.ts:289-290` registers `caseload_membership` as `async () => true`. GAP-022 is the same pattern (live tests seed `prn_administration` by raw SQL, so the crons look green while production never writes the table). GAP-025 requires the live test to pass `M17_SYSTEM_USER_ID` so it reproduces production.
- RLS isolation suites omit owned tables: GAP-105 (M16, M17, M19), GAP-169 (M31), GAP-217 (M1, M4), GAP-235 (M21, M22, M23).
- `fk-index-coverage.live.test.ts` is the only FK-index enforcement and needs live Postgres; no static check exists, so current state is unverified.

### 5.3 Architecture-fitness failures (incl. green gates hiding gaps)

No gate failure was supplied. The following green gates are proxies that hide real gaps:

- **`arch:outbox-bindings`** proves binding to catalog agreement only, not emit to catalog and not that the composition root constructs the consumer. Events declared with `declaredConsumers: []` escape it: GAP-016 (M29 lab handshake), GAP-049 (all 21 `m30.*` events), GAP-167 (all 22 `m31.*` events), GAP-040/GAP-041 (M26 threshold alerts), GAP-125 (M23/M24/M25 never consume `m22.document.rendered`, declarations were removed rather than bound), GAP-133 and GAP-179 (catalogued events with no emit site), GAP-150 (M27 handlers with no binding).
- **`arch:abac-composed`** reports `192 declared - 165 composed by requireAbac - 27 allowlisted` and is green only because the allowlist carries reasons. Open gaps behind it: GAP-123, GAP-197. GAP-244 shows an unused `PERIOD_ACTIVE` wrapper still counts as composed. `PermissionDef.abac` is a declaration only, which hides GAP-107, GAP-114, GAP-191, GAP-232, GAP-241.
- **Read-audit coverage gate** (`DEFAULT_READ_AUDIT_PREFIXES`) is an explicit allowlist of prefixes. Routes outside it need no `auditRead` and boot silently: GAP-044, GAP-045 (`/api/clinical`), GAP-064, GAP-188 (`/api/v1/messaging`, `/api/v1/alerts`), GAP-221, GAP-243. Routes inside it pass with a config that has no `resourceIdParam`, so the audit insert fails on the uuid cast and is swallowed: GAP-034, GAP-055, GAP-092, GAP-168, GAP-249.
- **`status:matrix`** reports all modules Implemented and counts registered routes, not spec rows or bound seams (see the stub and seam categories in §3, for example GAP-058, GAP-059, GAP-062, GAP-181).
- **`ui:parity` / `check-ui-screens`** validate only that a `built` row cites a registered screen set, so read-only, search-only and placeholder surfaces pass as built: GAP-205 and the UI gaps GAP-048, GAP-054, GAP-098, GAP-146, GAP-151, GAP-155, GAP-159, GAP-175, GAP-180, GAP-189, GAP-192, GAP-195, GAP-202, GAP-203.
- **`arch:openapi-coverage`** counts shallow entries as enriched: GAP-101 (17 M12 mutating routes with no response schema), GAP-207, GAP-208.
- **`check-fitness-gaps` PHI trigger guard** (`scripts/check-fitness-gaps.ts:196-206`) uses an unbounded corpus-wide regex that can pass without a real per-table trigger; an independent scan found no missing trigger, so no gap is reported, but the gate is a weak proxy.
- **`arch:fitness` and doc gates** do not scan `docs/history` (GAP-211), docs for banned GUC names (GAP-071) or cited code paths in module specs (GAP-212).

**Recurring defect patterns (fix as sweeps):**

- *Client-supplied value trusted as authority:* GAP-009 (`bypassMatchReview`), GAP-011 (`signerRole`), GAP-012 (`requiredSignerSet`), GAP-015 (`adminOverride`, `targetDate`), GAP-017 (`receivedAt`), GAP-031 (`biometricVerificationToken`), GAP-060 (`stripePaymentMethodId`), GAP-066 (`revokedByKind`), GAP-117 (`lastKnownVisitId`), GAP-119 (`patientId`), GAP-137 (appeal `documentId`), GAP-153 (`acceptedAggregateId`), GAP-174 (`patientIds`).
- *Constant BullMQ `jobId` retained after completion:* GAP-042, GAP-047.
- *Unbound vendor transport or deny stub in production:* GAP-028, GAP-051, GAP-056, GAP-058, GAP-062, GAP-063, GAP-074, GAP-149, GAP-156, GAP-173.
- *Alert code emitted with no seeded `alert_rule`, so zero recipients:* GAP-035, GAP-057, GAP-068, GAP-196.
- *Worker or queue declared but never constructed:* GAP-059, GAP-132, GAP-145, GAP-170, GAP-171, GAP-187, GAP-236, GAP-247, GAP-248.
- *Reads missing caseload or provider-entity scope:* GAP-107, GAP-114, GAP-124, GAP-128, GAP-129, GAP-191, GAP-222, GAP-241.
- *In-memory fallback spread into a Drizzle store:* GAP-069, GAP-070.

### 5.4 Security / compliance

No P0 security gap was supplied. Items needing action before certification:

- **Authentication and MFA (HIPAA 164.312(d)):** GAP-002 and GAP-004 (no authentication audit trail), GAP-003 and GAP-005 (MFA not enforced server-side for staff roles), GAP-078 (login-MFA step-up init never called), GAP-076, GAP-075.
- **Authorization and tenancy:** GAP-001, GAP-006, GAP-007, GAP-073, GAP-082, GAP-079, GAP-050, GAP-065, GAP-166.
- **Audit completeness and legal hold:** GAP-008 (legal-hold supremacy incomplete), GAP-072, GAP-186, GAP-194, GAP-140, plus the read-audit family listed in §5.3 (GAP-034, GAP-044, GAP-045, GAP-055, GAP-064, GAP-092, GAP-120, GAP-131, GAP-168, GAP-188, GAP-221, GAP-243, GAP-249).
- **Integrity of clinical and billing facts:** GAP-009, GAP-011, GAP-012, GAP-013, GAP-014, GAP-015, GAP-017, GAP-030, GAP-031, GAP-060, GAP-061, GAP-066, GAP-100, GAP-190.
- **PHI exposure and storage:** GAP-206 (step-up drafts in `sessionStorage` not cleared at sign-out), GAP-218 (idempotency replay precedes route authorization and is not bound to user, method or path), GAP-164 (halt-recording only flips a flag), GAP-174, GAP-253 (`DOCUMENT_UPLOAD_SCAN_REQUIRED` defaults to false and is undocumented).
- **Checklist of prior controls:** not re-run by this section; no regression of a prior control was reported in the supplied data. Idempotency cache storage of PHI response bodies, break-glass bypass under 42 CFR Part 2 and TLS/HSTS posture are listed in §7 as unverified.

### 5.5 Documentation drift

GAP-071, GAP-083 (stale header), GAP-087, GAP-170 (stale deferral text), GAP-205, GAP-209, GAP-210, GAP-211, GAP-212, GAP-215, GAP-224, GAP-228, GAP-230, GAP-240, GAP-244, GAP-247, GAP-252, GAP-253. Counts hand-mirrored from generated reports (GAP-209) are the same failure mode CLAUDE.md warns about. About 600 TODO or "lands" comments exist in code; only a sample was triaged (GAP-252).

### 5.6 Discovered gaps

GAP-025 (reassignment-scan and caregiver-reminder crons run with a sentinel actor, so the audit trigger FK can fail), GAP-219 (invitation accept is not atomic), GAP-246 (minor M31 drift: org-wide invitation list, fabricated `invitedAt`, 200 `not_found` replies, synthetic SMART session id, blanket 501 mapping). Related cross-cutting finds recorded in other categories: GAP-069, GAP-070 (in-memory seam fallbacks), GAP-179 (catalogued events never emitted), GAP-253 (undocumented operational env vars).

## 6. Remediation backlog

Ordered P0 to P3 (no P0 was reported); within a severity, by gap id. Sweep the §5.3 patterns as single changes where possible: client-trusted values, constant BullMQ jobIds, read-audit `resourceIdParam`, unseeded alert rules.

| #   | ID      | Sev | Task                                                                                                                                                                                    | File(s)                                                                                                                                                                                                                           | Done when                                                                                                                                                   | Verify                                                                                                   |
| --- | ------- | --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 1   | GAP-001 | P1  | Make M5`caseload_membership` accept `{patientId}` targets and drop the live-suite allow-all stub                                                                                    | `apps/backend/src/modules/05-patient/seams/caseload-provider.ts`, `apps/backend/src/modules/02-identity/routes/link-routes.ts`, `apps/backend/__tests__/m2-link-redemption.live.test.ts`                                    | Predicate accepts`patientId` and `id`; live suite uses the real registered predicate                                                                    | Boot with real M5 seams, POST`/api/v1/collaborators/invite` as assigned RN returns non-403             |
| 2   | GAP-002 | P1  | Register and emit auth.*, passkey.*, session.revoked audit actions                                                                                                                    | `packages/auth/src/identity/mount.ts`, `packages/auth/src/identity/auth.ts`, `packages/audit/src/actions/m2.ts`                                                                                                             | Actions in M4 catalog; emitted from Better Auth hooks and throttle lockout, with ip prefix and no secrets                                                   | Wrong then right sign-in;`/api/v1/audit/events?eventType=auth.login_failed` returns rows               |
| 3   | GAP-003 | P1  | Hold session at MFA-enrolment stage until the role-required factor exists; configure or document email verification                                                                     | `packages/auth/src/identity/auth.ts`, `apps/backend/src/bootstrap/plugins/authenticate.ts`                                                                                                                                    | Staff session without a factor cannot reach clinical routes; verify-email model configured or documented in spec                                            | Invited clinician with no 2FA signs in and clinical route call is refused                                |
| 4   | GAP-004 | P1  | Write spec'd auth.* audit events from the identity auth bridge                                                                                                                          | `packages/auth/src/identity/mount.ts`, `apps/backend/src/modules/02-identity/audit/identity-audit.ts`                                                                                                                         | 401 sign-in writes`auth.login_failed` with emailHash; lockout writes `auth.account_locked`; 200 writes `auth.login_succeeded`                         | Non-live inject test with stub auth handler                                                              |
| 5   | GAP-005 | P1  | Enforce the MFA matrix before org binding and block two-factor/disable for required roles                                                                                               | `apps/backend/src/modules/02-identity/routes/identity-routes.ts`, `packages/auth/src/identity/auth.ts`                                                                                                                        | `select-organization` answers 403 MFA_ENROLMENT_REQUIRED; disable returns 403 for required roles                                                          | Live auth suite: org_admin without TOTP/passkey cannot select org                                        |
| 6   | GAP-006 | P1  | Materialize role templates and default grants per tenant; attach org_admin to first-admin invite                                                                                        | `apps/backend/src/modules/03-authorization/role-store.ts`, `apps/backend/src/index.ts`, `scripts/db/sync-permission-catalog.ts`                                                                                             | Provision, accept first-admin invite,`/me/permissions` non-empty; backfill covers existing orgs                                                           | `SELECT count(*) FROM role WHERE organization_id = <new org>` is above 0                               |
| 7   | GAP-007 | P1  | Include`membership_role.scope` in ABAC context; validate scope and expiry on assignment                                                                                               | `apps/backend/src/modules/03-authorization/routes/authz-routes.ts`, `packages/auth/src/rbac/drizzle-store.ts`                                                                                                                 | Scoped grants intersect provider-entity and location predicates; wider scope rejected; time-bound roles require`expires_at`                               | Assign role with`{locationIds:[X]}`; permissions change for locations outside X                        |
| 8   | GAP-008 | P1  | Evaluate legal holds structurally and bind HoldApplier consumers                                                                                                                        | `apps/backend/src/modules/04-audit/erasers/audit-eraser.ts`, `apps/backend/src/modules/04-audit/routes/legal-holds.ts`, `apps/backend/src/modules/04-audit/routes/destruction-certificates.ts`                              | Date-range and resource-kind holds block erase at execute; holds re-checked in sweep; live tests added                                                      | Hold`{resourceKinds:['patient_address']}`, approve and execute certificate: rows survive               |
| 9   | GAP-009 | P1  | Require`patient.create_bypass_match`, step-up and critical audit when `bypassMatchReview` is set                                                                                    | `apps/backend/src/modules/05-patient/routes/patient-routes.ts`, `apps/backend/src/modules/05-patient/patient-route-service-db.ts`                                                                                             | Plain`patient.create` holder gets 403 with the flag; critical `patient.create_bypass_match` event emitted                                               | POST`/api/v1/patients` twice with `bypassMatchReview:true`; second returns 403                       |
| 10  | GAP-010 | P1  | Feed matcher full candidate data; persist or reject ssn/address/phone/email on admit                                                                                                    | `apps/backend/src/modules/05-patient/patient-route-service-db.ts`, `apps/backend/src/modules/05-patient/matching/matcher.ts`                                                                                                  | Same name/DOB/address admit returns 409; near-match returns`matchReviewIds`; unpersisted fields return 422                                                | `runMatch` with real candidate shape can reach `soft_review`; live admit twice without MBI           |
| 11  | GAP-011 | P1  | Bind signer slot to caller and add unique index on membership per version                                                                                                               | `apps/backend/src/modules/07-care-plan/care-plan-route-service-db.ts`, `apps/backend/src/modules/07-care-plan/abac-predicates.ts`, `packages/db/migrations`                                                                 | 403 SIGNER_ROLE_MISMATCH for roles not held; 409 for second signature by same membership                                                                    | Route test with rn_case_manager posting three signer roles; live suite asserts index                     |
| 12  | GAP-012 | P1  | Validate`requiredSignerSet` as a superset of the floor or drop the override                                                                                                           | `apps/backend/src/modules/07-care-plan/care-plan-route-service-db.ts`, `apps/backend/src/modules/07-care-plan/routes/care-plan-typebox.ts`                                                                                    | Sets missing a floor slot are refused; tightening comes from tenant config                                                                                  | Finalize with`[{rn_case_manager,1},{chaplain,1}]` returns 422/409; floor plus msw passes               |
| 13  | GAP-013 | P1  | Compute and persist late-entry tier at finalize and sign; enforce reason and overrides                                                                                                  | `apps/backend/src/modules/08-encounters/encounters-route-service-db.ts`, `apps/backend/src/modules/08-encounters/late-entry/tiers.ts`                                                                                         | Tier persisted and carried on`m8.encounter.signed`; reason of 40+ chars required; higher tiers need attested override                                     | 5-day-old encounter returns 422 until override; 20 days needs administrative override                    |
| 14  | GAP-014 | P1  | Add step-up and caseload scope to the three override routes                                                                                                                             | `apps/backend/src/modules/08-encounters/routes/encounters-routes.ts`                                                                                                                                                            | Late-entry, administrative and supervisor-release overrides compose STEP_UP and SCOPE_FOR                                                                   | Stale step-up returns STEP_UP_REQUIRED on each route; out-of-caseload supervisor gets 404                |
| 15  | GAP-015 | P1  | Remove public`adminOverride`; gate on `hope.admin.late_deadline_override` and classify against server time                                                                          | `apps/backend/src/modules/10-hope/routes/hope-routes.ts`, `apps/backend/src/modules/10-hope/hope-route-service-db.ts`, `packages/hope/src/recording/timepoint-gate.ts`                                                      | Override needs the permission plus audited justification; was_late cannot be self-declared                                                                  | RN with`adminOverride:true` past deadline gets 409 M10_TIMEPOINT_EXPIRED                               |
| 16  | GAP-016 | P1  | Build and bind the lab-results-applier consumer; declare m11 as consumer; emit results events                                                                                           | `apps/backend/src/modules/11-orders`, `apps/backend/src/modules/29-external-interfaces/events-by-m29.ts`, `apps/backend/src/index.ts`                                                                                       | `results_status` flips on `m29.lab_observation.attached`; `results_received` and `_critical` emitted; real-publisher live suite added               | Grep for writers of`results_status` and emitters; attach then render live                              |
| 17  | GAP-017 | P1  | Bound`receivedAt` against server time and add DB CHECK                                                                                                                                | `apps/backend/src/modules/11-orders/orders-route-service-db.ts`, `packages/orders/src/lifecycle/verbal-window.ts`, `packages/db/migrations`                                                                                 | Future and over-aged`receivedAt` rejected on M11 routes, M12 verbal route and seam                                                                        | Route test posting a future and a stale`receivedAt`                                                    |
| 18  | GAP-018 | P1  | Call`signOrderTarget` in the medication-order sign transaction                                                                                                                        | `apps/backend/src/modules/12-dosespot/dosespot-route-service-db.ts`                                                                                                                                                             | `order_signature` row with signer, role, attestation and server time exists for every signed prescription; same for signControlledComplete and retransmit | Grep`getOrderSignatureProvider` usage; sign order and query signature row                              |
| 19  | GAP-019 | P1  | Replace rx-benefit stub with cache read and explicit unknown                                                                                                                            | `apps/backend/src/modules/12-dosespot/dosespot-route-service-db.ts`, `apps/backend/src/modules/12-dosespot/routes/dosespot-routes.ts`, `scripts/openapi/enrichments.ts`                                                     | Route reads fresh tenant-scoped`rx_benefit_cache` or returns `{status:'unknown'}`/503; never fabricates covered; OpenAPI status fixed                   | Grep for all rxBenefit readers; call route with empty cache                                              |
| 20  | GAP-020 | P1  | Run five-rights check and real BCMA context in the production eMAR write path                                                                                                           | `apps/backend/src/modules/13-emar/emar-route-service-db.ts`, `packages/emar/src/barcode/barcode-match.ts`                                                                                                                     | `assertFiveRights` called in recordAdministration, recordCaregiverAttested, offlineSync; wrong-route or over-dose returns 422 FIVE_RIGHTS_VIOLATION       | Live test with wrong-route and over-dose requests                                                        |
| 21  | GAP-021 | P1  | Wire`assertPrnInterval` into PRN administration                                                                                                                                       | `apps/backend/src/modules/13-emar/emar-route-service-db.ts`, `packages/emar/src/prn/interval.ts`                                                                                                                              | Prior PRN dose loaded and interval enforced with 422; violation audit emitted                                                                               | Grep for callers; record two PRN doses inside the interval                                               |
| 22  | GAP-022 | P1  | Insert`prn_administration` in the administration transaction                                                                                                                          | `apps/backend/src/modules/13-emar/emar-route-service-db.ts`                                                                                                                                                                     | Row written with policy window and recommended scale; event carries real row id                                                                             | Record PRN dose via route, then run sweep live                                                           |
| 23  | GAP-023 | P1  | Guard reconciliation finalize, void and decisions by status and require all lines decided                                                                                               | `apps/backend/src/modules/13-emar/emar-route-service-db.ts`, `packages/emar/src/reconciliation/reconciliation.ts`                                                                                                             | `finalizeReconciliationWorksheet` used; terminal-status guards added; real userId on caregiver lines                                                      | Finalize twice and void a finalized worksheet are refused                                                |
| 24  | GAP-024 | P1  | Fix intentional-hold: status and grace guard, persist reason, add ABAC floor                                                                                                            | `apps/backend/src/modules/13-emar/emar-route-service-db.ts`, `apps/backend/src/modules/13-emar/routes/emar-routes.ts`                                                                                                         | Only pending doses within grace;`missed_dose` row with reason; `administering_clinician_eligible` guard added                                           | Hold an administered dose returns 409; reason appears in event                                           |
| 25  | GAP-025 | P1  | Use`orgContextFor` for reassignment-scan and caregiver-reminder crons                                                                                                                 | `apps/backend/src/modules/17-scheduling/scheduling-route-service-db.ts`                                                                                                                                                         | Lines 1923 and 1934 use`orgContextFor(orgId, userId)`; live test passes `M17_SYSTEM_USER_ID`                                                            | Run reassignment scan with due visit; no 23503                                                           |
| 26  | GAP-026 | P1  | Persist all recurring-visit fields the schema requires                                                                                                                                  | `apps/backend/src/modules/17-scheduling/scheduling-route-service-db.ts`, `apps/backend/src/modules/17-scheduling/routes/scheduling-routes.ts`                                                                                 | Window, tz, dates, count, byday and address round-trip; endDate-xor-count enforced                                                                          | Contract test creating and reading a policy                                                              |
| 27  | GAP-027 | P1  | Resolve`serviceTypeCode` and posting discipline server-side at EVV capture                                                                                                            | `apps/backend/src/modules/18-evv/evv-route-service-db.ts`, `apps/backend/src/modules/18-evv/routes/evv-routes.ts`                                                                                                             | Capture fails if unresolved; adapter payload builder rejects empty code                                                                                     | Capture then inspect submission payload code                                                             |
| 28  | GAP-028 | P1  | Bind Sandata transport, credential store, state-id reader and NPI source (or record launch-state decision)                                                                              | `apps/backend/src/modules/18-evv/jobs/wiring.ts`, `apps/backend/src/index.ts`                                                                                                                                                 | Production deps are non-deny; submission path can succeed                                                                                                   | Read wiring and index call; submit against sandbox                                                       |
| 29  | GAP-029 | P1  | Implement M17 on-call roster source and reader (or move ownership to M19 and amend specs)                                                                                               | `apps/backend/src/modules/17-scheduling/seams/drizzle-store.ts`, `apps/backend/src/modules/19-oncall/jobs/reconcile.ts`                                                                                                       | `tonightsOnCallRoster` returns data; M19 roster-sync creates shifts                                                                                       | Roster sync on DB boot yields non-empty plan                                                             |
| 30  | GAP-030 | P1  | Bind check-in schedule update to posting clinician and actionable state                                                                                                                 | `apps/backend/src/modules/20-field-safety/routes/write-service-drizzle.ts`                                                                                                                                                      | UPDATE has`clinician_membership_id` and state predicates; zero-row match returns 404/403; `scheduleClosed` from returned rows                           | Live test: clinician B posts against A's overdue scheduleId                                              |
| 31  | GAP-031 | P1  | Verify SOS cancel biometric token server-side                                                                                                                                           | `apps/backend/src/modules/20-field-safety/routes/write-service-drizzle.ts`, `apps/backend/src/modules/20-field-safety/routes/m20-typebox.ts`                                                                                  | Verdict derived from server-stamped attribute or M2 verifier; unverifiable token treated as failed                                                          | Test that arbitrary string is rejected                                                                   |
| 32  | GAP-032 | P1  | Implement emergency terminus effects or a critical page-ops alert at tier-3 breach                                                                                                      | `apps/backend/src/modules/20-field-safety/jobs/cron-workers.ts`, `apps/backend/src/modules/20-field-safety/routes/effects-runner.ts`                                                                                          | Dial, PSAP and page effects have implementers; tier-3 breach transitions                                                                                    | Live test of unacknowledged SOS running to terminus                                                      |
| 33  | GAP-033 | P1  | Register PDF builders for all 50 templates or fail render closed                                                                                                                        | `apps/backend/src/modules/22-documents/seams/renderer.ts`, `apps/backend/src/modules/22-documents/render-pdf/registry.ts`                                                                                                     | Every`PLATFORM_TEMPLATE_TABLE` key has a builder; output parses as PDF; missing builder yields `render_failed`                                          | Test comparing template keys to registry keys                                                            |
| 34  | GAP-034 | P1  | Add patient attribution to the two eligibility read-audit configs                                                                                                                       | `apps/backend/src/modules/23-billing-medicare/routes/eligibility.routes.ts`                                                                                                                                                     | `patientIdQueryParam` or `resourceIdParam` set; live assertion that read event lands                                                                    | Read both routes and query`audit_event`                                                                |
| 35  | GAP-035 | P1  | Seed alert rules for emitted M23/M25/M26/M27 codes and add a gate                                                                                                                       | `packages/messaging/src/seed/alert-rules.ts`, `apps/backend/src/modules/23-billing-medicare/jobs/m23-jobs.ts`                                                                                                                 | Every emitted`eventType` has a seeded rule; gate fails on mismatch including template codes                                                               | Diff emit-site eventType set against`PLATFORM_DEFAULT_ALERT_RULES`; NOE past window yields recipients  |
| 36  | GAP-036 | P1  | Define and populate`AppealPacketRenderPayload` and add an appeal_packet builder                                                                                                       | `apps/backend/src/modules/25-remittance/routes/write-service-drizzle.ts`, `packages/forms`, `apps/backend/src/modules/22-documents/outbox-consumers/render-consumer.ts`                                                     | Payload carries narrative, claim/remit refs and document index; validated at M22 boundary                                                                   | Submit appeal and inspect render payload                                                                 |
| 37  | GAP-037 | P1  | Persist per-patient`patient_aggregate` projection snapshots; return null when none                                                                                                    | `apps/backend/src/modules/26-cap/routes/write-service-drizzle.ts`, `apps/backend/src/modules/26-cap/seam-impls.ts`                                                                                                            | recompute iterates accrual rows honoring deceasedAt and methodologyWeight                                                                                   | Accrual near cap then recompute yields`scope='patient_aggregate'` row                                  |
| 38  | GAP-038 | P1  | Write`total_patient_days` and supply RHC differential                                                                                                                                 | `apps/backend/src/modules/26-cap/consumers/drizzle-store.ts`, `apps/backend/src/modules/26-cap/routes/write-service-drizzle.ts`, `apps/backend/src/modules/26-cap/seam-impls.ts`                                            | Denominator sourced from M6/M23; inpatient pctOfCap above 0; hard-coded zeros removed                                                                       | GIP plus routine days then recompute shows band transitions at 18/20%                                    |
| 39  | GAP-039 | P1  | Fix methodology-lock deadlock                                                                                                                                                           | `apps/backend/src/modules/26-cap/abac-predicates.ts`, `apps/backend/src/modules/26-cap/routes/write-service-drizzle.ts`                                                                                                       | Methodology required at open or lockable before first accrual; null-methodology period has escape path                                                      | Open without methodology, accrue, recompute, then lock succeeds and settlement proposes                  |
| 40  | GAP-040 | P1  | Add M36 consumer for`m26.cap.threshold_crossed` and build missing workers                                                                                                             | `apps/backend/src/modules/26-cap/events-by-m26.ts`, `apps/backend/src/modules/26-cap/jobs/index.ts`                                                                                                                           | Cap alert reaches`cap.event.read` holders with retry; threshold-evaluator and constant-refresh workers built or spec amended                              | Cross a band live and assert M36 notification row                                                        |
| 41  | GAP-041 | P1  | Pass real outbox publisher to M26 cron write service and dispatch band alerts                                                                                                           | `apps/backend/src/modules/26-cap/jobs/index.ts`, `apps/backend/src/modules/26-cap/routes/write-service-drizzle.ts`                                                                                                            | Nightly events reach outbox;`computedBy` accurate; per-band rules seeded                                                                                  | Nightly recompute crossing watch_90 produces outbox row and alert                                        |
| 42  | GAP-042 | P1  | Add time bucket, hash or request id to M27 BullMQ jobIds                                                                                                                                | `apps/backend/src/modules/27-cost-report/wiring.ts`, `apps/backend/src/modules/27-cost-report/routes/write-service-drizzle.ts`                                                                                                | Re-triggers after completion or failure run                                                                                                                 | Enqueue allocate twice with worker running; second creates a new job                                     |
| 43  | GAP-043 | P1  | Run feed health prober that writes`external_feed_health` and emits listener events                                                                                                    | `apps/backend/src/modules/29-external-interfaces/listener/circuit-breaker.ts`, `apps/backend/src/modules/29-external-interfaces/routes/store-drizzle.ts`                                                                      | Hourly rows recorded;`evaluateListenerCircuit` called; listener_down/recovered emitted                                                                    | Silence a feed for 5+ min and observe event and M36 alert                                                |
| 44  | GAP-044 | P1  | Add auditRead to M29 GET routes and both prefixes to the coverage gate                                                                                                                  | `apps/backend/src/bootstrap/index.ts`, `apps/backend/src/modules/29-external-interfaces/routes/labs.routes.ts`, `apps/backend/src/modules/29-external-interfaces/routes/proposal.routes.ts`                                 | Routes emit or waive read-audit; unannotated routes refuse to boot                                                                                          | Boot with prefixes; read observation and assert`audit_event` row                                       |
| 45  | GAP-045 | P1  | Add auditRead to the three lab routes and`/api/clinical` prefix                                                                                                                       | `apps/backend/src/modules/29-external-interfaces/routes/labs.routes.ts`, `apps/backend/src/bootstrap/index.ts`                                                                                                                | `ReadAuditCoverageError` for undeclared `/api/clinical` GET; 200 writes read event with patient_id                                                      | Unit test on buildServer; inject test on observation read                                                |
| 46  | GAP-046 | P1  | Implement pending-close plus nominee confirmation in nominee's own step-up session; restore DB co-sign check                                                                            | `apps/backend/src/modules/30-quality/routes/close-cosign.ts`, `packages/db/migrations/0335_m30_closure_nominee_marker.sql`                                                                                                    | Close stays pending until second member confirms; V-11/V-12 restored                                                                                        | Close PIP with one session; remains pending                                                              |
| 47  | GAP-047 | P1  | Add period, version or request id to M30 recompute and risk-register jobIds                                                                                                             | `apps/backend/src/modules/30-quality/routes/write-service-drizzle.ts`, `apps/backend/src/modules/30-quality/wiring.ts`                                                                                                        | Repeat recompute and refresh run after first completion                                                                                                     | POST`/quality/measures/recompute` twice                                                                |
| 48  | GAP-048 | P1  | Build incident, SRA, CAHPS, infection, QAPI and risk-register write UI or mark specs partial                                                                                            | `apps/web/src/modules/30-quality/screens.ts`, `docs/design/SCREEN_SPEC_STATUS.md`                                                                                                                                             | 31 uncalled mutating ops have callers or specs re-labelled partial with exact missing surfaces                                                              | Script diff of`docs/api/openapi.json` against SPA callers                                              |
| 49  | GAP-049 | P1  | Add M36 consumers for sentinel, abuse, outbreak, threshold and CAHPS events; add overdue sweeps                                                                                         | `apps/backend/src/modules/30-quality/events-by-m30.ts`, `apps/backend/src/modules/36-messaging/outbox-consumers`, `packages/quality/src/alert-defs.ts`                                                                      | Alerts fire with recipients;`declaredConsumers` set truthfully; mortality and CoP sweeps exist                                                            | Submit sentinel incident; alert and delivery rows exist                                                  |
| 50  | GAP-050 | P1  | Require account active in portal grant predicate and revoke sessions on suspend                                                                                                         | `apps/backend/src/modules/31-portal/abac-predicates.ts`, `apps/backend/src/modules/31-portal/routes/store.ts`                                                                                                                 | Suspended account gets 403 on PHI and telehealth routes                                                                                                     | Suspend account with live session;`GET /api/v1/portal/care-summary` returns 403                        |
| 51  | GAP-051 | P1  | Bind telehealth vendor adapter with per-tenant key store                                                                                                                                | `apps/backend/src/index.ts`, `apps/backend/src/modules/31-portal/routes/telehealth.routes.ts`                                                                                                                                 | Join, start-recording and webhooks work with a real adapter                                                                                                 | Clinician join on booted stack no longer 503                                                             |
| 52  | GAP-052 | P1  | Implement`disclosuresForPatient` and the patient access-log route and export                                                                                                          | `apps/backend/src/modules/31-portal/routes/store.ts`                                                                                                                                                                            | Provider returns`audit_event`/`document_access_log` rows; route and export exist                                                                        | After portal download, seam returns the row                                                              |
| 53  | GAP-053 | P1  | Mount vendor SDK in telehealth waiting room or mark screen deferred                                                                                                                     | `apps/portal/src/screens/telehealth-waiting-room.tsx`, `docs/design/SCREEN_SPEC_STATUS.md`                                                                                                                                    | SDK mounted using join ticket with controls, or status corrected                                                                                            | Read screen and package.json; grep SDK usage                                                             |
| 54  | GAP-054 | P1  | Add staff portal-admin and clinician telehealth screens or record deferral                                                                                                              | `apps/web/src/modules/*/screens.ts`, `apps/admin/src/modules/*/screens.ts`, `docs/design/SCREEN_SPEC_STATUS.md`                                                                                                             | Listed routes have callers or documented deferral                                                                                                           | grep for portal-accounts and collaborators/invite in SPAs                                                |
| 55  | GAP-055 | P1  | Fix AI invocation read-audit configs                                                                                                                                                    | `apps/backend/src/modules/32-ai-platform/routes/invocations.routes.ts`                                                                                                                                                          | R16`list:true`; R17 `resourceIdParam:'invocationId'` and `patientIdPayloadPath`; live test asserts event                                              | GET`/api/v1/ai/invocations/<id>` then query `audit_event`                                            |
| 56  | GAP-056 | P1  | Bind drilldown encryption over`getTenantKeyProvider().dekForOrg`                                                                                                                      | `apps/backend/src/modules/33-reporting/wiring.ts`, `apps/backend/src/modules/33-reporting/jobs/m33-jobs.ts`                                                                                                                   | Drilldown emit and flush worker succeed                                                                                                                     | POST`/api/v1/reporting/drilldown/emit` with valid tile no longer 500                                   |
| 57  | GAP-057 | P1  | Register M34 alert resolvers at boot and seed all M34 rules                                                                                                                             | `apps/backend/src/modules/34-saas-tenant-platform/alert-rules.ts`, `apps/backend/src/index.ts`                                                                                                                                | `registerM34AlertResolvers` called after resolver registry; built-in-only filter removed; live suite asserts notification row                             | Grep call sites; emit`m34.tenant.shred_pending_approval`                                               |
| 58  | GAP-058 | P1  | Bind Stripe webhook ingest with raw-body parser and run dispatcher                                                                                                                      | `apps/backend/src/index.ts`, `apps/backend/src/modules/35-subscription/routes/webhooks.routes.ts`                                                                                                                             | Webhook verifies and ingests; dispatcher worker consumes`m35.stripe.*`                                                                                    | POST`/api/v1/webhooks/stripe` no longer 503                                                            |
| 59  | GAP-059 | P1  | Build and register M35 worker set                                                                                                                                                       | `apps/backend/src/modules/35-subscription`, `apps/backend/src/index.ts`                                                                                                                                                       | Dunning, usage, reconciler, revenue snapshot and expiry workers run with org enumerator                                                                     | `grep -rn 'new Worker'` in module returns workers                                                      |
| 60  | GAP-060 | P1  | Verify payment-method id against completed SetupIntent and org ownership                                                                                                                | `apps/backend/src/modules/35-subscription/routes/service-drizzle.ts`, `apps/backend/src/modules/35-subscription/routes/subscription-typebox.ts`                                                                               | `pm_fake` refused; `createSubscription` validates org-owned payment method                                                                              | POST attach with`pm_fake` no longer 201                                                                |
| 61  | GAP-061 | P1  | Cap refund by amount paid and execute approved refunds                                                                                                                                  | `apps/backend/src/modules/35-subscription/routes/service-drizzle.ts`, `apps/backend/src/modules/35-subscription/events-by-m35.ts`                                                                                             | Over-cap and unpaid-invoice requests refused; executed/failed events emitted                                                                                | POST refund above`amountPaidCents` is rejected                                                         |
| 62  | GAP-062 | P1  | Bind real web-push, Twilio SMS/voice and Postmark transports                                                                                                                            | `apps/backend/src/index.ts`, `packages/messaging/src/dispatch/transports.ts`                                                                                                                                                  | Pending deliveries reach`sent` through vendor stub; boot warning while only deny transports bound                                                         | Live suite with vendor stub and webhook reconcile                                                        |
| 63  | GAP-063 | P1  | Bind`sendEndpointVerificationCode` or fail registration with 503                                                                                                                      | `apps/backend/src/modules/36-messaging/messaging-route-service-db.ts`, `apps/backend/src/modules/36-messaging/index.ts`                                                                                                       | SMS/email endpoints can become verified                                                                                                                     | grep for non-test bindings                                                                               |
| 64  | GAP-064 | P1  | Add messaging and alerts prefixes and auditRead configs                                                                                                                                 | `apps/backend/src/bootstrap/index.ts`, `apps/backend/src/modules/36-messaging/routes/messaging-routes.ts`                                                                                                                     | Channel, message and inbox reads emit audit with patient from care-team subject                                                                             | `grep -rn auditRead` in module; boot fails on undeclared GET                                           |
| 65  | GAP-065 | P1  | Consult M39 ConsentEvaluator in channel sync and view; stop attesting cascade until enforced                                                                                            | `apps/backend/src/modules/36-messaging/messaging-route-service-db.ts`, `apps/backend/src/modules/36-messaging/outbox-consumers/m39-consent-revoked.ts`                                                                        | Flagged patients' channels exclude non-consented members                                                                                                    | Read`canViewChannel` and consumer                                                                      |
| 66  | GAP-066 | P1  | Derive`revokedByKind` and `actorIsStaff` from session                                                                                                                               | `apps/backend/src/modules/39-consent/routes/consent-routes.ts`, `apps/backend/src/modules/39-consent/routes/consent-typebox.ts`                                                                                               | Staff cannot self-declare portal/dpoa/court kinds; break-glass kind restricted                                                                              | POST revoke as staff with`patient_self_via_portal` and empty reason is rejected                        |
| 67  | GAP-067 | P1  | Add M39 consumer for`m5.patient.merged` re-pointing consents                                                                                                                          | `apps/backend/src/modules/39-consent/consumers.ts`, `apps/backend/src/modules/05-patient/events-by-m5.ts`                                                                                                                     | Consent rows re-pointed to survivor;`m39.consent.repointed` emitted; live test                                                                            | grep`m5.patient.merged` bindings                                                                       |
| 68  | GAP-068 | P1  | Seed alert rule for`mdm.physician_deactivated`                                                                                                                                        | `packages/messaging/src/seed/alert-rules.ts`                                                                                                                                                                                    | Platform rule seeded and payload registered; live test shows recipient                                                                                      | grep seed file for the event                                                                             |
| 69  | GAP-069 | P1  | Implement Drizzle`renderPayload`, `mileageForClinician`, `insertDraftEncounter`                                                                                                   | `apps/backend/src/modules/08-encounters/seams/drizzle-store.ts`, `apps/backend/src/modules/19-oncall/clinical/encounter-link.ts`                                                                                              | No in-memory fallback spread; triage disposition yields real encounter row; actual miles non-zero                                                           | `select id from encounter where id = <linked_encounter_id>` returns a row                              |
| 70  | GAP-070 | P1  | Persist encounter EVV bracket state at finalize or sign with one NULL rule                                                                                                              | `apps/backend/src/modules/08-encounters/encounters-route-service-db.ts`, `apps/backend/src/modules/08-encounters/seams/drizzle-store.ts`                                                                                      | HVLDL numerator counts`evv_present`; reader and signed event agree                                                                                        | Sign encounter with check-in/out; reader returns`evv_present`                                          |
| 71  | GAP-071 | P2  | Correct banned GUC names in M29 task docs                                                                                                                                               | `docs/modules/module-29-tasks/WARDENX_T-29.02_SCHEMA_PACKAGE.md`, `docs/modules/module-29-tasks/WARDENX_T-29.11_SUD_HARDENING.md`, `docs/modules/module-29-tasks/WARDENX_T-29.10_CREDENTIAL_ROTATION.md`                    | Docs use`app.org_id` or carry a superseded banner                                                                                                         | `rg "app\.(organization_id\|current_organization_id)" docs/modules/module-29-tasks` shows no policy DDL |
| 72  | GAP-072 | P2  | Audit system-status changes with actor                                                                                                                                                  | `apps/backend/src/bootstrap/routes/system.ts`, `apps/backend/src/bootstrap/system-status-store.ts`                                                                                                                            | `system_status.changed` written; `updated_by` populated                                                                                                 | POST as platform_ops then query`audit_event`                                                           |
| 73  | GAP-073 | P2  | Require`collaborator.invite` permission                                                                                                                                               | `apps/backend/src/modules/02-identity/routes/link-routes.ts`                                                                                                                                                                    | `requirePermission("collaborator.invite")` precedes ABAC                                                                                                  | grep shows the guard; aide/volunteer call refused                                                        |
| 74  | GAP-074 | P2  | Bind`TaxIdCipherPort` over M34 key ring                                                                                                                                               | `apps/backend/src/index.ts`, `apps/backend/src/modules/02-identity/routes/org-admin-routes.ts`                                                                                                                                | POST`/api/v1/provider-entities` succeeds; live create-PE test                                                                                             | POST as org_admin no longer 503                                                                          |
| 75  | GAP-075 | P2  | Add session reaper and offboard/breach-check consumers or retire from spec                                                                                                              | `apps/backend/src/bootstrap/jobs`, `packages/auth/src/identity/session-timeout.ts`                                                                                                                                            | Expired sessions purged in batches                                                                                                                          | `SELECT count(*) FROM session WHERE expires_at < now() - interval '7 days'` stays bounded              |
| 76  | GAP-076 | P2  | Apply last-admin and self-deactivation guards and step-up to deactivate                                                                                                                 | `apps/backend/src/modules/02-identity/routes/identity-routes.ts`, `apps/backend/src/modules/02-identity/identity-stores-db.ts`                                                                                                | Sole org_admin cannot deactivate self                                                                                                                       | POST deactivate own id returns refusal                                                                   |
| 77  | GAP-077 | P2  | Validate and normalise invitation fields; align TTL; stop echoing token                                                                                                                 | `apps/backend/src/modules/02-identity/routes/identity-routes.ts`, `apps/backend/src/modules/02-identity/identity-stores-db.ts`                                                                                                | Email lowercased; location/PE ids validated (422 INVALID_LOCATION_SCOPE); TTL matches spec                                                                  | Two case-variant invites rejected; bad uuid returns 422                                                  |
| 78  | GAP-078 | P2  | Call`onLoginMfaCompleted` from two-factor/passkey completion hook                                                                                                                     | `apps/backend/src/modules/02-identity/hooks/login-mfa-completed.ts`, `packages/auth/src/identity/auth.ts`                                                                                                                     | `last_step_up_at` initialised after MFA login; live test                                                                                                  | Sign in with TOTP then GET`/api/v1/me/session` shows lastStepUpAt                                      |
| 79  | GAP-079 | P2  | Implement cross-tenant break-glass branch or amend spec; add deny-cosign                                                                                                                | `apps/backend/src/modules/03-authorization/break-glass-store.ts`, `apps/backend/src/modules/03-authorization/routes/authz-routes.ts`                                                                                          | `target_organization_id`/`consent_ref` written and double-audited; `denied` reachable                                                                 | grep`targetOrganizationId` finds producer                                                              |
| 80  | GAP-080 | P2  | Compute`resourcesTouched` from audit trail                                                                                                                                            | `apps/backend/src/modules/03-authorization/engagement-store.ts`                                                                                                                                                                 | Summary reflects touched resources                                                                                                                          | Auditor reads a chart; summary above 0                                                                   |
| 81  | GAP-081 | P2  | Use Valkey cache with 60s ceiling and publish invalidations                                                                                                                             | `packages/auth/src/rbac/resolve.ts`, `packages/auth/src/rbac/drizzle-store.ts`                                                                                                                                                | Out-of-band role changes invalidate within 60s                                                                                                              | Grant then revoke via SQL;`/me/permissions` updates                                                    |
| 82  | GAP-082 | P2  | Limit break-glass bypass to GET/HEAD guards by default                                                                                                                                  | `packages/auth/src/abac/require-abac.ts`                                                                                                                                                                                        | Mutating guards need explicit opt-in                                                                                                                        | Inject test: PATCH and merge on patient X refused under grant                                            |
| 83  | GAP-083 | P2  | Presign download URL for ready audit exports; fix stale header                                                                                                                          | `apps/backend/src/modules/04-audit/routes/audit-exports.ts`                                                                                                                                                                     | `downloadUrl` returned when status ready; download audited                                                                                                | Request export; GET returns`downloadUrl`                                                               |
| 84  | GAP-084 | P2  | Bind patient-merge consumers for M22 and M39; add live merge test                                                                                                                       | `apps/backend/src/modules/05-patient/merges-db.ts`, `apps/backend/src/modules/22-documents/lifecycle/merge-redirect.ts`, `apps/backend/src/modules/39-consent/consumers.ts`                                                 | Survivor sees source history; payload field names agree                                                                                                     | Merge then read survivor admissions, orders, documents, consents                                         |
| 85  | GAP-085 | P2  | Exclude merged from list/census; add MBI/DOB search; return mergedIntoId                                                                                                                | `apps/backend/src/modules/05-patient/patient-route-service-db.ts`                                                                                                                                                               | List excludes merged; GET of merged chart returns redirect field                                                                                            | Merge two patients then GET list and source                                                              |
| 86  | GAP-086 | P2  | Implement envelope-encrypted SSN/state_id path or descope in spec                                                                                                                       | `apps/backend/src/modules/05-patient/routes/lifecycle-routes.ts`, `apps/backend/src/modules/05-patient/patient-route-service-db.ts`                                                                                           | `phi.write_ssn`/`phi.read_ssn` routes exist or spec descoped                                                                                            | POST identifier kind ssn no longer 422                                                                   |
| 87  | GAP-087 | P2  | Update M5 and M2 spec route tables to as-built                                                                                                                                          | `docs/modules/WARDENX_MODULE_05_PATIENT_SPEC_v0_4.md`, `docs/modules/WARDENX_MODULE_02_IDENTITY_SPEC_v0_4.md`                                                                                                                 | Only true deferrals marked DEFERRED                                                                                                                         | Compare rows with route grep                                                                             |
| 88  | GAP-088 | P2  | Resolve org timezone in M6/M7 deadline math and F2F cron                                                                                                                                | `apps/backend/src/modules/06-admission/admission-route-service-db.ts`, `apps/backend/src/modules/06-admission/jobs/cron-workers.ts`, `apps/backend/src/modules/07-care-plan/care-plan-route-service-db.ts`                  | Deadlines land on org-local end-of-day                                                                                                                      | Unit tests for New_York and Honolulu orgs with DST fixture                                               |
| 89  | GAP-089 | P2  | Open compliance window at mark-late and guard CTI state                                                                                                                                 | `apps/backend/src/modules/06-admission/admission-route-service-db.ts`                                                                                                                                                           | Mark-late on signed/voided CTI returns 409; window escalates when overdue                                                                                   | Service test and escalation cron test                                                                    |
| 90  | GAP-090 | P2  | Implement or remove`effectiveStart` patch with status guard                                                                                                                           | `apps/backend/src/modules/06-admission/admission-route-service-db.ts`, `apps/backend/src/modules/06-admission/routes/admission-typebox.ts`                                                                                    | Pending period edit changes`effective_at`; active returns 409                                                                                             | Route test                                                                                               |
| 91  | GAP-091 | P2  | Scope problem and goalRefs lookups to the plan                                                                                                                                          | `apps/backend/src/modules/07-care-plan/care-plan-route-service-db.ts`                                                                                                                                                           | Cross-plan problemId returns 404; composite FK considered                                                                                                   | POST goal with problemId from plan B returns 404                                                         |
| 92  | GAP-092 | P2  | Add patient attribution to relevant-elements auditRead                                                                                                                                  | `apps/backend/src/modules/07-care-plan/routes/care-plan-routes.ts`                                                                                                                                                              | `patientIdQueryParam` set; live assertion that event lands                                                                                                | Live read-audit suite on private PG                                                                      |
| 93  | GAP-093 | P2  | Thread acting membership into encounter void                                                                                                                                            | `apps/backend/src/modules/08-encounters/encounters-route-service-db.ts`, `apps/backend/src/modules/08-encounters/routes/encounters-routes.ts`                                                                                 | `voided_by` and event carry the director                                                                                                                  | Director voids another author's draft                                                                    |
| 94  | GAP-094 | P2  | Call`checkVolunteerAssignment` in createDraft via M15 reader                                                                                                                          | `apps/backend/src/modules/08-encounters/encounters-route-service-db.ts`, `apps/backend/src/modules/08-encounters/lifecycle/validation.ts`                                                                                     | Volunteer visit without assignment returns 422 NO_VOLUNTEER_ASSIGNMENT                                                                                      | POST volunteer_visit with no assignment                                                                  |
| 95  | GAP-095 | P2  | Narrow cosignature queue to routed requests                                                                                                                                             | `apps/backend/src/modules/08-encounters/encounters-route-service-db.ts`, `apps/backend/src/modules/08-encounters/routes/encounters-routes.ts`                                                                                 | RN sees only routed items; supervisor sees team                                                                                                             | RN B with none routed gets empty queue                                                                   |
| 96  | GAP-096 | P2  | Align M10 spec with manual iQIES flow or schedule automated stages                                                                                                                      | `apps/backend/src/modules/10-hope/jobs/cron-workers.ts`, `docs/modules`                                                                                                                                                       | Spec/ADR matches as-built; alert dispatcher tracked as deferral                                                                                             | `docs:modules`/`arch:fitness` doc checks after update                                                |
| 97  | GAP-097 | P2  | Read Valkey suggestion projection in route and bind HOPE trigger                                                                                                                        | `apps/backend/src/modules/11-orders/orders-route-service-db.ts`, `scripts/outbox-subscription-exceptions.ts`                                                                                                                  | Suggestions route reflects state; exception entry removed                                                                                                   | grep Valkey key readers                                                                                  |
| 98  | GAP-098 | P2  | Wire standing-order lifecycle actions or mark spec partial                                                                                                                              | `apps/web/src/modules/11-orders/standing-orders.tsx`, `docs/design/SCREEN_SPEC_STATUS.md`                                                                                                                                     | Write routes have callers or status partial                                                                                                                 | Read screen; openapi diff                                                                                |
| 99  | GAP-099 | P2  | Add refill_inbox_policy and controlled_substance_policy tables; persist PATCH routes with step-up                                                                                       | `architecture/module-manifest.ts`, `apps/backend/src/modules/12-dosespot/dosespot-route-service-db.ts`, `apps/backend/src/modules/12-dosespot/routes/dosespot-routes.ts`                                                    | Tables with RLS in manifest (.ts and .cjs) and live RLS suite; PATCH persists; enroll and PATCH compose step-up; EPCS status route exists                   | grep migrations and manifest                                                                             |
| 100 | GAP-100 | P2  | Derive EPCS schedule, IAL2 and second factor from real data before enabling                                                                                                             | `apps/backend/src/modules/12-dosespot/dosespot-route-service-db.ts`                                                                                                                                                             | `epcs_signing_attempt` created with real nonce and verified factor; certification read per tenant                                                         | Code reading; EPCS stays OFF until done                                                                  |
| 101 | GAP-101 | P2  | Add response schemas for M12 and M14 mutations; ratchet missing responses                                                                                                               | `scripts/openapi/enrichments.ts`, `scripts/report-openapi-coverage.ts`                                                                                                                                                        | 17 M12 routes and 3 M14 routes have responses; ratchet counts them                                                                                          | Parse enrichment entries                                                                                 |
| 102 | GAP-102 | P2  | Register`DrugCostBillingReader` or drop rule and seam                                                                                                                                 | `apps/backend/src/bootstrap/seams/registry.ts`, `apps/backend/src/index.ts`                                                                                                                                                   | Cross-check no longer skips                                                                                                                                 | Cost-report validation shows drug-reconcile not 'skip'                                                   |
| 103 | GAP-103 | P2  | Fix caregiver-attested row identity and kit-return acknowledgment                                                                                                                       | `apps/backend/src/modules/13-emar/emar-route-service-db.ts`, `apps/backend/src/modules/13-emar/routes/emar-routes.ts`                                                                                                         | Real admission, drug and controlled flag; quantities, discrepancy event and supervisor floor on return                                                      | Code reading                                                                                             |
| 104 | GAP-104 | P2  | Add Idempotency-Key to listed M14 POST routes                                                                                                                                           | `apps/backend/src/modules/14-idg/routes/idg-routes.ts`                                                                                                                                                                          | All spec §4.1 POSTs require key                                                                                                                            | Retried POST decisions without key is refused                                                            |
| 105 | GAP-105 | P2  | Add three tables to M16/M17/M19 RLS isolation suites                                                                                                                                    | `packages/db/migrations/__tests__/m16-rls-isolation.live.test.ts`, `packages/db/migrations/__tests__/m17-rls-isolation.live.test.ts`, `packages/db/migrations/__tests__/m19-rls-isolation.live.test.ts`                     | Cross-tenant assertions for`bereavement_cop_opt_out_credit`, `membership_credential`, `on_call_roster_sync_queue`                                     | Scripted manifest vs suite compare                                                                       |
| 106 | GAP-106 | P2  | Derive visit window and address from proposal in publishProposal                                                                                                                        | `apps/backend/src/modules/17-scheduling/scheduling-route-service-db.ts`                                                                                                                                                         | Org-timezone window using duration; patient address resolved via M5                                                                                         | Read publishProposal and M18 baseline path                                                               |
| 107 | GAP-107 | P2  | Compose per-visit caseload_or_scope on visit/proposal/recurring write routes                                                                                                            | `apps/backend/src/modules/17-scheduling/routes/scheduling-routes.ts`                                                                                                                                                            | Writes and recurring list guarded like`VISIT_SCOPE`                                                                                                       | Read routes; test out-of-scope caller                                                                    |
| 108 | GAP-108 | P2  | Add status guard, If-Match and unassigned event to PATCH visit and reassign                                                                                                             | `apps/backend/src/modules/17-scheduling/scheduling-route-service-db.ts`                                                                                                                                                         | 412 on version mismatch; unassigned emitted for former assignee; notes persisted                                                                            | grep If-Match; service tests                                                                             |
| 109 | GAP-109 | P2  | Validate admission, patient, address and setting on visit create; persist opt-in                                                                                                        | `apps/backend/src/modules/17-scheduling/scheduling-route-service-db.ts`, `apps/backend/src/modules/17-scheduling/routes/scheduling-routes.ts`                                                                                 | Invalid combos refused;`caregiverReminderOptIn` stored                                                                                                    | Service tests                                                                                            |
| 110 | GAP-110 | P2  | Implement route-efficiency and m11/m14/m15 proposal producers or amend spec                                                                                                             | `apps/backend/src/modules/17-scheduling/scheduling-route-service-db.ts`, `apps/backend/src/modules/17-scheduling/consumers`                                                                                                   | Route returns data; proposal sources produced; stale transition exists                                                                                      | Read consumers; grep sources                                                                             |
| 111 | GAP-111 | P2  | Switch M17 audit triggers to 'compliance' class or amend spec                                                                                                                           | `packages/db/migrations/0045_scheduling_m17_rls_audit_triggers.sql`                                                                                                                                                             | New migration plus backfill, or spec corrected                                                                                                              | Read trigger SQL and spec header                                                                         |
| 112 | GAP-112 | P2  | Add requireIdempotencyKey to M17/M18 mutations and If-Match to geofence PATCH                                                                                                           | `apps/backend/src/modules/17-scheduling/routes/scheduling-routes.ts`, `apps/backend/src/modules/18-evv/routes/evv-routes.ts`                                                                                                  | Keys required; geofence PATCH versioned                                                                                                                     | grep requireIdempotencyKey                                                                               |
| 113 | GAP-113 | P2  | Persist`localId` and make EVV capture idempotent per device                                                                                                                           | `apps/backend/src/modules/18-evv/evv-route-service-db.ts`, `apps/backend/src/modules/18-evv/routes/evv-routes.ts`                                                                                                             | Replayed batch returns per-event results without error                                                                                                      | Replay partial batch                                                                                     |
| 114 | GAP-114 | P2  | Compose caseload_or_scope on EVV reads; track attestation as release gate                                                                                                               | `apps/backend/src/modules/18-evv/routes/evv-routes.ts`                                                                                                                                                                          | Reads scoped; device attestation enabled before release                                                                                                     | Read routes and runbook                                                                                  |
| 115 | GAP-115 | P2  | Add identifyPatient lifecycle decision with validation, history and event                                                                                                               | `apps/backend/src/modules/19-oncall/routes/write-service-drizzle.ts`                                                                                                                                                            | Allowed states only; patient/admission validated; history row and event                                                                                     | Read service; grep                                                                                       |
| 116 | GAP-116 | P2  | Route verbal orders through`recordTriageVerbalOrder`; add encounter-link retry worker                                                                                                 | `apps/backend/src/modules/19-oncall/clinical/verbal-order.ts`, `apps/backend/src/modules/19-oncall/routes/write-service-drizzle.ts`, `apps/backend/src/modules/19-oncall/jobs/index.ts`                                     | Step-up enforced; unlinked calls rescanned                                                                                                                  | Grep and read                                                                                            |
| 117 | GAP-117 | P2  | Resolve SOS visit server-side and re-verify in M17 consumer                                                                                                                             | `apps/backend/src/modules/20-field-safety/routes/write-service-drizzle.ts`, `apps/backend/src/modules/17-scheduling/outbox-consumers/m20-safety-visit-cancellation.ts`                                                        | Assignee equals poster                                                                                                                                      | Read flow                                                                                                |
| 118 | GAP-118 | P2  | Build high-risk-area evaluator, location-stream sampler and missing queues                                                                                                              | `apps/backend/src/modules/20-field-safety/seams/consumed.ts`, `apps/backend/src/modules/20-field-safety/jobs/index.ts`                                                                                                        | Evaluator emits`high_risk_area_entered`; location stream written; queues exist                                                                            | Grep and read                                                                                            |
| 119 | GAP-119 | P2  | Derive supply request patientId from admission                                                                                                                                          | `apps/backend/src/modules/21-supplies/routes/write-service-drizzle.ts`                                                                                                                                                          | Mismatching body value rejected; sourceOrderId checked                                                                                                      | Confirm summary.patientId compared                                                                       |
| 120 | GAP-120 | P2  | Add`patientIdPayloadPath` to M21-M25 single-record read configs                                                                                                                       | `apps/backend/src/modules/21-supplies/routes/supply-requests.routes.ts`, `apps/backend/src/modules/23-billing-medicare/routes/claims.routes.ts`                                                                               | Reads appear in patient accounting                                                                                                                          | grep attribution keys across five modules                                                                |
| 121 | GAP-121 | P2  | Build PHI bundle export and template publish, or remove routes                                                                                                                          | `apps/backend/src/modules/22-documents/documents-route-service-db.ts`, `apps/backend/src/modules/22-documents/routes/documents-routes.ts`                                                                                     | Routes produce output or are removed from surface and spec                                                                                                  | Read cited lines                                                                                         |
| 122 | GAP-122 | P2  | Add critical-results render lane or amend spec                                                                                                                                          | `apps/backend/src/modules/22-documents`, `docs/modules/WARDENX_MODULE_22_DOCUMENTS_SPEC_v0_5.md`                                                                                                                              | Queue, worker, watermark and event exist or D22 dropped                                                                                                     | grep + spec read                                                                                         |
| 123 | GAP-123 | P2  | Compose`document_within_admission_window` on document reads                                                                                                                           | `apps/backend/src/modules/22-documents/routes/documents-routes.ts`, `scripts/abac-uncomposed-allowlist.ts`                                                                                                                    | Predicate composed or deleted; allowlist entry removed                                                                                                      | `arch:abac-composed` passes without entry                                                              |
| 124 | GAP-124 | P2  | Apply provider-entity scope to NOE/NOTR/transfer, MAC credentials, AR and metrics                                                                                                       | `apps/backend/src/modules/23-billing-medicare/routes/read-service-drizzle.ts`, `apps/backend/src/modules/23-billing-medicare/routes/noe.routes.ts`, `apps/backend/src/modules/23-billing-medicare/routes/metrics.routes.ts` | Server-derived scope applied; out-of-scope filter rejected                                                                                                  | Route tests with PE-scoped manager                                                                       |
| 125 | GAP-125 | P2  | Bind m23/m24/m25`m22.document.rendered` back-ref consumers                                                                                                                            | `apps/backend/src/modules/22-documents/events-by-m22.ts`, `apps/backend/src/index.ts`                                                                                                                                         | Consumers bound; consumers listed in`declaredConsumers`; aggregateType mismatch fixed                                                                     | grep consumer list                                                                                       |
| 126 | GAP-126 | P2  | Publish M23`ClaimReader` and medicareSecondaryContext; trigger AWAITING_MEDICARE_PRIMARY                                                                                              | `apps/backend/src/bootstrap/seams/registry.ts`, `apps/backend/src/modules/24-billing-medicaid/outbox-consumers/m24-medicare-primary-ack.ts`                                                                                   | Dual-eligible claim reaches the state                                                                                                                       | Create dual-eligible claim                                                                               |
| 127 | GAP-127 | P2  | Thread CCN/provider entity through M23 cap-projection path                                                                                                                              | `apps/backend/src/modules/23-billing-medicare/services/cap-projection-adapter.ts`, `apps/backend/src/modules/26-cap/seam-impls.ts`                                                                                            | Second provider entity gets its own period                                                                                                                  | Seed two PEs and compare allocated cap                                                                   |
| 128 | GAP-128 | P2  | Apply`peScope` to remaining M24 reads and remove dead helper                                                                                                                          | `apps/backend/src/modules/24-billing-medicaid/routes/read-service-drizzle.ts`, `apps/backend/src/modules/24-billing-medicaid/routes/guards.ts`                                                                                | All listed reads scoped;`ABAC_QUERY_PE` used or removed                                                                                                   | Read methods; grep                                                                                       |
| 129 | GAP-129 | P2  | Add CaseloadProvider axis to M24 claim predicate                                                                                                                                        | `apps/backend/src/modules/24-billing-medicaid/abac-predicates.ts`                                                                                                                                                               | Caseload or org-wide bypass per spec; stale comment removed                                                                                                 | Read predicates against M23                                                                              |
| 130 | GAP-130 | P2  | Compute AR aging, charges and open-state filter                                                                                                                                         | `apps/backend/src/modules/24-billing-medicaid/routes/read-service-drizzle.ts`                                                                                                                                                   | Real buckets mirroring M23                                                                                                                                  | Read lines                                                                                               |
| 131 | GAP-131 | P2  | Replace R&B read-audit waiver with emission config                                                                                                                                      | `apps/backend/src/modules/24-billing-medicaid/routes/rb.routes.ts`                                                                                                                                                              | Detail and list emit audit with patient attribution                                                                                                         | Read rb.routes.ts                                                                                        |
| 132 | GAP-132 | P2  | Construct medicaid-ack-pull worker and schedule or amend spec                                                                                                                           | `apps/backend/src/modules/24-billing-medicaid/jobs/queues.ts`, `apps/backend/src/modules/24-billing-medicaid/jobs/index.ts`                                                                                                   | Worker runs every 15 min per state/channel, or spec updated                                                                                                 | grep`M24_CRON_QUEUES`                                                                                  |
| 133 | GAP-133 | P2  | Emit or remove unemitted M24 events; emit stalled on retry exhaustion                                                                                                                   | `apps/backend/src/modules/24-billing-medicaid/events-by-m24.ts`, `apps/backend/src/modules/24-billing-medicaid/jobs`                                                                                                          | Each catalogued event has an emitter or is removed with justification                                                                                       | Scan catalog vs literals                                                                                 |
| 134 | GAP-134 | P2  | Give remittance manual-match a target without denialCaseId                                                                                                                              | `apps/backend/src/modules/25-remittance/routes/remittance.routes.ts`, `apps/backend/src/modules/25-remittance/routes/guards.ts`                                                                                               | Non-broad roles with permission pass; route test added                                                                                                      | Static trace; route test                                                                                 |
| 135 | GAP-135 | P2  | Write ledger row and real event in close-write-off                                                                                                                                      | `apps/backend/src/modules/25-remittance/routes/write-service-drizzle.ts`                                                                                                                                                        | Real ledgerId/patientId/amount or no emit                                                                                                                   | Read lines 204-224                                                                                       |
| 136 | GAP-136 | P2  | Persist reasons for escalate/resolve/reopen/withdraw/decide                                                                                                                             | `apps/backend/src/modules/25-remittance/routes/write-service-drizzle.ts`                                                                                                                                                        | Reason stored on history/event                                                                                                                              | Read methods                                                                                             |
| 137 | GAP-137 | P2  | Validate attached appeal document ids via DocumentReader                                                                                                                                | `apps/backend/src/modules/25-remittance/routes/write-service-drizzle.ts`                                                                                                                                                        | Ids must belong to org and patient/claim                                                                                                                    | Read write path                                                                                          |
| 138 | GAP-138 | P2  | Fall back to M23 service dates and surface refused accruals                                                                                                                             | `apps/backend/src/modules/25-remittance/ingest/service-drizzle.ts`, `apps/backend/src/modules/26-cap/consumers/handlers.ts`                                                                                                   | 835 line without DTM accrues; refusals counted or dead-lettered                                                                                             | Ingest 835 with no DTM and check accrual line                                                            |
| 139 | GAP-139 | P2  | Block finalize on open PS&R variances; store attestation and real step-up id                                                                                                            | `apps/backend/src/modules/26-cap/routes/write-service-drizzle.ts`                                                                                                                                                               | 409 with line ids; attestation and snapshot stored                                                                                                          | Seed open line; finalize returns 409                                                                     |
| 140 | GAP-140 | P2  | Persist reopen reason, high severity audit and supersede snapshots                                                                                                                      | `apps/backend/src/modules/26-cap/routes/write-service-drizzle.ts`, `packages/db/migrations/0090_cap_m26_audit_triggers.sql`                                                                                                   | Reopen/finalize/lock audited at high severity                                                                                                               | Reopen then query`audit_event`                                                                         |
| 141 | GAP-141 | P2  | Remove methodology from period open or route via step-up lock                                                                                                                           | `apps/backend/src/modules/26-cap/routes/cap.routes.ts`, `apps/backend/src/modules/26-cap/routes/write-service-drizzle.ts`                                                                                                     | Methodology only set through lock row with step-up                                                                                                          | POST with methodology and no step-up is rejected                                                         |
| 142 | GAP-142 | P2  | Validate PS&R CCN against M40                                                                                                                                                           | `apps/backend/src/modules/26-cap/psr`, `apps/backend/src/modules/26-cap/routes/write-service-drizzle.ts`                                                                                                                      | Foreign CCN rejected                                                                                                                                        | Import CSV with foreign CCN                                                                              |
| 143 | GAP-143 | P2  | Widen M23 replaced/voided payloads or resolve accrual by originalClaimId                                                                                                                | `apps/backend/src/modules/23-billing-medicare/events-by-m23.ts`, `apps/backend/src/modules/26-cap/consumers/handlers.ts`                                                                                                      | Reversal line written                                                                                                                                       | Void paid claim in live suite                                                                            |
| 144 | GAP-144 | P2  | Isolate per-org/period failures in M26 crons and label snapshots correctly                                                                                                              | `apps/backend/src/modules/26-cap/jobs/index.ts`, `apps/backend/src/modules/26-cap/routes/write-service-drizzle.ts`                                                                                                            | One org's failure does not abort tick;`computed_by='nightly_batch'`                                                                                       | Throwing org test                                                                                        |
| 145 | GAP-145 | P2  | Build or delete M26 platformConstantRefresh and thresholdEvaluator queues                                                                                                               | `apps/backend/src/modules/26-cap/jobs/queues.ts`, `apps/backend/src/modules/26-cap/jobs/index.ts`                                                                                                                             | Workers constructed or queues removed with spec amended                                                                                                     | Scan queue keys vs usages                                                                                |
| 146 | GAP-146 | P2  | Wire cap writes in UI or relabel specs partial                                                                                                                                          | `apps/web/src/modules/26-cap`, `docs/design/SCREEN_SPEC_STATUS.md`                                                                                                                                                            | Uncalled ops have callers or rows are 'partial'                                                                                                             | openapi diff                                                                                             |
| 147 | GAP-147 | P2  | Register four unregistered M26 seams and bind consumers                                                                                                                                 | `apps/backend/src/modules/26-cap/wiring.ts`, `apps/backend/src/bootstrap/seams/registry.ts`, `packages/reporting/src/seams/consumed/m26-cap.ts`                                                                             | Seams in REQUIRED_SEAMS with consumers, or spec lines retired                                                                                               | grep`getSeam` for the four keys                                                                        |
| 148 | GAP-148 | P2  | Enforce filing deadline in submit; persist bypass reason                                                                                                                                | `apps/backend/src/modules/27-cost-report/routes/write-service-drizzle.ts`, `packages/cost-report/src/domain/lifecycle.ts`                                                                                                     | `/submit` blocks past deadline; `/submit-past-deadline` stores reason and emits warn audit                                                              | Expired-window report                                                                                    |
| 149 | GAP-149 | P2  | Bind Xero and Gusto pulls with OAuth storage or demote to manual import                                                                                                                 | `apps/backend/src/index.ts`, `apps/backend/src/modules/27-cost-report/jobs/m27-jobs.ts`                                                                                                                                       | Pull jobs complete or routes limited to manual import                                                                                                       | Trigger trial-balance pull in Docker stack                                                               |
| 150 | GAP-150 | P2  | Bind m25 denial and M40 offboard consumers or amend spec                                                                                                                                | `apps/backend/src/modules/27-cost-report/consumers/subscription-map.ts`, `apps/backend/src/index.ts`                                                                                                                          | W-CR-08 and W-CR-12 live                                                                                                                                    | Offboard PE with draft report; state closed                                                              |
| 151 | GAP-151 | P2  | Add M27 mapping, ECR, reopen and extension surfaces or record deferral                                                                                                                  | `apps/web/src/modules/27-cost-report/cost-report-api.ts`                                                                                                                                                                        | 15 uncalled ops covered or deferred                                                                                                                         | openapi diff                                                                                             |
| 152 | GAP-152 | P2  | Validate inbound FHIR resources and make staging idempotent                                                                                                                             | `apps/backend/src/modules/28-fhir/routes/fhir-r4.routes.ts`, `apps/backend/src/modules/28-fhir/routes/store-drizzle.ts`, `packages/db/migrations/0136_fhir_gateway_m28_inbound_resource_partitioned.sql`                    | Unique dedup key; repeat POST returns same proposal                                                                                                         | POST same Patient twice                                                                                  |
| 153 | GAP-153 | P2  | Mint accepted aggregate server-side via M5/M12 review-and-apply                                                                                                                         | `apps/backend/src/modules/28-fhir/routes/admin-inbound.routes.ts`, `apps/backend/src/modules/28-fhir/routes/store-drizzle.ts`                                                                                                 | Accept creates native row whose id matches                                                                                                                  | Stage and accept a Patient                                                                               |
| 154 | GAP-154 | P2  | Implement`$expand` via M38 or answer not-supported | `apps/backend/src/modules/28-fhir/routes/fhir-r4.routes.ts` | No empty expansion for unknown sets | GET known ValueSet/$expand |                                                                                                                                                                                                                                   |                                                                                                                                                             |                                                                                                          |
| 155 | GAP-155 | P2  | Decide screens for FHIR client and external-interface ops                                                                                                                               | `docs/design/SCREEN_SPEC_STATUS.md`                                                                                                                                                                                             | Documented owner decision or screens scheduled                                                                                                              | openapi diff                                                                                             |
| 156 | GAP-156 | P2  | Implement inbound decrypt via cipher with disclosure audit and rate limit                                                                                                               | `apps/backend/src/modules/29-external-interfaces/routes/message.routes.ts`, `apps/backend/src/modules/29-external-interfaces/inbound/inbound-crypto.ts`                                                                       | Plaintext returned with`phi_disclosure` row                                                                                                               | Call decrypt with step-up                                                                                |
| 157 | GAP-157 | P2  | Accept`appliedFields` and set partially_applied                                                                                                                                       | `apps/backend/src/modules/29-external-interfaces/routes/m29-typebox.ts`, `apps/backend/src/modules/29-external-interfaces/routes/store-drizzle.ts`                                                                            | Subset accept patches only selected fields                                                                                                                  | Accept PATIENT_UPDATE with address only                                                                  |
| 158 | GAP-158 | P2  | Implement and register external_interfaces eraser                                                                                                                                       | `apps/backend/src/bootstrap/erasers/registry.ts`, `apps/backend/src/modules/29-external-interfaces`                                                                                                                           | Destruction covers HL7 payloads, observations, proposals                                                                                                    | Run certificate for org with HL7 data                                                                    |
| 159 | GAP-159 | P2  | Add break-glass and engagement management screens or document API-only                                                                                                                  | `apps/web/src`, `apps/admin/src`, `docs/design/SCREEN_SPEC_STATUS.md`                                                                                                                                                       | Screens exist or spec documents API-only                                                                                                                    | grep three SPAs                                                                                          |
| 160 | GAP-160 | P2  | Wire SRA export route or amend spec                                                                                                                                                     | `apps/backend/src/modules/30-quality/routes/sra.routes.ts`                                                                                                                                                                      | `/cycles/:id/export` exists or spec amended                                                                                                               | GET export                                                                                               |
| 161 | GAP-161 | P2  | Add vendor service-principal path or internal ingest for CAHPS results                                                                                                                  | `apps/backend/src/modules/30-quality/routes/cahps.routes.ts`, `apps/backend/src/bootstrap/plugins/authenticate.ts`                                                                                                            | R-16 reachable;`cahps_result_summary` populated                                                                                                           | Call R-16 with system credential                                                                         |
| 162 | GAP-162 | P2  | Filter org-level readers by provider entity or compute once per org                                                                                                                     | `apps/backend/src/modules/30-quality/jobs/m30-jobs.ts`, `packages/types/src/admission.ts`                                                                                                                                     | Two PEs produce distinct rows                                                                                                                               | Compare HVLDL rows for two PEs                                                                           |
| 163 | GAP-163 | P2  | Capture raw body for telehealth webhooks and process lifecycle events                                                                                                                   | `apps/backend/src/modules/31-portal/routes/telehealth.routes.ts`                                                                                                                                                                | HMAC over raw bytes; room_ended and recording events update lifecycle                                                                                       | Signed Daily.co`room_ended` ends visit                                                                 |
| 164 | GAP-164 | P2  | Make halt-recording call vendor stopRecording                                                                                                                                           | `apps/backend/src/modules/31-portal/routes/admin.routes.ts`                                                                                                                                                                     | Vendor stop invoked; 404 on absent visit                                                                                                                    | Bound-adapter test                                                                                       |
| 165 | GAP-165 | P2  | Guard suspend/reinstate transitions and return 404/409                                                                                                                                  | `apps/backend/src/modules/31-portal/routes/store.ts`, `apps/backend/src/modules/31-portal/routes/admin.routes.ts`                                                                                                             | Reinstate only from suspended; missing account 404                                                                                                          | Reinstate invited account refused                                                                        |
| 166 | GAP-166 | P2  | Fail closed when discharge state cannot be read                                                                                                                                         | `apps/backend/src/modules/31-portal/routes/write.routes.ts`                                                                                                                                                                     | M6 error yields 503 on writes                                                                                                                               | Stub reader to throw                                                                                     |
| 167 | GAP-167 | P2  | Bind M36 membership removal and M2 session revocation consumers for m31 events                                                                                                          | `apps/backend/src/modules/31-portal/events-by-m31.ts`, `apps/backend/src/modules/36-messaging/outbox-consumers/channel-membership-sync.ts`                                                                                    | Revoke removes caregiver from channel                                                                                                                       | Revoke grant then query membership                                                                       |
| 168 | GAP-168 | P2  | Add resource ids to M31 single-resource reads                                                                                                                                           | `apps/backend/src/modules/31-portal/routes/session.routes.ts`, `apps/backend/src/modules/31-portal/routes/admin.routes.ts`                                                                                                    | Read events land; live assertion                                                                                                                            | Call sessions/patients then query audit                                                                  |
| 169 | GAP-169 | P2  | Extend M31 RLS isolation suite to three tables                                                                                                                                          | `packages/db/migrations/__tests__/m31-rls-isolation.live.test.ts`                                                                                                                                                               | Cross-tenant checks for`portal_invitation`, `portal_document_upload`, `portal_notification_preference`                                                | grep suite                                                                                               |
| 170 | GAP-170 | P2  | Build invite-expiry sweep and recording finalize; fix stale deferral text                                                                                                               | `apps/backend/src/modules/31-portal/jobs/queues.ts`, `docs/history/m31-portal-deferrals.md`                                                                                                                                   | Workers exist; text corrected                                                                                                                               | grep workers                                                                                             |
| 171 | GAP-171 | P2  | Build drift-sweep and evaluation workers and kill-switch broadcast                                                                                                                      | `apps/backend/src/modules/32-ai-platform/jobs`, `apps/backend/src/index.ts`                                                                                                                                                   | Five queues have workers or deferral documented                                                                                                             | grep`drift-sweeps`                                                                                     |
| 172 | GAP-172 | P2  | Add evaluations worker; stop accepting caller-supplied metrics                                                                                                                          | `apps/backend/src/modules/32-ai-platform/safety/service.ts`, `apps/backend/src/modules/32-ai-platform/routes/safety-ops.routes.ts`                                                                                            | Runs leave pending via`transitionAiEvaluationRun`                                                                                                         | Queue run and poll R28                                                                                   |
| 173 | GAP-173 | P2  | Bind tenant-DEK cipher and BAA/ZDR resolvers                                                                                                                                            | `apps/backend/src/index.ts`                                                                                                                                                                                                     | R10 and R18 usable                                                                                                                                          | POST hallucination-reports no longer 503                                                                 |
| 174 | GAP-174 | P2  | Derive drilldown cohort server-side                                                                                                                                                     | `apps/backend/src/modules/33-reporting/routes/drilldown.routes.ts`, `packages/reporting/src/drilldown/consent-narrowing.ts`                                                                                                   | Omitting patientIds does not skip narrowing                                                                                                                 | Compare`isConsentNarrowed`                                                                             |
| 175 | GAP-175 | P2  | Build definition builder, saved views and exports or downgrade status                                                                                                                   | `apps/web/src/modules/33-reporting/screens.ts`                                                                                                                                                                                  | 17 uncalled ops covered or status partial                                                                                                                   | openapi diff                                                                                             |
| 176 | GAP-176 | P2  | Add cap and quality MVs or record tiles unbuilt; wire MetricsProvider                                                                                                                   | `packages/db/migrations`, `apps/backend/src/modules/33-reporting/wiring.ts`                                                                                                                                                   | Datasets exist or spec/status updated                                                                                                                       | List`report_mv.*` relations                                                                            |
| 177 | GAP-177 | P2  | Resolve DSAR job patient server-side for ABAC                                                                                                                                           | `apps/backend/src/modules/34-saas-tenant-platform/routes/tenant/dsar-export-jobs.ts`                                                                                                                                            | Caseload arm usable                                                                                                                                         | Clinician in caseload downloads                                                                          |
| 178 | GAP-178 | P2  | Enforce compliance_officer role on grant issuance                                                                                                                                       | `apps/backend/src/modules/34-saas-tenant-platform/routes/tenant/support-consent-grants.ts`                                                                                                                                      | Role predicate or in-service check                                                                                                                          | Issue grant as non-compliance holder                                                                     |
| 179 | GAP-179 | P2  | Add emit-site coverage gate; emit or remove unemitted events                                                                                                                            | `scripts/check-outbox-bindings.ts`, `apps/backend/src/modules/34-saas-tenant-platform/jobs/saas-jobs.ts`                                                                                                                      | Gate fails on catalog-only events; security alerts`dek_rotation_due` and `integrity_failure` produced                                                   | grep -F each name                                                                                        |
| 180 | GAP-180 | P2  | Add missing platform actions or document API-only                                                                                                                                       | `apps/admin/src/modules/34-saas-platform/screens.ts`                                                                                                                                                                            | Actions have UI or documented                                                                                                                               | openapi diff for tags 34 and 35                                                                          |
| 181 | GAP-181 | P2  | Register Drizzle-backed M35 seams and bind usage ingest callers                                                                                                                         | `apps/backend/src/bootstrap/seams/registry.ts`, `apps/backend/src/modules/35-subscription/routes/service-drizzle.ts`                                                                                                          | Seams not deny-stubs;`usage_event` written                                                                                                                | `getSeam('BillingStatusProvider')` works on DB boot                                                    |
| 182 | GAP-182 | P2  | Add public flag to promo codes and require on tenant path                                                                                                                               | `packages/db/migrations`, `apps/backend/src/modules/35-subscription/routes/promo-redemption.ts`                                                                                                                               | Internal-only promo cannot be self-applied                                                                                                                  | POST apply_promo with internal code                                                                      |
| 183 | GAP-183 | P2  | Implement on_call, bereavement, discipline, location channels or defer in spec                                                                                                          | `apps/backend/src/modules/36-messaging/messaging-provider-db.ts`                                                                                                                                                                | No 501 NOT_IMPLEMENTED paths or spec defers                                                                                                                 | Read provider lines                                                                                      |
| 184 | GAP-184 | P2  | Persist message attachments or reject with 422                                                                                                                                          | `apps/backend/src/modules/36-messaging/messaging-route-service-db.ts`                                                                                                                                                           | `message_attachment` rows written                                                                                                                         | grep`messageAttachment`                                                                                |
| 185 | GAP-185 | P2  | Enforce edit window and channel visibility on edit/delete                                                                                                                               | `apps/backend/src/modules/36-messaging/messaging-route-service-db.ts`, `apps/backend/src/modules/36-messaging/routes/messaging-routes.ts`                                                                                     | 409 EDIT_WINDOW_CLOSED; membership checked                                                                                                                  | Edit old message                                                                                         |
| 186 | GAP-186 | P2  | Thread user id into patchAlertRule                                                                                                                                                      | `apps/backend/src/modules/36-messaging/routes/messaging-routes.ts`, `apps/backend/src/modules/36-messaging/messaging-route-service-db.ts`                                                                                     | Audit actor non-null;`updated_by` set                                                                                                                     | Read cited lines                                                                                         |
| 187 | GAP-187 | P2  | Build hash_verify, retention_scan, endpoint_health workers or defer in spec                                                                                                             | `apps/backend/src/modules/36-messaging/delivery/delivery-workers.ts`, `packages/messaging/src/jobs/queues.ts`                                                                                                                 | Eight missing queues covered                                                                                                                                | grep`MESSAGING_QUEUES`                                                                                 |
| 188 | GAP-188 | P2  | Declare auditRead on M36 reads and add governed prefixes                                                                                                                                | `apps/backend/src/modules/36-messaging/routes/messaging-routes.ts`, `apps/backend/src/bootstrap/index.ts`                                                                                                                     | Boot fails on undeclared GET; audit row per page                                                                                                            | Inject test                                                                                              |
| 189 | GAP-189 | P2  | Build tasks backend and UI or mark partial; add DM/announce/members screens                                                                                                             | `apps/web/src/modules/36-messaging/notifications-inbox.tsx`                                                                                                                                                                     | Placeholders replaced or status partial                                                                                                                     | Read screen; openapi grep                                                                                |
| 190 | GAP-190 | P2  | Add RN-coverage gate and bed/patient validation to equipment assign                                                                                                                     | `apps/backend/src/modules/37-ipu/routes/service-drizzle.ts`                                                                                                                                                                     | 412 when uncovered; bed belongs to unit                                                                                                                     | Read service                                                                                             |
| 191 | GAP-191 | P2  | Apply unit-staff/caseload scoping to IPU reads and remaining mutations                                                                                                                  | `apps/backend/src/modules/37-ipu/routes/ipu.routes.ts`, `apps/backend/src/modules/37-ipu/routes/service-drizzle.ts`                                                                                                           | Scoped or role-only decision documented                                                                                                                     | grep`requireUnitStaff`                                                                                 |
| 192 | GAP-192 | P2  | Add missing bed/equipment/coverage UI actions; correct frame-fidelity note                                                                                                              | `apps/web/src/modules/37-ipu/ipu-api.ts`, `docs/design/SCREEN_SPEC_STATUS.md`                                                                                                                                                 | 13 uncalled ops covered or status partial                                                                                                                   | openapi diff                                                                                             |
| 193 | GAP-193 | P2  | Register code-usage producers for claims, orders and others                                                                                                                             | `apps/backend/src/index.ts`, `apps/backend/src/modules/38-terminology/jobs/tenant-scan.ts`                                                                                                                                    | Producers beyond M7 or spec narrowed                                                                                                                        | grep`CodeUsageProducer`                                                                                |
| 194 | GAP-194 | P2  | Write platform audit event for M38 and M40 cross-tenant admin reads                                                                                                                     | `apps/backend/src/modules/38-terminology/routes/admin-terminology-routes.ts`                                                                                                                                                    | `audit.elevated_access` event per read                                                                                                                    | grep audit calls                                                                                         |
| 195 | GAP-195 | P2  | Build extension editor, remediation and licence panels or mark partial                                                                                                                  | `apps/web/src/modules/38-terminology/terminology-admin.tsx`                                                                                                                                                                     | 7 uncalled ops covered or status partial                                                                                                                    | openapi diff                                                                                             |
| 196 | GAP-196 | P2  | Emit four M39 alert payloads and seed rules                                                                                                                                             | `apps/backend/src/modules/39-consent/alerts-by-m39.ts`, `packages/messaging/src/seed/alert-rules.ts`                                                                                                                          | Alerts emitted from crons, DPOA write, disclosure gate; rules seeded                                                                                        | grep payload types                                                                                       |
| 197 | GAP-197 | P2  | Compose consent and retention predicates at consuming routes or delete                                                                                                                  | `scripts/abac-uncomposed-allowlist.ts`, `apps/backend/src/modules/22-documents/routes/documents-routes.ts`                                                                                                                    | Allowlist shrinks; 13-month window enforced                                                                                                                 | Post-discharge read at +14 months refused                                                                |
| 198 | GAP-198 | P2  | Emit`m40.mdm.baa_status_changed` and build M29 requeue consumer                                                                                                                       | `apps/backend/src/modules/40-mdm/mdm-store-db.ts`, `apps/backend/src/modules/40-mdm/events-by-m40.ts`                                                                                                                         | Event emitted in recordBaa transaction; M29 consumes                                                                                                        | grep`baa_status_changed`                                                                               |
| 199 | GAP-199 | P2  | Add four missing canonical tables or restrict KindSchema and spec                                                                                                                       | `apps/backend/src/modules/40-mdm/mdm-store-db.ts`, `architecture/module-manifest.ts`                                                                                                                                          | Tables with RLS and live test, or kinds restricted                                                                                                          | grep CREATE TABLE in migrations                                                                          |
| 200 | GAP-200 | P2  | Merge overlay PATCH onto existing row                                                                                                                                                   | `apps/backend/src/modules/40-mdm/routes/mdm-routes.ts`, `apps/backend/src/modules/40-mdm/mdm-store-db.ts`                                                                                                                     | Omitted fields preserved                                                                                                                                    | PATCH`{relationshipNotes}` keeps doNotRefer                                                            |
| 201 | GAP-201 | P2  | Add repoint jobs or redirect contract; emit merge events; map PG errors                                                                                                                 | `packages/db/migrations/0205_mdm_governance_writer_functions.sql`, `apps/backend/src/modules/40-mdm/mdm-store-db.ts`                                                                                                          | Events emitted; 409/422 instead of raw PG errors                                                                                                            | Read 0205 and cron header                                                                                |
| 202 | GAP-202 | P2  | Build MDM merge review, overlay and NPPES panels or mark partial                                                                                                                        | `apps/web/src/modules/40-mdm/mdm-console.tsx`                                                                                                                                                                                   | 12 uncalled ops covered or status partial; MDM_HEALTH_SYNC note corrected                                                                                   | openapi diff                                                                                             |
| 203 | GAP-203 | P2  | Triage residual uncalled staff routes against specs                                                                                                                                     | `docs/design/SCREEN_SPEC_STATUS.md`, `apps/web/src`, `apps/admin/src`                                                                                                                                                       | Each route has UI or API-only intent recorded                                                                                                               | Script diff of openapi vs SPA literals                                                                   |
| 204 | GAP-204 | P2  | Match pending and unmatched frames region-by-region                                                                                                                                     | `audit/frame-fidelity/FRAME_FIDELITY.md`                                                                                                                                                                                        | Matched count rises                                                                                                                                         | `bun run frame:fidelity`                                                                               |
| 205 | GAP-205 | P2  | Add per-row action coverage to`check-ui-screens` and re-grade rows                                                                                                                    | `scripts/check-ui-screens.ts`, `docs/design/SCREEN_SPEC_STATUS.md`                                                                                                                                                            | Built screen with no write call needs caveat                                                                                                                | Read script and status file                                                                              |
| 206 | GAP-206 | P2  | Replace sessionStorage drafts with in-memory Map; clear on sign-out; add lint gate                                                                                                      | `apps/web/src/shell/step-up-redirect.ts`                                                                                                                                                                                        | No`wx.step-up-draft` keys in storage                                                                                                                      | DOM test after STEP_UP_REQUIRED and sign-out                                                             |
| 207 | GAP-207 | P3  | Add response schemas to 8 GET routes                                                                                                                                                    | `scripts/openapi/enrichments.ts`                                                                                                                                                                                                | GET no-response count is 0                                                                                                                                  | openapi-coverage report                                                                                  |
| 208 | GAP-208 | P3  | Publish body schema for M35 Stripe webhook and re-baseline                                                                                                                              | `apps/backend/src/modules/35-subscription/routes/webhooks.routes.ts`, `scripts/openapi/enrichments.ts`, `audit/openapi-coverage/baseline.json`                                                                              | `bun run openapi:coverage` shows 0 mutating-no-body                                                                                                       | `arch:fitness` stays green                                                                             |
| 209 | GAP-209 | P3  | Remove hand-mirrored counts or point to generated reports                                                                                                                               | `docs/BUSINESS_LOGIC.md`, `docs/IMPLEMENTATION_ROADMAP.md`                                                                                                                                                                    | No restated counts; ADR-0028 count marked at-time-of-ADR                                                                                                    | `bun run arch:parity`, `bun run status:matrix`                                                       |
| 210 | GAP-210 | P3  | Fix or date-stamp cartography paths                                                                                                                                                     | `docs/cartography/audit_encounters_visits.md`, `docs/cartography/hope_report.md`                                                                                                                                              | No citations of absent files                                                                                                                                | ls cited paths                                                                                           |
| 211 | GAP-211 | P3  | Fix three broken relative links                                                                                                                                                         | `docs/history/status-overview.md`                                                                                                                                                                                               | Links resolve (`../DEVELOPMENT.md` etc.) or docs gate covers `docs/history`                                                                             | Link walker over`docs/**/*.md`                                                                         |
| 212 | GAP-212 | P3  | Add as-built path map or ratchet missing cited paths                                                                                                                                    | `docs/modules`, `scripts/check-module-docs.ts`                                                                                                                                                                                | Missing-path count reported or reduced                                                                                                                      | Path-citation scan                                                                                       |
| 213 | GAP-213 | P3  | Add E2E specs for zero-coverage screens                                                                                                                                                 | `audit/e2e-coverage/E2E_COVERAGE.md`                                                                                                                                                                                            | Reached count rises above 19 of 170                                                                                                                         | `bun run e2e:coverage`                                                                                 |
| 214 | GAP-214 | P3  | Decide which unmatched frames matter and compare pending screens                                                                                                                        | `audit/frame-fidelity/FRAME_FIDELITY.md`                                                                                                                                                                                        | Owner decision recorded                                                                                                                                     | `bun run frame:fidelity:check`                                                                         |
| 215 | GAP-215 | P3  | Update or delete stale seam-status comments                                                                                                                                             | `apps/backend/src/index.ts`, `apps/backend/src/modules/30-quality/jobs/m30-jobs.ts`, `apps/backend/src/modules/08-encounters/seams/drizzle-store.ts`                                                                        | Comments match code                                                                                                                                         | grep cited lines                                                                                         |
| 216 | GAP-216 | P3  | Emit Socket.IO status and flag events or amend spec to polling                                                                                                                          | `packages/messaging/src/realtime/events.ts`, `apps/backend/src/bootstrap/routes/system.ts`                                                                                                                                    | Emission exists or spec amended                                                                                                                             | grep`systemStatusChanged`                                                                              |
| 217 | GAP-217 | P3  | Add`processing_log` and `audit_integrity_run` to RLS isolation suites                                                                                                               | `packages/db/migrations/__tests__/m1-rls-isolation.live.test.ts`, `packages/db/migrations/__tests__/m4-rls-isolation.live.test.ts`                                                                                            | App-role cross-tenant read returns zero rows                                                                                                                | grep both suites                                                                                         |
| 218 | GAP-218 | P3  | Bind idempotency key to user, method, route and run replay after authorization                                                                                                          | `apps/backend/src/bootstrap/plugins/idempotency.ts`                                                                                                                                                                             | User B replaying A's key gets 409/403                                                                                                                       | Inject test                                                                                              |
| 219 | GAP-219 | P3  | Make invitation accept atomic                                                                                                                                                           | `apps/backend/src/modules/02-identity/routes/identity-routes.ts`, `apps/backend/src/modules/02-identity/identity-stores-db.ts`                                                                                                | Consume and membership create in one transaction or compensated                                                                                             | Accept for user with existing membership leaves invite pending                                           |
| 220 | GAP-220 | P3  | Use uuid/date formats, NotFoundError, cursor validation and response schemas in M5                                                                                                      | `apps/backend/src/modules/05-patient/routes/patient-typebox.ts`, `apps/backend/src/modules/05-patient/patient-route-service-db.ts`                                                                                            | Bad input returns typed 4xx                                                                                                                                 | POST payers with`payerId:'x'`; crafted cursor                                                          |
| 221 | GAP-221 | P3  | Add PHI-adjacent prefixes to the read-audit gate                                                                                                                                        | `apps/backend/src/bootstrap/index.ts`, `apps/backend/src/modules/04-audit/routes/audit-routes.ts`                                                                                                                             | Unannotated GET under new prefixes fails boot                                                                                                               | Add a test GET                                                                                           |
| 222 | GAP-222 | P3  | Narrow GET`/compliance-windows` by scope or bind `compliance.scope`                                                                                                                 | `apps/backend/src/modules/06-admission/routes/admission-routes.ts`, `scripts/abac-uncomposed-allowlist.ts`                                                                                                                    | Non-org-wide clinician sees caseload only; allowlist entry removed                                                                                          | Route test                                                                                               |
| 223 | GAP-223 | P3  | Implement R-ADM-02 guard or amend spec                                                                                                                                                  | `apps/backend/src/modules/06-admission/admission-route-service-db.ts`                                                                                                                                                           | Guard fed from windows plus DON override, or spec says vacuous                                                                                              | Route test with overdue 48h window                                                                       |
| 224 | GAP-224 | P3  | Remove stale deny-stubs and constants; extend M6 as-built note                                                                                                                          | `apps/backend/src/modules/06-admission/outbox-consumers/m29-proposal-accepted.ts`, `apps/backend/src/modules/09-assessments/seams/m22-summary-pdf.ts`                                                                         | No stale symbols                                                                                                                                            | grep;`arch:module-docs`                                                                                |
| 225 | GAP-225 | P3  | Route HTTP billable endpoint through`deriveBillability`                                                                                                                               | `apps/backend/src/modules/08-encounters/encounters-route-service-db.ts`                                                                                                                                                         | Volunteer signed visit returns billable false with reason                                                                                                   | Route test                                                                                               |
| 226 | GAP-226 | P3  | Compare membership ids in`m9.cosigner_role_match`                                                                                                                                     | `apps/backend/src/modules/09-assessments/abac-predicates.ts`                                                                                                                                                                    | Uses`membershipIdOf(context)`                                                                                                                             | Unit test with distinct fixtures                                                                         |
| 227 | GAP-227 | P3  | Add ABAC_AUTHOR to HUV date route; narrow schedules list by caseload                                                                                                                    | `apps/backend/src/modules/10-hope/routes/hope-routes.ts`                                                                                                                                                                        | Non-clinician gets 403; caseload RN lists narrowed                                                                                                          | Route tests                                                                                              |
| 228 | GAP-228 | P3  | Update stale deferral comment in M11 screens                                                                                                                                            | `apps/web/src/modules/11-orders/screens.ts`                                                                                                                                                                                     | Lists only real deferrals                                                                                                                                   | Read file                                                                                                |
| 229 | GAP-229 | P3  | Enforce prescriber/signer eligibility on refill approve; remove fabricated fallbacks; build carry-forward                                                                               | `apps/backend/src/modules/12-dosespot/routes/dosespot-routes.ts`, `apps/backend/src/modules/12-dosespot/dosespot-route-service-db.ts`                                                                                         | Approve checks eligibility and signs; missing source refused                                                                                                | Code reading                                                                                             |
| 230 | GAP-230 | P3  | Fix stale NULL-actor headers                                                                                                                                                            | `apps/backend/src/modules/12-dosespot/dosespot-route-service-db.ts`, `apps/backend/src/modules/13-emar/emar-route-service-db.ts`, `apps/backend/src/modules/14-idg/idg-route-service-db.ts`                                 | Headers cite GAP-111 behaviour                                                                                                                              | Read`packages/tenancy/src/context.ts`                                                                  |
| 231 | GAP-231 | P3  | Add`/internal/idg/*` routes or amend spec; add DPOA seam for cover fact                                                                                                               | `apps/backend/src/modules/14-idg/jobs/packet-build.ts`                                                                                                                                                                          | Routes exist or spec says seams;`activeDpoa` populated                                                                                                    | grep`internal/idg`                                                                                     |
| 232 | GAP-232 | P3  | Compose coordinator/officer ABAC on M15 routes 19, 22, 23, 24 or amend spec                                                                                                             | `apps/backend/src/modules/15-discipline-care-plans/routes/volunteer.routes.ts`                                                                                                                                                  | Any-of guard applied or RBAC-only documented                                                                                                                | Code reading                                                                                             |
| 233 | GAP-233 | P3  | Consult M4 legal hold at close or subscribe to hold events                                                                                                                              | `apps/backend/src/modules/16-bereavement/jobs/cron-workers.ts`                                                                                                                                                                  | `legal_hold_id` set or hold read at close                                                                                                                 | grep writers                                                                                             |
| 234 | GAP-234 | P3  | Isolate per-org failures in M17 crons; persist client reasonCode                                                                                                                        | `apps/backend/src/modules/17-scheduling/jobs/cron-workers.ts`, `apps/backend/src/modules/17-scheduling/scheduling-route-service-db.ts`                                                                                        | Uses`forEachActiveOrg`; reasonCode stored                                                                                                                 | Read                                                                                                     |
| 235 | GAP-235 | P3  | Add eight tables to M21/M22/M23 RLS isolation suites                                                                                                                                    | `packages/db/migrations/__tests__/m21-rls-isolation.live.test.ts`, `packages/db/migrations/__tests__/m22-rls-isolation.live.test.ts`, `packages/db/migrations/__tests__/m23-rls-isolation.live.test.ts`                     | Cross-tenant assertions present                                                                                                                             | Script comparison of table names                                                                         |
| 236 | GAP-236 | P3  | Build invoice reconciliation cron or amend spec                                                                                                                                         | `apps/backend/src/modules/21-supplies/jobs/queues.ts`                                                                                                                                                                           | Cron exists or manual route named sole path                                                                                                                 | Read queues and spec                                                                                     |
| 237 | GAP-237 | P3  | Use`document_version` resource kind on content read                                                                                                                                   | `apps/backend/src/modules/22-documents/routes/documents-routes.ts`                                                                                                                                                              | Kind matches resource                                                                                                                                       | Read lines                                                                                               |
| 238 | GAP-238 | P3  | Build platform-rule store or remove route                                                                                                                                               | `apps/backend/src/modules/23-billing-medicare/routes/platform-admin-service.ts`                                                                                                                                                 | No permanent 501                                                                                                                                            | Read lines                                                                                               |
| 239 | GAP-239 | P3  | Widen payloads or drop M26 consumer; flip M23 projection subscription live                                                                                                              | `apps/backend/src/modules/23-billing-medicare/consumers/subscription-map.ts`, `apps/backend/src/modules/26-cap/consumers/handlers.ts`                                                                                         | Void yields reversal row; no deny-stub                                                                                                                      | Void paid claim                                                                                          |
| 240 | GAP-240 | P3  | Remove stale DataClass TODOs                                                                                                                                                            | `apps/backend/src/modules/23-billing-medicare/erasers/billing-eraser.ts`, `apps/backend/src/modules/27-cost-report/erasers/cost-report-eraser.ts`, `apps/backend/src/modules/30-quality/erasers/quality-eraser.ts`          | Item (1) removed                                                                                                                                            | rg shows no match                                                                                        |
| 241 | GAP-241 | P3  | Compose caseload_or_scope on cap patient routes or document waiver                                                                                                                      | `apps/backend/src/modules/26-cap/routes/cap.routes.ts`                                                                                                                                                                          | Decision recorded and implemented                                                                                                                           | Call as out-of-caseload clinician                                                                        |
| 242 | GAP-242 | P3  | Include`psrImportId` in resolve WHERE                                                                                                                                                 | `apps/backend/src/modules/26-cap/routes/psr.routes.ts`, `apps/backend/src/modules/26-cap/routes/write-service-drizzle.ts`                                                                                                     | Mismatched importId returns 404                                                                                                                             | Call with mismatched id                                                                                  |
| 243 | GAP-243 | P3  | Create snapshot link on reopen; add auditRead to M27 reads and prefix                                                                                                                   | `apps/backend/src/modules/27-cost-report/routes/write-service-drizzle.ts`, `apps/backend/src/bootstrap/index.ts`                                                                                                              | Chain grows; read audit rows exist                                                                                                                          | Reopen and read snapshot                                                                                 |
| 244 | GAP-244 | P3  | Compose or allowlist`cost_report_period_active`; make gate require a use site                                                                                                         | `apps/backend/src/modules/27-cost-report/routes/guards.ts`, `scripts/check-abac-composed.ts`                                                                                                                                  | Gate flags unused wrappers                                                                                                                                  | Delete wrapper; gate fails                                                                               |
| 245 | GAP-245 | P3  | Build inbound queues or amend spec 4.9 to polling design                                                                                                                                | `apps/backend/src/index.ts`, `docs/modules/WARDENX_MODULE_29_EXTERNAL_INTERFACES_SPEC_v0_4.md`                                                                                                                                | Spec describes retry/quarantine semantics                                                                                                                   | Compare spec to queues                                                                                   |
| 246 | GAP-246 | P3  | Tidy M31 minor drift                                                                                                                                                                    | `apps/backend/src/modules/31-portal/provisioning/invitations.ts`, `apps/backend/src/modules/31-portal/routes/admin.routes.ts`, `apps/backend/src/modules/31-portal/routes/store.ts`                                         | 404/409 instead of 200 bodies; real SMART session id; errors mapped properly                                                                                | Read lines                                                                                               |
| 247 | GAP-247 | P3  | Build or drop`tile_warm_cache`; refresh comments                                                                                                                                      | `apps/backend/src/modules/33-reporting/jobs/m33-jobs.ts`                                                                                                                                                                        | Queue wired or removed                                                                                                                                      | grep`tileWarmCache`                                                                                    |
| 248 | GAP-248 | P3  | Remove or build`tileWarmCache` and `tenantEraser` queues                                                                                                                            | `apps/backend/src/modules/33-reporting/jobs/index.ts`                                                                                                                                                                           | Spec and catalog agree; erasure goes through M4 registry                                                                                                    | Source plus grep                                                                                         |
| 249 | GAP-249 | P3  | Fix`GET /tenant/account` auditRead                                                                                                                                                    | `apps/backend/src/modules/34-saas-tenant-platform/routes/tenant/account-flags-routes.ts`                                                                                                                                        | `resourceIdParam` or `list:true` or waiver                                                                                                              | Query`tenant_account.viewed`                                                                           |
| 250 | GAP-250 | P3  | Implement fuzzy suggestions and align request contracts or amend spec                                                                                                                   | `packages/mdm/src/provider/provider.ts`, `apps/backend/src/modules/40-mdm/routes/mdm-typebox.ts`                                                                                                                              | Shipped shape matches spec §4.2                                                                                                                            | Read provider                                                                                            |
| 251 | GAP-251 | P3  | Bind census KPIs to M6 reads or remove tiles                                                                                                                                            | `apps/web/src/modules/05-patient/patient-list-census.tsx`                                                                                                                                                                       | No placeholders                                                                                                                                             | Read lines 125-140                                                                                       |
| 252 | GAP-252 | P3  | Triage stale 'until Mxx lands' and TODO comments                                                                                                                                        | `apps/backend/src/modules/34-saas-tenant-platform`, `apps/backend/src/modules/06-admission/outbox-consumers/m29-proposal-accepted.ts`                                                                                         | Stale deleted; live ones tracked as issues                                                                                                                  | `git grep -nE 'when M[0-9]+ lands\|TODO\(Phase 2D'`                                                     |
| 253 | GAP-253 | P3  | Document operational env vars; validate scan flag in production                                                                                                                         | `deploy/production/.env.production.example`, `apps/backend/src/env.ts`                                                                                                                                                        | Listed production-relevant vars documented                                                                                                                  | grep names in env files                                                                                  |

## 7. Unverified assumptions

**Unverified P0/P1:** none supplied as unverified. All P1 gaps (GAP-001 to GAP-070) carry `verified: true`; none is P0. Several P1 findings carry caveats in their own verification text: GAP-016 (whether M29 emits `.attached` in production), GAP-025 (the 23503 inference is static), GAP-028 (no runtime attempt), GAP-030 (not exercised against a DB), GAP-034 (failure inferred from the uuid column type), GAP-063.

**P2/P3 verified true:** GAP-078, GAP-083, GAP-084, GAP-085, GAP-090, GAP-095, GAP-098, GAP-106, GAP-111, GAP-116, GAP-119, GAP-121, GAP-124, GAP-127, GAP-142, GAP-176, GAP-179, GAP-181, GAP-192, GAP-198, GAP-201, GAP-206, GAP-208, GAP-210, GAP-211, GAP-216, GAP-227, GAP-228, GAP-229, GAP-232, GAP-234, GAP-237, GAP-244, GAP-246, GAP-249.

**All other P2/P3 gaps are `verified: false`** (statically evidenced but not independently verified): every P2 and P3 id not in the list above, including GAP-071 to GAP-077, GAP-079 to GAP-082, GAP-086 to GAP-089, GAP-091 to GAP-094, GAP-096, GAP-097, GAP-099 to GAP-105, and so on through GAP-253.

**Refuted finding (excluded from §3 and §6):** M39 consent, DPOA, recipient and overlay writes run with `userId ''` so the write-audit trigger records a NULL actor. Refuted: the cited lines are accurate (`consent-store-db.ts` lines 784, 1485, 1583, 1641, 1710, 1773 and `grief-resources.ts:77-78`; trigger at `generate.ts:155`), but `withOrgContext` does not write the literal `""`. `packages/tenancy/src/context.ts:77-84` (`resolveActorUserId`) returns the ambient request user's id when `ctx.userId` is `""` and `ctx.systemActor` is not true, and that value is set as `app.user_id` (`context.ts:99`). `request-context.ts:56` runs each request inside `runWithRequestContext`, so request-driven paths record the real actor. Only a call outside a request context (a job or worker) would record NULL; none was found. Not confirmed at runtime. GAP-230 is the related stale-comment finding.

**Not executed / scope limits:**

- No unit, integration or live suite, fitness gate or Docker/DB command was run (read-only audit; live suites forbidden). Unit/integration pass status and 80% coverage were not measured. Whether `bun run build` was a no-op via `tsc` incremental cache (1s) was not checked; a clean rebuild was not forced.
- Whether the 336 skipped test files and 3824 skipped tests are all live or DB-gated suites was not enumerated.
- Live RLS and cross-tenant behaviour was not exercised; RLS coverage was judged by name-matching manifest tables against suites (the status-matrix Live column is a heuristic). Whether feature live suites listed for tables absent from the module isolation suites genuinely assert cross-tenant isolation was not confirmed (M11, M12, M21-M23, M26-M30, M36-M40).
- `fk-index-coverage.live.test.ts` is the only FK-index enforcement and was not run; no static check exists.
- Web/UI parity beyond the generated reports, runtime rendering of screens, nav reachability, per-route OpenAPI request/response accuracy, performance and index checks were out of scope or not audited. Callers outside TS source (e2e specs) were not counted; routes used only by workers, webhooks or internal clients were excluded from staff-UI claims.
- Role-grant defaults were not traced, so real exposure is unquantified for: M3/M4/M5 keys (ROLE_TEMPLATES carries no tenant grants), `remittance.manual_match` (GAP-134), `visit.cancel/reassign/edit` and `evv.read` (GAP-107, GAP-114), `m37.ipu_admission.read` (GAP-191), `support_consent_grant.issue` (GAP-178), `hope.admin.regenerate_schedules`, M35 `payment_method.write`, and each screen's `requiredPermission`.
- Production deployment: whether any service sets `WARDENX_SIGNUP_REQUIRES_INVITE` or `NODE_ENV=production` (only one compose service checked, `deploy/production/compose.yml:143`); whether any production process runs with role other than `api` so the outbox dispatcher and BullMQ workers start (`index.ts:8403`); whether `audit_hash_chain_enabled` is on for any tenant (if off, audit tamper detection is inactive; pgBackRest comparison documented as not built).
- Whether the audit trigger populates `context.patientId` on every PHI-write row (destruction sweep and legal hold matching derive it, `audit-job-ops.ts:360-366`) was not verified against migrations.
- Idempotency: whether cached 5xx/4xx responses for 24h are intended, whether a denylist excludes PHI response bodies, and the Fastify ordering claim behind GAP-218 were reasoned, not exercised.
- Break-glass bypass across non-step-up ABAC predicates (`require-abac.ts:218-227`), including SUD/consent predicates: legal acceptability under the 42 CFR Part 2 medical-emergency exception was not assessed.
- TLS: nginx vhosts listen on port 80 only and delegate certificate issuance and redirect to the operator; live HTTPS/HSTS posture of API and presigned-URL storage hosts could not be verified. Better Auth's built-in rate limiter and cookie attributes were not verified; the AC-05 credential throttle fails open on store errors and uses a per-replica in-memory store when `REDIS_URL` is unset.
- Runtime inference only (uuid cast of empty `resourceId`, 23503 FK failure, 500 vs 409/422 for raw Postgres exceptions, `DrilldownDekUnavailable` mapped to 500): GAP-025, GAP-034, GAP-055, GAP-092, GAP-168, GAP-056, GAP-201.
- Seam and event specifics not traced: M29 `.attached` emission in production; M5 merge consent re-point by SQL trigger (only TypeScript searched); M28 FHIR export BAA gate (§7.7) and anonymous-endpoint rate limiting; M26 year-close auto-propose and `CapPeriodNotActive` on in-settlement periods; M29 `lab_observation_patient_caseload_or_scope` on attach/discard; M36 channel read for portal users; whether any session-level middleware denies a suspended portal account (GAP-050); M7 `idgMeetingId` ownership check; M14 decision PATCH and recordDecision patient-on-agenda validation; M11 standing-order spawn, verbal-expiry worker and IV overlay gate; M8 alert-cron de-duplication; GAP-127, GAP-125 and GAP-192 sub-items from the prior audit; M39 `consent_recipient` GET read-audit (`consent-routes.ts:358`).
- External vendor behaviour not testable here: DoseSpot wire behaviour (`docs/history/m12-dosespot-adapter.md`), Oregon M24 gateway and credentials, M23 HETS eligibility (503 until `m23HetsConfigFromEnv`), M25 DTM-null frequency in real 835s.
- Spec ambiguities not reported as gaps: M18 geofence tighten-only overrides vs D3; M10 `targetDate` as clinical event date; M20/M16/M19 DEK-rotation re-seal (old versions remain readable via `dekForOrgVersion`, impact unverified); M36 realtime Socket.IO absence (accepted in ADR-0036); M33 MVs counted from migrations only; M30 spec event names vs the 21-event catalog; per-job RLS on M19, M31, M38, M40, M28 workers only spot-checked (M17 sampled).
- Not reported as gaps (judged out of spec or deferred): no malware scanner (no M22 spec text mandates one; architecture defers AV/EDR to phase 2, though GAP-253 notes the opt-in flag); `minio/minio:latest` unpinned in `deploy/production/compose.yml`; the `check-fitness-gaps` PHI guard being a weak proxy.
- Triage coverage: of about 600 TODO/"lands" comments and 121 non-test TODO/FIXME, only M33/M34/M30/M23/M27 samples were evaluated; contradictions between module specs and architecture beyond RLS GUC name, Postgres version and Redis/Valkey were not exhaustively compared; no dead-export tool (knip/ts-prune) was run; the 597 unmatched openapi-path-vs-spec results were too noisy to use; which deny-stub seams remain unregistered at boot was not enumerated.
- Prior audit: no prior GAP ids from the 20261004 report appendix were matched (gaps found independently); `prior_gap_ids` fields in §3 record the lineage the workers cited. Prior P1/P2 route-scope gaps (GAP-017, 020, 024, 029, 030, 033, 035, 036, 045, 046, 050, 051, 055, 064, 081, 088, 097, 132, 145, 148, 151, 153, 172) were spot-checked or not re-verified, and are neither confirmed closed nor reported open.

## 8. Machine-readable appendix

```json
{
  "generated_at": "2026-10-08T12:00:00Z",
  "repo": "WardenX",
  "summary": {
    "p0": 0,
    "p1": 70,
    "p2": 136,
    "p3": 47
  },
  "test_infra_failures": [],
  "gaps": [
    {
      "id": "GAP-001",
      "severity": "P1",
      "category": "seam",
      "module": "M02",
      "title": "POST /collaborators/invite and /funeral/invite are always 403 in production: the route passes {patientId} to caseload_membership, whose M5 implementation reads target.id (live suite masks it with an allow-all stub)",
      "evidence": [
        "apps/backend/src/modules/02-identity/routes/link-routes.ts:90-93 patientTarget returns `{ patientId }`; :153-156 and :191-194 requireAbac(..., \"caseload_membership\", { getTarget: patientTarget })",
        "apps/backend/src/modules/05-patient/seams/caseload-provider.ts:61-67 production predicate `const patientId = typeof target.id === \"string\" ? target.id : null; if (!patientId ...) return false`",
        "packages/auth/src/abac/require-abac.ts:206-212 target passed verbatim; registry.evaluate (abac/registry.ts ~224) does no key mapping; M5 is the only registrant of caseload_membership (grep)",
        "apps/backend/__tests__/m2-link-redemption.live.test.ts:289-290 `registry.register(\"caseload_membership\", async () => true)` hides the mismatch"
      ],
      "verified": true,
      "recommended_fix": "Make the M5 predicate accept `patientId` (and `id`) targets (the platform convention used by caseload_or_scope), or have M2 pass {id}; replace the live-suite stub with the real registered predicate so the mismatch cannot hide.",
      "verification": "Boot with the real M5 seams and call POST /api/v1/collaborators/invite as an assigned RN: returns 403 today (predicate false -> break-glass lookup -> ForbiddenError).",
      "prior_gap_ids": [
        "GAP-115"
      ]
    },
    {
      "id": "GAP-002",
      "severity": "P1",
      "category": "security",
      "module": "M02",
      "title": "No authentication audit trail: login success/failure, account lockout, logout, password reset, 2FA enrol/disable, backup-code use, passkey register/remove and session revoke are neither emitted nor in the action catalog",
      "evidence": [
        "packages/auth/src/identity/mount.ts:60-90 Better Auth proxy records throttle outcome only (`throttle.record`), writes no audit_event",
        "packages/auth/src/identity/auth.ts:331-345 hooks.before only gates sign-up; databaseHooks.session.create.before only blocks inactive users - no audit on any auth event",
        "packages/audit/src/actions/m2.ts (all m2.* actions) contains no auth.login_*, auth.account_locked, auth.logout, auth.password_reset, auth.2fa_*, passkey.*, session.revoked; grep for these names across apps/backend/src, packages/auth/src, packages/audit/src returns nothing",
        "Spec M02 \u00a78.1 audit table lines 1436-1450 requires all of them; \u00a716.2.1 line ~1834 `account-lockout events are also audited (M4)`"
      ],
      "verified": true,
      "recommended_fix": "Register the auth.* / passkey.* / session.revoked actions in the M4 catalog and emit them from Better Auth hooks (after-hooks on sign-in, sign-out, reset, two-factor and passkey endpoints, throttle lockout) with ip prefix and no secrets.",
      "verification": "Sign in with a wrong then right password and query /api/v1/audit/events?eventType=auth.login_failed -> no rows; grep -rn 'auth.login_succeeded' returns nothing.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-003",
      "severity": "P1",
      "category": "spec-drift",
      "module": "M02",
      "title": "M02: MFA enrolment not enforced server-side for staff roles (spec \u00a72.3); /api/auth/verify-email unbacked and requireEmailVerification unset (low impact, sign-up is invite-gated)",
      "evidence": [
        "docs/modules/WARDENX_MODULE_02_IDENTITY_SPEC_v0_4.md:293 (MFA required, enforced at first sign-in setup) and :724 (verify-email route)",
        "packages/auth/src/identity/auth.ts:348-361: the only session-create hook checks user status, with no factor-enrolment check",
        "No staff MFA-enrolment enforcement anywhere in apps/backend/src or packages/auth/src; the only enrolment gate is auditor-specific (apps/backend/src/bootstrap/plugins/authenticate.ts:113, apps/backend/src/modules/02-identity/routes/auditor-enrolment.ts)",
        "packages/auth/src/identity/auth.ts:255-282: emailAndPassword has no requireEmailVerification, and no sendVerificationEmail exists in the code",
        "Mitigation: sign-up is invite-gated (auth.ts ~340-343) and invite accept marks the email verified (identity-stores-db.ts:268 markEmailVerified)"
      ],
      "verified": true,
      "recommended_fix": "Add an authenticate-stage gate that holds a session at an MFA-enrolment stage (like the auditor enrolment stage) until the role-required factor exists; configure email verification or document the invite-accept-only model in the spec.",
      "verification": "Create an invited clinician with no 2FA, sign in, and call a clinical route: succeeds with no factor enrolled.",
      "prior_gap_ids": [
        "GAP-009"
      ]
    },
    {
      "id": "GAP-004",
      "severity": "P1",
      "category": "spec-drift",
      "module": "M02",
      "title": "Primary staff login success/failure, account lockout, logout and 2FA enrol/disable/backup-code use produce no audit_event (only step-up, portal-session and magic-link-redemption paths are audited)",
      "evidence": [
        "Command: grep -rniE 'login_failed|login_succeeded|account_locked|2fa_enrolled|backup_code_used|auth\\.logout|auth\\.login' over apps, packages, scripts, architecture and migrations (excluding node_modules and dist) returns only the UI route id 'auth.login' and m2.session.created billing-event references.",
        "packages/auth/src/identity/mount.ts:57-100: the guarded sign-in path calls throttle.assertUnderBudget and throttle.record only; there is no audit call.",
        "packages/auth/src/identity/auth.ts:331-361: hooks.before only gates /sign-up/email; databaseHooks.session.create.before only refuses inactive users.",
        "apps/backend/src/modules/02-identity/audit/identity-audit.ts:18-32: IDENTITY_AUDIT_EVENTS has no auth, login, logout, lockout or 2FA entries.",
        "Audited counterparts that do exist: apps/backend/src/modules/02-identity/audit/step-up-audit.ts:14-18, session-link-audit.ts, portal-sign-in-store.ts:134,169."
      ],
      "verified": true,
      "recommended_fix": "In the registerIdentityAuth bridge (and a Better Auth after-hook for 2FA/passkey/reset), write the spec'd auth.* audit events through the M4 audit helper (emailHash, ipPrefix only, no secrets); emit auth.account_locked when CredentialThrottleError fires.",
      "verification": "Non-live inject test with a stub auth handler: a 401 sign-in writes auth.login_failed with emailHash; the 6th failure within the window writes auth.account_locked; a 200 writes auth.login_succeeded.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-005",
      "severity": "P1",
      "category": "security",
      "module": "M02",
      "title": "MFA matrix is not enforced server-side: any role can sign in and bind an organization with password only",
      "evidence": [
        "Command: grep -rniE 'mfaRequired|requireMfa|MFA_REQUIRED|twoFactorEnabled' apps/backend/src packages/auth/src returns nothing.",
        "apps/backend/src/modules/02-identity/routes/identity-routes.ts select-organization handler (grep 'select-organization' -A40) contains no factor/enrolment check.",
        "packages/auth/src/identity/auth.ts plugins list: twoFactor() only challenges users who have already enrolled; nothing forces enrolment or blocks two-factor/disable for MFA-required roles.",
        "Spec: docs/modules/WARDENX_MODULE_02_IDENTITY_SPEC_v0_4.md:293 (TOTP required for all clinical/admin roles; passkey for platform_ops and org_admin, enforced at first sign-in), :729 (two-factor/disable blocked if role requires MFA), :315; HIPAA 164.312(d)."
      ],
      "verified": true,
      "recommended_fix": "Before org binding (select-organization) resolve the member's roles, check enrolled factors against the MFA matrix and answer 403 MFA_ENROLMENT_REQUIRED; block two-factor/disable for MFA-required roles.",
      "verification": "Live auth suite: an org_admin without TOTP/passkey cannot select an organization; disabling 2FA for a clinician role returns 403.",
      "prior_gap_ids": [
        "GAP-009"
      ]
    },
    {
      "id": "GAP-006",
      "severity": "P1",
      "category": "spec-drift",
      "module": "M03",
      "title": "No production path creates tenant `role` rows or default role->permission grants: a freshly provisioned tenant has no roles and its first admin invitation attaches nothing",
      "evidence": [
        "apps/backend/src/modules/03-authorization/role-store.ts:29-35: ROLE_TEMPLATES has no sync anywhere; read policy admits org-NULL template rows that nothing creates",
        "apps/backend/src/modules/03-authorization/proposed-role-attacher.ts:42-48: provisioning seeds no role rows; table starts empty outside dev seed scripts",
        "Command: grep -rniE 'insert into[^;]*\\brole\\b' packages/db/migrations returned no role-row inserts (only comments in 0274/0316/0374/0379 saying nothing materializes ROLE_TEMPLATES). Role inserts exist only in scripts/db/seed.ts:385, seed-org-admin.ts:113, seed-staff-personas.ts:396, seed-scenario-doclens.ts:248 and __tests__",
        "apps/backend/src/index.ts:2743-2748: first-admin acceptance selects the org_admin role with organizationId IS NULL and throws 'org_admin role template is unavailable' if absent; nothing in production creates that row (additional impact, not verified at runtime)",
        "scripts/db/sync-permission-catalog.ts:63: only grants to roles already present (SELECT ... FROM role WHERE key = ANY(...) AND organization_id IS NOT NULL)",
        "deploy/production/compose.yml:141,155: the migrate and provision services run migrate.ts --strict and provision-runtime-roles.ts only, with no role seeding"
      ],
      "verified": true,
      "recommended_fix": "Add a role-template materializer (migration/seed + M34 provisioning step, and a backfill for existing orgs) that clones ROLE_TEMPLATES and their default role_permission grants into each org and attaches org_admin to the first-admin invitation without an inviter ceiling (or via a platform-authorised path). Add a live test: provision tenant -> accept first-admin invite -> /me/permissions non-empty.",
      "verification": "On an empty DB: provision a tenant through M34, accept the first-admin invitation and GET /api/v1/me/permissions -> empty set; SELECT count(*) FROM role WHERE organization_id = <new org> -> 0.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-007",
      "severity": "P1",
      "category": "spec-drift",
      "module": "M03",
      "title": "membership_role.scope and role.scope_level are write-only: no authorization decision reads them, so scoping a role grant to a provider entity/location has no effect; the spec's scope and expiry validation rules are not enforced",
      "evidence": [
        "apps/backend/src/modules/03-authorization/routes/authz-routes.ts:309-322 stores `scope: body.scope` (free-form object, authz-typebox.ts:125-126,178-180) and audits it",
        "packages/auth/src/rbac/drizzle-store.ts:43-82 loadGrants selects roleKey/enabled/expiresAt only; :160-170 actor enrichment roleRows selects no scope; :190-196 providerEntityIds come solely from membership.defaultProviderEntityId and locationIds from membership.default_location_ids",
        "grep for membershipRoles.scope / roles.scopeLevel reads in packages/auth/src and apps/backend/src -> only the store view (membership-role-store.ts:20,37) and creation (role-store.ts:193)",
        "No check that a location-scoped role is not granted org-wide, nor that time-bound roles carry expires_at (AssignRoleBody authz-typebox.ts:175-182 expiresAt optional)",
        "Spec M03 \u00a73.4 line 454 `scope jsonb narrower PE/location ids than role default`; \u00a74.2 line 704 provider_entity_scope reads `membership_role.scope`; \u00a72.4 lines 251-252 `Role scope_level >= member scope`, `Time-bound role requires expires_at`"
      ],
      "verified": true,
      "recommended_fix": "Include membership_role.scope in the actor-enrichment/ABAC context and intersect it in provider_entity_scope/location_scope; reject scope wider than role.scope_level and require expires_at for time-bound role categories; add RLS-live + route tests.",
      "verification": "Assign org_admin-level role with scope {locationIds:[X]} and observe permissions/ABAC unchanged for locations outside X.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-008",
      "severity": "P1",
      "category": "security",
      "module": "M04",
      "title": "Legal-hold supremacy is incomplete: holds with dateRange- or resourceKinds-only criteria never stop an audit-row erase at execution, records are not flipped to legal_hold, and no module registers a HoldApplier",
      "evidence": [
        "apps/backend/src/modules/04-audit/routes/audit-typebox.ts:151-160,183-187 and legal-holds.ts:167-176 accept a hold whose only selector is dateRange or resourceKinds",
        "apps/backend/src/modules/04-audit/erasers/audit-eraser.ts:172-190 legalHoldFor matches only `text.includes(input.resourceId)` or `text.includes(input.patientId)` against the criteria JSON - a dateRange/resourceKinds-only hold matches nothing, so runExecuteDestruction erases the rows",
        "apps/backend/src/modules/04-audit/routes/destruction-certificates.ts:93-99,172-185 approve-time check is the only other guard: a resourceKinds-only hold (e.g. ['patient_address']) does not 'cover' dataClass `audit_event.compliance`, and a hold applied after approval is never re-checked",
        "apps/backend/src/modules/04-audit/routes/legal-holds.ts:213-262 apply only INSERTs legal_hold + counts matches (countMatchingEvents); no retention_class flip (spec \u00a72.6) and header (:50-58) says no HoldApplier subscriber exists for m4.legal_hold.applied",
        "Spec M04 \u00a72.5 `Legal hold supremacy ... retention jobs skip legal_hold records unconditionally`, \u00a72.6 `matching records' retention_class flipped`, \u00a710.6"
      ],
      "verified": true,
      "recommended_fix": "Evaluate holds structurally in legalHoldFor (date range overlap with the row's createdAt, resourceKinds membership, patientIds) instead of substring-matching ids; re-check holds inside the execute sweep; bind HoldApplier consumers (M22/M10/M16/M39 already read scope via ports) or document each module's hold read; add live tests for date-range and resource-kind holds.",
      "verification": "Create a legal hold with criteria {resourceKinds:['patient_address']}, approve + execute a destruction certificate covering that month: rows are erased.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-009",
      "severity": "P1",
      "category": "security",
      "module": "M05",
      "title": "POST /patients accepts a client-supplied bypassMatchReview flag that skips the whole duplicate-match pipeline with only patient.create (no patient.create_bypass_match, no step-up, no critical audit)",
      "evidence": [
        "apps/backend/src/modules/05-patient/routes/patient-typebox.ts:72 `bypassMatchReview: Type.Optional(Type.Boolean())` in AdmitBodySchema",
        "apps/backend/src/modules/05-patient/routes/patient-routes.ts:356-371 route guard is only `[CREATE]` = requirePermission(\"patient.create\"); body passed straight to service.admit",
        "apps/backend/src/modules/05-patient/patient-route-service-db.ts:369 `if (!input.bypassMatchReview) {` runs matcher; line 411 `return { outcome: \"created\", ... }` inserts with no check",
        "grep -rn 'create_bypass_match' apps/backend/src -> no reference outside packages/auth/src/permissions/contributed.ts:321 (catalog declaration only)",
        "Spec M05 line 318 (bypass requires patient.create_bypass_match, critical audit with co-sign), line 1350 (`requires patient.create_bypass_match`), line 1355 (401 REAUTH_REQUIRED without step-up), line 1554 (step-up + critical audit), line 2606 (audit event `patient.create_bypass_match` critical)"
      ],
      "verified": true,
      "recommended_fix": "In the POST /patients handler, when body.bypassMatchReview is true require requirePermission(\"patient.create_bypass_match\") AND requireStepUp, and emit the critical `patient.create_bypass_match` audit event (patientId, byUserId, justification); otherwise reject 403. Add a route test that a plain patient.create holder gets 403 with the flag.",
      "verification": "Hit POST /api/v1/patients twice with the same name+DOB+MBI as a user holding only patient.create, the second time with bypassMatchReview:true; today the second returns 201 instead of 403. grep -rn create_bypass_match apps/backend/src should show a guard.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-010",
      "severity": "P1",
      "category": "spec-drift",
      "module": "M05",
      "title": "Admit's matcher is fed only name+DOB+MBI, so the soft-review (>=0.75) and probabilistic hard-block (>=0.92) outcomes are mathematically unreachable and SSN/address/phone/email supplied at admit are silently discarded",
      "evidence": [
        "apps/backend/src/modules/05-patient/patient-route-service-db.ts:370-390 candidate query selects only lastName, firstName, dob, mbi (no address/phone/email/ssn) and builds MatchCandidate from them",
        "apps/backend/src/modules/05-patient/matching/matcher.ts:105-122 probabilisticScore: with no address/phone/email the maximum is 0.25+0.15+0.20 = 0.60 < soft floor 0.75; deterministic rule 2 (SSN+DOB) and rule 3 (DOB+name+address) cannot fire without candidate ssn/address (matcher.ts:79-95)",
        "apps/backend/src/modules/05-patient/patient-route-service-db.ts:313,331-361 insertPatient writes only patient + mrn/mbi identifier; comment at :313 `SSN is NOT stored ... nor are name_alias / address / phone / email (also follow-ups)`",
        "apps/backend/src/modules/05-patient/routes/patient-typebox.ts:59-71 AdmitBodySchema accepts ssn, primaryAddress, phone, email and returns 201 although none is persisted (no 422, no deferral error)",
        "Net effect: only an exact MBI match blocks; a same-name, same-DOB patient with no MBI is created as a duplicate with matchReviewIds always empty",
        "Spec M05 \u00a72.3 lines 296-318 (deterministic rules, weights, thresholds) and \u00a77.1/\u00a77.3"
      ],
      "verified": true,
      "recommended_fix": "Load each candidate's primary address, phone-last7, email and SSN hash (or a blocking-key subset) into MatchCandidate so the \u00a72.3 pipeline can reach its thresholds, or at minimum block on exact DOB+last+first. Persist (or explicitly reject with 422) ssn/address/phone/email on admit. Add a live test that a same-name/DOB/address admit returns 409 and a near-match returns matchReviewIds.",
      "verification": "Unit: runMatch with candidates built exactly as patient-route-service-db.ts builds them can never return soft_review; live: admit the same person twice without MBI and observe two patients.",
      "prior_gap_ids": [
        "GAP-019"
      ]
    },
    {
      "id": "GAP-011",
      "severity": "P1",
      "category": "security",
      "module": "M07",
      "title": "Care-plan signature records a client-claimed signerRole that is never checked against the signing user's own roles; one user can fill every quorum slot",
      "evidence": [
        "apps/backend/src/modules/07-care-plan/routes/care-plan-routes.ts:243-262 - POST .../signatures passes body.signerRole straight into service.signVersion; guards are only [SIGN, SCOPE, SIGNER_MATCH, SIGN_STEP_UP]",
        "apps/backend/src/modules/07-care-plan/abac-predicates.ts:336-346 - signer_role_match is built with default params target (versionId) so it never sees body.signerRole; it passes if the caller holds ANY role matching ANY slot of the set",
        "apps/backend/src/modules/07-care-plan/care-plan-route-service-db.ts:1168-1207 - signVersion calls decideRecordSignature(set, alreadySigned, signerRole) and inserts signerRole from the body with membershipId = actor; no check that the actor holds signerRole, none that the same membership has not already signed another slot",
        "packages/db/migrations/0127_care_plan_m7_write_lifecycle.sql:37 - only unique index is (care_plan_version_id, signer_role) WHERE invalidated_at IS NULL; no uniqueness on membership",
        "Spec M07 line 1184/1190: signer_role_match = caller's eligible signer roles intersect the set, 'checked at sign-attempt time ... 403 signer_role_match_failed'",
        "Same defect in in-memory service apps/backend/src/modules/07-care-plan/routes/service.ts:765-792"
      ],
      "verified": true,
      "recommended_fix": "Bind the slot to the caller: reject unless hasRole(actor, body.signerRole) (map role keys to CarePlanSignerRole server-side), reject when the same membership already holds a non-invalidated signature on the version (add a partial unique index on (care_plan_version_id, membership_id)), and give signer_role_match a getTarget that carries body.signerRole so the predicate and service agree.",
      "verification": "Add a service/route test: user with only rn_case_manager POSTs signerRole 'hospice_physician' then 'msw' then 'chaplain' on an idg_review version; expect 403 SIGNER_ROLE_MISMATCH for roles not held and 409 for a second signature by the same membership. Live suite m7-care-plan-write.live.test.ts should assert the unique index.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-012",
      "severity": "P1",
      "category": "security",
      "module": "M07",
      "title": "Finalize accepts a client-supplied requiredSignerSet; 'never loosen below the floor' is enforced only by comparing array length",
      "evidence": [
        "apps/backend/src/modules/07-care-plan/routes/care-plan-typebox.ts:91-93 - FinalizeVersionSchema.requiredSignerSet is an optional array of {role, count>=1}",
        "apps/backend/src/modules/07-care-plan/routes/care-plan-routes.ts:226-241 - body.requiredSignerSet forwarded to service.finalizeVersion",
        "apps/backend/src/modules/07-care-plan/care-plan-route-service-db.ts:1129-1141 - 'if (set.length < floor.length) throw'; any set with >= as many slots replaces the stored set (roles/counts not compared). routes/service.ts:700 same",
        "packages/types/src/care-plan.ts:175-187 - floors are [physician|NP, rn_case_manager] and [rn_case_manager, msw, chaplain, physician|medical_director]; a body like [{rn_case_manager,1},{chaplain,1}] satisfies the length test and drops the physician seat",
        "Spec M07 line 1403 (D5): 'per-tenant tightening allowed via configuration; loosening below the floor refused'"
      ],
      "verified": true,
      "recommended_fix": "Drop the per-request override or validate that every floor slot (role, count) is covered by the supplied set (superset check) and source tightening from tenant configuration, not the request body.",
      "verification": "Unit test: finalize an initial version with requiredSignerSet [{rn_case_manager,1},{chaplain,1}] must be 422/409; superset [floor + msw] must pass.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-013",
      "severity": "P1",
      "category": "spec-drift",
      "module": "M08",
      "title": "Late-entry tier (24h/72h/14d) is never computed; encounters sign as 'normal' however late, so reason/override gates and billing guard are dead",
      "evidence": [
        "apps/backend/src/modules/08-encounters/late-entry/tiers.ts:48-55 computeLateEntryTier, override.ts requiresLateEntryOverride/decideSignificantLateOverride/decideAdministrativeLateOverride, validation.ts checkLateEntryReason: no non-test caller (only apps/backend/__tests__/encounter-late-entry.test.ts)",
        "apps/backend/src/modules/08-encounters/encounters-route-service-db.ts:1710-1790 (finalize) and 1821-1990 (sign) never set late_entry_tier; packages/db/migrations/0030_encounters_m8_tables.sql:33 default 'normal'",
        "apps/backend/src/modules/08-encounters/gate/checks.ts:78-86 declares check 5 'elsewhere' (override routes), but those routes only set a tier on request (service lines 2007-2062) and emit daysLate: 0 (lines 2031, 2061)",
        "apps/backend/src/modules/08-encounters/seams/readers.ts:36-41 deriveBillability's late_entry_unattested branch can never fire unless a supervisor manually sets a tier",
        "Spec M08 \u00a72.5 lines 276-287: 'tier is computed at finalize-time and reified on the encounter row'; \u00a72.7 table: late_entry_reason >= 40 chars -> 422 LATE_ENTRY_REASON_REQUIRED"
      ],
      "verified": true,
      "recommended_fix": "At finalize (and re-evaluated at sign) compute the tier from service_date vs the org-local day (org timezone), persist it, require reason (>=40) for late_entry, require attested supervisor/director override before sign for the two higher tiers, and compute real daysLate in override events.",
      "verification": "Route/service test: encounter with serviceDate 5 days ago finalizes+signs -> expect 422 until override attested; 20 days -> administrative_override required; assert encounter.late_entry_tier persisted and m8.encounter.signed carries it. Add live assertion in m8 write suite.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-014",
      "severity": "P1",
      "category": "spec-drift",
      "module": "M08",
      "title": "Late-entry, administrative and supervisor-release overrides lack step-up auth (D13) and caseload scope",
      "evidence": [
        "apps/backend/src/modules/08-encounters/routes/encounters-routes.ts:625-636 late-entry-override preHandler [LATE_OVERRIDE] only",
        "apps/backend/src/modules/08-encounters/routes/encounters-routes.ts:639-650 administrative-override preHandler [ADMIN_OVERRIDE] only",
        "apps/backend/src/modules/08-encounters/routes/encounters-routes.ts:714-727 supervisor-release preHandler [COSIGN_RELEASE] only",
        "Spec \u00a74.1 rows 15, 16, 21 (lines 1136,1137,1142) list step_up_fresh; \u00a76 matrix lines 1542-1544 add caseload_or_scope for supervisor release and late-entry override; D13 (line 1862): 'override routes all require step_up_auth_at within 5 minutes'",
        "Sign/cosign/addendum-sign routes do compose STEP_UP (lines 605-611, 698-702) - the override routes are the omission"
      ],
      "verified": true,
      "recommended_fix": "Add STEP_UP('encounter.late_entry_override'|'encounter.administrative_override'|'encounter.cosign_supervisor_release') and SCOPE_FOR(...) (late-entry + supervisor-release) to the three routes; add an administrative-override reason >=100 check in typebox as well as the DB CHECK.",
      "verification": "Route test with a session whose last step-up is stale -> expect 412/403 STEP_UP_REQUIRED on each of the three routes; out-of-caseload supervisor without org-wide scope -> 404.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-015",
      "severity": "P1",
      "category": "security",
      "module": "M10",
      "title": "HOPE timeliness gate bypass: adminOverride is a request-body boolean any timepoint writer can set (the platform-admin override permission is defined but never enforced); window is judged on client-supplied targetDate",
      "evidence": [
        "apps/backend/src/modules/10-hope/routes/hope-typebox.ts:185,196 adminOverride: Type.Optional(Type.Boolean()) on RecordTimepoint/RecordSfv",
        "apps/backend/src/modules/10-hope/routes/hope-routes.ts:269-289 and 292-309 - preHandler [WRITE, SCOPE, ABAC_*] only; body.adminOverride forwarded",
        "apps/backend/src/modules/10-hope/hope-route-service-db.ts:1202-1212 assertCaptureAllowed(args.targetDate, window, {adminOverride}) and 1336 planSfvCompletion(... {adminOverride})",
        "packages/hope/src/recording/timepoint-gate.ts:88-92 expired is allowed when adminOverride === true; sfv.ts:96-110 same for past-due SFV",
        "packages/auth/src/permissions/contributed.ts:1311 defines hope.admin.late_deadline_override; no code references it (grep over apps/ and packages/ src)",
        "Spec M10 line 86: writes past late_deadline_at rejected 'with an admin-override path that requires platform-admin justification'; line 1606 names hope.admin.late_deadline_override; classification uses the body targetDate rather than server time, so a late filer can also send an in-window targetDate and get was_late=false with no reason code"
      ],
      "verified": true,
      "recommended_fix": "Remove adminOverride from the public body; add a separate route/permission check requiring hope.admin.late_deadline_override plus a justification, audited; classify capture against server now (or validate targetDate against now) so was_late/expired cannot be self-declared.",
      "verification": "Route test: RN with hope.timepoint.write posts adminOverride:true past late_deadline -> 409 M10_TIMEPOINT_EXPIRED; same user sends in-window targetDate on a date past the deadline -> rejected or flagged late. Live suite for the recording path.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-016",
      "severity": "P1",
      "category": "seam",
      "module": "M11",
      "title": "M29 to M11 lab-result handshake is unbuilt. Order results_status never leaves awaiting_results, m11.order.results_received and _critical are never emitted, and the lab-results review queue is always empty.",
      "evidence": [
        "Spec M11 line 1499 requires a lab-results-applier consuming m29.lab_observation.attached to flip results_status, set results_first_received_at and emit m11.order.results_received (and _critical). There is no such file under apps/backend/src/modules/11-orders/.",
        "apps/backend/src/modules/29-external-interfaces/events-by-m29.ts:363-380,395-410 declare m29.lab_observation.attached and .unmatched with declaredConsumers: [], so arch:outbox-bindings cannot flag the missing consumer (the gate prints green).",
        "m11.order.results_received has no emit site anywhere (grep of apps/ and packages/ finds only the catalog entries events-by-m11.ts:482 and packages/types/src/orders.ts:174 and the M22 consumer). m11.order.results_received_critical appears only in packages/types/src/orders.ts:175.",
        "M22 already binds the dead event (apps/backend/src/index.ts:9122 buildM22LabBackrefConsumer), so lab_results_pdf render never fires.",
        "Nothing writes order_record.results_status = 'results_received' or results_first_received_at (orders-route-service-db.ts only reads them at :918,1540,1815). resultsPendingReview (orders-route-service-db.ts:915-921) therefore always returns [].",
        "order-sweeps.ts:218-276 flips awaiting_results to results_overdue after the expected-by time and alerts, so every returned lab ends up falsely flagged overdue."
      ],
      "verified": true,
      "recommended_fix": "Build the lab-results-applier consumer and bind it in index.ts. Add m11 to the declaredConsumers of m29.lab_observation.attached and .unmatched so the bindings gate covers it. Emit results_received and results_received_critical. Add a real-publisher live suite that runs attach then results_status then M22 render.",
      "verification": "Grep of the whole repo for writers of results_status and emitters of the events; spec line 1499 read. Whether M29 actually emits .attached in production was not verified (batch 4/6 scope).",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-017",
      "severity": "P1",
      "category": "security",
      "module": "M11",
      "title": "Verbal-order 48h signature clock starts at a client-supplied receivedAt with no bound against server time (M11 and M12)",
      "evidence": [
        "apps/backend/src/modules/11-orders/routes/orders-typebox.ts:146-148 receivedAt is an unconstrained date-time",
        "apps/backend/src/modules/11-orders/routes/orders-routes.ts:~540-563 passes body.receivedAt to service.recordVerbal",
        "apps/backend/src/modules/11-orders/orders-route-service-db.ts:1178 computeVerbalDeadline(args.receivedAt) and :1201 stores new Date(args.receivedAt); same at :1000/:1017 for createVerbalOrder",
        "apps/backend/src/modules/11-orders/seams/providers.ts:83 computeVerbalDeadline(input.receivedAt, policy) used by M12 via recordVerbalOrder",
        "packages/orders/src/lifecycle/verbal-window.ts:78-86 pure, Date.parse(receivedAt), no clamp",
        "packages/db/migrations/0036_orders_m11_tables.sql:110 received_at NOT NULL only, no CHECK or trigger",
        "apps/backend/src/modules/12-dosespot/routes/dosespot-typebox.ts:122 and dosespot-route-service-db.ts:~982-986 forward args.receivedAt"
      ],
      "verified": true,
      "recommended_fix": "Reject receivedAt later than server now (plus small skew) and earlier than a bounded look-back. Prefer server-stamped time with an optional earlier clinician time under a reason. Add a DB CHECK deadline_at <= received_at + platform floor and received_at <= now()+skew. Apply to M11 routes, the M12 verbal route and the OrderSignatureProvider seam.",
      "verification": "Code reading of route, schema and service; no live run.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-018",
      "severity": "P1",
      "category": "spec-drift",
      "module": "M12",
      "title": "Standard medication-order sign writes no signature record. Signer identity, attestation and signedAtClient are not persisted, and the M11 sign seam is not called.",
      "evidence": [
        "apps/backend/src/modules/12-dosespot/dosespot-route-service-db.ts signOrder (~858-892): direct UPDATE to status=signed and signedAt only, no signOrderTarget call",
        "dosespot-route-service-db.ts:25-27 header admits the seam is not threaded and no order_signature row is written; getOrderSignatureProvider is used only at :979 (verbal) and :1059 (cosign)",
        "apps/backend/src/modules/12-dosespot/routes/dosespot-routes.ts:345-347 passes signedAtClient; the service never reads it",
        "Spec: docs/modules/WARDENX_MODULE_12_DOSESPOT_PRESCRIBING_SPEC_v0_2.md line 53 (D3), line 1100 (sign route: calls M11 signOrderTarget), line 1502 (M11 writes the order_signature row); line 1103 is the verbal route and was mis-cited"
      ],
      "verified": true,
      "recommended_fix": "Call signOrderTarget (targetKind='medication_order') in the sign transaction, using the same request-scoped seam pattern as cosign, so an order_signature row with signer, role, attestation and server time exists for every signed prescription. Do the same in signControlledComplete and retransmit.",
      "verification": "Code reading; grep of getOrderSignatureProvider usage.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-019",
      "severity": "P1",
      "category": "stub",
      "module": "M12",
      "title": "POST /api/v1/rx-benefit/lookup is a stub that always answers covered:true",
      "evidence": [
        "apps/backend/src/modules/12-dosespot/dosespot-route-service-db.ts:1418-1420: rxBenefitLookup ignores org/patient/rxcui and returns { covered: true, copayCents: null }.",
        "apps/backend/src/modules/12-dosespot/routes/service.ts:1298-1300: in-memory service has the same constant body.",
        "apps/backend/src/modules/12-dosespot/routes/dosespot-routes.ts:662-669: the route returns service.rxBenefitLookup(...) directly, with no cache read. rx_benefit_cache is referenced only by jobs/rx-benefit-prewarm.ts (write) and erasers/dosespot-eraser.ts (delete).",
        "apps/backend/src/modules/12-dosespot/jobs/queue-catalog.ts:84-88: lookupRxBenefit fails closed and the cache stays empty until a sandbox-verified endpoint exists, which contradicts the route's constant covered:true.",
        "Spec docs/modules/WARDENX_MODULE_12_DOSESPOT_PRESCRIBING_SPEC_v0_2.md:1119: POST /api/v1/rx-benefit/lookup is a 'cached lookup'.",
        "REMOVE the OpenAPI 201 point: scripts/openapi/enrichments.ts:4964-4967 declares no status override."
      ],
      "verified": true,
      "recommended_fix": "Read rx_benefit_cache (fresh row for the patient and rxcui, tenant-scoped). Return an explicit {status:'unknown'} (or 503/501) when there is no cached or verified answer. Never fabricate 'covered'. Fix the OpenAPI status.",
      "verification": "Code reading; grep for all rxBenefit readers.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-020",
      "severity": "P1",
      "category": "spec-drift",
      "module": "M13",
      "title": "Production eMAR write path never runs the five-rights check, and BCMA scans are evaluated against an empty order/patient context",
      "evidence": [
        "apps/backend/src/modules/13-emar/emar-route-service-db.ts:995-1007 passes { orderActive: true, rxnormRxcui: null, ndc: null } and { wristbandPayloadDigest: null } to evaluateBarcodeScan. In packages/emar/src/barcode/barcode-match.ts:80-91 a conflict needs the same token on BOTH scan and order, so wrong_drug and wrong_patient can never fire; only 'expired' can.",
        "assertFiveRights is referenced only by the in-memory service (apps/backend/src/modules/13-emar/routes/service.ts:29,636,651,879,987). `grep assertFiveRights|checkFiveRights` over apps/ and packages/ (excluding tests) finds no call in emar-route-service-db.ts.",
        "recordAdministration (emar-route-service-db.ts:770-1010) checks only patient/order agreement for the scheduled dose and kit. It does not check dose <= order dose, route, or future administeredAt.",
        "The file header admits it: emar-route-service-db.ts:44-48 says 'The \u00a75.11 five-rights validation against the order projection remains open'.",
        "Spec M13 line 156 makes 'five-rights validation passes' a precondition of the committing transition. Line 290 requires the same on the caregiver path. Line 92 maps it to Joint Commission MM.05/06."
      ],
      "verified": true,
      "recommended_fix": "Extend EmarMedicationOrderPort.administrationIdentity with dose, unit, rxnorm, ndc and the patient wristband digest. Call assertFiveRights in recordAdministration, recordCaregiverAttested and offlineSync. Pass real order and patient context to evaluateBarcodeScan. Add a live test where a wrong-route or over-dose request returns 422 FIVE_RIGHTS_VIOLATION.",
      "verification": "Code reading plus grep of call sites. Unit tests for M13 pass (550 tests) but cover the in-memory slice only. Not exercised live.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-021",
      "severity": "P1",
      "category": "stub",
      "module": "M13",
      "title": "PRN minimum-interval gate (assertPrnInterval) is dead code in production",
      "evidence": [
        "packages/emar/src/prn/interval.ts:44-90 defines checkPrnInterval and assertPrnInterval (422 PRN_INTERVAL_VIOLATION, supervisor override). A repo-wide grep (excluding tests and dist) finds no caller outside the definition file.",
        "emar-route-service-db.ts:1132-1146 only emits m13.prn_administration_recorded. It never queries the prior PRN dose for the order and never compares it with the minimum interval.",
        "Spec M13 line 204: 'PRN minimum-interval enforcement ... is enforced at the PRN-administration write ... returns 422'. Line 1912 requires an audit event administration.prn_interval_violation."
      ],
      "verified": true,
      "recommended_fix": "In recordAdministration, when args.prn is set, load the most recent committed PRN administration for the order and patient and call assertPrnInterval with the order's prnPolicy.minimumIntervalMinutes and the supervisor-override permission. Emit the violation audit.",
      "verification": "grep of references; code reading.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-022",
      "severity": "P1",
      "category": "seam",
      "module": "M13",
      "title": "No code writes prn_administration. The PRN reassessment-overdue cron and M30 prn_effectiveness measure read a permanently empty table.",
      "evidence": [
        "The only INSERT INTO prn_administration statements are in live tests: apps/backend/__tests__/m13-emar-crons.live.test.ts:736,763, m13-emar-read-service.live.test.ts:193 and packages/db/migrations/__tests__/m13-rls-isolation.live.test.ts:164.",
        "emar-route-service-db.ts:1132-1146 emits m13.prn_administration_recorded with prnAdministrationId: randomUUID() (no row behind it), reassessmentDueAt hard-coded to +60 min, and scale hard-coded to 'esas_r'. It ignores administration_policy.defaultPrnReassessmentWindowMinutes.",
        "scripts/outbox-deferred-consumers.ts:349-353 records that M9 does not consume the event, so the planned M9 materializer does not exist.",
        "jobs/deadline-sweeps.ts:235-297 selects from schema.prnAdministrations; apps/backend/src/modules/30-quality/jobs/m30-jobs.ts:785-791 reads the same table for prn_effectiveness_documented_rate.",
        "Because the live tests seed rows by raw SQL, the crons look green while production data never reaches them."
      ],
      "verified": true,
      "recommended_fix": "Insert the prn_administration row inside the same transaction as the administration commit. Use the policy window and the order's recommended scale. Emit the event with the real row id. Add a live test that records a PRN dose through the route and then runs the sweep.",
      "verification": "Repo-wide grep for inserts into the table; read of both writer and reader.",
      "prior_gap_ids": [
        "GAP-040"
      ]
    },
    {
      "id": "GAP-023",
      "severity": "P1",
      "category": "spec-drift",
      "module": "M13",
      "title": "Reconciliation worksheet finalize, void and decision writes have no status guard and do not require every line decided. The spec-correct pure finalizer is unused.",
      "evidence": [
        "emar-route-service-db.ts:1678-1727 finalizeReconciliation loads the worksheet and only requires decisions.length >= 1. It does not check worksheet status, so a voided or already-finalized worksheet can be finalized again. It emits lineSummary: {}.",
        "emar-route-service-db.ts:1728-1739 voidWorksheet has no status guard, so a finalized worksheet can be voided.",
        "emar-route-service-db.ts:1596 recordDecision runs an unconditional UPDATE ... SET status='in_progress', which reopens a finalized or voided worksheet. updateDecision (line 1634) and addCaregiverReportedLine (line 1660) also never check worksheet status.",
        "packages/emar/src/reconciliation/reconciliation.ts:323-345 finalizeReconciliationWorksheet (terminal-state check plus every-line-decided check) is referenced only by packages/emar/__tests__/reconciliation.test.ts.",
        "emar-route-service-db.ts:1672 writes decisionMadeByMembershipId: PATIENT_SENTINEL ('00000000-...-0000000000aa') for a caregiver-reported line. The actor of a clinical decision is a fake id, not the caller.",
        "Spec M13 line 276 and decision D17: 'finalized when every line has a decision'. Line 1427: finalize returns 422 RECONCILIATION_INCOMPLETE. Compromise (7) at emar-route-service-db.ts:54-55 admits the weaker rule."
      ],
      "verified": true,
      "recommended_fix": "Store the expected line set (or count lines at open). Call finalizeReconciliationWorksheet from finalize. Add terminal-status guards to recordDecision, updateDecision, addCaregiverReportedLine and void. Pass the real userId on addCaregiverReportedLine. Populate the completed event's per-line decisions.",
      "verification": "Code reading; pure function confirmed unreferenced by grep.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-024",
      "severity": "P1",
      "category": "spec-drift",
      "module": "M13",
      "title": "POST /scheduled-doses/:id/intentional-hold discards the reason, writes no missed_dose row, has no status or grace guard and omits the ABAC floor",
      "evidence": [
        "emar-route-service-db.ts:1512-1525 does UPDATE scheduled_dose SET status='intentionally_held' for any id. It has no status guard, so an administered, missed or controlled dose can be overwritten. It writes no missed_dose row with missed_kind='intentionally_held' and does not check the grace window.",
        "routes/emar-routes.ts:527-541 parses IntentionalHoldRequest.reason (emar-typebox.ts:151-153) and discards it. It never passes it to the service. The emitted payload carries no reason.",
        "The route guard is RECORD_MISSED plus SCOPE only. Spec route 14 (M13 line 1292) also requires administering_clinician_eligible.",
        "Spec M13 line 219: an intentional hold is a missed_dose row with missed_kind='intentionally_held' plus a (denylisted) reason, recorded before the grace window expires."
      ],
      "verified": true,
      "recommended_fix": "Require pending status and now < due_at+grace. Insert a missed_dose row with kind, reason and recorded-by. Add the administering_clinician_eligible ABAC guard. Include the reason in the event.",
      "verification": "Code reading of route and service.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-025",
      "severity": "P1",
      "category": "discovered",
      "module": "M17",
      "title": "Reassignment-scan and caregiver-reminder crons run with a sentinel actor in app.user_id; the audit trigger FK fails whenever they write",
      "evidence": [
        "apps/backend/src/modules/17-scheduling/scheduling-route-service-db.ts:1923 and :1934: withOrgContext(db, { organizationId: orgId, userId }, ...) with no orgContextFor(); compare :1649 and :1868, which use orgContextFor().",
        "apps/backend/src/modules/17-scheduling/jobs/cron-workers.ts:111 and :122 pass M17_WORKER_SYSTEM_USER_ID (alias of M17_SYSTEM_USER_ID, system-actor.ts:13). The orgContextFor sentinel-to-systemOrgContext mapping (system-actor.ts:20-24) is bypassed.",
        "packages/tenancy/src/context.ts:77-78 and :99: a non-empty userId is set verbatim as app.user_id.",
        "packages/db/migrations/0269_m17_evv_missing_resolution.sql:45-66 (supersedes 0045:237-274): trigger trg_audit_visit writes NULLIF(current_setting('app.user_id'),'')::uuid to audit_event.actor_user_id. FK to users.id at packages/db/src/schema/audit-events.ts:22.",
        "No user row is seeded for the sentinel: a grep of packages, apps, scripts and docs finds only the constant and tests.",
        "apps/backend/src/modules/17-scheduling/reassignment-scan.ts:100-104 and :190-194 UPDATE visit, which fires the audit trigger. These writes happen only when a visit is due, so empty ticks succeed."
      ],
      "verified": true,
      "recommended_fix": "Use orgContextFor(orgId, userId) at lines 1923 and 1934 (or systemOrgContext). Change the live test to pass M17_SYSTEM_USER_ID so it reproduces production.",
      "verification": "Static trace of worker -> service -> withOrgContext -> trigger. The 23503 inference rests on the FK in the schema and the module's own system-actor.ts comment; not executed.",
      "prior_gap_ids": [
        "GAP-052"
      ]
    },
    {
      "id": "GAP-026",
      "severity": "P1",
      "category": "spec-drift",
      "module": "M17",
      "title": "POST /recurring-visits discards the client's time window, timezone, dates, count, byday and address; every recurring visit is materialised at 09:00-10:00 UTC with no address",
      "evidence": [
        "apps/backend/src/modules/17-scheduling/routes/scheduling-typebox.ts:233-247 requires timeOfDayStart, timeOfDayEnd, timeZone and startDate (plus optional endDate, count, byday, patientAddressId).",
        "routes/scheduling-routes.ts:551-558 forwards only patientId, admissionId, assignedMembershipId, visitPurpose, visitSetting, rrule.",
        "scheduling-route-service-db.ts:1533-1543 hard-codes timeOfDayStart '09:00', timeOfDayEnd '10:00', timeZone 'UTC', startDate = today (UTC); patientAddressId and externalFacilityId are never set.",
        "materializeRecurringVisitsForOrg (1643-1700) schedules from those stored fields and passes policy.patientAddressId (null) into insertAndPublish."
      ],
      "verified": true,
      "recommended_fix": "Persist and validate all fields the schema requires (window, tz, startDate/endDate/count, byday, address/facility) and enforce the endDate-xor-count rule. Add a contract test that a created policy round-trips.",
      "verification": "Read route, service and typebox.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-027",
      "severity": "P1",
      "category": "stub",
      "module": "M18",
      "title": "Every EVV aggregator submission carries an empty service-type code: capture hard-codes serviceTypeCode '' and discards the client value",
      "evidence": [
        "apps/backend/src/modules/18-evv/evv-route-service-db.ts:476-478 inserts serviceTypeCode: \"\" and postingDisciplineAtRecording: \"\".",
        "routes/evv-routes.ts:178-186 never passes b.serviceTypeCode, although routes/evv-typebox.ts:39 requires it.",
        "jobs/submission-worker.ts:233 builds the payload from checkOut.serviceTypeCode, read from evv_event.service_type_code (:248-252), i.e. always ''. The registration's serviceTypeCode (outbox-consumers/m17-visit-published.ts:81) is not used."
      ],
      "verified": true,
      "recommended_fix": "Resolve serviceTypeCode (M38-validated) and the posting discipline server-side at capture, or fall back to the registration row, and fail the capture if unresolved. Reject an empty code in the adapter payload builder.",
      "verification": "Read capture and submission path.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-028",
      "severity": "P1",
      "category": "seam",
      "module": "M18",
      "title": "Aggregator submission path cannot succeed: Sandata transport is deny, credentials unbound, state identifier throws, NPI null",
      "evidence": [
        "apps/backend/src/modules/18-evv/jobs/wiring.ts:1-12 and :35-65 - createDenySandataTransport(), createUnboundAggregatorCredentialStore(), patientStateIdentifier() throws EvvAggregatorPortUnboundError, clinicianNpi() returns null.",
        "index.ts:3391-3393 builds these deps for production."
      ],
      "verified": true,
      "recommended_fix": "Bind a real SandataTransport, a KMS-backed credential store, an M5 decrypting state-id reader and clinician NPI source, or record the launch-state decision explicitly.",
      "verification": "Read wiring.ts and the index.ts call. No runtime attempt made.",
      "prior_gap_ids": [
        "GAP-056"
      ]
    },
    {
      "id": "GAP-029",
      "severity": "P1",
      "category": "seam",
      "module": "M19",
      "title": "M17 owns no on-call roster source: tonightsOnCallRoster always throws, so M19 roster-sync (shift-sync) is permanently degraded and creates no shifts",
      "evidence": [
        "apps/backend/src/modules/17-scheduling/seams/drizzle-store.ts:70-86 (SchedulingOnCallRosterUnavailableError) and :294-299 (onCallRoster throws unconditionally)",
        "apps/backend/src/modules/17-scheduling/seams/providers.ts:45-46 (reader forwards to store.onCallRoster)",
        "apps/backend/src/index.ts:1903-1915 (Drizzle store bound on db boot; comment acknowledges the throw)",
        "apps/backend/src/modules/19-oncall/consumers/trigger-context.ts:161-175 (throw mapped to {kind:'unavailable'})",
        "apps/backend/src/modules/19-oncall/jobs/reconcile.ts:17-26 (header: every production call resolves unavailable, empty degraded plan)",
        "docs/modules/WARDENX_MODULE_19_ONCALL_TRIAGE_SPEC_v0_3.md:46 (done-gate requires the M17 tonightsOnCallRoster consumer wired against the real M17)",
        "docs/modules/WARDENX_MODULE_17_SCHEDULING_SPEC_v0_2.md:844 (tonightsOnCallRoster published in the section 4.3 reader)"
      ],
      "verified": true,
      "recommended_fix": "Add the M17 on-call source (or move ownership to M19) and implement the reader, or amend both specs and the oncall_eligible fallback so Direct tenants have a supported path.",
      "verification": "Read both files.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-030",
      "severity": "P1",
      "category": "security",
      "module": "M20",
      "title": "POST /safety/check-ins closes any clinician's schedule row: scheduleId is not bound to the posting clinician",
      "evidence": [
        "apps/backend/src/modules/20-field-safety/routes/write-service-drizzle.ts:637-650 - UPDATE safety_check_in_schedule SET state='recorded', fulfilled_by_check_in_id WHERE id = input.scheduleId AND organization_id = actor.organizationId. There is no clinician_membership_id = actor.membershipId predicate and no actionable-state predicate.",
        "The row carries the owner: packages/db/src/schema/safety/safety-check-ins.ts:68 (clinician_membership_id). Only an audit trigger exists on the table (packages/db/migrations/0111_field_safety_m20_rls_audit_triggers.sql:270-306), so nothing else binds the poster to the owner.",
        "The response also reports scheduleClosed: input.scheduleId !== undefined regardless of whether any row matched (same function, ~line 676).",
        "Route guard is only ABAC_SELF(() => ({})) at routes/check-ins.routes.ts:57-59, which checks the poster, not the schedule."
      ],
      "verified": true,
      "recommended_fix": "Add eq(SCHEDULE.clinicianMembershipId, actor.membershipId) and a state IN actionable-states predicate to the UPDATE. Reject (404/403) when zero rows match and derive scheduleClosed from the returned rows. Add a live test where clinician B posts against clinician A's overdue scheduleId.",
      "verification": "Read write-service-drizzle.ts:541-684 and the schema column. Not exercised against a DB (live suites prohibited).",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-031",
      "severity": "P1",
      "category": "security",
      "module": "M20",
      "title": "SOS cancel biometric requirement is satisfied by any non-empty client-supplied biometricVerificationToken; the token is never verified",
      "evidence": [
        "apps/backend/src/modules/20-field-safety/routes/write-service-drizzle.ts:962-965 - biometricResult: input.biometricVerificationToken !== undefined ? \"passed\" : null. The adjacent comment says verification 'is M2's', but no M2 call exists anywhere in cancelSos (lines 944-1027).",
        "routes/m20-typebox.ts:287-289 - the field is a free Type.String(minLength 1).",
        "lifecycle/sos-alert.ts:258 - the machine only refuses when biometricResult !== 'passed', so any string passes."
      ],
      "verified": true,
      "recommended_fix": "Verify server-side: derive the verdict from a server-stamped session attribute (as stepUpRecent is) or call M2's step-up/biometric verifier with the token. Treat an unverifiable token as 'failed'. Add a test that an arbitrary string is rejected.",
      "verification": "Read cancelSos and the typebox. Grep shows no verifier call.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-032",
      "severity": "P1",
      "category": "stub",
      "module": "M20",
      "title": "SOS ladder never reaches or executes the emergency terminus: tier-3 SLA breach stalls; dial/PSAP/page effects are not implemented",
      "evidence": [
        "apps/backend/src/modules/20-field-safety/jobs/cron-workers.ts:36-52 - header states the tier-3 -> emergency_terminus rung is deliberately refused; a breached tier-3 alert is only logged (sosTerminusUnsupported) and left at escalation_tier_3.",
        "routes/effects-runner.ts:120-125 - CALLER_OWNED_EFFECT_KINDS = request_visit_cancellation, dial_emergency_contact, surface_psap_number, page_wardenx_ops are never executed by runEffects.",
        "grep for dial_emergency_contact / surface_psap_number / page_wardenx_ops outside lifecycle/ and jobs/ finds no implementer; they appear only in lifecycle/sos-alert.ts:350-395 and lifecycle/effects.ts.",
        "consumers/m36-delivery-failed.ts makes the same refusal for its edge."
      ],
      "verified": true,
      "recommended_fix": "Implement the three terminus effects (M36 voice dial to consented emergency contact, M40 PSAP jurisdiction lookup, platform page) or at minimum a critical page-ops outbox/alert at tier-3 breach, then allow the transition. Add a live test of an unacknowledged SOS running to terminus.",
      "verification": "Read cron-workers header, effects-runner and grep. Not run.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-033",
      "severity": "P1",
      "category": "spec-drift",
      "module": "M22",
      "title": "44 of 50 M22 platform templates render a non-PDF stand-in (JSON behind a %PDF header) instead of a real PDF; only 6 have registered builders",
      "evidence": [
        "apps/backend/src/modules/22-documents/seams/renderer.ts:432-446 standInBytes/renderBytes fallback",
        "apps/backend/src/modules/22-documents/render-pdf/registry.ts:20-28 six registered builders",
        "apps/backend/src/modules/22-documents/seams/renderer.ts:52 PLATFORM_TEMPLATE_TABLE has 50 keys (awk count lines 53-430)",
        "renderer.ts:448 comment acknowledges stand-in (GAP-095)"
      ],
      "verified": true,
      "recommended_fix": "Register real DocModel builders (render-pdf/registry.ts) for every template in PLATFORM_TEMPLATE_TABLE, or fail the render closed (render_failed) for any key with no builder instead of writing the stand-in; add a test that every template key has a registered builder and that output parses as a PDF.",
      "verification": "Read renderer.ts:429-446 and registry.ts:19-28; counted template keys vs registry keys with a script. Not run live.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-034",
      "severity": "P1",
      "category": "security",
      "module": "M23",
      "title": "Two PHI eligibility reads leave no read-audit trail (read-audit config has no resourceIdParam, so the audit insert fails and is swallowed)",
      "evidence": [
        "apps/backend/src/modules/23-billing-medicare/routes/eligibility.routes.ts:83 (GET /api/v1/billing/eligibility/hospice-periods) and :95 (GET /api/v1/billing/eligibility/latest) declare `auditRead: { resourceKind: \"eligibility_check\" }` with no resourceIdParam, no list, no patientIdQueryParam/patientIdPayloadPath",
        "apps/backend/src/bootstrap/plugins/read-audit.ts:204-205 computes `resourceId = params[resourceIdParam] ?? patientId ?? \"\"`; with neither it is \"\" and auditPhiRead inserts resource_id = '' into audit_event.resource_id",
        "packages/db/src/schema/audit-events.ts:29 resource_id is `uuid(\"resource_id\")`, so the insert raises an invalid-uuid error; read-audit.ts:214-217 catches it as best-effort and only logs",
        "These routes return a patient's Medicare eligibility/hospice-period history (PHI), guarded by caseload_or_scope"
      ],
      "verified": true,
      "recommended_fix": "Add patientIdQueryParam: \"patientId\" (resourceId then falls back to the patient) or resourceIdParam to both configs, and add a live assertion that the read event lands (the CLAUDE.md read-audit rule).",
      "verification": "Read eligibility.routes.ts:75-100, read-audit.ts:160-217 and audit-events.ts:29. Not run live; failure mode inferred from the uuid column type and the empty-string fallback.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-035",
      "severity": "P1",
      "category": "seam",
      "module": "M23/M25/M26/M27/M36",
      "title": "Cron alert codes emitted by M23, M25, M26 and M27 have no platform alert_rule, so each alert is persisted with zero recipients (including NOE/NOTR window breach)",
      "evidence": [
        "packages/messaging/src/seams/alert-emitter-impl.ts:80-92 (no rule -> recipientCount 0)",
        "apps/backend/src/modules/36-messaging/alert-emitter-drizzle.ts:169-188 (rules read only from alert_rule rows, platform or org)",
        "packages/messaging/src/seed/alert-rules.ts:657 (only m23.noe.rejected and m23.notr.rejected seeded for M23; no m25/m26/m27 codes)",
        "apps/backend/src/modules/23-billing-medicare/jobs/m23-jobs.ts:958,1665,1683,1736,1754,1805,1917 (unseeded alertCodes)",
        "apps/backend/src/index.ts:6283 (eventType: alertCode)"
      ],
      "verified": true,
      "recommended_fix": "Seed a platform rule for each emitted alert code, or map the codes to the existing rule names. Add a boot or arch gate that fails when an AlertEmitter eventType has no seeded rule and vice versa. Extend that gate to template-built codes such as `m27.filing_deadline.${tier}_due`.",
      "verification": "Set up an NOE past its window and run the window-watch cron, then check alert.resolved recipients and notification_delivery. Expect 0 rows today. Or diff the eventType set from emit sites against `PLATFORM_DEFAULT_ALERT_RULES`.",
      "prior_gap_ids": [
        "GAP-069",
        "GAP-076"
      ]
    },
    {
      "id": "GAP-036",
      "severity": "P1",
      "category": "stub",
      "module": "M25",
      "title": "Appeal packet render request carries an empty payload; the spec's typed AppealPacketRenderPayload does not exist",
      "evidence": [
        "apps/backend/src/modules/25-remittance/routes/write-service-drizzle.ts:335-340 submitAppeal publishes m25.appeal_packet.render_requested with `payload: { appealCaseId: id, tier: cur.tier, payload: {} }`; the late-good-cause path (line ~376) publishes only `{ lateGoodCauseFiling: true }`",
        "The submitted narrative (input.appealNarrative, attachedDocumentIds) is written to appeal_case.appeal_narrative (lines 313-319) but never reaches the render payload",
        "grep -rn AppealPacketRenderPayload packages --include=*.ts (excluding dist) returns nothing; docs/modules/WARDENX_MODULE_25_REMITTANCE_SPEC_v0_2.md:86 requires a typed packet payload (tier letter, supporting-document index, signed claim copy ref, remit copy)",
        "M22 renders the key through the stand-in (see M22 finding): apps/backend/src/modules/22-documents/outbox-consumers/render-consumer.ts:175-179 maps it to templateKey appeal_packet with contentField payload, and appeal_packet has no registered PDF builder"
      ],
      "verified": true,
      "recommended_fix": "Define AppealPacketRenderPayload in packages/forms, populate it at submit from the appeal narrative, claim/remit references and attached document index, add a real appeal_packet PDF builder, and validate the payload at the M22 boundary.",
      "verification": "Read write-service-drizzle.ts:309-340 and 370-380 and render-consumer.ts:175-179; grep for the payload type. Not run live.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-037",
      "severity": "P1",
      "category": "stub",
      "module": "M26",
      "title": "No code ever writes per-patient (patient_aggregate) projection snapshots, so per-patient cap bands, thresholds and the patient projection seam are dead",
      "evidence": [
        "apps/backend/src/modules/26-cap/routes/write-service-drizzle.ts:263-345 recompute() persists only 'agency_aggregate' and 'inpatient' scopes; the 'patient_aggregate' value appears only in the persistSnapshot type signature (line ~601)",
        "grep for patient_aggregate across apps/backend/src, packages/*/src and packages/db/migrations: no INSERT/producer, only readers (read-service-drizzle.ts:150-154, seam-impls.ts:75-90 and 245) and the enum definitions",
        "seam-impls.ts:75-90 getPatientProjection returns a fabricated 'safe', 0% view when no snapshot exists instead of null, so M23 pre-submission validation (spec 7.12) always sees a safe patient",
        "write-service-drizzle.ts recompute never reads cap_beneficiary_accrual.deceased_at / methodology_weight per patient (freeze-at-death written by consumers/drizzle-store.ts:290-304 is never used by a projection)"
      ],
      "verified": true,
      "recommended_fix": "In recompute() iterate cap_beneficiary_accrual rows, compute computeAggregateProjection per patient (honouring deceasedAt freeze and methodologyWeight), persistSnapshot with scope 'patient_aggregate' and the patient id, and let isEscalation drive threshold events. Return null from the seam when no snapshot exists.",
      "verification": "Insert an accrual with paid_cents near the cap, run recompute, expect a cap_projection_snapshot row with scope='patient_aggregate' and a cap_threshold_event; GET /api/v1/cap/projections/patient/:periodId/:patientId must return it.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-038",
      "severity": "P1",
      "category": "stub",
      "module": "M26",
      "title": "cap_inpatient_accrual.total_patient_days is never written in production code, so the inpatient-cap utilisation is always 0%, the alert never fires, settlement overage days equal all inpatient days (cents are 0 because no RHC differential is wired), and the cost-report seam sees totalMedicareDays of 0",
      "evidence": [
        "apps/backend/src/modules/26-cap/consumers/drizzle-store.ts:262-281 upserts only gipDays/ircDays/lastUpdatedAt",
        "packages/db/src/schema/cap/accrual.ts:121 total_patient_days default 0; grep across apps/ and packages/ (ts, sql) shows writers only in tests and migration 0086",
        "packages/cap-management/src/domain/inpatient.ts: computeInpatientProjection ratio over 0 days gives 0% and band inpatient_safe; computeInpatientOverage allowedDays=floor(pct*0)=0, so overageDays equals all inpatient days",
        "apps/backend/src/modules/26-cap/routes/write-service-drizzle.ts:455-463 reads totalPatientDays ?? 0 and passes no rhcDifferentialCentsPerDay, so overageCents is 0",
        "apps/backend/src/modules/26-cap/seam-impls.ts:120 and :156 read the same zero column for the projection and aggregateForCostReport"
      ],
      "verified": true,
      "recommended_fix": "Source the all-level-of-care patient-day denominator (M6 LevelOfCarePeriodReader or M23 claim lines for all LOC revenue codes) into total_patient_days on each accrual/recompute; supply the RHC differential from M23 rate data to computeInpatientOverage; remove the hard-coded zeros in the seam.",
      "verification": "Record GIP days plus routine days for a period, recompute, expect inpatient pctOfCap > 0 and band transitions at 18/20%; propose settlement and expect inpatientOverageDays = max(0, inpatient - floor(0.2*total)).",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-039",
      "severity": "P1",
      "category": "spec-drift",
      "module": "M26",
      "title": "Methodology-lock deadlock: the first projection flips an unlocked period open to active, after which methodology can never be set, so settlement can never be proposed",
      "evidence": [
        "abac-predicates.ts:86-89 cap_period_methodology_unlocked requires period.methodology === null AND status === 'open'",
        "write-service-drizzle.ts:~355-362 recompute() promotes status open to active (statusOnFirstAccrual) as soon as paidYtd > 0, even when methodology is still null (OpenCapPeriodRequest.methodology is Optional, packages/cap-management/src/contracts.ts:42)",
        "cap.routes.ts:128-142 the methodology route is gated by that ABAC, so on an active period it 404s (notFoundOnDeny); reopen is only legal from settled (packages/cap-management/src/domain/lifecycle.ts:14-20)",
        "write-service-drizzle.ts:~437-442 proposeSettlement throws METHODOLOGY_UNSET when methodology is null, so in_settlement to settled is unreachable"
      ],
      "verified": true,
      "recommended_fix": "Either require methodology at openPeriod (with the step-up lock row), or allow the lock while status is open/active before the first accrual line exists (the 2.3 rule), or make recompute not promote a methodology-less period; add a manager escape path for a null-methodology in_settlement period.",
      "verification": "Open a period without methodology, post one accrual, run recompute, then POST /periods/:id/methodology (expect success) and finish with propose/finalize.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-040",
      "severity": "P1",
      "category": "seam",
      "module": "M26",
      "title": "M26 threshold-crossing cap alerts are never delivered: no consumer of m26.cap.threshold_crossed, no M36 dispatch of the typed payloads, empty subscriber seam, and the threshold-evaluator and platform-constant-refresh queues have no worker",
      "evidence": [
        "packages/cap-management/src/alerts.ts payloads are imported nowhere in apps/backend/src (grep PatientWatch*/CapAlert* finds only 32-ai-platform token-cap unrelated hits)",
        "apps/backend/src/modules/26-cap/events-by-m26.ts:55-60 threshold_crossed declaredConsumers [] and seamConsumers ['m36','m33']; emitted at routes/write-service-drizzle.ts:678 with no consumer",
        "apps/backend/src/modules/26-cap/seam-impls.ts:232-234 listSubscribers() returns []",
        "apps/backend/src/modules/26-cap/jobs/queues.ts only: thresholdEvaluator/platformConstantRefresh have no Worker in jobs/index.ts registerM26CronWorkers",
        "jobs/index.ts:166-173 year-close alert dispatched only when closed > 0 (post-close, not a pre-close reminder)",
        "Correction: index.ts:6651-6657 wires a real m26Alerts port, so year_close_reminder and psr_variance_detected do dispatch through M36; only the threshold-crossing path is undelivered"
      ],
      "verified": true,
      "recommended_fix": "Add an M36 consumer (or worker) that maps m26.cap.threshold_crossed to the typed alert kinds and recipients from cap.event.read holders, persist dispatch_status with a retry job, and build the threshold-evaluator and platform-constant-refresh workers or amend the spec.",
      "verification": "Cross a band in a live test and assert an M36 notification row exists for a cap.event.read holder.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-041",
      "severity": "P1",
      "category": "seam",
      "module": "M26/M36",
      "title": "Cap band escalation never alerts anyone, and the nightly projection and cap-year-close crons publish their outbox events to a NOOP",
      "evidence": [
        "apps/backend/src/modules/26-cap/jobs/index.ts:91 `const write = buildDrizzleM26WriteService(db)` with no outbox, so write-service-drizzle.ts:43,81 NOOP_OUTBOX applies. recompute (jobs/index.ts:113) therefore publishes m26.cap.projection_updated and m26.cap.threshold_crossed (write-service-drizzle.ts:649,678) and closePeriod publishes m26.cap.year_closed (:543) to nothing. The nightly snapshot is also stamped computedBy:'manual_recompute' (:644).",
        "No code dispatches an M36 alert on band escalation: `grep -in alert routes/write-service-drizzle.ts` returns only band-field references, and events-by-m26.ts:55-60 has declaredConsumers [] with seamConsumers m36. The M36 outbox-consumers directory has no m26 binding.",
        "seam-impls.ts subscribers.listSubscribers returns [] (CapAlertSubscriberProvider) and is not registered (wiring.ts:16-21).",
        "docs/modules/WARDENX_MODULE_26_CAP_MANAGEMENT_SPEC_v0_3.md:424 (insert cap_threshold_event, emit m26.cap.threshold_crossed, then dispatch M36 typed alert per \u00a74.9); :1660 (M36 consumes threshold_crossed).",
        "packages/messaging seed rule `cap.approaching` (alert-rules.ts:674) has no emitter."
      ],
      "verified": true,
      "recommended_fix": "Pass m26OutboxPublisher into buildStores/buildDrizzleM26WriteService in registerM26CronWorkers. Dispatch the M36 cap alert on a band transition, or bind an M36 consumer for m26.cap.threshold_crossed, with seeded rules per band. Record computedBy accurately.",
      "verification": "Run the nightly recompute for a period whose pct crosses watch_90, then check outbox_event for m26.cap.threshold_crossed (expect 0 rows today) and alert for a cap alert.",
      "prior_gap_ids": [
        "GAP-150",
        "GAP-076"
      ]
    },
    {
      "id": "GAP-042",
      "severity": "P1",
      "category": "build",
      "module": "M27",
      "title": "M27 refresh/allocate/stats/tb/wage re-triggers are silently dropped: constant BullMQ jobIds are retained after completion or failure (validation-run unaffected)",
      "evidence": [
        "apps/backend/src/modules/27-cost-report/wiring.ts:132,140-141 (jobId=queue__dedupeKey; removeOnComplete {count:500}; removeOnFail:false)",
        "apps/backend/src/modules/27-cost-report/routes/write-service-drizzle.ts:525-537, 652-664, 901-905, 921, 976-979 (constant keys, no time/hash)",
        "node_modules/bullmq/dist/cjs/commands/addStandardJob-9.lua:90-93 (existing job hash => handleDuplicatedJob, no new job)",
        "apps/backend/src/modules/27-cost-report/jobs/queues.ts:103-125 M27_IDEMPOTENCY_KEYS defines day-bucket/asOf/hash builders not used by the producers",
        "Counter-check: write-service-drizzle.ts:1043 validation-run keys on run.id, so it is not affected; no clean/remove/getJob calls in module 27 or index.ts"
      ],
      "verified": true,
      "recommended_fix": "Add a day bucket / inputs-hash / request id to the jobId (as validation-run already does with run.id) or remove-on-complete/fail for these queues.",
      "verification": "Enqueue allocate twice with a worker running; the second should create a new job (check job count / second recompute timestamp). Fail a trial-balance pull then retry after reconnect; the retry must run.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-043",
      "severity": "P1",
      "category": "stub",
      "module": "M29",
      "title": "Listener-down detection and feed health are not implemented: evaluateListenerCircuit is never called and external_feed_health is never written",
      "evidence": [
        "grep evaluateListenerCircuit in apps/backend/src: only the definition (listener/circuit-breaker.ts) and the barrel re-export (index.ts:144); no caller",
        "grep externalFeedHealth|external_feed_health in apps/backend/src non-test: only SELECT usage (routes/store-drizzle.ts:132,879-919; seams/published-store-drizzle.ts:28); no INSERT/UPDATE anywhere; no feed_health_aggregate queue (grep)",
        "routes/store-drizzle.ts:879-919 feedHealthAggregate/listenerStatus therefore always report zero counts and listenerUp:false for every feed",
        "m29.external_feed.listener_down / listener_recovered are never emitted, so no CRITICAL M36 alert fires when an HL7 feed goes silent"
      ],
      "verified": true,
      "recommended_fix": "Run a health prober/aggregator (cron or in the listener supervisor) that records hourly external_feed_health rows, calls evaluateListenerCircuit, and emits listener_down/recovered through the outbox.",
      "verification": "Start a feed listener, stop sending for >5 min, expect a listener_down event, an M36 alert and external_feed_health.listener_down_seconds > 0.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-044",
      "severity": "P1",
      "category": "security",
      "module": "M29",
      "title": "M29 lab observation and inbound-proposal PHI GET routes (/api/clinical/labs/*, /api/admin/external-interfaces/inbound-proposals*) are outside DEFAULT_READ_AUDIT_PREFIXES and declare no config.auditRead, so no read-audit event is emitted",
      "evidence": [
        "apps/backend/src/bootstrap/index.ts:120-230 prefix list has no /api/clinical or /api/admin/external-interfaces entry",
        "apps/backend/src/bootstrap/index.ts:316 enforcedPrefixes = deps.readAuditPrefixes ?? DEFAULT; the composition root passes no override (grep readAuditPrefixes: only index.ts:56 and :316)",
        "apps/backend/dist/bootstrap/plugins/read-audit.js:41,107,131 enforcement and emission are gated on the prefix match plus config.auditRead",
        "apps/backend/src/modules/29-external-interfaces/routes/labs.routes.ts:37,59,78 and proposal.routes.ts:31,54 are GET routes with no auditRead config",
        "apps/backend/src/modules/29-external-interfaces/routes/message.routes.ts:24,47,111,133 are GET routes returning HL7 metadata only (header comment line 4: never the raw payload), so lower PHI exposure"
      ],
      "verified": true,
      "recommended_fix": "Add auditRead (emission with patientIdParam/resourceIdParam, or justified waiver) to every M29 GET and add both prefixes to DEFAULT_READ_AUDIT_PREFIXES so the boot gate enforces it.",
      "verification": "Boot with the prefixes added; routes missing config.auditRead must refuse to register. Read an observation and assert an audit_event read row.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-045",
      "severity": "P1",
      "category": "security",
      "module": "M29",
      "title": "M29 lab-result reads (/api/clinical/labs/*) emit no PHI read-audit event and sit outside the read-audit coverage gate",
      "evidence": [
        "apps/backend/src/modules/29-external-interfaces/routes/labs.routes.ts:37-56,59-76,78-93 - three GET routes (list observations, unmatched queue, single observation with value rows) declare no config.auditRead, and the file contains no audit call (grep -i audit labs.routes.ts returns nothing; M29 has no auditPhiRead/auditListRead call).",
        "apps/backend/src/bootstrap/index.ts:120-262 - DEFAULT_READ_AUDIT_PREFIXES is an explicit allowlist of /api/v1/* prefixes; '/api/clinical' is not in it, so apps/backend/src/bootstrap/plugins/read-audit.ts:138 (isGovernedReadRoute) never fires for these routes and the server boots without a declaration.",
        "Command: python scan of every .get(...) route outside the prefix list that lacks auditRead in its options lists /api/clinical/labs/observations, /api/clinical/labs/observations/:observationId, /api/clinical/labs/observations/unmatched.",
        "Spec: docs/modules/WARDENX_MODULE_29_EXTERNAL_INTERFACES_SPEC_v0_4.md:1143,1207 (clinician surface = /api/clinical/labs); M4 spec section 2.5 read-audit completeness (cited in read-audit.ts header); 45 CFR 164.528."
      ],
      "verified": true,
      "recommended_fix": "Add config.auditRead to the three lab routes (observation: resourceKind lab_observation, resourceIdParam observationId, patientIdPayloadPath observation.patientId; list: list:true with patientIdQueryParam). Add '/api/clinical' to DEFAULT_READ_AUDIT_PREFIXES so a new unannotated route fails boot.",
      "verification": "Unit test: booting buildServer with the prefix list throws ReadAuditCoverageError for an undeclared /api/clinical GET. Non-live inject test: a 200 from GET /api/clinical/labs/observations/:id writes an audit_event with the read action and patient_id.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-046",
      "severity": "P1",
      "category": "security",
      "module": "M30",
      "title": "PIP and SRA close is a nominee-based one-step close: the second role-holder never authenticates or attests, and migration 0335 relaxed V-11/V-12 to allow a null second co-sign timestamp (incomplete GAP-088 fix)",
      "evidence": [
        "apps/backend/src/modules/30-quality/routes/close-cosign.ts:9-13 (nominee never authenticates; follow-up flow is only logged, not built)",
        "close-cosign.ts:59-65,95-116 (cosignerAttested:false; nominee *_at set to null; closureCosignAttested:false)",
        "packages/db/migrations/0335_m30_closure_nominee_marker.sql (chk_qapi_pip_closure_cosign and chk_sra_cycle_closure_cosign accept closure_cosign_attested=false with the nominee's *_at NULL)",
        "apps/backend/src/modules/30-quality/routes/sra.routes.ts:71-77 (sraCloseAuthority target is the body-supplied cosignerMembershipId)",
        "docs/modules/WARDENX_MODULE_30_HQRP_QUALITY_SPEC_v0_5.md:370-371 (V-11/V-12 require both *_at non-null) and :1510 (split-actor invariant at app and DB layer)",
        "Prior id: GAP-088 (incomplete fix)"
      ],
      "verified": true,
      "recommended_fix": "Implement pending-close plus nominee confirmation in the nominee's own step-up session (or require a second authenticated step-up in the same request) and restore the DB co-sign check.",
      "verification": "Close a PIP with one session; expect the close to remain pending until the second member confirms.",
      "prior_gap_ids": [
        "GAP-088"
      ]
    },
    {
      "id": "GAP-047",
      "severity": "P1",
      "category": "build",
      "module": "M30",
      "title": "R-04 manual measure recompute and R-96 risk-register refresh are silently ignored after the first run: constant BullMQ jobIds retained",
      "evidence": [
        "routes/write-service-drizzle.ts:722-735 jobKey ${org}:measure:${id}|domain:|all with no period/version component; :1999-2005 ${org}:risk_register",
        "wiring.ts:108-118 jobId = queue:jobKey sanitized, removeOnComplete {count:500}, removeOnFail:false",
        "bullmq addStandardJob-9.lua:90-93 duplicate jobId is ignored while the prior job hash exists"
      ],
      "verified": true,
      "recommended_fix": "Include the period end / compute version / date bucket (or a request id) in the jobId.",
      "verification": "POST /quality/measures/recompute twice after the first job completed; the second must run.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-048",
      "severity": "P1",
      "category": "spec-drift",
      "module": "M30 Quality (web)",
      "title": "Quality UI is read-only apart from mortality review: no incident report/investigation, CAHPS, SRA, infection, QAPI program/PIP, risk-register or CoP-citation workflows",
      "evidence": [
        "apps/web/src/modules/30-quality/screens.ts:21,29,37 registers only quality.hub, quality.qapi-incidents, quality.mortality",
        "The only client writes in the module are apps/web/src/modules/30-quality/mortality-review.tsx:350 (PATCH mortality) and :368 (POST mortality/complete); no other POST/PATCH/PUT/DELETE in the directory",
        "docs/api/openapi.json: 31 of 36 mutating /api/v1/quality/* operations have no caller in apps/*/src or packages/ui/src: POST /quality/incidents/{id}/triage|investigate|investigation|resolve|close|reopen|submit, POST /quality/sra/cycles, /cycles/{id}/findings, /findings/{id}/remediation, POST /quality/cahps/vendor|export|results/ingest|decedents/{id}/exclude, POST /quality/infection/events, PATCH /quality/infection/outbreaks/{caseId}, POST /quality/qapi/programs|indicators|governance, POST/PATCH /quality/qapi/projects/{id}/pips, POST /quality/qapi/pips/{id}/close, POST /quality/risk-register/refresh, PATCH /quality/cop/citations/{id}, POST /quality/cop/citations/{id}/review, POST /quality/measures/recompute (also POST /quality/incidents for create)",
        "docs/design/SCREEN_SPEC_STATUS.md rows for WARDENX_UI_QAPI_INCIDENTS.md and WARDENX_UI_HQRP_QUALITY.md both say 'built' with no read-only caveat",
        "Only consumer of GET /quality/incidents outside the module is apps/web/src/shell/role-home.tsx:623 (a dashboard read)"
      ],
      "verified": true,
      "recommended_fix": "Build the incident intake form + triage/investigate/resolve/close/reopen drawer, the SRA console, CAHPS vendor/export, infection and QAPI program/PIP writes; or mark the specs 'partial' in SCREEN_SPEC_STATUS with the exact missing surfaces.",
      "verification": "python3 over docs/api/openapi.json comparing operation paths to string literals in apps/*/src and packages/ui/src (excluding tests/schema.ts); grep of client.POST/PATCH in 30-quality; read of screens.ts and both spec files.",
      "prior_gap_ids": [
        "GAP-157"
      ]
    },
    {
      "id": "GAP-049",
      "severity": "P1",
      "category": "seam",
      "module": "M30/M36",
      "title": "No M36 consumer or direct emit exists for any m30.* event, so sentinel, abuse-allegation, outbreak, threshold-breach and CAHPS-sample alerts never fire",
      "evidence": [
        "apps/backend/src/modules/30-quality/events-by-m30.ts: all 21 events have `declaredConsumers: []` (grep shows 21 matches). Descriptions at :57, :132, :362 say M36 raises the alert.",
        "apps/backend/src/modules/30-quality/routes/write-service-drizzle.ts:1537 publishes m30.incident.submitted to the outbox only. The only AlertEmitter calls in 30-quality are sra-reminder-ports.ts:96 and cap-overdue-scan.ts:105.",
        "grep -rn 'm26\\.|m27\\.|m30\\.' apps/backend/src/modules/36-messaging returns nothing; the M36 outbox-consumers directory has no quality consumer (admission-compliance, amendment-sla, breakglass, channel-membership-sync, clinical, emar, field-safety, idg, ipu, ipu-iv, m39, oncall).",
        "packages/types alert payload types m30.alerts.incident_sentinel, incident_abuse_allegation, outbreak_detected, measure_threshold_breached, cahps_sample_ready, mortality_review_due and cop_review_overdue are defined in packages/quality/src/alert-defs.ts:106-181, but a repo-wide grep finds no emitter for them. The two 'scheduled' ones (mortality-review overdue sweep, CoP cadence sweep) have no cron either.",
        "docs/modules/WARDENX_MODULE_30_HQRP_QUALITY_SPEC_v0_5.md:2889 (M36 dispatches incident_sentinel / incident_abuse_allegation immediately), :2861 (threshold breach to QAPI Coordinator), :2180 (sentinel alert, critical)."
      ],
      "verified": true,
      "recommended_fix": "Add M36 outbox-consumer bindings for m30.incident.submitted (sentinel and abuse severity), m30.infection.outbreak_opened, m30.measure.threshold_breached and m30.cahps.sample_ready that call AlertEmitter with matching platform rules. Add the mortality-review-overdue and CoP-cadence sweeps. Set declaredConsumers truthfully so arch:outbox-bindings can catch the gap.",
      "verification": "Submit a sentinel incident, then query alert and notification_delivery. Expect a row with recipients; today none exists.",
      "prior_gap_ids": [
        "GAP-155"
      ]
    },
    {
      "id": "GAP-050",
      "severity": "P1",
      "category": "security",
      "module": "M31",
      "title": "A suspended portal account keeps full PHI access: grant predicate ignores account status, suspend leaves grants live, no session revocation",
      "evidence": [
        "apps/backend/src/modules/31-portal/abac-predicates.ts:315-329 portal_grant_active_for_patient checks only an unrevoked grant + live consent; it never loads the portal_account status",
        "apps/backend/src/modules/31-portal/routes/guards.ts:39-46 ABAC_GRANT is the only account/grant guard on every PHI read/write/telehealth route; ABAC_ACCOUNT (status check) is bound only on session/preferences routes (read.routes.ts:376, session.routes.ts:115,142,193, write.routes.ts:488)",
        "apps/backend/src/modules/31-portal/routes/store.ts:538-552 activeGrant filters only revoked_at IS NULL",
        "apps/backend/src/modules/31-portal/routes/store.ts:554-578 suspendAccount updates portal_account.status only: no grant revoke, no session revoke, only emits m31.portal_account.suspended",
        "apps/backend/src/modules/31-portal/events-by-m31.ts:44-53 declaredConsumers: [] - no M2/M36 consumer exists; grep of apps/backend for 'portal_account.suspended' finds only the catalog entry and the emit"
      ],
      "verified": true,
      "recommended_fix": "Make portal_grant_active_for_patient (or a shared ABAC_GRANT wrapper) also require portal_account_active, and/or revoke the account's M2 sessions in the suspend transaction; add an inject/live test that a suspended account's existing session gets 403 on /portal/care-summary and telehealth join.",
      "verification": "Suspend an account that holds an active session and grant (admin POST /admin/portal-accounts/:id/suspend), then call GET /api/v1/portal/care-summary with the pre-existing portal session: expect 403; today the request is served.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-051",
      "severity": "P1",
      "category": "stub",
      "module": "M31",
      "title": "Telehealth vendor adapter never bound in production: portal/clinician join (incl. lazy room mint) and start-recording fail 503, and both webhooks always return 401 (end/stop-recording degrade to no-ops)",
      "evidence": [
        "apps/backend/src/index.ts:4846-4851 comment and ~4888-4990 mountM31Routes call: no `telehealth` dep; grep finds no telehealth-client import in apps/backend",
        "apps/backend/src/modules/31-portal/routes/telehealth.routes.ts:35-51 NOOP_ADAPTER; :60 `deps.telehealth ?? NOOP_ADAPTER`",
        "telehealth.routes.ts:178 empty token => vendorUnavailable (503) on join",
        "telehealth.routes.ts:319-320 empty vendorRecordingId => 503 on start-recording",
        "telehealth.routes.ts:~437-439 verifyWebhookSignature false => 401 on both webhooks",
        "telehealth.routes.ts:42 NOOP endRoom is a no-op, so end does NOT 503 under the NOOP adapter",
        "docs/history/m31-portal-deferrals.md:24-26 acknowledges binding is the remaining step"
      ],
      "verified": true,
      "recommended_fix": "Bind @wardenx/telehealth-client (Daily.co) adapter with a per-tenant API-key store in index.ts and pass it as `telehealth`; until then the feature is not delivered (spec 7.2 acceptance cannot pass).",
      "verification": "POST /api/v1/telehealth/visits/<m17 telephonic visit id>/join as a clinician on a booted stack: today 503 TELEHEALTH_VENDOR_UNAVAILABLE.",
      "prior_gap_ids": [
        "GAP-095"
      ]
    },
    {
      "id": "GAP-052",
      "severity": "P1",
      "category": "stub",
      "module": "M31",
      "title": "PortalDisclosureAccountingProvider returns an empty list always and no patient-facing access-log route exists (HIPAA 164.528 accounting)",
      "evidence": [
        "apps/backend/src/modules/31-portal/routes/store.ts:483-489 disclosuresForPatient(): Promise<...> { return []; } - this is the store registered in apps/backend/src/index.ts:1884-1885 via createM31PublishedSeamImpls(portalStore)",
        "docs/modules/WARDENX_MODULE_31...:2087,2166 mark the access-log route and export route 'DEFERRED - unbuilt'",
        "docs/history/m31-portal-deferrals.md F-225 item 5: 'still a stub returning [] ... NOTHING renders them to a patient'"
      ],
      "verified": true,
      "recommended_fix": "Implement disclosuresForPatient over audit_event/document_access_log (patient_id indexed by migration 0298) and add the access-log route + export.",
      "verification": "After a portal document download (document_access_log row written), call getSeam('PortalDisclosureAccountingProvider').disclosuresForPatient(org, patient, from, to): expect the row, today [].",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-053",
      "severity": "P1",
      "category": "stub",
      "module": "M31 Portal/Telehealth (portal)",
      "title": "Telehealth 'video visit' renders a static placeholder box; no vendor SDK is mounted anywhere",
      "evidence": [
        "apps/portal/src/screens/telehealth-waiting-room.tsx:77-79 comment 'The vendor SDK mounts here in the running app'; :80-96 is a div with aria-label 'Video area' showing the text 'Video connected' / 'Audio-only mode'",
        "apps/portal/package.json, apps/web/package.json and packages/*/package.json contain no daily/twilio video dependency (grep for daily-co|@daily|twilio-video returned only packages/telehealth-client name); grep for joinUrl|ticket.token|DailyIframe|createFrame in apps/portal/src returned nothing",
        "The only controls are Join and 'Leave visit' (lines ~139-160); no mute/camera/chat/participant panel from the spec"
      ],
      "verified": true,
      "recommended_fix": "Mount the vendor SDK (via @wardenx/telehealth-client) using the join ticket, add the controls/participant panel, or mark the screen deferred in SCREEN_SPEC_STATUS (currently 'built portal/31-portal').",
      "verification": "Read telehealth-waiting-room.tsx lines 40-160; grep of package.json files and apps/portal/src.",
      "prior_gap_ids": [
        "GAP-095"
      ]
    },
    {
      "id": "GAP-054",
      "severity": "P1",
      "category": "spec-drift",
      "module": "M31 Portal/Telehealth (web)",
      "title": "No staff UI for telehealth (clinician join/end/recording) or for the M31 portal-admin pane (accounts, invitations, grants, telehealth roster)",
      "evidence": [
        "No web/admin screen path under /admin/portal or telehealth: grep of apps/web/src/modules/*/screens.ts and apps/admin/src/modules/*/screens.ts finds none; apps/web has no portal-admin module dir (ls apps/web/src/modules)",
        "No caller in apps/*/src for: GET/POST /api/v1/admin/portal-accounts*, /admin/portal-invitations*, GET /admin/telehealth/visits[/{id}], POST /admin/telehealth/visits/{id}/halt-recording, POST /telehealth/visits/{visitId}/join|end|start-recording|stop-recording, POST /collaborators/invite, POST /funeral/invite, GET /auditor/portal-engagement/{id}",
        "Staff therefore cannot invite a family member to the portal, issue/revoke grants, or run a telehealth visit from any SPA; only the patient-side join in apps/portal calls the API"
      ],
      "verified": true,
      "recommended_fix": "Add the staff portal-admin screens from section 5.3 and a clinician telehealth room, or record them as deferred in SCREEN_SPEC_STATUS and the M31 spec.",
      "verification": "openapi-vs-frontend path diff (python script) plus grep for 'portal-accounts|portal-invitations|collaborators/invite' across apps/*/src returned 0 hits.",
      "prior_gap_ids": [
        "GAP-160",
        "GAP-092"
      ]
    },
    {
      "id": "GAP-055",
      "severity": "P1",
      "category": "security",
      "module": "M32",
      "title": "AI invocation PHI reads (R16 search, R17 detail) leave no read-audit row: auditRead has no resourceIdParam / list flag",
      "evidence": [
        "apps/backend/src/modules/32-ai-platform/routes/invocations.routes.ts:46-49 INVOCATION_PHI = {resourceKind:'ai_invocation', fields:[patient_id,...]} with no list:true, no resourceIdParam, no patientId source",
        "invocations.routes.ts:62 (R16) and :85 (R17) use it",
        "apps/backend/src/bootstrap/plugins/read-audit.ts:195-209 non-list path writes resourceId = '' ; audit_event.resource_id is uuid, insert fails, error swallowed at :244-246 (R16 is a collection so it also takes the single-resource branch)"
      ],
      "verified": true,
      "recommended_fix": "R16: list:true; R17: resourceIdParam:'invocationId' (+ patientIdPayloadPath 'patientId'); add a live test asserting the event lands.",
      "verification": "As a compliance officer GET /api/v1/ai/invocations/<id> then SELECT from audit_event where resource_kind='ai_invocation': no row.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-056",
      "severity": "P1",
      "category": "stub",
      "module": "M33",
      "title": "POST /reporting/drilldown/emit (and the drilldown_audit_flush worker) always fails: no per-tenant envelope encryption port is bound",
      "evidence": [
        "apps/backend/src/modules/33-reporting/wiring.ts:568-577 createDrizzleM33ExportDrilldownBackend(...) is built without drilldownEncryption",
        "apps/backend/src/modules/33-reporting/routes/export-drilldown-service.ts:479-488 default encryptFilters throws DrilldownDekUnavailable (a plain Error => generic 500 INTERNAL_ERROR via bootstrap/plugins/error-handler.ts)",
        "apps/backend/src/modules/33-reporting/jobs/m33-jobs.ts:733-739 worker encryptFilters is the same unbound() deny",
        "wiring.ts:467-468 justification 'the M1 envelope-DEK/KMS provider does not exist anywhere in this codebase' is stale: getTenantKeyProvider().dekForOrg is used by M31 (index.ts:4869-4872), M18, M30"
      ],
      "verified": true,
      "recommended_fix": "Bind drilldownEncryption (and the worker port) over getTenantKeyProvider().dekForOrg like createPortalPhiCipher.",
      "verification": "POST /api/v1/reporting/drilldown/emit with a valid tile: 500 today.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-057",
      "severity": "P1",
      "category": "seam",
      "module": "M34",
      "title": "M34 alert resolvers never registered: most tenant-lifecycle/security alert rules are unseeded and never deliver",
      "evidence": [
        "apps/backend/src/modules/34-saas-tenant-platform/alert-rules.ts:105 defines registerM34AlertResolvers; grep across apps/backend/src finds no call site other than the definition",
        "alert-rules.ts:437-440: 'registerM34AlertResolvers is written but NOTHING CALLS IT'; alert-rules.ts:524 'TODO(Phase 2D - boot wiring)'",
        "alert-rules.ts:503 seedableM34AlertRules() seeds only rules naming M36 built-in resolvers; every rule naming compliance_officer_for_tenant / platform_security_owner stays unseeded",
        "apps/backend/src/index.ts:5349-5363 logs 'M34 alert_rule seed is PARTIAL ... stay dormant until registerM34AlertResolvers is bound at boot'",
        "Spec module-34 (Depends on, M36 clause): 'the compliance_officer_for_tenant and platform_security_owner resolvers M34 registers with M36's alert-rule engine; M36 alert-rule catalog where M34 contributes thirteen rule keys'"
      ],
      "verified": true,
      "recommended_fix": "Bind M34AlertResolverPorts to M2 membership/role lookups, call registerM34AlertResolvers against M36's resolver registry after createRecipientResolverRegistry, then remove the built-in-only filter in seedableM34AlertRules so all M34_ALERT_RULES are upserted. Add a live suite asserting an m34.tenant.shred_pending_approval emit yields a notification row.",
      "verification": "Static: grep for call sites of registerM34AlertResolvers (only the definition found); read alert-rules.ts 425-545 and index.ts 5345-5375. Runtime delivery not exercised (live suites forbidden).",
      "prior_gap_ids": [
        "GAP-098",
        "GAP-061"
      ]
    },
    {
      "id": "GAP-058",
      "severity": "P1",
      "category": "stub",
      "module": "M35",
      "title": "Stripe transport is unbound: inbound webhook always 503, no outbound dispatcher exists, billing is local state only",
      "evidence": [
        "apps/backend/src/index.ts:4395-4423 mountM35Routes is given only `service`; mount.ts:38 registerWebhookRoutes(app, deps.webhook ?? {}) so deps.ingest is undefined",
        "apps/backend/src/modules/35-subscription/routes/webhooks.routes.ts:43-49 unset ingest => 503 STRIPE_WEBHOOK_UNCONFIGURED; rawBodyOf (:29-35) falls back to JSON.stringify(request.body) because no raw-body parser is registered",
        "apps/backend/src/modules/35-subscription/routes/service-drizzle.ts:890-899 createSetupIntent hard-refuses 503; no code path consumes m35.stripe.* events (packages/subscription-billing/src/stripe/dispatcher.ts is never instantiated in apps/backend)"
      ],
      "verified": true,
      "recommended_fix": "Bind the webhook ingest (verifier, stripe_webhook_event store, encryptor) with a raw-body parser and run the dispatcher worker.",
      "verification": "POST /api/v1/webhooks/stripe with any body: 503.",
      "prior_gap_ids": [
        "GAP-100"
      ]
    },
    {
      "id": "GAP-059",
      "severity": "P1",
      "category": "stub",
      "module": "M35",
      "title": "None of the M35 workers exist: dunning engine, usage aggregator, Stripe usage posting, reconciler, revenue snapshot, payment-method expiry watch",
      "evidence": [
        "apps/backend/src/modules/35-subscription has no jobs/ directory (ls shows only routes, outbox-consumers, predicates)",
        "apps/backend/src/index.ts: only the three consumers at :9704-9712 are bound for M35; grep of apps/backend/src for 'dunning-engine|usage-aggregator|revenue-snapshot|subscription-reconciler|payment-method-expiry' hits only the service text and a test",
        "GET /admin/dunning, /admin/revenue/snapshots/compute read/write rows that no worker ever advances"
      ],
      "verified": true,
      "recommended_fix": "Build and register the worker set with an org enumerator; until then past_due/suspended transitions and m35.tenant.billing_blocked never occur.",
      "verification": "grep -rn 'new Worker' apps/backend/src/modules/35-subscription: none.",
      "prior_gap_ids": [
        "GAP-100"
      ]
    },
    {
      "id": "GAP-060",
      "severity": "P1",
      "category": "security",
      "module": "M35",
      "title": "attach payment method trusts a client-supplied stripePaymentMethodId (no SetupIntent/Stripe/ownership check); createSubscription accepts any paymentMethodId",
      "evidence": [
        "apps/backend/src/modules/35-subscription/routes/subscription-typebox.ts:108-111 body is {stripePaymentMethodId: string minLength 1, setAsDefault}",
        "routes/service-drizzle.ts:901-944 attachPaymentMethod inserts payment_method (kind 'card', is_active true) from the raw string, with no Stripe or SetupIntent call, then optionally sets subscription.default_payment_method_id and emits m35.payment_method.added",
        "routes/service-drizzle.ts:648-690 createSubscription stores args.paymentMethodId at line 680 with no lookup against payment_method for the actor's org",
        "packages/db/migrations/0141_subscription_billing_m35_tenant_tables.sql:35 default_payment_method_id is a bare uuid with no FK constraint (correcting the claim of an FK that bypasses RLS)",
        "packages/db/migrations/0141_subscription_billing_m35_tenant_tables.sql:90 global unique index on stripe_payment_method_id (squatting risk)",
        "routes/tenant.routes.ts:135-150 route has permission, step-up and idempotency preHandlers only; no PM validation"
      ],
      "verified": true,
      "recommended_fix": "Verify the pm id against a completed SetupIntent for this org's Stripe customer via the dispatcher before insert; validate org ownership of paymentMethodId.",
      "verification": "POST /api/v1/payment_methods/attach {stripePaymentMethodId:'pm_fake'}: 201.",
      "prior_gap_ids": [
        "GAP-100"
      ]
    },
    {
      "id": "GAP-061",
      "severity": "P1",
      "category": "spec-drift",
      "module": "M35",
      "title": "M35 refund request has no cap or invoice validation (amount <= amount_paid, cumulative refunds, paid status), and approved refunds are never executed (no producer for m35.refund.executed/failed)",
      "evidence": [
        "apps/backend/src/modules/35-subscription/routes/service-drizzle.ts:1426-1462 requestRefund inserts args.amountCents with no check against inv.amountPaidCents, prior refunds or status",
        "apps/backend/src/modules/35-subscription/routes/subscription-typebox.ts:154 amountCents only minimum 1; packages/db/migrations/0141:266 CHECK amount_cents > 0 only",
        "service-drizzle.ts:1464-1498 approveRefund only flips status to approved; no Stripe execution or dispatcher anywhere in apps/backend/src",
        "apps/backend/src/modules/35-subscription/events-by-m35.ts:381,397 m35.refund.executed/failed catalogued with no emitter",
        "docs/modules/WARDENX_MODULE_35_SUBSCRIPTION_BILLING_SPEC_v0_3.md:235 (app-code cap), :262-263 and :1847-1848 (executed/failed events)",
        "Correction: drop 'deny emits no event'. No m35.refund.denied exists in the catalogue or spec."
      ],
      "verified": true,
      "recommended_fix": "Enforce amount <= amount_paid - already requested/executed refunds and invoice.status paid in the transaction; wire execution through the dispatcher.",
      "verification": "POST /api/admin/refunds with amountCents greater than the invoice's amountPaidCents: 201.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-062",
      "severity": "P1",
      "category": "stub",
      "module": "M36",
      "title": "No vendor transport is bound: every push/SMS/voice/email alert delivery settles failed (transport_not_configured), so SOS voice escalation cannot happen",
      "evidence": [
        "apps/backend/src/index.ts:7589-7601 comment says 'transports are the fail-closed DENY stubs until a real web-push/Twilio/Postmark adapter is bound' and passes `transports: createDenyTransports()`",
        "packages/messaging/src/dispatch/transports.ts:8 'NOTHING HERE TALKS TO A VENDOR. The production binding today is createDenyTransports'",
        "grep for a Twilio/web-push transport factory in packages/messaging/src and apps/backend/src finds none (only createPostmarkTransactionalEmailTransport, used for auth emails)",
        "docs/modules/WARDENX_MODULE_36_MESSAGING_SPEC_v0_4.md:60 'Phase 1 delivers everything in this spec including Tier-1 Voice escalation for SOS field-safety'"
      ],
      "verified": true,
      "recommended_fix": "Implement and bind real web-push, Twilio SMS/voice and Postmark alert transports (env-gated) in place of createDenyTransports(), with a live suite proving a pending notification_delivery reaches 'sent' through a vendor stub and the webhook reconcile. Until then raise a boot warning/health signal when SOS-capable categories have only deny transports.",
      "verification": "read index.ts:7589-7601 and transports.ts:1-70; grep -rn 'createDenyTransports' apps packages",
      "prior_gap_ids": [
        "GAP-101"
      ]
    },
    {
      "id": "GAP-063",
      "severity": "P1",
      "category": "seam",
      "module": "M36",
      "title": "SMS/email endpoint verification code is generated but never delivered in production, so no out-of-band endpoint can ever become 'verified'",
      "evidence": [
        "apps/backend/src/modules/36-messaging/messaging-route-service-db.ts:272 declares optional `sendEndpointVerificationCode`, line 851 calls it with `?.`",
        "apps/backend/src/modules/36-messaging/index.ts mountMessagingRoutes calls `_createDbMessagingRouteService(db)` with no opts; grep -rn sendEndpointVerificationCode apps packages shows no other binding",
        "packages/db/migrations/0355_m36_out_of_band_delivery.sql:74 delivery_endpoint_for_delivery only resolves `verification_status = 'verified'`",
        "only `push` endpoints are auto-verified (messaging-route-service-db.ts:820)"
      ],
      "verified": true,
      "recommended_fix": "Bind sendEndpointVerificationCode in mountMessagingRoutes/composition root to the SMS/email transports (and fail registration with a clear 503 when no sender is bound rather than silently leaving the endpoint pending forever).",
      "verification": "grep -rn 'sendEndpointVerificationCode' apps packages --include=*.ts | grep -v test",
      "prior_gap_ids": [
        "GAP-166",
        "GAP-101"
      ]
    },
    {
      "id": "GAP-064",
      "severity": "P1",
      "category": "security",
      "module": "M36",
      "title": "Message history and alert inbox reads (PHI) emit no read-audit; /api/v1/messaging and /api/v1/alerts are outside the read-audit coverage gate",
      "evidence": [
        "grep for auditRead in apps/backend/src/modules/36-messaging returns nothing",
        "apps/backend/src/bootstrap/index.ts:120-260 DEFAULT_READ_AUDIT_PREFIXES contains no /api/v1/messaging, /api/v1/alerts or /api/v1/notifications",
        "apps/backend/src/modules/36-messaging/routes/messaging-routes.ts:171-198 GET channels/:id and GET channels/:id/messages decrypt and return clinical message bodies",
        "spec line 98: 'dedicated audit on message read ... message.read events written individually'; spec line 425 'Message read by user ... M4 audit row written'"
      ],
      "verified": true,
      "recommended_fix": "Add the messaging/alerts prefixes to DEFAULT_READ_AUDIT_PREFIXES and give GET channel detail, GET messages and GET alerts/inbox an auditRead config (resourceKind message/channel, resourceIdParam id, patientId from the care_team channel subject).",
      "verification": "grep -rn auditRead apps/backend/src/modules/36-messaging; sed -n 120,260p apps/backend/src/bootstrap/index.ts",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-065",
      "severity": "P1",
      "category": "security",
      "module": "M36",
      "title": "M36 has no M39 consent gate on care_team membership/visibility, yet it ACKs the consent-revocation cascade as if the pull path enforced it",
      "evidence": [
        "grep -n -iE 'consent|part2|sud' apps/backend/src/modules/36-messaging/messaging-route-service-db.ts messaging-provider-db.ts finds only a header comment",
        "messaging-route-service-db.ts canViewChannel (approx. lines 424-470) checks channel_member + CareTeamProvider roster only",
        "apps/backend/src/modules/36-messaging/outbox-consumers/m39-consent-revoked.ts:1-46 takes no action and ACKs on the claim that canViewChannel is the pull half",
        "spec \u00a77.13 edge row: 'patient has SUD diagnosis + no consent for a member | M39 consent gate excludes that member from membership re-sync; audited'"
      ],
      "verified": true,
      "recommended_fix": "Consult the M39 ConsentEvaluator (SUD / 42 CFR Part 2 release) in syncCareTeamChannel and canViewChannel for flagged patients, and only then ACK the cascade; otherwise stop attesting m36_messaging in CASCADE_LIVE_CONSUMERS.",
      "verification": "read m39-consent-revoked.ts and canViewChannel; grep consent in the M36 module",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-066",
      "severity": "P1",
      "category": "security",
      "module": "M39",
      "title": "Revocation validation and attribution trust the client-supplied revokedByKind: a staff user can send patient_self_via_portal/dpoa_agent/court_order to skip the 40-char reason + evidence document rule",
      "evidence": [
        "apps/backend/src/modules/39-consent/routes/consent-routes.ts:331 `actorIsStaff: body.revokedByKind === \"staff\"`; revokedByKind at line 332 is stored from the body",
        "apps/backend/src/modules/39-consent/routes/consent-typebox.ts:93-105 RevokeBodySchema allows all five kinds incl. platform_admin_break_glass on the staff route",
        "packages/consent/src/validation/rules.ts:226-241 validateRevocation returns ok() when !actorIsStaff",
        "this route is staff-session only (portal route 27 deferred, GAP-201)"
      ],
      "verified": true,
      "recommended_fix": "Derive revokedByKind/actorIsStaff from the authenticated session class and roles on the server; restrict platform_admin_break_glass to the break-glass path; only accept dpoa_agent/court_order with evidence.",
      "verification": "POST /consents/:id/revoke as staff with {revokedByKind:'patient_self_via_portal', reasonText:''} -> validateRevocation passes (read rules.ts:226-241)",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-067",
      "severity": "P1",
      "category": "seam",
      "module": "M39",
      "title": "m5.patient.merged has no M39 consumer: consent records (incl. Part 2 releases and revocations) stay on the merged-away patient",
      "evidence": [
        "apps/backend/src/modules/39-consent/consumers.ts:59-66 decidePatientMergeRepoint is a pure function; grep -rn 'decidePatientMergeRepoint\\|m39.consent.repointed' apps/backend/src shows no binding or UPDATE",
        "apps/backend/src/modules/05-patient/events-by-m5.ts:165-185 m5.patient.merged declaredConsumers: ['m35'] only",
        "apps/backend/src/modules/05-patient/merges-db.ts has no consent re-point",
        "consumers.ts:7-8 and M39 spec \u00a74.6 say M39 re-points consent_record.patient_id to the survivor"
      ],
      "verified": true,
      "recommended_fix": "Add an outbox consumer (declared in events-by-m5) that re-points consent_record (and dependent rows) to the survivor in one tx and emits m39.consent.repointed, with a live test.",
      "verification": "grep -rn 'm5.patient.merged' apps/backend/src --include=*.ts",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-068",
      "severity": "P1",
      "category": "seam",
      "module": "M40",
      "title": "mdm.physician_deactivated alerts reach nobody: no alert_rule is seeded for the event type",
      "evidence": [
        "apps/backend/src/modules/40-mdm/outbox-consumers/nppes-consumer-ports.ts:214 and jobs/nppes-fallback.ts:164 call alerts.emit(eventType 'mdm.physician_deactivated')",
        "packages/messaging/src/seed/alert-rules.ts seeds mdm.license_expiring (1097) and mdm.baa_expiring (1117) but no mdm.physician_deactivated",
        "packages/messaging/src/seams/alert-emitter-impl.ts:80-93 emit() with no rule persists an alert with recipientCount 0 and no deliveries"
      ],
      "verified": true,
      "recommended_fix": "Seed a platform-default alert_rule for mdm.physician_deactivated (tenant admins / referral coordinators) and register its payload type; add a live test asserting a recipient is resolved.",
      "verification": "grep -n 'physician_deactivated' packages/messaging/src/seed/alert-rules.ts (no hit)",
      "prior_gap_ids": [
        "GAP-099"
      ]
    },
    {
      "id": "GAP-069",
      "severity": "P1",
      "category": "seam",
      "module": "M8/M19/M17",
      "title": "Production M8 EncounterCreator, MileagePayrollReader and renderPayloadFor run on the in-memory store: M19 triage persists a phantom linked_encounter_id and M17 actual miles are always 0",
      "evidence": [
        "apps/backend/src/modules/08-encounters/seams/drizzle-store.ts:69,71 `const fallback = createInMemoryEncounterReaderStore().store; return { ...fallback, ...}` overrides only encounterFacts, lateEntryCountsForOrg, skilledNursingDayTotalsForOrg, skilledVisitDaysForOrg, signedEncountersForPatientSince (grep of method names at lines 88,128,169,206,227). renderPayload, mileageForClinician and insertDraftEncounter stay in-memory (header lines 11-15 admit it).",
        "apps/backend/src/modules/08-encounters/seams/store.ts:141-152 in-memory insertDraftEncounter mints uuidFromCounter(++created) and pushes to a closure array; nothing is written to the encounter table.",
        "apps/backend/src/index.ts:1575-1577 registerEncounterSeams({store: createDrizzleEncounterReaderStore(db), db}); seams/index.ts:80 registers EncounterCreator over that same store.",
        "apps/backend/src/modules/19-oncall/clinical/encounter-link.ts:218-226 linkTriageEncounter calls getEncounterCreator().createDraftEncounter then port.linkEncounter(...encounterId): the phantom id is stored on the call. Called from apps/backend/src/modules/19-oncall/routes/write-service-drizzle.ts:950 and :973. triage_call.linked_encounter_id is a logical uuid with no FK (packages/db/migrations/0107_oncall_m19_enums_tables.sql:306), so the phantom link persists. encounter-link.ts:196-199 says a phantom link strands the call permanently.",
        "apps/backend/src/modules/17-scheduling/seams/drizzle-store.ts:436 getMileagePayrollReader().mileageForPayrollPeriod reads the in-memory empty list, so totalActualMiles is always 0 in the route-efficiency report."
      ],
      "verified": true,
      "recommended_fix": "Implement renderPayload, mileageForClinician and insertDraftEncounter against the encounter, encounter_mileage and related tables inside withOrgContext. Do not spread an in-memory fallback into a Drizzle store; make the store type require every method. Add a live suite that creates a triage disposition and asserts an encounter row exists for the linked id.",
      "verification": "Run a triage disposition on a DB boot, then `select id from encounter where id = <triage_call.linked_encounter_id>`. Expect 0 rows today.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-070",
      "severity": "P1",
      "category": "seam",
      "module": "M8/M30",
      "title": "HVLDL numerator is always 0 in production: encounter.evv_bracket_state is never persisted as 'evv_present', and the SignedEncountersReader maps NULL to 'evv_missing_documented'",
      "evidence": [
        "apps/backend/src/modules/30-quality/jobs/m30-jobs.ts:1033-1038 counts only digests with e.evvBracketState === \"evv_present\"; the header at :984 says the same.",
        "apps/backend/src/modules/08-encounters/seams/drizzle-store.ts:270 `evvBracketState: (r.evvBracketState ?? \"evv_missing_documented\")` for a NULL column.",
        "The only write to encounter.evv_bracket_state in the app is encounters-route-service-db.ts:1699-1702 (documentEvvMissing), which sets 'evv_missing_documented'. packages/db/src/schema/encounter/encounters.ts:62 says `populated at finalize`, but the finalize update at encounters-route-service-db.ts:1752-1757 sets only status, vocabVersionId, version and updatedAt. grep for \"evv_present\" in apps/backend/src finds writes only to visit.evvBracketState (17-scheduling), never to the encounter.",
        "The same column is read inconsistently at sign time: encounters-route-service-db.ts:1840 `r.evvBracketState ?? \"evv_present\"` is emitted on m8.encounter.signed, so M18 sees evv_present while M30 sees missing."
      ],
      "verified": true,
      "recommended_fix": "Persist the encounter's EVV bracket state at finalize or sign (resolve it from the linked visit or the M18 EvvBracketProvider), or have the reader resolve it through the visit. Use one NULL-handling rule in both places.",
      "verification": "Sign an encounter for a visit with M18 check-in/out, then call SignedEncountersReader.signedEncountersForPatientSince. Expect evvBracketState 'evv_present'; today it is 'evv_missing_documented'. Run the HVLDL recompute and check qualifyingDisciplineVisitsInLastDays.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-071",
      "severity": "P2",
      "category": "spec-drift",
      "module": "docs/modules/module-29-tasks",
      "title": "M29 task addenda give RLS policy DDL using banned session variables app.organization_id / app.current_organization_id",
      "evidence": [
        "docs/modules/module-29-tasks/WARDENX_T-29.02_SCHEMA_PACKAGE.md:1085-1130 (8+ policies USING organization_id = current_setting('app.organization_id', true)::uuid), status 'lock-grade' (line 3)",
        "WARDENX_T-29.11_SUD_HARDENING.md:137 and WARDENX_T-29.10_CREDENTIAL_ROTATION.md:202 use app.current_organization_id",
        "Canonical per ADR-0010 D2 and docs/modules/WARDENX_MODULE_07_CARE_PLAN_SPEC_v0_3.md:703 / MODULE_36:1442 is app.org_id; those specs state the other names are never set so policies fail closed; CLAUDE.md check-tenancy enforces app.org_id. The module README lists these as drop-in artifacts, and arch:tenancy does not scan docs, so the contradiction is uncaught"
      ],
      "verified": false,
      "recommended_fix": "Correct the GUC name in the three task docs (or mark them superseded with a banner pointing at M29 spec and ADR-0010 D2); optionally add a docs grep gate for app.organization_id|app.current_organization_id outside historical audit-note context.",
      "verification": "rg \"app\\.(organization_id|current_organization_id)\" docs/modules/module-29-tasks returns no policy DDL",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-072",
      "severity": "P2",
      "category": "security",
      "module": "M01",
      "title": "POST /api/v1/admin/system/status mutates the platform-global status banner with no audit event and no actor",
      "evidence": [
        "apps/backend/src/bootstrap/routes/system.ts:93-99 handler upserts and returns with no audit() call",
        "apps/backend/src/bootstrap/system-status-store.ts:1-40 header: updatedBy left NULL, 'fabricating an actor id ...'; table is NON_ORG_SCOPED with no RLS",
        "grep -rn 'system_status.changed' apps packages -> only retention.ts:51-52 comment",
        "Spec M01 \u00a78.1 `system_status.changed | platform_ops | warn if degraded/outage | compliance`"
      ],
      "verified": false,
      "recommended_fix": "Resolve the actor from request.context, write system_status.changed through audit() (platform context) and populate system_status.updated_by.",
      "verification": "POST the route as platform_ops then query audit_event for system_status.changed -> none.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-073",
      "severity": "P2",
      "category": "security",
      "module": "M02",
      "title": "POST /collaborators/invite has no RBAC check (collaborator.invite never required); any session whose ABAC passes can mint an external PHI link",
      "evidence": [
        "apps/backend/src/modules/02-identity/routes/link-routes.ts:149-156 only requireSession() + requireAbac(...); compare funeral invite at :190-194 which adds requirePermission(\"funeral.invite\")",
        "packages/auth/src/permissions/contributed.ts:70-74 collaborator.invite is a registered permission, but grep shows no requirePermission(\"collaborator.invite\")",
        "Spec M02 \u00a74.7 key table: `collaborator.invite | clinical_* (ABAC: caseload), org_admin`"
      ],
      "verified": false,
      "recommended_fix": "Add `await requirePermission(\"collaborator.invite\")(request)` before the ABAC check, as the funeral route does.",
      "verification": "grep -rn 'requirePermission(\"collaborator.invite\")' apps/backend/src returns nothing; call the route as an aide/volunteer on a caseload once finding above is fixed.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-074",
      "severity": "P2",
      "category": "stub",
      "module": "M02",
      "title": "POST /api/v1/provider-entities always returns 503 TAX_ID_CIPHER_UNBOUND in production because mountOrgAdminRoutes is never given a taxIdCipher",
      "evidence": [
        "apps/backend/src/index.ts:3889-3894 `mountOrgAdminRoutes(app, dbHandle.db, { outbox: m2OutboxPublisher })` with comment that the cipher is not bound",
        "apps/backend/src/modules/02-identity/routes/org-admin-routes.ts:223-230 throws WardenXError(\"TAX_ID_CIPHER_UNBOUND\", ..., 503) when deps.taxIdCipher is absent"
      ],
      "verified": false,
      "recommended_fix": "Bind a TaxIdCipherPort over the M34 tenant key ring (tenant-kek.ts) at the composition root and add a live create-PE test.",
      "verification": "POST /api/v1/provider-entities with a valid body as org_admin -> 503.",
      "prior_gap_ids": [
        "GAP-115"
      ]
    },
    {
      "id": "GAP-075",
      "severity": "P2",
      "category": "stub",
      "module": "M02",
      "title": "M2's spec'd BullMQ jobs session.reap_expired, auth.offboard_user, auth.breach_check and auth.send_invitation do not exist: expired session rows are never purged",
      "evidence": [
        "Spec M02 \u00a74.6 lines 1200-1206 (five queues with idempotent consumers)",
        "grep -rnE 'session\\.reap_expired|auth\\.offboard_user|auth\\.breach_check|auth\\.send_invitation' apps/backend/src packages -> no queue/worker; only a comment in 02-identity/auditor-link-delivery.ts:2",
        "grep for expired-session deletes (lt(schema.sessions.expiresAt...)) -> none; GAP-002's enforcer deletes a session only when that session is presented (packages/auth/src/identity/session-timeout.ts, authenticate.ts:141-150)",
        "apps/backend/src/bootstrap/jobs/ has only audit-archive, idempotency-cleanup, partition-rotation"
      ],
      "verified": false,
      "recommended_fix": "Add a per-org-free (session is not org-scoped) reaper cron on the platform context deleting expired/past-absolute sessions in batches, and the offboard/breach-check consumers or amend the spec to retire them.",
      "verification": "SELECT count(*) FROM session WHERE expires_at < now() - interval '7 days' grows without bound; no queue named session.reap_expired in bullmq.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-076",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M02",
      "title": "POST /users/:id/deactivate bypasses the last-admin lockout guard (and has no self-deactivation guard or step-up) that member revoke/suspend enforce",
      "evidence": [
        "apps/backend/src/modules/02-identity/routes/identity-routes.ts:749-790 deactivate calls deps.users.deactivateFromOrg then revokeAllForUser with no activeAdminCount check",
        "identity-routes.ts:583 and :628 lastAdminLockout() enforced only on PATCH suspend and DELETE member",
        "apps/backend/src/modules/02-identity/identity-stores-db.ts:339-350 deactivateFromOrg revokes every membership in the org with no admin check",
        "Spec M02 \u00a74.1 note `auth.lastadmin_override | platform_ops` and \u00a76 last-admin lockout guard"
      ],
      "verified": false,
      "recommended_fix": "Apply the same activeAdminCount guard (and refuse self-deactivation) in the deactivate route; require step-up like the platform variant.",
      "verification": "As the only org_admin, POST /api/v1/users/<own id>/deactivate -> 200, org left with no admin.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-077",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M02",
      "title": "Invitation create deviates from spec: email not format-validated or normalised, proposed location/PE ids not validated (INVALID_LOCATION_SCOPE never raised), TTL is 72h not 7 days, and the token is returned in the response body",
      "evidence": [
        "apps/backend/src/modules/02-identity/routes/identity-routes.ts:247-300 uses readString/readStringArray only; pendingExists(orgId,email) is case-sensitive (identity-stores-db.ts:123-135) and create stores email as given (:174-182)",
        "grep -rn INVALID_LOCATION_SCOPE apps/backend/src -> nothing",
        "identity-stores-db.ts:39 and identity-ports.ts:820 INVITE_TTL_MS = 72h vs Spec M02 \u00a72.3 line 295 `default TTL 7 days`",
        "identity-routes.ts:300-304,346-350 returns inviteUrl (contains the one-time token) in the 201/200 body; Spec M02 \u00a74.2 line ~832 `token emailed ... never returned in body`",
        "accept copies detail.defaultLocationIds straight into membership.default_location_ids (identity-routes.ts:405-410) which feeds the location_scope predicate"
      ],
      "verified": false,
      "recommended_fix": "Validate email (RFC-lite, lowercase/trim at write), validate location/PE ids belong to the org and to the inviter's scope (422 INVALID_LOCATION_SCOPE), align TTL with the spec or update the spec, and stop echoing the token once the email provider is bound.",
      "verification": "POST two invitations for 'A@x.com' and 'a@x.com' -> both 201; POST with proposedDefaultLocationIds:['not-a-uuid'] -> 201.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-078",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M02",
      "title": "Login-MFA step-up initialisation (W-M2-08) is never wired: onLoginMfaCompleted has no caller",
      "evidence": [
        "grep -rn onLoginMfaCompleted apps packages -> definition apps/backend/src/modules/02-identity/hooks/login-mfa-completed.ts:40 and barrel export index.ts:232 only; step-up-adapters-db.ts:14 comment admits it",
        "Spec M02 \u00a72.4 line 311 `Login success with MFA: initialize session.last_step_up_at/factor`; \u00a77.8 W-M2-08"
      ],
      "verified": true,
      "recommended_fix": "Call onLoginMfaCompleted from the two-factor/passkey sign-in completion hook (Better Auth after-hook) and add a live test.",
      "verification": "Sign in with TOTP then GET /api/v1/me/session -> lastStepUpAt null.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-079",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M03",
      "title": "Cross-tenant (WardenX support) break-glass is not implemented: target_organization_id / consent_ref are never written, and the `denied` state is unreachable",
      "evidence": [
        "packages/db/src/schema/break-glass.ts:21,30 columns exist; grep targetOrganizationId|consentRef in apps/backend/src shows no break-glass producer",
        "apps/backend/src/modules/03-authorization/break-glass-store.ts:63-89 invoke inserts only the intra-org columns",
        "authz-routes.ts offers cosign/revoke only; no route sets status 'denied' (store.revoke sets 'revoked')",
        "Spec M03 \u00a72.4 `Cross-tenant break-glass ... requires break-glass and tenant consent record; double-audited`; \u00a72.3.2 `cosign_pending --> denied: co-sign refused`; \u00a73.5"
      ],
      "verified": false,
      "recommended_fix": "Either implement the platform cross-tenant branch (consent_ref check, double audit) or amend the spec to point at M34 support sessions; add a deny-cosign action.",
      "verification": "grep -rn 'targetOrganizationId' apps/backend/src (excluding tests) is empty.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-080",
      "severity": "P2",
      "category": "stub",
      "module": "M03",
      "title": "GET /engagements/:id/summary hardcodes resourcesTouched: 0, so the post-engagement 'who touched what' report is empty",
      "evidence": [
        "apps/backend/src/modules/03-authorization/engagement-store.ts:183-188 `resourcesTouched: 0, // populated from the break-glass + read-audit trail (M4/T10).`",
        "Spec M03 \u00a74.3 `GET /engagements/:id/summary | post-engagement report (who touched what)` and \u00a75.2 line 861 (lists every patient touched, document downloaded)"
      ],
      "verified": false,
      "recommended_fix": "Compute touched resources from the M4 read-audit/auditor-session trail via the sanctioned audit reader keyed on the auditor's session/engagement id.",
      "verification": "Run an auditor session that reads a chart; GET summary -> resourcesTouched 0.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-081",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M03",
      "title": "Effective-permission cache is per-process with a 5-minute TTL; spec requires Valkey cache with 60-second safety TTL, authz.cache_invalidate queue and permissions.changed push (none exist)",
      "evidence": [
        "packages/auth/src/rbac/resolve.ts:102 DEFAULT_TTL_MS = 5*60*1000; drizzle-store.ts:115-116 registerDbEffectivePermissionResolver builds the resolver with no cache/ttl options (in-memory default, cache.ts)",
        "grep -rn 'cache_invalidate|permissions.changed' apps/backend/src packages -> none",
        "Out-of-band changes (bun run db:platform-role revoke, M2 membership suspend, another API replica) do not invalidate; invalidation exists only in-process in authz-routes.ts (invalidateOrg calls)",
        "Spec M03 D6 (line 1084) `event-driven invalidation primary, 60-second TTL`, \u00a74.5 queue table, STRIDE row line 997"
      ],
      "verified": false,
      "recommended_fix": "Use a Valkey-backed EffectivePermissionCache with a 60s ceiling, publish invalidations from M2/M3 writers and the platform-role CLI.",
      "verification": "Grant then revoke a role via SQL; /me/permissions keeps returning the stale set for up to 5 minutes.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-082",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M03",
      "title": "Break-glass grants satisfy mutating ABAC guards by default, so an emergency 'view' grant also lifts caseload scope on writes (patient edit/payers/merge/amend and any other module that did not opt out)",
      "evidence": [
        "packages/auth/src/abac/require-abac.ts:221-227 - breakGlassBypassable defaults to true for every requireAbac guard; only M12 (apps/backend/src/modules/12-dosespot/routes/dosespot-routes.ts:132-165), M22 review workspace (review-workspace-routes.ts:297-302), M36 (messaging-routes.ts:134) and M31 invitation scope opt out.",
        "apps/backend/src/modules/05-patient/routes/patient-routes.ts:136-145,157,161 - chartScope(patient.edit / patient.edit_payers / patient.amend_request_record / patient.merge) use caseload_or_scope with target {patientId}; apps/backend/src/modules/03-authorization/break-glass-store.ts:231-234 matches any active grant whose targetPatientId equals that id, so the write passes and is only audited at critical.",
        "Spec: docs/modules/WARDENX_MODULE_03*.md:65 and :849 define break-glass as the audited 'view a patient outside my normal scope' mechanism; dosespot-routes.ts:15 itself states 'an emergency read grant never authorises a write'."
      ],
      "verified": false,
      "recommended_fix": "Invert the default: break-glass bypass only for GET/HEAD guards (derive from request.method in requireAbac) and require explicit opt-in for any mutating guard.",
      "verification": "Inject test: with an active grant on patient X and a caller outside X's caseload, GET /patients/X succeeds but PATCH /patients/X, POST /patients/X/merge return 404/403.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-083",
      "severity": "P2",
      "category": "stub",
      "module": "M04",
      "title": "Audit exports are built and stored but can never be retrieved: GET /audit/exports/:id never returns downloadUrl",
      "evidence": [
        "apps/backend/src/modules/04-audit/routes/audit-exports.ts:82-92 toExportView `downloadUrl is always omitted ... nothing here can legitimately produce a ready row yet` (stale: jobs/audit-job-ops.ts:236-270 now sets status ready, file_ref and PUTs audit-exports/<fileRef>.<fmt>)",
        "apps/backend/src/modules/04-audit/routes/audit-exports.ts:15-17 header still says GET reports pending forever",
        "Spec M04 lines 868-869: `downloadUrl ... only present when status='ready'`; audit-typebox.ts:300 declares the field"
      ],
      "verified": true,
      "recommended_fix": "Presign a short-lived URL over fileRef when status='ready' (and expire/clean objects after 7 days), return it, and audit the download; update the stale header comment.",
      "verification": "Request an export, wait for the build tick (status ready), GET /api/v1/audit/exports/:id -> no downloadUrl.",
      "prior_gap_ids": [
        "GAP-014"
      ]
    },
    {
      "id": "GAP-084",
      "severity": "P2",
      "category": "seam",
      "module": "M05",
      "title": "M5 patient.merged has no wired consumers for M22 document re-attach/redirect or M39 consent repoint (and M39's expected payload shape mismatches); satellite rows stay on the source, relying only on PatientReader's merged_into_id chase",
      "evidence": [
        "apps/backend/src/modules/05-patient/merges-db.ts:76-80 states no cross-table re-point; the merge body only updates patient rows, inserts patient_merge, and publishes m5.patient.merged",
        "apps/backend/src/modules/05-patient/events-by-m5.ts:165-183 declaredConsumers [\"m35\"], seamConsumers [\"m22\"], comment admits the M22 redirect is unwired",
        "apps/backend/src/modules/22-documents/lifecycle/merge-redirect.ts:39,68 and 22-documents/lifecycle/index.ts:58-60: resolvePatientRedirect/applyPatientMergeCascade have zero callers outside the barrel export and tests",
        "apps/backend/src/modules/39-consent/consumers.ts:60-66: decidePatientMergeRepoint expects mergedIntoId but M5 publishes patientId (survivor) and sourcePatientId; it has no caller and no binding",
        "Counter-evidence: apps/backend/src/modules/05-patient/seams/patient-reader.ts:45-54 chases merged_into_id up to MAX_MERGE_HOPS, which partly satisfies spec line 384 for generic FK holders",
        "Spec: docs/modules/WARDENX_MODULE_05_PATIENT_SPEC_v0_4.md:384"
      ],
      "verified": true,
      "recommended_fix": "Either re-point (or union-read) patient-keyed rows for the clinical modules on m5.patient.merged, or wire merged_into_id resolution into every patient reader; bind M22 MergeFacts redirect and an M39 consent re-point consumer (fix the payload field mismatch); add a live merge test that admissions, orders, MAR, documents and consents are visible from the survivor.",
      "verification": "Merge two charts via POST /patients/:id/merge then GET survivor's admissions/orders/documents/consents: history of the source is absent. grep for callers of resolvePatientRedirect returns none.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-085",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M05",
      "title": "GET /patients list and GET /patients/:id drift from spec: merged charts are listed, merged charts are not followed/redirected, and search omits MBI/DOB",
      "evidence": [
        "apps/backend/src/modules/05-patient/patient-route-service-db.ts:117-150 list where-clause has no status != 'merged' filter (only an optional caller-supplied status); search is ILIKE on last/first/mrn only (:136-141)",
        "patient-route-service-db.ts:197-200 getPatient returns the row as-is; grep merged/mergedIntoId in that file -> none",
        "Spec M05 line 1240 `returns canonical only (excludes merged)`, `search: name/MRN/MBI/DOB`; line 1241 `follows merged_into_id and returns 301-like in body for merged`",
        "censusMetrics (:158-175) also counts merged rows in total"
      ],
      "verified": true,
      "recommended_fix": "Exclude merged in the default list/census, add MBI (identifier) and DOB search, and return {mergedIntoId} for a merged chart.",
      "verification": "Merge two patients then GET /api/v1/patients -> both rows present; GET /patients/<source> -> 200 with status merged and no redirect field.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-086",
      "severity": "P2",
      "category": "stub",
      "module": "M05",
      "title": "SSN/state-ID storage and reveal are unbuilt (phi.read_ssn / phi.write_ssn unused), and several spec'd M5 capabilities remain deferred: _match-preview, >30-day unmerge break-glass",
      "evidence": [
        "apps/backend/src/modules/05-patient/routes/lifecycle-routes.ts:209-214 POST identifiers throws SENSITIVE_IDENTIFIER_UNSUPPORTED for ssn/state_id",
        "patient-route-service-db.ts:274-276,313 `Full reveal is a separate phi.read_ssn-gated read (M5 SSN decryption follow-up)`; grep phi.read_ssn|phi.write_ssn outside the catalog -> comments only",
        "patient-lifecycle.ts:31 `>30d unmerge platform_ops break-glass ... not built`; spec line 2445 `/patients/_match-preview (DEFERRED - unbuilt)`",
        "Spec M05 \u00a72.2 per-tenant envelope encryption of SSN/state ID; lines 1249, 1261"
      ],
      "verified": false,
      "recommended_fix": "Implement the envelope-encrypted SSN/state_id path (M1 KEK/DEK helper) with phi.write_ssn step-up and a phi.read_ssn reveal route, or formally descope in the spec.",
      "verification": "POST /patients/:id/identifiers {kind:'ssn'} -> 422 SENSITIVE_IDENTIFIER_UNSUPPORTED.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-087",
      "severity": "P2",
      "category": "doc",
      "module": "M05",
      "title": "Spec route tables contradict the code: M5 \u00a74.3 marks built routes DEFERRED (unbuilt) and M2 marks GET /me/session DEFERRED though it is registered",
      "evidence": [
        "docs/modules/WARDENX_MODULE_05_PATIENT_SPEC_v0_4.md:1249,1252-1253,1257-1259,1261,1264,1268 say DEFERRED (unbuilt) for identifiers POST, caregivers, patient-matches, unmerge, amendments list, statement; code registers all of them in apps/backend/src/modules/05-patient/routes/lifecycle-routes.ts:157-381 and the same spec's as-built section (lines 2918-2921) says built",
        "docs/modules/WARDENX_MODULE_02_IDENTITY_SPEC_v0_4.md:739 marks /me/session `no route`, but apps/backend/src/modules/02-identity/routes/session-step-up.ts:159 registers it and the spec's own GAP-115 note (line 770) says built"
      ],
      "verified": false,
      "recommended_fix": "Update the route table rows to as-built and keep only the true deferrals (ssn, >30d unmerge, _match-preview).",
      "verification": "Compare the quoted spec rows with `grep -n 'app\\.\\(get\\|post\\)' lifecycle-routes.ts session-step-up.ts`.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-088",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M06",
      "title": "Org timezone (D8) not used for M6 deadline math and M6/M7 daily crons; hard-coded America/Los_Angeles and UTC dates",
      "evidence": [
        "apps/backend/src/modules/06-admission/admission-route-service-db.ts:575,593 assessment window deadlines (48h / 5-day) computed with DEFAULT_ORG_TZ; :4771 written-cert deadline; :4889 F2F encounter-date plausibility; recert-period-activation.ts:195 adequacy timeZone DEFAULT_ORG_TZ; readmission-service-db.ts:41 orgToday() uses DEFAULT_ORG_TIME_ZONE",
        "apps/backend/src/modules/06-admission/jobs/cron-workers.ts:91-93,105-109 calendarDate(now) = UTC date for F2F due_7d/3d/overdue_1d tiers; schedules '0 6 * * *' registered without a timezone (jobs/index.ts:39-45, cron-workers.ts:425-470)",
        "apps/backend/src/modules/07-care-plan/care-plan-route-service-db.ts:763 initialDueAt = activation + 5*24h (gate-clock.computeInitialDueAt unused), :1258 computeNextReviewDueAt(at) and :1057 warningOpensAt use the default LA timezone; jobs/index.ts:136",
        "Some M6 paths do call organizationTimezone (cron-workers.ts:237,326,353; admission-route-service-db.ts:4642), proving the source exists",
        "Spec M06 D8 (line 3994-4003): org timezone from organization.timezone, all dueAt/late-cert deadlines in org TZ; M07 \u00a77.1 'activation day + 5 calendar days, end-of-day org-tz'; crons 'daily 06:00 org TZ'"
      ],
      "verified": false,
      "recommended_fix": "Resolve organizationTimezone(tx, organizationId) at each deadline computation (pass into computeAssessmentWindowDeadline/computeWrittenCertDeadline/computeNextReviewDueAt/warningOpensAt, call computeInitialDueAt at bootstrap) and use per-org local date in the F2F due cron; document or implement per-org 06:00 scheduling.",
      "verification": "Unit tests with an org in America/New_York and Pacific/Honolulu asserting deadlines land on the org-local end-of-day; fixture for DST boundary.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-089",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M06",
      "title": "Late (oral) CTI: written-certification deadline is neither persisted nor followed up; mark-late has no state guard",
      "evidence": [
        "apps/backend/src/modules/06-admission/admission-route-service-db.ts:4743-4786 markCtiLate only sets signed_late=true (no status check, no deadline column/window) and publishes m6.cti.late_flagged with a computed deadline",
        "apps/backend/src/modules/06-admission/events-by-m6.ts:540-549 m6.cti.late_flagged declaredConsumers: [] (nobody acts on the deadline)",
        "apps/backend/src/modules/06-admission/jobs/index.ts:26-27 cti_late_followup queue declared with no worker (cron-workers.ts:385-421); isWrittenCertOverdue (certification/*) has no caller",
        "Spec \u00a74.3 line ~2302 'documented deferral' says the CTI signature SLA events cover it, but those key off signature_due_at, not the oral-cert 2-calendar-day written deadline (42 CFR 418.22(a)(2)); spec D4 (lines 3944-3955) requires reminder + escalation if missed"
      ],
      "verified": false,
      "recommended_fix": "Open a compliance_window (e.g. written_cert_deadline) at mark-late with must_complete_by = computed deadline so the existing window-escalation cron pages it, and restrict mark-late to unsigned drafts/awaiting-attending CTIs.",
      "verification": "Service test: mark-late on a signed/voided CTI -> 409; mark-late opens a window that goes overdue through runComplianceWindowEscalationCron.",
      "prior_gap_ids": [
        "GAP-026"
      ]
    },
    {
      "id": "GAP-090",
      "severity": "P2",
      "category": "stub",
      "module": "M06",
      "title": "PATCH /election-periods/:id accepts effectiveStart but only bumps the row version (silent no-op, also on non-draft periods)",
      "evidence": [
        "apps/backend/src/modules/06-admission/routes/admission-typebox.ts:377-380 ElectionPeriodPatchSchema has effectiveStart",
        "apps/backend/src/modules/06-admission/routes/admission-routes.ts:1081-1090 only body.ifVersion is passed",
        "apps/backend/src/modules/06-admission/admission-route-service-db.ts:4386-4401 patchElectionPeriod updates only version/updated_at, with no status check (spec: 'edit pre-signature only')",
        "Spec route 21 (line ~1906): edit pre-signature only"
      ],
      "verified": true,
      "recommended_fix": "Implement the effectiveStart edit for pending periods with a status guard (R-EL-03/F2F window recompute) or remove the field and route.",
      "verification": "Route test: PATCH {effectiveStart} on a pending period changes effective_at; on an active period -> 409.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-091",
      "severity": "P2",
      "category": "security",
      "module": "M07",
      "title": "Goal and intervention creation do not verify that problemId (or goalRefs) belongs to the plan in the path",
      "evidence": [
        "apps/backend/src/modules/07-care-plan/care-plan-route-service-db.ts:1445-1475 addGoal: checkGoalReferencesProblem(body.problemId) only checks presence; insert uses body.problemId",
        "apps/backend/src/modules/07-care-plan/care-plan-route-service-db.ts:1549-1559 addIntervention same; plan-scoped loadProblem (lines 673-680) exists but is not used here",
        "packages/db/migrations/0028_care_plan_m7_tables.sql:150,156 plain FKs goal.problem_id/intervention.problem_id -> problem(id), no composite (care_plan_id, problem_id)",
        "A caller authorized on plan A can attach elements to another patient's problem in the same org (same class as prior GAP-024)"
      ],
      "verified": false,
      "recommended_fix": "Load the problem with eq(PROB.carePlanId, planId) (and validate goalRefs against the plan's goals) before insert; consider a composite FK.",
      "verification": "Route test: POST /care-plans/{A}/goals with problemId from plan B -> 404.",
      "prior_gap_ids": [
        "GAP-024"
      ]
    },
    {
      "id": "GAP-092",
      "severity": "P2",
      "category": "security",
      "module": "M07",
      "title": "PHI read /internal/care-plan/relevant-elements declares auditRead without any resource/patient id, so its read event cannot be written",
      "evidence": [
        "apps/backend/src/modules/07-care-plan/routes/care-plan-routes.ts:507-514 config: { auditRead: { resourceKind: \"care_plan_element\" } } (no resourceIdParam, patientIdParam, patientIdQueryParam, list)",
        "apps/backend/src/bootstrap/plugins/read-audit.ts: resourceId = params[resourceIdParam] ?? patientId ?? \"\" and patientId resolves only from param/query-param/payload-path config",
        "packages/audit/src/audit.ts:177 binds input.resourceId ?? null (\"\" is not null); packages/db/migrations/0001_foundation_rls_roles_partitioning.sql:55 resource_id uuid -> uuid cast of '' fails; emission wrapper swallows (read-audit.ts catch)",
        "CLAUDE.md standing habit: 'A read-audit config needs a resourceIdParam ... the read leaves no trail'. Programmatic scan of every GET in M6-M10 found this the only config of that shape; the route is called by the web encounter screen with a human session (see GAP-182 comment, lines 509-515)"
      ],
      "verified": false,
      "recommended_fix": "Add patientIdQueryParam: 'patientId' (and resourceKind care_plan) to the config; add a live assertion that the read event lands.",
      "verification": "Live read-audit suite: GET the route as a clinician and assert a care_plan_element.viewed row with patient_id exists (run on private PG container, not shared cluster).",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-093",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M08",
      "title": "Encounter void records the encounter's author as the voiding actor (no distinct void actor threaded)",
      "evidence": [
        "apps/backend/src/modules/08-encounters/encounters-route-service-db.ts:2090 voidedBy: r.authoredByMembershipId // no distinct void actor threaded; :2097 event payload voidedBy likewise",
        "apps/backend/src/modules/08-encounters/routes/encounters-routes.ts:653-664 void handler never passes the acting membership (userId not destructured)",
        "Audit/event attribute a director's administrative void to the clinician who wrote the note"
      ],
      "verified": false,
      "recommended_fix": "Pass actorMembershipId from the route into voidEncounter and persist/emit it.",
      "verification": "Route test: director voids another author's draft; assert encounter.voided_by and m8.encounter.voided.voidedBy equal the director's membership.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-094",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M08",
      "title": "Volunteer-visit rule (active volunteer_assignment) and related pure validators are defined but never invoked",
      "evidence": [
        "apps/backend/src/modules/08-encounters/lifecycle/validation.ts:124-133 checkVolunteerAssignment has no production caller",
        "apps/backend/src/modules/08-encounters/encounters-route-service-db.ts:1209-1210 comment: 'the rest - volunteer assignment, service-date-after-admission - thread their seam facts when the interface carries them'; createDraft (1202-1260) does not call it",
        "M15 now owns volunteer_assignment (apps/backend/src/modules/15-discipline-care-plans/volunteer/assignments.ts), so the 'deny-stub until M15 lands' reason no longer holds",
        "Spec M08 \u00a72.7 table line 363: volunteer encounter must reference an active volunteer_assignment -> 422 NO_VOLUNTEER_ASSIGNMENT; \u00a77.10 line 1611"
      ],
      "verified": false,
      "recommended_fix": "Resolve the M15 assignment reader in createDraft and call checkVolunteerAssignment; add a unit+live test.",
      "verification": "POST /encounters with encounterType volunteer_visit and no active assignment -> 422 NO_VOLUNTEER_ASSIGNMENT.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-095",
      "severity": "P2",
      "category": "security",
      "module": "M08",
      "title": "Cosignature queue returns all org cosign_pending encounters to any encounter.cosign holder; not narrowed to the caller's routed requests (RN) vs team view (supervisor)",
      "evidence": [
        "apps/backend/src/modules/08-encounters/routes/encounters-routes.ts:257-269 (preHandler [COSIGN] only, passes organizationId only)",
        "apps/backend/src/modules/08-encounters/encounters-route-service-db.ts:1136-1145 (WHERE status='cosign_pending', no cosignature_request join, no routed_to or caseload filter)",
        "docs/modules/WARDENX_MODULE_08_ENCOUNTERS_SPEC_v0_2.md:1148 (route 27 'RN's cosignature work queue'), 1096 (cosignature_request_routed_to_idx for the queue), 1511-1516 (\u00a75.5: 'Routed cosignatures'; supervisor view 'shows the same queue across the team')"
      ],
      "verified": true,
      "recommended_fix": "Filter by routed_to_membership_id = caller (or caller's caseload via listScopeOf) like the encounters list does.",
      "verification": "Route test: RN B with no routed requests and patients off caseload gets an empty queue; RN A sees only routed items.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-096",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M10",
      "title": "Spec describes an automated iQIES submit/reconcile pipeline and alert dispatcher; as-built is a manual package flow with the automated stages unscheduled and transport unbound",
      "evidence": [
        "apps/backend/src/modules/10-hope/jobs/cron-workers.ts:7-20 RECOVERY NOTE; :440-470 registerM10CronWorkers builds only windows, sfv, retention workers; :493-520 scheduleM10Jobs skips assemble/submit/reconcile; runIqiesSubmitCron/ReconcileCron kept but unwired",
        "apps/backend/src/index.ts:7290-7316 iqies: createUnboundIqiesAdapter()",
        "Queues hope.alerts (hope-alert-dispatcher), hope.validation (revalidate-on-terminology-update), hope.scheduling have no workers (documented deferral, spec line ~1262)",
        "Spec M10 \u00a74.8 table (lines 1248-1262) and line 150 ('We submit... cron-driven iqies-submit-worker'), \u00a71.4; routes mark-uploaded/results/package/workspace exist in hope-routes.ts:589-625 but are not in spec \u00a74.1",
        "The manual-flow decision is documented only in a code comment, not in the module spec or an ADR (grep docs/ finds it only in the superseded audit)"
      ],
      "verified": false,
      "recommended_fix": "Update M10 spec/ADR to the as-built manual flow (routes, jobs, DR tier) or schedule the automated stages once a live transport exists; track alert-dispatcher as an explicit deferral.",
      "verification": "bun run docs:modules / arch:fitness doc checks after spec update; test that unbound adapter leaves no queued orphan batches.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-097",
      "severity": "P2",
      "category": "stub",
      "module": "M11",
      "title": "Order-suggestion banner (D7) is half built. The route always returns an empty list and the HOPE J2051 trigger consumer is unbound.",
      "evidence": [
        "orders-route-service-db.ts:922-925 suggestions() returns { patientId, suggestions: [] }; routes/service.ts:1489 is the same.",
        "outbox-consumers/m9-assessment-significant-change.ts:1-30 writes suggestion state to Valkey (wardenx:m11:orders:suggestion:<patientId>), and its header says no read route exists. No code reads that key, so GET /api/v1/orders/suggestions/:patientId (orders-routes.ts:369-386) never reflects it.",
        "consumers/hope-trigger.ts is a decider with no binding. scripts/outbox-subscription-exceptions.ts:141-150 registers it as handler-unbound (a reasoned, acknowledged deferral).",
        "m11.order.suggestion_state_changed has no producer outside that consumer. Spec M11 lines for hope.j2051_trigger_fired and assessment.significant_change require updating state and emitting the event."
      ],
      "verified": false,
      "recommended_fix": "Make suggestions() read the Valkey projection (or persist it). Bind the HOPE trigger consumer and remove the exception entry.",
      "verification": "Code reading; grep for the Valkey key.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-098",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M11 Orders (web)",
      "title": "Standing orders screen is read-only: no UI to create, pause, resume, discontinue or spawn; verbal-policy admin, sign-on-behalf and suggestions endpoints also have no web caller (not spec-mandated)",
      "evidence": [
        "apps/web/src/modules/11-orders/standing-orders.tsx:16-17 (write actions deferred), :48 (only client.GET)",
        "grep of apps/web/src, apps/admin/src and packages/ui/src finds no caller of the standing-order write routes, verbal-policy, regenerate-verbal-timer, sign-on-behalf or orders/suggestions beyond the generated packages/ui/src/core/api/schema.ts and a comment at apps/web/src/modules/11-orders/screens.ts:29",
        "docs/design/screens/clinical/WARDENX_UI_ORDERS.md:113 only describes standing-order template spawning; lines 86-94 describe verbal-order record, sign and countdown and do not mention policy admin or sign-on-behalf"
      ],
      "verified": true,
      "recommended_fix": "Wire the lifecycle actions or mark the spec partial.",
      "verification": "Read standing-orders.tsx; openapi diff.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-099",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M12",
      "title": "refill_inbox_policy and controlled_substance_policy tables do not exist. The PATCH policy routes do not persist and omit step-up. Enroll lacks step-up.",
      "evidence": [
        "Spec M12 line 2189 makes ownedTables = [... 'refill_inbox_policy','controlled_substance_policy' ...] a blocker. architecture/module-manifest.ts:539-554 lists neither, and no migration creates them.",
        "dosespot-route-service-db.ts:1546-1578 putRefillInboxPolicy returns a view without writing anything or emitting an event. putControlledSubstancePolicy only emits an event. getRefillInboxPolicy / getControlledSubstancePolicy always return the DEFAULT_* constants (:205-216). The header (:26-28) admits no table exists.",
        "putRefillInboxPolicy throws NotFoundError (404) for a validation failure (:1553-1556).",
        "Spec \u00a74.1 requires step-up on PATCH refill-inbox-policy, PATCH controlled-substance-policy and POST .../enroll. routes/dosespot-routes.ts:705,750,777 compose only the ROSTER or POLICY permission.",
        "epcsCertificationStatus is the constant 'not_certified' (:215), so the D18 per-tenant gate cannot be flipped. The platform_ops flip route (spec line 2173 blocker) does not exist.",
        "refillSla jobs use platform defaults only; the tighten-only tenant policy cannot take effect."
      ],
      "verified": false,
      "recommended_fix": "Add both tables (RLS, tenancy columns, manifest .ts and .cjs, live RLS suite). Persist the PATCH routes. Compose requireStepUp on enroll and both PATCH routes. Return 422 for policy-floor violations. Add the platform_ops EPCS-status route.",
      "verification": "grep of migrations and manifest; code reading.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-100",
      "severity": "P2",
      "category": "stub",
      "module": "M12",
      "title": "EPCS controlled-sign path hard-codes its safety facts to true and never verifies a second factor",
      "evidence": [
        "dosespot-route-service-db.ts:894-909 signControlledInitiate passes deaScheduleAuthorized: true and prescriberIal2Verified: true into the machine. It ignores the _schedule argument, so the body-supplied schedule drives the dea_schedule_authorized ABAC (routes/dosespot-routes.ts:126-138) and is never compared with the stored order's schedule. It returns { nonce: id, expiresAt: new Date().toISOString() } (a nonce equal to the order id, already expired).",
        "signControlledComplete (:911-935) passes challengeCompletedInTime: true and secondFactorType: 'totp' to the machine. SignControlledCompleteRequest is parsed and discarded (routes/dosespot-routes.ts:383), so no code is ever verified. epcs_signing_attempt is never written here.",
        "Today the tenant gate is a constant 'not_certified' (:215), so the path always refuses. The first flip of the gate would let any prescriber with the permission complete an EPCS sign with no IAL2 check and no 2FA."
      ],
      "verified": false,
      "recommended_fix": "Before enabling EPCS, derive the schedule from the stored order, read the roster IAL2 state and DEA schedules, create and verify an epcs_signing_attempt with a real nonce and second factor, and read certification status from a per-tenant table.",
      "verification": "Code reading. Documented as Phase-1 OFF (D18) so severity is limited to latent risk.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-101",
      "severity": "P2",
      "category": "coverage",
      "module": "M12",
      "title": "17 mutating M12 routes publish no response schema, and rx-benefit lookup declares 201 while returning 200",
      "evidence": [
        "scripts/openapi/enrichments.ts:4872-4999 (a script over the enrichment entries for the M12 paths) lists entries with no `response:` for PATCH /medication-orders/:id, request-signature, sign, sign-controlled/initiate and /complete, verbal, cosign, discontinue, complete, correct, refills approve and deny, rx-benefit/lookup, admin enroll and revoke, PATCH refill-inbox-policy and PATCH controlled-substance-policy.",
        "POST /refills/:id/deny, /medication-orders/:id/retransmit and /patients/:patientId/medications/history/refresh have no `body:` entry (mutatingNoBody candidates). arch:openapi-coverage reports deficit 0 because shallow entries count as enriched.",
        "The same pattern, smaller, in M14: POST /idg/meetings/:id/cancel, /reschedule and /adjourn have no response (enrichments.ts:5206-5222)."
      ],
      "verified": false,
      "recommended_fix": "Add response schemas for the M12 and M14 mutations (reuse the service view TypeBoxes). Extend the coverage ratchet to count missing responses on mutating routes.",
      "verification": "Parsed scripts/openapi/enrichments.ts entries.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-102",
      "severity": "P2",
      "category": "seam",
      "module": "M12/M27",
      "title": "DrugCostBillingReader (M12) is never registered, so M27's Worksheet-A pharmacy cross-check always skips",
      "evidence": [
        "apps/backend/src/bootstrap/seams/registry.ts:464-472 (ownerModule 12; RESERVATION: stays on the deny-stub).",
        "No registerSeam(\"DrugCostBillingReader\") anywhere under apps/backend/src (perl scan of registerSeam calls).",
        "Consumer: apps/backend/src/index.ts:6190 `drugCost: () => getSeam(\"DrugCostBillingReader\")`."
      ],
      "verified": false,
      "recommended_fix": "Add a drug-cost column or aggregate on M12 and register the reader, or drop the rule and the seam.",
      "verification": "Run a cost-report validation and confirm the drug-reconcile rule outcome is 'skip'.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-103",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M13",
      "title": "Caregiver-attested administration is filed under a sentinel admission with empty drug snapshot and no controlled-substance flag. Manual kit-return acknowledgment skips quantities, discrepancy check and supervisor floor.",
      "evidence": [
        "emar-route-service-db.ts:1260 uses admissionId: ADMISSION_SENTINEL and :1264 uses drugNameSnapshot: ''. Neither isControlledSubstance nor the order's admission is taken from `identity`, although identity is resolved at lines 1241-1247. A controlled-substance dose reported by a caregiver is stored as non-controlled and is invisible to admission-scoped rollups.",
        "emar-route-service-db.ts:1741-1768 acknowledgeReturn ignores remaining quantities. It hard-codes disposalReconciliationStatus='reconciled' and finalRemainingByMedication: {}, has no status guard, and never raises m13.comfort_kit.controlled_substance_discrepancy (spec line 1663: \u22655% discrepancy).",
        "routes/emar-routes.ts:714-722 composes KIT_ACK_RETURN plus SCOPE only. Spec route 26 (line 1304) also requires clinical_supervisor_or_above.",
        "AcknowledgeReturnRequest (emar-typebox.ts:224-226) carries only an optional note."
      ],
      "verified": false,
      "recommended_fix": "Use identity.admissionId, drugName and isControlledSubstance for the caregiver row. Extend the acknowledge-return body with remaining quantities per medication. Compute the discrepancy, add the supervisor floor, and guard on disposalStatus.",
      "verification": "Code reading.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-104",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M14",
      "title": "POST routes lack the Idempotency-Key requirement that spec \u00a74.1 lists for them",
      "evidence": [
        "Spec M14 \u00a74.1 column 'Idempotency' lists Idempotency-Key for cancel, reschedule, packets/build, start, adjourn, attendance, agenda, decisions, supersede, action-items and recurring-policies.",
        "apps/backend/src/modules/14-idg/routes/idg-routes.ts uses requireIdempotencyKey() (IDEMPOTENCY_KEY, line 185) only on PATCH/DELETE routes and on POST discipline-notes (:980). POST /recurring-policies (:254), /meetings (:282), cancel, reschedule, packets/build, start, adjourn, attendance, agenda, decisions, supersede and action-items do not use it.",
        "The global middleware (bootstrap/plugins/idempotency.ts:42-48) only acts when the client sends a key, so a retried POST /decisions or /action-items without a key creates a duplicate row."
      ],
      "verified": false,
      "recommended_fix": "Add IDEMPOTENCY_KEY to the listed POST routes, as M15 does (routes/plans.routes.ts IDEMPOTENT).",
      "verification": "Code reading and route extraction script output.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-105",
      "severity": "P2",
      "category": "coverage",
      "module": "M16",
      "title": "Live RLS isolation tests omit three owned tables",
      "evidence": [
        "packages/db/migrations/__tests__/m16-rls-isolation.live.test.ts has no bereavement_cop_opt_out_credit; m17-rls-isolation.live.test.ts has no membership_credential; m19-rls-isolation.live.test.ts has no on_call_roster_sync_queue (only incidental cross-tenant assertion at m19-roster-sync-debounce.live.test.ts:432).",
        "Other live suites reference bereavement_cop_opt_out_credit (m16-opt-out-changed) and membership_credential (m17-scheduling-write) but make no cross-tenant read/write assertion on them."
      ],
      "verified": false,
      "recommended_fix": "Add the three tables to the per-module isolation suites.",
      "verification": "Scripted compare of manifest ownedTables vs the test sources. Suites not run.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-106",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M17",
      "title": "Publishing a visit proposal hard-codes 13:00-14:00 UTC, ignores proposal duration, and leaves patient_address_id NULL for a patient_home visit (spec section 2.3 violation); EVV only gets a baseline via the primary-address fallback",
      "evidence": [
        "apps/backend/src/modules/17-scheduling/scheduling-route-service-db.ts:1420-1438 hard-codes T13:00:00.000Z start, T14:00:00.000Z end, patient_home, patientAddressId null, externalFacilityId null. The same fixed instant is used for the seam facts at :1404.",
        "proposedDurationMinutes is not used in publishProposal. The only references are at :1758 (the value 60) and :1797.",
        "docs/modules/WARDENX_MODULE_17_SCHEDULING_SPEC_v0_2.md:285 says patient_home requires patient_address_id non-null.",
        "COUNTER-EVIDENCE: apps/backend/src/modules/05-patient/address-reader.ts:134-160 serviceAddressCoordinate resolves the current primary address when patientAddressId is null. evv-route-service-db.ts:381-408 passes the null through to it. The claim that every check-in is labelled fail_no_baseline is therefore not supported."
      ],
      "verified": true,
      "recommended_fix": "Take the visit window from the proposal/availability in the org timezone with proposed_duration_minutes, resolve the patient's service address through M5's PatientAddressReader, and respect visit setting.",
      "verification": "Read publishProposal and the M18 baseline path.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-107",
      "severity": "P2",
      "category": "security",
      "module": "M17",
      "title": "Visit/proposal/recurring write routes carry only RBAC; permissions declare caseload_or_scope but no route composes it",
      "evidence": [
        "apps/backend/src/modules/17-scheduling/routes/scheduling-routes.ts:326-343 (PATCH /visits/:id, EDIT only), :365-391 (cancel, reschedule, no-show), :480 (reassign), :511-535 (proposal publish/dismiss), :538-586 (recurring list/create/discontinue) have no ABAC guard. Only GET /visits/:id uses VISIT_SCOPE.",
        "packages/auth/src/permissions/contributed.ts:1893-1966 declares abac 'caseload_or_scope' for visit.edit/cancel/reschedule/reassign/mark_no_show/proposal.dismiss/recurring_*; CLAUDE.md notes PermissionDef.abac is a declaration only.",
        "GET /recurring-visits lists by an arbitrary patient query param with no scope."
      ],
      "verified": false,
      "recommended_fix": "Compose a per-visit/per-patient caseload_or_scope guard (or an explicit org-scope role check) on these routes, mirroring VISIT_SCOPE.",
      "verification": "Read routes. Role-to-permission grants not inspected, so reach depends on which roles hold these keys.",
      "prior_gap_ids": [
        "GAP-053"
      ]
    },
    {
      "id": "GAP-108",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M17",
      "title": "PATCH /visits and reassign have no status guard, no version/If-Match check and no unassigned event on assignee change",
      "evidence": [
        "scheduling-route-service-db.ts:963-1038 editVisit and :1297-1349 reassignVisit never inspect v.status and update WHERE id only; both read v.version but never compare an expected version.",
        "grep -rn 'If-Match|expectedVersion' in the M17 module returns nothing.",
        "editVisit changes assignedMembershipId without appending visit_state_history or emitting m17.visit.unassigned/assigned (reassignVisit emits assigned only, no unassigned for the old assignee), so the caseload shift cache is not updated for the former assignee.",
        "EditVisitRequest.schedulerInternalNotes (scheduling-typebox.ts:200) is never persisted."
      ],
      "verified": false,
      "recommended_fix": "Require If-Match/expected version on PATCH and reassign (412 with current row), restrict to published/proposed states, emit unassigned for the former assignee, persist notes.",
      "verification": "Read services and grep.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-109",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M17",
      "title": "Visit creation never validates admission, patient<->admission, address or setting rules; caregiverReminderOptIn is accepted but never stored",
      "evidence": [
        "scheduling-route-service-db.ts:638-706 insertAndPublish inserts patientId/admissionId/patientAddressId as supplied; no admission/patient/address existence or active check.",
        "No CHECK for the setting rules: packages/db/src/schema/scheduling/visits.ts:10-11 states these are app-validated, and no code validates them (grep).",
        "POST /visits request (scheduling-typebox.ts:179-192) includes caregiverReminderOptIn, schedulerInternalNotes, parentRecurringVisitId; routes/scheduling-routes.ts:260-270 drops all three. The only reader is reassignment-scan.ts:175 (eq(V.caregiverReminderOptIn,true)); the web UI sends it (apps/web/src/modules/17-scheduling/scheduling-workflow.tsx:379), so caregiver reminders can never fire."
      ],
      "verified": false,
      "recommended_fix": "Validate the admission and its patient via the M6 reader, enforce patient_home->address and facility->externalFacilityId, and persist opt-in and notes.",
      "verification": "Read service, route, schema and grep.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-110",
      "severity": "P2",
      "category": "stub",
      "module": "M17",
      "title": "GET /metrics/route-efficiency always returns 501; proposal sources m11/m14/m15 are never produced",
      "evidence": [
        "scheduling-route-service-db.ts:2267-2275 throws WardenXError NOT_IMPLEMENTED 501.",
        "M17 consumers handle only m7.care_plan.version_signed (consumers/care-plan-proposals.ts:36-43). There is no consumer of m11.order_requires_visit or idg.decision_recorded (consumers/index.ts:12-14 says they are 'wired by M17-T04', but they are not). SupervisoryCadenceReader is exported (seams/consumed.ts:40) but never called.",
        "grep: m11.order_requires_visit has no producer in M11; the only generated source is frequency_driven_m7 (scheduling-route-service-db.ts:1816). Proposals never move to 'stale' (spec 2.2.4)."
      ],
      "verified": false,
      "recommended_fix": "Implement the m14/m11/m15 proposal producers (or amend the spec) and either implement route-efficiency or remove the route and its M33 dependency.",
      "verification": "Read consumers, grep for sources.",
      "prior_gap_ids": [
        "GAP-131"
      ]
    },
    {
      "id": "GAP-111",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M17",
      "title": "M17 PHI write-audit events use retention_class 'operational' although the spec requires 'compliance' for audit events",
      "evidence": [
        "packages/db/migrations/0045_scheduling_m17_rls_audit_triggers.sql:255-268 (and 0269_m17_evv_missing_resolution.sql:76) insert audit_event with 'operational'.",
        "M17 spec header (Depends-on item 4): 'M17-F07/ADR-0004 - PHI write-AUDIT events ... go to the compliance class (7-yr HIPAA floor) - never operational'. M18/M16/M19/M20 triggers use 'compliance' (0047, 0102, 0108, 0111)."
      ],
      "verified": true,
      "recommended_fix": "Switch M17 audit triggers to 'compliance' (new migration) and backfill, or amend the spec if operational is intended.",
      "verification": "Read trigger SQL and spec header. Spec section 3.7 says tables are operational, so the spec is internally inconsistent; implementation follows 3.7.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-112",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M17",
      "title": "M17 and M18 mutating routes do not require Idempotency-Key; geofence/visit PATCH lack If-Match",
      "evidence": [
        "grep for requireIdempotencyKey in modules 17-scheduling and 18-evv returns no files (M16, M19, M20 each use it); the M1 plugin only acts when a key is sent (bootstrap/plugins/idempotency.ts:37-39).",
        "M17 spec Remediation M17-F08: key 'declared on every mutating route'. M18 spec section 4.1 header and table: Idempotency-Key 'required'; PATCH /evv/geofence-policy/tenant 'If-Match' (EditTenantPolicyRequest has no version, evv-typebox.ts:98-101)."
      ],
      "verified": false,
      "recommended_fix": "Add requireIdempotencyKey() to the mutating routes and a version/If-Match to the geofence-policy PATCH.",
      "verification": "Grep and read specs.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-113",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M18",
      "title": "Offline-sync idempotency on (deviceId, localId) is not implemented; a replayed batch hits the (org, visit, kind) unique index",
      "evidence": [
        "localId is accepted at evv-typebox.ts:45,62 but never passed by routes/evv-routes.ts:178-186/:236-258 nor used in evv-route-service-db.ts (grep for localId in the module finds only the typebox).",
        "The column and unique index exist (packages/db/src/schema/evv/evv-event.ts:85,123).",
        "captureInTx (evv-route-service-db.ts:466-491) plain-inserts with no ON CONFLICT; recordCapture runs the batch with Promise.all of independent transactions (evv-routes.ts:253-270), so a retry after a partial success errors on already-synced events and the client cannot ack the queue."
      ],
      "verified": false,
      "recommended_fix": "Persist localId and insert ON CONFLICT (org, device, local_id) DO NOTHING returning the existing result; return per-event results.",
      "verification": "Read route, service and schema. Not run.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-114",
      "severity": "P2",
      "category": "security",
      "module": "M18",
      "title": "EVV event/bracket reads have no caseload_or_scope; device attestation gate is off by default",
      "evidence": [
        "routes/evv-routes.ts:303-310, :316-327, :367-379 - GET /evv/events/:id, /evv/events (filter by patient/clinician) and /evv/visits/:id/bracket use only P('evv.read').",
        "routes/evv-routes.ts:123-126 and :142-150 mount device_attestation_valid only when deps.deviceAttestationEnforced is true; docs/architecture/WARDENX_OPS_RUNBOOK_v0.1.md:2103 says default is OFF (no attested client)."
      ],
      "verified": false,
      "recommended_fix": "Compose caseload_or_scope (or an org-scope role check) on the read routes. Track enabling attestation as a release gate.",
      "verification": "Read routes and runbook. Role grants for evv.read not inspected.",
      "prior_gap_ids": [
        "GAP-055"
      ]
    },
    {
      "id": "GAP-115",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M19",
      "title": "POST /triage-calls/:id/identify-patient takes unvalidated patient/admission ids and can re-point a call in any state with no history or event",
      "evidence": [
        "routes/write-service-drizzle.ts:587-609 - applyCallPatch sets patientId, admissionId, locationId, callerCaregiverId from the body. There is no patient/admission existence or patient<->admission check, no call-state guard (compare other commands using lifecycle deciders), no state-history row and no outbox event.",
        "grep: no identify_patient_completed event or lifecycle decider exists (spec 4.8 AI queue is triggered on it)."
      ],
      "verified": false,
      "recommended_fix": "Add an identifyPatient lifecycle decision (allowed states only, no change after protocol answers/disposition), validate patient/admission via M5/M6 readers, append history and emit the event.",
      "verification": "Read service and grep.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-116",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M19",
      "title": "Verbal-order step-up and M11 recordVerbalOrder are never invoked from M19 routes; deferred M8 encounter links have no retry worker",
      "evidence": [
        "clinical/verbal-order.ts:185-200 recordTriageVerbalOrder (scope + step-up + M11 seam) has no production caller (grep of apps/backend/src); selectDisposition (routes/write-service-drizzle.ts:871-883) only checks the named order exists for the same patient (assertVerbalOrderBelongsToCall), with no step-up and no check that it is a verbal order.",
        "routes/write-service-drizzle.ts:949-962 swallows linkTriageEncounter failure with .catch(() => undefined); the comment at :986-991 says 'the encounter-creator.consumer retries', but jobs/index.ts M19_QUEUES has no such worker and no job rescans documented_pending_encounter calls."
      ],
      "verified": true,
      "recommended_fix": "Route verbal_order_recorded through recordTriageVerbalOrder with step-up, and add the m19.encounter-creator retry worker (or a rescan) for calls with no linked_encounter_id.",
      "verification": "Grep and read.",
      "prior_gap_ids": [
        "GAP-134"
      ]
    },
    {
      "id": "GAP-117",
      "severity": "P2",
      "category": "security",
      "module": "M20",
      "title": "SOS lastKnownVisitId is client-supplied, unvalidated, and later drives a cross-module visit cancellation",
      "evidence": [
        "routes/write-service-drizzle.ts:839 stores input.lastKnownVisitId as supplied (no check that the visit is the poster's).",
        "routes/write-service-drizzle.ts:1149 and :1247 emit m20.safety.visit_cancellation_requested / draft the incident with visitId: row.lastKnownVisitId.",
        "17-scheduling/outbox-consumers/m20-safety-visit-cancellation.ts:100-140 cancels the visit by id with no assignee check."
      ],
      "verified": false,
      "recommended_fix": "Resolve the visit server-side via VisitAssignmentReader.currentVisitForClinician(actor.membershipId), or validate assignee == poster at raise; verify again in the M17 consumer.",
      "verification": "Read flow. Requires a supervisor to resolve with outcome=visit_cancelled.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-118",
      "severity": "P2",
      "category": "stub",
      "module": "M20",
      "title": "High-risk-area evaluator and SOS location-stream writer are unbuilt; several section 4.8 queues are absent",
      "evidence": [
        "seams/consumed.ts:28-35 and index.ts:43-45 say M20 has no polygon evaluator because 'PatientAddressReader.geocodedAddressFor does not exist'; but M5's PatientAddressReader.serviceAddressCoordinate now exists (18-evv/evv-route-service-db.ts:223) and a ray-cast already exists in seams/providers.ts:188-191.",
        "m20.safety.high_risk_area_entered has no emitter (alerts.ts:216/391 builder only; events-by-m20.ts:379-396).",
        "No code inserts into safety_sos_location_stream (grep: schema, eraser and tests only), so GET /safety/sos/:id/location-stream (routes/sos.routes.ts:181-189) can never return data; lifecycle/location-stream.ts is a decider with no worker.",
        "jobs/index.ts M20_QUEUES has only sos-sla-watchdog, overdue-detector and coverage-gap-watchdog. Missing from the spec catalog: sos-location-stream, high-risk-area-evaluator, policy-version-housekeeper, dek-rotation."
      ],
      "verified": false,
      "recommended_fix": "Build the evaluator (M5 coordinate + M40/jsonb polygons) with mandatory pre-visit schedule rows, the location-stream sampler, and dek-rotation re-seal.",
      "verification": "Grep and read.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-119",
      "severity": "P2",
      "category": "security",
      "module": "M21",
      "title": "M21 createSupplyRequest persists the body patientId without checking it against the admission's patient (same-tenant misattribution)",
      "evidence": [
        "apps/backend/src/modules/21-supplies/routes/write-service-drizzle.ts:606-636: patientId: input.patientId is inserted verbatim (line 634 -> insertSupplyRequest insert at ~334).",
        "write-service-drizzle.ts:516-533: providerEntityFor() reads getAdmissionSummary() but extracts only providerEntityId; summary.patientId (packages/types/src/admission.ts:267) is never compared.",
        "packages/db/migrations/0104_supplies_m21_supply_request_partitioned.sql:42-43,81-83: patient_id and admission_id are plain uuid NOT NULL columns; FKs exist only for organization, provider_entity and location. Migrations 0106 and 0386 add no patient/admission check or trigger.",
        "apps/backend/src/modules/21-supplies/routes/supply-requests.routes.ts:61-66: preHandlers are P('supplies.request.create'), ABAC_DISPATCHER_ON_KIND and IDEMPOTENT only. guards.ts:60-80 shows the ABAC checks dispatcher eligibility for the serving Location, not patient/admission consistency."
      ],
      "verified": true,
      "recommended_fix": "Derive patientId from the admission summary server-side (reject or ignore a mismatching body value), and verify sourceOrderId belongs to that patient/admission; optionally compose caseload_or_scope on the target patient.",
      "verification": "Read the cited lines; confirmed no comparison of summary.patientId anywhere in write-service-drizzle.ts (grep patientId). Not run live.",
      "prior_gap_ids": [
        "GAP-064"
      ]
    },
    {
      "id": "GAP-120",
      "severity": "P2",
      "category": "security",
      "module": "M21",
      "title": "PHI read-audit events for M21-M25 single-record reads carry no patient attribution, so the M4 patient-access / accounting join cannot find them",
      "evidence": [
        "No auditRead config in modules 21-25 sets patientIdParam, patientIdQueryParam or patientIdPayloadPath except M22 pending-address and prospect-summary patient routes (22-documents/extraction/pending-address-routes.ts:60, prospect-summary-routes.ts:171); e.g. supply-requests.routes.ts:98-103, comfort-kits.routes.ts:87-92, 23 claims.routes.ts:232-237, 24 claims.routes.ts:87-95, 25 denials.routes.ts:73-79 and remittance.routes.ts:55-60, 22 documents-routes.ts:337-342",
        "apps/backend/src/bootstrap/plugins/read-audit.ts:87-101 states a patient-scoped route 'must name one'; resolvePatientId returns undefined otherwise",
        "packages/audit/src/query/drizzle-audit-query.ts:63-68 touchesPatient matches only context.patientId or resourceKind 'patient', so these reads never appear in patientAccess/accounting"
      ],
      "verified": false,
      "recommended_fix": "Add patientIdPayloadPath (e.g. 'patientId') to the single-record read configs on patient-bound resources in M21-M25.",
      "verification": "grep for the three attribution keys across the five modules plus read of the query filter. M39 and M2 routes show the working pattern (patientIdPayloadPath).",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-121",
      "severity": "P2",
      "category": "stub",
      "module": "M22",
      "title": "Spec routes still unbuilt: right-of-access PHI bundle export fails closed (503) and template-version publish returns 501",
      "evidence": [
        "apps/backend/src/modules/22-documents/documents-route-service-db.ts:786-794 exportPhiBundle throws DegradedError('m22.export-phi-bundle'); the route is registered at routes/documents-routes.ts:419-432 with step-up and ABAC but produces nothing",
        "documents-route-service-db.ts:1192-1199 publishTemplateVersion throws WardenXError NOT_IMPLEMENTED 501; routes/documents-routes.ts:740 exposes the publish route",
        "Spec \u00a74.1 row 11 / \u00a78.9 (164.524 export, document.phi_bundle_exported alert) and \u00a74.7 form_template_publish_authority"
      ],
      "verified": true,
      "recommended_fix": "Build the async bundle pipeline (or route the endpoint to the M34 DSAR export) and a platform-context publish path, or remove the routes from the tenant surface and the spec.",
      "verification": "Read the cited lines. The fake-success defect in GAP-065/GAP-140 is gone (these now fail honestly), but the capability is absent.",
      "prior_gap_ids": [
        "GAP-065",
        "GAP-140"
      ]
    },
    {
      "id": "GAP-122",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M22",
      "title": "D22 critical-results priority render lane (forms-render-critical, CRITICAL RESULT watermark, m22.document.rendered_critical_results) is not implemented",
      "evidence": [
        "grep -rn 'forms-render-critical|rendered_critical_results|results_received_critical' apps/backend/src (excluding tests/dist) finds only apps/backend/src/modules/11-orders/events-by-m11.ts:499, which declares declaredConsumers: [] for the critical event",
        "docs/modules/WARDENX_MODULE_22_DOCUMENTS_SPEC_v0_5.md:601 (separate BullMQ queue, concurrency 5, 30 s timeout), :732 form-render-critical.worker.ts, :746, \u00a74.8 queue table row `forms-render-critical`, and the 'CRITICAL RESULT' watermark sentence",
        "Lab PDFs render only through the normal m11.order.results_received consumer (render-variants/lab-backref-bindings.ts)"
      ],
      "verified": false,
      "recommended_fix": "Add the critical lane (queue, worker, watermark variant, rendered_critical_results event) or amend the spec if D22 is dropped.",
      "verification": "grep + spec read. Not run live.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-123",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M22",
      "title": "document_within_admission_window (13-month post-discharge read window) is registered but composed on no document read route",
      "evidence": [
        "scripts/abac-uncomposed-allowlist.ts:16-17 lists it with 'Open gap'",
        "apps/backend/src/modules/22-documents/abac-predicates.ts:31 registers it; routes/documents-routes.ts composes only ABAC_OWNER on content/export reads",
        "Spec \u00a74.7 row `document_within_admission_window` applies to documents.read / documents.read_phi_content on post-discharge bereavement-class documents"
      ],
      "verified": false,
      "recommended_fix": "Compose the predicate on the document read and content routes (or delete it and amend \u00a74.7).",
      "verification": "bun run arch:abac-composed passes only because of this allowlist entry.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-124",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M23",
      "title": "Provider-entity scoping is missing on NOE/NOTR/transfer-notice lists, MAC credential list, AR dashboard and metrics",
      "evidence": [
        "apps/backend/src/modules/23-billing-medicare/routes/noe.routes.ts:51-53, notr.routes.ts:51-53, transfer-notice.routes.ts:47-50 guard the list routes with [READ] only; readService.listNoes/listNotrs (routes/read-service-drizzle.ts:527-562) filter by caller-supplied providerEntityId only, no actor scope",
        "routes/mac-credentials.routes.ts:59-62 GET list is [READ] only; listMacCredentials (read-service-drizzle.ts:651-664) lists the whole org",
        "routes/metrics.routes.ts:25-51 AR dashboard and metrics are [READ_AR]/[READ_METRICS] only; getArAging/getClaimMetrics (read-service-drizzle.ts:738-780) apply only the optional caller filter, so a PE-scoped billing_manager sees org-wide totals and can name any providerEntityId",
        "Contrast: GET /billing/claims passes `providerEntityScope: resolveClaimProviderScope(request)` (claims.routes.ts:207-225)",
        "Spec \u00a74.1 rows 24, 28, 34, 37, 38 require provider_entity_billing_scope"
      ],
      "verified": true,
      "recommended_fix": "Apply the server-derived provider-entity scope (as listClaims does) in listNoes/listNotrs/listTransferNotices/listMacCredentials/getArAging/getClaimMetrics, and reject or empty an out-of-scope providerEntityId filter.",
      "verification": "Read the cited routes and read-service methods; no scope argument reaches these queries. Not run live.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-125",
      "severity": "P2",
      "category": "seam",
      "module": "M23",
      "title": "M23, M24 and M25 never consume m22.document.rendered, so their document back-reference columns are never populated",
      "evidence": [
        "apps/backend/src/modules/22-documents/events-by-m22.ts:88 declaredConsumers for m22.document.rendered = [m6,m11,m12,m13,m14,m16,m21,m27,m33]; m23, m24, m25 are absent",
        "apps/backend/src/index.ts consumer list (around 9559-9690) binds no m23/m24/m25 consumer for the event; handlers exist (23-billing-medicare/consumers/handlers.ts handleDocumentRendered, 25-remittance/consumers/handlers.ts:205-212, 25-remittance/outbox-consumers/denial-seed-store-drizzle.ts:85-103 backrefDocument) but dispatchM25UpstreamEvent/handleDocumentRendered have no caller outside their module",
        "grep for confirmationDocumentId/acknowledgmentDocumentId writes under apps/backend/src finds only read mappers and noe-notr-state-service optional params; appealPacketDocumentId is written only by the manual attach route",
        "Specs: M23 line 2700 task 57 (m22-document-rendered.consumer), M24 line 433, M25 lines 589, 1295, 1426, 1492"
      ],
      "verified": false,
      "recommended_fix": "Bind the three back-ref consumers (match on sourceModule/aggregateType, including the appeal_packet vs appeal_case aggregateType mismatch noted at renderer.ts:195-197 vs handlers.ts:195-203) and add m23/m24/m25 to the event's declaredConsumers.",
      "verification": "grep + read of the catalog and index.ts consumer list. The outbox gate stays green because the declarations were removed rather than bound. Not run live.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-126",
      "severity": "P2",
      "category": "seam",
      "module": "M23/M24/M28",
      "title": "M23 ClaimReader is unregistered; M24 Medicare-primary context and the M28 Claim projection have no source, and M24's Medicare-primary ack consumer is inert",
      "evidence": [
        "registry.ts:600 `{ key: \"ClaimReader\", ownerModule: 23 ... }` and no registration anywhere; 23-billing-medicare/index.ts:10 only mentions it.",
        "apps/backend/src/modules/24-billing-medicaid/outbox-consumers/m24-medicare-primary-ack.ts:14-19 says the ClaimReader.medicareSecondaryContext seam is not bound; :34-39 says no code ever transitions a claim into AWAITING_MEDICARE_PRIMARY, so the consumer matches zero claims.",
        "apps/backend/src/modules/28-fhir/seams/consumed.ts:221-222 getFhirClaimReader returns the deny-stub."
      ],
      "verified": false,
      "recommended_fix": "Publish ClaimReader and the medicareSecondaryContext read from M23. Call await_medicare_primary from M24 assemble/validate for dual-eligible claims.",
      "verification": "Create a dual-eligible Medicaid claim and verify its state reaches AWAITING_MEDICARE_PRIMARY; check medicare_secondary_context_snapshot.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-127",
      "severity": "P2",
      "category": "seam",
      "module": "M23/M26",
      "title": "M23 cap-projection path (projectionForOrg / M26 getProjectionForServiceDate and getInpatientProjectionForServiceDate) ignores CCN and picks the first period by capYear; only the cost-report path was fixed by GAP-149",
      "evidence": [
        "apps/backend/src/modules/23-billing-medicare/services/cap-projection-adapter.ts:~67 projectionForOrg(orgId, _providerEntityId, capYear) drops the provider entity and calls the M26 seam without any CCN",
        "apps/backend/src/modules/26-cap/seam-impls.ts:79-80 and :95-96 `periods.find((p) => p.capYear === capYear)` with no ambiguity handling",
        "contrast: seam-impls.ts:127-137 aggregateForCostReport uses selectCapPeriodForCcn (apps/backend/src/modules/26-cap/cap-period-selection.ts), which returns null when ambiguous",
        "packages/db/migrations/0086_cap_m26_tables.sql:38 unique key is (organization_id, ccn, cap_year), so several periods per year are legal",
        "apps/backend/src/index.ts:4619-4633 and write-service-drizzle.ts:137 stamp a real CCN only when the org has exactly one provider entity, else '000000'"
      ],
      "verified": true,
      "recommended_fix": "Thread providerEntityId/CCN through CapProjectionProvider and the M23 adapter. Open per-CCN periods and route accrual per patient provider entity.",
      "verification": "Seed two provider entities with different CCNs and a period each for the same year. Call projectionForOrg for the second and compare totalAllocatedCap to that CCN's period.",
      "prior_gap_ids": [
        "GAP-149"
      ]
    },
    {
      "id": "GAP-128",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M24",
      "title": "Several M24 reads are org-wide: provider-entity scope is not applied to AR dashboard, AR metrics, eligibility history, R&B arrangement list, validation worklist, override list or trading-partner credential list",
      "evidence": [
        "apps/backend/src/modules/24-billing-medicaid/routes/read-service-drizzle.ts:545-590 arDashboard/arMetrics filter only by the optional requested providerEntityId (no peScope)",
        "read-service-drizzle.ts:426-451 listEligibilityChecks filters by patientId only (LIMIT 200 org-wide when none)",
        "read-service-drizzle.ts:455-470 listRbArrangements, :285-301 listOverrides, :308-380 validationWorklist (returns patientId and control number across all provider entities), :510-540 listTradingPartnerCredentials are unscoped",
        "Only listClaims (peScope at line 158) and listRbDays (line 491) call the new peScope helper (lines 136-145)",
        "routes/eligibility.routes.ts:44-48, routes/rb.routes.ts:60-63, routes/claims.routes.ts:354-358, 368-382, 405-415, routes/trading-partner.routes.ts:31-34 compose only P(permission); guards.ts:74 ABAC_QUERY_PE is defined but never used",
        "Spec \u00a74.1 rows 17, 23, 25, 35, 36 name provider_entity_medicaid_billing_scope / rb_arrangement_visible_in_scope"
      ],
      "verified": false,
      "recommended_fix": "Pass the server-assembled providerEntityIds through peScope in every list/aggregate read above, and delete or use the dead ABAC_QUERY_PE helper.",
      "verification": "Read each cited method and route; grep ABAC_QUERY_PE shows a definition and no use. Not run live.",
      "prior_gap_ids": [
        "GAP-145"
      ]
    },
    {
      "id": "GAP-129",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M24",
      "title": "medicaid_claim_in_billing_manager_caseload checks only provider-entity scope; the spec's per-patient caseload axis (and org-wide-role bypass) is not implemented",
      "evidence": [
        "apps/backend/src/modules/24-billing-medicaid/abac-predicates.ts:166-174 returns `!!claim && peInScope(context, claim.providerEntityId)`; the comment at :17-18 and :172 says the per-patient narrowing 'binds when the M5 CaseloadProvider seam binds (deferred)'",
        "docs/modules/WARDENX_MODULE_24_BILLING_MEDICAID_SPEC_v0_2_1.md:1717-1727 defines the predicate as org-wide-billing-scope OR caseload.patientsForActor includes resource.patientId",
        "M23 already consumes that seam for the identical predicate: apps/backend/src/modules/23-billing-medicare/abac-predicates.ts:134-143 and :322-323 (isInCaseload via CaseloadProvider)"
      ],
      "verified": false,
      "recommended_fix": "Resolve the claim's patient and add the CaseloadProvider.isInCaseload axis (with the org-wide billing-scope bypass) as M23 does; remove the stale 'deferred' comment.",
      "verification": "Read both predicate files and the spec block. Not run live.",
      "prior_gap_ids": [
        "GAP-145"
      ]
    },
    {
      "id": "GAP-130",
      "severity": "P2",
      "category": "stub",
      "module": "M24",
      "title": "Medicaid AR dashboard and metrics return hard-coded empty/zero fields",
      "evidence": [
        "apps/backend/src/modules/24-billing-medicaid/routes/read-service-drizzle.ts:561 `buckets: []`, :562 `chargesCents: 0`, :588 `aging: []`",
        "arDashboard counts every claim in every state as `totalOpen` (lines 545-563, no open-state filter)",
        "Spec \u00a75 / row 35: aging buckets by state and MCO, rolling denial rate, R&B billing rate, AR balance by patient; M23 getArAging (read-service-drizzle.ts:738-780) shows the intended bucket computation"
      ],
      "verified": false,
      "recommended_fix": "Compute aging buckets, charge totals and the open-state filter from claim rows (mirror M23 getArAging); drop fields that cannot be computed.",
      "verification": "Read the cited lines. Not run live.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-131",
      "severity": "P2",
      "category": "security",
      "module": "M24",
      "title": "Read-audit waiver on R&B arrangement routes says 'no patient data' but the payload is patient-bound",
      "evidence": [
        "apps/backend/src/modules/24-billing-medicaid/routes/rb.routes.ts:60-67 and :84-86 declare `auditRead: { none: \"room-and-board arrangements ... no patient data\" }`",
        "read-service-drizzle.ts:103-119 toArrangement returns patientId, nfFacilityMdmId and the NF name snapshot (the patient's residence); getRbArrangement (:473-488) also returns the patient's rb_day list",
        "packages: the same routes accept a patientId filter (listRbArrangements, :455-470)"
      ],
      "verified": false,
      "recommended_fix": "Replace the waiver with an emission config (resourceKind rb_arrangement, resourceIdParam id, patient attribution) for the detail route and a list config for the list route.",
      "verification": "Read rb.routes.ts and toArrangement. Not run live.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-132",
      "severity": "P2",
      "category": "stub",
      "module": "M24",
      "title": "M24 ack-pull cron declared in queue catalog and spec but no worker/schedule is ever constructed",
      "evidence": [
        "apps/backend/src/modules/24-billing-medicaid/jobs/queues.ts:13 M24_CRON_QUEUES.ackPull='medicaid-ack-pull'; :21 schedule '*/15 * * * *'; :31 concurrency",
        "grep of M24_CRON_QUEUES.* usages: only eligibilityStaleWatchdog and rbDayDailySweep (jobs/index.ts:84,95,112,113) and stateChannelHealth (state-channel-health-jobs.ts:429,440) are constructed; ackPull has no reference outside queues.ts",
        "jobs/index.ts:10 comment says ack-pull 'is wired separately (submission-jobs.ts)' but submission-jobs.ts contains no ack-pull queue/worker (only submit/poll queues)",
        "Spec docs/modules/WARDENX_MODULE_24_BILLING_MEDICAID_SPEC_v0_2_1.md:413,1782,2263: medicaid-ack-pull cron every 15 min per state per channel, 'pulls + parses ack files via adapter'"
      ],
      "verified": false,
      "recommended_fix": "Construct the medicaid-ack-pull Worker + repeatable schedule fanning over (state, channel), or document and remove it from the catalog if the poll queue is the intended replacement and amend the spec.",
      "verification": "grep -rn M24_CRON_QUEUES apps/backend/src; read jobs/index.ts and queues.ts. Whether the poll queue fully substitutes was not proven.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-133",
      "severity": "P2",
      "category": "seam",
      "module": "M24",
      "title": "Catalogued M24 events with no emit site: submission_stalled, replaced, voided, awaiting_medicare_primary, acknowledgment_partial, eligibility refresh_requested and mco_assignment_changed",
      "evidence": [
        "apps/backend/src/modules/24-billing-medicaid/events-by-m24.ts:167 (submission_stalled), 295 (replaced), 311 (voided), 80 (awaiting_medicare_primary), 205 (acknowledgment_partial), 344 (medicaid_eligibility.refresh_requested), 384 (mco_assignment_changed): each name appears only in the catalog file in non-test source",
        "M24 retry path: jobs/queues attempts:5 (submission-jobs.ts:652) but on exhaustion nothing emits stalled; contrast M23 jobs/m23-jobs.ts:946 which emits m23.claim.submission_stalled plus a critical alert dispatch",
        "events-by-m24.ts:167-177 seamConsumers ['m36','m33'] so the M36 stalled-submission alert can never fire for Medicaid claims",
        "No dynamic template eventName for m24 (grep 'eventName: `' only hits m23)"
      ],
      "verified": false,
      "recommended_fix": "Emit m24.medicaid_claim.submission_stalled (plus alert) when the submit/poll retry budget is exhausted; emit replaced/voided on TOB 817/818 acceptance; or remove unbuildable events from the catalog with spec justification.",
      "verification": "Python scan of all 774 catalogued events against quoted-literal occurrences in non-test src, then grep -F per name. 15 events had <=1 occurrence; 1 (idg.decision_recorded) was a false positive (emitted at 14-idg/idg-route-service-db.ts:1354).",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-134",
      "severity": "P2",
      "category": "seam",
      "module": "M25",
      "title": "remittance.manual_match composes claim_assigned_to_actor against the remittance LINE id as if it were a denial-case id, so non-oversight roles are always denied",
      "evidence": [
        "apps/backend/src/modules/25-remittance/routes/remittance.routes.ts:23 `MANUAL_MATCH_ABAC = ASSIGNED_TO_ACTOR(\"remittance.manual_match\")` and :130 preHandler [MANUAL_MATCH, MANUAL_MATCH_ABAC, IDEMPOTENT]",
        "routes/guards.ts:17-19 targetDenialCaseId returns `{ denialCaseId: params.id }`, and for this route params.id is the remittance_line id",
        "abac-predicates.ts:176-185: a non-broad role with a non-empty denialCaseId calls loadDenialAssignment(lineId) -> null -> returns false (notFoundOnDeny: true gives 404); the comment at :179 'no denial case in the target (manual-match) -> pass' is never reached because the guard always supplies the line id",
        "BROAD_DENIAL_SCOPE_ROLES (abac-predicates.ts:39-43) = org_admin, compliance_officer, billing_manager only"
      ],
      "verified": true,
      "recommended_fix": "Give the manual-match route a target that omits denialCaseId (or a dedicated provider-entity-scope guard on the line's PE) so the predicate's no-subject branch applies; add a route-level test with a non-broad role.",
      "verification": "Static trace of guard -> predicate. Role-grant defaults for remittance.manual_match were not traced (unverified), so which roles are affected is not confirmed. Not run live.",
      "prior_gap_ids": [
        "GAP-073"
      ]
    },
    {
      "id": "GAP-135",
      "severity": "P2",
      "category": "stub",
      "module": "M25",
      "title": "denial close-write-off emits a fabricated m25.patient_responsibility.recorded event and records no ledger row",
      "evidence": [
        "apps/backend/src/modules/25-remittance/routes/write-service-drizzle.ts:218-223 publishes `payload: { ledgerId: id, patientId: id, prAmount: \"0.00\" }` where id is the denial_case id",
        "No patient_responsibility_ledger insert happens in closeWriteOffDenial (:204-224)",
        "events-by-m25.ts:239-243 documents the event as 'a CAS group-PR adjustment recorded a patient_responsibility_ledger row'; spec route #16 says 'emits PR/bad-debt event'"
      ],
      "verified": false,
      "recommended_fix": "Resolve the claim's patient and the written-off balance, write the ledger/bad-debt record, and emit the event with real ledgerId/patientId/amount (or do not emit).",
      "verification": "Read write-service-drizzle.ts:204-224. The event currently has no declared consumer, so no runtime impact today. Not run live.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-136",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M25",
      "title": "Mandatory documented reasons for escalate/resolve/reopen/withdraw/decide are validated then discarded",
      "evidence": [
        "apps/backend/src/modules/25-remittance/routes/write-service-drizzle.ts:154 escalateDenial(_input), :158 resolveDenial(_input), :227 reopenDenial(_input), :466 withdrawAppeal(_input) never read the reason; decideAppeal (:411-420) stores outcome but not the \u226540-char reason",
        "Only assign (:144) and close-write-off (:214 overridePayload) persist a reason",
        "m25-typebox.ts:60-86,135-140 enforce minLength 20/40 on these bodies; spec \u00a74.1 #14,#17,#24,#25 and the HHS-OIG audit-trail row (spec line 140) require a documented reason"
      ],
      "verified": false,
      "recommended_fix": "Persist the reason on a denylisted column or event row (denial_case_assignment-style history or appeal_case_event payload) for each transition.",
      "verification": "Read the cited methods. Not run live.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-137",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M25",
      "title": "Attached appeal document ids are client-supplied and never validated against the org, patient or claim",
      "evidence": [
        "apps/backend/src/modules/25-remittance/routes/write-service-drizzle.ts:289-303 attachAppealDocument sets appeal_packet_document_id = body documentId with no existence, org, or patient check",
        "submitAppeal/submitAppealLateGoodCause (:309-319, :352-356) store attachedDocumentIds in appeal_narrative.documents unchecked",
        "packages/db/src/schema/remittance/appeal.ts: appeal_packet_document_id is a plain uuid (no FK)"
      ],
      "verified": false,
      "recommended_fix": "Verify each document id is visible in the org and belongs to the appeal's patient/claim (via the M22 DocumentReader seam) before storing.",
      "verification": "Read the cited methods; no document lookup in the write path. Not run live.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-138",
      "severity": "P2",
      "category": "seam",
      "module": "M25/M26",
      "title": "A paid 835 line whose claim lacks DTM service dates is silently dropped from cap accrual",
      "evidence": [
        "apps/backend/src/modules/25-remittance/ingest/service-drizzle.ts:225-226 `serviceFrom: claim.serviceFrom ?? null, serviceTo: claim.serviceTo ?? null`.",
        "apps/backend/src/modules/26-cap/consumers/handlers.ts:41-60 handleRemittancePosted returns {recorded:false} when serviceFrom/serviceTo/patientId is empty (the header says it refuses rather than fabricates). Nothing logs, alerts or retries a refusal, and the dispatcher row completes."
      ],
      "verified": false,
      "recommended_fix": "Fall back to the M23 claim's service dates (claimCandidates seam) in M25's capFacts. Surface a refused accrual through a counter, a dead-letter or an M26 reconciliation flag.",
      "verification": "Ingest an 835 with no DTM*232/233 for a paid hospice claim and check cap_beneficiary_accrual_line (expect no row today).",
      "prior_gap_ids": [
        "GAP-075"
      ]
    },
    {
      "id": "GAP-139",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M26",
      "title": "Settlement finalize skips the unresolved-PS&R-variance block, drops the attestation, and records the user id as the step-up assertion id",
      "evidence": [
        "write-service-drizzle.ts:~494-545 finalizeSettlement(actor, periodId, _input) never queries cap_psr_reconciliation for pending lines and never stores _input.attestation",
        "write-service-drizzle.ts:520 stepUpSessionId: actor.userId and :197 (methodology lock) stepUpSessionId: actor.userId; both columns are 'M2 step-up evidence' (packages/db/src/schema/cap/cap-period.ts:90, reconciliation.ts:127)",
        "grep finalization_snapshot / finalizationSnapshot in packages/db/src/schema/cap: no column"
      ],
      "verified": false,
      "recommended_fix": "Reject finalize with 409 + line ids while open/investigating reconciliation lines exist (or require a recorded waiver); persist attestation and a worksheet snapshot; stamp the real session/step-up id (ctx.attributes.sessionId + lastStepUpAt).",
      "verification": "Seed an open cap_psr_reconciliation line, call finalize, expect 409; assert cap_settlement carries attestation and a real step-up evidence id.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-140",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M26",
      "title": "Period reopen ignores its reason and is not flagged severity=high; no application-level audit events exist; audit triggers hard-code severity 'info'",
      "evidence": [
        "write-service-drizzle.ts:~222-240 reopenPeriod(actor, periodId, _input) discards the reason; snapshots are not marked superseded; no event is emitted",
        "packages/db/migrations/0090_cap_m26_audit_triggers.sql: every trigger writes severity 'info'",
        "grep audit|severity in apps/backend/src/modules/26-cap non-test code: no audit()/severity use (only job alert payloads)",
        "no application audit for settlement proposal, PS&R upload, manual recompute or threshold ack (spec 8.4 item 2)"
      ],
      "verified": false,
      "recommended_fix": "Persist the reopen reason, emit an audit event with severity high for reopen/finalize/methodology-lock, mark prior snapshots superseded, and add the spec'd application-level audit events.",
      "verification": "Reopen a settled period and query audit_event for severity='high' with the reason.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-141",
      "severity": "P2",
      "category": "security",
      "module": "M26",
      "title": "POST /cap/periods accepts a methodology at open with no step-up and no methodology_lock row, bypassing the D12 step-up lock",
      "evidence": [
        "cap.routes.ts:64-70 POST /api/v1/cap/periods has only PERIOD_MANAGE + IDEMPOTENT",
        "write-service-drizzle.ts:~151-170 inserts methodology: input.methodology directly on cap_period without a cap_period_methodology_lock row or step-up"
      ],
      "verified": false,
      "recommended_fix": "Drop methodology from OpenCapPeriodRequest or route it through lockMethodology with STEP_UP and the lock row.",
      "verification": "POST /cap/periods with methodology and no step-up; expect rejection.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-142",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M26",
      "title": "PS&R import performs no CCN validation against M40 (and the period CCN is the 000000 sentinel for multi-entity orgs)",
      "evidence": [
        "grep -i ccn in apps/backend/src/modules/26-cap/psr and packages/cap-management/src (excluding seams): no CCN header check; psr-reconcile.ts parses and reconciles without comparing the file CCN",
        "write-service-drizzle.ts:~140 openPeriod falls back to ccn '000000' when the org is not unambiguous"
      ],
      "verified": true,
      "recommended_fix": "Validate the PS&R CCN against the org/provider-entity CCN via the M40 resolver and reject mismatches; implement per-provider-entity periods.",
      "verification": "Import a CSV with a foreign CCN and expect parse_failed/rejection.",
      "prior_gap_ids": [
        "GAP-149"
      ]
    },
    {
      "id": "GAP-143",
      "severity": "P2",
      "category": "seam",
      "module": "M26",
      "title": "m23.claim.replaced and m23.claim.voided are bound but functionally inert: handler reads fields the payload never carries",
      "evidence": [
        "apps/backend/src/modules/23-billing-medicare/events-by-m23.ts:305-320 payload is {originalClaimId, replacementClaimId|voidClaimId, reason}",
        "apps/backend/src/modules/26-cap/consumers/handlers.ts:90-103 handleClaimReversed requires patientId, claimId, serviceFrom, serviceTo and returns {recorded:false} otherwise",
        "consumers/outbox-binding.ts header itself says they stay 'functionally inert'"
      ],
      "verified": false,
      "recommended_fix": "Widen the M23 payloads (patientId, amounts, service dates) or have M26 resolve the original claim's accrual lines by originalClaimId and write the reversal.",
      "verification": "Void a paid claim in a live suite and assert a negative cap_beneficiary_accrual_line appears.",
      "prior_gap_ids": [
        "GAP-075"
      ]
    },
    {
      "id": "GAP-144",
      "severity": "P2",
      "category": "build",
      "module": "M26",
      "title": "Cron fan-out has no per-org/per-period isolation (one failing org aborts the tick) and nightly snapshots are mislabelled manual_recompute",
      "evidence": [
        "jobs/index.ts:134-170 each cron is a single BullMQ job looping listActiveOrgs() then runNightlyProjection/runCapYearClose with no try/catch per org or period",
        "write-service-drizzle.ts:644 persistSnapshot hard-codes computedBy: 'manual_recompute' although enum has 'nightly_batch' (packages/db/src/schema/cap/enums.ts:37)",
        "no advisory lock per (period, scope) (spec 2.5)"
      ],
      "verified": false,
      "recommended_fix": "Enqueue child jobs per (org, period) with the spec idempotency key, or isolate failures per org; pass the compute basis through recompute.",
      "verification": "Make one org's recompute throw and assert later orgs still recompute; assert computed_by='nightly_batch' for cron rows.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-145",
      "severity": "P2",
      "category": "stub",
      "module": "M26",
      "title": "M26 platformConstantRefresh and thresholdEvaluator queues declared but never constructed",
      "evidence": [
        "apps/backend/src/modules/26-cap/jobs/queues.ts:14,17 queue names cap-threshold-evaluator and cap-platform-constant-refresh; :27 cron '0 4 15 8 *'; :50-72 params with DLQ",
        "apps/backend/src/modules/26-cap/jobs/index.ts constructs only nightlyProjection, capYearClose, psrVarianceWatchdog, psrReconcile (lines 152,162,180,202,231,251-253)",
        "grep for platformConstantRefresh/thresholdEvaluator/constant_refresh across apps/backend/src and packages/cap-management/src: only queues.ts",
        "Spec WARDENX_MODULE_26 line 422-423 describes enqueueing threshold-evaluator jobs on accrual line insert; threshold crossing is evaluated inline in routes/write-service-drizzle.ts:595-678 instead"
      ],
      "verified": false,
      "recommended_fix": "Either build the Aug-15 CMS cap-amount publication reminder worker (spec D3 platform-constant refresh) or delete the queue and amend the spec; reconcile threshold-evaluator queue with inline evaluation.",
      "verification": "Scripted scan of every exported *_QUEUE_PARAMS/CRON key against usages (150 keys; 5 had zero usage). Inline threshold evaluation was read; the behavioral equivalence with the spec scope scopes was not tested.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-146",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M26 Cap (web)",
      "title": "Cap UI is read-only: no PS&R import/resolve, methodology change, projection recompute or settlement actions",
      "evidence": [
        "No caller: POST /cap/periods/{id}/methodology, POST /cap/periods/{id}/psr-imports, POST /cap/projections/{id}/recompute, GET /cap/projections[/agency|inpatient|patient], GET /cap/accruals/inpatient|patient, PATCH /platform/cap/constants/{year} (4 of 12 mutating ops)",
        "SCREEN_SPEC_STATUS: CAP_MANAGEMENT 'built ... read views only (no cap write is wired in the SPA)'; CAP_SETTLEMENT 'built ... settlement (read)' although the spec's Actions require writes"
      ],
      "verified": false,
      "recommended_fix": "Wire writes or re-label both specs 'partial'.",
      "verification": "openapi diff; SCREEN_SPEC_STATUS rows.",
      "prior_gap_ids": [
        "GAP-079"
      ]
    },
    {
      "id": "GAP-147",
      "severity": "P2",
      "category": "seam",
      "module": "M26/M27/M37/M33/M30",
      "title": "Four of M26's six published seams (CapSettlementProvider, InpatientCapProvider, CapMetricsProvider, CapAlertSubscriberProvider) are built but unregistered and not in REQUIRED_SEAMS; the spec'd consumers have no read path",
      "evidence": [
        "apps/backend/src/modules/26-cap/wiring.ts:19-20 registers only CapAccrualReader and CapProjectionProvider.",
        "apps/backend/src/bootstrap/seams/registry.ts has no entry for CapSettlementProvider, InpatientCapProvider, CapMetricsProvider or CapAlertSubscriberProvider (only CapAccrualReader :441 and CapProjectionProvider :450).",
        "The only M27 cap read is CapAccrualReader.aggregateForCostReport (27-cost-report/routes/cap-context.ts:36); there is no per-beneficiary attachment or settlement snapshot.",
        "docs/modules/WARDENX_MODULE_26_CAP_MANAGEMENT_SPEC_v0_3.md:18 (M27 consumes CapSettlementProvider.snapshotForCostReport for the Worksheet E row and per-beneficiary attachment; M37 consumes InpatientCapProvider for the per-unit cap tile; M30 consumes CapMetricsProvider; M33 consumes all four) and :70.",
        "packages/reporting/src/seams/consumed/m26-cap.ts still says 'M26 is not yet implemented' and is a deny-stub that nothing consumes."
      ],
      "verified": false,
      "recommended_fix": "Register the four seams (add REQUIRED_SEAMS entries) and bind their consumers, or retire the spec lines and the dead builders. Update the stale M33 consumed-seam header.",
      "verification": "grep -rn 'getSeam(\"CapSettlementProvider\"|getSeam(\"InpatientCapProvider\"' returns nothing outside tests.",
      "prior_gap_ids": [
        "GAP-208"
      ]
    },
    {
      "id": "GAP-148",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M27",
      "title": "Past-deadline filing block is not implemented: submit and submit-past-deadline are the same code path and the bypass reason is discarded",
      "evidence": [
        "write-service-drizzle.ts:1164-1167 submit() calls submitPastDeadline(actor, id, {reason: ''})",
        "write-service-drizzle.ts:1169-1250 submitPastDeadline never reads compliance window/current_effective_deadline_date and never uses args.reason; emits the same m27.cost_report.submitted event",
        "packages/cost-report/src/domain/lifecycle.ts:58 submit transition has no deadline guard (only approve_for_submit is guarded)"
      ],
      "verified": false,
      "recommended_fix": "In submit, refuse with a structured error when today > current_effective_deadline_date; in submitPastDeadline require and persist the reason and emit a warn-severity audit event.",
      "verification": "Create a report with an expired window, call /submit (expect block) and /submit-past-deadline (expect success + warn audit).",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-149",
      "severity": "P2",
      "category": "stub",
      "module": "M27",
      "title": "Live Xero trial-balance and Gusto wage pulls are unbound, so every pull job fails (only manual CSV/JSON import works)",
      "evidence": [
        "apps/backend/src/index.ts:6153-6210 buildM27WorkerDeps is passed no trialBalanceSeam, wageDataSeam or dek",
        "jobs/m27-jobs.ts:331-364 default to unboundWorkerPort('trialBalanceSeam.pull' / 'wageDataSeam.pull'); the file's own comment (lines ~1206-1214) says OAuth token storage does not exist yet",
        "POST /cost-reports/:id/imports/trial-balance and /wage-data, and refresh-inputs source:'xero', therefore end in status failed"
      ],
      "verified": false,
      "recommended_fix": "Bind the xero-client/gusto-client pulls with tenant OAuth credential storage, or demote the routes/spec to manual-import-only for Phase 1.",
      "verification": "Trigger a trial-balance pull in the Docker stack and expect a completed import row.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-150",
      "severity": "P2",
      "category": "seam",
      "module": "M27",
      "title": "W-CR-08 (MAC rejection to rule suggestion) and W-CR-12 (provider-entity offboarding closes open reports) have handlers but no live consumer binding or producing event",
      "evidence": [
        "consumers/subscription-map.ts:14-22 header: m25.denial.opened has a handler and no binding; the M40 offboard topic 'm40.provider_entity.offboarded' is a name no catalog carries",
        "apps/backend/src/index.ts:9472-9476 binds only buildM27DocumentBackrefConsumer and buildM27VendorInvoiceConsumer",
        "grep m40.provider_entity.offboarded / provider_entity_offboarded in modules/40-mdm: no producer; arch:outbox-bindings reports 'no-such-event 2'"
      ],
      "verified": false,
      "recommended_fix": "Bind the m25 denial consumer, introduce an M40 offboard event, and bind the close-reports consumer, or amend the spec.",
      "verification": "Offboard a provider entity with a draft cost report; expect state closed and window closed_at set.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-151",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M27 Cost report (web)",
      "title": "Cost report workspace cannot map accounts, generate/track ECR, reopen, return to draft or request deadline extensions",
      "evidence": [
        "cost-report-api.ts:64-156 now wires imports, compute, allocate, validate, approve-for-submit and submit (GAP-082 mostly closed)",
        "15 of 29 mutating M27 ops uncalled: cost-center-mappings preview|apply|reset-to-platform-default, ecr-submissions list/detail/acknowledgments, deadline-extensions, submit-past-deadline, reopen, return-to-draft, refresh-inputs, statistics refresh, bad-debt PATCH/DELETE, validations/{vid}/overrides, validation-rules PATCH/disable"
      ],
      "verified": false,
      "recommended_fix": "Add mapping, ECR and reopen/extension surfaces or record them as deferred.",
      "verification": "openapi diff; read cost-report-api.ts.",
      "prior_gap_ids": [
        "GAP-082"
      ]
    },
    {
      "id": "GAP-152",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M28",
      "title": "Inbound FHIR staging has no wire validation and no idempotency (non-unique dedup index), so re-POSTs create duplicate proposals",
      "evidence": [
        "fhir-r4.routes.ts:831-846 stages request.body as-is; grep InboundPatientResource|validateInbound in packages/fhir and apps/backend: none",
        "store-drizzle.ts:784-825 stageInbound is a plain INSERT",
        "packages/db/migrations/0136_fhir_gateway_m28_inbound_resource_partitioned.sql:52 fhir_inbound_dedup_idx is a plain CREATE INDEX (not UNIQUE)"
      ],
      "verified": false,
      "recommended_fix": "Validate per resource type and make (organization_id, source_client_id, resource_type, source_fhir_id) idempotent (return the existing proposal).",
      "verification": "POST the same Patient twice; expect one proposal row and the same proposal id.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-153",
      "severity": "P2",
      "category": "seam",
      "module": "M28",
      "title": "Inbound accept pins a reviewer-supplied acceptedAggregateId; no owner-module (M5/M12) callback or consumer exists, so accepted proposals never become native records",
      "evidence": [
        "routes/m28-typebox.ts:143-147 AcceptProposalBody.acceptedAggregateId is a free Uuid from the request body",
        "admin-inbound.routes.ts:52-67 passes body.acceptedAggregateId straight to store.acceptProposal (store-drizzle.ts:678-716) with no existence/ownership check",
        "grep m28.fhir.inbound.accepted and FhirInboundProposalReader consumers: only M28 files and bootstrap; M5 and M12 never read or act on proposals"
      ],
      "verified": false,
      "recommended_fix": "Implement the M5/M12 review-and-apply flow that creates the native row and calls accept with the minted id (server-validated), or have accept resolve the aggregate itself.",
      "verification": "Stage a Patient, accept as an RN, and assert a patient row exists whose id equals accepted_aggregate_id.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-154",
      "severity": "P2",
      "category": "stub",
      "module": "M28",
      "title": "CodeSystem read and ValueSet read are 404 not-supported stubs and ValueSet/$expand returns an empty expansion for any ValueSet",
      "evidence": [
        "fhir-r4.routes.ts:679-696 and 789-808 return 404 'not served in Phase 1'",
        "fhir-r4.routes.ts:813-828 returns {resourceType:'ValueSet', expansion:{total:0, contains:[]}} without consulting M38, which the file's own R13 comment calls a wrong answer rather than a stub"
      ],
      "verified": false,
      "recommended_fix": "Implement $expand via the M38 TerminologyProvider or answer not-supported (404/501 OperationOutcome) instead of an empty set.",
      "verification": "GET a known ValueSet/$expand and expect members.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-155",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M28/M29 Interfaces",
      "title": "FHIR client management and external-interface feed/credential operations (68 operations) have no UI; screen specs are deferred",
      "evidence": [
        "35 of 35 M28 and 33 of 33 M29 operations uncalled, incl. POST /fhir/clients/{id}/approve|revoke|credentials/rotate, /api/admin/external-interfaces/feeds[/{id}/activate|credentials|health]",
        "SCREEN_SPEC_STATUS marks all three deferred with reason ('API/ops-only', 'read from the database / ops tooling'), so documented, but the spec corpus still describes staff screens"
      ],
      "verified": false,
      "recommended_fix": "Accept as documented deferral with an owner decision, or schedule screens.",
      "verification": "openapi diff; SCREEN_SPEC_STATUS rows.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-156",
      "severity": "P2",
      "category": "stub",
      "module": "M29",
      "title": "POST /messages/inbound/:id/decrypt is a hard-coded 501 although the DEK-backed InboundCipher already exists",
      "evidence": [
        "routes/message.routes.ts:65-86 always throws M29StoreError('...unbound in Phase 1') (routes/store.ts:479-484 default status 501)",
        "inbound/inbound-crypto.ts:42-70 createInboundCipher(...).decrypt is implemented and bound at apps/backend/src/index.ts:5137 and 8325"
      ],
      "verified": false,
      "recommended_fix": "Decrypt via the cipher, write the M4 disclosure-accounting event, and add the 1/5s per-actor rate limit.",
      "verification": "Call decrypt with step-up on a stored message; expect plaintext + a phi_disclosure audit row.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-157",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M29",
      "title": "Partial-field proposal accept (W-XI-03) is unreachable: the accept route/store never pass appliedFields and PARTIALLY_APPLIED is never set",
      "evidence": [
        "routes/m29-typebox.ts:191-195 AcceptProposalBody has only decisionNote and acceptedAggregateId",
        "routes/store-drizzle.ts:673-679 decideProposal is called without appliedFields although proposals/decision.ts:37,175 and 05-patient/outbox-consumers/m29-proposal-accepted.ts:61-113 support it",
        "grep PARTIALLY_APPLIED outside enums: no writer"
      ],
      "verified": false,
      "recommended_fix": "Accept an appliedFields list in the body, pass it to decideProposal, set status partially_applied when a strict subset is accepted.",
      "verification": "Accept a PATIENT_UPDATE with only address fields and assert the M5 patch excludes coverage fields.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-158",
      "severity": "P2",
      "category": "stub",
      "module": "M29",
      "title": "M29 data eraser is still the Phase-0 deny-stub (no destruction path for HL7 payloads, lab observations or proposals)",
      "evidence": [
        "apps/backend/src/bootstrap/erasers/registry.ts:218-227 comment: 'the Phase-0 deny-stub stands until a later M29 task binds the REAL eraser'",
        "grep registerEraser / className 'external_interfaces' under apps/backend/src/modules/29-external-interfaces: none (M26, M27, M28, M30 each have erasers/)"
      ],
      "verified": false,
      "recommended_fix": "Implement and register the external_interfaces eraser per the 3.7 table.",
      "verification": "Run a destruction certificate for an org with HL7 messages and lab_observation rows.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-159",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M3/M2 Authorization and Identity (web)",
      "title": "Break-glass request/co-sign/revoke, auditor engagement management, per-member elevated approvals and step-up overrides have no UI",
      "evidence": [
        "grep of apps/web/src, apps/admin/src, apps/portal/src for 'engagements', 'elevated-approvals', 'step-up-overrides' returns 0 non-test hits; 'break-glass' appears only in CSS/comments (apps/web/src/index.css:91, 16-bereavement/plan-history.tsx:14,117)",
        "No caller: GET/POST /breakglass, POST /breakglass/{id}/cosign|revoke, POST /engagements, PATCH /engagements/{id}, POST /engagements/{id}/auditors, GET /engagements/{id}/summary, GET/POST/DELETE /orgs/{id}/members/{mId}/elevated-approvals, GET/POST/DELETE /orgs/{id}/step-up-overrides, device attestation routes",
        "Auditor sessions can be redeemed/enrolled (identity.auditor-redeem/enrolment screens exist) but no screen creates the engagement or invites auditors"
      ],
      "verified": false,
      "recommended_fix": "Add a compliance break-glass review screen and an engagement/auditor management screen, or document API-only operation in the M3 spec and screen status.",
      "verification": "grep across all three SPAs; openapi diff.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-160",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M30",
      "title": "R-48 SRA NIST 800-66r2 export route is not implemented",
      "evidence": [
        "routes/sra.routes.ts:27-30 and :81 state R-48 is intentionally NOT wired ('lands with the M30 export service in P2c')",
        "route list under /api/v1/quality/sra has 8 routes, no /cycles/:id/export"
      ],
      "verified": false,
      "recommended_fix": "Wire the M22 render-handshake export or amend the spec.",
      "verification": "GET /api/v1/quality/sra/cycles/:id/export.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-161",
      "severity": "P2",
      "category": "stub",
      "module": "M30",
      "title": "CAHPS result ingest (R-16) is unreachable: quality.cahps.system is granted to no role and there is no mTLS/service-principal path, so cahps_result_summary is never populated",
      "evidence": [
        "routes/cahps.routes.ts:190-200 gates R-16 on CAHPS_SYSTEM only",
        "permission-keys.ts:57,74 comment 'bound to the vendor adapter's mTLS service account at boot' but grep quality.cahps.system finds no role grant (packages/auth/src/roles/templates.ts has no quality entries) and no service-principal handling in packages/auth (grep actorKind: none)",
        "bootstrap/plugins/authenticate.ts:126-134 the system credential sets userId 'system' with no membership/roles, so requirePermission would deny",
        "write-service-drizzle.ts:942 is the only cahps_result_summary writer"
      ],
      "verified": false,
      "recommended_fix": "Add a vendor service-principal auth path that holds the key, or ingest from the adapter pipeline internally.",
      "verification": "Call R-16 with the platform system credential or any seeded role; expect 200 and a cahps_result_summary row.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-162",
      "severity": "P2",
      "category": "seam",
      "module": "M30/M6/M8/M12",
      "title": "Per-provider-entity measure rows are computed from org-wide inputs, so each PE of a multi-PE org carries the same org aggregate",
      "evidence": [
        "The recompute grain is per PE (m30-jobs.ts:2113-2121 fan-out; value rows keyed by providerEntityId), but the readers take only organizationId: packages/types/src/admission.ts:517-522 DeathDischargeReader.listDeathDischargesInPeriod(organizationId, period); SignedEncountersReader.signedEncountersForPatientSince (drizzle-store.ts:227); HopeOrgRollupProvider (index.ts:5922-5936); LevelOfCarePeriodReader; DischargeReader.",
        "m30-jobs.ts:909-912 admits it for cost_report_filing_compliance ('the value is repeated per PE row').",
        "docs/modules/WARDENX_MODULE_30_HQRP_QUALITY_SPEC_v0_5.md:184 (per-PE measure aggregation via ProviderEntityReader)."
      ],
      "verified": false,
      "recommended_fix": "Add a providerEntityId filter to the org-level readers, or compute org-level measures once per org and write one row.",
      "verification": "Create two provider entities in one org with patients on each. Run the HVLDL recompute and compare the two quality_measure_value rows; today they are identical.",
      "prior_gap_ids": [
        "GAP-154"
      ]
    },
    {
      "id": "GAP-163",
      "severity": "P2",
      "category": "stub",
      "module": "M31",
      "title": "Vendor webhooks verify then discard the body; signature is computed over re-serialised JSON, not the raw bytes; room_ended / recording_* never processed",
      "evidence": [
        "apps/backend/src/modules/31-portal/routes/telehealth.routes.ts:434-440 raw = JSON.stringify(request.body) and verifyWebhookSignature(headers, raw), then a bare 200 {received:true}",
        "No raw-body parser covers /api/v1/telehealth/webhooks/* (parsers only in 12-dosespot webhook-route.ts:46, 36-messaging webhook-mount.ts:84, 31 write.routes.ts:303 for upload types)",
        "apps/backend/src/modules/31-portal/routes/store.ts:93-95 recording_completed not mapped by the webhook route",
        "docs/history/m31-portal-deferrals.md:163 the webhook route verifies the signature and drops the body",
        "Mitigating: telehealth.routes.ts:49-51 default adapter verifyWebhookSignature returns false, and index.ts:~4847 leaves the real vendor adapter unwired, so the route currently always 401s (latent, not live)"
      ],
      "verified": true,
      "recommended_fix": "Capture the raw body for the two webhook paths (parseAs string), verify the HMAC over it, map room_ended / recording_started / recording_completed onto telehealth_visit lifecycle + the m31.telehealth.* events, and build the recording finalize step.",
      "verification": "POST a correctly signed Daily.co room_ended payload to /api/v1/telehealth/webhooks/daily-co with an adapter bound; assert telehealth_visit.lifecycle_state becomes ended_* and m31.telehealth.visit_ended is emitted (today: 200 and no change, or 401 on signature mismatch).",
      "prior_gap_ids": [
        "GAP-159"
      ]
    },
    {
      "id": "GAP-164",
      "severity": "P2",
      "category": "security",
      "module": "M31",
      "title": "Compliance 'halt-recording' only flips the DB flag; the vendor recording keeps running and vendorRecordingId is kept",
      "evidence": [
        "apps/backend/src/modules/31-portal/routes/admin.routes.ts:329-345 handler calls only store.updateTelehealthLifecycle({recordingEnabled:false,recordingRequested:false}); no adapter.stopRecording, vendorRecordingId not cleared, and no existence check on :id",
        "contrast apps/backend/src/modules/31-portal/routes/telehealth.routes.ts:333-368 stop-recording which does call adapter.stopRecording"
      ],
      "verified": false,
      "recommended_fix": "Reuse the stop-recording vendor path (openRoomValue + adapter.stopRecording) in halt-recording; 404 when the visit is absent.",
      "verification": "With an adapter bound and an active recording, POST halt-recording and assert the vendor stopRecording call was made; today none.",
      "prior_gap_ids": [
        "GAP-095"
      ]
    },
    {
      "id": "GAP-165",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M31",
      "title": "suspend/reinstate apply unconditionally to any account status (reinstate can activate an invited or revoked account; revoked rows hit a CHECK and 500)",
      "evidence": [
        "apps/backend/src/modules/31-portal/routes/store.ts:554-593 suspendAccount/reinstateAccount UPDATE ... WHERE id = $1 with no status guard",
        "packages/db/migrations/0138_portal_m31_tables.sql:62 CHECK portal_account_revoked_terminal (revoked_at IS NULL OR status='revoked') makes reinstating a revoked row a constraint error (500) rather than a 409",
        "apps/backend/src/modules/31-portal/routes/admin.routes.ts:174-216 ok:false/status:'not_found' returned with HTTP 200 for a missing account"
      ],
      "verified": false,
      "recommended_fix": "Guard transitions in the UPDATE (suspend only from active/bereaved, reinstate only from suspended) and return 404/409.",
      "verification": "POST /admin/portal-accounts/<invited account>/reinstate: today the account becomes status=active without ever accepting the invitation.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-166",
      "severity": "P2",
      "category": "security",
      "module": "M31",
      "title": "Post-discharge read-only gate fails open on any M6 error",
      "evidence": [
        "apps/backend/src/modules/31-portal/routes/write.routes.ts:166-178 dischargedReadOnly() catch { return false } with comment 'Fail-OPEN (false) so an M6 outage does not silently disable every write'; used for caregiver attestation (line 223), upload begin (272) and amendment (399)"
      ],
      "verified": true,
      "recommended_fix": "Fail closed (503) for writes when the discharge state cannot be read.",
      "verification": "Stub AdmissionStatusReader.isDischargedReadOnly to throw; POST /portal/administrations/caregiver-attested for a discharged patient: today proceeds.",
      "prior_gap_ids": [
        "GAP-159"
      ]
    },
    {
      "id": "GAP-167",
      "severity": "P2",
      "category": "seam",
      "module": "M31",
      "title": "All 22 m31.* events are record-only (declaredConsumers empty): grant revoke/suspend/revoke never remove the caregiver from the M36 channel, revoke M22 shares or M2 sessions",
      "evidence": [
        "apps/backend/src/modules/31-portal/events-by-m31.ts: every entry has declaredConsumers: [] (e.g. lines 38-65)",
        "apps/backend/src/modules/36-messaging/outbox-consumers/channel-membership-sync.ts has no portal_access_grant handling (grep portal_access_grant in 36-messaging: none)"
      ],
      "verified": false,
      "recommended_fix": "Bind the spec'd consumers (at minimum M36 membership removal and M2 session revocation) or record an explicit architecture decision.",
      "verification": "Revoke a grant and query M36 channel membership for the caregiver user: still a member.",
      "prior_gap_ids": [
        "GAP-159"
      ]
    },
    {
      "id": "GAP-168",
      "severity": "P2",
      "category": "coverage",
      "module": "M31",
      "title": "Single-resource PHI reads declare auditRead without resourceIdParam: the read audit insert fails and is swallowed (no disclosure trail)",
      "evidence": [
        "apps/backend/src/modules/31-portal/routes/session.routes.ts:116 and :143 (sessions/current, sessions/patients - returns patient display names) config auditRead {resourceKind:'portal_session'} only",
        "apps/backend/src/modules/31-portal/routes/admin.routes.ts:320 GET /admin/telehealth/visits/:id auditRead {list:false} with no resourceIdParam, response carries patientId but no patientIdPayloadPath",
        "apps/backend/src/bootstrap/plugins/read-audit.ts:201-206 resourceId = params[resourceIdParam] ?? patientId ?? '' ; audit_event.resource_id is uuid (migration 0000:127) so '' fails the cast; read-audit.ts:244-246 swallows the error"
      ],
      "verified": false,
      "recommended_fix": "Add resourceIdParam/patientIdPayloadPath to these routes and add a live assertion that the read event lands.",
      "verification": "Call GET /api/v1/portal/sessions/patients then query audit_event for portal_session.viewed: no row.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-169",
      "severity": "P2",
      "category": "coverage",
      "module": "M31",
      "title": "Live RLS isolation suite omits three owned tables: portal_invitation, portal_document_upload, portal_notification_preference",
      "evidence": [
        "architecture/module-manifest.ts:1046-1053 ownedTables lists six tables",
        "packages/db/migrations/__tests__/m31-rls-isolation.live.test.ts references only portal_account, portal_access_grant, telehealth_visit (grep for the other three: no matches in any *.live.test.ts as a cross-tenant assertion)",
        "migrations 0422, 0423, 0424 created the three tables later"
      ],
      "verified": false,
      "recommended_fix": "Extend m31-rls-isolation.live.test.ts with cross-tenant SELECT/INSERT denial for the three tables as wardenx_app.",
      "verification": "grep -L portal_invitation packages/db/migrations/__tests__/*rls*.live.test.ts",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-170",
      "severity": "P2",
      "category": "stub",
      "module": "M31",
      "title": "Telehealth recording lifecycle unbuilt: no telehealth_recording row, no recording-finalize/byte pull, recording_completed never emitted; four further spec queues missing with a stale justification",
      "evidence": [
        "apps/backend/src/modules/31-portal/jobs/queues.ts:10-24 only post-discharge-grace and late-join-watchdog crons are defined; wired at apps/backend/src/index.ts:6531-6571",
        "docs/history/m31-portal-deferrals.md GAP-159 section closes invite-expiry and upload-intake as 'no portal_invitation table / no portal_document_upload table', but migrations 0424_m31_portal_invitation.sql and 0423_m31_portal_document_upload.sql now create them and the manifest owns them (architecture/module-manifest.ts:1046-1053)",
        "apps/backend/src/modules/31-portal/provisioning/invitations.ts:98-106 expiry is only derived at read time; no sweep marks/revokes expired invitations"
      ],
      "verified": false,
      "recommended_fix": "Build the invite-expiry sweep and recording-finalize path (or amend the spec); correct the stale deferral text.",
      "verification": "grep -rn 'invite-expiry\\|recording-finalize' apps/backend/src: no worker.",
      "prior_gap_ids": [
        "GAP-159"
      ]
    },
    {
      "id": "GAP-171",
      "severity": "P2",
      "category": "stub",
      "module": "M32",
      "title": "Five of seven spec 4.8 queues have no worker or producer (drift sweeps, evaluations, async invocations, embeddings index, kill-switch broadcast)",
      "evidence": [
        "apps/backend/src/modules/32-ai-platform/jobs/ contains only token-ledger-rollup.ts and triage-followup-worker.ts",
        "apps/backend/src/index.ts:6071-6127 constructs only the triage-followup and token-rollup workers",
        "apps/backend/src/modules/32-ai-platform/routes/safety-ops.routes.ts:181-200 R31 reads drift from ai_evaluation_run stage=drift_response, which nothing ever writes"
      ],
      "verified": false,
      "recommended_fix": "Build the drift-sweep and evaluation workers (and kill-switch broadcast) or document deferral against ai.full.",
      "verification": "grep -rn 'drift-sweeps' apps/backend/src: none.",
      "prior_gap_ids": [
        "GAP-161"
      ]
    },
    {
      "id": "GAP-172",
      "severity": "P2",
      "category": "stub",
      "module": "M32",
      "title": "Evaluation runs can never leave 'pending' (transitionAiEvaluationRun has no caller), so D10 stage-3 evidence cannot be produced; R26 stores client-supplied mlflowRunId/summaryMetrics",
      "evidence": [
        "apps/backend/src/modules/32-ai-platform/safety/service.ts:473 export transitionAiEvaluationRun - grep over apps/backend/src finds no non-test caller",
        "apps/backend/src/modules/32-ai-platform/routes/safety-ops.routes.ts:79-96 R26 inserts a run from body {mlflowRunId, datasetVersionRef, summaryMetrics} and returns 201",
        "safety/store-drizzle.ts:481 inserts status 'pending'; applyTransition (:517) only reachable through the unused service function"
      ],
      "verified": false,
      "recommended_fix": "Add the ai:evaluations worker (or a guarded result-recording route) that applies transitions; do not accept caller-supplied summary metrics as evidence.",
      "verification": "Queue a run via R26 and poll R28 indefinitely: status stays pending.",
      "prior_gap_ids": [
        "GAP-161"
      ]
    },
    {
      "id": "GAP-173",
      "severity": "P2",
      "category": "stub",
      "module": "M32",
      "title": "Fail-closed unbound ports make R10 (cloud opt-in) and R18 (hallucination report) unusable in production",
      "evidence": [
        "apps/backend/src/index.ts:5049 evidence: createDenyingAiOptInEvidenceResolver() (answers baaResolved=false for every question, governance/service.ts:96-105)",
        "apps/backend/src/index.ts:5077 cipher: null => R18 refuses 503 AI_REPORT_CIPHER_UNBOUND, although getTenantKeyProvider() is bound for M31 at index.ts:4869-4883"
      ],
      "verified": false,
      "recommended_fix": "Bind a tenant-DEK cipher for R18 and real BAA/ZDR/reviewer resolvers for R10 (or record that ai.full is out of scope).",
      "verification": "POST /api/v1/ai/hallucination-reports: 503.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-174",
      "severity": "P2",
      "category": "security",
      "module": "M33",
      "title": "Drilldown consent narrowing trusts a client-supplied patientIds cohort; omitting it yields an un-narrowed URL",
      "evidence": [
        "apps/backend/src/modules/33-reporting/routes/drilldown.routes.ts:68-80 patientIds taken from body",
        "packages/reporting/src/drilldown/consent-narrowing.ts:107-109 patientIds.length === 0 => evaluation {isNarrowed:false}, URL returned unchanged",
        "export-drilldown-service.ts:464-478 patientIds: input.patientIds ?? []"
      ],
      "verified": false,
      "recommended_fix": "Derive the cohort server-side from the tile/dimension context (or from the actor's reportable_scope) rather than the request body.",
      "verification": "POST drilldown/emit with and without patientIds for a consent-restricted patient and compare isConsentNarrowed.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-175",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M33 Reporting (web)",
      "title": "Reporting UI has no report definitions, saved views, sharing or PDF/XLSX/CSV export",
      "evidence": [
        "apps/web/src/modules/33-reporting/screens.ts registers only reporting.catalog, .dashboard, .role-dashboard, .schedules, .admin (lines 31-64)",
        "Module calls only GET bases/dashboards/tiles/schedules/runs/admin/lag/admin/mvs and POST mvs refresh/suspend, drilldown/emit",
        "No caller for 17 of 22 mutating M33 ops: POST/GET /reporting/definitions[/{id}/versions|archive|publish], POST/PATCH /reporting/views[/{id}/share|archive|set-org-default|export.csv|export.pdf|export.xlsx], POST /reporting/drilldown/bulk_export, POST /reporting/schedules/{id}/delete_all_runs",
        "SCREEN_SPEC_STATUS marks WARDENX_UI_REPORTING_ANALYTICS.md 'built' with no caveat"
      ],
      "verified": false,
      "recommended_fix": "Build definition builder, saved-view CRUD/share and export actions, or downgrade status to partial.",
      "verification": "openapi-vs-frontend diff; grep of reporting module for client calls.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-176",
      "severity": "P2",
      "category": "seam",
      "module": "M33/M26/M30",
      "title": "M33 has no data substrate or consumer for M26 or M30: only three MVs exist and the published MetricsProvider is read by no module",
      "evidence": [
        "`grep -h 'CREATE MATERIALIZED VIEW' packages/db/migrations/*.sql` returns only report_mv.mv_census_org_daily, mv_encounter_productivity_membership_day and mv_evv_compliance_org_week (0060_reporting_mv.sql).",
        "getSeam(\"MetricsProvider\") has no caller outside its registration (apps/backend/src/modules/33-reporting/wiring.ts:297).",
        "grep for quality_measure or m30 in apps/backend/src/modules/33-reporting finds no dataset; the M33 outbox-consumers directory holds only m22-document-rendered.ts.",
        "docs/modules/WARDENX_MODULE_33_REPORTING_SPEC_v0_2.md consumed-seam table :914 (M26 Cap Watch) and the M30 HQRP-tiles line."
      ],
      "verified": true,
      "recommended_fix": "Add MVs and catalog bases for cap and quality, or record the Cap Watch and HQRP tiles as unbuilt in the spec and status matrix. Wire M30/M34/M37 embeds to MetricsProvider or retire it.",
      "verification": "List report_mv.* relations and the active base catalog for an org.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-177",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M34",
      "title": "DSAR job routes (fulfill/extend/deny/download) cannot use the caseload arm: ABAC target carries only the job :id, so only org_admin passes",
      "evidence": [
        "apps/backend/src/modules/34-saas-tenant-platform/routes/tenant/dsar-export-jobs.ts:46-62 ABAC_JOB/EXTEND/DENY/DOWNLOAD use requireAbac with no getTarget (target = route params {id})",
        "apps/backend/src/modules/34-saas-tenant-platform/abac-predicates.ts:178-188 predicate reads target.patientId, absent => false for any non-org_admin"
      ],
      "verified": false,
      "recommended_fix": "Resolve the job's patient server-side (getTarget loading dsar_export_job.patient_id) before the predicate.",
      "verification": "As a clinician in the patient's caseload, GET /tenant/dsar-export-jobs/:id/download: 403 although the same user could POST the request.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-178",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M34",
      "title": "Support-consent grant issuance does not enforce 'grantor must be compliance_officer' (comment claims the service asserts it)",
      "evidence": [
        "apps/backend/src/modules/34-saas-tenant-platform/routes/tenant/support-consent-grants.ts:50-52 comment says the route service asserts the role; route passes only membershipId (:60-66)",
        "routes/tenant/service-drizzle.ts:100-126 issueConsentGrant has no role check; permission-keys.ts:171-176 abac:'none'"
      ],
      "verified": false,
      "recommended_fix": "Add a requireAbac role predicate (compliance_officer) or an in-service check.",
      "verification": "Issue a grant with a user holding support_consent_grant.issue but not the compliance_officer role.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-179",
      "severity": "P2",
      "category": "seam",
      "module": "M34/M27/M39/M25/M1",
      "title": "Catalogued events never emitted: m34.tenant.dek_rotation_due, m27.snapshot.integrity_failure, m39.consent.renewal_cycle_opened, m39.consent.dpoa.agent_appointed/agent_removed, m25.remittance.parsed, m1.feature_flag.updated",
      "evidence": [
        "apps/backend/src/modules/34-saas-tenant-platform/events-by-m34.ts:232 dek_rotation_due (M36 alert to 'platform security owner'); only dek_rotation_completed is emitted (jobs/saas-jobs.ts:503); no rotation-cadence sweep emits _due",
        "apps/backend/src/modules/27-cost-report/events-by-m27.ts:474 integrity_failure (critical, seamConsumers m36): no emit site in apps/backend/src/modules/27-cost-report or packages",
        "apps/backend/src/modules/39-consent/events-by-m39.ts:158,232,259: no emit site; alerts-by-m39.ts:51 uses a different name 'm39.consent.dpoa_agent_appointed'",
        "apps/backend/src/modules/25-remittance/events-by-m25.ts:66 and packages/shared/src/outbox-events/events-by-m1.ts:32: single occurrence each",
        "scripts/check-outbox-bindings.ts proves binding<->catalog agreement only, not emit<->catalog (its header line ~80 'does not prove the composition root...')"
      ],
      "verified": true,
      "recommended_fix": "Add an emit-site coverage gate (catalog -> at least one non-test publish reference, allowlist with reason), then emit or remove each event. For dek_rotation_due and snapshot integrity_failure, implement the producer since they are security-relevant alerts.",
      "verification": "Same scan as prior finding; each name grep -F across apps/packages/scripts excluding tests and dist showed catalog-only hits.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-180",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M34/M35 Platform admin (admin app)",
      "title": "Platform ops cannot create/revoke tenant invitations, offboard a tenant, elevate a support session, approve oversized exports, fulfil DSAR, revoke promos or cancel/resume subscriptions from any SPA",
      "evidence": [
        "No caller: GET/POST/DELETE /platform/tenant-invitations, POST /platform/tenants/{orgSlug}/offboard, POST /platform/support-sessions/{id}/elevate, POST /platform/tenant-export-jobs/{id}/approve-oversized, POST /tenant/dsar-export-jobs/{id}/fulfill|deny|extend (partly), GET /tenant/account downloads, POST /api/admin/subscriptions/{id}/revoke_promo, POST /api/v1/subscription/cancel|resume, POST /api/admin/subscriptions/{id}/cancel|resume",
        "apps/admin/src/modules/34-saas-platform/screens.ts registers 10 screens (tenants, overview, support-sessions, dsar-queue, export-queue, onboarding-templates, feature-flags, baa, signups, key-rings) and none covers tenant invitations or offboarding"
      ],
      "verified": false,
      "recommended_fix": "Add the missing platform actions or document them as API-only; update the onboarding spec status.",
      "verification": "openapi diff for 34-saas-tenant-platform and 35-subscription tags.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-181",
      "severity": "P2",
      "category": "seam",
      "module": "M35",
      "title": "All six M35 published seams remain deny-stubs (documented dormant, GAP-208); usage_event has no production writer, so usage metering is never populated",
      "evidence": [
        "apps/backend/src/bootstrap/seams/registry.ts:625-660: the comment says the six are DORMANT with no live impl and no getSeam consumer; each entry has only denyStub",
        "grep of apps/ and packages/ (excluding dist, tests) finds no registerSeam or getSeam use of the six keys; only packages/types/src/seams.ts types and comments in modules/32-ai-platform/events-by-m32.ts:140,198",
        "apps/backend/src/modules/35-subscription/routes/service-drizzle.ts:363,548,594: usage_period_aggregate is only read; no code inserts into usage_event or usage_period_aggregate outside migrations and schema",
        "Evidence correction: providers.ts:1851 refers to onboardingStatusProviderDenyStub (an M34-owned seam M35 consumes), not BillingStatusProvider",
        "Prior gap match: GAP-208 (still open)"
      ],
      "verified": true,
      "recommended_fix": "Register Drizzle-backed implementations at boot and bind UsageMeteringIngest callers (M32/M13 etc.).",
      "verification": "getSeam('BillingStatusProvider').statusForOrg(org) throws NotImplementedError on a DB boot.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-182",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M35",
      "title": "Tenant promo self-apply has no 'publicly-visible' restriction: any tenant can redeem any active platform promo code",
      "evidence": [
        "packages/db/migrations/0140_subscription_billing_m35_enums_platform_tables.sql:93-109 promo_code has no public/visibility column",
        "apps/backend/src/modules/35-subscription/routes/promo-redemption.ts:76-92 only is_active, window and cap are checked",
        "routes/service-drizzle.ts:845-888 applyTenantPromo uses redeemPromoInTx for any code"
      ],
      "verified": false,
      "recommended_fix": "Add a public flag (or allowlist) and require it on the tenant path.",
      "verification": "Create an internal-only promo and POST /api/v1/subscription/apply_promo as a tenant with its code.",
      "prior_gap_ids": [
        "GAP-099"
      ]
    },
    {
      "id": "GAP-183",
      "severity": "P2",
      "category": "stub",
      "module": "M36",
      "title": "on_call, bereavement, discipline and location channels are never created or synced (501 NOT_IMPLEMENTED); only care_team and announcement exist",
      "evidence": [
        "apps/backend/src/modules/36-messaging/messaging-provider-db.ts:69-74 notWired throws WardenXError NOT_IMPLEMENTED 501",
        "messaging-provider-db.ts:82 openChannel('bereavement') -> notWired; lines 303-308 syncOnCallChannel/syncBereavementChannel -> notWired",
        "grep -rn 'syncOnCallChannel\\|syncBereavementChannel\\|openBereavementChannel' apps packages: no caller outside the provider",
        "no discipline/location sync code exists (spec \u00a73.1 lists discipline-sync.ts and location-sync.ts)",
        "spec lines 330-335, 420-422"
      ],
      "verified": false,
      "recommended_fix": "Implement the M19 on-call shift and M16 bereavement-plan consumers plus discipline/location auto-membership, or amend the spec to defer them; make the 501 an explicit phase deferral in the spec.",
      "verification": "sed -n 60,90p and 300-310 of messaging-provider-db.ts",
      "prior_gap_ids": [
        "GAP-104"
      ]
    },
    {
      "id": "GAP-184",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M36",
      "title": "Message attachments are accepted by the route (201) but silently dropped; message_attachment has no writer",
      "evidence": [
        "apps/backend/src/modules/36-messaging/routes/messaging-routes.ts:151 passes attachments to service.sendMessage",
        "messaging-route-service-db.ts sendMessage (approx. line 483-490) and messaging-write-core.ts:88-125 insertEncryptedMessage take no attachments argument",
        "grep -rn 'message_attachment\\|messageAttachment' apps/backend/src packages/messaging/src shows only the eraser reference",
        "spec \u00a74.2 201 contract and manifest ownedTables include message_attachment"
      ],
      "verified": false,
      "recommended_fix": "Persist message_attachment rows (documentRef, mime, size, filename) in the same tx, validate documentRef org ownership, or reject attachments with 422 until built.",
      "verification": "grep -rn -i messageAttachment apps/backend/src packages/messaging/src",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-185",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M36",
      "title": "Message edit window (default 5 min) is not enforced; edit/delete also skip channel membership and archive checks",
      "evidence": [
        "messaging-route-service-db.ts:491-520 editMessage checks only author and status, never created_at vs a window",
        "grep -rniE 'EDIT_WINDOW|editWindow' apps/backend/src packages/messaging/src returns nothing",
        "routes/messaging-routes.ts:157-170 PATCH/DELETE messages/:id use only requirePermission(messaging.send), no channel_visibility",
        "spec line 357 'author edits within edit window (default 5 min)' and line 1542"
      ],
      "verified": false,
      "recommended_fix": "Reject edits older than the window (410/409 EDIT_WINDOW_CLOSED) and require current channel visibility and non-archived state on edit/delete.",
      "verification": "read editMessage and grep EDIT_WINDOW",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-186",
      "severity": "P2",
      "category": "security",
      "module": "M36",
      "title": "Alert-rule overrides are written with an empty audit actor (userId '')",
      "evidence": [
        "routes/messaging-routes.ts:378 service.patchAlertRule(organizationId, { ruleId, patch }) passes no user",
        "messaging-route-service-db.ts:1133 withOrgContext(db, { organizationId: orgId, userId: '' }, ...) for the insert/update of alert_rule",
        "packages/audit/src/triggers/generate.ts:155 actor_user_id = NULLIF(current_setting('app.user_id', true), '')::uuid, so the audit row has NULL actor"
      ],
      "verified": false,
      "recommended_fix": "Thread request.context.userId into patchAlertRule and use it in withOrgContext (and in an updated_by column).",
      "verification": "read lines 370-380 of messaging-routes.ts and 1126-1134 of the route service",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-187",
      "severity": "P2",
      "category": "stub",
      "module": "M36",
      "title": "Only 4 of the 12 spec'd M36 queues have workers; hash_verify, retention_scan, endpoint_health, bereavement_close and channel_sync are never built",
      "evidence": [
        "packages/messaging/src/jobs/queues.ts:40-53 lists twelve MESSAGING_QUEUES",
        "apps/backend/src/modules/36-messaging/delivery/delivery-workers.ts:17-20 builds only send_push/sms/voice/email",
        "grep -rn 'hashVerify\\|hash_verify' apps/backend/src (non-test) finds only a comment in index.ts:14",
        "spec \u00a74.4 and \u00a78.1 m36.integrity.hash_mismatch / m36.hash_verify.run"
      ],
      "verified": true,
      "recommended_fix": "Build and schedule the hash_verify and retention_scan workers (with per-org enumerator and legal-hold filter) and endpoint_health; or record the deferral in the spec.",
      "verification": "grep -rn MESSAGING_QUEUES apps/backend/src",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-188",
      "severity": "P2",
      "category": "security",
      "module": "M36",
      "title": "M36 message history (including per-patient care-team channels) is read with no read-audit declaration and outside the coverage gate",
      "evidence": [
        "apps/backend/src/modules/36-messaging/routes/messaging-routes.ts:153,159,170 - GET /api/v1/messaging/channels, /channels/:id, /channels/:id/messages have no config.auditRead; no auditPhiRead/auditListRead anywhere in the module.",
        "apps/backend/src/bootstrap/index.ts:120-262 - '/api/v1/messaging' and '/api/v1/alerts' are not in DEFAULT_READ_AUDIT_PREFIXES.",
        "apps/backend/src/modules/31-portal/routes/read.routes.ts (MessagingArm.syncCareTeamChannel(orgId, patientId)) and M5 patient creation auto-create a per-patient care-team channel, so message bodies are patient-linked."
      ],
      "verified": false,
      "recommended_fix": "Declare auditRead (list/ resourceKind message_channel, patientId from channel subject) on the three reads and add '/api/v1/messaging', '/api/v1/alerts' to the governed prefixes, or add a justified { none } waiver if bodies are proven PHI-free.",
      "verification": "Boot test fails on an undeclared GET under /api/v1/messaging; inject test shows an audit row per message page read.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-189",
      "severity": "P2",
      "category": "stub",
      "module": "M36 Messaging / Notifications (web)",
      "title": "Notifications & Tasks 'Tasks' and 'Mentions' tabs are placeholders and no tasks backend exists; staff DM/announcement/alert-rule/endpoint workflows have no UI",
      "evidence": [
        "apps/web/src/modules/36-messaging/notifications-inbox.tsx:255-259: 'Your task worklist arrives with the Tasks module.' / '@-mentions arrive with the messaging worklist.'; header comment :18-19 'honest placeholders'",
        "docs/api/openapi.json has no task/mention routes (only discharges/worklist, medicaid-validation-worklist, onboarding taskId)",
        "No caller for 15 of 17 mutating M36 ops: POST /messaging/dm, /messaging/announce, POST/DELETE /messaging/channels/{id}/members, PATCH/DELETE /messaging/messages/{id}, POST /messaging/messages/{id}/read, GET/PATCH /alert-rules, GET/PUT /notifications/preferences, POST/DELETE /notifications/endpoints, GET /admin/messaging/alert-deliveries",
        "SCREEN_SPEC_STATUS: WARDENX_UI_NOTIFICATIONS_TASKS.md and STAFF_MESSAGING 'built'"
      ],
      "verified": false,
      "recommended_fix": "Either build tasks (backend + UI) or mark the spec partial; add DM/announce/members and notification-preference screens (also serves USER_PROFILE_PREFERENCES).",
      "verification": "Read notifications-inbox.tsx:240-262; openapi path grep for task/mention.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-190",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M37",
      "title": "Equipment assign skips the RN-coverage gate and trusts client-supplied bedId/patientId",
      "evidence": [
        "apps/backend/src/modules/37-ipu/routes/service-drizzle.ts:2326-2362 assignEquipmentBed only checks inspection currency (assertInspectionCurrent) before writing currentBedId/currentAssignedPatientId from the body",
        "docs/modules/WARDENX_MODULE_37_IPU_SPEC_v0_2.md:220 lists equipment assign among routes that return 412 IPU_RN_COVERAGE_UNAVAILABLE when the hour is uncovered",
        "RN coverage is enforced only in openAdmission/requestBed/initiateTransfer/applyRestraint (service-drizzle.ts:960,1015,1186,1883)",
        "no check that the bed belongs to the unit or that the patient is admitted there"
      ],
      "verified": false,
      "recommended_fix": "Add coverageActiveFor to assignEquipmentBed and validate bed/patient against the active ipu_bed_assignment.",
      "verification": "read service-drizzle.ts:2326-2362",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-191",
      "severity": "P2",
      "category": "security",
      "module": "M37",
      "title": "No per-patient scope or unit-staff check on IPU PHI reads; m37.ipu.staff_member is enforced only on restraint writes and the bed grid",
      "evidence": [
        "apps/backend/src/modules/37-ipu/routes/ipu.routes.ts:193-247, 396-440 (admissions list/detail, restraints, gip-criteria, irc-episodes, visitors) use only P(m37.ipu_admission.read)",
        "requireUnitStaff is called only at service-drizzle.ts:872,1870,1981,2026 (bed grid + restraint apply/reassess/release)",
        "scripts/abac-uncomposed-allowlist.ts:46 records the staff_member predicate as enforced in service only for those paths; no caseload_or_scope anywhere in modules/37-ipu",
        "spec \u00a77.2 'every M37 mutation route composes the relevant predicates'"
      ],
      "verified": false,
      "recommended_fix": "Apply unit-staff/caseload scoping to admission, restraint, body-release and visitor reads and the remaining mutations (assign-bed, discharge, body release, meals), or document role-only access as the decision.",
      "verification": "grep -n requireUnitStaff apps/backend/src/modules/37-ipu/routes/service-drizzle.ts",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-192",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M37 IPU (web)",
      "title": "IPU bed board lacks bed cleaning-status, body release, RN-coverage and break-glass, meals, shifts, equipment inspection/maintenance writes",
      "evidence": [
        "Module calls (grep): visitors, restrictions, restraint, assign-bed, request-bed, gip-criteria, discharge only",
        "No caller: POST /ipu-beds/{id}/cleaning-status, PATCH /ipu-beds/{id}, GET/POST /ipu-body-release/{admissionId}, GET /ipu-units/{id}/rn-coverage, POST /ipu-units/{id}/rn-coverage/break-glass, POST /ipu-meals, GET/POST /ipu-shifts and staff, POST /ipu-equipment/{id}/inspection|maintenance|assign-bed, POST /inpatient-units/{id}/deactivate (13 of 36 mutating ops)",
        "apps/web/src/modules/37-ipu/ipu-api.ts:270 error copy tells users 'A coverage break-glass is the other route' but no UI offers it",
        "docs/design/SCREEN_SPEC_STATUS.md marks IPU_BED_BOARD 'built'; audit/frame-fidelity notes DEATH_PRONOUNCEMENT 'body-release steps have no backing route' although POST /ipu-body-release/{admissionId} exists"
      ],
      "verified": true,
      "recommended_fix": "Add the missing bed/equipment/coverage actions or mark partial; correct the frame-fidelity note.",
      "verification": "grep of client calls in 37-ipu; openapi diff.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-193",
      "severity": "P2",
      "category": "stub",
      "module": "M38",
      "title": "Tenant deprecation remediation scans only M7 problem-list usage; claim lines, orders and other consumers are not producers",
      "evidence": [
        "apps/backend/src/index.ts:7135 `producers: [carePlanCodeUsageProducer(() => getSeam(\"CarePlanReader\"))]` is the only producer",
        "apps/backend/src/modules/38-terminology/jobs/tenant-scan.ts:6 names M7 as 'today' the sole producer",
        "spec \u00a74.3 terminology.tenant_deprecation_scan: 'tenants with consuming records (problem list, claim line, order...)'"
      ],
      "verified": false,
      "recommended_fix": "Register code-usage producers for M23 claim lines, M11 orders and other coded records, or amend the spec to the shipped scope.",
      "verification": "grep -rn 'CodeUsageProducer' apps/backend/src",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-194",
      "severity": "P2",
      "category": "security",
      "module": "M38",
      "title": "Platform-ops cross-tenant admin reads are not audited as audit.elevated_access despite the file header claiming it",
      "evidence": [
        "apps/backend/src/modules/38-terminology/routes/admin-terminology-routes.ts:5-7 states '/api/v1/admin/terminology/* routes are ... audited as audit.elevated_access per M4 \u00a76'",
        "GET /api/v1/admin/terminology/value-set-extensions (line 328) returns every tenant's extensions and reasons via terminology_admin_list_value_set_extensions; no audit call in the route or terminology-ops-store-db.ts (grep -i audit shows only the header comment)",
        "contrast apps/backend/src/modules/36-messaging/routes/admin-alert-deliveries-routes.ts which audits before release; /api/v1/admin/mdm/* also writes no elevated_access event"
      ],
      "verified": false,
      "recommended_fix": "Write an org-less platform audit event (audit_writer_insert_platform_event, as M36 does) for the cross-tenant admin reads in M38 and M40.",
      "verification": "grep -n -i audit apps/backend/src/modules/38-terminology/routes/admin-terminology-routes.ts",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-195",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M38 Terminology (web)",
      "title": "Terminology admin is search-only: no tenant value-set extensions, license attestation, remediation scan, attributions or version/load views",
      "evidence": [
        "terminology-admin.tsx:16,67 only GET /api/v1/terminology/{system}/search; screens.ts:14 single screen terminology.admin; requiredPermission comment at screens.ts:18 admits 'terminology.admin.read ... not built here'",
        "7 of 7 mutating M38 ops uncalled (POST/DELETE /terminology/value-sets/{id}/extensions, POST /admin/terminology/{system}/license-attestation|refresh-embeddings|load, POST /admin/terminology/uploads, revoke attestation) plus GET /terminology/remediation, /attributions, /admin/terminology/versions, /license-attestations, /value-set-extensions",
        "SCREEN_SPEC_STATUS marks WARDENX_UI_TERMINOLOGY_ADMIN.md 'built'"
      ],
      "verified": false,
      "recommended_fix": "Build the extension editor/remediation/licence panels or mark partial.",
      "verification": "Read terminology-admin.tsx; openapi diff.",
      "prior_gap_ids": [
        "GAP-116"
      ]
    },
    {
      "id": "GAP-196",
      "severity": "P2",
      "category": "stub",
      "module": "M39",
      "title": "Four of five typed M39 alert payloads are never emitted (expiration_imminent, dpoa_agent_appointed, recipient_disclosure_attempted_without_consent, renewal_overdue) and have no seeded alert_rule",
      "evidence": [
        "apps/backend/src/modules/39-consent/alerts-by-m39.ts:21,51,65,80 register the payloads",
        "grep for these payloadTypes in apps/backend/src, packages/messaging/src and packages/consent/src finds only the registrations",
        "packages/messaging/src/seed/alert-rules.ts:1079 seeds only m39.consent.revoked_cascade_failed",
        "jobs/expiration.ts:273 emits only the outbox event m39.consent.expiring_soon, which no M36 consumer turns into a staff alert"
      ],
      "verified": false,
      "recommended_fix": "Emit the alerts from the expiration/reminder crons, the DPOA appointment write, the disclosure gate and the renewal-overdue sweep, and seed their rules (consent_management_steward resolver).",
      "verification": "grep -rn 'expiration_imminent\\|renewal_overdue' apps packages --include=*.ts | grep -v test",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-197",
      "severity": "P2",
      "category": "coverage",
      "module": "M39",
      "title": "Consent and retention-window ABAC predicates that specs assign to consumers are registered but composed by no route (media/HIPAA release, research, advance-directive, M22 13-month window, M6 compliance.scope)",
      "evidence": [
        "scripts/abac-uncomposed-allowlist.ts:16-17 (document_within_admission_window: 'no document read route composes it ... Open gap'), :26-36 (family_caregiver_access_active, portal_access_active, media_release_active, research_participation_active, advance_directive_acknowledged, hipaa_release_active: 'no consuming route composes it yet'), :62-63 (compliance.scope: 'Open gap to bind or delete').",
        "bun run arch:abac-composed output: '192 declared - 165 composed by requireAbac - 27 allowlisted' (gate is green only because the list is reasoned).",
        "Spec: docs/modules/WARDENX_MODULE_39_CONSENT_SPEC_v0_3.md:1675-1678 (media_release_active consumed by M22/M33, hipaa_release_active by M5/M22, research_participation_active by M30, advance_directive_acknowledged by M6/M7/M14); docs/modules/WARDENX_MODULE_22_DOCUMENTS_SPEC_v0_5.md:1906,2463 (post-discharge documents readable 13 months, then compliance/QA only)."
      ],
      "verified": false,
      "recommended_fix": "Compose each predicate at the consuming route/service named in the spec (or amend the spec and delete the predicate); enforce the M22 13-month window in the document read guard.",
      "verification": "Inject tests: reading a post-discharge document at discharge+14 months as a care-team member returns 403/404; a records release without an active hipaa_release consent is refused.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-198",
      "severity": "P2",
      "category": "seam",
      "module": "M40",
      "title": "mdm.baa_status_changed (M40 spec \u00a72.6/\u00a78.1) is never emitted by recordBaa; M29 relies on pull-based gate re-evaluation and M11 stuck-order recovery instead of the specified push consumer",
      "evidence": [
        "grep -rn 'baa_status_changed' over apps packages architecture scripts, excluding node_modules and dist: no .ts hits; only docs/modules specs (M40 spec :378 and :1884, M29 spec :2406, T-29.04 task doc)",
        "apps/backend/src/modules/40-mdm/mdm-store-db.ts:416-443 recordBaa upserts mdm_baa_record and emits nothing",
        "apps/backend/src/modules/40-mdm/events-by-m40.ts M40_OUTBOX_EVENTS has only m40.canonical.updated and m40.canonical.deactivated",
        "Counter-evidence: apps/backend/src/modules/29-external-interfaces/outbound/stuck-order-support.ts:23-33 outboundBaaCleared re-evaluates the live BAA gate (F-201), used by M11 stuck-order recovery to retry baa_inactive orders",
        "docs/modules/WARDENX_MODULE_40_MDM_SPEC_v0_4.md:378 and WARDENX_MODULE_29_EXTERNAL_INTERFACES_SPEC_v0_4.md:2406 specify the event and the push requeue"
      ],
      "verified": true,
      "recommended_fix": "Emit m40.mdm.baa_status_changed {orgId,kind,id,oldStatus,newStatus} in the recordBaa transaction (and BAA expiry transitions), add it to M40_OUTBOX_EVENTS with M29 as a declared consumer, and build the M29 requeue consumer.",
      "verification": "grep -rn baa_status_changed apps packages",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-199",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M40",
      "title": "Only 3 of 7 canonical kinds (physician, facility, payer) have tables; pharmacy, referral_source, dme_vendor, funeral_home resolve to null and have no overlay tables",
      "evidence": [
        "apps/backend/src/modules/40-mdm/mdm-store-db.ts:70-72 hasCanonicalTable returns true only for physician|facility|payer; canonicalIdByIdentifier/search return null/[] otherwise",
        "packages/db/migrations/0205_mdm_governance_writer_functions.sql approve_merge raises MERGE_KIND_UNSUPPORTED for the other four kinds",
        "architecture/module-manifest.ts M40 ownedTables list has no pharmacy/dme_vendor/funeral_home/referral_source canonical or any overlay besides external_physician_tenant_overlay",
        "spec lines 36, 140-160, 282, 565 (seven canonical kinds, facility/payer/pharmacy overlays)",
        "routes accept all seven kinds (mdm-typebox KindSchema) and perKind permissions exist"
      ],
      "verified": false,
      "recommended_fix": "Add the four missing canonical tables and the other overlay tables (migration, RLS, manifest .ts/.cjs, live RLS test) or restrict the route KindSchema and spec to the shipped kinds.",
      "verification": "sed -n 60,75p mdm-store-db.ts; grep CREATE TABLE in migrations for pharmacy|dme_vendor|funeral_home|referral_source (none)",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-200",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M40",
      "title": "PATCH overlay is a full replace: omitted fields reset doNotRefer/isPreferred to false and other fields to null",
      "evidence": [
        "apps/backend/src/modules/40-mdm/routes/mdm-routes.ts:162-169 builds the fields with `b.doNotRefer ?? false`, `b.isPreferred ?? false`, `?? null` for the rest",
        "mdm-store-db.ts:361-388 onConflictDoUpdate overwrites every column with those values",
        "OverlayBodySchema (mdm-typebox.ts:65-72) makes every field optional",
        "spec \u00a74.2 'PATCH ... Body PartialOverlay<kind>'"
      ],
      "verified": false,
      "recommended_fix": "Only set the columns present in the body (merge onto the existing overlay) and return the resolved MdmResolved per spec.",
      "verification": "PATCH overlay with only {relationshipNotes} on a row with doNotRefer=true: doNotRefer becomes false (read lines above)",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-201",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M40",
      "title": "Merge approval does not re-point consumer FKs and emits no mdm.merge_executed / provisional_promoted / duplicate_suspected events; refusals surface as raw PG errors",
      "evidence": [
        "packages/db/migrations/0205_mdm_governance_writer_functions.sql:~130-165 approve_merge only flips the duplicate and appends merged_from; no repoint",
        "apps/backend/src/modules/40-mdm/jobs/cron-workers.ts header says the function 'flips the duplicate and re-points in one transaction' and that mdm.repoint_* are 'owned by those modules'; no module implements a repoint (grep -rn 'repoint' shows only M12/M20 unrelated hits)",
        "events-by-m40.ts has only two events; spec \u00a72.6 lists mdm.merge_executed, mdm.provisional_promoted, mdm.duplicate_suspected",
        "mdm-store-db.ts:497-508 approveMerge does not map MERGE_REQUEST_NOT_PENDING / MERGE_SURVIVOR_ALREADY_MERGED to 409/CONFLICTING_MERGE/422 CANONICAL_IS_MERGED (apps/backend/__tests__/gap-060-m40-governance-writes.live.test.ts:193-215 only asserts PG messages); bootstrap has no mapping for these RAISE errors",
        "spec \u00a77.6, \u00a74.2 approve route"
      ],
      "verified": true,
      "recommended_fix": "Add repoint jobs or a documented redirect-only contract, emit the merge/promotion events through the 0186 platform insert, and map the PG exceptions to WardenXError 409/422 per \u00a74.2.",
      "verification": "read 0205 lines 95-165 and cron-workers.ts header",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-202",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M40 MDM (web)",
      "title": "MDM console is a single search box; merge review, golden-record/overlay edit, NPPES sync log, grief resources, BAA/license entry have no UI",
      "evidence": [
        "apps/web/src/modules/40-mdm/mdm-console.tsx:15-16,69 only GET /api/v1/mdm/{kind}/search; screens.ts:12 is the sole screen (mdm.console)",
        "12 of 12 mutating M40 ops and 5 reads have no caller: GET /admin/mdm/merge-requests, POST /admin/mdm/merge-requests/{id}/approve|reject, POST /admin/mdm/nppes/lookup, GET /admin/mdm/nppes/sync-log, POST /admin/mdm/provisional/{id}/promote, GET/POST/PATCH /mdm/grief-resources*, GET/POST /mdm/baa, POST /mdm/license/manual, POST /mdm/{kind}/get-or-create, PATCH /mdm/{kind}/{id}/overlay, GET /mdm/{kind}/{id}/relationships",
        "SCREEN_SPEC_STATUS: WARDENX_UI_MASTER_DATA_MDM.md 'built' (no caveat); MDM_HEALTH_SYNC 'partial' claims a 'sync-health panel lives inside the MDM console' but the console has none"
      ],
      "verified": false,
      "recommended_fix": "Build merge review/overlay/NPPES panels or mark the spec partial; correct the MDM_HEALTH_SYNC note.",
      "verification": "Read mdm-console.tsx and screens.ts; openapi diff.",
      "prior_gap_ids": [
        "GAP-116"
      ]
    },
    {
      "id": "GAP-203",
      "severity": "P2",
      "category": "spec-drift",
      "module": "Staff workflows (cross-module)",
      "title": "Residual staff-facing mutating routes with no caller in any SPA (spec requirement not individually confirmed)",
      "evidence": [
        "M5: POST /patient-matches/{id}/merge|not-a-match, POST /patients/{id}/merge, POST /patient-merges/{id}/unmerge, POST/GET /patients/{id}/caregivers (spec PATIENT_CHART.md:97,108 'Manage caregivers & emergency contacts'), POST /patients/{id}/amendments, POST /amendments/{id}/statement, POST /patients/{id}/deceased|status",
        "M6: POST /cti/{id}/mark-late|sign-attending, POST /discharges/{id}/decline-for-cause, POST /level-of-care/{id}/confirm-bed",
        "M8: POST /encounters/{id}/administrative-override|late-entry-override",
        "M12: POST /medication-orders/{id}/report-error, POST /rx-benefit/lookup, GET /prescribing/named-prescribers",
        "M14: POST/PATCH /idg/recurring-policies (IDG_MEETING.md recurring review)",
        "M17: POST /optimize-day, GET /map-view, GET /metrics/route-efficiency (SCHEDULING_VISIT_CALENDAR.md:41 Map view, :115 Optimize route; apps/web/src/modules/17-scheduling/screens.ts:59 admits polyline not built)",
        "M22: POST /intake/jobs/{id}/extraction/commit, POST /intake/uploads/{id}/discard, GET/PUT /tenant-overlays, GET/POST /admin/form-fills*, POST /documents/{id}/links",
        "M18/M19/M21: POST /evv/check-in, /evv/devices/self-register, /evv/offline-sync, /administrations/offline-sync, POST /triage-calls/{id}/request-summary, POST /supplies/supply-requests/{id}/caregiver-signature|vendor-invoice (mobile/field flows; mobile app deferred)",
        "M23-25: POST /admin/billing/platform-rules, /admin/platform-medicaid-rules, /admin/state-rate-schedule-load, POST /appeals/{id}/submit-late-good-cause, PATCH /taxonomy/overlays/{carc}",
        "M39: POST /consent-types/overlay, GET /consents/{id}/eval-audit, GET /patients/{id}/delegated-access, POST /consents/{id}/document/re-render"
      ],
      "verified": false,
      "recommended_fix": "Triage each against its module spec: build the UI or record API-only intent in SCREEN_SPEC_STATUS.",
      "verification": "python script: every docs/api/openapi.json operation matched against string literals in apps/web/src, apps/admin/src, apps/portal/src, packages/ui/src (template placeholders wildcarded); the only dynamic path builder found is referrals/{id}/${command}, whose used commands were subtracted.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-204",
      "severity": "P2",
      "category": "spec-drift",
      "module": "UI (web)",
      "title": "Frame fidelity: only 3 of 19 mapped screens are matched; 2 pending, 70 frames unmatched",
      "evidence": [
        "audit/frame-fidelity/FRAME_FIDELITY.md: 'By status: 3 matched, 14 partial, 2 pending'",
        "M06 Death and Pronouncement (node:f7o1r) and Discharge/Revocation/Transfer (node:m8VaU) are pending",
        "'102 frames not yet mapped: 25 deferred, 7 design-library, 70 unmatched'",
        "partial rows list unbuilt data (e.g. M13 dose rows lack drug text, M14 packet content, M36 tasks and mentions placeholders)"
      ],
      "verified": false,
      "recommended_fix": "Advisory metric, but relevant given the owner's 'match mockups identically' directive: schedule region-by-region matching for the pending and unmatched frames.",
      "verification": "bun run frame:fidelity shows matched count rising; the report is generated and advisory, so this is not a CI-red condition.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-205",
      "severity": "P2",
      "category": "doc",
      "module": "UI corpus / gates",
      "title": "SCREEN_SPEC_STATUS 'built' is only checked for citing one registered screen set, so read-only/search-only/placeholder surfaces pass as 'built'",
      "evidence": [
        "scripts/check-ui-screens.ts:155-203 only validates status vocabulary, that built/partial rows cite a registered screen set, and that deferred rows have a reason",
        "Rows marked 'built' despite the gaps above: QAPI_INCIDENTS, HQRP_QUALITY, REPORTING_ANALYTICS, MASTER_DATA_MDM, TERMINOLOGY_ADMIN, NOTIFICATIONS_TASKS, STAFF_MESSAGING, IPU_BED_BOARD, CAP_SETTLEMENT, TELEHEALTH_VISIT_ROOM, ORDERS (standing)",
        "audit/ui-parity/UI_PARITY.md:11 still reports only counts (113 documented, 330 registered)"
      ],
      "verified": false,
      "recommended_fix": "Add a per-row action-coverage column (or require a caveat when a built screen set has no write call) and re-grade the rows.",
      "verification": "Read scripts/check-ui-screens.ts and SCREEN_SPEC_STATUS.md.",
      "prior_gap_ids": [
        "GAP-186"
      ]
    },
    {
      "id": "GAP-206",
      "severity": "P2",
      "category": "security",
      "module": "web",
      "title": "PHI-bearing step-up form drafts persisted in sessionStorage and not cleared at sign-out, contradicting the no-PHI-in-browser-storage rule",
      "evidence": [
        "apps/web/src/shell/step-up-redirect.ts:71-77 stashStepUpDraft sets sessionStorage; removals only at :42 (TTL on read), :66 (sweep inside peek), :96 (clearStepUpDraft on submit/cancel); no sign-out clear anywhere in apps/web/src.",
        "apps/web/src/modules/08-encounters/addendum-panel.tsx:333, 13-emar/administration-detail.tsx:128, 17-scheduling/scheduling-workflow.tsx:821, 25-remittance/denial-detail-panel.tsx:177, 17-scheduling/my-visits.tsx:183 stash free-text reasons or narrative.",
        "apps/web/src/modules/23-billing-medicare/write-workflow.ts:12-17 states PHI must never be persisted to browser storage (2026-06-27 remediation).",
        "Mitigations: sessionStorage is tab-scoped; DRAFT_TTL_MS = 15 min (step-up-redirect.ts:18); keys are org/user-scoped."
      ],
      "verified": true,
      "recommended_fix": "Replace the sessionStorage stash with the module-scoped in-memory Map used by write-workflow.ts (survives SPA navigation, dies on reload), or at minimum clear all wx.step-up-draft:* keys on sign-out/session-expiry and exclude free-text clinical fields. Add a lint/arch gate banning sessionStorage/localStorage writes outside an allowlist.",
      "verification": "DOM test: after a STEP_UP_REQUIRED on addendum save, window.sessionStorage contains no wx.step-up-draft entry; after sign-out no keys remain.",
      "prior_gap_ids": [
        "GAP-191"
      ]
    },
    {
      "id": "GAP-207",
      "severity": "P3",
      "category": "build",
      "module": "05-patient, 10-hope (and others)",
      "title": "8 GET routes carry no response schema",
      "evidence": [
        "audit/openapi-coverage/OPENAPI_COVERAGE.md:8 '8/602 GETs carry no response schema'",
        "audit/openapi-coverage/OPENAPI_COVERAGE.md:17 05-patient GET no resp = 4; line 22 10-hope = 1"
      ],
      "verified": false,
      "recommended_fix": "Add response schemas for the 8 GETs so the typed client can express their results.",
      "verification": "openapi-coverage report shows GET no resp = 0",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-208",
      "severity": "P3",
      "category": "build",
      "module": "35-subscription",
      "title": "M35 POST /api/v1/webhooks/stripe (raw-body HMAC webhook) publishes no request schema; counted by the OpenAPI coverage report, benign by design",
      "evidence": [
        "apps/backend/src/modules/35-subscription/routes/webhooks.routes.ts:32-37,43,53 (handler reads the raw body via rawBodyOf and verifies the stripe-signature header)",
        "scripts/openapi/enrichments.ts:2578 (entry has summary only, no body)",
        "scripts/report-openapi-coverage.ts:120 (counts a route when !e.body && handlerReadsBody)",
        "Reproduced with a scratch script that reuses scanRoutes, ROUTE_ENRICHMENTS and extractRouteCall: the only flagged route repo-wide is 35-subscription post /api/v1/webhooks/stripe",
        "audit/openapi-coverage/OPENAPI_COVERAGE.md:8,47 and baseline.json:169-172 (mutatingNoBody: 1)"
      ],
      "verified": true,
      "recommended_fix": "Publish a body schema for the offending M35 route (client:gen currently types its body as never) and re-baseline to 0.",
      "verification": "bun run openapi:coverage shows 0/840; bun run arch:fitness stays green. Specific route not identified by this worker.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-209",
      "severity": "P3",
      "category": "doc",
      "module": "docs/BUSINESS_LOGIC.md, docs/IMPLEMENTATION_ROADMAP.md",
      "title": "Hand-mirrored counts that diverge from generated reports",
      "evidence": [
        "docs/BUSINESS_LOGIC.md:606 'M30 ... 60 routes' vs audit/implementation-status/IMPLEMENTATION_STATUS.md M30 row 61/61 enriched routes",
        "docs/IMPLEMENTATION_ROADMAP.md:60 'applied \u2014 36 packages' vs bun run arch:parity: '49 packages + 4 apps map 1:1 to manifest codePaths' (ADR-0028 count 36 was point-in-time, ADR README row 53 says '36 pkgs')",
        "CLAUDE.md itself says not to restate counts"
      ],
      "verified": false,
      "recommended_fix": "Remove or point to the generated report; mark ADR-0028 count as at-time-of-ADR.",
      "verification": "bun run arch:parity; bun run status:matrix",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-210",
      "severity": "P3",
      "category": "doc",
      "module": "docs/cartography",
      "title": "Cartography docs cite files that do not exist",
      "evidence": [
        "docs/cartography/audit_encounters_visits.md:748,762 cite apps/backend/src/modules/17-scheduling/service.ts and 08-encounters/service.ts (neither exists; ls shows no service.ts)",
        "docs/cartography/hope_report.md:190,383 cite apps/web/src/shared/entity-lookups.tsx (apps/web/src/shared does not exist; arch:boundaries violations cited as 'known' are likely stale)"
      ],
      "verified": true,
      "recommended_fix": "Date-stamp these as historical snapshots or fix the paths.",
      "verification": "ls the cited paths",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-211",
      "severity": "P3",
      "category": "doc",
      "module": "docs/history",
      "title": "docs/history/status-overview.md has 3 broken relative links (repo-root-relative paths copied from CLAUDE.md)",
      "evidence": [
        "docs/history/status-overview.md:77-81 links ./docs/DEVELOPMENT.md, ./docs/PHASE_0_SCAFFOLD_PLAN.md, ./docs/adr/ADR-0027-phase-0-toolchain-and-scaffold.md; relative to docs/history/ these resolve to docs/history/docs/... which does not exist (link-check script over all docs/**/*.md: only these 3 real broken links; arch:module-docs/adr-docs/ui-screens do not scan docs/history)"
      ],
      "verified": true,
      "recommended_fix": "Change to ../DEVELOPMENT.md, ../PHASE_0_SCAFFOLD_PLAN.md, ../adr/ADR-0027-...md, or extend a docs gate to cover docs/history.",
      "verification": "python link walker over docs/**/*.md reports zero broken relative links",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-212",
      "severity": "P3",
      "category": "doc",
      "module": "docs/modules/*",
      "title": "Module specs cite ~470 backticked code paths that do not exist (proposal-era layout)",
      "evidence": [
        "Path-citation scan over docs/modules/*.md found 473 missing repo paths across 50 files, e.g. MODULE_11 cites packages/domain/orders/machines/order.ts, MODULE_13 packages/domain/administration/*, MODULE_20 packages/db/src/schema/safety-*.ts, MODULE_10 packages/hope/src/sections/J/schema.ts, MODULE_01 packages/db/src/rls.test.ts",
        "Specs are 'implementation proposals' (docs/modules/README.md), and arch:module-docs only checks relative links, so this is advisory; architecture docs are clean via arch:architecture-docs (43 documented-absent paths are declared as such)"
      ],
      "verified": false,
      "recommended_fix": "Optional: add an 'as built' path-map pointer or extend arch:module-docs to report (ratchet) missing cited paths.",
      "verification": "python scan of backticked (apps|packages|scripts|architecture)/... paths against filesystem",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-213",
      "severity": "P3",
      "category": "coverage",
      "module": "e2e (web)",
      "title": "E2E reaches only 19 of 170 statically-routable web screens",
      "evidence": [
        "audit/e2e-coverage/E2E_COVERAGE.md: '19/170 E2E-reached, 163/170 axe-reached'",
        "Zero-E2E list includes admin screens such as saas.account, billing.surveyor-audit, admission.census"
      ],
      "verified": false,
      "recommended_fix": "Add E2E specs for the zero-coverage screens, starting with revenue and admission paths. Axe is near full (163/170).",
      "verification": "bun run e2e:coverage shows reached count rising; arch:e2e-coverage --check stays green. Heuristic static analysis, not an execution result.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-214",
      "severity": "P3",
      "category": "spec-drift",
      "module": "Frame fidelity",
      "title": "Frame-fidelity: 2 pending, 14 partial, 70 unmatched frames, 25 deferred specs",
      "evidence": [
        "bun run frame:fidelity:check: 'OK frame-fidelity: report fresh (19 mapped \u00b7 25 deferred \u00b7 70 unmatched \u00b7 green 3 / amber 14 / grey 2)'",
        "Pending: M06 Death & Pronouncement (node:f7o1r) and Discharge/Revocation/Transfer (node:m8VaU), 'not yet matched region-by-region'",
        "Partial (14): App Shell, Care Plan, Assessments, Encounter, Feature Flags, Global Search, HOPE, IDG, Medications/eMAR, Notifications & Tasks, Orders, Patient Chart, Patient List, Staff Messaging",
        "Deferred 25: e.g. wound care, allergy mgmt, prior auth, grievances, breach, OIG, accreditation, timesheets, help, system health, clinical copilot, HL7 logs, mobile suite, six non-patient portals"
      ],
      "verified": false,
      "recommended_fix": "Owner decision on which unmatched frames matter for release; compare pending screens to their frames.",
      "verification": "bun run frame:fidelity:check and read of the generated report.",
      "prior_gap_ids": [
        "GAP-179"
      ]
    },
    {
      "id": "GAP-215",
      "severity": "P3",
      "category": "doc",
      "module": "global",
      "title": "Stale seam-status comments in the composition root and M30 jobs contradict the code",
      "evidence": [
        "apps/backend/src/index.ts:5951 says SignedEncountersReader is registered 'over M8's in-memory store'; it is Drizzle-backed (index.ts:1575, drizzle-store.ts:227).",
        "index.ts:3255-3262 says M32's publisher is deliberately not bound; index.ts:3311 binds it.",
        "index.ts:1580-1584 'KNOWN GAP' that the M9 write path never populates provider_entity_id/location_id; assessments-route-service-db.ts:460-461,584-585 now stamps the siting.",
        "m30-jobs.ts:2640-2644 says cahps_export has no per-job withOrgContext; the worker at :2411-2433 has the processing_log guard under withOrgContext.",
        "drizzle-store.ts:12-15 calls the in-memory defaults for renderPayload/mileage/insertDraftEncounter 'safe', but insertDraftEncounter fabricates an id (see the P1 finding)."
      ],
      "verified": false,
      "recommended_fix": "Update or delete the stale comments.",
      "verification": "grep the cited lines.",
      "prior_gap_ids": [
        "GAP-188",
        "GAP-208"
      ]
    },
    {
      "id": "GAP-216",
      "severity": "P3",
      "category": "spec-drift",
      "module": "M01",
      "title": "M1 Socket.IO events (system.status_changed, feature_flag.updated) are not emitted anywhere",
      "evidence": [
        "Spec docs/modules/WARDENX_MODULE_01_FOUNDATION_SPEC_v0_4.md:2522-2523",
        "packages/messaging/src/realtime/events.ts:30 defines systemStatusChanged constant; grep for systemStatusChanged in apps/*/src and packages/*/src finds no other reference, so it is never used to emit",
        "feature_flag.updated appears only as an outbox catalog entry (packages/shared/src/outbox-events/events-by-m1.ts:32) and in tests; no Socket.IO emit in apps/backend/src",
        "packages/ui/src/core/providers/system-status-provider.tsx consumes the event client-side only"
      ],
      "verified": true,
      "recommended_fix": "Emit from the system-status/feature-flag write paths via the M36 socket gateway or amend the spec to polling.",
      "verification": "grep returns nothing.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-217",
      "severity": "P3",
      "category": "coverage",
      "module": "M01",
      "title": "processing_log (M1) and audit_integrity_run (M4) have no cross-tenant RLS assertion in the m1/m4 isolation live suites",
      "evidence": [
        "Script comparing manifest ownedTables to packages/db/migrations/__tests__/m1-rls-isolation.live.test.ts + rls-isolation.live.test.ts and m4-rls-isolation.live.test.ts: missing processing_log, audit_integrity_run (M2: auditor_magic_link, collaborator_link, auditor_baa_acceptance and M5: patient_allergy are covered by dedicated suites apps/backend/__tests__/m2-*.live.test.ts, f238-doclens-clinical-writeback.live.test.ts:708)",
        "apps/backend/__tests__/m4-audit-integrity-sample.live.test.ts reads audit_integrity_run on the admin connection and only asserts UPDATE is refused as app (line 215)"
      ],
      "verified": false,
      "recommended_fix": "Add both tables to the module RLS isolation suites (app-role cross-tenant read returns zero rows).",
      "verification": "grep -n 'processing_log\\|audit_integrity_run' packages/db/migrations/__tests__/m1-rls-isolation.live.test.ts packages/db/migrations/__tests__/m4-rls-isolation.live.test.ts",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-218",
      "severity": "P3",
      "category": "security",
      "module": "M01",
      "title": "Idempotency replay runs in a global preHandler before route-level authorization and the key is not bound to user, method or path",
      "evidence": [
        "apps/backend/src/bootstrap/plugins/idempotency.ts:36-67 - addHook('preHandler') loads store.load(orgId, key) and replies with the cached response when requestHash matches; hash = computeIdempotencyHash(orgId, key, body) (line 43) has no user/route component.",
        "Fastify runs global preHandler hooks before a route's own preHandler array (requirePermission/requireAbac), so a replay is answered before those guards run. Exploitation needs knowledge of another user's Idempotency-Key in the same org.",
        "Spec conformance: docs/architecture/WARDENX_ARCHITECTURE_v0_11.md:3063 specifies (org_id, key, request_hash, response), so this is spec-consistent but unsafe for PHI create responses."
      ],
      "verified": false,
      "recommended_fix": "Include userId, method and route URL in the stored key/hash and run the replay check after route authorization (move to the route preHandler chain tail or onRequest-after-auth).",
      "verification": "Inject test: user B in the same org replaying user A's key + body on a PHI-returning POST gets 409/403, not A's cached body.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-219",
      "severity": "P3",
      "category": "discovered",
      "module": "M02",
      "title": "Invitation accept is not atomic: the invitation is consumed before the membership insert, so a membership failure burns the invite",
      "evidence": [
        "apps/backend/src/modules/02-identity/routes/identity-routes.ts:372-410 consume(token) (separate tx, identity-stores-db.ts:219-233) -> markEmailVerified -> memberships.create (separate tx); any throw after consume leaves status 'accepted' with no membership",
        "Spec M02 \u00a72.3 line 295 / \u00a77.12 atomic single-use consumption"
      ],
      "verified": false,
      "recommended_fix": "Perform consume + membership create in one org-context transaction or compensate on failure.",
      "verification": "Accept an invite for a user who already holds an active membership in that org: invitation burned, request errors.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-220",
      "severity": "P3",
      "category": "coverage",
      "module": "M05",
      "title": "Boundary validation gaps on M5 writes/reads produce raw 500s instead of typed 4xx",
      "evidence": [
        "apps/backend/src/modules/05-patient/routes/patient-typebox.ts:260-282 AddPatientPayerBodySchema: payerId and effectiveFrom are bare strings (no uuid/date format) so bad input reaches the uuid/date cast",
        "patient-route-service-db.ts:524-534 `throw new Error('patient ... not found')` (500) for an org-wide-scope caller on an unknown id",
        "patient-route-service-db.ts:96-108,125-129 list cursor decoded and cast `::uuid` without validation (crafted cursor -> 22P02 500)",
        "routes/lifecycle-typebox.ts: lrProofDocRef is an unvalidated reference (patient-lifecycle-db.ts:274-280 never checks the document exists)",
        "4 M5 GET routes carry no OpenAPI response schema: GET /api/v1/patients/:id/caregivers, /patient-matches, /patients/:id/amendments, /amendments (ROUTE_ENRICHMENTS, audit/openapi-coverage/OPENAPI_COVERAGE.md getsNoResponse=4)"
      ],
      "verified": false,
      "recommended_fix": "Use format uuid/date in TypeBox, throw NotFoundError, validate the cursor, verify LR proof doc exists in M22, add response schemas.",
      "verification": "POST /patients/:id/payers with payerId 'x' -> 500; GET /patients?cursor=<base64url of [\"a\",\"b\",\"c\"]> -> 500.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-221",
      "severity": "P3",
      "category": "coverage",
      "module": "M05",
      "title": "Read-audit coverage gate omits PHI-adjacent prefixes (amendments, patient-matches, patient-merges, privacy, audit/patients, funeral)",
      "evidence": [
        "apps/backend/src/bootstrap/index.ts:120-300 DEFAULT_READ_AUDIT_PREFIXES lists /api/v1/patients but none of /api/v1/amendments, /api/v1/patient-matches, /api/v1/privacy, /api/v1/audit, /api/v1/funeral (grep returns only /api/v1/auditor/portal-engagement)",
        "Routes currently self-declare auditRead (lifecycle-routes.ts:265-275,347-358; privacy-routes.ts:99-112; link-routes.ts:386) but GET /api/v1/audit/patients/:patientId/access (audit-routes.ts:95-105) declares none and is not audited when read by a non-elevated user"
      ],
      "verified": false,
      "recommended_fix": "Add the prefixes so a new unannotated GET fails boot; decide and document whether chart-access-history reads are themselves read-audited.",
      "verification": "Add a GET under /api/v1/amendments without config.auditRead: it registers silently.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-222",
      "severity": "P3",
      "category": "security",
      "module": "M06",
      "title": "GET /compliance-windows (global queue) has no compliance.scope/caseload narrowing; predicate is registered but allowlisted as 'open gap'",
      "evidence": [
        "apps/backend/src/modules/06-admission/routes/admission-routes.ts:1536-1548 preHandler [COMPLIANCE_READ] only",
        "apps/backend/src/modules/06-admission/admission-route-service-db.ts:2489-2507 listComplianceWindows has no scope parameter; rows expose admissionId/windowKind/severity/dueAt",
        "scripts/abac-uncomposed-allowlist.ts:62-63 compliance.scope: 'Open gap to bind or delete'",
        "Spec route 44 (line ~1930): ABAC compliance.scope"
      ],
      "verified": false,
      "recommended_fix": "Apply readScopeOf narrowing as GET /admissions does, or bind compliance.scope and delete the allowlist entry.",
      "verification": "Route test: non-org-wide clinician lists windows and sees only caseload admissions; arch:abac-composed allowlist entry removed.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-223",
      "severity": "P3",
      "category": "spec-drift",
      "module": "M06",
      "title": "R-ADM-02 (no overdue initial_assessment_48h at activation unless DON override) is not implemented; constants hard-coded false",
      "evidence": [
        "apps/backend/src/modules/06-admission/admission-route-service-db.ts:3962-3965 privacyFlagBlock:false, initialAssessment48hOverdue:false, donOverride:false passed to transitionAdmission",
        "apps/backend/src/modules/06-admission/state-machines/admission.ts:139-143 guard exists but is fed constants",
        "reanchorAssessmentWindows (admission-route-service-db.ts:565-580) resets still-open windows to the activation instant, so the rule is vacuous today; no DON override path exists",
        "Spec \u00a72.4 R-ADM-02 (line 610); privacyFlag half is covered by the readiness patient_privacy requirement"
      ],
      "verified": false,
      "recommended_fix": "Either implement the guard from compliance_window rows plus a DON override, or amend the spec to state the rule is vacuous by re-anchoring.",
      "verification": "Spec/doc check; if implemented, route test with an overdue 48h window.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-224",
      "severity": "P3",
      "category": "doc",
      "module": "M06",
      "title": "Stale deny-stub/forward-seam documentation and unworked queue names after the seams went live",
      "evidence": [
        "apps/backend/src/modules/06-admission/outbox-consumers/m29-proposal-accepted.ts:1-31 header says no M29 producer, 'NOT live-wired', M6_PROPOSAL_ACCEPTED_CONSUMER_DEFERRED = true, but apps/backend/src/index.ts:9050 binds buildM6ProposalAcceptedConsumer",
        "apps/backend/src/modules/09-assessments/seams/m22-summary-pdf.ts:1-53 and index.ts:129-136 export a DENY-STUB renderer 'M22 not built'; M22 exists and the real path is the m9.assessment.summary_requested event (render-consumer.ts:444) - the stub is unused",
        "apps/backend/src/modules/06-admission/jobs/index.ts:15-30 queues draftFromReferral and emitFormRequest have no worker and are not in the spec's documented-deferral note (spec ~line 2302 names only recompute_windows and cti_late_followup)"
      ],
      "verified": false,
      "recommended_fix": "Delete or correct the stale stubs/constants and extend the as-built note in the M6 spec.",
      "verification": "grep for the removed symbols; arch:module-docs.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-225",
      "severity": "P3",
      "category": "spec-drift",
      "module": "M08",
      "title": "HTTP GET /internal/encounters/billable applies a simplified rule that disagrees with the BillableEncounterReader seam (volunteer visits reported billable, no reason codes)",
      "evidence": [
        "apps/backend/src/modules/08-encounters/encounters-route-service-db.ts:1156-1170 billable = status signed|cosigned, no reason",
        "apps/backend/src/modules/08-encounters/seams/readers.ts:34-52 deriveBillability returns volunteer_non_billable / awaiting_cosignature / late_entry_unattested / voided",
        "Spec lines 1266, 1376 define the reason enum for this endpoint"
      ],
      "verified": false,
      "recommended_fix": "Route the HTTP handler through deriveBillability.",
      "verification": "Route test: volunteer_visit signed -> billable:false, reason volunteer_non_billable.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-226",
      "severity": "P3",
      "category": "security",
      "module": "M09",
      "title": "m9.cosigner_role_match compares membership id to user id (no-self-cosign predicate cannot fire); only the service guard prevents self-cosign",
      "evidence": [
        "apps/backend/src/modules/09-assessments/abac-predicates.ts:146 return facts.recordedByUserId !== context.userId",
        "apps/backend/src/modules/09-assessments/assessments-route-service-db.ts:1153-1155 recordedByUserId is CA.capturedByMembershipId (membership id space)",
        "Service backstop present: assessments-route-service-db.ts:992-1000 cosignerIsRecorder: r.capturedByMembershipId === actorUserId (actorOf supplies membership id)",
        "M8's GAP-029 comment claims M9 'already fixed this defect class' - the predicate was not"
      ],
      "verified": false,
      "recommended_fix": "Use membershipIdOf(context) in the predicate as M8/M10 now do.",
      "verification": "Unit test with distinct userId vs membershipId fixtures for the recorder.",
      "prior_gap_ids": [
        "GAP-029"
      ]
    },
    {
      "id": "GAP-227",
      "severity": "P3",
      "category": "spec-drift",
      "module": "M10",
      "title": "M10: PATCH /hope/assessments/:id/huv/completion-date lacks the author-discipline ABAC guard (sibling write routes have it); unfiltered GET /hope/schedules is denied to non-org-wide clinicians by design instead of caseload-narrowed like /hope/sfv",
      "evidence": [
        "apps/backend/src/modules/10-hope/routes/hope-routes.ts:431-445 preHandler [WRITE, SCOPE(\"hope.timepoint.write\")] without ABAC_AUTHOR; siblings at :311-313 and :417-419 include it",
        "apps/backend/src/modules/10-hope/hope-route-service-db.ts:1416-1470 setHuvCompletionDate performs no discipline check (only HUV kind, draft status, version)",
        "apps/backend/src/modules/10-hope/abac-predicates.ts (hope.scope empty-target branch, ~line 248) returns hasOrgWideScope(context.roles); the comment there documents the deny as deliberate",
        "apps/backend/src/modules/10-hope/routes/hope-routes.ts:223-241 GET /hope/schedules has no caseload narrowing, versus :478-494 /hope/sfv using listScopeOf",
        "docs/modules/WARDENX_MODULE_10 line 951: GET /hope/schedules, ABAC caseload, 'List schedules for org or filtered patient'. The denial status (404) is unverified"
      ],
      "verified": true,
      "recommended_fix": "Add ABAC_AUTHOR to the HUV date route; apply listScopeOf narrowing to schedules list for non-org-wide roles.",
      "verification": "Route tests for a non-RN/NP/MD role on the HUV route (403) and a caseload RN listing schedules without a filter (200, narrowed).",
      "prior_gap_ids": [
        "GAP-124"
      ]
    },
    {
      "id": "GAP-228",
      "severity": "P3",
      "category": "doc",
      "module": "M11 Orders",
      "title": "Stale comment claims order authoring and correct are still deferred",
      "evidence": [
        "apps/web/src/modules/11-orders/screens.ts:28-29 'STILL DEFERRED ... the AUTHORING draft modal (all 8 kinds, POST /api/v1/orders), correct'",
        "apps/web/src/modules/11-orders/order-editor.tsx:104-121 posts to /api/v1/orders and PATCHes; POST /orders/{id}/correct is not in the uncalled set"
      ],
      "verified": true,
      "recommended_fix": "Update the comment to list only the standing-order and verbal-policy writes.",
      "verification": "Read screens.ts:20-30 and order-editor.tsx.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-229",
      "severity": "P3",
      "category": "spec-drift",
      "module": "M12",
      "title": "Refill approve checks neither prescriber nor signer eligibility and never signs (leaves an unsigned draft with an empty prescriberDiscipline); DoseSpot history reconcile carry_forward never creates a draft (documented unbuilt)",
      "evidence": [
        "apps/backend/src/modules/12-dosespot/routes/dosespot-routes.ts:630-644: approve preHandler is [REFILL_DECIDE, ABAC_REFILL_DECIDE] only; the signer predicate is bound only on the sign route (:141)",
        "dosespot-route-service-db.ts approveRefill: actorInScope:true hard-coded, prescriberDiscipline:'', no sign seam call, resultingMedicationOrderId set to the draft",
        "Fallbacks admissionId ?? patientId and prescribingPhysicianMdmId ?? sourceMedicationOrderId are unreachable: sourceOrderActive requires source.status==='active' or the transition throws",
        "dosespot-route-service-db.ts reconcileHistory ~1238-1277: returns resultingOrderId:null; spec line 1114 says carry_forward creates a draft; the spec's own as-built note (line 428) records it as not built"
      ],
      "verified": true,
      "recommended_fix": "Remove the fabricated fallbacks (refuse if the source is missing). Enforce prescriber and signer eligibility on approve and call the sign seam. Build the D10 carry-forward draft for DoseSpot-sourced history rows.",
      "verification": "Code reading.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-230",
      "severity": "P3",
      "category": "doc",
      "module": "M12",
      "title": "Stale 'NULL actor' compromise comments in the M12, M13 and M14 route-service headers",
      "evidence": [
        "dosespot-route-service-db.ts:22-23, emar-route-service-db.ts:19-21 and idg-route-service-db.ts:20 state that withOrgContext with userId:'' makes the write-audit trigger fire with a NULL actor.",
        "packages/tenancy/src/context.ts:55-73 (resolveActorUserId) now inherits the ambient authenticated request actor for an empty userId in the same org (GAP-111), so route writes do record an actor. The comments mislead the next reader."
      ],
      "verified": false,
      "recommended_fix": "Update the headers to cite GAP-111 behaviour.",
      "verification": "Read context.ts.",
      "prior_gap_ids": [
        "GAP-111"
      ]
    },
    {
      "id": "GAP-231",
      "severity": "P3",
      "category": "spec-drift",
      "module": "M14",
      "title": "Spec'd /internal/idg/* system routes are absent, and the packet activeDpoa cover fact is always null",
      "evidence": [
        "Spec M14 \u00a74.1 lists GET /api/v1/internal/idg/packets/:id, /cadence-adherence/:admissionId and /decisions/by-care-plan/:carePlanId. grep for 'internal/idg' in apps/backend/src finds nothing. The data flows through seams (seams/providers.ts) instead.",
        "jobs/packet-build.ts:33-35 and :773 set activeDpoa: null. Packets also carry layer2Polished: null."
      ],
      "verified": false,
      "recommended_fix": "Either add the internal routes or amend the spec to say seams replace them. Add the M39 DPOA seam for the cover fact.",
      "verification": "grep.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-232",
      "severity": "P3",
      "category": "spec-drift",
      "module": "M15",
      "title": "M15 volunteer routes 19, 22, 23, 24 have no ABAC role restriction; the spec's coordinator \u2228 compliance-officer (\u2228 DON) composition is never applied",
      "evidence": [
        "apps/backend/src/modules/15-discipline-care-plans/routes/volunteer.routes.ts:103,160,175,192 use only P(...) permission preHandlers; there is no requireAbac on these routes (ABAC_COORDINATOR appears only at lines 61, 85, 126, 143).",
        "packages/auth/src/permissions/contributed.ts:3720-3748 declares abac:\"none\" for volunteer_compliance.read, .revoke, .read_ratio and .adjust_hours.",
        "apps/backend/src/modules/15-discipline-care-plans/abac-predicates.ts:18-19 comment claims the officer branch is composed at the route; no compliance_officer_role predicate exists (only volunteer_coordinator_role at :43, :197).",
        "docs/modules/WARDENX_MODULE_15_DISCIPLINE_CARE_PLANS_SPEC_v0_2.md:892,895,896,897 (\u00a74.1 rows 19, 22, 23, 24) require the ABAC alternatives."
      ],
      "verified": true,
      "recommended_fix": "Either compose an any-of coordinator/compliance-officer/DON guard or amend the spec to state RBAC-only.",
      "verification": "Code reading; grep.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-233",
      "severity": "P3",
      "category": "spec-drift",
      "module": "M16",
      "title": "close-13mo legal-hold skip is vacuous: nothing ever sets bereavement_plan.legal_hold_id",
      "evidence": [
        "jobs/cron-workers.ts:187 and :293 filter on legal_hold_id IS NULL; lifecycle/plan.ts:15 and :117-125 (GAP-130) deliberately do not model m4.legal_hold.applied/released.",
        "grep legalHoldId across the module shows only reads; no writer."
      ],
      "verified": false,
      "recommended_fix": "Either consult M4's legal-hold read at close time or implement the m4.legal_hold subscription; amend spec section 4.5/4.9.",
      "verification": "Grep.",
      "prior_gap_ids": [
        "GAP-130"
      ]
    },
    {
      "id": "GAP-234",
      "severity": "P3",
      "category": "spec-drift",
      "module": "M17",
      "title": "Cron fan-out does not isolate per-org failures; cancel reasonCode ignored",
      "evidence": [
        "17-scheduling/jobs/cron-workers.ts:47-77 - runRecurringMaterializationCron and runVisitAttentionCron have no try/catch per org (siblings use forEachActiveOrg), so one org's error starves later orgs until retry.",
        "scheduling-route-service-db.ts:1143 forces cancellationReasonCode 'operational' while CancelVisitRequest.reasonCode is required (scheduling-typebox.ts:210)."
      ],
      "verified": true,
      "recommended_fix": "Wrap in forEachActiveOrg; persist the client reasonCode against the M38 value set.",
      "verification": "Read.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-235",
      "severity": "P3",
      "category": "coverage",
      "module": "M21",
      "title": "Standard per-module RLS isolation suites omit some owned tables",
      "evidence": [
        "Compared architecture/module-manifest.ts ownedTables to packages/db/migrations/__tests__/m2N-rls-isolation.live.test.ts: M21 missing supply_request_pharmacy_dispense; M22 missing intake_batch_relink, intake_records_request, intake_records_request_fax; M23 missing hospice_rate_table, tenant_wage_index, transfer_notice_record, unmapped_taxonomy_occurrence; M24 and M25 complete",
        "Feature live suites (m23-rate-table, m23-wage-index, m23-transfer-notice, m23-taxonomy-occurrence, f238-records-request, m21-pharmacy-dispense) mention cross-tenant cases, but I did not confirm each asserts isolation for these tables"
      ],
      "verified": false,
      "recommended_fix": "Add the eight tables to their module's rls-isolation live suite.",
      "verification": "Script comparison of table names against suite text. Live suites not run (forbidden).",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-236",
      "severity": "P3",
      "category": "spec-drift",
      "module": "M21",
      "title": "m21.invoice_reconciliation hourly cron from spec \u00a74.6 is not built",
      "evidence": [
        "apps/backend/src/modules/21-supplies/jobs/queues.ts:3 states only the three cron queues are modelled and m21.invoice_reconciliation is omitted",
        "Spec \u00a74.6 lists m21.invoice_reconciliation (hourly, reconcileInvoicesBatch) 'when M27 forward seam is live'; M27 now consumes the accrual events (scripts/outbox-deferred-consumers.ts F-207 note)",
        "Reconciliation is only a manual route (supply-requests.routes.ts:140 vendor-invoice, write-service-drizzle.ts:775-803)"
      ],
      "verified": false,
      "recommended_fix": "Build the batch reconciler or amend the spec to name the manual route as the only path.",
      "verification": "Read queues.ts and the spec table.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-237",
      "severity": "P3",
      "category": "coverage",
      "module": "M22",
      "title": "M22 content-download read-audit labels a document_version id as resourceKind 'document'",
      "evidence": [
        "apps/backend/src/modules/22-documents/routes/documents-routes.ts:306 resourceKind 'document' + resourceIdParam 'versionId' (content route, lines 302-307)",
        "documents-routes.ts:292 and :327 use 'document_version' for the version routes",
        "Spec: M4 \u00a72.5 Accounting completeness (WARDENX_MODULE_04_AUDIT_SPEC_v0_4.md:275) is the closest anchor; no explicit kind-naming rule exists"
      ],
      "verified": true,
      "recommended_fix": "Use resourceKind 'document_version' (or resourceIdParam 'id') so audit rows join to the right resource.",
      "verification": "Read the cited lines.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-238",
      "severity": "P3",
      "category": "stub",
      "module": "M23",
      "title": "POST /admin/billing/platform-rules is a permanent 501 for new rules",
      "evidence": [
        "apps/backend/src/modules/23-billing-medicare/routes/platform-admin-service.ts:109-121 registerPlatformRule throws PLATFORM_RULES_ARE_CODE_DEFINED 501",
        "Spec \u00a74.1 row 41 now carries a DEFERRED (unbuilt) note"
      ],
      "verified": false,
      "recommended_fix": "Either build the platform-rule store/DSL or remove the route from the OpenAPI surface and spec inventory.",
      "verification": "Read the cited lines.",
      "prior_gap_ids": [
        "GAP-144"
      ]
    },
    {
      "id": "GAP-239",
      "severity": "P3",
      "category": "seam",
      "module": "M23/M26",
      "title": "M26's m23.claim.replaced/voided bindings are inert and the m26.cap.projection_updated revalidate consumer in M23 is a deny-stub",
      "evidence": [
        "apps/backend/src/modules/23-billing-medicare/events-by-m23.ts:305-322 and claim-state-service.ts:431-451 carry only {originalClaimId, replacementClaimId|voidClaimId, reason}, while 26-cap/consumers/handlers.ts:85-112 handleClaimReversed needs patientId, claimId, serviceFrom, serviceTo and an amount, so it always returns recorded:false (outbox-binding.ts:27-33 admits it). The m25 claim_recouped path does cover reversal.",
        "23-billing-medicare/consumers/subscription-map.ts:310-318 marks M26_CAP_PROJECTION_TOPIC `deny_stub`; handlers.ts:560-566 throws ForwardSeamNotLandedError although M26 now emits it."
      ],
      "verified": false,
      "recommended_fix": "Widen the replaced/voided payloads or drop M26 as a declared consumer. Flip the M23 projection_updated subscription to live (revalidate) or remove it.",
      "verification": "Void a paid claim and inspect cap_beneficiary_accrual_line (no reversal row from this path).",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-240",
      "severity": "P3",
      "category": "doc",
      "module": "M23/M27/M30 erasers",
      "title": "Stale TODO(boot-wiring) comments say DataClass union lacks billing_record / cost_report_class / quality_class; they were added",
      "evidence": [
        "apps/backend/src/modules/23-billing-medicare/erasers/billing-eraser.ts:643-646 TODO '(1) add \"billing_record\" to the @wardenx/types DataClass union'",
        "apps/backend/src/modules/27-cost-report/erasers/cost-report-eraser.ts:204 (and :32) same for cost_report_class",
        "apps/backend/src/modules/30-quality/erasers/quality-eraser.ts:202 same for quality_class",
        "packages/types/src/seams.ts:1766,1769,1772 already list quality_class, cost_report_class, billing_record; apps/backend/src/index.ts:2542 registers the M23 eraser"
      ],
      "verified": false,
      "recommended_fix": "Remove item (1) from the three TODOs (keep the decisionCert co-sign item only if still true) or verify each against REQUIRED_ERASERS.",
      "verification": "rg 'to the `@wardenx/types` `DataClass`' apps/backend/src returns nothing; confirm REQUIRED_ERASERS membership in apps/backend/src/bootstrap/seams/registry.ts",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-241",
      "severity": "P3",
      "category": "security",
      "module": "M26",
      "title": "Per-patient cap PHI routes compose no caseload_or_scope although sibling billing routes do",
      "evidence": [
        "cap.routes.ts:196-215 (accruals/patient...) and 175-194 (projections/patient...) gate on cap.accrual.read / cap.projection.read only",
        "apps/backend/src/modules/23-billing-medicare/routes/claims.routes.ts:13 and guards.ts:128-153 compose caseload_or_scope for patient-level billing reads",
        "auditRead with patientIdParam IS configured (cap.routes.ts:187-192) so reads are audited"
      ],
      "verified": false,
      "recommended_fix": "Decide explicitly: compose M5 caseload_or_scope (billing roles likely org-wide) or document the waiver in the spec.",
      "verification": "Call the route as a clinician outside the patient's caseload holding cap.projection.read.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-242",
      "severity": "P3",
      "category": "spec-drift",
      "module": "M26",
      "title": "PS&R resolve route ignores :importId (line is resolved by lineId alone)",
      "evidence": [
        "psr.routes.ts:75-84 parses only lineId",
        "write-service-drizzle.ts:393-408 resolveVariance updates PR by id with no import match"
      ],
      "verified": false,
      "recommended_fix": "Include psrImportId in the WHERE clause.",
      "verification": "Call with a mismatched importId; expect 404.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-243",
      "severity": "P3",
      "category": "spec-drift",
      "module": "M27",
      "title": "Reopen creates no new snapshot-chain link or warn audit; financial/snapshot reads declare no read-audit",
      "evidence": [
        "write-service-drizzle.ts:1337-1365 reopen only changes state and emits m27.cost_report.reopened",
        "grep auditRead in apps/backend/src/modules/27-cost-report/routes: 0 matches; '/api/v1/cost-reports' is not in DEFAULT_READ_AUDIT_PREFIXES (apps/backend/src/bootstrap/index.ts:120-250)"
      ],
      "verified": false,
      "recommended_fix": "Create the snapshot link on reopen and add auditRead to snapshot/financial reads (and the prefix).",
      "verification": "Reopen a report and read a snapshot; assert snapshot chain length and an audit read row.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-244",
      "severity": "P3",
      "category": "doc",
      "module": "M27",
      "title": "cost_report_period_active predicate is never composed by any route yet arch:abac-composed passes (unused PERIOD_ACTIVE wrapper)",
      "evidence": [
        "routes/guards.ts:57 exports PERIOD_ACTIVE; grep PERIOD_ACTIVE in apps/backend/src: only the definition",
        "bun run arch:abac-composed: 'every declared ABAC predicate is composed' (wrapper definition counts); state is enforced service-side (write-service-drizzle.ts:509,593,708,799,839,870)"
      ],
      "verified": true,
      "recommended_fix": "Compose it on the edit routes or allowlist it with a reason; make the gate require a use site for wrappers.",
      "verification": "Delete PERIOD_ACTIVE and re-run arch:abac-composed; the gate should flag the predicate.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-245",
      "severity": "P3",
      "category": "spec-drift",
      "module": "M29",
      "title": "Inbound parse/match/apply pipeline is a poll worker over hl7_message_inbound, not the spec'd m29.hl7_inbound_* BullMQ queues with retry/DLQ",
      "evidence": [
        "apps/backend/src/index.ts:8311-8350 startM29ParseWorker is poll-based with FOR UPDATE SKIP LOCKED",
        "grep hl7_inbound_parse|hl7_inbound_match|hl7_inbound_apply|feed_health_aggregate in apps/backend/src: no queue definitions; modules/29-external-interfaces/queues/ does not exist"
      ],
      "verified": false,
      "recommended_fix": "Either build the queues or amend spec 4.9 to describe the polling design and its retry/quarantine semantics.",
      "verification": "Compare spec 4.9 to registered queues.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-246",
      "severity": "P3",
      "category": "discovered",
      "module": "M31",
      "title": "Minor drift: invitation list/revoke org-wide with no patient link; fabricated invitedAt; 200 'not_found' replies; PortalSessionMinter returns a synthetic id; grief-resources route maps every error to a 501 'M40 has not built' message",
      "evidence": [
        "apps/backend/src/modules/31-portal/provisioning/invitations.ts:334-350 list(organizationId) has no patientId filter and limits 200; routes/admin.routes.ts:103-129 list/revoke use ABAC_IN_ORG",
        "routes/admin.routes.ts:238 invitedAt: r.activatedAt ?? now().toISOString()",
        "routes/admin.routes.ts:326 (also 194, 217) return 200 with 'not_found' status instead of a NotFoundError",
        "routes/store.ts:476-481 createSmartLaunchSession returns a synthetic `smart:` id and creates nothing; spec interface is mintSessionForSmartLaunch (docs/modules/WARDENX_MODULE_31_PORTAL_TELEHEALTH_SPEC_v0_2.md:1000)",
        "routes/read.routes.ts:419-434 bare catch maps every error to 501 'M40 has not built this catalog'; M40 registers the seam at modules/40-mdm/seams.ts:58"
      ],
      "verified": true,
      "recommended_fix": "Tidy as listed; return 404/409 instead of 200 bodies.",
      "verification": "Read the cited lines.",
      "prior_gap_ids": [
        "GAP-158",
        "GAP-199"
      ]
    },
    {
      "id": "GAP-247",
      "severity": "P3",
      "category": "doc",
      "module": "M33",
      "title": "report.tile_warm_cache has no worker or producer; stale comments claim cron adapter is FAIL_CLOSED",
      "evidence": [
        "apps/backend/src/modules/33-reporting/jobs/m33-jobs.ts:301-304,1120-1121 state tile_warm_cache has no consumer/producer; dashboard_tile_cache is never populated",
        "m33-jobs.ts:1122 says the cron adapter is FAIL_CLOSED_CRON but wiring.ts:312-358 binds the live cron-parser (GAP-050)"
      ],
      "verified": false,
      "recommended_fix": "Build or formally drop tile_warm_cache; refresh the stale comments.",
      "verification": "grep -rn tileWarmCache apps/backend/src --include=*.ts: only constants.",
      "prior_gap_ids": [
        "GAP-162"
      ]
    },
    {
      "id": "GAP-248",
      "severity": "P3",
      "category": "stub",
      "module": "M33",
      "title": "M33 tileWarmCache and tenantEraser queues declared with params and DLQ names but have no worker or producer",
      "evidence": [
        "apps/backend/src/modules/33-reporting/jobs/index.ts:62,68,78,81,132,159",
        "apps/backend/src/modules/33-reporting/jobs/m33-jobs.ts:886-888, 1120-1121 state both queues are 'NOT constructed here - no producer anywhere'",
        "Spec Module 33 lines ~1119 and 1122 list report.tile_warm_cache and report.tenant_eraser worker queues and m33.tenant_eraser_complete event (line 1157)"
      ],
      "verified": false,
      "recommended_fix": "Remove from catalog and amend spec, or build; confirm tenant erasure of M33 operational rows goes through the M4 destruction registry (reporting-eraser.ts:233 has TODO for decisionCert gate).",
      "verification": "Source comments plus grep; documented as deliberate in code, spec not amended.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-249",
      "severity": "P3",
      "category": "coverage",
      "module": "M34",
      "title": "GET /tenant/account auditRead has no resourceIdParam (audit insert fails silently)",
      "evidence": [
        "apps/backend/src/modules/34-saas-tenant-platform/routes/tenant/account-flags-routes.ts:43 auditRead {resourceKind:'tenant_account'} (non-list, no id source)"
      ],
      "verified": true,
      "recommended_fix": "Add resourceIdParam or list:true / waive with a reason.",
      "verification": "Query audit_event for tenant_account.viewed after GET.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-250",
      "severity": "P3",
      "category": "spec-drift",
      "module": "M40",
      "title": "get-or-create never returns fuzzy_candidates and ignores identifierType; search/get-or-create request shapes differ from spec",
      "evidence": [
        "packages/mdm/src/provider/provider.ts:96-116 returns only matched_canonical or created_provisional; comment says fuzzy_candidates is 'T07/T08'",
        "apps/backend/src/modules/40-mdm/mdm-store-db.ts canonicalIdByIdentifier ignores identifierType",
        "mdm-typebox.ts:40-62 SearchQuerySchema (q, identifier, limit) and GetOrCreateBodySchema (identifierType/identifierValue/displayName) vs spec \u00a74.2 npi/ccn/payerId/isPreferred/status/cursor and per-kind union body"
      ],
      "verified": false,
      "recommended_fix": "Implement the fuzzy suggestion branch and align the request contracts, or amend spec \u00a74.2 to the shipped Phase-1 shape.",
      "verification": "read provider.ts:96-116",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-251",
      "severity": "P3",
      "category": "stub",
      "module": "M5 Patient census",
      "title": "Census KPI strip: Admissions/Discharges/GIP/Recerts render as placeholders",
      "evidence": [
        "patient-list-census.tsx:132-133 'cross-module KPIs ... render as honest placeholders until M6/billing reads land'; audit/frame-fidelity notes the same",
        "Backend /api/v1/admissions and /discharges/worklist exist, so the reads are available"
      ],
      "verified": false,
      "recommended_fix": "Bind the KPIs to the M6 reads or remove the tiles.",
      "verification": "Read lines 125-140 and the frame-fidelity row.",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-252",
      "severity": "P3",
      "category": "doc",
      "module": "multiple (M05/M06/M08/M13/M18/M19/M22/M23/M30/M33/M34)",
      "title": "Comments describe modules as not yet landed ('when M29/M17/M39/M26/M25 lands', 'Phase 2D', 'integrator') though all 40 modules are implemented",
      "evidence": [
        "apps/backend/src/modules/06-admission/outbox-consumers/m29-proposal-accepted.ts:36 'boot wiring (when M29 lands)'",
        "apps/backend/src/modules/08-encounters/outbox-consumers/m17-visit-scheduled.ts:197 'when M17 lands'",
        "apps/backend/src/modules/23-billing-medicare/consumers/subscription-map.ts:67,309 'DENY-STUB until M26 lands'",
        "apps/backend/src/modules/05-patient/privacy/index.ts:4,48 'inert until M39 lands'",
        "apps/backend/src/modules/30-quality/jobs/m30-jobs.ts:157,2623 and 33-reporting/jobs/m33-jobs.ts:107 'TODO(integrator)'",
        "apps/backend/src/modules/34-saas-tenant-platform/**: ~15 'TODO(Phase 2D)' (index.ts:255, routes/public/signup-intents.ts:195, platform/service.ts:1188)",
        "IMPLEMENTATION_STATUS.md header: 40 Implemented, 0 Partial, 0 Placeholder. Some are legitimately still open (alert-rules.ts:524 registerM34AlertResolvers uncalled, index.ts:5363; signup service gated by flag), so each must be triaged individually - not verified which of the ~600 TODO/lands-hits are stale"
      ],
      "verified": false,
      "recommended_fix": "Triage each 'until Mxx lands' / TODO(Phase 2D|integrator) comment against current wiring; delete stale ones, convert live ones to tracked issues.",
      "verification": "git grep -nE 'when M[0-9]+ lands|until M[0-9]+ lands|TODO\\(Phase 2D|TODO\\(integrator' apps packages",
      "prior_gap_ids": []
    },
    {
      "id": "GAP-253",
      "severity": "P3",
      "category": "build",
      "module": "Ops/Config",
      "title": "Operational env vars read by backend are absent from .env.example, docker-compose and deploy/production example",
      "evidence": [
        "Absent from .env.example, deploy/production/.env.production.example, docker-compose*.yml, deploy/production/compose.yml, bootstrap-vps.sh: DOCUMENT_UPLOAD_SCAN_REQUIRED (22-documents/index.ts:91), M19_CURSOR_SIGNING_KEY and M20_CURSOR_SIGNING_KEY (override keys, concurrency.ts:143), OPS_ALERT_WEBHOOK_URL (index.ts:5263,7556), WEB_APP_URL, PORTAL_APP_URL (index.ts:3650,3679,4877), OUTBOX_DISPATCHER_DISABLED, OUTBOX_READY_DEPTH_THRESHOLD, NPPES_SYNC_DISABLED, EVV_AGGREGATOR_STATES, M11_RECOVERY_ESCALATION_THRESHOLD, M11_RECOVERY_ORG_RATE_THRESHOLD, TERMINOLOGY_PLATFORM_BUCKET, TERMINOLOGY_LOADER_EGRESS, ANTHROPIC_BAA_REFERENCE, AUDIT_INTEGRITY_SAMPLE_SIZE, DOCLENS_AI, OLLAMA_LICENSES",
        "Method: grep process.env.X reads in apps/packages/scripts/services vs grep of those names in the four env files",
        "DOCUMENT_UPLOAD_SCAN_REQUIRED defaults to false: with no malware scanner in repo, server uploads store unscanned bytes unless an operator knows the undocumented flag (index.ts:85-91)"
      ],
      "verified": false,
      "recommended_fix": "Add the production-relevant ones (scan flag, OPS_ALERT_WEBHOOK_URL, APP URLs, ANTHROPIC_BAA_REFERENCE, TERMINOLOGY_*) to deploy/production/.env.production.example with comments; consider env.ts production validation for DOCUMENT_UPLOAD_SCAN_REQUIRED. M19_/M20_ overrides are optional since CURSOR_SIGNING_KEY is documented (deploy example:51, env.ts:251).",
      "verification": "Static grep only; some listed names are dev/test-only (WARDENX_SEED_*, BOOT_CHECK_*, CI) and were deliberately not reported.",
      "prior_gap_ids": [
        "GAP-068"
      ]
    }
  ]
}
```
