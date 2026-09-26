# Force-push recovery audit — `main`, 2026-09-25

**Status:** audit only. Nothing has been re-landed, deleted, or pushed. The pre-force-push `main` is preserved
locally as `refs/rescue/main-before-forcepush-2026-09-17` (and is still fetchable from GitHub by SHA
`ec55d971b92b9cfe573d94aa0bc819ea27d7a756`, though nothing on GitHub references it any more).

## What happened

| When (UTC) | Event |
|---|---|
| 2026-08-25 16:55 | PR #13 merges `develop` into `main` (`c526c79b`). `main`'s tree equals `develop`'s tip `612bd641` exactly. |
| 2026-08-25 → 08-30 | 134 first-parent commits land on `main` (all by `fabwebdev`): PRs #14–#222, ending at `ec55d971`. |
| 2026-08-26 → 08-30 | Each merge auto-deploys to production, including migrations `0215`–`0241`. |
| **2026-09-17 13:22** | **The `Jacobson-svg` account force-pushes `main`: `ec55d971` → `2fe1db27`.** `2fe1db27` descends from `612bd641` (Aug 25) plus 17 commits on that account's branch; it does not contain any of the 134. |
| 2026-09-17 → 09-25 | PRs #230–#241 merge on top of the rewritten `main` and deploy. |

GitHub still lists the dropped PRs as **Merged**, and their merge commits are unreachable from `main`.

## Scope of the loss

