# Fitness gates: ABAC, request headers, context attributes, route reachability

> Rationale for `check-abac-predicates` (incl. F-092/F-093/F-096/F-097), `check-request-header-auth`, `check-context-attributes` (F-029/F-030), `check-route-reachability` (F-090/F-091). Moved verbatim from the repo-root `CLAUDE.md`; point-in-time narrative — generated reports under `audit/` are authoritative. Index: [`README.md`](./README.md).

- `scripts/check-abac-predicates.ts` — **ABAC named-predicate resolution** (`bun run arch:abac-predicates`). Every `requireAbac(_, "<name>")` — including through each module's
  local `guards.ts` factory — must name a predicate some module declares. M3's registry fails
  closed on an unknown name, so a typo'd or never-registered name is a permanently dead endpoint
  (403 for every caller) with the whole build green; that is exactly how M30's 15 `inOrg` guards
  sat unreachable across 7 route files. There is **no deferral allowlist**: a predicate whose
  inputs do not exist yet is expressed as a *registered* predicate that denies and says why
  (`deviceAttestationValid` in `packages/auth/src/abac/registry.ts`), never as an unregistered
  name — both refuse identically, only the first is distinguishable from a mistake.
  **The UNASKED DIRECTION is a standing finding (F-092)**, the F-025/F-043 shape a third time. This
  gate goes guard → declaration, so it cannot see a control that is DECLARED and gated by nothing.
  Every `PermissionDef` carries an `abac` field — "the default ABAC predicate that guards the key, or
  `'none'`" — and **545 catalog keys name a non-`none` predicate while only 113 are named by any
  `requireAbac` guard**. `requirePermission` resolves the actor's grant set and asks `granted.has(key)`;
  it never reads `defaultAbac`, which exists only to mirror into the `permission` table for the admin
  UI. So the field is a declaration with no mechanism behind it, and several route files' own headers
  say the opposite — M13's eMAR routes state their key "maps to the shared `caseload_or_scope`
  predicate … **bound by the §4.6 default ABAC on each clinical route**", a binding that does not exist.
  Most of the 466 unguarded keys are defensible (a module composing its own `admission.scope` /
  `encounter.scope` / `hope.scope` is doing the same job under another name, and `inOrg` at 116 keys is
  RLS's job), which is why no gate is proposed yet: a 466-entry deferral registry written without
  verifying each one would manufacture a passing state, the failure `outbox:deferrals:update` is
  explicitly built to refuse. **M5 was the instance that mattered and is fixed**: it was the only
  clinical module on the platform composing NO `requireAbac` at all, while nine of its keys declared
  `caseload_or_scope` and six of its route comments claimed a "§7.5 non-leak · non-caseload → 404" that
  `service.getPatient(organizationId, id)` has no caseload input to perform — any holder of
  `patient.read` read any chart in the tenant. The per-chart routes now compose the predicate the
  catalog names, with `notFoundOnDeny` so a refusal does not itself confirm the chart exists.
  Fixing M5 surfaced a second live defect in the four modules that DO enforce it (M7/M9/M20/M23):
  `ORG_WIDE_SCOPE_ROLES` listed `medical_director`, `compliance_officer` and `survey_coordinator` and
  **omitted `director_of_nursing`**, whose `SYSTEM_LOCKED_FLOORS` entry locks on `patient.read` AND
  `patient.assign` — a permission to put clinicians on caseloads that cannot be exercised against
  patients the holder may not see. A DON has been refused every care plan, assessment and safety row
  outside their own caseload. The list is now DERIVED from the floors that lock `patient.read` rather
  than maintained by hand. `org_admin` is deliberately NOT included even though ~10 predicates treat it
  as the tenant's top authority: it carries no `patient.read` floor, so the platform has never asserted
  that role reads charts.
  **§7.5's other half — the CENSUS list — is now narrowed too (F-096, #209), and the derivation is
  shared rather than copied.** F-092 delivered the per-chart 404 and named the list half as open because
  "a preHandler can refuse a list but cannot filter one". That was the LARGER of the two disclosures: a
  chart read leaks one patient to someone who guessed an id, a census leaks the identity of every patient
  the agency serves to everyone who can log in, and any holder of `patient.read` listed all 5,000.
  `PatientRouteService.list` now takes the narrowing set as a REQUIRED third argument — `null` for an
  org-wide reader, otherwise the ids, resolved through M5's own `caseloadPatientIds`, whose doc comment
  has called it "the `patient_id = ANY(:ids)` list filter" since M5-T07 while having exactly one consumer
  platform-wide (M12's refill inbox, which is not this list). **An EMPTY set returns NOTHING**: the
  fail-open shape is `if (ids.length > 0) narrow(ids)`, which reads as a harmless guard against an empty
  `IN ()` and hands the entire tenant to precisely the actor who should see least. The narrowing is in the
  WHERE clause, not a post-read `rows.filter` — the M12 `refillInboxWhere` lesson, and the two are
  indistinguishable until a LIMIT is involved, which is why `m5-census-caseload-scope.live.test.ts` pages
  through a caseload that sorts LAST: a post-read filter returns a short page and a wrong cursor having
  already read every patient into memory. Three of its seven fail against the two failure shapes.
  Fixing it needed the org-wide determination callable from outside the predicate registry, which
  surfaced that `ORG_WIDE_SCOPE_ROLES` existed **five times** — M7, M8, M9, M10 and M15 — and that F-092
  had derived exactly one of them. **M8, M9 and M10 still carried the three-name literal**, so a DON went
  on being refused every encounter, assessment and HOPE record outside their own caseload, and M8's copy
  claimed in its own comment to "mirror M7's". There is now one `hasOrgWideScope` in `@wardenx/auth`,
  beside the `SYSTEM_LOCKED_FLOORS` it derives from, and `org-wide-scope.test.ts` pins the DERIVATION
  rather than the four names — asserting the output would rebuild the thing that failed.
**Every invitation the platform ever issued produced a membership with NO role grants (F-097, #210).**
M2 §D3 is recorded as **Decided** — "Membership→role assignment is Module 3. M2 carries
`proposedRoleKeys` … and creates the membership; M3 attaches roles on accept" — and its §11 "Done means"
repeats it. Nothing performed it. `POST /api/v1/invitations/accept` consumed the token, created the
membership, and returned, carrying the comment "proposedRoleKeys are carried to M3 on accept (role attach
is M3-owned, §7.1)" — a line naming the mechanism as someone else's while nobody had it. There is no event
path either: at the time this was found, **M2 contributed no outbox catalog at all** (the absence #205
later recorded as the blocker for M35's four `m2.*` subscriptions), so `m2.membership.accepted` was an
AUDIT action and nothing could subscribe to it. **M2 now catalogues it** (`events-by-m2.ts`, #205), and it
stays deliberately record-only (`declaredConsumers: []`) — its own catalog comment says why: the §D3 role
attach this finding fixes below is "the real, synchronous mechanism for downstream role-grant effects;
this event has no consumer." An admin invites an RN as `clinical_rn`, the RN accepts, the RN holds nothing — no error,
no warning, and the `organization_invitation` row still lists the roles that were requested, so the admin
surface reports access the user does not have. The handshake is now performed by
`03-authorization/proposed-role-attacher.ts`, bound at the composition root because M2 is `dependsOn: [1]`
and cannot import M3 (the `emailTransport` precedent). It resolves keys to THIS org's enabled roles and
grants them in one RLS-scoped transaction, idempotent by the UNIQUE `(membership_id, role_id)` index
rather than by a pre-read (a replayed accept is expected — the invitation `consume` already races
atomically). **The `organization_id` predicate on the role lookup is load-bearing and not redundant with
RLS**: migration 0025 widened the role READ policy to admit org-NULL platform TEMPLATE rows, so RLS alone
lets a template resolve and be granted into a tenant that never created it —
`m3-proposed-role-attach.live.test.ts` fails on exactly that case when the predicate is removed.
**An unresolvable key is REPORTED, never dropped** (`rolesAttached: { attached, unresolved }` on the wire,
audited as `m3.role.assigned` with outcome `failure` when nothing attached): silence would reproduce the
defect one layer down, and it is the state a freshly provisioned tenant is in for EVERY key —
**M34's provisioning worker seeds a key ring, storage prefixes, an organization, onboarding tasks and the
first-admin invitation, and NO `role` rows.** `ROLE_TEMPLATES` still has no materializer (the `permission`
catalog has `db:sync:permissions`; roles have no sibling), so outside the dev seed scripts the table starts
empty — and the M34 onboarding template `first_admin_invited` gates on
`orgAdminAcceptedMembershipCount > 0`, an `org_admin` grant that cannot exist. **That half is reported, not
fixed**: which roles a new tenant gets by default is a product decision, and only 13 of the spec's ≈60
Appendix-A templates are coded (F-093), so seeding "the 7 tenant ones" would quietly make that mismatch
normative. `packages/saas-tenant-platform/src/onboarding/context.ts` also has no production builder, so the
precondition DSL evaluates nowhere.
**The regression that proves the standing test-corpus finding.** F-096 made
`PatientRouteService.list`'s narrowing argument REQUIRED, and a two-argument caller in
`auth.live.test.ts` survived a full green `typecheck` + `test` run: `apps/backend/tsconfig.json` is
`"include": ["src"]`, so **all 136 backend suite files are never typechecked**, and a live suite
additionally self-skips without a database — invisible on two axes at once. Measured today: ~730 real
type errors across `apps/backend/__tests__` (plus 1208 TS6307 project-config artifacts). Fixing that is
its own change; the broken caller and the census-narrowing fallout in that suite are fixed here, and
TEST-003 now seeds a real `patient_assignment` and registers the real `CaseloadProvider`, so it proves
the §7.5 narrowing end-to-end under a genuine session cookie rather than a header shim.

**The §3.4.1 CoP role floor was enforced in the test double and nowhere else (F-093).** Two files each
named the other as the enforcer: `role-store.ts` — the Drizzle `RoleStore` the composition root mounts —
said "the route layer enforces the `system_locked` CoP floor before calling the store", while
`authz-routes.ts` says "the §3.4.1 floor check IN THE STORE is what refuses it" and only TRANSLATES a
`RoleLockedError` into a 409. The store that raises it is `createInMemoryRoleStore`, the slice every
route test runs against; the production one deleted and re-inserted `role_permission` unconditionally and
deleted any role row handed to it. So `PATCH /api/v1/roles/:id { permissionKeys: [] }` stripped the
Medical Director's CoP floor and `DELETE` removed the Compliance Officer role — M03-F06, the control CoP
418.102 / 418.64(a) / 418.52 rest on. **Two more defects sat under it.** (1) The pre-read ran on the bare
pool — `db.select().where(eq(roles.id, id))` with no `withOrgContext`, so `app.org_id` was unset, the
policy predicate was NULL and it matched nothing: under real RLS every role edit was a raw 500 and every
delete a silent no-op. It looked fine in development because `db:migrate` grants `wardenx_app` BYPASSRLS
there, which is exactly the gap the live-suite convention exists to cross. (2) **Eight of the
twenty-seven floor keys named permissions no module registers** — `cti.sign` where M6 registers
`cti.sign_hospice_md`, `order.cosign` where M11 registers `orders.cosign`, `security_event.read` for a
resource with no table, no route and no key anywhere. `role_permission.permission_key` REFERENCES
`permission.key`, so those floors were UNGRANTABLE, and `floorViolations` reports an ungrantable key as
stripped on every edit — enforcing §3.4.1 without fixing them would have made locked roles permanently
uneditable. The floors now name catalog keys, `permission-catalog.test.ts` pins the resolution invariant
in both directions (floors and template `grants`), and `role-templates.test.ts` no longer pins the spec's
§3.4.1 table verbatim: pinning the spec is what preserved the eight dangling names, and `catalog.ts`'s own
rule — "the permission catalog is CODE, the single source of truth" — plus the authority rule (a module
spec is an implementation proposal) settle which side is normative. `m3-role-catalog-floor.live.test.ts`
is the proof and is LIVE by necessity: a test against the double proves the double, which is what every
suite had been doing while the deployed control was absent. All 10 of its cases fail against the
pre-fix store. **Two related absences are reported, not fixed**: nothing materializes `ROLE_TEMPLATES`
into the `role` table (the `permission` catalog has `db:sync:permissions`; roles have no sibling), so
every row in every database is org-owned with `system_default`/`system_locked` FALSE and migration 0025's
org-NULL read widening admits template rows nothing creates — which is why the lock check keys on the
role KEY and treats the column as a second arm; and this file ships 13 templates where the spec's
Appendix A enumerates ≈60.

- `scripts/check-request-header-auth.ts` — **request-header authorization gate** (F-028,
  `bun run arch:request-header-auth`, in `arch:fitness`). A request header is whatever the caller
  typed; deciding an AUTHORIZATION question from one, unverified, hands the decision to the party
  being gated. Four commit-point routes did exactly that — M14's IDG adjourn (the D13 commit point),
  M17's self-attested visit start, and M18's retroactive correction-of-record + D6 supervisor
  override each gated their fresh-step-up requirement on `request.headers["x-step-up"] === "fresh"`,
  so anyone who could reach the route could satisfy the re-authentication ceremony by typing the
  header. Eight other modules gated the same requirement correctly the whole time, through
  `requireStepUp(opKey)` → M3's `step_up_recent` predicate → M2's `SessionContextResolver` seam.
  Nothing caught it because every gate was self-consistent about it: the routes carried
  request/response contracts, so `arch:openapi-coverage` counted them enriched; `openapi:check`
  proves the contract was *regenerated*, not that it is *true*; and `client:gen` was clean because a
  header nothing declares is simply one the client cannot send — the published API and the code
  agreed with each other and both were wrong about what the route required. It surfaced only when
  F-012 type-checked `scripts/` and broke a seed that had been passing the header as a typed
  parameter. The gate requires every `request.headers[...]` read in `apps/backend/src` to name a
  header REGISTERED as either `verified` (the server checks the value against state it holds — a
  signature, a constant-time secret compare, a server-minted single-use token, a double-submit
  cookie) or `not-authorization` (concurrency control, telemetry; a forged value earns a 412 or a bad
  log line, never access). There is deliberately **no third classification** for "trusted because the
  caller is nice" — a header that would need one is the bug. Response headers and comments are not
  inputs and are skipped; test files are excluded (a harness legitimately drives its own fake
  authenticate hook off headers); a name reached through a module constant is resolved to the real
  header, and the one generic accessor whose name arrives as a parameter is declared in
  `DYNAMIC_READERS` with the constants its callers pass, each of which must itself be registered.
  The resolution the four routes now use is `stepUpFreshFor` /`requestStepUpFresh`
  (`apps/backend/src/bootstrap/step-up.ts`), shared with M3's predicate so the guard form and the
  boolean form cannot drift.
- `scripts/check-context-attributes.ts` — **request-context attribute producer gate** (F-030,
  `bun run arch:context-attributes`, in `arch:fitness`). `request.context.attributes` is the untyped
  bag the authenticate hook fills with server-assembled facts about the caller and that ABAC
  predicates and route actors read back out. It is `Record<string, unknown>`, so a read of a key
  nothing writes compiles, evaluates, and yields `undefined` — and every reader treats that as deny,
  which makes the failure silent, permanent, and indistinguishable from working code. Four instances
  had already been found and fixed one at a time before anyone looked for the pattern:
  `membershipId` (7 modules' §4.x ownership predicates saw null and denied), `providerEntityIds` /
  `locationIds` (every PE/location predicate denied unconditionally, ARCH-008/009), `stepUpRecent`
  (15 modules — M23/M27/M37 mount `requireStepUp`, which PASSES, then refuse in the DOMAIN on the
  always-false flag, so the guard allowed and the machine refused, F-029), and `systemPrincipal`
  (one fact under two names: `actorKind` was stamped and checked by M15/M23's
  `requireSystemPrincipal()`, while M23's seam predicate and M25's `/internal` guard checked a name
  nothing wrote — those service-to-service endpoints refused every caller, a diagnosis
  `seed-scenario-billing.ts`'s header had already written down and worked around by skipping M25).
  `arch:abac-predicates` cannot see any of this: it proves a predicate NAME resolves, not that the
  FACTS the predicate reads are ever produced. The gate requires every key read off the bag to be
  declared as either `{ producer }` — and it verifies a write actually EXISTS, since a declared
  producer that stops writing is the exact regression — or `{ blocked }`, carrying the reason and
  what it needs (the `deviceAttestationValid` rule again: a fact whose source does not exist yet is
  a *declared* absence, never an undeclared one). A blocked key that gains a writer fails, so an
  entry cannot outlive its reason; a declared key nothing reads fails, so the registry cannot go
  stale. Tests are excluded from the scan on purpose — every historical instance was invisible
  precisely BECAUSE each suite wrote the attribute in its own fake authenticate hook, so counting
  those as producers would make the gate agree with the bug. The scanner resolves string constants
  **across** files (`attributes[REVIEW_FLOOR_OVERRIDE_ATTRIBUTE]` is read in M14's routes and
  declared in its predicate file), the SCREAMING_CASE identifier-index write form (how both
  in-request producers actually write), and whole-bag aliases (`const attrs = ctx.attributes ?? {}`,
  which is the only way two of the unproduced keys are read at all). **4 keys are currently
  declared blocked** and the gate prints them on every run — they are the standing finding, not a
  passing state. The largest is `sessionClass`: M16/M31/M39 read it and default to `"staff"`, and
  M31's portal predicates gate on it being one of `patient_portal`/`caregiver_portal`/
  `bereaved_portal`, none of which the M1 `session_class` enum contains — so the whole portal ABAC
  surface denies. **Resolved (2026-08-26):** migration 0219 extends `session_class` with the three
  portal classes + M19's two vendor classes, 0220 teaches `session_scope_chk` what scope each
  requires, and M2 publishes a `PortalSessionBinder` seam so M31 can hand it the account/patient
  binding its `select-patient` route always claimed to. Blocked keys: **13 → 10**. Writing 0220
  against a real database also surfaced a **pre-existing** hole in the same constraint: `scope ?
  'patientId'` on a NULL `scope` is NULL, `NULL OR false` is NULL, and a CHECK **passes** on NULL —
  so the collaborator/funeral branch never bound on a row with no scope, and a one-time magic-link
  session whose whole purpose is to be pinned to ONE patient could be written unpinned. The
  app-layer mirror (`isSessionScopeValid`) never had the hole, so the defense-in-depth layer was the
  strict one and the DB floor was the loose one — which is why nothing going through the auth layer
  ever hit it. Both are proven by `session_scope_chk (F-030) — live` in `auth.live.test.ts`, which
  is that constraint's only executable coverage. **Resolved next (2026-08-26):** the session's
  pinned patient, which was read under THREE names and written under none — M31/M19 as
  `portalPatientId`, M19's portal-triage guard as `portalPatientId ?? patientId` (a `??` chain of
  two undefineds, shaped like a safety net), and M7's `caseload_or_scope` as a `scopePatientIds`
  ARRAY, so a collaborator session's scope grant never fired and every collaborator fell through to
  a caseload they are not in. One key now, `sessionPatientId`, named for the fact rather than for
  one of its three readers — M7's readers are `external_collaborator` sessions, so a `portal…` name
  would have become the fourth rather than the last. It resolves through `sessionPinnedPatientId`,
  so the CLASS decides and a staff session carrying a stray `scope.patientId` pins nothing (reading
  the jsonb key directly, as the store did, would have widened the one predicate whose job is to
  narrow). Blocked keys: **10 → 8**. Then `organizationName`, the one entry that was never an
  authorization control: M2's invitation routes read it and fell back to the literal `Organization`,
  so with nothing writing it the fallback was not a fallback but the only branch — every invitation
  row stored that string, the pre-auth `GET /invitations/:token` preview served it back to the
  invitee's browser, and the email said "invited to join your organization". It now resolves from
  the INVITER's own active membership in the org they are inviting into (`findActive`, the same read
  `/auth/context` already projects the name through), which is org-scoped by construction and adds
  no dependency. Blocked keys: **8 → 7**. Then `permissions`, whose blocked entry had assumed a COST
  decision — whether to stamp the actor's whole grant set on every request — when there was none to
  make: `resolveActorPermissions` is the check-don't-gate seam, its doc comment names this exact case
  ("consumers that must *check* a permission rather than gate on it") and states an assembled
  `AbacContext` is a valid argument, and the resolver behind it is TTL-cached per (org, user) with
  the TTL capped by the soonest grant expiry — so by the time M27/M30's predicates ask, the route's
  own `requirePermission` preHandler has already resolved the same set and it is a cache hit. Nothing
  is stamped; the two `actorHoldsPermission` helpers resolve through the seam. Blocked keys:
  **7 → 6**. Then `phiFullRead`, where the entry was not merely mis-reasoned but wrong on the facts:
  it recorded the role-token arm as working, so the attribute was "the dead half". BOTH arms were
  dead. `context.roles.includes("phi.full_read")` asks a list of ROLE keys (`compliance_officer`,
  `medical_director`, …) for a `resource.action` PERMISSION key — a namespace error nothing can make
  true — and `phi.full_read` was in no permission catalog either, so it could not be granted to
  anyone. M32's §164.528 disclosure ledger (R16/R17) therefore masked the patient identity for every
  caller, always, including the compliance officer the ledger exists for. Masking fails SAFE, which
  is why nothing surfaced it: a permanently masked ledger and a correctly masked one are
  indistinguishable. The key is now registered in M5's `phi.*` family (`abac: "none"`, a
  check-don't-gate key like `cost_report.edit_any_provider`) and resolved through the same seam, and
  it is deliberately assigned to NO default role template — who reads unmasked PHI by default is a
  tenant policy decision, and choosing one here would have granted it silently on every existing org.
  Blocked keys: **6 → 5**. Then `licensure`, the third entry in a row whose stated blocker was wrong:
  it said no column or seam existed for the clinical licence M22's §4.7 high-risk-field review gate
  needs. M17's `membership_credential` + the `CredentialReader` seam are that fact under another
  name, already applying the status/effective/expiry logic and deliberately orthogonal to the RBAC
  role grant (a clinician can hold the `rn` ROLE while the LICENCE has lapsed). Only the vocabulary
  was short, and only by one value: **`md` already means PHYSICIAN — MD *or* DO**, which
  `VISIT_PURPOSE_DISCIPLINES` has documented as "MD/DO or NP" all along, so giving DO its own enum
  value would have stopped four CoP-relevant visit purposes (`f2f`/`recert`/`loc_change`/
  `pronouncement`) accepting osteopathic physicians — a regression bought with a distinction no
  consumer makes. `pa` was genuinely absent (a physician assistant could not be recorded as licensed
  at all) and migration 0221 adds it, in NO `VISIT_PURPOSE_DISCIPLINES` list: holding a licence is
  not visit authority, and the Medicare hospice face-to-face encounter is physician-or-NP only
  (42 CFR 418.22(a)(4)). Blocked keys: **5 → 4**. Then `isPlatformOperator`, the fourth entry running
whose recorded blocker had expired: it quoted M29's own read site ("Until a platform-operator caller is
provisioned this reads false and the predicate denies (W-XI-12)") and filed it as correct-by-design. A
platform-operator caller HAS been provisioned since ADMIN-T02 registered the six `platform_staff`
templates, and M35's `platform_billing_scope` has gated its whole cross-tenant `/api/admin` surface on
exactly that role set the entire time — so M29's `nppes_platform_job_caller` was asking the same question
under a second name, and refusing the platform operators it exists to admit. It now re-derives from
`PLATFORM_OPS_ROLE_KEYS`, the same single source M35 re-derives from, so the codebase's two platform-only
gates cannot drift on who counts as an operator. Both tests that covered it supplied the attribute
themselves — the unit test set `isPlatformOperator: true` on the context and the inject suite stamped it
off an `x-test-platform-operator` header — so each demonstrated the shim, not the gate; the allow arms are
now real catalog roles, and the inject suite's platform session differs from its tenant session by that
role alone, so the 403→202 flip can only be the predicate. Blocked keys: **4 → 3**. Then `disciplines`,
which needed a DECISION rather than a diagnosis: seven modules (M7–M13) each assembled the caller's
clinical discipline set by unioning `attributes.disciplines` with the session role keys, so the union was
with the empty set on every request the codebase has ever served and the role arm was the whole answer in
all seven. Unlike every other F-030 key, NO test ever supplied this one — it did not need faking, because
the derivation degraded instead of dying. The reads are gone rather than the fact produced, because the
platform already has one derivation and two modules had written down why: M19's
`TRIAGE_DISCIPLINE_FOR_ROLE_KEY` states the rule ("M3's `RoleGrant.roleKey` is the platform's one
authority-derivation input") and **M17 — which owns both the discipline vocabulary and
`membership_credential` — resolves its own D8 pre-schedule gate exactly this way** (`resolveDisciplinesTx`:
active role grants ∩ the scheduling vocabulary), reading the credential only for the deliberately
orthogonal question of whether the licence is currently active. Producing an eighth answer to a question
three modules already answer identically would have been the drift, not the fix. `discipline-derivation.
test.ts` pins both halves — each module answers from role keys, and a stray `disciplines` attribute cannot
change the answer, so a future producer of that key cannot silently widen seven clinical floors
(controlled-substance prescribing, medication administration, order authoring, scale recording) without a
deliberate edit; 8 of its 21 cases fail against the pre-change code. Blocked keys: **3 → 2**, and both
survivors are genuine declared absences of the `deviceAttestationValid` kind: `deviceAttestation` (M2 owns
no attestation table per ADR-0023 D2 and the mobile client doing the §12.4 posture check is unbuilt per
ADR-0035 — widening it would disable a SecHardening control) and `externalActorId` (M19's binding Phase
boundary ships the Hybrid/Centralized models feature-flagged-OFF; producing it means building the §7.5
vendor SSO binding and the `packages/triage-vendors` adapter, i.e. M19 Phase 2). Then
`deviceAttestation` — the one entry the registry itself held up as its own model, and the only one that
needed a SURFACE built rather than a name rewired. **ADR-0023 D2 named exactly this and offered two exits:
add it to M2 with a real manifest `ownedTables` edit (the `tenant_step_up_policy_override` precedent) or
declare it vapor and delete the consuming specs.** It is added, because it had two consumers and one of
them already wrote to it — M18's `evv_device.m2_device_attestation_id`, documented in that table as "M2 row
(app-validated; no FK)", a logical foreign key to a table that did not exist and which M18's own
registration path satisfies with `randomUUID()`. Migration 0222 adds `device_attestation` (org-scoped RLS,
audit trigger, one LIVE row per device via a partial unique index, revoked/failed rows retained as the
trail) plus `session.device_attestation_id`; the authenticate hook stamps the fact from
`ResolvedActor.deviceAttestation`, which is RE-CHECKED off the row (`liveDeviceAttestation`: verdict,
revocation, expiry) rather than trusted from the pointer — so a revoked handset stops satisfying the gate
on its NEXT request. The write path is real, not a stub: M2's `managed_enrollment` verifier recomputes an
HMAC over a **server-minted, single-use** nonce keyed by a per-org derivation of the platform enrolment
secret, and the MAC covers the reported §12.2 posture, so the assertion is unforgeable, unreplayable and
unmalleable — the device reports its own posture (§12.4's detector runs on the handset, so it must) but
the server will not believe the report unless it arrives authenticated, and then applies the §12.2 policy
itself, where an UNREPORTED requirement counts as unmet. The two hardware providers (App Attest / Play
Integrity) report `unavailable` rather than denying, and an unconfigured deployment answers 501, so "this
deployment does not do device enrolment" never looks like "this fleet is compromised". This un-closes M33's
`report.drilldown.bulk_export`, which had been refused to every caller since it was written. Blocked keys:
**2 → 1**. Then `externalActorId`, the last one — M19's `external_triage_actor` compares the SHIFT's
vendor against the SESSION's, and nothing ever wrote the session's, so the comparison ran against
`undefined` and no vendor-scoped call could be recognised as one. It survived because it LOOKED like the
phase plan: M19 ships the Hybrid/Centralized models feature-flagged-OFF in Phase 1 and promises a Phase-2
tenant is "a configuration flip + vendor-adapter package install, not a schema change" — a promise that
did not hold, since both would have landed on a session layer that cannot express a vendor. Migration 0223
makes `scope.externalActorId` a `session_scope_chk` requirement of both vendor classes (0220 had given
them none, reasoning they are org-scoped rather than patient-scoped — true, and it does not follow that
they are unscoped WITHIN the org; the descriptor's `scopeKind` is now `external_vendor` rather than
`organization`, which is the reading that produced the gap); M2 publishes a `VendorSessionBinder` seam,
the `PortalSessionBinder` shape one module over; and M19 gains a bind route that checks four separate
things first — the vendor is in this org, the tenant's D3 model is actually outsourced, the BAA is in
effect and unexpired, and RN coverage is attested (D13 / CoP 418.64(b)). It does NOT turn the models on.
The fact resolves through `sessionExternalActorId`, so the CLASS decides and a staff session carrying a
stray `scope.externalActorId` stamps nothing — M19's own predicate header names that exact risk. Blocked
keys: **1 → 0**. **The F-030 registry is now fully produced: 12 keys, 12 producers, 0 blocked.**

**The step-up FACT had the same defect one layer down (2026-08-26).** F-029 fixed
`attributes.stepUpRecent` so the fact reaches the fifteen modules that read it, and `stepUpFreshFor`
resolves it correctly from `session.last_step_up_at` — a column **nothing in production ever wrote**.
`registerSessionStepUpRoutes` shipped with slice adapters and exactly one caller (its own test), and
`onLoginMfaCompleted`, the only other writer, was exported and called by nobody. The routes even appeared
in the published OpenAPI contract, because `scan-routes.ts` reads SOURCE and cannot tell a mounted route
from an unmounted one. So every step-up gate on the platform answered "not fresh" for every caller,
forever — fail-closed and therefore invisible, and worse than inert on the four write paths (M23 claim
submit/replace/void, M27 cost-report submit, M37 IRC cap override + restraint apply) whose guard PASSES
and whose domain then refuses on the flag. The routes are now mounted with production adapters:
`createContextSessionResolver` (server-assembled, never the body), the D8 paired-write over `session`, an
enrolment reader that requires `two_factor.verified` (Better Auth writes that row at the START of
enrolment, so treating it as enrolled would offer a challenge against a secret the user may never have
scanned — three failures from the lockout that terminates their session), and a real `MfaVerifier`. The
WebAuthn half already existed and was wired to nothing; the TOTP half did not exist at all, and
`totp-verifier.ts` now unwraps BOTH encryption layers over the secret — Better Auth's own
`symmetricEncrypt` envelope and the repo's ADR-0034 at-rest seal over it — composing the vendor's
published primitives rather than reimplementing them, and refusing rather than throwing on every failure
so the route's contract can turn a false into the 401 the lockout counter is built on. `resolvePasskeyRpId`
/`resolvePasskeyOrigin` are now shared with enrolment, because a step-up that resolved its own RP identity
would refuse every passkey this instance ever issued and report it as "assertion invalid". **The gap this
left open is now closed (F-090):** a route could still be in the published contract and mounted by
nothing, and `scripts/check-route-reachability.ts` is the call graph from the composition root that
F-029 said it would take. See its entry below — it found two more surfaces in exactly that state.
- `scripts/check-route-reachability.ts` — **route reachability from the composition root** (F-090,
  `bun run arch:route-reachability`, in `arch:fitness`). Every function that registers an HTTP route
  must be REACHED from `apps/backend/src/index.ts`. `scan-routes.ts` reads SOURCE, so an unmounted
  registrar is published in `docs/api/openapi.json` exactly like a mounted one and answers **404** —
  the contract advertises a surface that does not exist. F-029 was the instance that made the point
  (`registerSessionStepUpRoutes` had production-shaped adapters and exactly one caller, its own test,
  so `session.last_step_up_at` was written by nobody and every step-up gate on the platform answered
  "not fresh" forever) and it named both the gate needed and the trap in the cheap version: **a
  barrel's `export { registerFooRoutes } from "./foo"` is a reference, not an execution**, so "is it
  referenced anywhere?" answers yes for a registrar nothing calls. Grep cannot separate those; the
  AST can, because a re-export is an `ExportDeclaration` whose names are `ExportSpecifier` nodes — a
  kind that never appears in executable code — and skipping exactly that kind is the whole difference.
  Syntax-only (`ts.createSourceFile`, no type checker) so it runs in ~0.7s like the other gates. It
  found **two** surfaces in that state, both re-exported and called by nothing: **M22's DocLens
  extraction** (`POST /api/v1/intake/uploads/{id}/extraction/run` + `/jobs/{id}/extraction/commit`)
  and **M36's three inbound vendor webhooks**. DocLens is now mounted — everything it needs existed,
  and the module spends a paragraph specifying `503 EXTRACTION_DISABLED` + `Retry-After: 0` as the
  Phase-1 answer, which is a different statement from 404 (the capability is off for this tenant vs.
  the endpoint does not exist); it also meant `documents.doclens`, the capability flag whose whole job
  is to turn the surface on when M32 lands, was **an activation switch wired to nothing**. That entry
  originally recorded "no flag reader is threaded" as the accurate state and filed the reason as a
  standing finding — **now resolved, and it was worse than the note said (F-091)**. `feature_flag` had
  no reader AND no writer in the running system: `createDefaultFeatureFlagReader` answered `{}` for
  every org because the composition root never passed a reader, and M34's admin surface, which the note
  credited with WRITING flags, was bound to a stub that threw `M34InfraPortUnbound` on all three §4.7
  methods. Both halves dead is what hid it — a flag that cannot be set and a flag that reads off are
  indistinguishable from a Phase-1 capability that is correctly off, so the table, its four governance
  kinds, the five-key permission family, `feature_flag_write_authority`, the admin screen and the kill
  switch were all inert with nothing to say so. **And the writer could not have worked anyway**:
  `feature_flag_key_org_idx` is `UNIQUE (flag_key, organization_id)` and `organization_id` is NULL for a
  platform-global flag, so Postgres's NULL-distinctness left the global scope unconstrained *and* made
  `ON CONFLICT (flag_key, organization_id)` unable to match a global row — the create-or-update contract
  degraded to create-only for exactly the flags a platform operator sets, appending a rival row per
  edit. Migration 0237 adds `NULLS NOT DISTINCT` (migration 0110's `sss_active_pair_uniq` precedent).
  `apps/backend/src/bootstrap/feature-flag-store.ts` now binds both ends: the tenant-pool reader
  (`withOrgContext`, so migration 0002's own-org-OR-global policy is the isolation floor) threaded into
  the three surfaces that consume the fact — `GET /api/v1/system/feature-flags`, M22's
  `documents.doclens` gate and M38's §7.7 `ai.full` gate — and the platform-pool admin seam injected
  into `buildDrizzlePlatformService`. Resolution is a pure function with fail-CLOSED rules, because each
  has an easy fail-open sibling: a kill switch forces false ahead of everything, an expired flag stops
  applying, a non-`bool` value type is ABSENT rather than coerced (a non-empty string is truthy), and a
  `rollout_percent`/`targeting` flag is ABSENT because `forOrg(orgId)` carries no subject and bucketing
  a rollout by org would resolve every percentage to 0% or 100%. A tenant row wins over the global row
  **outright** — no fallback — so a lapsing tenant override can never read as the platform re-enabling
  the key there. **`setKillSwitch` still refuses, deliberately**: §4.7 specifies it as an AUDITED
  emergency control and both carriers for its alert fail on a global flag (the catalogued outbox payload
  requires a non-null `actorMembershipId` that a platform-ops actor toggling an org-NULL flag has not;
  M36's seam is `AlertEmitter.emit(orgId, …)` and a global flag has no org), so writing it silently
  would be an emergency disable whose security owner is never told — strictly worse than refusing, and
  `upsert` remains a working disable path. Proven by `m1-feature-flags.live.test.ts`, LIVE by necessity
  (NULL-distinctness, `ON CONFLICT` inference, and the RLS read policy are all statements about
  Postgres); three of its ten fail against the pre-0237 schema. M36's webhooks are a
  registered `DEFERRED` entry, the `deviceAttestationValid` rule at route-surface granularity: the
  routes and both §4.9 verification layers are built but `MessagingWebhookService` — the
  delivery-reconcile port every handler ends in — has **no implementation anywhere in the repo**, the
  Twilio/Postmark secrets have no resolver, and `@fastify/formbody`, which that file's own header says
  production registers so the urlencoded body parses into the map the HMAC is computed over, is
  registered nowhere and is not a dependency. Mounting it would answer Twilio with a signature check
  over an empty body and then call a service that does not exist. An entry that gains a mount fails
  ("outlived its reason"), one whose registrar disappears fails, and an empty reason fails.