- **134 commits, ~112,000 inserted lines, 1,013 files** (`git diff c526c79b ec55d971`).
- Mechanical check of each commit against current `main` (reverse-apply = already present):
  - **1** already present (#80, a two-file revert);
  - **11** absent but apply cleanly on their own;
  - **122** absent and do not apply on their own (later commits build on earlier ones, and `main` has moved).
- **277 files the lost work created do not exist on `main`**, including 27 migrations, 98 backend and 54 web
  files, 11 e2e specs, and ~12 fitness gates (`check-migration-numbering`, `check-merge-artifacts`,
  `check-route-reachability`, `check-test-typecheck-coverage`, `check-request-body-contract`, …).
- `.github/workflows/ci.yml` on `main` lacks ~470 lines that `ec55d971` had; `deploy.yml` ~160.

## Trial merge (`git merge ec55d971` into current `main`, not committed)

The two histories share `612bd641`, so a real merge re-applies everything that does not overlap:

- **~930 files merge automatically.**
- **84 files conflict** (81 content, 3 add/add). Of these, **10 are generated** and are regenerated rather
  than resolved (`audit/**`, `docs/api/openapi.json`, `packages/ui/src/core/api/schema.ts`,
  `scripts/openapi/enrichments.ts` partially). **~74 need hand resolution**, concentrated in:
  - M6 admission (route services, typebox, detail screen) — lost #46/#52/#143/#162/#213 vs. the
    `Jacobson-svg` admission phase-1 work;
  - M8 encounters (route service, typebox, write workflow) — lost #113/#120/#126/#127/#129/#130/#160/#179/#195;
  - M10 HOPE (route service, routes, typebox, detail screen) — lost #47/#51/#149/#151/#176/#178/#196 vs. the
    `Jacobson-svg` HOPE phases 1a–7;
  - `apps/backend/src/index.ts` (composition root; 29 lost PRs touched it);
  - web screens restyled by #235 (the redesign) that lost PRs also changed.
- Auto-merged files still need review: a clean text merge can combine two implementations of the same
  thing (see *Overlaps*).

## Migrations — the highest-risk part

Both sides numbered new migrations from `0215`:

| Range | Lost (`ec55d971`) | Current `main` |
|---|---|---|
| `0215`–`0235` | 21 files | 21 different files, same numbers |
| `0236`–`0241` | 6 files | — |

`scripts/db/migrate.ts` records applied migrations **by filename** (+ checksum). Production applied the 27 lost
files on Aug 26–30 and the 21 current ones since Sep 17, so its `_wardenx_migration` table should hold **both
sets**. Consequences for recovery:

- **Keep the lost migrations' exact filenames and bytes.** Renumbering them would make production see new files
  and run them a second time.
- On a fresh database both sets would then run interleaved by filename, an order production never saw; a fresh
  build from the merged tree must be proven green before any merge.
- The numbering gate (lost `check-migration-numbering.ts`) needs an explicit allowlist for these 21 historical
  duplicates.
- **Verify production first:** read its `_wardenx_migration` table to confirm which of the 48 files it has.

## Overlaps: work done twice

Work merged after the force-push re-solved some of the same problems. Each pair must be reconciled (keep one,
or combine) rather than both kept by the merge:

| Lost PR | Later equivalent on `main` / in progress |
|---|---|
| #20 F-001 pre-org membership picker (`0215_pre_org_membership_picker_definer`) | #236/#237 (`0231_m2_membership_picker_definer`) |
| #142 HCI could not compute | uncommitted HCI indicator 2/8/9/composite work (this session) |
| #184 FHIR gateway + #197 disclosure-ledger RLS (`0233`/`0235` FHIR) | #238 FORCE RLS on 8 tables (`0233_rls_force_…`) |
| #201 feature_flag reader/writer (`0237`) | #236 (`0232_foundation_feature_flag_evaluation_audit`) |
| #47/#51/#149/#151/#176/#178/#196 HOPE capture, validator, iQIES stages | `Jacobson-svg` HOPE phases 1a–7, #239, #240 |
| #46/#52 admission siting / location backfill (`0218`) | `Jacobson-svg` M6 admission phase-1 (`0215`/`0220`/`0221`) |
| #222 alert delivery (`0240`/`0241`) | `0216_m36_alert_correlation_dedup` |
| #25/#62/#42/#58/#60/#211 fitness runner, migration numbering, CI live/e2e jobs | #236 fitness fixes, #238 CI live-suite fixes |

This list comes from topic matching and is not exhaustive; the merge review should confirm each.

## Branches that still hold lost work

Do **not** delete until recovery is done: `audit/F-081-passkey-enrolment` (through #194),
`audit/F-082-tenant-key-ring-seed` (through #195), `docs/agents-skills-mirror` (PR #171, through #169),
and `develop`.

## Recommended recovery

1. Preserve `ec55d971` on GitHub as a branch (e.g. `rescue/main-2026-08-30`) so it cannot be garbage-collected.
2. Read production's `_wardenx_migration` table.
3. On a recovery branch, `git merge ec55d971` into `main`; resolve the ~74 conflicts module by module;
   regenerate the generated files; reconcile each overlap pair; keep lost migration filenames unchanged.
4. Prove it: fresh-database migrate, `bun run build`, `arch:fitness` (including the restored gates), the full
   unit suite, and every live suite; then run the Docker stack and exercise the recovered flows.
5. Land it as one PR (reviewed), or as a short series by module if review size demands.
6. Protect `main` against force-pushes.

## Per-PR table

"On main now" is the mechanical reverse-apply check; "Trial-merge conflicts" counts the conflicted files the
PR touched (other PRs may share them).

| PR | Commit | Files | +Lines | On main now | Trial-merge conflicts | Title |
|---|---|---|---|---|---|---|
| #26 | `d188a353` | 2 | 38 | no (applies cleanly alone) | — | Merge pull request #26 from Engrace-Hospice/audit/F-002-deploy-verification-gate |
| #24 | `e6ad2e10` | 16 | 19 | no | 3 | Merge pull request #24 from Engrace-Hospice/audit/F-003-web-boundary-and-token |
| #20 | `7d79c1b8` | 6 | 463 | no | 1 | Merge pull request #20 from Engrace-Hospice/audit/F-001-membership-rls-cross-org |
| #23 | `dde4b1cc` | 2 | 182 | no (applies cleanly alone) | — | Merge pull request #23 from Engrace-Hospice/audit/F-005-notification-prefs-org-scope |
| #63 | `4bdc023f` | 8 | 632 | no | 1 | Merge pull request #63 from Engrace-Hospice/audit/F-006-tenancy-policy-scoped-exemption |
| #25 | `2791edd5` | 3 | 188 | no (applies cleanly alone) | — | Merge pull request #25 from Engrace-Hospice/audit/F-004-fitness-gate-runner |
| #62 | `24f546f7` | 9 | 273 | no | — | Merge pull request #62 from Engrace-Hospice/audit/F-026-migration-numbering |
| #40 | `80c01697` | 3 | 40 | no | 1 | Merge pull request #40 from Engrace-Hospice/audit/F-014-scenario-seed-physician-session |
| #42 | `234b3c7a` | 4 | 300 | no | — | Merge pull request #42 from Engrace-Hospice/audit/F-015-live-suite-coverage-blind-spots |
| #28 | `6a03c305` | 2 | 275 | no (applies cleanly alone) | — | Merge pull request #28 from Engrace-Hospice/audit/F-007-payment-method-actions |
| #38 | `f1dc7c33` | 33 | 814 | no | 2 | Merge pull request #38 from Engrace-Hospice/audit/F-010-keyboard-operable-rows |
| #30 | `d89fdc83` | 3 | 370 | no (applies cleanly alone) | — | Merge pull request #30 from Engrace-Hospice/audit/F-008-shred-ceremony-inputs |
| #35 | `94276619` | 4 | 213 | no (applies cleanly alone) | 3 | Merge pull request #35 from Engrace-Hospice/audit/F-009-openapi-duplicate-alias |
| #37 | `ad561b11` | 5 | 507 | no | — | Merge pull request #37 from Engrace-Hospice/audit/F-013-openapi-provenance-gate |
| #64 | `30c00d50` | 15 | 623 | no | 2 | Merge pull request #64 from Engrace-Hospice/audit/F-022-diagnosable-error-mapping |
| #46 | `f95ac290` | 14 | 581 | no | 6 | Merge pull request #46 from Engrace-Hospice/audit/F-017-admission-siting-election-record |
| #47 | `0c19b697` | 6 | 446 | no | 3 | Merge pull request #47 from Engrace-Hospice/audit/F-018-hope-assessment-patient-id |
| #51 | `15ab52b3` | 19 | 1483 | no | 11 | Merge pull request #51 from Engrace-Hospice/audit/F-019-hope-schedule-and-recording-gate |
| #52 | `96170c81` | 18 | 1107 | no | 14 | Merge pull request #52 from Engrace-Hospice/audit/F-021-admission-location-siting |
| #53 | `a7164d4e` | 9 | 570 | no | 2 | Merge pull request #53 from Engrace-Hospice/audit/F-020-outbox-binding-catalog-gate |
| #54 | `de3513b8` | 5 | 214 | no | — | Merge pull request #54 from Engrace-Hospice/audit/F-014-seed-chain-personas |
| #57 | `5f1f4756` | 5 | 241 | no | 1 | Merge pull request #57 from Engrace-Hospice/audit/F-023-e2e-suite-green |
| #66 | `b851c092` | 8 | 282 | no | — | Merge pull request #66 from Engrace-Hospice/fix/ci-yml-conflict-markers |
| #58 | `ba33cf47` | 9 | 228 | no | — | Merge pull request #58 from Engrace-Hospice/audit/F-024-e2e-in-ci |
| #60 | `f34fbe43` | 5 | 287 | no | — | Merge pull request #60 from Engrace-Hospice/audit/F-025-live-suite-file-direction |
| #14 | `469c0c6f` | 4 | 607 | no (applies cleanly alone) | — | Merge pull request #14 from Engrace-Hospice/audit/prompt-5-github-delivery |
| #67 | `7fb62d99` | 8 | 586 | no | — | Merge pull request #67 from Engrace-Hospice/audit/F-027-phi-safe-error-serializer |
| #68 | `0c36b5f8` | 131 | 2604 | mostly no (2present/129not) | 8 | Merge pull request #68 from Engrace-Hospice/audit/F-011-lint-blocking |
| #69 | `0cc263c4` | 25 | 367 | no | 1 | Merge pull request #69 from Engrace-Hospice/audit/F-012-typecheck-scripts |
| #71 | `60867e05` | 10 | 256 | no | 2 | Merge pull request #71 from Engrace-Hospice/audit/F-016-single-local-db-path |
| #72 | `3a30a04f` | 15 | 808 | no | — | fix(security): the step-up gate on four commit-point routes was a client-supplied header (#70) (#72) |
| #74 | `92f8c4b9` | 4 | 258 | no | — | fix(authz): stamp `context.attributes.stepUpRecent` — fifteen modules read a fact nothing wrote (#73) (#74) |
| #76 | `46414c60` | 9 | 557 | no | — | fix(authz): gate the context-attribute bag, and retire the `systemPrincipal` name (#75) (#76) |
| #77 | `6b3a825b` | 28 | 1142 | no | 1 | fix(authz): mint the portal session classes, and close a NULL hole in session_scope_chk (#75) (#77) |
| #78 | `018f03f4` | 20 | 210 | no | — | fix(authz): one name for the session's pinned patient — it had three, and no writer (#75) (#78) |
| #79 | `13e0361e` | 6 | 171 | no | — | fix(authz): every WardenX invitation said "Organization" — resolve the real name (#75) (#79) |
| #80 | `e2c734d5` | 2 | 0 | yes | — | revert: restore the two tracked spec artifacts #79 deleted by accident (#80) |
| #81 | `3eb2563e` | 3 | 5 | no (applies cleanly alone) | — | chore: drop the two spec zips from the tree (deliberate, confirmed) (#81) |
| #82 | `759bc347` | 7 | 251 | no | — | fix(authz): M27/M30's permission checks read a bag key; the check-don't-gate seam was always there (#75) (#82) |
| #83 | `4f39760d` | 12 | 145 | no | — | fix(authz): M32's disclosure ledger masked PHI for everyone, forever — both arms of the check were dead (#75) (#83) |
| #84 | `05878d07` | 1 | 3 | no | — | docs(authz): correct three F-030 blocked-key entries that were wrong about their own blockers (#75) (#84) |
| #85 | `5050fed8` | 12 | 229 | no | 3 | fix(authz): nobody could review a high-risk extracted field — wire M22 to the licence M17 records (#75) (#85) |
| #86 | `c0267559` | 5 | 77 | no | — | fix(authz): M29's platform-only NPPES gate refused the platform operators it exists for (#75) (#86) |
| #87 | `ed6c4677` | 12 | 262 | no | — | fix(authz): seven modules derived clinical discipline from a key nothing writes (#75) (#87) |
| #88 | `d3aac9ca` | 37 | 2768 | no | 11 | feat(authz): build the M2 device-attestation surface — ADR-0023 D2, adjudicated (#75) (#88) |
| #89 | `14b3c461` | 39 | 1067 | mostly no (1present/38not) | 10 | feat(authz): bind a session to its triage vendor — the last unproduced key (#75) (#89) |
| #90 | `9d69226e` | 15 | 724 | no | 3 | fix(authz,arch): nothing in production ever wrote a step-up; gate the manifest mirror (#90) |
| #108 | `c72d73ea` | 3 | 81 | no (applies cleanly alone) | — | fix(frontend): the triage state filter's "any" sentinel keyed as "open", and so did the open state (#101) (#108) |
| #109 | `ee0754a1` | 6 | 50 | no | — | docs: correct six statements that had outlived what they describe (#107) (#109) |
| #110 | `ff7c6b7e` | 10 | 1035 | no | 1 | feat(db,infra): schedule partition rotation, and correct what its absence actually does (#93) (#110) |
| #111 | `4191bc56` | 5 | 316 | no | 2 | fix(infra): the deploy verified one loopback /ready and called it done (#98) (#111) |
| #112 | `bbccdc04` | 9 | 659 | no | 1 | feat(infra,security): sign, scan and describe the release images, and verify on the host (#100) (#112) |
| #113 | `5ce9da19` | 19 | 1164 | mostly no (1present/18not) | 15 | fix(api,clinical): a recorded vital was unreadable through every caller-facing route (#92) (#113) |
| #116 | `966197da` | 6 | 360 | no (applies cleanly alone) | 1 | fix(infra,security): production env validation certified hosts reserved to never resolve (#115) (#116) |
| #131 | `43157be7` | 18 | 1066 | no | 2 | fix(security,infra,db): the platform had no key-encryption key, and could not have read one (#105) (#131) |
| #132 | `e8f33f65` | 5 | 1731 | no | — | feat(infra,backend): ask the outbox gate the direction it never asked (#103) (#132) |
| #139 | `badcd301` | 30 | 1307 | no | 4 | fix(reporting,authz): the reporting read path ended one layer above where the audit said, and D8's scope envelope was… |
| #142 | `59666376` | 31 | 2536 | no | 3 | fix(quality,clinical): the HCI could not compute, and one of its four "bound" indicators never had (#102) (#142) |
| #118 | `b5e45fd9` | 30 | 991 | no | 6 | feat(api): check that a route's published request body agrees with the one it reads (#94) (#118) |
| #119 | `3792471a` | 22 | 633 | no | 4 | fix(api,clinical,portal): four routes demanded a payload and threw it away (#117) (#119) |
| #120 | `08d28d0e` | 24 | 1499 | no | 16 | fix(api,clinical): the encounter note body was never written (#114) (#120) |
| #126 | `6d4a9b22` | 14 | 1041 | no | 4 | fix(api,clinical): the Layer-3 compliance gate was a literal `true` (#121) (#126) |
| #127 | `9875c836` | 12 | 386 | no | 4 | fix(api,clinical): an LPN note routed its own cosignature (#124) (#127) |
| #129 | `efff14b9` | 15 | 620 | no | 7 | fix(api,clinical,db): the signed note's bytes were never pinned (#122) (#129) |
| #130 | `38e85366` | 11 | 275 | no | 8 | fix(api,clinical): the Layer-2 enhance route fabricated a modification id (#123) (#130) |
| #133 | `ef40a9a9` | 33 | 8254 | no | 4 | fix(emar,web): the eMAR could not record a dose, and the doses it did record were filed under a sentinel patient (#91… |
| #136 | `46164e97` | 13 | 292 | no | — | fix(prescribing,emar): `signed` was a terminal state wearing an in-flight state's name (#135) (#136) |
| #143 | `80874116` | 10 | 923 | no | 3 | fix(clinical,authz): M6's election-period machine was called by nothing, so four §2.4 rules never ran (#141) (#143) |
| #144 | `f96a785e` | 5 | 5 | no | — | fix(db): 0224 was claimed by three migrations at once — renumber the two that landed second (#144) |
| #145 | `b6e33c5b` | 12 | 615 | no | 3 | fix(clinical): every signed note pinned the same placeholder vocabulary (#128) (#145) |
| #146 | `90f40693` | 42 | 1218 | no | 6 | fix(infra,backend): 252 events deferred forever by a subscription nobody meant to declare (#103) (#146) |
| #147 | `8c899545` | 12 | 1688 | mostly no (1present/11not) | 4 | feat(orders,web): the M11 queues could not do the thing they exist for (#91) (#147) |
| #149 | `744b0220` | 17 | 1710 | no | 10 | fix(hope,clinical): the CMS pre-submission validator has never run (#148) (#149) |
| #151 | `e34f555a` | 17 | 2339 | no | 7 | feat(hope,web): the CMS instrument had no capture path (#91) (#151) |
| #152 | `aa980917` | 15 | 422 | no | 3 | fix(hope,terminology): hope_j_codes holds instrument items, not symptom answers (ADR-0047) (#152) |
| #154 | `6afcc346` | 11 | 1755 | no | 5 | feat(documents,web): the staff app had no way to file a document (#91) (#154) |
| #155 | `64b0fe49` | 8 | 1782 | no | 4 | feat(care-plan,web): the plan of care could be read but never written (#91) (#155) |
| #157 | `ca784307` | 6 | 919 | no | 3 | fix(openapi): 441 route keys were declared twice; only the last was ever published (#156) (#157) |
| #158 | `d9c09c0d` | 24 | 3619 | mostly no (1present/23not) | 9 | feat(idg,web): the IDG meeting could be read but never conducted (#91) (#158) |
| #160 | `b0760df2` | 22 | 2083 | no | 15 | feat(encounters,web): the staff app could sign a visit note but never write one (#91) (#160) |
| #162 | `8593b8dc` | 26 | 2254 | no | 15 | feat(dosespot,admission,web): nothing in the staff app could write a prescription (#91) (#162) |
| #163 | `8b869662` | 23 | 1488 | no | 12 | feat(assessments,web): a clinician could read a PPS timeline and not record a PPS (#91) (#163) |
| #164 | `e95a0a57` | 9 | 1563 | no | 2 | feat(scheduling,web): the scheduler could read a day and not schedule a visit (#91) (#164) |
| #166 | `bbdc980e` | 11 | 1104 | no | 2 | fix(evv): the write paths validated a justification and dropped it; the correction-of-record could not succeed (#165)… |
| #167 | `c1df21c6` | 8 | 2401 | no (applies cleanly alone) | — | feat(evv,web): nine EVV read screens could not approve a device, close a missing capture, or retry a state submission… |
| #169 | `9fdd27e7` | 22 | 1439 | no | 10 | fix(ipu): a restraint's CoP 418.110 physician order was "the caller typed something"; the ids to reassess or release … |
| #172 | `a946a464` | 21 | 891 | mostly no (1present/20not) | 10 | fix(ipu): a discharge asserted its own M6 discharge event; assignments and restrictions could be created but never li… |
| #173 | `186d4c4e` | 8 | 3672 | no | 1 | feat(ipu,web): four IPU read screens could not move an admission, reassess a restraint, or attest a GIP criterion (#9… |
| #175 | `19e91108` | 24 | 1639 | no | 6 | fix(ipu): M37 registered no crons, so the RN-coverage invariant had no producer and every GIP and respite admission w… |
| #176 | `f4ac945a` | 24 | 1152 | no | 12 | fix(hope): hope_submission_item had no writer, so the route that force-assembles a batch created an empty one (#150) … |
| #178 | `a6865ffe` | 10 | 1531 | no | 4 | feat(hope): build iQIES submission stages 2 and 3, and register the assemble cron the transmit stage was the precondi… |
| #179 | `80a07df8` | 20 | 858 | mostly no (1present/19not) | 14 | fix(encounters): the care-plan link was never written, and could not have been (#159) (#179) |
| #180 | `c27dce0c` | 16 | 738 | mostly no (1present/15not) | 12 | fix(documents): document_tag had two writers and no reader, so every tag was invisible and undeletable (#153) (#180) |
| #181 | `cd2d38b2` | 11 | 508 | no | 4 | fix(care-plan,billing-medicaid): the two admissionId workarounds F-065 left standing (#161) (#181) |
| #183 | `b9038299` | 14 | 699 | no | 3 | feat(web,documents): the M22 tag-editing row — and the 204 idempotency defect it uncovered (#91, #182) (#183) |
| #184 | `f256a144` | 40 | 2816 | mostly no (1present/39not) | 8 | feat(fhir): bind the M28 gateway — it could not mint a token, so no route below R3 was reachable (#95) (#184) |
| #185 | `daabefee` | 3 | 155 | no | — | test(orders,e2e): M11's signature inbox had nothing to sign, so no spec could prove it works (#91) (#185) |
| #186 | `0800e965` | 8 | 302 | no | 1 | fix(hope,e2e): M10's three write paths all sent a value the route refuses (#91) (#186) |
| #187 | `0a30d5f6` | 5 | 286 | no | — | test(prescribing,e2e): M12's drug search had no concepts to find, so nothing could be prescribed (#91) (#187) |
| #188 | `d593249a` | 8 | 10 | no | — | docs(hope,prescribing): renumber two finding ids that collided with existing ones (#188) |
| #189 | `cdf8d7c8` | 6 | 383 | no | 1 | fix(assessments): the significant-change detector had no caller, so the queue was empty everywhere (#91) (#189) |
| #190 | `71d84027` | 6 | 204 | no | 3 | test(care-plan,e2e): drive the §418.56 quorum, and fix the WCAG failure it exposed (#91) (#190) |
| #191 | `551181f3` | 5 | 157 | no | — | test(evv,e2e): the device-approval queue was empty, so M18's only web write was untestable (#91) (#191) |
| #192 | `a0c0ecfc` | 4 | 246 | no | — | fix(scheduling): nobody held a licence, so the D8 gate refused every visit create (#91) (#192) |
| #193 | `7e2dee8d` | 19 | 997 | no | 9 | fix(ipu): no RN assignment could be confirmed, so no IPU admission could move (#91) (#193) |
| #194 | `9ba9b8bc` | 20 | 561 | no | — | fix(auth): no user could enrol a step-up factor, so 138 gated writes were unreachable (#91) (#194) |
| #194 | `406601f9` | 0 | 0 | no | — | fix(auth): no user could enrol a step-up factor, so 138 gated writes were unreachable (#91) (#194) |
| #195 | `dbaa1082` | 20 | 905 | no | 4 | fix(encounters,hope,auth): no clinician could open a visit note, and no seeded deployment could finalize one (#91) (#… |
| #196 | `c7bac8f5` | 5 | 207 | no | 2 | fix(hope): the nightly iQIES assemble cron threw from its second run onward, in every tenant (#91) (#196) |
| #197 | `a44af34f` | 3 | 185 | no | 1 | fix(db,fitness): the M28 disclosure ledger's RLS did not apply to its owner, and nothing had ever asked (#91) (#197) |
| #198 | `4227b2d2` | 6 | 156 | no | — | fix(evv): correction-of-record could never commit — the D2 backstop index and the write path disagreed on what "super… |
| #199 | `ecedf351` | 4 | 138 | no | — | fix(admission): an unrecognised signer kind skipped the §418.24 representative-authority check, and six M6 guard test… |
| #200 | `bba5f444` | 6 | 426 | no | 1 | feat(fitness): close F-029's open gap — two route surfaces were in the published contract and mounted by nothing (#91… |
| #201 | `cf33fee2` | 12 | 871 | no | 2 | fix(foundation): the feature_flag table had no reader and no writer, and its unique index did not cover global flags … |
| #202 | `4abad00a` | 6 | 260 | no | 2 | fix(patient,care-plan): M5's chart surface enforced no ABAC at all, and the permission catalog's `abac` field binds n… |
| #203 | `67e7d4ad` | 9 | 513 | no | — | fix(authz): the §3.4.1 CoP role floor was enforced in the test double and nowhere else (#91) (#203) |
| #204 | `8aad9b90` | 16 | 1315 | no | 2 | fix(field-safety): six consumers were bound by nothing, so safety_check_in_schedule had no producer at all (#91) (#10… |
| #206 | `d39324c3` | 14 | 679 | no | 1 | fix(infra): six modules declared a subscribed-event list that was compared to nothing (#91) (#205) (#206) |
| #207 | `6d105d57` | 9 | 988 | no | 1 | fix(oncall): the D10 inbound triggers were bound by nothing, so no proactive triage call could ever be opened (#91) (… |
| #208 | `153022bb` | 14 | 738 | no | — | fix(infra): rule 6 saw six subscription lists of nineteen, and its own comment said otherwise (#91) (#208) (#208) |
| #209 | `bb06d477` | 16 | 513 | no | 1 | fix(patient,authz): the census listed every patient in the tenant, and the org-wide role list existed five times (#91… |
| #210 | `c49229f8` | 16 | 670 | no | 3 | fix(identity,authz): every invitation produced a membership with no role grants (#91) (#210) (#210) |
| #211 | `a252b5cc` | 95 | 1091 | no | 4 | fix(infra,tests): 631 test files were compiled by nothing, and a regression shipped through the hole (#91) (#211) |
| #212 | `a2479bd8` | 19 | 724 | no | 3 | fix(documents): six modules request a document render and M22 renders none of them (#103) (#212) |
| #213 | `14b4384b` | 26 | 1062 | no | 5 | fix(admission,documents): M6's six CoP documents were never rendered, and six write routes 500'd (#103) (#213) |
| #214 | `0e475ed8` | 4 | 128 | no | 1 | fix(admission): seven m6 events declared a consumer that renders nothing, deferring every emission forever (#103) (#214) |
| #215 | `ed851e5a` | 15 | 1018 | no | 2 | fix(orders,dosespot): a discharged patient's orders stayed in flight forever, and the fix was blocked from both sides… |
| #216 | `ac5429e6` | 11 | 672 | no | 2 | fix(discipline-plans): nothing ever created a discipline care plan, and every m15 event that would have announced one… |
| #217 | `09529a4a` | 20 | 831 | no | 3 | fix(idg): the D8 action-item auto-close had no binding, and the column it matches on was written by nothing (#103) (#… |
| #218 | `878ad495` | 15 | 925 | no | 2 | fix(bereavement): no bereavement plan has ever existed, and three defects sat between the event and the row (#103) (#… |
| #219 | `89aab55c` | 13 | 810 | no | 2 | fix(billing-medicare): no Notice of Election has ever been filed, and the trigger the spec names cannot work (#103) (… |
| #220 | `593db422` | 10 | 928 | no | 3 | fix(billing-medicare): no NOTR has ever been drafted, and two of its three triggers needed a decision (#103) (#220) |
| #221 | `70563394` | 15 | 750 | no | 1 | fix(cost-report): the cost report CMS receives pointed at nothing, and the request half was asking for the wrong file… |
| #222 | `ec55d971` | 15 | 565 | no | 2 | fix(messaging): every alert ever emitted claimed it was delivered, and nothing has ever been delivered by any channel… |
